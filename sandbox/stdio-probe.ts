// stdio MCP probe — 프로세스를 띄워 initialize → notifications/initialized → tools/list 만 보낸다.
//   원격 Scanner(probeRemote)와 같은 필드·해시를 남긴다(비교 가능하게). 도구는 호출하지 않는다.
//   서버가 보내는 요청(roots/list, sampling 등)에는 -32601(method not found)로만 답한다.
//   표준오류(stderr)는 바이트 수만 센다. 내용은 저장하지 않는다.

import { spawn } from 'node:child_process';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import {
  capabilityKeys,
  hashTools,
  MCP_PROTOCOL_VERSION,
  namesHash,
  toolDefOf,
  toolNameList,
  toolSetHash,
  type ToolDef,
} from '../scanner/lib.ts';
import { LineSplitter, SANDBOX_RUNNER_VERSION, type Outcome } from './sandbox-lib.ts';

export interface StdioProbeOpts {
  initTimeoutMs: number;
  listTimeoutMs: number;
  maxStdoutBytes: number;
  spawnImpl?: (cmd: string, args: string[], opts: SpawnOptions) => ChildProcess;
}

export const DEFAULT_PROBE_OPTS: StdioProbeOpts = { initTimeoutMs: 30_000, listTimeoutMs: 15_000, maxStdoutBytes: 4 << 20 };

export interface StdioProbeResult {
  outcome: Outcome;
  reached_level: 0 | 1 | 2;
  exit_code: number | null;
  signal: string | null;
  init_ms: number | null;
  list_ms: number | null;
  duration_ms: number;
  metadata: Record<string, unknown>;
  tool_names?: string[];
  tool_defs?: ToolDef[];
}

interface RpcResponse {
  id: number;
  result?: unknown;
  error?: unknown;
}

function shortText(v: unknown, max = 64): string | null {
  if (typeof v !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  return v.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, max) || null;
}

function rpcErrorCode(err: unknown): number | null {
  const c = err && typeof err === 'object' ? (err as { code?: unknown }).code : undefined;
  return typeof c === 'number' && Number.isInteger(c) ? c : null;
}

export async function probeStdio(cmd: string[], opts: StdioProbeOpts = DEFAULT_PROBE_OPTS): Promise<StdioProbeResult> {
  const started = Date.now();
  const metadata: Record<string, unknown> = { runner_version: SANDBOX_RUNNER_VERSION, nonjson_lines: 0, stderr_bytes: 0, server_requests: 0 };
  const doSpawn = opts.spawnImpl ?? spawn;
  const [file, ...args] = cmd;
  if (!file) throw new Error('empty command');

  let child: ChildProcess;
  try {
    child = doSpawn(file, args, { stdio: ['pipe', 'pipe', 'pipe'] });
  } catch {
    return { outcome: 'runner_error', reached_level: 0, exit_code: null, signal: null, init_ms: null, list_ms: null, duration_ms: Date.now() - started, metadata };
  }

  const lines = new LineSplitter(opts.maxStdoutBytes);
  const pending = new Map<number, (r: RpcResponse) => void>();
  let exited: { code: number | null; signal: string | null } | null = null;
  let spawnError = false;
  const exitWaiters: Array<() => void> = [];
  const overflowWaiters: Array<() => void> = [];

  const write = (msg: unknown) => {
    try {
      if (child.stdin && !child.stdin.destroyed) child.stdin.write(`${JSON.stringify(msg)}\n`);
    } catch {
      // 상대가 이미 끝났다(EPIPE) — 결과는 exit 로 판정한다
    }
  };
  child.stdin?.on('error', () => {});

  child.stdout?.on('data', (chunk: Buffer) => {
    const wasOverflow = lines.overflow;
    for (const line of lines.push(chunk)) {
      let msg: unknown;
      try {
        msg = JSON.parse(line);
      } catch {
        metadata.nonjson_lines = (metadata.nonjson_lines as number) + 1;
        continue;
      }
      if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
        metadata.nonjson_lines = (metadata.nonjson_lines as number) + 1;
        continue;
      }
      const m = msg as Record<string, unknown>;
      if (typeof m.method === 'string') {
        // 서버 → 클라이언트 요청이면 지원하지 않는다고 답한다. 알림은 무시.
        if (m.id !== undefined && m.id !== null) {
          metadata.server_requests = (metadata.server_requests as number) + 1;
          write({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'Method not found' } });
        }
        continue;
      }
      if (typeof m.id === 'number' && ('result' in m || 'error' in m)) {
        const r = pending.get(m.id);
        if (r) {
          pending.delete(m.id);
          r({ id: m.id, result: m.result, error: m.error });
        }
      }
    }
    if (!wasOverflow && lines.overflow) for (const w of overflowWaiters.splice(0)) w();
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    metadata.stderr_bytes = (metadata.stderr_bytes as number) + chunk.length;
  });
  child.on('error', () => {
    spawnError = true;
    if (!exited) exited = { code: null, signal: null };
    for (const w of exitWaiters.splice(0)) w();
  });
  child.on('exit', (code, signal) => {
    if (!exited) exited = { code, signal };
    for (const w of exitWaiters.splice(0)) w();
  });

  type Wait = { kind: 'response'; r: RpcResponse } | { kind: 'timeout' } | { kind: 'exit' } | { kind: 'overflow' };
  const request = (id: number, method: string, params: unknown, timeoutMs: number): Promise<Wait> =>
    new Promise<Wait>((resolve) => {
      let done = false;
      const finish = (w: Wait) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        pending.delete(id);
        resolve(w);
      };
      const timer = setTimeout(() => finish({ kind: 'timeout' }), timeoutMs);
      pending.set(id, (r) => finish({ kind: 'response', r }));
      exitWaiters.push(() => setTimeout(() => finish({ kind: 'exit' }), 50)); // 끝나기 직전에 쓴 응답을 먼저 읽는다
      overflowWaiters.push(() => finish({ kind: 'overflow' }));
      if (exited) setTimeout(() => finish({ kind: 'exit' }), 50);
      write({ jsonrpc: '2.0', id, method, params });
    });

  const result = (outcome: Outcome, level: 0 | 1 | 2, initMs: number | null, listMs: number | null, extra: Partial<StdioProbeResult> = {}): StdioProbeResult => {
    if (lines.overflow) metadata.output_limited = true;
    return {
      outcome: spawnError ? 'runner_error' : outcome,
      reached_level: level,
      exit_code: exited?.code ?? null,
      signal: exited?.signal ?? null,
      init_ms: initMs,
      list_ms: listMs,
      duration_ms: Date.now() - started,
      metadata,
      ...extra,
    };
  };

  const stop = async () => {
    try {
      child.stdin?.end();
    } catch {
      // 무시
    }
    if (!exited) {
      await new Promise<void>((r) => {
        const t = setTimeout(r, 1_000);
        exitWaiters.push(() => {
          clearTimeout(t);
          r();
        });
      });
    }
    if (!exited) {
      try {
        child.kill('SIGKILL');
      } catch {
        // 무시
      }
    }
  };

  try {
    // L1: initialize
    const t0 = Date.now();
    const init = await request(
      1,
      'initialize',
      { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'lowdown-sandbox', version: SANDBOX_RUNNER_VERSION } },
      opts.initTimeoutMs,
    );
    const initMs = Date.now() - t0;
    if (init.kind === 'overflow') return result('output_limit', 0, null, null);
    if (init.kind === 'timeout') return result('init_timeout', 0, null, null);
    if (init.kind === 'exit') return result('exited', 0, null, null);
    if (init.r.error !== undefined) {
      metadata.rpc_error_code = rpcErrorCode(init.r.error);
      return result('init_error', 0, initMs, null);
    }
    const ir = init.r.result;
    if (!ir || typeof ir !== 'object' || Array.isArray(ir)) return result('init_invalid', 0, initMs, null);
    const iro = ir as { protocolVersion?: unknown; serverInfo?: unknown; capabilities?: unknown };
    const caps = capabilityKeys(iro.capabilities);
    if (caps) metadata.capabilities = caps;
    metadata.protocol_version = shortText(iro.protocolVersion, 32);
    if (iro.serverInfo && typeof iro.serverInfo === 'object') {
      metadata.server_version = shortText((iro.serverInfo as { version?: unknown }).version);
    }

    write({ jsonrpc: '2.0', method: 'notifications/initialized' });

    // L2: tools/list
    const t1 = Date.now();
    const list = await request(2, 'tools/list', {}, opts.listTimeoutMs);
    const listMs = Date.now() - t1;
    if (list.kind === 'overflow') return result('output_limit', 1, initMs, null);
    if (list.kind === 'timeout') return result('list_timeout', 1, initMs, null);
    if (list.kind === 'exit') return result('exited_after_init', 1, initMs, null);
    if (list.r.error !== undefined) {
      metadata.rpc_error_code = rpcErrorCode(list.r.error);
      return result('list_error', 1, initMs, listMs);
    }
    const lr = list.r.result as { tools?: unknown; nextCursor?: unknown } | null;
    if (!lr || typeof lr !== 'object' || !Array.isArray(lr.tools)) return result('list_invalid', 1, initMs, listMs);

    metadata.tool_count = lr.tools.length;
    metadata.tools_has_more = typeof lr.nextCursor === 'string' && lr.nextCursor.length > 0;
    try {
      Object.assign(metadata, hashTools(lr.tools));
    } catch {
      metadata.hash_error = true;
    }
    const tn = toolNameList(lr.tools);
    metadata.names_hash = namesHash(tn.names);
    if (tn.rejected > 0) metadata.tool_names_rejected = tn.rejected;
    let defs: ToolDef[] | undefined;
    try {
      defs = lr.tools.map(toolDefOf);
      metadata.tool_set_hash = toolSetHash(defs.map((d) => d.def_hash));
    } catch {
      metadata.tool_defs_error = true;
    }
    return result('ok', 2, initMs, listMs, { tool_names: tn.names, ...(defs ? { tool_defs: defs } : {}) });
  } finally {
    await stop();
  }
}
