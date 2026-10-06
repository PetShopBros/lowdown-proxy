// Lowdown MCP Scanner — 핵심 로직 (의존성 0, Node >= 22.18)
// 원칙: 관찰한 사실만 기록한다. tools/call 은 하지 않는다. tool 이름/설명문은 저장하지 않는다.

import { createHash } from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns';
import type { LookupAddress } from 'node:dns';
import type { IncomingHttpHeaders } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP } from 'node:net';
import type { LookupFunction } from 'node:net';

export const SCANNER_VERSION = '0.1.0';
export const MCP_PROTOCOL_VERSION = '2025-06-18';
export const USER_AGENT = `lowdown-scanner/${SCANNER_VERSION}`;
export const DEFAULT_REGISTRY_URL = 'https://registry.modelcontextprotocol.io';

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
  const out = (p: Omit<ProbeResult, 'transport' | 'metadata'>): ProbeResult => ({
    transport: remote.type,
    metadata,
    ...p,
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
  const ir = initResult as { protocolVersion?: unknown; serverInfo?: unknown };
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
  maxPages?: number;
}

export async function fetchRegistryTargets(
  deps: RegistryDeps = {},
): Promise<{ targets: RegistryTarget[]; stats: RegistryStats }> {
  const base = (deps.baseUrl ?? DEFAULT_REGISTRY_URL).replace(/\/+$/, '');
  const f = deps.fetchImpl ?? fetch;
  const sleep = deps.sleep ?? defaultSleep;
  const pageSize = deps.pageSize ?? 100;
  const maxPages = deps.maxPages ?? 500;

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
  const seenKeys = new Set<string>();
  let cursor: string | undefined;

  for (;;) {
    if (stats.pages >= maxPages) throw new Error(`registry: exceeded maxPages=${maxPages}`);
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
      if (!retryable || attempt >= 3) throw new Error(`registry: page ${stats.pages + 1} failed (HTTP ${status || 'network'})`);
      await sleep(1000 * 2 ** (attempt - 1));
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
      if (!(meta?.status === 'active' && meta?.isLatest === true)) continue;
      stats.active_latest++;

      const remotes: RegistryRemote[] = [];
      const seenUrls = new Set<string>();
      for (const r of Array.isArray(s.remotes) ? (s.remotes as unknown[]) : []) {
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
      if (remotes.length === 0) continue;
      if (byName.has(s.name)) {
        stats.duplicate_names++;
        continue;
      }
      byName.set(s.name, { name: s.name, version: String(s.version ?? ''), remotes });
      stats.targets_with_probeable_remote++;
      stats.remotes_probeable += remotes.length;
    }

    const next = page.metadata?.nextCursor;
    if (typeof next !== 'string' || next.length === 0) break;
    if (newKeys === 0 || next === cursor) throw new Error('registry: pagination did not advance (cursor ignored?)');
    cursor = next;
  }

  return { targets: [...byName.values()], stats };
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
