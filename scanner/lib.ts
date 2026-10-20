// Lowdown MCP Scanner — 핵심 로직 (의존성 0, Node >= 22.18)
// 원칙: 관찰한 사실만 기록한다. tools/call 은 하지 않는다. tool 이름/설명문은 저장하지 않는다.

import { createHash } from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns';
import type { LookupAddress } from 'node:dns';
import type { IncomingHttpHeaders } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP } from 'node:net';
import type { LookupFunction } from 'node:net';

// 관찰 결과의 의미가 바뀌는 수정(probe 판정·저장 필드·코호트 규칙)마다 올린다. CHANGELOG 의 Scanner 항목과 맞춘다.
//   0.1.0 — 2026-10-06 최초 / 0.2.0 — 2026-10-16 scanner_commit·registry_fetched_at 기록 시작
//   0.3.0 — 2026-10-19 메인 probe 호스트당 동시 1건 / 0.4.0 — capabilities·names_hash 기록, 도구 이름 목록 별도 저장
//   (0.1.0 기간에도 재시도·대체·사유 분리가 추가됐으므로 그 기간 행의 정확한 코드는 알 수 없다)
export const SCANNER_VERSION = '0.4.0';
export const MCP_PROTOCOL_VERSION = '2025-06-18';
export const USER_AGENT = `lowdown-scanner/${SCANNER_VERSION}`;
export const DEFAULT_REGISTRY_URL = 'https://registry.modelcontextprotocol.io';

/** 실행 중인 코드의 git commit (GitHub Actions 의 GITHUB_SHA). 앞 12자. 형식이 아니면 null(로컬 실행 등) */
export function scannerCommit(sha: string | undefined = process.env.GITHUB_SHA): string | null {
  const s = sha?.trim().toLowerCase() ?? '';
  return /^[0-9a-f]{40}$/.test(s) ? s.slice(0, 12) : null;
}

// ─────────────────────────────────────────────
// SSRF 방어
// ─────────────────────────────────────────────

const blockedRanges = new BlockList();
for (const [addr, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  blockedRanges.addSubnet(addr, prefix, 'ipv4');
}
for (const [addr, prefix] of [
  ['::', 96], // ::, ::1, IPv4-compatible
  // IPv4-mapped(::ffff:0:0/96)는 일부러 넣지 않는다: Node BlockList 는 IPv4 규칙을 mapped 주소에도 적용하며,
  // 이 대역을 넣으면 모든 IPv4 가 차단된다.
  ['64:ff9b::', 96], // NAT64
  ['64:ff9b:1::', 48],
  ['100::', 64], // discard
  ['2001::', 32], // Teredo
  ['2001:db8::', 32], // documentation
  ['2002::', 16], // 6to4
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link-local
  ['ff00::', 8], // multicast
] as const) {
  blockedRanges.addSubnet(addr, prefix, 'ipv6');
}

export function isBlockedIp(ip: string): boolean {
  const family = isIP(ip);
  if (family === 0) return true; // 해석 불가 → 차단
  return blockedRanges.check(ip, family === 4 ? 'ipv4' : 'ipv6');
}

export class BlockedUrlError extends Error {
  code: string;
  constructor(reason: string) {
    super(`blocked url: ${reason}`);
    this.name = 'BlockedUrlError';
    this.code = 'LD_BLOCKED_URL';
  }
}

/** https 공개 호스트만 허용. 통과한 URL 객체를 반환, 아니면 BlockedUrlError. */
export function parseSafeUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new BlockedUrlError('invalid_url');
  }
  if (u.protocol !== 'https:') throw new BlockedUrlError('not_https');
  if (u.username || u.password) throw new BlockedUrlError('credentials_in_url');
  let host = u.hostname.toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  host = host.replace(/\.$/, '');
  if (!host) throw new BlockedUrlError('empty_host');
  if (isIP(host)) {
    if (isBlockedIp(host)) throw new BlockedUrlError('blocked_ip');
    return u;
  }
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host.endsWith('.localdomain') ||
    !host.includes('.')
  ) {
    throw new BlockedUrlError('local_hostname');
  }
  return u;
}

/** 연결 시점 DNS 검증(DNS rebinding 방어): 하나라도 차단 대역이면 연결하지 않는다. */
export const safeLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) {
      callback(err, '', 0);
      return;
    }
    const list = addresses as LookupAddress[];
    if (list.length === 0 || list.some((a) => isBlockedIp(a.address))) {
      callback(new BlockedUrlError('blocked_ip') as unknown as NodeJS.ErrnoException, '', 0);
      return;
    }
    if (options.all) {
      callback(null, list);
    } else {
      const first = list[0] as LookupAddress;
      callback(null, first.address, first.family);
    }
  });
};

// ─────────────────────────────────────────────
// 전송 계층 (node:https, 리다이렉트 미추적)
// ─────────────────────────────────────────────

export type ErrorType =
  | 'timeout'
  | 'dns'
  | 'tls'
  | 'conn_refused'
  | 'conn_reset'
  | 'blocked_url'
  | 'invalid_response'
  | 'network_error';

export class TransportError extends Error {
  errorType: ErrorType;
  ms: number | null;
  constructor(errorType: ErrorType, message: string, ms: number | null = null) {
    super(message);
    this.name = 'TransportError';
    this.errorType = errorType;
    this.ms = ms;
  }
}

export function classifyNetworkError(e: unknown): ErrorType {
  if (e instanceof TransportError) return e.errorType;
  if (e instanceof BlockedUrlError) return 'blocked_url';
  const err = e as { code?: unknown; errors?: unknown[]; message?: unknown } | null;
  let code = typeof err?.code === 'string' ? err.code : '';
  if (!code && Array.isArray(err?.errors)) {
    const inner = err.errors[0] as { code?: unknown } | undefined;
    if (typeof inner?.code === 'string') code = inner.code;
  }
  if (code === 'LD_BLOCKED_URL') return 'blocked_url';
  if (code === 'LD_TIMEOUT' || code === 'ETIMEDOUT' || code === 'ESOCKETTIMEDOUT') return 'timeout';
  if (['ENOTFOUND', 'EAI_AGAIN', 'EAI_NODATA', 'EAI_FAIL', 'EAI_NONAME'].includes(code)) return 'dns';
  if (code === 'ECONNREFUSED') return 'conn_refused';
  if (code === 'ECONNRESET' || code === 'EPIPE') return 'conn_reset';
  if (/^(ERR_TLS_|ERR_SSL_|ERR_OSSL|CERT_|DEPTH_ZERO|UNABLE_TO_|SELF_SIGNED|HOSTNAME_MISMATCH|EPROTO)/.test(code)) {
    return 'tls';
  }
  if (typeof err?.message === 'string' && /certificate|tls|ssl/i.test(err.message)) return 'tls';
  return 'network_error';
}

export interface RpcMessage {
  id?: unknown;
  result?: unknown;
  error?: unknown;
  [key: string]: unknown;
}

export interface PostOptions {
  headers?: Record<string, string>;
  timeoutMs: number;
  maxBytes: number;
  /** 지정하면 본문에서 해당 id 의 JSON-RPC 응답을 찾는다. 미지정이면 응답 헤더만 받고 종료. */
  expectId?: number;
  method?: 'POST' | 'DELETE';
  /** 테스트 전용. scan.ts 는 사용하지 않는다. */
  allowPrivate?: boolean;
  ca?: string;
}

export interface PostResult {
  status: number;
  headers: IncomingHttpHeaders;
  contentType: string;
  message: RpcMessage | null;
  parseError: boolean;
  ms: number;
}

export type PostFn = (url: string, body: string | null, opts: PostOptions) => Promise<PostResult>;

function isReply(v: unknown, id: number): v is RpcMessage {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const m = v as RpcMessage;
  return (m.id === id || m.id === String(id)) && ('result' in m || 'error' in m);
}

function findReply(parsed: unknown, id: number): RpcMessage | null {
  if (Array.isArray(parsed)) {
    for (const p of parsed) if (isReply(p, id)) return p;
    return null;
  }
  return isReply(parsed, id) ? parsed : null;
}

function extractFromSse(text: string, id: number): RpcMessage | null {
  for (const ev of text.split(/\r?\n\r?\n/)) {
    const data = ev
      .split(/\r?\n/)
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).replace(/^ /, ''))
      .join('\n');
    if (!data) continue;
    try {
      const r = findReply(JSON.parse(data), id);
      if (r) return r;
    } catch {
      // 아직 덜 받은 이벤트 — 무시
    }
  }
  return null;
}

export function extractRpcMessage(text: string, sse: boolean, id: number): RpcMessage | null {
  if (sse) return extractFromSse(text, id);
  try {
    const r = findReply(JSON.parse(text.trim()), id);
    if (r) return r;
  } catch {
    // JSON 아님 — 아래 SSE 형식 fallback 시도
  }
  return /^\s*(event|data):/m.test(text) ? extractFromSse(text, id) : null;
}

export function httpsPost(rawUrl: string, body: string | null, opts: PostOptions): Promise<PostResult> {
  return new Promise<PostResult>((resolve, reject) => {
    let url: URL;
    try {
      url = opts.allowPrivate ? new URL(rawUrl) : parseSafeUrl(rawUrl);
    } catch (e) {
      reject(new TransportError(classifyNetworkError(e), 'url rejected', 0));
      return;
    }

    const started = performance.now();
    const elapsed = () => Math.round(performance.now() - started);
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      fn();
    };
    const fail = (e: unknown) => done(() => reject(new TransportError(classifyNetworkError(e), 'request failed', elapsed())));

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'Accept-Encoding': 'identity',
      'User-Agent': USER_AGENT,
      ...opts.headers,
    };
    if (body !== null) headers['Content-Length'] = String(Buffer.byteLength(body));

    const req = httpsRequest(
      url,
      {
        method: opts.method ?? 'POST',
        headers,
        agent: false,
        ...(opts.allowPrivate ? {} : { lookup: safeLookup }),
        ...(opts.ca ? { ca: opts.ca } : {}),
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const contentType = String(res.headers['content-type'] ?? '').toLowerCase();
        const base = { status, headers: res.headers, contentType };
        const ok = status >= 200 && status < 300;
        if (!ok || opts.expectId === undefined) {
          res.destroy();
          done(() => resolve({ ...base, message: null, parseError: false, ms: elapsed() }));
          return;
        }
        const id = opts.expectId;
        const sse = contentType.includes('text/event-stream');
        let text = '';
        let size = 0;
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          if (settled) return;
          size += Buffer.byteLength(chunk);
          if (size > opts.maxBytes) {
            res.destroy();
            done(() => resolve({ ...base, message: null, parseError: true, ms: elapsed() }));
            return;
          }
          text += chunk;
          if (sse) {
            const m = extractRpcMessage(text, true, id);
            if (m) {
              res.destroy();
              done(() => resolve({ ...base, message: m, parseError: false, ms: elapsed() }));
            }
          }
        });
        const finish = () => {
          const m = extractRpcMessage(text, sse, id);
          done(() => resolve({ ...base, message: m, parseError: m === null, ms: elapsed() }));
        };
        res.on('end', finish);
        res.on('close', finish);
        res.on('error', fail);
      },
    );

    timer = setTimeout(() => {
      done(() => reject(new TransportError('timeout', 'timeout', elapsed())));
      req.destroy();
    }, opts.timeoutMs);

    req.on('error', fail);
    try {
      req.end(body ?? undefined);
    } catch (e) {
      fail(e);
    }
  });
}

// ─────────────────────────────────────────────
// 해시 (tool 이름/설명문은 저장하지 않고 해시만 저장)
// ─────────────────────────────────────────────

export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  const o = v as Record<string, unknown>;
  const parts = Object.keys(o)
    .sort()
    .filter((k) => o[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`);
  return `{${parts.join(',')}}`;
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** schema_hash: name + inputSchema + outputSchema. desc_hash: name + title + description. 순서/키 순서 무관. */
export function hashTools(tools: unknown[]): { schema_hash: string; desc_hash: string } {
  const objs = tools.map((t) => (typeof t === 'object' && t !== null && !Array.isArray(t) ? (t as Record<string, unknown>) : {}));
  const byName = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  const schema = objs
    .map((t) => canonicalJson({ name: t.name, inputSchema: t.inputSchema, outputSchema: t.outputSchema }))
    .sort(byName);
  const desc = objs.map((t) => canonicalJson({ name: t.name, title: t.title, description: t.description })).sort(byName);
  return { schema_hash: sha256(`[${schema.join(',')}]`), desc_hash: sha256(`[${desc.join(',')}]`) };
}

function shortText(v: unknown, max = 64): string | null {
  if (typeof v !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  return v.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, max) || null;
}

// ─────────────────────────────────────────────
// Probe (L1 initialize → L2 tools/list)
// ─────────────────────────────────────────────

export interface ProbeResult {
  transport: string;
  http_status: number | null;
  reached_level: 0 | 1 | 2;
  latency_ms: number | null;
  /** HTTP 응답을 받지 못했거나(timeout/dns/tls/...) 2xx 인데 JSON-RPC 응답이 아닐 때(invalid_response)만 채운다. */
  error_type: string | null;
  metadata: Record<string, unknown>;
  /** L2 에서 받은 도구 이름(형식 통과분, 정렬). 관찰 행에는 넣지 않고 scanner_tool_sets 로만 저장한다. */
  tool_names?: string[];
}

const CAPABILITY_KEY = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;
const TOOL_NAME = /^[A-Za-z0-9_.\-/]{1,64}$/;
export const MAX_CAPABILITIES = 20;
export const MAX_TOOL_NAMES = 200;

/** initialize 결과 capabilities 의 최상위 키 이름만(형식 통과, 정렬, 최대 20). experimental 안쪽 키는 보지 않는다. */
export function capabilityKeys(caps: unknown): string[] | null {
  if (typeof caps !== 'object' || caps === null || Array.isArray(caps)) return null;
  return Object.keys(caps)
    .filter((k) => CAPABILITY_KEY.test(k))
    .sort()
    .slice(0, MAX_CAPABILITIES);
}

/** tools/list 의 도구 이름(형식 통과분, 중복 제거, 정렬, 최대 200). 설명문은 보지 않는다. */
export function toolNameList(tools: readonly unknown[]): { names: string[]; rejected: number } {
  const ok = new Set<string>();
  let rejected = 0;
  for (const t of tools) {
    const name = typeof t === 'object' && t !== null ? (t as { name?: unknown }).name : undefined;
    if (typeof name === 'string' && TOOL_NAME.test(name)) ok.add(name);
    else rejected++;
  }
  const sorted = [...ok].sort();
  rejected += Math.max(0, sorted.length - MAX_TOOL_NAMES);
  return { names: sorted.slice(0, MAX_TOOL_NAMES), rejected };
}

/** 정렬된 이름 목록의 해시. 이름 집합이 같으면 스키마·설명이 바뀌어도 같다. */
export function namesHash(names: readonly string[]): string {
  return sha256(JSON.stringify([...names].sort()));
}

export interface RegistryRemote {
  type: string;
  url: string;
}

function headerValue(h: IncomingHttpHeaders, name: string): string | undefined {
  const v = h[name];
  return Array.isArray(v) ? v.join(', ') : v;
}

function noteAuthHeaders(metadata: Record<string, unknown>, res: PostResult): void {
  if (res.status === 401 || res.status === 403) {
    const wa = headerValue(res.headers, 'www-authenticate');
    metadata.www_authenticate = wa !== undefined;
    metadata.www_authenticate_resource_metadata = wa !== undefined && /resource_metadata\s*=/i.test(wa);
  }
}

function rpcErrorCode(msg: RpcMessage): number | null {
  const e = msg.error;
  if (typeof e === 'object' && e !== null) {
    const c = (e as { code?: unknown }).code;
    if (typeof c === 'number' && Number.isFinite(c)) return c;
  }
  return null;
}

const SAFE_SESSION_ID = /^[\x21-\x7e]{1,256}$/;

export async function probeRemote(
  remote: RegistryRemote,
  ctx: { registryVersion: string; index: number },
  post: PostFn = httpsPost,
): Promise<ProbeResult> {
  const metadata: Record<string, unknown> = {
    remote_url: remote.url,
    remote_index: ctx.index,
    registry_version: ctx.registryVersion,
    scanner_version: SCANNER_VERSION,
  };
  let toolNames: string[] | undefined;
  const out = (p: Omit<ProbeResult, 'transport' | 'metadata' | 'tool_names'>): ProbeResult => ({
    transport: remote.type,
    metadata,
    ...p,
    ...(toolNames ? { tool_names: toolNames } : {}),
  });

  // L1: initialize
  let init: PostResult;
  try {
    init = await post(
      remote.url,
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'lowdown-scanner', version: SCANNER_VERSION },
        },
      }),
      { timeoutMs: 10_000, maxBytes: 1 << 20, expectId: 1 },
    );
  } catch (e) {
    const te = e instanceof TransportError ? e : null;
    return out({
      http_status: null,
      reached_level: 0,
      latency_ms: te?.ms ?? null,
      error_type: classifyNetworkError(e),
    });
  }

  const latency = init.ms;
  metadata.init_status = init.status;
  noteAuthHeaders(metadata, init);
  if (init.status < 200 || init.status >= 300) {
    return out({ http_status: init.status, reached_level: 0, latency_ms: latency, error_type: null });
  }
  if (!init.message) {
    return out({ http_status: init.status, reached_level: 0, latency_ms: latency, error_type: 'invalid_response' });
  }
  if ('error' in init.message) {
    metadata.rpc_error_code = rpcErrorCode(init.message);
    return out({ http_status: init.status, reached_level: 0, latency_ms: latency, error_type: null });
  }
  const initResult = init.message.result;
  if (typeof initResult !== 'object' || initResult === null) {
    return out({ http_status: init.status, reached_level: 0, latency_ms: latency, error_type: 'invalid_response' });
  }
  const ir = initResult as { protocolVersion?: unknown; serverInfo?: unknown; capabilities?: unknown };
  const caps = capabilityKeys(ir.capabilities);
  if (caps) metadata.capabilities = caps;
  const negotiated =
    typeof ir.protocolVersion === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(ir.protocolVersion)
      ? ir.protocolVersion
      : MCP_PROTOCOL_VERSION;
  metadata.protocol_version = shortText(ir.protocolVersion, 32);
  if (typeof ir.serverInfo === 'object' && ir.serverInfo !== null) {
    metadata.server_version = shortText((ir.serverInfo as { version?: unknown }).version);
  }
  const sessionRaw = headerValue(init.headers, 'mcp-session-id');
  const sessionId = sessionRaw && SAFE_SESSION_ID.test(sessionRaw) ? sessionRaw : undefined;
  metadata.session_id_issued = sessionRaw !== undefined;

  const followHeaders: Record<string, string> = { 'MCP-Protocol-Version': negotiated };
  if (sessionId) followHeaders['Mcp-Session-Id'] = sessionId;

  // 세션 종료는 결과에 영향을 주지 않는 best-effort
  const closeSession = async () => {
    if (!sessionId) return;
    try {
      await post(remote.url, null, { method: 'DELETE', headers: followHeaders, timeoutMs: 3_000, maxBytes: 0 });
    } catch {
      // 무시
    }
  };

  try {
    // initialized 알림 (best-effort)
    try {
      await post(remote.url, JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }), {
        headers: followHeaders,
        timeoutMs: 5_000,
        maxBytes: 0,
      });
    } catch {
      // 일부 서버는 알림에 응답하지 않음 — tools/list 로 진행
    }

    // L2: tools/list
    let list: PostResult;
    try {
      list = await post(remote.url, JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }), {
        headers: followHeaders,
        timeoutMs: 10_000,
        maxBytes: 4 << 20,
        expectId: 2,
      });
    } catch (e) {
      metadata.list_error_type = classifyNetworkError(e);
      return out({ http_status: init.status, reached_level: 1, latency_ms: latency, error_type: classifyNetworkError(e) });
    }

    metadata.list_status = list.status;
    metadata.list_latency_ms = list.ms;
    noteAuthHeaders(metadata, list);
    if (list.status < 200 || list.status >= 300) {
      return out({ http_status: list.status, reached_level: 1, latency_ms: latency, error_type: null });
    }
    if (!list.message) {
      return out({ http_status: list.status, reached_level: 1, latency_ms: latency, error_type: 'invalid_response' });
    }
    if ('error' in list.message) {
      metadata.rpc_error_code = rpcErrorCode(list.message);
      return out({ http_status: list.status, reached_level: 1, latency_ms: latency, error_type: null });
    }
    const lr = list.message.result as { tools?: unknown; nextCursor?: unknown } | null;
    if (typeof lr !== 'object' || lr === null || !Array.isArray(lr.tools)) {
      return out({ http_status: list.status, reached_level: 1, latency_ms: latency, error_type: 'invalid_response' });
    }
    metadata.tool_count = lr.tools.length;
    metadata.tools_has_more = typeof lr.nextCursor === 'string' && lr.nextCursor.length > 0;
    try {
      Object.assign(metadata, hashTools(lr.tools));
    } catch {
      metadata.hash_error = true;
    }
    const tn = toolNameList(lr.tools);
    toolNames = tn.names;
    metadata.names_hash = namesHash(tn.names);
    if (tn.rejected > 0) metadata.tool_names_rejected = tn.rejected;
    return out({ http_status: list.status, reached_level: 2, latency_ms: latency, error_type: null });
  } finally {
    await closeSession();
  }
}

// ─────────────────────────────────────────────
// Registry 수집
// ─────────────────────────────────────────────

export interface RegistryTarget {
  name: string;
  version: string;
  remotes: RegistryRemote[];
}

/** probe 대상이 아닌(또는 안 되는) 항목을 포함해, Registry 에서 본 모든 이름에 대해 기록한다. 사유 분리(planCohortJobs)에 쓰인다. */
export interface RegistryGapInfo {
  version: string;
  status: string | undefined;
  isLatest: boolean | undefined;
  hasAnyRemotes: boolean;
  hasProbeableRemote: boolean;
}

/**
 * 시장판 1단계(Registry 비교 기록)용: 이름별 선언 요약. probe 여부와 무관하게 모든 항목.
 * 설명문 원문은 저장하지 않고 해시만(등록자 문자열을 옮기지 않음).
 */
export interface RegistryDeclaration {
  version: string;
  status: string | null;
  /** 원격 선언 "type url" 을 정렬해 줄바꿈으로 이은 것. 없으면 '' */
  remotesKey: string;
  /** 패키지 선언 "registryType identifier version transport" 정렬·줄바꿈. 없으면 '' */
  packagesKey: string;
  /** 설명문 SHA-256 앞 16자. 없으면 '' */
  descHash: string;
  /** 원격 주소들의 capHost (정렬, 중복 제거) */
  hosts: string[];
}

function declarationOf(s: Record<string, unknown>, status: string | undefined): RegistryDeclaration {
  const remotes = (Array.isArray(s.remotes) ? (s.remotes as unknown[]) : [])
    .map((r) => r as { type?: unknown; url?: unknown } | null)
    .filter((r): r is { type: string; url: string } => !!r && typeof r.type === 'string' && typeof r.url === 'string');
  const packages = (Array.isArray(s.packages) ? (s.packages as unknown[]) : [])
    .map((p) => p as Record<string, unknown> | null)
    .filter((p): p is Record<string, unknown> => !!p && typeof p === 'object')
    .map((p) => {
      const t = p.transport as { type?: unknown } | undefined;
      return [p.registryType ?? p.registry_type ?? '', p.identifier ?? p.name ?? '', p.version ?? '', t?.type ?? '']
        .map((x) => (typeof x === 'string' ? x : ''))
        .join(' ');
    });
  const desc = typeof s.description === 'string' ? s.description : '';
  const hosts = [...new Set(remotes.map((r) => capHost(r.url)).filter((h): h is string => h !== null))].sort();
  return {
    version: String(s.version ?? ''),
    status: status ?? null,
    remotesKey: [...new Set(remotes.map((r) => `${r.type} ${r.url}`))].sort().join('\n'),
    packagesKey: [...new Set(packages)].sort().join('\n'),
    descHash: desc ? sha256(desc).slice(0, 16) : '',
    hosts,
  };
}

export interface RegistryStats {
  pages: number;
  entries: number;
  active_latest: number;
  targets_with_probeable_remote: number;
  remotes_probeable: number;
  skipped_non_streamable_http: number;
  skipped_templated_url: number;
  duplicate_names: number;
}

const OFFICIAL_META = 'io.modelcontextprotocol.registry/official';
const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface RegistryDeps {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  pageSize?: number;
  /** 무한 페이지 방지 상한. Registry 가 커져도 걸리지 않게 넉넉히(2026-10 기준 약 425 페이지). */
  maxPages?: number;
  /** 페이지당 시도 횟수(기본 6: 대기 2·4·8·16·32초) */
  maxAttempts?: number;
  /** 이 시각(ms) 이후에는 다음 페이지를 요청하지 않고 실패 → 호출 측이 직전 관찰 주소로 대체 */
  deadline?: number;
  now?: () => number;
}

export async function fetchRegistryTargets(
  deps: RegistryDeps = {},
): Promise<{
  targets: RegistryTarget[];
  stats: RegistryStats;
  registryInfo: Map<string, RegistryGapInfo>;
  declarations: Map<string, RegistryDeclaration>;
}> {
  const base = (deps.baseUrl ?? DEFAULT_REGISTRY_URL).replace(/\/+$/, '');
  const f = deps.fetchImpl ?? fetch;
  const sleep = deps.sleep ?? defaultSleep;
  const pageSize = deps.pageSize ?? 100;
  const maxPages = deps.maxPages ?? 2000;
  const maxAttempts = deps.maxAttempts ?? 6;
  const now = deps.now ?? Date.now;

  const stats: RegistryStats = {
    pages: 0,
    entries: 0,
    active_latest: 0,
    targets_with_probeable_remote: 0,
    remotes_probeable: 0,
    skipped_non_streamable_http: 0,
    skipped_templated_url: 0,
    duplicate_names: 0,
  };
  const byName = new Map<string, RegistryTarget>();
  const registryInfo = new Map<string, RegistryGapInfo>();
  const declarations = new Map<string, RegistryDeclaration>();
  const seenKeys = new Set<string>();
  let cursor: string | undefined;

  for (;;) {
    if (stats.pages >= maxPages) throw new Error(`registry: exceeded maxPages=${maxPages}`);
    if (deps.deadline !== undefined && now() > deps.deadline) {
      throw new Error(`registry: time budget exceeded after ${stats.pages} pages`);
    }
    // version=latest: 서버별 최신 버전만 (없으면 모든 버전이 와서 페이지 수가 수 배로 늘어남)
    const qs = new URLSearchParams({ limit: String(pageSize), version: 'latest' });
    if (cursor) qs.set('cursor', cursor);
    const url = `${base}/v0.1/servers?${qs.toString()}`;

    let data: unknown;
    for (let attempt = 1; ; attempt++) {
      let status = 0;
      try {
        const res = await f(url, { headers: { Accept: 'application/json', 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(30_000) });
        status = res.status;
        if (res.ok) {
          data = await res.json();
          break;
        }
      } catch {
        // 네트워크 오류 — 재시도
      }
      const retryable = status === 0 || status >= 500 || status === 429;
      const wait = 1000 * 2 ** attempt;
      // 시간 상한 안에서만 재시도한다(넘기면 호출 측이 직전 관찰 주소로 대체)
      const outOfTime = deps.deadline !== undefined && now() + wait > deps.deadline;
      if (!retryable || attempt >= maxAttempts || outOfTime) {
        throw new Error(`registry: page ${stats.pages + 1} failed (HTTP ${status || 'network'})`);
      }
      await sleep(wait);
    }

    const page = data as { servers?: unknown; metadata?: { nextCursor?: unknown } } | null;
    if (!page || !Array.isArray(page.servers)) throw new Error('registry: unexpected response shape (no servers[])');
    stats.pages++;

    let newKeys = 0;
    for (const entry of page.servers as Array<{ server?: Record<string, unknown>; _meta?: Record<string, unknown> }>) {
      const s = entry?.server;
      if (!s || typeof s.name !== 'string') continue;
      stats.entries++;
      const key = `${s.name}@${String(s.version ?? '')}`;
      if (!seenKeys.has(key)) {
        seenKeys.add(key);
        newKeys++;
      }
      const meta = entry._meta?.[OFFICIAL_META] as { status?: unknown; isLatest?: unknown } | undefined;
      const metaStatus = typeof meta?.status === 'string' ? meta.status : undefined;
      const metaIsLatest = typeof meta?.isLatest === 'boolean' ? meta.isLatest : undefined;
      const version = String(s.version ?? '');
      // 같은 이름이 여러 번 오면(버전 여러 개) isLatest 인 쪽을 우선, 없으면 처음 것
      if (!declarations.has(s.name) || metaIsLatest === true) declarations.set(s.name, declarationOf(s, metaStatus));

      if (!(metaStatus === 'active' && metaIsLatest === true)) {
        registryInfo.set(s.name, { version, status: metaStatus, isLatest: metaIsLatest, hasAnyRemotes: false, hasProbeableRemote: false });
        continue;
      }
      stats.active_latest++;

      const rawRemotes = Array.isArray(s.remotes) ? (s.remotes as unknown[]) : [];
      const remotes: RegistryRemote[] = [];
      const seenUrls = new Set<string>();
      for (const r of rawRemotes) {
        const rr = r as { type?: unknown; url?: unknown } | null;
        if (!rr || typeof rr.type !== 'string' || typeof rr.url !== 'string') continue;
        if (rr.type !== 'streamable-http') {
          stats.skipped_non_streamable_http++;
          continue;
        }
        if (rr.url.includes('{')) {
          stats.skipped_templated_url++;
          continue;
        }
        if (seenUrls.has(rr.url)) continue;
        seenUrls.add(rr.url);
        remotes.push({ type: rr.type, url: rr.url });
      }
      registryInfo.set(s.name, { version, status: metaStatus, isLatest: metaIsLatest, hasAnyRemotes: rawRemotes.length > 0, hasProbeableRemote: remotes.length > 0 });

      if (remotes.length === 0) continue;
      if (byName.has(s.name)) {
        stats.duplicate_names++;
        continue;
      }
      byName.set(s.name, { name: s.name, version, remotes });
      stats.targets_with_probeable_remote++;
      stats.remotes_probeable += remotes.length;
    }

    const next = page.metadata?.nextCursor;
    if (typeof next !== 'string' || next.length === 0) break;
    if (newKeys === 0 || next === cursor) throw new Error('registry: pagination did not advance (cursor ignored?)');
    cursor = next;
  }

  return { targets: [...byName.values()], stats, registryInfo, declarations };
}

// ─────────────────────────────────────────────
// Supabase (PostgREST) 쓰기/읽기
// ─────────────────────────────────────────────

export interface SupabaseConfig {
  url: string;
  key: string;
}

export interface ObservationRow extends ProbeResult {
  scan_run_id: string;
  node_id: string;
  target_id: string;
  target_type: 'mcp_server';
  observed_at: string;
  source: 'scanner';
}

/** 새 형식(sb_...) 키는 apikey 헤더만, 레거시 JWT(service_role)는 apikey + Authorization. */
export function supabaseHeaders(key: string, extra: Record<string, string> = {}): Record<string, string> {
  const h: Record<string, string> = { apikey: key, ...extra };
  if (!key.startsWith('sb_')) h.Authorization = `Bearer ${key}`;
  return h;
}

export interface InsertDeps {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  batchSize?: number;
  maxAttempts?: number;
  /** 이전 시도의 응답이 유실됐을 수 있는 배치의 재시도: 첫 시도의 409(unique index)도 "이미 저장됨"으로 본다 */
  assumeAmbiguous?: boolean;
}

export async function insertObservations(rows: ObservationRow[], cfg: SupabaseConfig, deps: InsertDeps = {}): Promise<number> {
  const f = deps.fetchImpl ?? fetch;
  const sleep = deps.sleep ?? defaultSleep;
  const size = deps.batchSize ?? 200;
  const maxAttempts = deps.maxAttempts ?? 4;
  const endpoint = `${cfg.url.replace(/\/+$/, '')}/rest/v1/scanner_observations`;
  let inserted = 0;

  for (let i = 0; i < rows.length; i += size) {
    const batch = rows.slice(i, i + size);
    const body = JSON.stringify(batch);
    let ambiguous = deps.assumeAmbiguous === true;
    for (let attempt = 1; ; attempt++) {
      let res: Response | null = null;
      try {
        res = await f(endpoint, {
          method: 'POST',
          headers: supabaseHeaders(cfg.key, { 'Content-Type': 'application/json', Prefer: 'return=minimal' }),
          body,
          signal: AbortSignal.timeout(30_000),
        });
      } catch {
        res = null;
      }
      if (res && res.status >= 200 && res.status < 300) {
        inserted += batch.length;
        break;
      }
      // 응답 유실 후 재시도에서 409 = 이미 커밋된 배치(unique index)
      if (res && res.status === 409 && ambiguous) {
        inserted += batch.length;
        break;
      }
      const retryable = !res || res.status >= 500 || res.status === 429 || res.status === 408;
      if (retryable) ambiguous = true;
      if (!retryable || attempt >= maxAttempts) {
        let snippet = '';
        try {
          snippet = res ? (await res.text()).slice(0, 300) : '';
        } catch {
          // 무시
        }
        throw new Error(`supabase insert failed: HTTP ${res?.status ?? 'network'} ${snippet}`.trim());
      }
      await sleep(1000 * 2 ** (attempt - 1));
    }
  }
  return inserted;
}

export interface DurableInserterOpts {
  /** 테스트용 주입. 기본은 insertObservations */
  insert?: (rows: ObservationRow[], cfg: SupabaseConfig, deps: InsertDeps) => Promise<number>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  log?: (msg: string) => void;
  /** 저장이 막힌 뒤 새 배치를 바로 시도하지 않는 시간(ms). 기본 60초 */
  cooldownMs?: number;
  /** 스캔이 끝난 뒤 남은 배치를 다시 시도하기 전 대기(ms). 기본 60·120·240초 */
  recoveryWaitsMs?: number[];
}

export interface DurableInserter {
  /** 배치 하나를 저장한다. 실패해도 throw 하지 않고 보관해 두었다가 다시 시도한다. */
  push(batch: ObservationRow[]): Promise<void>;
  /** 스캔이 끝난 뒤: 남은 배치를 대기 후 재시도하고, 끝내 못 넣은 행을 돌려준다. */
  finish(): Promise<{ unsaved: ObservationRow[] }>;
  inserted(): number;
  backlogBatches(): number;
}

/**
 * 저장 실패 한 번이 16분짜리 스캔 전체를 버리지 않게 한다(2026-10-20 06:10 UTC, Supabase 응답 없음).
 * 실패한 배치는 메모리에 보관, 막힌 동안은 60초에 한 번만 1회 시도, 끝난 뒤 길게 대기하며 재시도.
 * 보관한 배치는 응답이 유실됐을 수 있으므로 409(unique index)를 "이미 저장됨"으로 본다.
 */
export function createDurableInserter(cfg: SupabaseConfig, opts: DurableInserterOpts = {}): DurableInserter {
  const insert = opts.insert ?? insertObservations;
  const sleep = opts.sleep ?? defaultSleep;
  const now = opts.now ?? Date.now;
  const log = opts.log ?? (() => {});
  const cooldownMs = opts.cooldownMs ?? 60_000;
  const waits = opts.recoveryWaitsMs ?? [60_000, 120_000, 240_000];
  const backlog: ObservationRow[][] = [];
  let inserted = 0;
  let blockedAt = 0; // 0 = 막히지 않음

  const attempt = async (batch: ObservationRow[], maxAttempts: number, ambiguous: boolean): Promise<boolean> => {
    try {
      inserted += await insert(batch, cfg, { maxAttempts, assumeAmbiguous: ambiguous });
      return true;
    } catch (e) {
      log(`저장 실패(보관 후 재시도): ${e instanceof Error ? e.message : 'unknown'}`);
      return false;
    }
  };

  const drain = async (maxAttempts: number): Promise<boolean> => {
    while (backlog.length > 0) {
      if (!(await attempt(backlog[0]!, maxAttempts, true))) return false;
      backlog.shift();
    }
    return true;
  };

  return {
    async push(batch) {
      if (batch.length === 0) return;
      if (blockedAt && now() - blockedAt < cooldownMs) {
        backlog.push(batch);
        return;
      }
      const probing = blockedAt !== 0; // 막혀 있던 뒤의 첫 시도는 1회만(오래 붙잡히지 않게)
      const maxAttempts = probing ? 1 : 4;
      if (backlog.length > 0 && !(await drain(maxAttempts))) {
        blockedAt = now();
        backlog.push(batch);
        return;
      }
      if (await attempt(batch, maxAttempts, false)) {
        if (probing) log(`저장 복구(보관 배치 모두 저장)`);
        blockedAt = 0;
        return;
      }
      blockedAt = now();
      backlog.push(batch);
    },
    async finish() {
      for (const w of waits) {
        if (backlog.length === 0) break;
        log(`보관한 배치 ${backlog.length}개, ${Math.round(w / 1000)}초 뒤 재시도`);
        await sleep(w);
        if (await drain(4)) blockedAt = 0;
      }
      if (backlog.length === 0) return { unsaved: [] };
      const unsaved = backlog.splice(0).flat();
      return { unsaved };
    },
    inserted: () => inserted,
    backlogBatches: () => backlog.length,
  };
}

// ─────────────────────────────────────────────
// 고정 코호트 (Day 0 에 확정 → 이후 같은 대상만 관찰)
// ─────────────────────────────────────────────

export const DEFAULT_COHORT_VERSION = '2026-10-07-v1';
export const DEFAULT_COHORT_SIZE = 2000;
export const MAX_COHORT_SIZE = 10_000;

/** target_id(`mcp:...`)를 SHA-256 으로 정렬해 상위 size 개. 입력 순서와 무관하게 결정적. */
export function selectCohort(targetIds: string[], size: number): string[] {
  const unique = [...new Set(targetIds)];
  return unique
    .map((id) => ({ id, h: sha256(id) }))
    .sort((a, b) => (a.h < b.h ? -1 : a.h > b.h ? 1 : a.id < b.id ? -1 : 1))
    .slice(0, size)
    .map((x) => x.id);
}

/**
 * 기존 코호트(base)를 전부 포함한 확장 코호트. base 멤버는 지금 Registry 에 없어도 빠지지 않는다(시계열 유지).
 * 추가분은 base 밖 후보에서 같은 SHA-256 순서로 size - base 개.
 */
export function extendCohort(baseIds: readonly string[], candidateIds: readonly string[], size: number): string[] {
  const base = [...new Set(baseIds)];
  if (base.length === 0) throw new Error('extendCohort: base 코호트가 비어 있습니다');
  if (base.length > size) throw new Error(`extendCohort: base(${base.length}) 가 size(${size}) 보다 큽니다`);
  const baseSet = new Set(base);
  const extra = selectCohort(candidateIds.filter((id) => !baseSet.has(id)), size - base.length);
  return [...base, ...extra];
}

/**
 * 호스트 상한용 정규화: URL 의 hostname(소문자, 포트 제외, 끝 점 제거). 파싱 불가면 null.
 * 등록 도메인으로 묶지 않는다(a.workers.dev 와 b.workers.dev 는 별개). 호스트 ≠ 운영자.
 */
export function capHost(rawUrl: string): string | null {
  try {
    const h = new URL(rawUrl).hostname.toLowerCase().replace(/\.+$/, '');
    return h || null;
  } catch {
    return null;
  }
}

export interface CappedCohort {
  ids: string[];
  /** 추가분으로 뽑힌 수 */
  added: number;
  /** size 를 채우지 못한 수 (상한을 넘겨 채우지 않는다) */
  shortfall: number;
  /** 상한 때문에 건너뛴 후보 수 */
  skippedByCap: number;
}

/**
 * 호스트 상한을 둔 확장 코호트. base 는 전부 유지하고, base 멤버의 호스트를 할당량에 먼저 센다.
 * 추가분은 base 밖 후보를 SHA-256 순서로 보며, 그 후보의 모든 원격 호스트가 cap 미만일 때만 넣는다
 * (원격이 여러 개면 각 호스트에 1씩). cap <= 0 이면 상한 없음(= extendCohort 와 같은 결과).
 * hostsOf 에 없는 base 멤버(지금 Registry 에 없음)는 할당량에 세지 않는다.
 */
export function extendCohortCapped(
  baseIds: readonly string[],
  candidateIds: readonly string[],
  size: number,
  cap: number,
  hostsOf: ReadonlyMap<string, readonly string[]>,
): CappedCohort {
  const base = [...new Set(baseIds)];
  if (base.length === 0) throw new Error('extendCohortCapped: base 코호트가 비어 있습니다');
  if (base.length > size) throw new Error(`extendCohortCapped: base(${base.length}) 가 size(${size}) 보다 큽니다`);
  const baseSet = new Set(base);
  const used = new Map<string, number>();
  const take = (hosts: readonly string[]) => {
    for (const h of new Set(hosts)) used.set(h, (used.get(h) ?? 0) + 1);
  };
  for (const id of base) take(hostsOf.get(id) ?? []);

  const need = size - base.length;
  const ordered = selectCohort(candidateIds.filter((id) => !baseSet.has(id)), Number.MAX_SAFE_INTEGER);
  const extra: string[] = [];
  let skippedByCap = 0;
  for (const id of ordered) {
    if (extra.length >= need) break;
    const hosts = [...new Set(hostsOf.get(id) ?? [])];
    if (cap > 0 && hosts.some((h) => (used.get(h) ?? 0) >= cap)) {
      skippedByCap++;
      continue;
    }
    extra.push(id);
    take(hosts);
  }
  return { ids: [...base, ...extra], added: extra.length, shortfall: need - extra.length, skippedByCap };
}

/** 코호트의 호스트 집중도. 대상 하나가 여러 호스트에 원격을 두면 각 호스트에 1씩 센다. */
export function hostConcentration(
  ids: readonly string[],
  hostsOf: ReadonlyMap<string, readonly string[]>,
  topN = 5,
): { uniqueHosts: number; withHosts: number; top: Array<[string, number]>; top1Share: number; top3Share: number } {
  const m = new Map<string, number>();
  let withHosts = 0;
  for (const id of ids) {
    const hosts = [...new Set(hostsOf.get(id) ?? [])];
    if (hosts.length > 0) withHosts++;
    for (const h of hosts) m.set(h, (m.get(h) ?? 0) + 1);
  }
  const sorted = [...m.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  const share = (k: number) => (withHosts === 0 ? 0 : sorted.slice(0, k).reduce((s, [, n]) => s + n, 0) / withHosts);
  return { uniqueHosts: m.size, withHosts, top: sorted.slice(0, topN), top1Share: share(1), top3Share: share(3) };
}

/** 작업 목록의 호스트별 원격 수 상위 n 개 (쏠림 확인용). 파싱 불가 URL 은 'invalid' */
export function topHosts(urls: readonly string[], n = 5): Array<[string, number]> {
  const m = new Map<string, number>();
  for (const u of urls) {
    let h = 'invalid';
    try {
      h = new URL(u).hostname;
    } catch {
      // 그대로 invalid
    }
    m.set(h, (m.get(h) ?? 0) + 1);
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, n);
}

export interface CohortDeps {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  pageSize?: number;
  maxAttempts?: number;
}

/** 저장된 코호트의 target_id 목록. 없으면 빈 배열. 읽기 실패는 throw (조용히 새 코호트를 만들지 않는다). */
export async function fetchCohort(cfg: SupabaseConfig, version: string, deps: CohortDeps = {}): Promise<string[]> {
  const f = deps.fetchImpl ?? fetch;
  const pageSize = deps.pageSize ?? 1000;
  const base = cfg.url.replace(/\/+$/, '');
  const out: string[] = [];
  for (let offset = 0; ; offset += pageSize) {
    const qs = new URLSearchParams({
      select: 'target_id',
      cohort_version: `eq.${version}`,
      order: 'target_id.asc',
      limit: String(pageSize),
      offset: String(offset),
    });
    let res: Response;
    try {
      res = await f(`${base}/rest/v1/scanner_cohort?${qs.toString()}`, {
        headers: supabaseHeaders(cfg.key, { Accept: 'application/json' }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw new Error('cohort read failed: network');
    }
    if (!res.ok) {
      let snippet = '';
      try {
        snippet = (await res.text()).slice(0, 300);
      } catch {
        // 무시
      }
      throw new Error(`cohort read failed: HTTP ${res.status} ${snippet}`.trim());
    }
    const page = (await res.json()) as Array<{ target_id?: unknown }>;
    if (!Array.isArray(page)) throw new Error('cohort read failed: unexpected response shape');
    for (const r of page) if (typeof r.target_id === 'string') out.push(r.target_id);
    if (page.length < pageSize) break;
  }
  return out;
}

/** 코호트를 한 번의 요청(단일 트랜잭션)으로 저장. 부분 저장이 남지 않는다. 이미 있는 행은 무시(멱등). */
export async function saveCohort(cfg: SupabaseConfig, version: string, targetIds: string[], deps: CohortDeps = {}): Promise<void> {
  const f = deps.fetchImpl ?? fetch;
  const sleep = deps.sleep ?? defaultSleep;
  const maxAttempts = deps.maxAttempts ?? 4;
  const selectedAt = new Date().toISOString();
  const body = JSON.stringify(targetIds.map((target_id) => ({ cohort_version: version, target_id, selected_at: selectedAt })));
  const endpoint = `${cfg.url.replace(/\/+$/, '')}/rest/v1/scanner_cohort?on_conflict=cohort_version,target_id`;
  for (let attempt = 1; ; attempt++) {
    let res: Response | null = null;
    try {
      res = await f(endpoint, {
        method: 'POST',
        headers: supabaseHeaders(cfg.key, { 'Content-Type': 'application/json', Prefer: 'resolution=ignore-duplicates,return=minimal' }),
        body,
        signal: AbortSignal.timeout(60_000),
      });
    } catch {
      res = null;
    }
    if (res && res.status >= 200 && res.status < 300) return;
    const retryable = !res || res.status >= 500 || res.status === 429 || res.status === 408;
    if (!retryable || attempt >= maxAttempts) {
      let snippet = '';
      try {
        snippet = res ? (await res.text()).slice(0, 300) : '';
      } catch {
        // 무시
      }
      throw new Error(`cohort save failed: HTTP ${res?.status ?? 'network'} ${snippet}`.trim());
    }
    await sleep(1000 * 2 ** (attempt - 1));
  }
}

export interface CohortJob {
  name: string;
  version: string;
  remote: RegistryRemote;
  index: number;
}

export type CohortGapReason = 'no_remote' | 'remote_not_probeable' | 'not_active' | 'not_in_registry';

/** 코호트 멤버 중 이번 run 에 observation 행이 생기지 않는 이유. scanner_observations 에는 넣지 않는다(분모 보호). */
export interface CohortGap {
  target_id: string;
  reason: CohortGapReason;
  registry_version: string | null;
  registry_status: string | null;
}

/**
 * 코호트 멤버 중 현재 Registry 에서 probe 가능한 remote 만 작업으로 만든다.
 * 작업이 안 생기는 멤버는 gap 으로 사유와 함께 남긴다(실패로 기록하지 않음):
 *   not_in_registry(이름 자체가 응답에 없음) / not_active(active·latest 아님)
 *   / no_remote(active·latest 이나 원격 선언 없음) / remote_not_probeable(원격은 있으나 streamable-http 아니거나 템플릿 URL)
 */
export function planCohortJobs(
  targets: RegistryTarget[],
  cohortIds: string[],
  registryInfo: Map<string, RegistryGapInfo> = new Map(),
): { jobs: CohortJob[]; gaps: CohortGap[] } {
  const byId = new Map(targets.map((t) => [`mcp:${t.name}`, t]));
  const jobs: CohortJob[] = [];
  const gaps: CohortGap[] = [];
  for (const id of cohortIds) {
    const t = byId.get(id);
    if (t) {
      t.remotes.forEach((remote, index) => jobs.push({ name: t.name, version: t.version, remote, index }));
      continue;
    }
    const name = id.startsWith('mcp:') ? id.slice('mcp:'.length) : id;
    const info = registryInfo.get(name);
    if (!info) {
      gaps.push({ target_id: id, reason: 'not_in_registry', registry_version: null, registry_status: null });
    } else if (!(info.status === 'active' && info.isLatest === true)) {
      gaps.push({ target_id: id, reason: 'not_active', registry_version: info.version, registry_status: info.status ?? null });
    } else if (!info.hasAnyRemotes) {
      gaps.push({ target_id: id, reason: 'no_remote', registry_version: info.version, registry_status: info.status ?? null });
    } else {
      gaps.push({ target_id: id, reason: 'remote_not_probeable', registry_version: info.version, registry_status: info.status ?? null });
    }
  }
  return { jobs, gaps };
}

export interface CohortGapRow extends CohortGap {
  scan_run_id: string;
  cohort_version: string;
  observed_at: string;
}

/** scanner_cohort_gaps 에 저장. 하루 수십 행 수준이라 청크 없이 1회 POST. */
export async function insertCohortGaps(rows: CohortGapRow[], cfg: SupabaseConfig, deps: InsertDeps = {}): Promise<number> {
  if (rows.length === 0) return 0;
  const f = deps.fetchImpl ?? fetch;
  const sleep = deps.sleep ?? defaultSleep;
  const maxAttempts = deps.maxAttempts ?? 4;
  const endpoint = `${cfg.url.replace(/\/+$/, '')}/rest/v1/scanner_cohort_gaps`;
  const body = JSON.stringify(rows);
  let ambiguous = false;
  for (let attempt = 1; ; attempt++) {
    let res: Response | null = null;
    try {
      res = await f(endpoint, {
        method: 'POST',
        headers: supabaseHeaders(cfg.key, { 'Content-Type': 'application/json', Prefer: 'return=minimal' }),
        body,
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      res = null;
    }
    if (res && res.status >= 200 && res.status < 300) return rows.length;
    if (res && res.status === 409 && ambiguous) return rows.length; // 재시도 중 이미 커밋된 배치(unique index)
    const retryable = !res || res.status >= 500 || res.status === 429 || res.status === 408;
    if (retryable) ambiguous = true;
    if (!retryable || attempt >= maxAttempts) {
      let snippet = '';
      try {
        snippet = res ? (await res.text()).slice(0, 300) : '';
      } catch {
        // 무시
      }
      throw new Error(`supabase cohort gaps insert failed: HTTP ${res?.status ?? 'network'} ${snippet}`.trim());
    }
    await sleep(1000 * 2 ** (attempt - 1));
  }
}

/** UTC 날짜의 00:00 (ISO). 예비 실행이 "오늘 이미 관찰했는가"를 판단하는 기준. */
export function utcDayStart(now: Date): string {
  return `${now.toISOString().slice(0, 10)}T00:00:00.000Z`;
}

/** since 이후 Scanner 관찰 행 수. Content-Range(예: "0-0/1996", "*\/0")의 총계를 읽는다. 실패는 throw. */
export async function countObservationsSince(cfg: SupabaseConfig, sinceIso: string, deps: { fetchImpl?: typeof fetch } = {}): Promise<number> {
  const f = deps.fetchImpl ?? fetch;
  const qs = new URLSearchParams({ select: 'id', source: 'eq.scanner', observed_at: `gte.${sinceIso}`, limit: '1' });
  let res: Response;
  try {
    res = await f(`${cfg.url.replace(/\/+$/, '')}/rest/v1/scanner_observations?${qs.toString()}`, {
      headers: supabaseHeaders(cfg.key, { Accept: 'application/json', Prefer: 'count=exact' }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new Error('observation count failed: network');
  }
  if (!res.ok) throw new Error(`observation count failed: HTTP ${res.status}`);
  const total = /\/(\d+)\s*$/.exec(res.headers.get('content-range') ?? '')?.[1];
  if (total === undefined) throw new Error('observation count failed: no content-range total');
  return Number.parseInt(total, 10);
}

// ─────────────────────────────────────────────
// Registry 목록을 못 받은 날의 대체: 직전 관찰 실행의 원격 주소로 같은 코호트를 관찰한다.
//   코호트는 고정이고 주소는 거의 바뀌지 않으므로, Registry(또는 그 경로)의 일시 장애가 관찰 결측으로 번지지 않게 한다.
//   이렇게 만든 행에는 metadata.registry_fallback 등을 남겨, 그날 Registry 변화가 반영되지 않았다는 사실을 기록한다.
// ─────────────────────────────────────────────

export interface FallbackJobs {
  jobs: CohortJob[];
  sourceRunId: string;
  sourceObservedAt: string;
  sourceRows: number;
}

/**
 * 가장 최근 Scanner 실행의 행에서 (대상, 원격 주소) 작업 목록을 만든다.
 * 그 실행의 행이 minRows 미만이면(부분 실행) 대체하지 않고 throw — 반쪽 목록으로 관찰하지 않는다.
 */
export async function fetchFallbackJobs(
  cfg: SupabaseConfig,
  opts: { minRows: number; cohortIds?: readonly string[] },
  deps: { fetchImpl?: typeof fetch; pageSize?: number } = {},
): Promise<FallbackJobs> {
  const f = deps.fetchImpl ?? fetch;
  const pageSize = deps.pageSize ?? 1000;
  const base = `${cfg.url.replace(/\/+$/, '')}/rest/v1/scanner_observations`;
  const get = async (qs: URLSearchParams): Promise<Array<Record<string, unknown>>> => {
    let res: Response;
    try {
      res = await f(`${base}?${qs.toString()}`, {
        headers: supabaseHeaders(cfg.key, { Accept: 'application/json' }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw new Error('fallback: read failed (network)');
    }
    if (!res.ok) throw new Error(`fallback: read failed (HTTP ${res.status})`);
    const body: unknown = await res.json();
    if (!Array.isArray(body)) throw new Error('fallback: unexpected response');
    return body as Array<Record<string, unknown>>;
  };

  const latest = await get(new URLSearchParams({ select: 'scan_run_id,observed_at', source: 'eq.scanner', order: 'id.desc', limit: '1' }));
  const runId = typeof latest[0]?.scan_run_id === 'string' ? latest[0].scan_run_id : '';
  if (!runId) throw new Error('fallback: no previous observations');

  const rows: Array<Record<string, unknown>> = [];
  let lastId = 0;
  for (;;) {
    const page = await get(
      new URLSearchParams({
        select: 'id,target_id,transport,observed_at,metadata',
        scan_run_id: `eq.${runId}`,
        id: `gt.${lastId}`,
        order: 'id.asc',
        limit: String(pageSize),
      }),
    );
    rows.push(...page);
    if (page.length < pageSize) break;
    lastId = Number(page[page.length - 1]?.id ?? 0);
    if (!(lastId > 0)) throw new Error('fallback: pagination failed');
  }
  if (rows.length < opts.minRows) {
    throw new Error(`fallback: previous run ${runId} has only ${rows.length} rows (< ${opts.minRows}), not using it`);
  }

  const cohort = opts.cohortIds ? new Set(opts.cohortIds) : null;
  const seen = new Set<string>();
  const jobs: CohortJob[] = [];
  let sourceObservedAt = '';
  for (const r of rows) {
    const targetId = typeof r.target_id === 'string' ? r.target_id : '';
    const meta = (r.metadata ?? {}) as Record<string, unknown>;
    const url = typeof meta.remote_url === 'string' ? meta.remote_url : '';
    if (!targetId.startsWith('mcp:') || !url) continue;
    if (cohort && !cohort.has(targetId)) continue;
    const key = `${targetId} ${url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const at = typeof r.observed_at === 'string' ? r.observed_at : '';
    if (at > sourceObservedAt) sourceObservedAt = at;
    jobs.push({
      name: targetId.slice('mcp:'.length),
      version: typeof meta.registry_version === 'string' ? meta.registry_version : '',
      remote: { type: typeof r.transport === 'string' ? r.transport : 'streamable-http', url },
      index: Number(meta.remote_index ?? 0) || 0,
    });
  }
  if (jobs.length === 0) throw new Error('fallback: previous run has no usable remotes');
  jobs.sort((a, b) => (a.name === b.name ? a.index - b.index : a.name < b.name ? -1 : 1));
  return { jobs, sourceRunId: runId, sourceObservedAt, sourceRows: rows.length };
}

// ─────────────────────────────────────────────
// 직후 재시도: 메인 probe 가 끝난 뒤, 일시적일 수 있는 실패만 호스트당 1건씩 다시 시도한다.
//   첫 시도 컬럼(reached_level/http_status/error_type/latency_ms)은 바꾸지 않고
//   같은 행의 metadata.retry 에만 덧붙인다(supabase/scanner_retry.sql 의 scanner_attach_retry).
// ─────────────────────────────────────────────

/** 일시적일 수 있는 연결 실패. dns/tls/blocked_url/invalid_response 는 지속 성격이라 제외. */
export const RETRYABLE_ERROR_TYPES: ReadonlySet<string> = new Set(['timeout', 'conn_reset', 'conn_refused', 'network_error']);

export function isRetryable(r: Pick<ProbeResult, 'error_type' | 'http_status'>): boolean {
  if (r.error_type) return RETRYABLE_ERROR_TYPES.has(r.error_type);
  const s = r.http_status;
  return s !== null && (s === 408 || s === 429 || s >= 500);
}

export function hostOf(rawUrl: string): string {
  try {
    return new URL(rawUrl).host.toLowerCase();
  } catch {
    return rawUrl;
  }
}

export interface RoundRobinResult<T, R> {
  results: Array<{ item: T; result: R }>;
  /** 시간 예산 안에 시작하지 못한 항목 */
  skipped: T[];
}

/**
 * 호스트당 동시 1건, 호스트 간 최대 concurrency 건. 호스트를 번갈아 골라 한 호스트가 시간을 독차지하지 않게 한다.
 * deadline(ms, now() 기준) 이후에는 새 항목을 시작하지 않는다(이미 시작한 항목은 끝까지 기다린다).
 * fn 은 throw 하지 않아야 한다(호출 측에서 감쌀 것).
 * onResult 는 항목마다 결과 직후 호출된다(중간 저장용). throw 하면 전체가 reject 된다.
 */
export async function runPerHostRoundRobin<T, R>(
  items: readonly T[],
  keyOf: (item: T) => string,
  concurrency: number,
  fn: (item: T) => Promise<R>,
  opts: { deadline?: number; now?: () => number; onResult?: (item: T, result: R) => void | Promise<void> } = {},
): Promise<RoundRobinResult<T, R>> {
  const now = opts.now ?? Date.now;
  const queues = new Map<string, T[]>();
  for (const it of items) {
    const k = keyOf(it);
    const q = queues.get(k);
    if (q) q.push(it);
    else queues.set(k, [it]);
  }
  const hosts = [...queues.keys()];
  const busy = new Set<string>();
  const results: Array<{ item: T; result: R }> = [];
  let cursor = 0;
  let remaining = items.length;
  let waiters: Array<() => void> = [];

  const pick = (): { host: string; item: T } | null => {
    for (let k = 0; k < hosts.length; k++) {
      const i = (cursor + k) % hosts.length;
      const h = hosts[i] as string;
      const q = queues.get(h) as T[];
      if (!busy.has(h) && q.length > 0) {
        cursor = (i + 1) % hosts.length;
        remaining--;
        return { host: h, item: q.shift() as T };
      }
    }
    return null;
  };
  const wakeAll = () => {
    const w = waiters;
    waiters = [];
    for (const f of w) f();
  };

  const worker = async (): Promise<void> => {
    for (;;) {
      if (remaining === 0) return;
      if (opts.deadline !== undefined && now() >= opts.deadline) return;
      const next = pick();
      if (!next) {
        // 남은 항목의 호스트가 모두 처리 중 → 하나가 끝날 때까지 대기
        await new Promise<void>((r) => waiters.push(r));
        continue;
      }
      busy.add(next.host);
      let result: R;
      try {
        result = await fn(next.item);
      } finally {
        busy.delete(next.host);
        wakeAll();
      }
      results.push({ item: next.item, result });
      // 호스트를 놓은 뒤 호출 → 저장이 느려도 같은 호스트의 다음 항목은 다른 worker 가 이어받는다
      if (opts.onResult) await opts.onResult(next.item, result);
    }
  };

  const n = Math.min(Math.max(1, concurrency), Math.max(1, hosts.length));
  await Promise.all(Array.from({ length: n }, worker));
  return { results, skipped: [...queues.values()].flat() };
}

export interface RetryInfo {
  retried_at: string;
  reached_level: 0 | 1 | 2;
  http_status: number | null;
  error_type: string | null;
  latency_ms: number | null;
  per_host_concurrency: 1;
}

export interface RetryKey {
  scan_run_id: string;
  target_id: string;
  remote_url: string;
}

/**
 * 기존 관찰 행의 metadata.retry 에 재시도 결과를 덧붙인다. 이미 retry 가 있으면 바꾸지 않는다(false 반환).
 * 함수가 멱등이라 네트워크·5xx 실패는 재시도해도 안전하다.
 */
export async function attachRetry(cfg: SupabaseConfig, key: RetryKey, retry: RetryInfo, deps: InsertDeps = {}): Promise<boolean> {
  const f = deps.fetchImpl ?? fetch;
  const sleep = deps.sleep ?? defaultSleep;
  const maxAttempts = deps.maxAttempts ?? 3;
  const endpoint = `${cfg.url.replace(/\/+$/, '')}/rest/v1/rpc/scanner_attach_retry`;
  const body = JSON.stringify({ p_run: key.scan_run_id, p_target: key.target_id, p_remote_url: key.remote_url, p_retry: retry });
  for (let attempt = 1; ; attempt++) {
    let res: Response | null = null;
    try {
      res = await f(endpoint, {
        method: 'POST',
        headers: supabaseHeaders(cfg.key, { 'Content-Type': 'application/json', Accept: 'application/json' }),
        body,
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      res = null;
    }
    if (res && res.ok) {
      const v: unknown = await res.json();
      return v === true;
    }
    const retryable = !res || res.status >= 500 || res.status === 429 || res.status === 408;
    if (!retryable || attempt >= maxAttempts) {
      throw new Error(`attach retry failed: HTTP ${res?.status ?? 'network'}`);
    }
    await sleep(1000 * 2 ** (attempt - 1));
  }
}

export const EXPORT_COLUMNS = [
  'id',
  'scan_run_id',
  'node_id',
  'target_id',
  'target_type',
  'observed_at',
  'transport',
  'http_status',
  'reached_level',
  'latency_ms',
  'error_type',
  'source',
  'metadata',
] as const;

export interface MonthRange {
  label: string;
  start: string;
  end: string;
}

/** now 가 속한 달을 포함해 최근 months 개월(UTC). 오래된 달부터. */
export function monthRanges(now: Date, months: number): MonthRange[] {
  const out: MonthRange[] = [];
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  for (let i = months - 1; i >= 0; i--) {
    const start = new Date(Date.UTC(y, m - i, 1));
    const end = new Date(Date.UTC(y, m - i + 1, 1));
    out.push({
      label: `${start.getUTCFullYear()}-${String(start.getUTCMonth() + 1).padStart(2, '0')}`,
      start: start.toISOString(),
      end: end.toISOString(),
    });
  }
  return out;
}

export function csvEscape(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function rowsToCsv(rows: Array<Record<string, unknown>>): string {
  const lines = [EXPORT_COLUMNS.join(',')];
  for (const r of rows) lines.push(EXPORT_COLUMNS.map((c) => csvEscape(r[c])).join(','));
  return `${lines.join('\n')}\n`;
}

export interface FetchRowsDeps {
  fetchImpl?: typeof fetch;
  pageSize?: number;
}

/** 한 달치 scanner_observations 를 id 오름차순 keyset 페이지네이션으로 읽는다. */
export async function fetchMonthRows(cfg: SupabaseConfig, range: MonthRange, deps: FetchRowsDeps = {}): Promise<Array<Record<string, unknown>>> {
  const f = deps.fetchImpl ?? fetch;
  const pageSize = deps.pageSize ?? 1000;
  const base = cfg.url.replace(/\/+$/, '');
  const rows: Array<Record<string, unknown>> = [];
  let lastId = 0;
  for (;;) {
    const qs = new URLSearchParams();
    qs.set('select', EXPORT_COLUMNS.join(','));
    qs.append('observed_at', `gte.${range.start}`);
    qs.append('observed_at', `lt.${range.end}`);
    qs.set('id', `gt.${lastId}`);
    qs.set('order', 'id.asc');
    qs.set('limit', String(pageSize));
    const res = await f(`${base}/rest/v1/scanner_observations?${qs.toString()}`, {
      headers: supabaseHeaders(cfg.key, { Accept: 'application/json' }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`supabase read failed: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`.trim());
    const page = (await res.json()) as Array<Record<string, unknown>>;
    if (!Array.isArray(page)) throw new Error('supabase read: unexpected response shape');
    rows.push(...page);
    if (page.length < pageSize) break;
    const last = page[page.length - 1]?.id;
    if (typeof last !== 'number' || last <= lastId) throw new Error('supabase read: id keyset did not advance');
    lastId = last;
  }
  return rows;
}

// ─────────────────────────────────────────────
// 유틸
// ─────────────────────────────────────────────

export async function runPool<T, R>(items: readonly T[], concurrency: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i] as T, i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), items.length) }, worker));
  return out;
}
