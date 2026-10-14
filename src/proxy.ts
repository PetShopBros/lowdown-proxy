import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { recordInteraction, type InteractionRecord } from "./record.js";
import { getNodeId } from "./node-identity.js";
import { annotateToolResult, type LogWatcher } from "./log-watch.js";
import { classifyResponse, schemaHash, serverVersionOf } from "./classify.js";

interface PendingCall {
  method: string;
  toolName?: string;
  paged: boolean; // tools/list 요청에 cursor 가 있었는지 (페이지 일부면 해시하지 않음)
  startedAt: number;
}

interface ProxyOptions {
  command: string;
  args: string[];
  actor: string;      // 이 프록시를 호출하는 클라이언트를 식별할 라벨
  targetLabel: string; // 이 프록시가 감싸는 MCP 서버를 식별할 라벨 (target)
  source: "organic" | "seeded" | "synthetic";
  logWatcher?: LogWatcher;
  record?: (r: InteractionRecord) => void | Promise<void>; // 테스트용 주입
}

/**
 * lowdown-proxy 핵심 로직.
 *
 * 설계 원칙 (lowdown-brief.md 참고):
 * - 패스스루가 최우선. 기록 로직이 통신을 막거나 지연시켜선 안 된다.
 * - "무슨 일이 일어났는가"만 기록한다(Interaction 레이어). 품질 판단(Opinion)은 v0 범위 밖.
 * - 판정 기준은 classify.ts: tools/call 의 isError 는 실패, 잘못된 요청(-32602 등)은 서버 실패와 분리,
 *   tools/call 이 아닌 요청은 protocol 로 남기고 성공률에 넣지 않는다.
 * - 각 행에 그 시점의 server_version(initialize)·schema_hash(tools/list)를 찍는다.
 */
export function runProxy(opts: ProxyOptions): void {
  const nodeId = getNodeId();
  const record = opts.record ?? ((r: InteractionRecord) => recordInteraction(r));
  const child = spawn(opts.command, opts.args, {
    stdio: ["pipe", "pipe", "inherit"], // stderr는 그대로 상위로 흘려보냄(디버깅용)
    shell: process.platform === "win32",
  });

  const pending = new Map<string | number, PendingCall>();
  const state: { serverVersion?: string; schemaHash?: string } = {};

  // ── Client(부모 프로세스의 stdin) → Server(child.stdin) ──
  const clientReader = createInterface({ input: process.stdin });
  clientReader.on("line", (line) => {
    // 항상 먼저 그대로 전달 — 파싱 실패해도 패스스루는 깨지면 안 됨
    child.stdin.write(line + "\n");
    trackRequest(pending, line);
  });

  // ── Server(child.stdout) → Client(부모 프로세스의 stdout) ──
  const serverReader = createInterface({ input: child.stdout });
  serverReader.on("line", (line) => {
    let out = line;
    if (opts.logWatcher) {
      try {
        const m = JSON.parse(line);
        if (m?.id !== undefined && pending.get(m.id)?.method === "tools/call") {
          const annotated = annotateToolResult(m, opts.logWatcher);
          if (annotated) out = JSON.stringify(annotated);
        }
      } catch {
        // passthrough
      }
    }
    process.stdout.write(out + "\n");

    const rec = buildRecord(pending, state, line, { ...opts, nodeId });
    if (rec) void Promise.resolve(record(rec)).catch(() => {}); // fire-and-forget
  });

  child.on("exit", (code) => {
    process.exit(code ?? 0);
  });

  process.on("SIGINT", () => child.kill("SIGINT"));
  process.on("SIGTERM", () => child.kill("SIGTERM"));
}

/** 클라이언트 → 서버 한 줄. id 있는 요청이면 pending 에 등록. */
export function trackRequest(pending: Map<string | number, PendingCall>, line: string, now = Date.now()): void {
  try {
    const msg = JSON.parse(line);
    if (msg?.id !== undefined && typeof msg?.method === "string") {
      pending.set(msg.id, {
        method: msg.method,
        toolName: msg.method === "tools/call" && typeof msg.params?.name === "string" ? msg.params.name : undefined,
        paged: msg.method === "tools/list" && msg.params?.cursor !== undefined,
        startedAt: now,
      });
    }
  } catch {
    // JSON이 아니거나 파싱 실패 — 무시하고 패스스루만 유지
  }
}

/** 서버 → 클라이언트 한 줄. 대기 중인 요청의 응답이면 기록 1건을 만든다(상태도 갱신). */
export function buildRecord(
  pending: Map<string | number, PendingCall>,
  state: { serverVersion?: string; schemaHash?: string },
  line: string,
  opts: { actor: string; targetLabel: string; source: ProxyOptions["source"]; nodeId: string },
  now = Date.now(),
): InteractionRecord | null {
  let msg: any;
  try {
    msg = JSON.parse(line);
  } catch {
    return null;
  }
  if (msg?.id === undefined || !pending.has(msg.id)) return null;
  const call = pending.get(msg.id)!;
  pending.delete(msg.id);

  if (!msg.error) {
    if (call.method === "initialize") {
      const v = serverVersionOf(msg);
      if (v) state.serverVersion = v;
    } else if (call.method === "tools/list" && Array.isArray(msg.result?.tools) && !call.paged && msg.result?.nextCursor === undefined) {
      state.schemaHash = schemaHash(msg.result.tools);
    }
  }

  const c = classifyResponse(call.method, msg);
  return {
    actor: opts.actor,
    target: opts.targetLabel,
    target_type: "tool",
    task_type: call.toolName ?? call.method,
    outcome: c.outcome,
    ...(c.failure_type ? { failure_type: c.failure_type } : {}),
    ...(c.error_layer ? { error_layer: c.error_layer } : {}),
    request_kind: c.request_kind,
    latency_ms: now - call.startedAt,
    source: opts.source,
    node_id: opts.nodeId,
    ...(state.serverVersion ? { server_version: state.serverVersion } : {}),
    ...(state.schemaHash ? { schema_hash: state.schemaHash } : {}),
  };
}
