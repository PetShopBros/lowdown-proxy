// 운영 요약(안정화 3단계). 설계: scanner/ops-lib.ts 맨 위.
//   1) GitHub Actions: 워크플로별 최근 7일 실행(+ scanner 의 작업별 결과) → 판정
//   2) DB 신선도: 서버에서 도는 일(샌드박스·ERC-8004)과 관찰·방문 기록의 마지막 시각
//   3) ops_daily(비공개)에 오늘 날짜로 한 줄씩(같은 날 다시 돌리면 갱신), 실행 요약, 고정 이슈 "운영 상태 (자동 갱신)" 본문 갱신
// 사용: node scanner/ops-summary.ts [--dry-run]
// env: GITHUB_TOKEN, GITHUB_REPOSITORY, LOWDOWN_SUPABASE_URL, LOWDOWN_SCANNER_KEY, (GITHUB_STEP_SUMMARY)
import { appendFileSync } from 'node:fs';
import { supabaseHeaders } from './lib.ts';
import { DB_CHECKS, WORKFLOW_CHECKS, judgeDb, judgeRuns, renderMarkdown, unrecovered, type CheckRow, type RunLike } from './ops-lib.ts';

const ISSUE_TITLE = '운영 상태 (자동 갱신)';
const dryRun = process.argv.includes('--dry-run');

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} required`);
  return v;
}

async function gh<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: { authorization: `Bearer ${env('GITHUB_TOKEN')}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'lowdown-ops-summary', ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`GitHub ${init.method ?? 'GET'} ${path.split('?')[0]}: HTTP ${res.status}`);
  return (await res.json()) as T;
}

interface GhRun { id: number; created_at: string; updated_at: string; status: string; conclusion: string | null; run_started_at?: string }
interface GhJob { name: string; started_at: string | null; completed_at: string | null; status: string; conclusion: string | null }

async function main(): Promise<void> {
  const repo = env('GITHUB_REPOSITORY');
  const now = new Date();
  const since = new Date(now.getTime() - 7 * 86_400_000).toISOString().slice(0, 10);
  const rows: CheckRow[] = [];

  const runsCache = new Map<string, GhRun[]>();
  const runsOf = async (wf: string) => {
    if (!runsCache.has(wf)) {
      const r = await gh<{ workflow_runs: GhRun[] }>(`/repos/${repo}/actions/workflows/${wf}/runs?created=%3E%3D${since}&per_page=100`);
      runsCache.set(wf, r.workflow_runs);
    }
    return runsCache.get(wf)!;
  };
  const jobsCache = new Map<number, GhJob[]>();
  const jobsOf = async (runId: number) => {
    if (!jobsCache.has(runId)) jobsCache.set(runId, (await gh<{ jobs: GhJob[] }>(`/repos/${repo}/actions/runs/${runId}/jobs?per_page=100`)).jobs);
    return jobsCache.get(runId)!;
  };

  for (const c of WORKFLOW_CHECKS) {
    try {
      const runs = await runsOf(c.workflow);
      let list: RunLike[];
      if (c.kind === 'job') {
        list = [];
        for (const r of runs.filter((x) => x.status === 'completed')) {
          for (const j of await jobsOf(r.id)) if (c.job!.test(j.name)) list.push({ created_at: j.started_at ?? r.created_at, completed_at: j.completed_at, status: j.status, conclusion: j.conclusion });
        }
      } else {
        list = runs.map((r) => ({ created_at: r.run_started_at ?? r.created_at, completed_at: r.status === 'completed' ? r.updated_at : null, status: r.status, conclusion: r.conclusion }));
      }
      if (c.alsoWorkflow) {
        // workflow_call 로 불린 실행은 호출한 쪽(scanner)에만 잡힌다 → 여기는 단독(수동) 실행만 더한다
        for (const r of await runsOf(c.alsoWorkflow)) list.push({ created_at: r.run_started_at ?? r.created_at, completed_at: r.status === 'completed' ? r.updated_at : null, status: r.status, conclusion: r.conclusion });
      }
      rows.push(judgeRuns(c, list, now));
    } catch (e) {
      rows.push({ check_id: c.id, kind: c.kind, status: 'error', last_at: null, last_conclusion: null, last_success_at: null, failing_since: null, runs_24h: null, failures_24h: null, details: { workflow: c.workflow, error: e instanceof Error ? e.message : String(e) } });
    }
  }

  const url = env('LOWDOWN_SUPABASE_URL').replace(/\/+$/, '');
  const key = env('LOWDOWN_SCANNER_KEY');
  for (const c of DB_CHECKS) {
    try {
      const qs = new URLSearchParams({ select: c.column, order: `${c.column}.desc`, limit: '1', ...(c.filter ?? {}) });
      const res = await fetch(`${url}/rest/v1/${c.table}?${qs}`, { headers: supabaseHeaders(key, { Accept: 'application/json' }), signal: AbortSignal.timeout(30_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = (await res.json()) as Array<Record<string, string>>;
      rows.push(judgeDb(c, j[0]?.[c.column] ?? null, now));
    } catch (e) {
      rows.push(judgeDb(c, null, now, e instanceof Error ? e.message : String(e)));
    }
  }

  const md = renderMarkdown(rows, now);
  console.log(md);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
  for (const r of unrecovered(rows, now)) console.log(`::warning::unrecovered >24h: ${r.check_id} (${r.status} since ${r.failing_since})`);
  if (dryRun) return;

  // ops_daily(비공개): 같은 날 다시 돌리면 갱신
  const day = now.toISOString().slice(0, 10);
  const body = rows.map((r) => ({ day, ...r, computed_at: now.toISOString() }));
  const up = await fetch(`${url}/rest/v1/ops_daily?on_conflict=day,check_id`, {
    method: 'POST',
    headers: supabaseHeaders(key, { 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' }),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  if (!up.ok) throw new Error(`ops_daily write failed: HTTP ${up.status} ${(await up.text()).slice(0, 300)}`);

  // 고정 이슈 하나를 매일 갱신(없으면 만든다)
  const open = await gh<Array<{ number: number; title: string; pull_request?: unknown }>>(`/repos/${repo}/issues?state=open&per_page=100`);
  const existing = open.find((i) => !i.pull_request && i.title === ISSUE_TITLE);
  if (existing) await gh(`/repos/${repo}/issues/${existing.number}`, { method: 'PATCH', body: JSON.stringify({ body: md }) });
  else await gh(`/repos/${repo}/issues`, { method: 'POST', body: JSON.stringify({ title: ISSUE_TITLE, body: md }) });
  console.log(`ops_daily: ${rows.length} rows (${day}), issue ${existing ? `#${existing.number} updated` : 'created'}`);
}

main().catch((e: unknown) => {
  console.error(`::error::${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
