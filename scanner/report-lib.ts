// Lowdown Scanner 공개 리포트 (REPORT.md) 생성 로직 — 의존성 0
// 원칙: 최신 run 을 메모리에서 집계하고, 출력에는 집계값만 쓴다. 개별 서버 이름·점수·순위·판정 라벨은 쓰지 않는다.
// 분모를 섞지 않는다: 코호트 크기 / 관찰 대상 수 / 관찰 행 수 / 호출하지 않은 행(blocked_url) / 프로브 시도 수.

import { supabaseHeaders } from './lib.ts';
import type { SupabaseConfig } from './lib.ts';

export interface ReportRow {
  id: number;
  scan_run_id: string;
  target_id: string;
  observed_at: string;
  http_status: number | null;
  reached_level: number;
  error_type: string | null;
  cohort_version: string | null;
}

export const REPORT_COLUMNS = 'id,scan_run_id,target_id,observed_at,http_status,reached_level,error_type,cohort_version:metadata->>cohort_version';
/** 최신 run 이 코호트의 이 비율보다 적게 관찰했으면 부분 실행(--limit 수동 실행 등)으로 보고 리포트를 만들지 않는다. */
export const MIN_RUN_COVERAGE = 0.5;
export const TREND_RUNS = 7;
export const WINDOW_DAYS = 8;

export interface ReportFetchDeps {
  fetchImpl?: typeof fetch;
  pageSize?: number;
}

/** since 이후 행을 id 오름차순 keyset 으로 읽는다 (집계에 필요한 열만). */
export async function fetchReportRows(cfg: SupabaseConfig, sinceIso: string, deps: ReportFetchDeps = {}): Promise<ReportRow[]> {
  const f = deps.fetchImpl ?? fetch;
  const pageSize = deps.pageSize ?? 1000;
  const base = cfg.url.replace(/\/+$/, '');
  const rows: ReportRow[] = [];
  let lastId = 0;
  for (;;) {
    const qs = new URLSearchParams();
    qs.set('select', REPORT_COLUMNS);
    qs.set('observed_at', `gte.${sinceIso}`);
    qs.set('id', `gt.${lastId}`);
    qs.set('order', 'id.asc');
    qs.set('limit', String(pageSize));
    const res = await f(`${base}/rest/v1/scanner_observations?${qs.toString()}`, {
      headers: supabaseHeaders(cfg.key, { Accept: 'application/json' }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`report read failed: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`.trim());
    const page = (await res.json()) as ReportRow[];
    if (!Array.isArray(page)) throw new Error('report read: unexpected response shape');
    rows.push(...page);
    if (page.length < pageSize) break;
    const last = page[page.length - 1]?.id;
    if (typeof last !== 'number' || last <= lastId) throw new Error('report read: id keyset did not advance');
    lastId = last;
  }
  return rows;
}

/** 가장 오래된 관찰 시각. 없으면 null. */
export async function fetchFirstObservedAt(cfg: SupabaseConfig, deps: ReportFetchDeps = {}): Promise<string | null> {
  const f = deps.fetchImpl ?? fetch;
  const base = cfg.url.replace(/\/+$/, '');
  const qs = new URLSearchParams({ select: 'observed_at', order: 'observed_at.asc', limit: '1' });
  const res = await f(`${base}/rest/v1/scanner_observations?${qs.toString()}`, {
    headers: supabaseHeaders(cfg.key, { Accept: 'application/json' }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`report read failed: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`.trim());
  const page = (await res.json()) as Array<{ observed_at?: unknown }>;
  const v = Array.isArray(page) ? page[0]?.observed_at : undefined;
  return typeof v === 'string' ? v : null;
}

// ─────────────────────────────────────────────
// 집계 (순수 함수)
// ─────────────────────────────────────────────

export interface RunSummary {
  run_id: string;
  started_at: string;
  ended_at: string;
  rows: number;
  targets: number;
  not_called: number;
  probe_attempts: number;
  reached_level_2_rows: number;
}

export interface Distribution {
  key: string;
  count: number;
}

export interface ReportData {
  generated_at: string;
  data_as_of: string;
  first_observed_at: string | null;
  cohort_version: string;
  cohort_size: number;
  latest: RunSummary;
  cohort_unobserved: number;
  reached_level: Record<'0' | '1' | '2', number>;
  http_status: Distribution[];
  error_type: Distribution[];
  trend: RunSummary[];
}

function groupRuns(rows: readonly ReportRow[]): Map<string, ReportRow[]> {
  const m = new Map<string, ReportRow[]>();
  for (const r of rows) {
    const g = m.get(r.scan_run_id);
    if (g) g.push(r);
    else m.set(r.scan_run_id, [r]);
  }
  return m;
}

function bounds(rows: readonly ReportRow[]): { min: string; max: string } {
  let min = rows[0]!.observed_at;
  let max = rows[0]!.observed_at;
  for (const r of rows) {
    if (r.observed_at < min) min = r.observed_at;
    if (r.observed_at > max) max = r.observed_at;
  }
  return { min, max };
}

export function summarizeRun(runId: string, rows: readonly ReportRow[]): RunSummary {
  const b = bounds(rows);
  const notCalled = rows.filter((r) => r.error_type === 'blocked_url').length;
  return {
    run_id: runId,
    started_at: b.min,
    ended_at: b.max,
    rows: rows.length,
    targets: new Set(rows.map((r) => r.target_id)).size,
    not_called: notCalled,
    probe_attempts: rows.length - notCalled,
    reached_level_2_rows: rows.filter((r) => r.reached_level === 2).length,
  };
}

/** 가장 최근에 관찰이 끝난 run 과 그 run 의 코호트 버전(최빈값). 행이 없으면 null. */
export function latestRun(rows: readonly ReportRow[]): { runId: string; rows: ReportRow[]; cohortVersion: string | null } | null {
  let best: { runId: string; rows: ReportRow[]; max: string } | null = null;
  for (const [runId, g] of groupRuns(rows)) {
    const { max } = bounds(g);
    if (!best || max > best.max) best = { runId, rows: g, max };
  }
  if (!best) return null;
  const counts = new Map<string, number>();
  for (const r of best.rows) if (r.cohort_version) counts.set(r.cohort_version, (counts.get(r.cohort_version) ?? 0) + 1);
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
  return { runId: best.runId, rows: best.rows, cohortVersion: top?.[0] ?? null };
}

// 외부(원격 서버·DB)에서 온 문자열이 공개 문서에 그대로 나가지 않도록 허용 형식만 통과시킨다.
function statusKey(s: number | null): string {
  if (s === null || s === undefined) return 'no HTTP response';
  return Number.isInteger(s) && s >= 100 && s <= 599 ? String(s) : 'other';
}

function errorKey(e: string | null): string {
  if (e === null || e === undefined) return 'none';
  return /^[a-z_]{1,32}$/.test(e) ? e : 'other';
}

function distribution(keys: string[]): Distribution[] {
  const m = new Map<string, number>();
  for (const k of keys) m.set(k, (m.get(k) ?? 0) + 1);
  return [...m.entries()].map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}

export function buildReport(
  rows: readonly ReportRow[],
  cohortIds: readonly string[],
  cohortVersion: string,
  firstObservedAt: string | null,
  now: Date,
): ReportData {
  const latest = latestRun(rows);
  if (!latest) throw new Error('관찰 행이 없어 리포트를 만들 수 없습니다.');
  if (cohortIds.length === 0) throw new Error(`코호트 ${cohortVersion} 가 비어 있습니다.`);
  const cohort = new Set(cohortIds);
  const summary = summarizeRun(latest.runId, latest.rows);
  if (summary.targets < Math.ceil(cohort.size * MIN_RUN_COVERAGE)) {
    throw new Error(`최신 run 이 코호트의 ${Math.round(MIN_RUN_COVERAGE * 100)}% 미만만 관찰했습니다 (${summary.targets}/${cohort.size}). 부분 실행으로 보고 리포트를 만들지 않습니다.`);
  }

  const seen = new Set(latest.rows.map((r) => r.target_id));
  let unobserved = 0;
  for (const id of cohort) if (!seen.has(id)) unobserved++;

  // 분포는 실제로 호출한 행(프로브 시도)만 대상으로 한다. blocked_url 은 호출하지 않았으므로 제외.
  const attempts = latest.rows.filter((r) => r.error_type !== 'blocked_url');
  const reached: Record<'0' | '1' | '2', number> = { '0': 0, '1': 0, '2': 0 };
  for (const r of attempts) {
    if (r.reached_level === 0 || r.reached_level === 1 || r.reached_level === 2) reached[String(r.reached_level) as '0' | '1' | '2']++;
  }

  const runs = [...groupRuns(rows)].map(([id, g]) => summarizeRun(id, g)).sort((a, b) => a.ended_at.localeCompare(b.ended_at));

  return {
    generated_at: now.toISOString(),
    data_as_of: summary.ended_at,
    first_observed_at: firstObservedAt,
    cohort_version: cohortVersion,
    cohort_size: cohort.size,
    latest: summary,
    cohort_unobserved: unobserved,
    reached_level: reached,
    http_status: distribution(attempts.map((r) => statusKey(r.http_status))),
    error_type: distribution(attempts.map((r) => errorKey(r.error_type))),
    trend: runs.slice(-TREND_RUNS),
  };
}

// ─────────────────────────────────────────────
// Markdown 렌더링
// ─────────────────────────────────────────────

const n = (v: number): string => v.toLocaleString('en-US');

function utc(iso: string): string {
  return `${new Date(iso).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

function kst(iso: string): string {
  const d = new Date(new Date(iso).getTime() + 9 * 3_600_000);
  return `${d.toISOString().slice(0, 16).replace('T', ' ')} KST`;
}

function day(iso: string): string {
  return new Date(iso).toISOString().slice(0, 10);
}

function table(headers: string[], body: string[][]): string {
  return [`| ${headers.join(' | ')} |`, `|${headers.map(() => '---').join('|')}|`, ...body.map((r) => `| ${r.join(' | ')} |`)].join('\n');
}

export function renderReport(d: ReportData): string {
  const size = n(d.cohort_size);
  const attempts = d.latest.probe_attempts;
  const period = d.first_observed_at ? `${day(d.first_observed_at)} to ${day(d.data_as_of)} (UTC)` : 'not available';

  const lines = [
    `# Lowdown Scanner Report: MCP Registry reachability observations`,
    ``,
    `- **Data as of:** ${utc(d.data_as_of)} (${kst(d.data_as_of)}), the end of the most recent Scanner run`,
    `- **Report generated:** ${utc(d.generated_at)}`,
    `- **Observation period:** ${period}`,
    ``,
    `Lowdown Scanner observes ${size} MCP Registry entries every day and records MCP initialize and tools/list reachability, HTTP status, latency, and tool-count changes. This report summarizes the most recent run. The ${size} entries are a fixed sample (cohort \`${d.cohort_version}\`) selected once from the official MCP Registry and unchanged since; they are Registry entries, not operators, and they do not represent the whole Registry.`,
    ``,
    `## Scope and limits`,
    ``,
    `- The Scanner sends \`initialize\` and \`tools/list\` only. It never calls a tool and does not authenticate. A \`401\` or \`403\` is recorded as the HTTP status that was observed; it is not classified as success or failure.`,
    `- Each entry is observed once per day from a single network location (GitHub Actions). These counts describe single probes, not availability or uptime.`,
    `- \`reached_level 2\` means the probe completed \`initialize\` and \`tools/list\` at that moment. It does not mean a tool executed successfully.`,
    `- Cohort entries with no observation row in a run are counted separately and are not recorded as failures.`,
    `- This report contains no scores, rankings, labels, or individual server names.`,
    ``,
    `## Latest run`,
    ``,
    table(
      ['Measure', 'Count'],
      [
        [`Cohort entries (fixed sample, \`${d.cohort_version}\`)`, size],
        ['Cohort entries with at least one observation row in this run', n(d.cohort_size - d.cohort_unobserved)],
        ['Cohort entries with no observation row in this run', n(d.cohort_unobserved)],
        ['Observation rows in this run (an entry with several remotes has several rows)', n(d.latest.rows)],
        ['Rows where the Scanner did not call the URL (blocked by its safety checks)', n(d.latest.not_called)],
        ['Probe attempts (observation rows minus rows not called)', n(attempts)],
      ],
    ),
    ``,
    `## Reach level of probe attempts`,
    ``,
    table(
      ['reached_level', 'Meaning', `Count (of ${n(attempts)} probe attempts)`],
      [
        ['2', 'initialize and tools/list completed', n(d.reached_level['2'])],
        ['1', 'initialize completed; tools/list did not', n(d.reached_level['1'])],
        ['0', 'initialize did not complete', n(d.reached_level['0'])],
      ],
    ),
    ``,
    `## HTTP status of probe attempts`,
    ``,
    table(['HTTP status', `Count (of ${n(attempts)})`], d.http_status.map((x) => [x.key, n(x.count)])),
    ``,
    `## Error types of probe attempts`,
    ``,
    table(['error_type', `Count (of ${n(attempts)})`], d.error_type.map((x) => [x.key, n(x.count)])),
    ``,
    `## Last ${d.trend.length} runs`,
    ``,
    table(
      ['Run date (UTC)', 'Observation rows', 'Entries with a row', 'Rows with reached_level 2'],
      d.trend.map((r) => [day(r.started_at), n(r.rows), n(r.targets), n(r.reached_level_2_rows)]),
    ),
    ``,
    `## Data`,
    ``,
    `Raw per-observation records are exported weekly as CSV in \`scanner_observations/\` in this repository. This report is regenerated from the database after each daily run.`,
    ``,
  ];
  return lines.join('\n');
}