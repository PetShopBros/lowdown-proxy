// 조회된 대상 관찰(requested) — 순수 계산 + DB 읽기/쓰기
//   누군가 조회한 Registry 서버를 다음 스캔부터 매일 함께 관찰한다.
//   고정 코호트와 섞지 않는다. 목록은 scanner_requested, 관찰 행은 source = 'scanner_requested'.
//   상한: 하루 새로 들어오는 수(dailyCap), 전체 크기(totalCap). 상한을 넘는 대상은 다음 날로 미룬다(버리지 않음).
//   우선순위: 크롤러가 아닌 조회(분류 없음·AI 사용자 요청)가 많은 순 → 전체 조회 많은 순 → 이름순.
//   실사용 자리(2026-11-01): AI 사용자(bot_kind = 'ai_user', 예: Claude-User·ChatGPT 원격 MCP) 조회가 있는 대상은
//     전체 상한과 별도로 받는다(하루 userDailyCap, 전체 userRemaining). 10/28 전체 상한 3,000이 크롤러 조회로 차서
//     실사용 조회 대상도 들어가지 못했기 때문. 분류 없음(null)은 넣지 않는다 — 브라우저 UA를 돌려쓰는 수집기가 대부분.
//   일반 자리 닫음(2026-11-22): 3,001개 중 2,999개가 크롤러가 처음 고른 대상이었다(11/11 실측).
//     scan.ts 는 일반 자리를 0으로 두고 AI 사용자 자리만 쓴다(fetchRecentLookups aiUserOnly).
//     바깥 고리(3일마다) 이후 점검 가능한 서버는 모두 이미 관찰되므로 result_kind = observed 조회도 후보로 받는다
//     → AI 사용자가 읽은 바깥 고리 서버를 매일 관찰로 올린다. 고정 코호트·이미 있는 대상은 제외.
//     크롤러가 고른 기존 행은 지우지 않고 retired_at 으로 은퇴(supabase/2026-11-22_requested_retire.sql).
//     은퇴한 대상은 목록에서 빠지고 바깥 고리(또는 고정 코호트)로 돌아간다. AI 사용자가 다시 읽으면 reactivated_at.

import { supabaseHeaders, type SupabaseConfig } from './lib.ts';

export const REQUESTED_SOURCE = 'scanner_requested';
export const REQUESTED_VERSION = 'requested';
export const DEFAULT_REQUESTED_DAILY_CAP = 1000;
export const DEFAULT_REQUESTED_TOTAL_CAP = 3000;
export const DEFAULT_REQUESTED_USER_DAILY_CAP = 100;
export const DEFAULT_REQUESTED_USER_TOTAL_CAP = 1000;
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
  /** 이미 매일 관찰 중인 target_id (고정 코호트 + 활성 requested) */
  exclude: ReadonlySet<string>;
  dailyCap: number;
  /** 일반 자리의 남은 수 */
  remaining: number;
  /** 실사용 자리: AI 사용자 조회가 있는 대상을 일반 상한과 별도로 받는 하루 수 (없으면 0) */
  userDailyCap?: number;
  /** 실사용 자리의 남은 전체 수 (없으면 userDailyCap 과 같음) */
  userRemaining?: number;
}

export function pickRequested(lookups: readonly LookupRef[], o: PickOptions): { picks: RequestedPick[]; eligible: number; deferred: number; userPicks: number } {
  const stats = new Map<string, { human: number; ai: number; total: number; firstKind: string | null; firstAt: string }>();
  for (const l of lookups) {
    const name = registryNameOf(l.target);
    if (!name || !o.probeable.has(name)) continue;
    const id = `mcp:${name}`;
    if (o.exclude.has(id)) continue;
    const s = stats.get(id) ?? { human: 0, ai: 0, total: 0, firstKind: l.bot_kind ?? null, firstAt: l.created_at };
    s.total++;
    if (l.bot_kind !== 'crawler') s.human++;
    if (l.bot_kind === 'ai_user') s.ai++;
    if (l.created_at < s.firstAt) {
      s.firstAt = l.created_at;
      s.firstKind = l.bot_kind ?? null;
    }
    stats.set(id, s);
  }
  const ordered = [...stats.entries()].sort((a, b) => b[1].human - a[1].human || b[1].total - a[1].total || (a[0] < b[0] ? -1 : 1));
  const room = Math.max(0, Math.min(o.dailyCap, o.remaining));
  const chosen = ordered.slice(0, room);
  // 실사용 자리: 일반 자리에 못 든 대상 중 AI 사용자 조회가 있는 것 (AI 사용자 조회 많은 순, 같으면 위 정렬)
  const userDaily = Math.max(0, o.userDailyCap ?? 0);
  const userRoom = Math.max(0, Math.min(userDaily, o.userRemaining ?? userDaily));
  const userChosen = ordered.slice(room).filter(([, s]) => s.ai > 0).sort((a, b) => b[1].ai - a[1].ai).slice(0, userRoom);
  const picks = [...chosen, ...userChosen].map(([target_id, s]) => ({ target_id, first_bot_kind: s.firstKind, first_lookups: s.total }));
  return { picks, eligible: ordered.length, deferred: ordered.length - picks.length, userPicks: userChosen.length };
}

export interface RequestedDeps {
  fetchImpl?: typeof fetch;
  pageSize?: number;
  maxPages?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface LookupQuery {
  /** true: AI 사용자 조회만, result_kind registry_only·observed 둘 다 (2026-11-22). false/없음: 예전처럼 registry_only 전부 */
  aiUserOnly?: boolean;
}

const base = (cfg: SupabaseConfig) => cfg.url.replace(/\/+$/, '');

/** 최근 조회. 기본은 "Registry 에는 있는데 관찰 기록이 없다"고 답한 조회. aiUserOnly 면 AI 사용자 조회만(관찰 중 포함).
 *  AI 사용자 조건은 DB 에서 거른다 — observed 까지 넓히면 크롤러 페이지 조회가 많아 읽기 상한에 잘리기 때문.
 *  오류 문구에 응답 본문을 넣지 않는다. */
export async function fetchRecentLookups(cfg: SupabaseConfig, sinceIso: string, deps: RequestedDeps = {}, q: LookupQuery = {}): Promise<LookupRef[]> {
  const f = deps.fetchImpl ?? fetch;
  const pageSize = deps.pageSize ?? 1000;
  const maxPages = deps.maxPages ?? 30;
  const out: LookupRef[] = [];
  for (let page = 0; page < maxPages; page++) {
    const qs = new URLSearchParams({ select: 'target,bot_kind,created_at', result_kind: q.aiUserOnly ? 'in.(registry_only,observed)' : 'eq.registry_only', order: 'created_at.asc,id.asc', limit: String(pageSize), offset: String(page * pageSize) });
    qs.set('created_at', `gte.${sinceIso}`);
    if (q.aiUserOnly) qs.set('bot_kind', 'eq.ai_user');
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

/** 활성 requested target_id 전부 (은퇴한 행 제외, 페이지 읽기). 읽기 실패는 throw. */
export async function fetchRequestedIds(cfg: SupabaseConfig, deps: RequestedDeps = {}): Promise<string[]> {
  const f = deps.fetchImpl ?? fetch;
  const pageSize = deps.pageSize ?? 1000;
  const out: string[] = [];
  for (let offset = 0; ; offset += pageSize) {
    const qs = new URLSearchParams({ select: 'target_id', retired_at: 'is.null', order: 'target_id.asc', limit: String(pageSize), offset: String(offset) });
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

/** 새 대상 저장. 이미 있는 행(은퇴한 행 포함)은 건드리지 않는다(멱등). 은퇴한 행은 reactivateRequested 로. */
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

const TARGET_ID_RE = /^mcp:[A-Za-z0-9._~\/-]{1,300}$/;
const REACTIVATE_CHUNK = 50;

/** 은퇴한 행 중 이번에 다시 고른 대상만 되살린다(retired_at = null, reactivated_at = 지금).
 *  은퇴하지 않은 행은 retired_at=not.is.null 조건 때문에 바뀌지 않는다. first_* 열과 retired_reason 은 그대로 둔다.
 *  형식이 아닌 id 는 보내지 않는다. 바뀐 행 수를 돌려준다. */
export async function reactivateRequested(cfg: SupabaseConfig, targetIds: readonly string[], deps: RequestedDeps = {}): Promise<number> {
  const ids = [...new Set(targetIds)].filter((id) => TARGET_ID_RE.test(id)).sort();
  if (ids.length === 0) return 0;
  const f = deps.fetchImpl ?? fetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const body = JSON.stringify({ retired_at: null, reactivated_at: new Date().toISOString() });
  let changed = 0;
  for (let i = 0; i < ids.length; i += REACTIVATE_CHUNK) {
    const chunk = ids.slice(i, i + REACTIVATE_CHUNK);
    const qs = new URLSearchParams({ target_id: `in.(${chunk.map((id) => `"${id}"`).join(',')})`, retired_at: 'not.is.null', select: 'target_id' });
    const endpoint = `${base(cfg)}/rest/v1/scanner_requested?${qs.toString()}`;
    for (let attempt = 1; ; attempt++) {
      let res: Response | null = null;
      try {
        res = await f(endpoint, { method: 'PATCH', headers: supabaseHeaders(cfg.key, { 'Content-Type': 'application/json', Accept: 'application/json', Prefer: 'return=representation' }), body, signal: AbortSignal.timeout(60_000) });
      } catch {
        res = null;
      }
      if (res && res.status >= 200 && res.status < 300) {
        const rows = (await res.json().catch(() => [])) as unknown;
        changed += Array.isArray(rows) ? rows.length : 0;
        break;
      }
      const retryable = !res || res.status >= 500 || res.status === 429 || res.status === 408;
      if (!retryable || attempt >= 4) throw new Error(`requested reactivate failed: HTTP ${res?.status ?? 'network'}`);
      await sleep(1000 * 2 ** (attempt - 1));
    }
  }
  return changed;
}
