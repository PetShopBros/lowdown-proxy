// Lowdown MCP Scanner — 일 1회 실행 진입점
//   Registry → active && isLatest → streamable-http remote → SSRF 검증 → initialize → tools/list → scanner_observations
//
// 필수 환경변수(dry-run 이면 불필요): LOWDOWN_SUPABASE_URL, LOWDOWN_SCANNER_KEY(scanner 전용 service key), LOWDOWN_NODE_ID
// 선택: DRY_RUN=1 또는 --dry-run, SCAN_LIMIT=<N> 또는 --limit=<N>, SCAN_CONCURRENCY=<N, 기본 8>, REGISTRY_URL
//       COHORT_VERSION(기본 2026-10-07-v1), COHORT_SIZE(기본 2000)
//       SKIP_IF_DONE=1 — 예비 실행용. 오늘(UTC) 관찰이 코호트 절반 이상 있으면 아무것도 하지 않고 끝낸다
//       RETRY_FAILED=0 — 직후 재시도 끄기(기본 켜짐). RETRY_DELAY_SEC(기본 60), RETRY_BUDGET_SEC(기본 720)
// 직후 재시도: 메인 probe 후 일시적일 수 있는 실패(timeout/연결 실패/408/429/5xx)만 호스트당 1건씩 다시 시도해
//         같은 행의 metadata.retry 에 덧붙인다. 첫 시도 값은 바꾸지 않는다. 시간 예산을 넘긴 행은 retry 없이 남긴다.
// 코호트: 해당 버전의 scanner_cohort 가 비어 있으면(Day 0) Registry 의 probe 가능 target 을 SHA-256 순으로 COHORT_SIZE 개 확정·저장하고,
//         이후에는 저장된 같은 대상만 관찰한다(remote URL 만 매번 최신 Registry 값). dry-run 은 저장하지 않는다.
// target_id 는 기존 Lowdown 표기와 맞춰 `mcp:` + Registry 이름 (예: mcp:io.github.user/server)

import { randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import {
  attachRetry,
  DEFAULT_COHORT_SIZE,
  DEFAULT_COHORT_VERSION,
  DEFAULT_REGISTRY_URL,
  countObservationsSince,
  fetchCohort,
  fetchRegistryTargets,
  hostOf,
  insertCohortGaps,
  insertObservations,
  isRetryable,
  MAX_COHORT_SIZE,
  planCohortJobs,
  probeRemote,
  runPerHostRoundRobin,
  runPool,
  saveCohort,
  selectCohort,
  utcDayStart,
} from './lib.ts';
import type { CohortGapRow, ObservationRow, ProbeResult, RetryInfo } from './lib.ts';

function fail(message: string): never {
  console.error(`::error::${message}`);
  process.exit(1);
}

function requireEnv(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) fail(`환경변수 ${name} 가 없습니다. GitHub Secrets 설정을 확인하세요.`);
  return v;
}

function envSeconds(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!(n >= 0)) throw new Error(`${name} 값이 올바르지 않습니다: ${raw}`);
  return n;
}

function count<T extends string | number | null>(values: T[]): Array<[string, number]> {
  const m = new Map<string, number>();
  for (const v of values) m.set(String(v), (m.get(String(v)) ?? 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}

function summarize(rows: ObservationRow[], runId: string, extra: Record<string, unknown>): string {
  const lines = [
    `## Lowdown Scanner run`,
    ``,
    `- scan_run_id: \`${runId}\``,
    `- observations: ${rows.length}`,
    ...Object.entries(extra).map(([k, v]) => `- ${k}: ${String(v)}`),
    ``,
    `| reached_level | n |`,
    `|---|---|`,
    ...count(rows.map((r) => r.reached_level)).map(([k, n]) => `| ${k} | ${n} |`),
    ``,
    `| http_status | n |`,
    `|---|---|`,
    ...count(rows.map((r) => r.http_status)).map(([k, n]) => `| ${k} | ${n} |`),
    ``,
    `| error_type | n |`,
    `|---|---|`,
    ...count(rows.map((r) => r.error_type)).map(([k, n]) => `| ${k} | ${n} |`),
    ``,
  ];
  return lines.join('\n');
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = process.env.DRY_RUN === '1' || args.includes('--dry-run');
  const limitArg = args.find((a) => a.startsWith('--limit='))?.slice('--limit='.length);
  const limitRaw = (limitArg ?? process.env.SCAN_LIMIT)?.trim();
  const limit = limitRaw ? Number.parseInt(limitRaw, 10) : undefined;
  if (limitRaw && !(limit && limit > 0)) fail(`SCAN_LIMIT 값이 올바르지 않습니다: ${limitRaw}`);
  const concurrency = Number.parseInt(process.env.SCAN_CONCURRENCY?.trim() || '8', 10);
  if (!(concurrency > 0)) fail('SCAN_CONCURRENCY 값이 올바르지 않습니다.');

  const cohortVersion = process.env.COHORT_VERSION?.trim() || DEFAULT_COHORT_VERSION;
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(cohortVersion)) fail(`COHORT_VERSION 값이 올바르지 않습니다: ${cohortVersion}`);
  const cohortSizeRaw = process.env.COHORT_SIZE?.trim() || String(DEFAULT_COHORT_SIZE);
  const cohortSize = Number.parseInt(cohortSizeRaw, 10);
  if (!(cohortSize >= 1 && cohortSize <= MAX_COHORT_SIZE)) fail(`COHORT_SIZE 는 1~${MAX_COHORT_SIZE} 사이여야 합니다: ${cohortSizeRaw}`);

  // Supabase 설정: 실제 실행은 필수, dry-run 은 있으면 저장된 코호트를 읽기만 한다(쓰지 않음)
  let supabase: { url: string; key: string } | undefined;
  let nodeId = process.env.LOWDOWN_NODE_ID?.trim() || 'dry-run';
  const envUrl = process.env.LOWDOWN_SUPABASE_URL?.trim();
  const envKey = process.env.LOWDOWN_SCANNER_KEY?.trim();
  if (!dryRun) {
    const url = requireEnv('LOWDOWN_SUPABASE_URL');
    const key = requireEnv('LOWDOWN_SCANNER_KEY');
    nodeId = requireEnv('LOWDOWN_NODE_ID');
    if (!/^ld_[A-Za-z0-9_-]+$/.test(nodeId)) fail('LOWDOWN_NODE_ID 형식이 올바르지 않습니다 (ld_... 형식).');
    try {
      if (new URL(url).protocol !== 'https:') fail('LOWDOWN_SUPABASE_URL 은 https 여야 합니다.');
    } catch {
      fail('LOWDOWN_SUPABASE_URL 이 올바른 URL 이 아닙니다.');
    }
    supabase = { url, key };
  }
  const cohortReadCfg = supabase ?? (envUrl && envKey ? { url: envUrl, key: envKey } : undefined);

  // 예비 실행(SKIP_IF_DONE=1): 오늘(UTC) 이미 코호트 절반 이상 관찰했으면 건너뛴다.
  // 본 실행이 지연·누락됐을 때만 채우기 위함. 확인 자체가 실패하면 실행한다(빠지는 날보다 중복이 낫다).
  if (supabase && process.env.SKIP_IF_DONE === '1') {
    const since = utcDayStart(new Date());
    try {
      const done = await countObservationsSince(supabase, since);
      if (done >= Math.ceil(cohortSize / 2)) {
        console.log(`skip: ${since} 이후 관찰 ${done}행 — 오늘 본 실행이 이미 끝남`);
        return;
      }
      console.log(`backup run: ${since} 이후 관찰 ${done}행 — 오늘 본 실행이 없어서 실행`);
    } catch (e) {
      console.error(`오늘 관찰 확인 실패(그래도 실행): ${e instanceof Error ? e.message : 'unknown'}`);
    }
  }

  const runId = randomUUID();
  const registryUrl = process.env.REGISTRY_URL?.trim() || DEFAULT_REGISTRY_URL;
  console.log(`scan_run_id=${runId} dry_run=${dryRun} registry=${registryUrl}`);

  // 1) Registry 수집 (실패하면 명확하게 실패)
  const { targets, stats, registryInfo } = await fetchRegistryTargets({ baseUrl: registryUrl });
  console.log('registry stats', JSON.stringify(stats));
  if (targets.length === 0) fail('Registry 에서 probe 가능한 대상이 0개입니다 (응답 형식 변경 가능성).');

  // 2) 코호트 확정/로드 → probe 작업 목록
  let cohortIds: string[] = [];
  let cohortCreated = false;
  let cohortSource = 'none';
  if (cohortReadCfg) {
    cohortIds = await fetchCohort(cohortReadCfg, cohortVersion); // 읽기 실패 시 throw — 조용히 새 코호트를 만들지 않는다
    cohortSource = 'stored';
  }
  if (cohortIds.length === 0) {
    cohortIds = selectCohort(targets.map((t) => `mcp:${t.name}`), cohortSize);
    cohortCreated = true;
    cohortSource = supabase ? 'created' : 'preview';
    if (supabase) {
      await saveCohort(supabase, cohortVersion, cohortIds);
      console.log(`cohort ${cohortVersion} created: ${cohortIds.length} targets (Day 0)`);
    } else {
      console.log(`cohort ${cohortVersion} preview (not saved): ${cohortIds.length} targets`);
    }
  }
  const plan = planCohortJobs(targets, cohortIds, registryInfo);
  let jobs = plan.jobs;
  if (jobs.length === 0) fail('코호트에서 probe 할 remote 가 0개입니다 (Registry 와 코호트가 맞지 않음).');
  const gapReasonCounts = Object.fromEntries(count(plan.gaps.map((g) => g.reason)));
  const cohortInfo = {
    cohort_version: cohortVersion,
    cohort_source: cohortSource,
    cohort_created: cohortCreated,
    cohort_size: cohortIds.length,
    cohort_missing: plan.gaps.length,
    cohort_gap_reasons: JSON.stringify(gapReasonCounts),
  };
  console.log('cohort', JSON.stringify(cohortInfo));

  // 사유 분리 저장: probe 와 무관하므로 먼저 저장한다. 실패해도 probe 는 계속 진행한다(관측 본체가 우선).
  if (supabase && plan.gaps.length > 0) {
    const gapObservedAt = new Date().toISOString();
    const gapRows: CohortGapRow[] = plan.gaps.map((g) => ({ ...g, scan_run_id: runId, cohort_version: cohortVersion, observed_at: gapObservedAt }));
    try {
      await insertCohortGaps(gapRows, supabase);
      console.log(`cohort gaps saved: ${gapRows.length}`);
    } catch (e) {
      console.error(`cohort gaps 저장 실패(계속 진행): ${e instanceof Error ? e.message : 'unknown'}`);
    }
  }

  if (limit) jobs = jobs.slice(0, limit);
  console.log(`probing ${jobs.length} remotes (concurrency=${concurrency})`);

  // 3) 청크 단위 probe → 즉시 저장 (중간 실패해도 앞선 데이터 보존)
  const CHUNK = 80;
  const all: ObservationRow[] = [];
  let inserted = 0;
  for (let i = 0; i < jobs.length; i += CHUNK) {
    const chunk = jobs.slice(i, i + CHUNK);
    const rows = await runPool(chunk, concurrency, async (job): Promise<ObservationRow> => {
      const observedAt = new Date().toISOString();
      try {
        const p = await probeRemote(job.remote, { registryVersion: job.version, index: job.index });
        return {
          scan_run_id: runId,
          node_id: nodeId,
          target_id: `mcp:${job.name}`,
          target_type: 'mcp_server',
          observed_at: observedAt,
          source: 'scanner',
          ...p,
          metadata: { ...p.metadata, cohort_version: cohortVersion },
        };
      } catch (e) {
        console.error(`unexpected probe error for ${job.name}: ${e instanceof Error ? e.message : 'unknown'}`);
        return {
          scan_run_id: runId,
          node_id: nodeId,
          target_id: `mcp:${job.name}`,
          target_type: 'mcp_server',
          observed_at: observedAt,
          source: 'scanner',
          transport: job.remote.type,
          http_status: null,
          reached_level: 0,
          latency_ms: null,
          error_type: 'network_error',
          metadata: { remote_url: job.remote.url, remote_index: job.index, registry_version: job.version, internal_error: true, cohort_version: cohortVersion },
        };
      }
    });
    all.push(...rows);
    if (supabase) {
      inserted += await insertObservations(rows, supabase);
      console.log(`inserted ${inserted}/${jobs.length}`);
    }
  }

  // 4) 직후 재시도 (실패해도 본 데이터에는 영향 없음)
  let retryStats: Record<string, number | string> = {};
  try {
    retryStats = await retryFailed(all, { supabase, concurrency });
  } catch (e) {
    console.error(`retry 단계 실패(관찰 데이터는 저장 완료): ${e instanceof Error ? e.message : 'unknown'}`);
    retryStats = { retry: 'error' };
  }

  const summary = summarize(all, runId, { dry_run: dryRun, inserted, ...cohortInfo, ...stats, ...retryStats });
  console.log(summary);
  if (dryRun) {
    console.log('sample rows:');
    for (const r of all.slice(0, 5)) console.log(JSON.stringify(r));
  }
  const summaryFile = process.env.GITHUB_STEP_SUMMARY;
  if (summaryFile) appendFileSync(summaryFile, `${summary}\n`);
  // 전체 관찰을 실제로 저장했을 때만 report job 이 돈다(scanner.yml: needs.scan.outputs.scanned). 샘플(limit)·dry-run·건너뛴 예비 실행은 제외
  const outputFile = process.env.GITHUB_OUTPUT;
  if (outputFile && !dryRun && !limit && inserted > 0) appendFileSync(outputFile, 'scanned=1\n');
}

async function retryFailed(
  rows: ObservationRow[],
  opts: { supabase: { url: string; key: string } | undefined; concurrency: number },
): Promise<Record<string, number | string>> {
  if (process.env.RETRY_FAILED?.trim() === '0') return { retry: 'off' };
  const candidates = rows.filter((r) => isRetryable(r) && typeof r.metadata.remote_url === 'string');
  if (candidates.length === 0) return { retry_candidates: 0 };
  const delaySec = envSeconds('RETRY_DELAY_SEC', 60);
  const budgetSec = envSeconds('RETRY_BUDGET_SEC', 720);
  console.log(`retry: ${candidates.length} candidates, wait ${delaySec}s, budget ${budgetSec}s`);
  await new Promise<void>((r) => setTimeout(r, delaySec * 1000));

  const deadline = Date.now() + budgetSec * 1000;
  const { results, skipped } = await runPerHostRoundRobin(
    candidates,
    (r) => hostOf(r.metadata.remote_url as string),
    opts.concurrency,
    async (r): Promise<RetryInfo> => {
      const retriedAt = new Date().toISOString();
      let p: Pick<ProbeResult, 'reached_level' | 'http_status' | 'error_type' | 'latency_ms'>;
      try {
        p = await probeRemote(
          { type: r.transport, url: r.metadata.remote_url as string },
          { registryVersion: String(r.metadata.registry_version ?? ''), index: Number(r.metadata.remote_index ?? 0) },
        );
      } catch {
        p = { reached_level: 0, http_status: null, error_type: 'network_error', latency_ms: null };
      }
      return {
        retried_at: retriedAt,
        reached_level: p.reached_level,
        http_status: p.http_status,
        error_type: p.error_type,
        latency_ms: p.latency_ms,
        per_host_concurrency: 1,
      };
    },
    { deadline },
  );

  const recovered = results.filter(({ item, result }) => result.reached_level > item.reached_level).length;
  let attached = 0;
  let attachFailed = 0;
  if (opts.supabase) {
    const cfg = opts.supabase;
    await runPool(results, 4, async ({ item, result }) => {
      try {
        const ok = await attachRetry(
          cfg,
          { scan_run_id: item.scan_run_id, target_id: item.target_id, remote_url: item.metadata.remote_url as string },
          result,
        );
        if (ok) attached++;
      } catch (e) {
        attachFailed++;
        if (attachFailed <= 3) console.error(`retry 저장 실패(계속 진행): ${e instanceof Error ? e.message : 'unknown'}`);
      }
    });
  }
  const out = {
    retry_candidates: candidates.length,
    retry_done: results.length,
    retry_recovered: recovered,
    retry_skipped_budget: skipped.length,
    retry_attached: attached,
    retry_attach_failed: attachFailed,
  };
  console.log('retry', JSON.stringify(out));
  return out;
}

main().catch((e: unknown) => {
  fail(e instanceof Error ? e.message : 'scanner failed');
});
