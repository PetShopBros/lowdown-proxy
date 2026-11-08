// 운영 요약(안정화 3단계, 2026-11-08): 워크플로·작업(job)·DB 신선도를 하루 한 번 모아 판정한다.
//   판정: ok / failing(마지막 완료 실행이 실패) / stale(마지막 성공이 허용 간격보다 오래됨) / not_seen(7일 동안 실행 없음) / error(확인 실패)
//   failing_since: 마지막 성공 뒤 첫 실패 실행 시각(워크플로·작업) 또는 last_at + 허용 간격(DB).
//   "복구 안 됨" = failing·stale 이 24시간 넘게 이어짐.
// 공개 저장소 이슈에 쓰이므로 오류 원문은 넣지 않는다(상태·시각·개수만).

export type OpsStatus = 'ok' | 'failing' | 'stale' | 'not_seen' | 'error';

export interface WorkflowCheck {
  id: string;
  kind: 'workflow' | 'job';
  workflow: string; // 파일 이름 (예: scanner.yml)
  job?: RegExp; // kind=job: 작업 이름
  /** 같은 일을 하는 단독 워크플로(수동 재실행용). 그 실행도 같은 판정에 넣는다. 예: scanner 의 report 작업 ↔ report.yml */
  alsoWorkflow?: string;
  maxAgeHours: number | null; // 마지막 성공 허용 간격. null = 실패만 본다
}

export interface DbCheck {
  id: string;
  kind: 'db';
  table: string;
  column: string;
  filter?: Record<string, string>;
  maxAgeHours: number;
}

export const WORKFLOW_CHECKS: WorkflowCheck[] = [
  { id: 'scanner/scan', kind: 'job', workflow: 'scanner.yml', job: /^scan$/, maxAgeHours: 26 },
  { id: 'scanner/report', kind: 'job', workflow: 'scanner.yml', job: /^report\b/, alsoWorkflow: 'report.yml', maxAgeHours: 26 },
  { id: 'scanner/cards', kind: 'job', workflow: 'scanner.yml', job: /^cards\b/, maxAgeHours: 8 * 24 },
  { id: 'backup', kind: 'workflow', workflow: 'backup.yml', maxAgeHours: 26 },
  { id: 'cards', kind: 'workflow', workflow: 'cards.yml', maxAgeHours: 14 },
  { id: 'npm', kind: 'workflow', workflow: 'npm.yml', maxAgeHours: 26 },
  { id: 'pypi', kind: 'workflow', workflow: 'pypi.yml', maxAgeHours: 26 },
  { id: 'notable', kind: 'workflow', workflow: 'notable.yml', maxAgeHours: 26 },
  { id: 'pages', kind: 'workflow', workflow: 'pages.yml', maxAgeHours: 26 },
  { id: 'notable-tools', kind: 'workflow', workflow: 'notable-tools.yml', maxAgeHours: 26 },
  { id: 'smoke', kind: 'workflow', workflow: 'smoke.yml', maxAgeHours: 26 },
  { id: 'sandbox-watchdog', kind: 'workflow', workflow: 'sandbox-watchdog.yml', maxAgeHours: 26 },
  { id: 'keepalive', kind: 'workflow', workflow: 'keepalive.yml', maxAgeHours: 8 * 24 },
  { id: 'test', kind: 'workflow', workflow: 'test.yml', maxAgeHours: null },
];

// 서버(Lightsail)에서 도는 것은 Actions 기록이 없다 → DB 에 마지막으로 쓴 시각으로 본다. 모두 인덱스가 있는 열(order desc limit 1).
export const DB_CHECKS: DbCheck[] = [
  { id: 'db/scanner_observations', kind: 'db', table: 'scanner_observations', column: 'observed_at', filter: { source: 'eq.scanner' }, maxAgeHours: 26 },
  { id: 'db/sandbox_runs', kind: 'db', table: 'sandbox_runs', column: 'observed_at', maxAgeHours: 26 },
  { id: 'db/sandbox_observe_runs', kind: 'db', table: 'sandbox_observe_runs', column: 'observed_at', maxAgeHours: 26 },
  { id: 'db/erc8004_cursor', kind: 'db', table: 'erc8004_cursor', column: 'updated_at', maxAgeHours: 26 },
  { id: 'db/edge_hits', kind: 'db', table: 'edge_hits', column: 'created_at', maxAgeHours: 3 },
];

export interface RunLike {
  created_at: string; // 실행(또는 작업) 시작
  completed_at: string | null;
  status: string; // completed / in_progress / queued
  conclusion: string | null; // success / failure / cancelled / skipped / timed_out / ...
}

export interface CheckRow {
  check_id: string;
  kind: 'workflow' | 'job' | 'db';
  status: OpsStatus;
  last_at: string | null;
  last_conclusion: string | null;
  last_success_at: string | null;
  failing_since: string | null;
  runs_24h: number | null;
  failures_24h: number | null;
  details: Record<string, unknown>;
}

const BAD = new Set(['failure', 'timed_out', 'startup_failure', 'action_required']);
const H = 3_600_000;

/** 워크플로·작업 실행 목록(최근 7일) → 판정. skipped·진행 중은 판정에서 뺀다. */
export function judgeRuns(check: WorkflowCheck, runs: readonly RunLike[], now: Date): CheckRow {
  const done = runs
    .filter((r) => r.status === 'completed' && r.conclusion && r.conclusion !== 'skipped' && r.conclusion !== 'neutral')
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1)); // 최신 먼저
  const t = now.getTime();
  const in24 = done.filter((r) => t - Date.parse(r.created_at) <= 24 * H);
  const lastSuccess = done.find((r) => r.conclusion === 'success') ?? null;
  const last = done[0] ?? null;
  const base = {
    check_id: check.id,
    kind: check.kind,
    last_at: last?.created_at ?? null,
    last_conclusion: last?.conclusion ?? null,
    last_success_at: lastSuccess?.completed_at ?? lastSuccess?.created_at ?? null,
    runs_24h: in24.length,
    failures_24h: in24.filter((r) => BAD.has(r.conclusion ?? '')).length,
    details: { workflow: check.workflow, runs_7d: done.length, cancelled_24h: in24.filter((r) => r.conclusion === 'cancelled').length },
  };
  if (!last) return { ...base, status: check.maxAgeHours == null ? 'not_seen' : 'stale', failing_since: null };
  // 마지막 성공 뒤의 첫 실패(가장 오래된 것)
  const afterSuccess = done.filter((r) => !lastSuccess || r.created_at > lastSuccess.created_at);
  const firstBad = [...afterSuccess].reverse().find((r) => BAD.has(r.conclusion ?? ''));
  if (BAD.has(last.conclusion ?? '')) return { ...base, status: 'failing', failing_since: firstBad?.created_at ?? last.created_at };
  if (check.maxAgeHours != null) {
    const ls = base.last_success_at ? Date.parse(base.last_success_at) : null;
    if (ls == null || t - ls > check.maxAgeHours * H) {
      return { ...base, status: 'stale', failing_since: ls == null ? (afterSuccess.at(-1)?.created_at ?? null) : new Date(ls + check.maxAgeHours * H).toISOString() };
    }
  }
  return { ...base, status: 'ok', failing_since: null };
}

export function judgeDb(check: DbCheck, lastAt: string | null, now: Date, error?: string): CheckRow {
  const base = { check_id: check.id, kind: 'db' as const, last_at: lastAt, last_conclusion: null, last_success_at: lastAt, runs_24h: null, failures_24h: null, details: { table: check.table, column: check.column, max_age_hours: check.maxAgeHours } };
  if (error) return { ...base, status: 'error', failing_since: null, details: { ...base.details, error } };
  if (!lastAt) return { ...base, status: 'stale', failing_since: null };
  const due = Date.parse(lastAt) + check.maxAgeHours * H;
  return due < now.getTime() ? { ...base, status: 'stale', failing_since: new Date(due).toISOString() } : { ...base, status: 'ok', failing_since: null };
}

/** 24시간 넘게 복구되지 않은 것. */
export function unrecovered(rows: readonly CheckRow[], now: Date): CheckRow[] {
  return rows.filter((r) => (r.status === 'failing' || r.status === 'stale') && r.failing_since && now.getTime() - Date.parse(r.failing_since) > 24 * H);
}

const kst = (iso: string | null) => (iso ? new Date(Date.parse(iso) + 9 * H).toISOString().slice(0, 16).replace('T', ' ') + ' KST' : '-');
const days = (iso: string | null, now: Date) => (iso ? Math.floor((now.getTime() - Date.parse(iso)) / (24 * H)) : null);
const MARK: Record<OpsStatus, string> = { ok: '✅ ok', failing: '❌ failing', stale: '⏰ stale', not_seen: '· not_seen', error: '⚠️ error' };

export function renderMarkdown(rows: readonly CheckRow[], now: Date): string {
  const un = unrecovered(rows, now);
  const out: string[] = [];
  out.push(`# 운영 상태 (자동 갱신)`, '', `갱신: ${kst(now.toISOString())} · ops-summary 워크플로가 매일 갱신합니다. 상태·시각·개수만 적습니다.`, '');
  out.push(`## 24시간 넘게 복구되지 않음 (${un.length})`, '');
  if (!un.length) out.push('없음', '');
  else for (const r of un) out.push(`- **${r.check_id}** — ${MARK[r.status]}, ${days(r.failing_since, now)}일째 (since ${kst(r.failing_since)}), 마지막 성공 ${kst(r.last_success_at)}`);
  if (un.length) out.push('');
  const bad = rows.filter((r) => r.status !== 'ok' && !un.includes(r));
  out.push(`## 오늘 문제 (24시간 이내) (${bad.length})`, '');
  if (!bad.length) out.push('없음', '');
  else { for (const r of bad) out.push(`- **${r.check_id}** — ${MARK[r.status]}, since ${kst(r.failing_since)}, 마지막 성공 ${kst(r.last_success_at)}`); out.push(''); }
  out.push('## 전체', '', '| 항목 | 상태 | 마지막 실행 | 마지막 성공 | 24h 실행/실패 |', '|---|---|---|---|---|');
  for (const r of rows) out.push(`| ${r.check_id} | ${MARK[r.status]} | ${kst(r.last_at)} | ${kst(r.last_success_at)} | ${r.runs_24h ?? '-'} / ${r.failures_24h ?? '-'} |`);
  out.push('');
  return out.join('\n');
}
