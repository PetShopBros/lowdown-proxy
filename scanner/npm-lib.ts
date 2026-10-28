// npm 패키지 일별 상태 — 순수 함수와 DB/npm 입출력
//   대상: MCP Registry 가 선언한 npm 패키지. 공개 API(registry.npmjs.org)의 요약 메타데이터만 읽고 코드는 실행하지 않는다.
//   npm 이용 조건: 공개 API 로 복제 허용, 월 500만 요청 이하가 합리적 사용(docs.npmjs.com/policies/open-source-terms).
//   우리는 이름을 밝히는 UA 로, 동시 요청·총 요청 상한을 두고 하루 1회만 읽는다.
//   저장은 버전·시각·여부만. 설명·README·deprecated 문구 같은 외부 문자열은 저장하지 않는다.

import { supabaseHeaders, USER_AGENT, type SupabaseConfig } from './lib.ts';
import { postBatches, type DiffIoDeps } from './registry-diff.ts';

export const NPM_REGISTRY = 'https://registry.npmjs.org';
export const NPM_USER_AGENT = `${USER_AGENT} (+https://github.com/PetShopBros/lowdown-proxy)`;
export const ABBREVIATED_ACCEPT = 'application/vnd.npm.install-v1+json';

// npm 이름: 214자 이하, 선택적 @scope/, URL 에 안전한 문자. 옛 패키지에 대문자가 있어 대소문자는 허용하고 바꾸지 않는다.
const NPM_NAME = /^(?:@[A-Za-z0-9~-][A-Za-z0-9._~-]*\/)?[A-Za-z0-9~-][A-Za-z0-9._~-]*$/;
const SAFE_VERSION = /^[0-9A-Za-z.+_-]{1,64}$/;

export function isNpmName(s: string): boolean {
  return s.length > 0 && s.length <= 214 && NPM_NAME.test(s);
}

/** registry_state.packages_key 들 → 고유 npm 패키지 이름(정렬). 형식이 아닌 값은 개수만. */
export function npmIdentsFromPackagesKeys(keys: readonly string[]): { idents: string[]; invalid: number } {
  const set = new Set<string>();
  let invalid = 0;
  for (const key of keys) {
    for (const line of key.split('\n')) {
      const [type, ident] = line.trim().split(' ');
      if (type !== 'npm') continue;
      if (ident && isNpmName(ident)) set.add(ident);
      else invalid++;
    }
  }
  return { idents: [...set].sort(), invalid };
}

/** 요청 주소: 범위 패키지의 / 만 %2F 로 */
export function npmUrl(ident: string, base = NPM_REGISTRY): string {
  return `${base.replace(/\/+$/, '')}/${ident.replace('/', '%2F')}`;
}

export interface NpmFacts {
  latest: string | null;
  modified: string | null;
  deprecated: boolean | null;
}

/** 요약 메타데이터 → 사실 세 가지. 형식이 아니면 null. deprecated 문구는 버린다. */
export function parseAbbreviated(doc: unknown): NpmFacts {
  const d = (doc && typeof doc === 'object' ? doc : {}) as Record<string, unknown>;
  const tags = (d['dist-tags'] && typeof d['dist-tags'] === 'object' ? d['dist-tags'] : {}) as Record<string, unknown>;
  const latest = typeof tags.latest === 'string' && SAFE_VERSION.test(tags.latest) ? tags.latest : null;
  let modified: string | null = null;
  if (typeof d.modified === 'string') {
    const t = Date.parse(d.modified);
    if (Number.isFinite(t)) modified = new Date(t).toISOString();
  }
  let deprecated: boolean | null = null;
  const versions = d.versions && typeof d.versions === 'object' ? (d.versions as Record<string, unknown>) : null;
  if (latest && versions && versions[latest] && typeof versions[latest] === 'object') {
    const dep = (versions[latest] as Record<string, unknown>).deprecated;
    deprecated = typeof dep === 'string' ? dep.length > 0 : dep === true;
  }
  return { latest, modified, deprecated };
}

export type NpmObservation =
  | { ident: string; kind: 'found'; facts: NpmFacts }
  | { ident: string; kind: 'not_found' }
  | { ident: string; kind: 'error'; error: string };

export interface NpmStateRow {
  ident: string;
  status: 'found' | 'not_found';
  latest: string | null;
  modified: string | null;
  deprecated: boolean | null;
  baseline: boolean;
  first_checked_at: string;
  checked_at: string;
  changed_at: string | null;
  last_error: string | null;
  last_error_at: string | null;
  scan_run_id: string | null;
}

export type NpmChangeKind = 'latest_changed' | 'deprecated' | 'undeprecated' | 'not_found' | 'restored';

export interface NpmChangeRow {
  detected_on: string;
  ident: string;
  kind: NpmChangeKind;
  old_value: string | null;
  new_value: string | null;
  scan_run_id: string;
  /** latest_changed 에만: 전날까지 기록된 패키지 문서 수정 시각(직전 발행 시각보다 같거나 늦다). 그 외 이벤트는 null.
   *  일괄 쓰기(PostgREST)는 모든 행의 키가 같아야 하므로 diffPackage 는 항상 이 키를 넣는다. */
  prev_modified?: string | null;
}

export interface NpmRunCtx {
  now: string;
  scanRunId: string;
}

/**
 * 직전 상태 + 오늘 관찰 → 새 상태 행(전체 열) + 이벤트.
 *  - 직전 상태가 없으면 기준선: 이벤트 없음. 오류면 행도 만들지 않는다.
 *  - 오류: 상태는 그대로, last_error 만 갱신.
 *  - 404: 직전이 found 였을 때만 not_found 이벤트. not_found → found 는 restored.
 */
export function diffPackage(prev: NpmStateRow | undefined, obs: NpmObservation, ctx: NpmRunCtx): { row: NpmStateRow | null; events: NpmChangeRow[] } {
  const day = ctx.now.slice(0, 10);
  const ev = (kind: NpmChangeKind, oldV: string | null, newV: string | null, prevModified: string | null = null): NpmChangeRow => ({ detected_on: day, ident: obs.ident, kind, old_value: oldV, new_value: newV, scan_run_id: ctx.scanRunId, prev_modified: prevModified });

  if (obs.kind === 'error') {
    if (!prev) return { row: null, events: [] };
    return { row: { ...prev, last_error: obs.error, last_error_at: ctx.now }, events: [] };
  }

  const next: Pick<NpmStateRow, 'status' | 'latest' | 'modified' | 'deprecated'> =
    obs.kind === 'found'
      ? { status: 'found', latest: obs.facts.latest, modified: obs.facts.modified, deprecated: obs.facts.deprecated }
      : { status: 'not_found', latest: null, modified: null, deprecated: null };

  if (!prev) {
    return {
      row: { ident: obs.ident, ...next, baseline: true, first_checked_at: ctx.now, checked_at: ctx.now, changed_at: null, last_error: null, last_error_at: null, scan_run_id: ctx.scanRunId },
      events: [],
    };
  }

  const events: NpmChangeRow[] = [];
  if (prev.status === 'found' && next.status === 'not_found') events.push(ev('not_found', prev.latest, null));
  else if (prev.status === 'not_found' && next.status === 'found') events.push(ev('restored', null, next.latest));
  else if (prev.status === 'found' && next.status === 'found') {
    if (prev.latest !== null && next.latest !== null && prev.latest !== next.latest) events.push(ev('latest_changed', prev.latest, next.latest, prev.modified));
    if (prev.deprecated === false && next.deprecated === true) events.push(ev('deprecated', next.latest, null));
    if (prev.deprecated === true && next.deprecated === false) events.push(ev('undeprecated', next.latest, null));
  }
  const stateChanged = prev.status !== next.status || prev.latest !== next.latest || prev.deprecated !== next.deprecated;
  return {
    row: {
      ...prev,
      ...next,
      checked_at: ctx.now,
      changed_at: stateChanged ? ctx.now : prev.changed_at,
      last_error: null,
      last_error_at: prev.last_error_at,
      scan_run_id: ctx.scanRunId,
    },
    events,
  };
}

export interface SnapshotLimits {
  /** 한 번에 found → not_found 로 바뀌는 수가 이보다 많으면 npm 장애로 보고 그 전환을 쓰지 않는다 */
  maxNewNotFound: number;
  /** 오류 비율이 이보다 크면 아무것도 쓰지 않는다 */
  maxErrorShare: number;
}
export const DEFAULT_SNAPSHOT_LIMITS: SnapshotLimits = { maxNewNotFound: 50, maxErrorShare: 0.2 };

export interface SnapshotPlan {
  rows: NpmStateRow[];
  events: NpmChangeRow[];
  stats: { checked: number; found: number; not_found: number; errors: number; baseline: number; events: number; held_not_found: number };
  abort: string | null;
}

/** 오늘 관찰 전체 → 쓸 행·이벤트. 안전장치에 걸리면 abort(아무것도 쓰지 않음) 또는 일부 전환 보류. */
export function planSnapshot(prevRows: readonly NpmStateRow[], observations: readonly NpmObservation[], ctx: NpmRunCtx, limits: SnapshotLimits = DEFAULT_SNAPSHOT_LIMITS): SnapshotPlan {
  const prevBy = new Map(prevRows.map((r) => [r.ident, r]));
  const stats = { checked: observations.length, found: 0, not_found: 0, errors: 0, baseline: 0, events: 0, held_not_found: 0 };
  for (const o of observations) {
    if (o.kind === 'found') stats.found++;
    else if (o.kind === 'not_found') stats.not_found++;
    else stats.errors++;
  }
  if (observations.length > 0 && stats.errors / observations.length > limits.maxErrorShare) {
    return { rows: [], events: [], stats, abort: `error share ${stats.errors}/${observations.length} over ${limits.maxErrorShare}` };
  }
  const newNotFound = observations.filter((o) => o.kind === 'not_found' && prevBy.get(o.ident)?.status === 'found').length;
  const hold = newNotFound > limits.maxNewNotFound;

  const rows: NpmStateRow[] = [];
  const events: NpmChangeRow[] = [];
  for (const o of observations) {
    const prev = prevBy.get(o.ident);
    if (hold && o.kind === 'not_found' && prev?.status === 'found') {
      // 대량 사라짐은 npm 쪽 문제일 수 있다: 상태를 바꾸지 않고 오류처럼 남긴다.
      stats.held_not_found++;
      rows.push({ ...prev, last_error: 'not_found_held', last_error_at: ctx.now });
      continue;
    }
    const r = diffPackage(prev, o, ctx);
    if (r.row) {
      rows.push(r.row);
      if (!prev && r.row.baseline) stats.baseline++;
    }
    events.push(...r.events);
  }
  stats.events = events.length;
  return { rows, events, stats, abort: null };
}

// ─────────────────────────────────────────────
// npm 읽기
// ─────────────────────────────────────────────

export interface NpmFetchDeps {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  base?: string;
  timeoutMs?: number;
}

/** 패키지 하나. 404 = not_found, 200 = found, 나머지는 error. 429·5xx·네트워크는 한 번 다시 시도(Retry-After 존중, 최대 60초). */
export async function fetchNpmPackage(ident: string, deps: NpmFetchDeps = {}): Promise<NpmObservation> {
  const f = deps.fetchImpl ?? fetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let attempt = 1; attempt <= 2; attempt++) {
    let res: Response;
    try {
      res = await f(npmUrl(ident, deps.base), {
        headers: { Accept: ABBREVIATED_ACCEPT, 'User-Agent': NPM_USER_AGENT },
        signal: AbortSignal.timeout(deps.timeoutMs ?? 15_000),
      });
    } catch (e) {
      const kind = e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError') ? 'timeout' : 'network';
      if (attempt < 2) {
        await sleep(2000);
        continue;
      }
      return { ident, kind: 'error', error: kind };
    }
    if (res.status === 200) {
      try {
        return { ident, kind: 'found', facts: parseAbbreviated(await res.json()) };
      } catch {
        return { ident, kind: 'error', error: 'invalid_json' };
      }
    }
    if (res.status === 404) {
      await res.body?.cancel().catch(() => undefined);
      return { ident, kind: 'not_found' };
    }
    await res.body?.cancel().catch(() => undefined);
    const retryable = res.status === 429 || res.status >= 500;
    if (retryable && attempt < 2) {
      const ra = Number(res.headers.get('retry-after'));
      await sleep(Number.isFinite(ra) && ra > 0 ? Math.min(ra, 60) * 1000 : 2000);
      continue;
    }
    return { ident, kind: 'error', error: `http_${res.status}` };
  }
  return { ident, kind: 'error', error: 'unreachable' };
}

export interface PoolOpts {
  concurrency: number;
  /** 이 수만큼만 요청한다(나머지는 다음 실행으로) */
  maxRequests: number;
  /** 이 시각(ms) 이후에는 새 요청을 시작하지 않는다 */
  deadline: number;
  now?: () => number;
}

/** 동시 요청 상한·총 요청 상한·시간 상한. 순서대로 시작하고, 끝난 것만 돌려준다. */
export async function fetchAll<T = NpmObservation>(idents: readonly string[], one: (ident: string) => Promise<T>, opts: PoolOpts): Promise<{ observations: T[]; skipped: number }> {
  const now = opts.now ?? Date.now;
  const todo = idents.slice(0, opts.maxRequests);
  const out: T[] = [];
  let next = 0;
  let started = 0;
  async function worker(): Promise<void> {
    for (;;) {
      if (next >= todo.length || now() >= opts.deadline) return;
      const ident = todo[next++]!;
      started++;
      out.push(await one(ident));
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, opts.concurrency) }, worker));
  return { observations: out, skipped: idents.length - started };
}

// ─────────────────────────────────────────────
// DB 입출력
// ─────────────────────────────────────────────

const STATE_COLUMNS = 'ident,status,latest,modified,deprecated,baseline,first_checked_at,checked_at,changed_at,last_error,last_error_at,scan_run_id';

export async function getKeyset<T extends Record<string, unknown>>(cfg: SupabaseConfig, table: string, select: string, key: string, filters: Array<[string, string]>, deps: DiffIoDeps): Promise<T[]> {
  const f = deps.fetchImpl ?? fetch;
  const pageSize = deps.pageSize ?? 1000;
  const base = `${cfg.url.replace(/\/+$/, '')}/rest/v1/${table}`;
  const out: T[] = [];
  let after: string | null = null;
  for (;;) {
    const qs = new URLSearchParams({ select, order: `${key}.asc`, limit: String(pageSize) });
    for (const [k, v] of filters) qs.append(k, v);
    if (after !== null) qs.append(key, `gt.${after}`);
    let res: Response;
    try {
      res = await f(`${base}?${qs.toString()}`, { headers: supabaseHeaders(cfg.key, { Accept: 'application/json' }), signal: AbortSignal.timeout(30_000) });
    } catch {
      throw new Error(`${table} read failed: network`);
    }
    if (!res.ok) throw new Error(`${table} read failed: HTTP ${res.status}`);
    const page = (await res.json()) as T[];
    if (!Array.isArray(page)) throw new Error(`${table} read failed: unexpected response`);
    out.push(...page);
    if (page.length < pageSize) break;
    const last = page[page.length - 1]?.[key];
    if (typeof last !== 'string' || last === after) throw new Error(`${table} read failed: pagination did not advance`);
    after = last;
  }
  return out;
}

/** Registry 에서 지금 선언 중인 항목의 packages_key */
export async function fetchDeclaredPackageKeys(cfg: SupabaseConfig, deps: DiffIoDeps = {}): Promise<string[]> {
  const rows = await getKeyset<{ name: string; packages_key: string | null }>(cfg, 'registry_state', 'name,packages_key', 'name', [['removed_at', 'is.null'], ['packages_key', 'neq.']], deps);
  return rows.map((r) => r.packages_key ?? '').filter((k) => k !== '');
}

export function fetchNpmState(cfg: SupabaseConfig, deps: DiffIoDeps = {}): Promise<NpmStateRow[]> {
  return getKeyset<NpmStateRow & Record<string, unknown>>(cfg, 'npm_package_state', STATE_COLUMNS, 'ident', [], deps);
}

export function upsertNpmState(cfg: SupabaseConfig, rows: readonly NpmStateRow[], deps: DiffIoDeps = {}): Promise<number> {
  return postBatches(cfg, 'npm_package_state?on_conflict=ident', rows, 'resolution=merge-duplicates,return=minimal', { batchSize: 500, ...deps });
}

export function insertNpmChanges(cfg: SupabaseConfig, rows: readonly NpmChangeRow[], deps: DiffIoDeps = {}): Promise<number> {
  return postBatches(cfg, 'npm_package_changes?on_conflict=detected_on,ident,kind', rows, 'resolution=ignore-duplicates,return=minimal', deps);
}
