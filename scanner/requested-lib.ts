// 조회된 대상 관찰 (requested) — 순수 계산 + DB 읽기/쓰기
//   누군가 조회했지만 아직 관찰된 적 없는 Registry 서버(result_kind = registry_only)를 다음 스캔에서 함께 관찰한다.
//   고정 코호트와 섞지 않는다: 목록은 scanner_requested, 관찰 행은 source = 'scanner_requested'.
//   한도: 하루에 새로 들어오는 수(dailyCap), 전체 크기(totalCap). 한도를 넘는 대상은 다음 날로 미룬다(버리지 않음).
//   우선순위: 크롤러가 아닌 조회(분류 없음·AI 사용자 요청)가 많은 순 → 전체 조회 많은 순 → 이름순.

import { supabaseHeaders, type SupabaseConfig } from './lib.ts';

export const REQUESTED_SOURCE = 'scanner_requested';
export const REQUESTED_VERSION = 'requested';
export const DEFAULT_REQUESTED_DAILY_CAP = 1000;
export const DEFAULT_REQUESTED_TOTAL_CAP = 3000;
export const LOOKUP_WINDOW_DAYS = 2;

export interface LookupRef {
  target: string;
  bot_kind: string | null;
  created_at: string;
}

export interface RequestedPick {
  target_id: string;
  first_bot_kind: string | null;
  first_lookups: number;
}

/** 조회 문자열 → Registry 이름. 'mcp:' 접두만 허용, 패키지 표기(npm:/pypi:)·빈 값은 null. */
export function registryNameOf(target: unknown): string | null {
  if (typeof target !== 'string') return null;
  let t = target.trim();
  if (t.startsWith('mcp:')) t = t.slice(4);
  if (!t || t.length > 300 || /^(npm|pypi):/i.test(t)) return null;
  return t;
}

export interface PickOptions {
  /** 지금 Registry 에서 probe 가능한 이름 */
  probeable: ReadonlySet<string>;
  /** 이미 관찰 중인 target_id (고정 코호트 + 기존 requested) */
  exclude: ReadonlySet<string>;
  dailyCap: number;
  /** 이미 있는 requested 수를 뺀 남은 자리 */
  remaining: number;
}

export function pickRequested(lookups: readonly LookupRef[], o: PickOptions): { picks: RequestedPick[]; eligible: number; deferred: number } {
  const stats = new Map<string, { human: number; total: number; firstKind: string | null; firstAt: string }>();
  for (const l of lookups) {
    const name = registryNameOf(l.target);
    if (!name || !o.probeable.has(name)) continue;
    const id = `mcp:${name}`;
    if (o.exclude.has(id)) continue;
    const s = stats.get(id) ?? { human: 0, total: 0, firstKind: l.bot_kind ?? null, firstAt: l.created_at };
    s.total++;
    if (l.bot_kind !== 'crawler') s.human++;
    if (l.created_at < s.firstAt) {
      s.firstAt = l.created_at;
      s.firstKind = l.bot_kind ?? null;
    }
    stats.set(id, s);
  }
  const ordered = [...stats.entries()].sort((a, b) => b[1].human - a[1].human || b[1].total - a[1].total || (a[0] < b[0] ? -1 : 1));
  const room = Math.max(0, Math.min(o.dailyCap, o.remaining));
  const picks = ordered.slice(0, room).map(([target_id, s]) => ({ target_id, first_bot_kind: s.firstKind, first_lookups: s.total }));
  return { picks, eligible: ordered.length, deferred: ordered.length - picks.length };
}

export interface RequestedDeps {
  fetchImpl?: typeof fetch;
  pageSize?: number;
  maxPages?: number;
  sleep?: (ms: number) => Promise<void>;
}

const base = (cfg: SupabaseConfig) => cfg.url.replace(/\/+$/, '');

/** 최근 days 일 동안 "Registry 에는 있는데 관찰 기록이 없다"고 답한 조회. 오류 문구에 응답 본문을 넣지 않는다. */
export async function fetchRecentLookups(cfg: SupabaseConfig, sinceIso: string, deps: RequestedDeps = {}): Promise<LookupRef[]> {
  const f = deps.fetchImpl ?? fetch;
  const pageSize = deps.pageSize ?? 1000;
  const maxPages = deps.maxPages ?? 30;
  const out: LookupRef[] = [];
  for (let page = 0; page < maxPages; page++) {
    const qs = new URLSearchParams({ select: 'target,bot_kind,created_at', result_kind: 'eq.registry_only', order: 'created_at.asc,id.asc', limit: String(pageSize), offset: String(page * pageSize) });
    qs.set('created_at', `gte.${sinceIso}`);
    let res: Response;
    try {
      res = await f(`${base(cfg)}/rest/v1/reputation_lookups?${qs.toString()}`, { headers: supabaseHeaders(cfg.key, { Accept: 'application/json' }), signal: AbortSignal.timeout(30_000) });
    } catch {
      throw new Error('lookups read failed: network');
    }
    if (!res.ok) throw new Error(`lookups read failed: HTTP ${res.status}`);
    const rows = (await res.json()) as unknown;
    if (!Array.isArray(rows)) throw new Error('lookups read failed: unexpected response');
    for (const r of rows as Array<Record<string, unknown>>) {
      if (typeof r.target === 'string' && typeof r.created_at === 'string') out.push({ target: r.target, bot_kind: typeof r.bot_kind === 'string' ? r.bot_kind : null, created_at: r.created_at });
    }
    if (rows.length < pageSize) break;
  }
  return out;
}

/** 이미 requested 로 들어온 target_id 전부 (페이지 읽기). 읽기 실패는 throw. */
export async function fetchRequestedIds(cfg: SupabaseConfig, deps: RequestedDeps = {}): Promise<string[]> {
  const f = deps.fetchImpl ?? fetch;
  const pageSize = deps.pageSize ?? 1000;
  const out: string[] = [];
  for (let offset = 0; ; offset += pageSize) {
    const qs = new URLSearchParams({ select: 'target_id', order: 'target_id.asc', limit: String(pageSize), offset: String(offset) });
    let res: Response;
    try {
      res = await f(`${base(cfg)}/rest/v1/scanner_requested?${qs.toString()}`, { headers: supabaseHeaders(cfg.key, { Accept: 'application/json' }), signal: AbortSignal.timeout(30_000) });
    } catch {
      throw new Error('requested read failed: network');
    }
    if (!res.ok) throw new Error(`requested read failed: HTTP ${res.status}`);
    const rows = (await res.json()) as Array<{ target_id?: unknown }>;
    if (!Array.isArray(rows)) throw new Error('requested read failed: unexpected response');
    for (const r of rows) if (typeof r.target_id === 'string') out.push(r.target_id);
    if (rows.length < pageSize) break;
  }
  return out;
}

/** 새 대상 저장. 이미 있는 행은 무시(멱등). */
export async function saveRequested(cfg: SupabaseConfig, picks: readonly RequestedPick[], deps: RequestedDeps = {}): Promise<number> {
  if (picks.length === 0) return 0;
  const f = deps.fetchImpl ?? fetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = new Date().toISOString();
  const body = JSON.stringify(picks.map((p) => ({ ...p, first_requested_at: now })));
  const endpoint = `${base(cfg)}/rest/v1/scanner_requested?on_conflict=target_id`;
  for (let attempt = 1; ; attempt++) {
    let res: Response | null = null;
    try {
      res = await f(endpoint, { method: 'POST', headers: supabaseHeaders(cfg.key, { 'Content-Type': 'application/json', Prefer: 'resolution=ignore-duplicates,return=minimal' }), body, signal: AbortSignal.timeout(60_000) });
    } catch {
      res = null;
    }
    if (res && res.status >= 200 && res.status < 300) return picks.length;
    const retryable = !res || res.status >= 500 || res.status === 429 || res.status === 408;
    if (!retryable || attempt >= 4) throw new Error(`requested save failed: HTTP ${res?.status ?? 'network'}`);
    await sleep(1000 * 2 ** (attempt - 1));
  }
}
