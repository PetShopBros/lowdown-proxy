// PyPI 패키지 일별 상태 — 순수 함수와 PyPI/DB 입출력
//   대상: MCP Registry 가 선언한 PyPI 패키지. 공개 JSON API 와 Index API(JSON)만 읽고 코드는 실행하지 않는다.
//   PyPI 안내(docs.pypi.org/api, 2026-10-23 확인): 가장자리 요청 제한은 없지만 몇 분 안에 수천 건을 몰아 보내지 말고
//   시간에 걸쳐 순차로, User-Agent 로 우리를 밝힐 것. 무책임한 사용은 차단될 수 있다.
//   저장은 버전·시각·여부·프로젝트 상태만. 설명·README·회수 사유, 그리고 JSON API 의 vulnerabilities(보안 데이터)는 읽지도 저장하지도 않는다.

import { USER_AGENT, type SupabaseConfig } from './lib.ts';
import { getKeyset } from './npm-lib.ts';
import { postBatches, type DiffIoDeps } from './registry-diff.ts';

export const PYPI_BASE = 'https://pypi.org';
export const PYPI_USER_AGENT = `${USER_AGENT} (+https://github.com/PetShopBros/lowdown-proxy)`;
export const SIMPLE_JSON_ACCEPT = 'application/vnd.pypi.simple.v1+json';

// PEP 508 이름 형식(대소문자 무시). 길이는 넉넉히 200 으로 막는다.
const PYPI_NAME = /^([A-Za-z0-9]|[A-Za-z0-9][A-Za-z0-9._-]*[A-Za-z0-9])$/;
const SAFE_VERSION = /^[0-9A-Za-z.+_!-]{1,64}$/;
export const PROJECT_STATUSES = ['active', 'archived', 'quarantined', 'deprecated'] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

export function isPypiName(s: string): boolean {
  return s.length > 0 && s.length <= 200 && PYPI_NAME.test(s);
}

/** PEP 503 정규화: 소문자, 연속된 - _ . 는 - 하나로 */
export function normalizePypiName(s: string): string {
  return s.replace(/[-_.]+/g, '-').toLowerCase();
}

/** registry_state.packages_key 들 → 정규화한 고유 PyPI 이름(정렬). 형식이 아닌 값은 개수만. */
export function pypiIdentsFromPackagesKeys(keys: readonly string[]): { idents: string[]; invalid: number } {
  const set = new Set<string>();
  let invalid = 0;
  for (const key of keys) {
    for (const line of key.split('\n')) {
      const [type, ident] = line.trim().split(' ');
      if (type !== 'pypi') continue;
      if (ident && isPypiName(ident)) set.add(normalizePypiName(ident));
      else invalid++;
    }
  }
  return { idents: [...set].sort(), invalid };
}

export const pypiJsonUrl = (ident: string, base = PYPI_BASE) => `${base.replace(/\/+$/, '')}/pypi/${ident}/json`;
export const pypiSimpleUrl = (ident: string, base = PYPI_BASE) => `${base.replace(/\/+$/, '')}/simple/${ident}/`;

export interface PypiFacts {
  latest: string | null;
  latest_yanked: boolean | null;
  uploaded: string | null;
}

/** JSON API 응답 → 최신 버전·그 버전의 회수 여부·업로드 시각. vulnerabilities 등 다른 키는 보지 않는다. */
export function parsePypiJson(doc: unknown): PypiFacts {
  const d = (doc && typeof doc === 'object' ? doc : {}) as Record<string, unknown>;
  const info = (d.info && typeof d.info === 'object' ? d.info : {}) as Record<string, unknown>;
  const latest = typeof info.version === 'string' && SAFE_VERSION.test(info.version) ? info.version : null;
  const latest_yanked = typeof info.yanked === 'boolean' ? info.yanked : null;
  let uploaded: string | null = null;
  const urls = Array.isArray(d.urls) ? (d.urls as unknown[]) : [];
  for (const u of urls) {
    const t = u && typeof u === 'object' ? (u as Record<string, unknown>).upload_time_iso_8601 : undefined;
    if (typeof t !== 'string') continue;
    const ms = Date.parse(t);
    if (!Number.isFinite(ms)) continue;
    const iso = new Date(ms).toISOString();
    if (uploaded === null || iso > uploaded) uploaded = iso;
  }
  return { latest, latest_yanked, uploaded };
}

/** Index API(JSON) 응답 → project-status. 알 수 없으면 null. */
export function parseProjectStatus(doc: unknown): ProjectStatus | null {
  const d = (doc && typeof doc === 'object' ? doc : {}) as Record<string, unknown>;
  const ps = d['project-status'];
  const st = ps && typeof ps === 'object' ? (ps as Record<string, unknown>).status : undefined;
  return typeof st === 'string' && (PROJECT_STATUSES as readonly string[]).includes(st) ? (st as ProjectStatus) : null;
}

/** Index API(/simple/<이름>/)가 이번에 실제로 답한 것: 200 = found, 404 = not_found, 오류·미확인 = null */
export type IndexStatus = 'found' | 'not_found';

export type PypiObservation =
  /** project_status null = 이번에 알 수 없음(Index API 실패 등) → 직전 값을 유지. 단 Index API 가 404 면 비운다. */
  | { ident: string; kind: 'found'; facts: PypiFacts; project_status: ProjectStatus | null; index?: IndexStatus | null }
  | { ident: string; kind: 'not_found'; project_status: ProjectStatus | null; index?: IndexStatus | null }
  | { ident: string; kind: 'error'; error: string };

export interface PypiStateRow {
  ident: string;
  status: 'found' | 'not_found';
  latest: string | null;
  latest_yanked: boolean | null;
  uploaded: string | null;
  project_status: ProjectStatus | null;
  /**
   * Index API 의 마지막 답(found/not_found). JSON API 가 404 일 때 둘을 가른다:
   * found = PyPI 에 프로젝트는 있으나 릴리스가 없음, not_found = 그 이름의 프로젝트가 없음. null = 아직 모름(2026-10-24 이전 행 등).
   */
  index_status: IndexStatus | null;
  baseline: boolean;
  first_checked_at: string;
  checked_at: string;
  changed_at: string | null;
  last_error: string | null;
  last_error_at: string | null;
  scan_run_id: string | null;
}

export type PypiChangeKind = 'latest_changed' | 'yanked' | 'unyanked' | 'status_changed' | 'not_found' | 'restored';

export interface PypiChangeRow {
  detected_on: string;
  ident: string;
  kind: PypiChangeKind;
  old_value: string | null;
  new_value: string | null;
  scan_run_id: string;
}

export interface PypiRunCtx {
  now: string;
  scanRunId: string;
}

/**
 * 직전 상태 + 오늘 관찰 → 새 상태 행 + 이벤트. npm 과 같은 규칙.
 *  - 직전 상태가 없으면 기준선(이벤트 없음). 오류면 행도 만들지 않는다.
 *  - 오류: 상태는 그대로, last_error 만.
 *  - JSON API 404 만 not_found. 직전이 found 일 때만 not_found 이벤트, 반대는 restored.
 *  - project_status 가 이번에 null(알 수 없음)이면 직전 값을 유지하고 이벤트를 만들지 않는다.
 */
export function diffPypiPackage(prev: PypiStateRow | undefined, obs: PypiObservation, ctx: PypiRunCtx): { row: PypiStateRow | null; events: PypiChangeRow[] } {
  const day = ctx.now.slice(0, 10);
  const ev = (kind: PypiChangeKind, oldV: string | null, newV: string | null): PypiChangeRow => ({ detected_on: day, ident: obs.ident, kind, old_value: oldV, new_value: newV, scan_run_id: ctx.scanRunId });

  if (obs.kind === 'error') {
    if (!prev) return { row: null, events: [] };
    return { row: { ...prev, last_error: obs.error, last_error_at: ctx.now }, events: [] };
  }

  // Index API 가 404 = 프로젝트 자체가 없다 → 직전 project_status 를 남기지 않는다(남기면 "이름은 있음"으로 읽힌다)
  const index = obs.index ?? null;
  // (JSON API 가 답한 found 쪽에서 Index 만 404 인 것은 일시적인 불일치로 보고 직전 값을 유지)
  const projectStatus = obs.kind === 'not_found' && index === 'not_found' ? null : (obs.project_status ?? prev?.project_status ?? null);
  const indexStatus = index ?? prev?.index_status ?? null;
  const next: Pick<PypiStateRow, 'status' | 'latest' | 'latest_yanked' | 'uploaded' | 'project_status' | 'index_status'> =
    obs.kind === 'found'
      ? { status: 'found', latest: obs.facts.latest, latest_yanked: obs.facts.latest_yanked, uploaded: obs.facts.uploaded, project_status: projectStatus, index_status: indexStatus }
      : { status: 'not_found', latest: null, latest_yanked: null, uploaded: null, project_status: projectStatus, index_status: indexStatus };

  if (!prev) {
    return {
      row: { ident: obs.ident, ...next, baseline: true, first_checked_at: ctx.now, checked_at: ctx.now, changed_at: null, last_error: null, last_error_at: null, scan_run_id: ctx.scanRunId },
      events: [],
    };
  }

  const events: PypiChangeRow[] = [];
  if (prev.status === 'found' && next.status === 'not_found') events.push(ev('not_found', prev.latest, null));
  else if (prev.status === 'not_found' && next.status === 'found') events.push(ev('restored', null, next.latest));
  else if (prev.status === 'found' && next.status === 'found') {
    if (prev.latest !== null && next.latest !== null && prev.latest !== next.latest) events.push(ev('latest_changed', prev.latest, next.latest));
    if (prev.latest_yanked === false && next.latest_yanked === true) events.push(ev('yanked', next.latest, null));
    if (prev.latest_yanked === true && next.latest_yanked === false) events.push(ev('unyanked', next.latest, null));
  }
  if (obs.project_status !== null && prev.project_status !== null && prev.project_status !== obs.project_status) {
    events.push(ev('status_changed', prev.project_status, obs.project_status));
  }
  const stateChanged =
    prev.status !== next.status || prev.latest !== next.latest || prev.latest_yanked !== next.latest_yanked || prev.project_status !== next.project_status;
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

export interface PypiSnapshotLimits {
  maxNewNotFound: number;
  maxErrorShare: number;
}
export const DEFAULT_PYPI_LIMITS: PypiSnapshotLimits = { maxNewNotFound: 30, maxErrorShare: 0.2 };

export interface PypiSnapshotPlan {
  rows: PypiStateRow[];
  events: PypiChangeRow[];
  stats: { checked: number; found: number; not_found: number; errors: number; baseline: number; events: number; held_not_found: number };
  abort: string | null;
}

/** 오늘 관찰 전체 → 쓸 행·이벤트. 오류가 많으면 아무것도 쓰지 않고, 한꺼번에 많이 404 가 되면 그 전환은 보류한다. */
export function planPypiSnapshot(
  prevRows: readonly PypiStateRow[],
  observations: readonly PypiObservation[],
  ctx: PypiRunCtx,
  limits: PypiSnapshotLimits = DEFAULT_PYPI_LIMITS,
): PypiSnapshotPlan {
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

  const rows: PypiStateRow[] = [];
  const events: PypiChangeRow[] = [];
  for (const o of observations) {
    const prev = prevBy.get(o.ident);
    if (hold && o.kind === 'not_found' && prev?.status === 'found') {
      stats.held_not_found++;
      rows.push({ ...prev, last_error: 'not_found_held', last_error_at: ctx.now });
      continue;
    }
    const r = diffPypiPackage(prev, o, ctx);
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
// PyPI 읽기
// ─────────────────────────────────────────────

export interface PypiFetchDeps {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  base?: string;
  timeoutMs?: number;
}

type GetResult = { kind: 'ok'; body: unknown } | { kind: 'not_found' } | { kind: 'error'; error: string };

/** GET 하나. 200 = ok, 404 = not_found, 나머지는 error. 429·5xx·네트워크는 한 번 다시 시도(Retry-After 존중, 최대 60초). */
async function getJson(url: string, accept: string, deps: PypiFetchDeps): Promise<GetResult> {
  const f = deps.fetchImpl ?? fetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let attempt = 1; attempt <= 2; attempt++) {
    let res: Response;
    try {
      res = await f(url, { headers: { Accept: accept, 'User-Agent': PYPI_USER_AGENT }, signal: AbortSignal.timeout(deps.timeoutMs ?? 15_000) });
    } catch (e) {
      const kind = e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError') ? 'timeout' : 'network';
      if (attempt < 2) {
        await sleep(2000);
        continue;
      }
      return { kind: 'error', error: kind };
    }
    if (res.status === 200) {
      try {
        return { kind: 'ok', body: await res.json() };
      } catch {
        return { kind: 'error', error: 'invalid_json' };
      }
    }
    await res.body?.cancel().catch(() => undefined);
    if (res.status === 404) return { kind: 'not_found' };
    const retryable = res.status === 429 || res.status >= 500;
    if (retryable && attempt < 2) {
      const ra = Number(res.headers.get('retry-after'));
      await sleep(Number.isFinite(ra) && ra > 0 ? Math.min(ra, 60) * 1000 : 2000);
      continue;
    }
    return { kind: 'error', error: `http_${res.status}` };
  }
  return { kind: 'error', error: 'unreachable' };
}

/**
 * 패키지 하나: JSON API(최신 버전·회수·업로드 시각) + Index API(project-status).
 *  - JSON API 가 found/not_found/error 를 정한다. 404 만 not_found.
 *  - Index API 는 project-status 만. 실패하면 null(알 수 없음, 직전 값 유지).
 */
export async function fetchPypiPackage(ident: string, deps: PypiFetchDeps = {}): Promise<PypiObservation> {
  const j = await getJson(pypiJsonUrl(ident, deps.base), 'application/json', deps);
  if (j.kind === 'error') return { ident, kind: 'error', error: j.error };
  const s = await getJson(pypiSimpleUrl(ident, deps.base), SIMPLE_JSON_ACCEPT, deps);
  const project_status = s.kind === 'ok' ? parseProjectStatus(s.body) : null;
  const index: IndexStatus | null = s.kind === 'ok' ? 'found' : s.kind === 'not_found' ? 'not_found' : null;
  if (j.kind === 'not_found') return { ident, kind: 'not_found', project_status, index };
  return { ident, kind: 'found', facts: parsePypiJson(j.body), project_status, index };
}

// ─────────────────────────────────────────────
// DB 입출력
// ─────────────────────────────────────────────

const STATE_COLUMNS = 'ident,status,latest,latest_yanked,uploaded,project_status,index_status,baseline,first_checked_at,checked_at,changed_at,last_error,last_error_at,scan_run_id';

export function fetchPypiState(cfg: SupabaseConfig, deps: DiffIoDeps = {}): Promise<PypiStateRow[]> {
  return getKeyset<PypiStateRow & Record<string, unknown>>(cfg, 'pypi_package_state', STATE_COLUMNS, 'ident', [], deps);
}

export function upsertPypiState(cfg: SupabaseConfig, rows: readonly PypiStateRow[], deps: DiffIoDeps = {}): Promise<number> {
  return postBatches(cfg, 'pypi_package_state?on_conflict=ident', rows, 'resolution=merge-duplicates,return=minimal', { batchSize: 500, ...deps });
}

export function insertPypiChanges(cfg: SupabaseConfig, rows: readonly PypiChangeRow[], deps: DiffIoDeps = {}): Promise<number> {
  return postBatches(cfg, 'pypi_package_changes?on_conflict=detected_on,ident,kind', rows, 'resolution=ignore-duplicates,return=minimal', deps);
}
