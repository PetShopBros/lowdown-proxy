// 명함(카드) 확인 — 순수 함수와 요청 하나 (scanner/card-discovery.ts 가 쓴다). DB 구조: supabase/2026-11-06_card_discovery.sql
// 카드는 서버·호스트의 자기 선언이다. 여기서는 "무엇을 선언했나"만 뽑고 판정하지 않는다.
// 원문은 원격이 보낸 신뢰할 수 없는 문자열: 지시로 해석하지 않고, 정해진 필드만 형식 검사 뒤 꺼낸다.
//
// 경로 근거 (2026-11-06 확인)
//   MCP Server Card: SEP-2127(Final) + experimental-ext-server-card docs/discovery.md
//     <streamable-http-url>/server-card (권장), /.well-known/ai-catalog.json (도메인 목록, 항목 url 또는 data),
//     /.well-known/mcp/server-card (비권장이지만 쓰임). /.well-known/mcp/server-card.json 은 규격 밖이지만 검사기들이 보는 경로.
//     카드 필드: name, version, description, remotes[]{type: streamable-http|sse, url, supportedProtocolVersions}
//   A2A Agent Card: /.well-known/agent-card.json (v0.3+), 옛 경로 /.well-known/agent.json (v0.2.5)
//     v1.0: supportedInterfaces[]{url, protocolBinding, protocolVersion}, 옛 형식: 최상위 url(+additionalInterfaces)

import { createHash } from 'node:crypto';
import { isPrivateHost, readCapped } from './erc8004-lib.ts';
import { normEndpoint } from './declared-lib.ts';
import { USER_AGENT } from './lib.ts';

export const CARD_MAX_BYTES = 64 * 1024;
/** 종류별 읽기 상한. ai-catalog 는 도메인의 카드 목록이라 큼(2026-11-11: 64KB → 256KB). 나머지는 64KB 그대로 */
export const CARD_MAX_BYTES_BY_KIND: Record<CardKind, number> = {
  mcp_server_card: CARD_MAX_BYTES,
  a2a_agent_card: CARD_MAX_BYTES,
  ai_catalog: 256 * 1024,
};
export const SHARED_HOST_MIN = 5;
export const SLICES = 7;
/** 같은 호스트에서 주소 확인이 이만큼 연속으로 timeout·network 이면 나머지 주소는 이번 주 건너뛴다 */
export const HOST_FAIL_STREAK = 5;
const DAY_MS = 86_400_000;

export type CardKind = 'mcp_server_card' | 'ai_catalog' | 'a2a_agent_card';
export type CardOutcome =
  | 'found'
  | 'not_found'       // 404·410: 카드 없음
  | 'auth_required'   // 401·403: 확인 실패(접근 막힘), 카드 없음과 다르다
  | 'http_error'      // 그 밖의 상태
  | 'timeout'
  | 'network'
  | 'redirect_blocked'// https 가 아니거나 사설 주소로 가는 넘김, 넘김 3번 초과
  | 'too_large'
  | 'html_fallback'   // 2xx 인데 HTML(어떤 경로에든 홈페이지를 돌려주는 사이트)
  | 'invalid_json'
  | 'wrong_shape'     // JSON 이지만 이 종류의 카드 모양이 아님
  | 'skipped_after_timeouts'; // 같은 호스트에서 연속 시간 초과·연결 실패 뒤 이번 주는 요청하지 않음(확인 못 함, 카드 없음 아님)

export interface Fetched {
  url: string;
  outcome: CardOutcome;
  http_status: number | null;
  content_type: string | null;
  bytes: number | null;
  sha256: string | null;
  text: string | null; // found·wrong_shape 판정 전 원문 (저장은 found 만)
}

const ACCEPT: Record<CardKind, string> = {
  mcp_server_card: 'application/mcp-server-card+json, application/json;q=0.9, */*;q=0.1',
  ai_catalog: 'application/ai-catalog+json, application/json;q=0.9, */*;q=0.1',
  a2a_agent_card: 'application/json, */*;q=0.1',
};

// ── 주소 ─────────────────────────────────────────────────

/** https://host[:port] — 정규화된 엔드포인트에서 */
export function originOf(endpoint: string): string | null {
  const m = /^(https?:\/\/[^/?#]+)/i.exec(endpoint);
  return m ? m[1]!.toLowerCase() : null;
}

export function hostOf(origin: string): string {
  return origin.replace(/^https?:\/\//i, '').replace(/:\d+$/, '').toLowerCase();
}

/** 호스트를 요일 7칸에 고르게 나눈다(주소마다 늘 같은 칸) */
export function sliceOf(origin: string): number {
  return createHash('sha256').update(origin).digest().readUInt32BE(0) % SLICES;
}

/** 오늘(UTC) 확인할 칸 */
export function sliceForDay(now: number): number {
  return Math.floor(now / DAY_MS) % SLICES;
}

export const endpointCardUrl = (endpoint: string) => `${endpoint.replace(/\/+$/, '')}/server-card`;

export const HOST_PATHS = {
  ai_catalog: ['/.well-known/ai-catalog.json'],
  a2a_agent_card: ['/.well-known/agent-card.json', '/.well-known/agent.json'],
  mcp_well_known: ['/.well-known/mcp/server-card.json', '/.well-known/mcp/server-card'],
} as const;

// ── 요청 하나 ─────────────────────────────────────────────

const sha = (t: string) => createHash('sha256').update(t).digest('hex');

/** 응답 → 결과 분류 (본문 모양 검사는 종류별 파서가 이어서 한다) */
export function classify(status: number, contentType: string | null, text: string | null): CardOutcome {
  if (status === 404 || status === 410) return 'not_found';
  if (status === 401 || status === 403) return 'auth_required';
  if (status < 200 || status >= 300) return 'http_error';
  if (text === null) return 'too_large';
  const head = text.trimStart().slice(0, 64).toLowerCase();
  if (/text\/html/i.test(contentType ?? '') || head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<')) return 'html_fallback';
  try {
    const v = JSON.parse(text);
    if (!v || typeof v !== 'object') return 'wrong_shape';
  } catch {
    return 'invalid_json';
  }
  return 'found';
}

export async function fetchCard(url: string, kind: CardKind, timeoutMs: number, fetchImpl: typeof fetch = fetch): Promise<Fetched> {
  const base = { url, http_status: null, content_type: null, bytes: null, sha256: null, text: null };
  let cur = url;
  for (let hop = 0; hop <= 3; hop++) {
    let u: URL;
    try {
      u = new URL(cur);
    } catch {
      return { ...base, outcome: 'redirect_blocked' };
    }
    if (u.protocol !== 'https:' || isPrivateHost(u.hostname.toLowerCase())) return { ...base, outcome: 'redirect_blocked' };
    let res: Response;
    try {
      res = await fetchImpl(cur, {
        redirect: 'manual',
        headers: { accept: ACCEPT[kind], 'user-agent': `${USER_AGENT} cards (+https://github.com/PetShopBros/lowdown-proxy)` },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      return { ...base, outcome: e instanceof Error && /timeout|abort/i.test(e.name + e.message) ? 'timeout' : 'network' };
    }
    const loc = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && loc) {
      try {
        cur = new URL(loc, cur).toString();
      } catch {
        return { ...base, outcome: 'redirect_blocked', http_status: res.status };
      }
      try { await res.body?.cancel(); } catch { /* 무시 */ }
      continue;
    }
    const ct = res.headers.get('content-type')?.slice(0, 120) ?? null;
    let text: string | null = null;
    if (res.status >= 200 && res.status < 300) {
      try {
        text = await readCapped(res, CARD_MAX_BYTES_BY_KIND[kind]);
      } catch {
        return { ...base, outcome: 'network', http_status: res.status, content_type: ct };
      }
    } else {
      try { await res.body?.cancel(); } catch { /* 무시 */ }
    }
    const outcome = classify(res.status, ct, res.status >= 200 && res.status < 300 ? text : '');
    const bytes = text === null ? (outcome === 'too_large' ? CARD_MAX_BYTES_BY_KIND[kind] + 1 : null) : Buffer.byteLength(text, 'utf8');
    return { url, outcome, http_status: res.status, content_type: ct, bytes, sha256: text === null ? null : sha(text), text: outcome === 'found' ? text : null };
  }
  return { ...base, outcome: 'redirect_blocked' };
}

// ── 종류별 파서 (모양이 아니면 null → wrong_shape) ─────────────

const str = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
const NAME_RE = /^[a-zA-Z0-9.-]+\/[a-zA-Z0-9._-]+$/;

export interface McpCardFacts {
  claimed_name: string | null;
  name_format_ok: boolean;
  version: string | null;
  endpoints: Array<{ url: string; type: string | null; versions: string[] }>;
}

export function parseServerCard(v: unknown): McpCardFacts | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const name = str(o.name, 200);
  const remotes = Array.isArray(o.remotes) ? o.remotes : [];
  if (!name && remotes.length === 0) return null;
  const endpoints: McpCardFacts['endpoints'] = [];
  for (const r of remotes.slice(0, 20)) {
    if (!r || typeof r !== 'object') continue;
    const x = r as Record<string, unknown>;
    const url = str(x.url, 2000);
    if (!url) continue;
    const versions = Array.isArray(x.supportedProtocolVersions)
      ? x.supportedProtocolVersions.filter((s): s is string => typeof s === 'string' && /^[0-9A-Za-z.-]{1,20}$/.test(s)).slice(0, 10)
      : [];
    endpoints.push({ url, type: str(x.type, 40), versions });
  }
  return { claimed_name: name, name_format_ok: !!name && NAME_RE.test(name), version: str(o.version, 80), endpoints };
}

export interface A2aCardFacts {
  claimed_name: string | null;
  protocol_version: string | null;
  interfaces: Array<{ url: string; binding: string | null }>;
}

export function parseA2aCard(v: unknown): A2aCardFacts | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const name = str(o.name, 200);
  const interfaces: A2aCardFacts['interfaces'] = [];
  const add = (url: unknown, binding: unknown) => {
    const u = str(url, 2000);
    if (u && interfaces.length < 10 && !interfaces.some((i) => i.url === u)) interfaces.push({ url: u, binding: str(binding, 40) });
  };
  for (const key of ['supportedInterfaces', 'additionalInterfaces']) {
    const arr = o[key];
    if (Array.isArray(arr)) for (const it of arr) if (it && typeof it === 'object') add((it as any).url, (it as any).protocolBinding ?? (it as any).transport);
  }
  add(o.url, o.preferredTransport); // v1.0 이전 형식
  if (!name && interfaces.length === 0) return null;
  const pv = str(o.protocolVersion, 20) ?? (Array.isArray(o.supportedInterfaces) ? str((o.supportedInterfaces[0] as any)?.protocolVersion, 20) : null);
  return { claimed_name: name, protocol_version: pv, interfaces };
}

export interface CatalogFacts {
  entries: number;
  entry_types: Record<string, number>;
  mcp_card_urls: string[];       // 항목이 가리키는 MCP Server Card 주소 (https 만)
  mcp_card_inline: McpCardFacts[]; // 항목 안에 들어 있는 카드
}

/** AI Catalog: 항목 배열을 흔한 자리에서 찾는다(최상위 배열, entries, items, catalog). 형식이 확정되지 않아 넓게 읽고 형식 검사만 한다. */
export function parseAiCatalog(v: unknown): CatalogFacts | null {
  let arr: unknown[] | null = null;
  if (Array.isArray(v)) arr = v;
  else if (v && typeof v === 'object') {
    for (const k of ['entries', 'items', 'catalog', 'artifacts']) {
      const x = (v as Record<string, unknown>)[k];
      if (Array.isArray(x)) {
        arr = x;
        break;
      }
    }
  }
  if (!arr) return null;
  const facts: CatalogFacts = { entries: 0, entry_types: {}, mcp_card_urls: [], mcp_card_inline: [] };
  for (const e of arr.slice(0, 200)) {
    if (!e || typeof e !== 'object' || Array.isArray(e)) continue;
    const o = e as Record<string, unknown>;
    facts.entries++;
    const type = str(o.type, 80) ?? 'unknown';
    if (Object.keys(facts.entry_types).length < 20 || facts.entry_types[type]) facts.entry_types[type] = (facts.entry_types[type] ?? 0) + 1;
    if (type === 'application/mcp-server-card+json') {
      const u = str(o.url, 2000);
      if (u && /^https:\/\//i.test(u) && facts.mcp_card_urls.length < 5) facts.mcp_card_urls.push(u);
      const inline = o.data !== undefined ? parseServerCard(o.data) : null;
      if (inline && facts.mcp_card_inline.length < 5) facts.mcp_card_inline.push(inline);
    }
  }
  return facts.entries > 0 ? facts : null;
}

// ── 결과 모양 (공개 표에 들어가는 사실만, 원문 없음) ───────────

export interface CheckResult {
  kind: CardKind;
  url: string;
  outcome: CardOutcome;
  http_status: number | null;
  content_type: string | null;
  bytes: number | null;
  sha256: string | null;
  tried?: Array<{ url: string; outcome: CardOutcome; http_status: number | null }>;
  first_found_at?: string | null;
  last_changed_at?: string | null;
  [k: string]: unknown;
}

export function baseResult(kind: CardKind, f: Fetched): CheckResult {
  return { kind, url: f.url, outcome: f.outcome, http_status: f.http_status, content_type: f.content_type, bytes: f.bytes, sha256: f.outcome === 'found' ? f.sha256 : null };
}

/** 정규화된 주소 목록 (비교·저장용) */
export function normList(urls: string[]): string[] {
  return [...new Set(urls.map((u) => normEndpoint(u)).filter((u): u is string => u !== null))].slice(0, 10);
}

/** 이전 결과 대비 바뀌었나 (결과 종류 또는 내용 해시) */
export function changed(prev: { outcome?: unknown; sha256?: unknown } | null | undefined, cur: CheckResult): boolean {
  if (!prev) return true;
  return prev.outcome !== cur.outcome || (prev.sha256 ?? null) !== (cur.sha256 ?? null);
}

/** 처음 찾은 시각·마지막 변경 시각을 이어 붙인다 */
export function carryDates(prev: Record<string, any> | null | undefined, cur: CheckResult, nowIso: string): CheckResult {
  const isChange = changed(prev, cur);
  const firstFound = cur.outcome === 'found' ? (prev?.outcome === 'found' && prev?.first_found_at ? prev.first_found_at : (prev?.first_found_at ?? nowIso)) : (prev?.first_found_at ?? null);
  return { ...cur, first_found_at: firstFound, last_changed_at: isChange && prev ? nowIso : (prev?.last_changed_at ?? null) };
}
