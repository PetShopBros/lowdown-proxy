// Lowdown 월간 MCP 보고서 — 집계와 초안 렌더 (실행: scanner/monthly.ts)
//   설계: 프로젝트 문서 claude/lowdown-monthly-report-plan-2026-11-09.md
//   원칙:
//     1) 서버 이름·주소·호스트·도구 이름은 결과에 넣지 않는다. 합계와 분포만 남긴다.
//     2) 절마다 기준(basis)과 공개 데이터셋(CC BY 4.0)으로 다시 계산할 수 있는지(reproducible)를 붙인다.
//     3) 큰 표(scanner_observations)는 (observed_at, id) keyset 으로 읽고 페이지마다 바로 축약한다(supabase/QUERY_RULES.md).
//     4) 작은 합계는 PostgREST count(HEAD + Prefer: count=exact)로만 센다. 행을 내려받지 않는다.
//     5) 비공개 데이터(레이다·stdio·패키지 상태)는 합계만. md 에는 6절 숫자를 몇 개만 싣는다. json 은 내부 작업용(게시하지 않음).
//   Registry 전체 수치의 대상: source ∈ {scanner, scanner_rotating, scanner_requested}. 셋 다 target_id = mcp:<Registry 이름>이고
//   한 실행에서 서버마다 하나의 source 로만 관찰된다(scan.ts). scanner_declared(Registry 밖 엔드포인트)는 넣지 않는다.

import { capHost, supabaseHeaders, type SupabaseConfig } from './lib.ts';
import { fetchRetry } from './rest-retry.ts';

export const MONTHLY_SOURCES = ['scanner', 'scanner_rotating', 'scanner_requested'] as const;
/** 고정 코호트 추이(Q4): 조회된 코호트 멤버는 scanner_requested 로 기록되므로 함께 읽는다 */
export const TREND_SOURCES = new Set(['scanner', 'scanner_requested']);
export const DEFAULT_TREND_FROM = '2026-10-07';

export type Basis = 'fixed' | 'rotating' | 'requested';
export const BASES: readonly Basis[] = ['fixed', 'rotating', 'requested'];
const BASIS_OF: Record<string, Basis> = { scanner: 'fixed', scanner_rotating: 'rotating', scanner_requested: 'requested' };

export const MONTH_COLUMNS =
  'id,target_id,observed_at,source,http_status,reached_level,error_type,' +
  'remote_url:metadata->>remote_url,tool_set_hash:metadata->>tool_set_hash,tool_count:metadata->>tool_count,server_version:metadata->>server_version';

export interface MonthRow {
  id: number;
  target_id: string;
  observed_at: string;
  source: string;
  http_status: number | null;
  reached_level: number | null;
  error_type: string | null;
  remote_url: string | null;
  tool_set_hash: string | null;
  tool_count: string | number | null;
  server_version: string | null;
}

export interface MonthRange {
  label: string; // YYYY-MM
  start: string; // ISO, 포함
  end: string; // ISO, 제외
  startDay: string; // YYYY-MM-DD
  endDay: string; // 다음 달 1일 YYYY-MM-DD (제외)
}

export function parseMonth(label: string): MonthRange {
  const m = /^(\d{4})-(\d{2})$/.exec(label);
  if (!m) throw new Error(`month must look like YYYY-MM: ${label}`);
  const y = Number(m[1]);
  const mo = Number(m[2]);
  if (mo < 1 || mo > 12) throw new Error(`month out of range: ${label}`);
  const start = new Date(Date.UTC(y, mo - 1, 1));
  const end = new Date(Date.UTC(y, mo, 1));
  return { label, start: start.toISOString(), end: end.toISOString(), startDay: start.toISOString().slice(0, 10), endDay: end.toISOString().slice(0, 10) };
}

// ── 축약 ─────────────────────────────────────────────

/** 서버 하나의 하루치 요약. 원격 주소가 여럿이면 가장 높은 단계에 도달한 시도를 대표로 쓴다. */
export interface DaySummary {
  day: string;
  attempts: number; // blocked_url 을 뺀 시도 수
  blocked: number;
  level: number; // 시도 중 최고 단계 (-1 = 시도 없음)
  http: string; // 대표 시도의 HTTP 상태 키
  error: string; // 대표 시도의 error_type 키
  hosts: Set<string>; // 단계 1 이상에 도달한 시도의 호스트 (결과로 내보내지 않음)
  version: string | null; // 단계 1 이상 시도의 server_version
  toolCount: number | null; // 단계 2 시도의 최대 도구 수
}

interface RemoteHash {
  hash: string;
  seen: number;
  changed: boolean;
}

export interface TargetAcc {
  basis: Basis; // 그 달 마지막 관찰의 source
  first: DaySummary | null;
  last: DaySummary | null;
  days: number;
  remotes: Map<string, RemoteHash>; // 원격 주소별 tool_set_hash 연속 비교 (결과로 내보내지 않음)
}

export interface TrendCell {
  day: string;
  level: number;
}

export interface MonthlyState {
  rows: number;
  targets: Map<string, TargetAcc>;
  trend: Map<string, Map<string, TrendCell>>; // week -> target -> 그 주 마지막 관찰 날의 단계
}

export function newState(): MonthlyState {
  return { rows: 0, targets: new Map(), trend: new Map() };
}

// 외부에서 온 문자열은 허용 형식만 통과시킨다 (report-lib.ts 와 같은 규칙)
export function statusKey(s: number | null): string {
  if (s === null || s === undefined) return 'no HTTP response';
  return Number.isInteger(s) && s >= 100 && s <= 599 ? String(s) : 'other';
}

export function errorKey(e: string | null): string {
  if (e === null || e === undefined) return 'none';
  return /^[a-z_]{1,32}$/.test(e) ? e : 'other';
}

function levelOf(r: MonthRow): number {
  return r.reached_level === 0 || r.reached_level === 1 || r.reached_level === 2 ? r.reached_level : 0;
}

function toolCountOf(v: string | number | null): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d{1,6}$/.test(v) ? Number(v) : NaN;
  return Number.isInteger(n) && n >= 0 ? n : null;
}

function emptyDay(day: string): DaySummary {
  return { day, attempts: 0, blocked: 0, level: -1, http: 'none', error: 'none', hosts: new Set(), version: null, toolCount: null };
}

function addToDay(d: DaySummary, r: MonthRow): void {
  if (r.error_type === 'blocked_url') {
    d.blocked++;
    return;
  }
  d.attempts++;
  const lv = levelOf(r);
  if (lv > d.level) {
    d.level = lv;
    d.http = statusKey(r.http_status);
    d.error = errorKey(r.error_type);
  }
  if (lv >= 1) {
    const h = typeof r.remote_url === 'string' ? capHost(r.remote_url) : null;
    if (h) d.hosts.add(h);
    if (typeof r.server_version === 'string' && r.server_version.trim() && d.version === null) d.version = r.server_version.trim();
  }
  if (lv === 2) {
    const tc = toolCountOf(r.tool_count);
    if (tc !== null && (d.toolCount === null || tc > d.toolCount)) d.toolCount = tc;
  }
}

/** 월요일 시작 주(UTC)의 첫날 */
export function weekOf(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  const dow = (d.getUTCDay() + 6) % 7; // 월=0
  return new Date(d.getTime() - dow * 86_400_000).toISOString().slice(0, 10);
}

/** 한 페이지(시각 오름차순)를 상태에 더한다. 월 범위 밖 행은 추이(Q4)에만 쓴다. */
export function accumulate(state: MonthlyState, rows: readonly MonthRow[], range: MonthRange, trendIds: ReadonlySet<string>): void {
  for (const r of rows) {
    const day = r.observed_at.slice(0, 10);
    if (trendIds.has(r.target_id) && TREND_SOURCES.has(r.source) && day < range.endDay && r.error_type !== 'blocked_url') {
      const wk = weekOf(day);
      let w = state.trend.get(wk);
      if (!w) state.trend.set(wk, (w = new Map()));
      const lv = levelOf(r);
      const c = w.get(r.target_id);
      if (!c || day > c.day) w.set(r.target_id, { day, level: lv });
      else if (day === c.day && lv > c.level) c.level = lv;
    }

    if (day < range.startDay || day >= range.endDay) continue;
    const basis = BASIS_OF[r.source];
    if (!basis) continue;
    state.rows++;
    let t = state.targets.get(r.target_id);
    if (!t) state.targets.set(r.target_id, (t = { basis, first: null, last: null, days: 0, remotes: new Map() }));
    t.basis = basis;
    if (!t.last || t.last.day !== day) {
      t.last = emptyDay(day);
      t.days++;
      if (!t.first) t.first = t.last;
    }
    addToDay(t.last, r); // 첫 날이면 t.first 와 같은 객체

    if (levelOf(r) === 2 && typeof r.tool_set_hash === 'string' && /^[0-9a-f]{64}$/.test(r.tool_set_hash) && typeof r.remote_url === 'string') {
      const rh = t.remotes.get(r.remote_url);
      if (!rh) t.remotes.set(r.remote_url, { hash: r.tool_set_hash, seen: 1, changed: false });
      else {
        rh.seen++;
        if (rh.hash !== r.tool_set_hash) {
          rh.changed = true;
          rh.hash = r.tool_set_hash;
        }
      }
    }
  }
}

// ── 집계 (순수 함수) ─────────────────────────────────

export interface Distribution {
  key: string;
  count: number;
}

function distribution(keys: readonly string[]): Distribution[] {
  const m = new Map<string, number>();
  for (const k of keys) m.set(k, (m.get(k) ?? 0) + 1);
  return [...m.entries()].map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}

function byBasis<T>(make: () => T): Record<Basis, T> {
  return { fixed: make(), rotating: make(), requested: make() };
}

export interface StatusSummary {
  servers: number;
  by_basis: Record<Basis, number>;
  not_called: number;
  attempted: number;
  reached_level: Record<'0' | '1' | '2', number>;
  http_status: Distribution[];
  error_type: Distribution[];
  status_401_403: number;
}

/** Q1·Q3: 서버별 그 달 마지막 관찰 날 기준 */
export function statusDist(state: MonthlyState): StatusSummary {
  const out: StatusSummary = {
    servers: state.targets.size,
    by_basis: byBasis(() => 0),
    not_called: 0,
    attempted: 0,
    reached_level: { '0': 0, '1': 0, '2': 0 },
    http_status: [],
    error_type: [],
    status_401_403: 0,
  };
  const http: string[] = [];
  const err: string[] = [];
  for (const t of state.targets.values()) {
    out.by_basis[t.basis]++;
    const d = t.last!;
    if (d.attempts === 0) {
      out.not_called++;
      continue;
    }
    out.attempted++;
    out.reached_level[String(d.level) as '0' | '1' | '2']++;
    http.push(d.http);
    err.push(d.error);
    if (d.level === 0 && (d.http === '401' || d.http === '403')) out.status_401_403++;
  }
  out.http_status = distribution(http);
  out.error_type = distribution(err);
  return out;
}

export interface TransitionSummary {
  compared: number; // 그 달 안에서 서로 다른 두 날 이상 시도가 있었던 서버
  became_reachable: number; // 첫 날 단계 0 → 마지막 날 단계 1 이상
  became_unreachable: number; // 첫 날 단계 1 이상 → 마지막 날 단계 0
  unchanged: number;
}

/** Q2: 그 달 첫 관찰 날 → 마지막 관찰 날 (관찰 방식별) */
export function transitions(state: MonthlyState): Record<Basis, TransitionSummary> {
  const out = byBasis<TransitionSummary>(() => ({ compared: 0, became_reachable: 0, became_unreachable: 0, unchanged: 0 }));
  for (const t of state.targets.values()) {
    const a = t.first;
    const b = t.last;
    if (!a || !b || a === b || a.attempts === 0 || b.attempts === 0) continue;
    const o = out[t.basis];
    o.compared++;
    const up = a.level === 0 && b.level >= 1;
    const down = a.level >= 1 && b.level === 0;
    if (up) o.became_reachable++;
    else if (down) o.became_unreachable++;
    else o.unchanged++;
  }
  return out;
}

export interface ToolChangeSummary {
  eligible: number; // 같은 원격 주소에서 도구 목록(tool_set_hash)을 두 번 이상 받은 서버
  changed: number; // 그중 그 달 안에 해시가 한 번 이상 바뀐 서버
}

/** Q8 */
export function toolChanges(state: MonthlyState): Record<Basis, ToolChangeSummary> {
  const out = byBasis<ToolChangeSummary>(() => ({ eligible: 0, changed: 0 }));
  for (const t of state.targets.values()) {
    const rs = [...t.remotes.values()];
    if (!rs.some((r) => r.seen >= 2)) continue;
    out[t.basis].eligible++;
    if (rs.some((r) => r.changed)) out[t.basis].changed++;
  }
  return out;
}

export const TOOL_COUNT_BUCKETS: ReadonlyArray<{ key: string; min: number; max: number }> = [
  { key: '0', min: 0, max: 0 },
  { key: '1-5', min: 1, max: 5 },
  { key: '6-10', min: 6, max: 10 },
  { key: '11-20', min: 11, max: 20 },
  { key: '21-50', min: 21, max: 50 },
  { key: '51+', min: 51, max: Number.POSITIVE_INFINITY },
];

export interface ToolCountSummary {
  servers: number;
  median: number | null;
  buckets: Distribution[];
}

/** Q9: 마지막 관찰 날 단계 2인 서버의 도구 수 */
export function toolCountDist(state: MonthlyState): ToolCountSummary {
  const counts: number[] = [];
  for (const t of state.targets.values()) if (t.last && t.last.level === 2 && t.last.toolCount !== null) counts.push(t.last.toolCount);
  counts.sort((a, b) => a - b);
  const n = counts.length;
  const median = n === 0 ? null : n % 2 ? counts[(n - 1) / 2]! : (counts[n / 2 - 1]! + counts[n / 2]!) / 2;
  return {
    servers: n,
    median,
    buckets: TOOL_COUNT_BUCKETS.map((b) => ({ key: b.key, count: counts.filter((c) => c >= b.min && c <= b.max).length })),
  };
}

export interface RegistryDecl {
  version: string;
  hosts: readonly string[];
}

export interface DeclaredSummary {
  servers: number; // 마지막 관찰 날 단계 1 이상 + Registry 항목이 있는 서버
  version_compared: number;
  version_mismatch: number;
  host_compared: number;
  host_mismatch: number;
}

export function normVersion(v: string): string {
  return v.trim().replace(/^v(?=\d)/i, '');
}

/** Q7: get_lowdown 의 declared_vs_observed 와 같은 정의 — Registry version ↔ 관찰 server_version, Registry hosts ↔ 관찰 호스트 */
export function declaredVsObserved(state: MonthlyState, registry: ReadonlyMap<string, RegistryDecl>): DeclaredSummary {
  const out: DeclaredSummary = { servers: 0, version_compared: 0, version_mismatch: 0, host_compared: 0, host_mismatch: 0 };
  for (const [id, t] of state.targets) {
    const d = t.last;
    if (!d || d.level < 1 || !id.startsWith('mcp:')) continue;
    const decl = registry.get(id.slice(4));
    if (!decl) continue;
    out.servers++;
    if (decl.version.trim() && d.version) {
      out.version_compared++;
      if (normVersion(decl.version) !== normVersion(d.version)) out.version_mismatch++;
    }
    const declared = new Set(decl.hosts.map((h) => h.toLowerCase().replace(/\.+$/, '')));
    if (declared.size > 0 && d.hosts.size > 0) {
      out.host_compared++;
      if ([...d.hosts].some((h) => !declared.has(h))) out.host_mismatch++;
    }
  }
  return out;
}

export interface TrendWeek {
  week: string; // 월요일
  observed: number;
  level2: number;
}

/** Q4: 고정 코호트(v1)의 주별 — 그 주에 시도가 있었던 멤버 수, 그 주 마지막 관찰 날 단계 2인 멤버 수 */
export function weeklyCohortTrend(state: MonthlyState): TrendWeek[] {
  return [...state.trend.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([week, m]) => ({ week, observed: m.size, level2: [...m.values()].filter((c) => c.level === 2).length }));
}

// ── 결과 묶음 ───────────────────────────────────────

export const REGISTRY_KINDS = ['new', 'removed', 'restored', 'version', 'status', 'remotes', 'packages', 'description'] as const;
export const NPM_CHANGE_KINDS = ['latest_changed', 'deprecated', 'undeprecated', 'not_found', 'restored'] as const;
export const PYPI_CHANGE_KINDS = ['latest_changed', 'yanked', 'unyanked', 'status_changed', 'not_found', 'restored'] as const;
export const NOTABLE_RULES = [
  'P1_npm_deprecated',
  'P2_npm_not_found',
  'P4_pypi_archived',
  'P5_pypi_latest_yanked',
  'P6_pypi_not_found',
  'P7_declared_missing_package',
  'R1_first_change_after_stable',
  'R2_changed_same_server_version',
  'R3_tool_removed',
] as const;

export interface CountsInput {
  registry_changes: Record<string, number>;
  registry_active: number;
  registry_with_remotes: number;
  npm_changes: Record<string, number>;
  npm_state: { found: number; not_found: number; deprecated: number };
  pypi_changes: Record<string, number>;
  pypi_state: { found: number; not_found: number; archived: number; quarantined: number; deprecated: number };
  notable: Record<string, number>;
  sandbox: { versions: number; npm: number; pypi: number; done: number; ok: number };
}

export interface MonthlyData {
  month: string;
  period: { start: string; end: string };
  generated_at: string;
  partial: boolean; // 달이 끝나기 전에 만든 초안
  observation_rows: number;
  status: StatusSummary;
  transitions: Record<Basis, TransitionSummary>;
  tool_changes: Record<Basis, ToolChangeSummary>;
  tool_count: ToolCountSummary;
  declared: DeclaredSummary;
  trend: { cohort_version: string; cohort_size: number; from: string; weeks: TrendWeek[] };
  counts: CountsInput;
  sections: Record<string, { basis: string; reproducible: boolean }>;
}

export const SECTIONS: MonthlyData['sections'] = {
  status: {
    basis:
      'scanner_observations, sources scanner + scanner_rotating + scanner_requested (MCP Registry entries with a remote). One row per server: the last UTC day it was observed in the month; when a server has several remotes, the remote that reached the highest level represents it. blocked_url rows are counted as not called.',
    reproducible: true,
  },
  transitions: {
    basis: 'Same servers, first observed day of the month compared with the last. Split by how a server is observed: fixed sample (daily), rotating (every 3 days, started 2026-11-06), on request (daily after a lookup).',
    reproducible: true,
  },
  trend: {
    basis: 'Members of the first fixed sample (cohort 2026-10-07-v1). Per week (Monday, UTC): members with at least one attempt, and members whose last observed day that week reached level 2.',
    reproducible: true,
  },
  registry: {
    basis: 'registry_changes by kind with detected_on in the month; registry_state entries not removed at the time of the run.',
    reproducible: true,
  },
  declared: {
    basis: "Servers that answered initialize on their last observed day and have a Registry entry. Version: Registry version vs serverInfo.version (a leading 'v' ignored). Hosts: any observed host not among the hosts the Registry lists.",
    reproducible: true,
  },
  tools: {
    basis: 'metadata.tool_set_hash (recorded since 2026-10-21) compared per remote across the month. A server counts once if any of its remotes changed. Tool counts: level-2 servers on their last observed day.',
    reproducible: true,
  },
  packages: {
    basis: 'npm and PyPI packages declared in the MCP Registry: change records with detected_on in the month, and package state at the time of the run.',
    reproducible: false,
  },
  private: {
    basis: 'Radar rules (scanner/RADAR.md) recorded in the month; stdio sandbox state since the first runs on 2026-10-23 (sandbox/README.md). Totals only.',
    reproducible: false,
  },
};

export function buildMonthly(
  state: MonthlyState,
  registry: ReadonlyMap<string, RegistryDecl>,
  counts: CountsInput,
  range: MonthRange,
  cohort: { version: string; size: number; from: string },
  now: Date,
): MonthlyData {
  return {
    month: range.label,
    period: { start: range.start, end: range.end },
    generated_at: now.toISOString(),
    partial: now.toISOString() < range.end,
    observation_rows: state.rows,
    status: statusDist(state),
    transitions: transitions(state),
    tool_changes: toolChanges(state),
    tool_count: toolCountDist(state),
    declared: declaredVsObserved(state, registry),
    trend: { cohort_version: cohort.version, cohort_size: cohort.size, from: cohort.from, weeks: weeklyCohortTrend(state) },
    counts,
    sections: SECTIONS,
  };
}

// ── 렌더 (표만. 해설 문장은 사람이 쓴다) ───────────────────

const n = (x: number) => x.toLocaleString('en-US');
export function pct(a: number, b: number): string {
  return b > 0 ? `${((a / b) * 100).toFixed(1)}%` : 'n/a';
}

function table(headers: string[], body: string[][]): string {
  return [`| ${headers.join(' | ')} |`, `| ${headers.map(() => '---').join(' | ')} |`, ...body.map((r) => `| ${r.join(' | ')} |`)].join('\n');
}

const TODO = '<!-- TODO: commentary -->';

function meta(key: string, d: MonthlyData): string {
  const s = d.sections[key]!;
  return `_Basis: ${s.basis} Reproducible from the public dataset: ${s.reproducible ? 'yes' : 'no'}._`;
}

const BASIS_LABEL: Record<Basis, string> = { fixed: 'Fixed sample (daily)', rotating: 'Rotating (every 3 days)', requested: 'On request (daily)' };

export function renderMonthly(d: MonthlyData): string {
  const s = d.status;
  const tc = BASES.reduce((a, b) => ({ eligible: a.eligible + d.tool_changes[b].eligible, changed: a.changed + d.tool_changes[b].changed }), { eligible: 0, changed: 0 });
  const c = d.counts;
  const radar = (c.notable.R1_first_change_after_stable ?? 0) + (c.notable.R2_changed_same_server_version ?? 0) + (c.notable.R3_tool_removed ?? 0);
  const out: string[] = [
    `# Lowdown Ecosystem Observation Report — ${d.month}`,
    '',
    'What MCP Registry servers declared and what Lowdown observed about them. How Lowdown\'s own records were read and used is in the separate Data Access Report.',
    '',
    d.partial ? `> DRAFT: generated ${d.generated_at} before the month closed. Numbers will change.` : `> Generated ${d.generated_at} from the database. Period: ${d.period.start} to ${d.period.end} (UTC, end excluded).`,
    '',
    '## 1. At a glance',
    '',
    TODO,
    '',
    `- Remote MCP servers observed: ${n(s.servers)} (${n(s.attempted)} probed, ${n(s.not_called)} not called)`,
    `- Answered \`tools/list\` on their last observed day: ${n(s.reached_level['2'])} (${pct(s.reached_level['2'], s.attempted)} of probed)`,
    `- Returned 401 or 403: ${n(s.status_401_403)} (${pct(s.status_401_403, s.attempted)} of probed)`,
    `- Changed their tool definitions during the month: ${n(tc.changed)} of ${n(tc.eligible)} (${pct(tc.changed, tc.eligible)})`,
    '',
    '## 2. Remote server status',
    '',
    TODO,
    '',
    table(
      ['Last observed level', 'Servers', 'Share of probed'],
      [
        ['2 — answered initialize and tools/list', n(s.reached_level['2']), pct(s.reached_level['2'], s.attempted)],
        ['1 — answered initialize only', n(s.reached_level['1']), pct(s.reached_level['1'], s.attempted)],
        ['0 — no MCP answer', n(s.reached_level['0']), pct(s.reached_level['0'], s.attempted)],
      ],
    ),
    '',
    table(['HTTP status (representative attempt)', 'Servers'], s.http_status.slice(0, 10).map((x) => [x.key, n(x.count)])),
    '',
    table(['error_type', 'Servers'], s.error_type.slice(0, 10).map((x) => [x.key, n(x.count)])),
    '',
    'The Scanner sends `initialize` and `tools/list` only. It never calls a tool and does not authenticate. A 401 or 403 is the status that was observed; it is not classified as success or failure.',
    '',
    table(
      ['Observed', 'Compared', 'Became reachable', 'Became unreachable', 'Unchanged'],
      BASES.map((b) => {
        const t = d.transitions[b];
        return [BASIS_LABEL[b], n(t.compared), n(t.became_reachable), n(t.became_unreachable), n(t.unchanged)];
      }),
    ),
    '',
    meta('status', d),
    '',
    meta('transitions', d),
    '',
    `### Fixed sample since ${d.trend.from}`,
    '',
    table(['Week of', 'Members observed', 'Level 2', 'Share'], d.trend.weeks.map((w) => [w.week, n(w.observed), n(w.level2), pct(w.level2, w.observed)])),
    '',
    meta('trend', d),
    '',
    '## 3. MCP Registry',
    '',
    TODO,
    '',
    table(['Change kind', 'Count'], REGISTRY_KINDS.map((k) => [k, n(c.registry_changes[k] ?? 0)])),
    '',
    `Entries at the time of the run: ${n(c.registry_active)}, of which ${n(c.registry_with_remotes)} declare a remote.`,
    '',
    meta('registry', d),
    '',
    table(
      ['Declared vs observed', 'Compared', 'Mismatch', 'Share'],
      [
        ['Version', n(d.declared.version_compared), n(d.declared.version_mismatch), pct(d.declared.version_mismatch, d.declared.version_compared)],
        ['Hosts', n(d.declared.host_compared), n(d.declared.host_mismatch), pct(d.declared.host_mismatch, d.declared.host_compared)],
      ],
    ),
    '',
    meta('declared', d),
    '',
    '## 4. Tool definitions',
    '',
    TODO,
    '',
    table(
      ['Observed', 'Servers with 2+ tool lists', 'Changed', 'Share'],
      BASES.map((b) => {
        const t = d.tool_changes[b];
        return [BASIS_LABEL[b], n(t.eligible), n(t.changed), pct(t.changed, t.eligible)];
      }),
    ),
    '',
    `Tool count on the last observed day (${n(d.tool_count.servers)} servers, median ${d.tool_count.median ?? 'n/a'}):`,
    '',
    table(['Tools', 'Servers'], d.tool_count.buckets.map((x) => [x.key, n(x.count)])),
    '',
    meta('tools', d),
    '',
    '## 5. Packages',
    '',
    TODO,
    '',
    table(['npm change', 'Count'], NPM_CHANGE_KINDS.map((k) => [k, n(c.npm_changes[k] ?? 0)])),
    '',
    table(['PyPI change', 'Count'], PYPI_CHANGE_KINDS.map((k) => [k, n(c.pypi_changes[k] ?? 0)])),
    '',
    `npm state: ${n(c.npm_state.found)} found (${n(c.npm_state.deprecated)} deprecated), ${n(c.npm_state.not_found)} not found. PyPI state: ${n(c.pypi_state.found)} found, ${n(c.pypi_state.not_found)} not found; project status archived ${n(c.pypi_state.archived)}, quarantined ${n(c.pypi_state.quarantined)}, deprecated ${n(c.pypi_state.deprecated)}.`,
    '',
    'These counts are not in the public dataset. Per server, the same facts are returned by `get_lowdown` (menu `packages`).',
    '',
    meta('packages', d),
    '',
    '## 6. Private observations (totals only)',
    '',
    TODO,
    '',
    `- Tool-definition changes confirmed by the radar rules (R1–R3): ${n(radar)}, of which ${n(c.notable.R2_changed_same_server_version ?? 0)} without a server version change.`,
    `- stdio sandbox: ${n(c.sandbox.versions)} package versions run; ${pct(c.sandbox.ok, c.sandbox.versions)} answered \`tools/list\` on their last run.`,
    '',
    'Per-server results are not published. To ask about access, open an issue: https://github.com/PetShopBros/lowdown-proxy/issues',
    '',
    meta('private', d),
    '',
    '## 7. Method and data',
    '',
    TODO,
    '',
    '- Public dataset (CC BY 4.0): https://github.com/PetShopBros/lowdown-data',
    '- Radar rules: https://github.com/PetShopBros/lowdown-proxy/blob/main/scanner/RADAR.md',
    '- stdio sandbox: https://github.com/PetShopBros/lowdown-proxy/blob/main/sandbox/README.md',
    `- Observation rows read for the month: ${n(d.observation_rows)}`,
    '',
  ];
  return out.join('\n');
}

// ── DB 입출력 ───────────────────────────────────────

export interface MonthlyDeps {
  fetchImpl?: typeof fetch;
  pageSize?: number;
}

async function get(url: string, init: () => RequestInit, label: string, deps: MonthlyDeps): Promise<Response> {
  if (!deps.fetchImpl) return fetchRetry(url, init, label);
  const res = await deps.fetchImpl(url, init());
  if (!res.ok) throw new Error(`${label} failed: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`.trim());
  return res;
}

/** scanner_observations 를 [sinceIso, endIso) 범위에서 (observed_at, id) keyset 으로 읽어 페이지마다 onPage 에 넘긴다. 행 수를 돌려준다. */
export async function streamObservations(
  cfg: SupabaseConfig,
  sinceIso: string,
  endIso: string,
  onPage: (rows: MonthRow[]) => void,
  deps: MonthlyDeps = {},
): Promise<number> {
  const pageSize = deps.pageSize ?? 1000;
  const base = cfg.url.replace(/\/+$/, '');
  let after: { at: string; id: number } | null = null;
  let total = 0;
  for (;;) {
    const qs = new URLSearchParams();
    qs.set('select', MONTH_COLUMNS);
    qs.append('observed_at', `gte.${after ? after.at : sinceIso}`);
    qs.append('observed_at', `lt.${endIso}`);
    qs.set('source', `in.(${MONTHLY_SOURCES.join(',')})`);
    if (after) qs.set('or', `(observed_at.gt."${after.at}",and(observed_at.eq."${after.at}",id.gt.${after.id}))`);
    qs.set('order', 'observed_at.asc,id.asc');
    qs.set('limit', String(pageSize));
    const res = await get(
      `${base}/rest/v1/scanner_observations?${qs.toString()}`,
      () => ({ headers: supabaseHeaders(cfg.key, { Accept: 'application/json' }), signal: AbortSignal.timeout(30_000) }),
      'monthly observations read',
      deps,
    );
    const page = (await res.json()) as MonthRow[];
    if (!Array.isArray(page)) throw new Error('monthly observations read: unexpected response shape');
    onPage(page);
    total += page.length;
    if (page.length < pageSize) break;
    const last = page[page.length - 1];
    const at = last?.observed_at;
    const id = last?.id;
    if (typeof at !== 'string' || typeof id !== 'number') throw new Error('monthly observations read: keyset columns missing');
    if (after && at === after.at && id <= after.id) throw new Error('monthly observations read: keyset did not advance');
    after = { at, id };
  }
  return total;
}

/** registry_state 중 지워지지 않은 항목의 version·hosts (name keyset) */
export async function fetchRegistryDecls(cfg: SupabaseConfig, deps: MonthlyDeps = {}): Promise<Map<string, RegistryDecl>> {
  const pageSize = deps.pageSize ?? 1000;
  const base = cfg.url.replace(/\/+$/, '');
  const out = new Map<string, RegistryDecl>();
  let after: string | null = null;
  for (;;) {
    const qs = new URLSearchParams({ select: 'name,version,hosts', removed_at: 'is.null', order: 'name.asc', limit: String(pageSize) });
    if (after !== null) qs.set('name', `gt.${after}`);
    const res = await get(
      `${base}/rest/v1/registry_state?${qs.toString()}`,
      () => ({ headers: supabaseHeaders(cfg.key, { Accept: 'application/json' }), signal: AbortSignal.timeout(30_000) }),
      'registry_state read',
      deps,
    );
    const page = (await res.json()) as Array<{ name: string; version: string | null; hosts: string[] | null }>;
    if (!Array.isArray(page)) throw new Error('registry_state read: unexpected response shape');
    // 진행 판정은 "새 이름이 들어왔는가"로 한다. DB 정렬(콜레이션)과 JS 문자열 비교는 대소문자·기호 순서가 달라서
    // last <= after 로 비교하면 실제로는 넘어간 페이지를 멈춘 것으로 잘못 판정한다(2026-11-15 시험 실행에서 발생).
    const before = out.size;
    for (const r of page) out.set(r.name, { version: r.version ?? '', hosts: Array.isArray(r.hosts) ? r.hosts : [] });
    if (page.length < pageSize) break;
    const last = page[page.length - 1]!.name;
    if (out.size === before || last === after) throw new Error('registry_state read: keyset did not advance');
    after = last;
  }
  return out;
}

/** 행을 받지 않고 개수만 (HEAD + Prefer: count=exact → Content-Range: *\/N) */
export async function countRows(cfg: SupabaseConfig, table: string, filters: Record<string, string>, deps: MonthlyDeps = {}): Promise<number> {
  if (!/^[a-z_]{1,64}$/.test(table)) throw new Error(`bad table name: ${table}`);
  const base = cfg.url.replace(/\/+$/, '');
  const qs = new URLSearchParams({ select: '*', ...filters });
  const res = await get(
    `${base}/rest/v1/${table}?${qs.toString()}`,
    () => ({ method: 'HEAD', headers: supabaseHeaders(cfg.key, { Prefer: 'count=exact' }), signal: AbortSignal.timeout(30_000) }),
    `${table} count`,
    deps,
  );
  const m = /\/(\d+)$/.exec(res.headers.get('content-range') ?? '');
  if (!m) throw new Error(`${table} count: Content-Range missing`);
  return Number(m[1]);
}

export async function fetchCounts(cfg: SupabaseConfig, range: MonthRange, deps: MonthlyDeps = {}): Promise<CountsInput> {
  const c = (table: string, f: Record<string, string>) => countRows(cfg, table, f, deps);
  const inMonth = (col: string) => ({ and: `(${col}.gte.${range.startDay},${col}.lt.${range.endDay})` });
  const kinds = async (table: string, col: string, ks: readonly string[], key = 'kind') => {
    const out: Record<string, number> = {};
    for (const k of ks) out[k] = await c(table, { ...inMonth(col), [key]: `eq.${k}` });
    return out;
  };
  return {
    registry_changes: await kinds('registry_changes', 'detected_on', REGISTRY_KINDS),
    registry_active: await c('registry_state', { removed_at: 'is.null' }),
    registry_with_remotes: await c('registry_state', { removed_at: 'is.null', remotes_key: 'neq.' }),
    npm_changes: await kinds('npm_package_changes', 'detected_on', NPM_CHANGE_KINDS),
    npm_state: {
      found: await c('npm_package_state', { status: 'eq.found' }),
      not_found: await c('npm_package_state', { status: 'eq.not_found' }),
      deprecated: await c('npm_package_state', { status: 'eq.found', deprecated: 'is.true' }),
    },
    pypi_changes: await kinds('pypi_package_changes', 'detected_on', PYPI_CHANGE_KINDS),
    pypi_state: {
      found: await c('pypi_package_state', { status: 'eq.found' }),
      not_found: await c('pypi_package_state', { status: 'eq.not_found' }),
      archived: await c('pypi_package_state', { project_status: 'eq.archived' }),
      quarantined: await c('pypi_package_state', { project_status: 'eq.quarantined' }),
      deprecated: await c('pypi_package_state', { project_status: 'eq.deprecated' }),
    },
    notable: await kinds('scanner_notable', 'day', NOTABLE_RULES, 'rule_id'),
    sandbox: {
      versions: await c('sandbox_state', {}),
      npm: await c('sandbox_state', { registry_type: 'eq.npm' }),
      pypi: await c('sandbox_state', { registry_type: 'eq.pypi' }),
      done: await c('sandbox_state', { done: 'is.true' }),
      ok: await c('sandbox_state', { last_outcome: 'eq.ok' }),
    },
  };
}
