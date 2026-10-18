// Lowdown MCP Scanner — 일 1회 실행 진입점
//   Registry → active && isLatest → streamable-http remote → SSRF 검증 → initialize → tools/list → scanner_observations
//
// 필수 환경변수(dry-run 이면 불필요): LOWDOWN_SUPABASE_URL, LOWDOWN_SCANNER_KEY(scanner 전용 service key), LOWDOWN_NODE_ID
// 선택: DRY_RUN=1 또는 --dry-run, SCAN_LIMIT=<N> 또는 --limit=<N>, SCAN_CONCURRENCY=<N, 기본 8>, REGISTRY_URL
//       COHORT_VERSION(기본 2026-10-07-v1), COHORT_SIZE(기본 2000)
//       COHORT_BASE — 확장 코호트의 기준 버전(예: 2026-10-07-v1). 설정하면 Day 0 에 base 전부 + 추가분으로 만들고,
//         base 멤버 행에는 metadata.cohort_versions = [base, version] 을 남겨 base 시계열을 이어 볼 수 있게 한다.
//       COHORT_HOST_CAP=<N> — 확장 코호트 Day 0 선정 시 호스트당 대상 상한(base 멤버를 먼저 센다). 0/미설정 = 상한 없음
//       REGISTRY_DIFF=1 — 시장판 1단계: 관찰 뒤 Registry 선언 변화를 registry_state/registry_changes 에 기록(probe 없음).
//         첫 실행은 baseline(이벤트 없음). fallback 날은 건너뜀. dry-run 은 읽고 계산만 한다. 실패해도 관찰 데이터와 무관
//       PLAN_ONLY=1 또는 --plan-only — Registry 수신 + 선정 계산만 하고 끝낸다(probe·저장 없음). COHORT_BASE 필요
//         PLAN_CAPS(기본 0,3,5,10) 의 상한별로 추가분 수·미달·상한 탈락·고유 호스트·상위 호스트 비중을 출력한다
//       SKIP_IF_DONE=1 — 예비 실행용. 오늘(UTC) 관찰이 코호트 절반 이상 있으면 아무것도 하지 않고 끝낸다
//       REGISTRY_BUDGET_SEC(기본 480) — Registry 목록 받기 시간 상한. 넘기거나 실패하면 직전 관찰 실행의 원격 주소로 같은 코호트를 관찰
//         (행에 metadata.registry_fallback=true, registry_snapshot_run, registry_snapshot_at 기록)
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
  capHost,
  extendCohort,
  extendCohortCapped,
  hostConcentration,
  topHosts,
  fetchCohort,
  fetchFallbackJobs,
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
  SCANNER_VERSION,
  scannerCommit,
  selectCohort,
  utcDayStart,
} from './lib.ts';
import { diffRegistry, fetchRegistryState, insertRegistryChanges, upsertRegistryState } from './registry-diff.ts';
import type { CohortGap, CohortGapRow, CohortJob, ObservationRow, ProbeResult, RetryInfo } from './lib.ts';

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
  const planOnlyFlag = process.env.PLAN_ONLY === '1' || args.includes('--plan-only');
  const dryRun = process.env.DRY_RUN === '1' || args.includes('--dry-run') || planOnlyFlag; // plan-only 는 쓰지 않으므로 dry-run 으로 취급
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
  const cohortBase = process.env.COHORT_BASE?.trim() || '';
  if (cohortBase && !/^[A-Za-z0-9._-]{1,64}$/.test(cohortBase)) fail(`COHORT_BASE 값이 올바르지 않습니다: ${cohortBase}`);
  if (cohortBase && cohortBase === cohortVersion) fail('COHORT_BASE 는 COHORT_VERSION 과 달라야 합니다.');
  const hostCapRaw = process.env.COHORT_HOST_CAP?.trim() || '0';
  const hostCap = Number.parseInt(hostCapRaw, 10);
  if (!(hostCap >= 0) || String(hostCap) !== hostCapRaw) fail(`COHORT_HOST_CAP 값이 올바르지 않습니다: ${hostCapRaw}`);
  if (hostCap > 0 && !cohortBase) fail('COHORT_HOST_CAP 은 COHORT_BASE(확장 코호트)와 함께만 씁니다.');
  const planOnly = planOnlyFlag;
  if (planOnly && !cohortBase) fail('PLAN_ONLY 는 COHORT_BASE 가 필요합니다.');
  const t0 = Date.now();

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
      // 확장 코호트(COHORT_BASE)로 바뀌는 날: 그날 본 실행은 이전 크기(v1 2,000)로 끝났을 수 있다.
      // 새 크기의 절반으로 비교하면 이미 끝난 날에 예비 실행이 확장 코호트를 하루 앞당겨 다시 돌리므로, 작은 쪽 기준으로 본다.
      const skipThreshold = Math.ceil((cohortBase ? Math.min(cohortSize, DEFAULT_COHORT_SIZE) : cohortSize) / 2);
      if (done >= skipThreshold) {
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
  const commit = scannerCommit();
  console.log(`scan_run_id=${runId} dry_run=${dryRun} registry=${registryUrl} scanner_version=${SCANNER_VERSION} scanner_commit=${commit ?? 'none'}`);

  // 1) Registry 수집. 실패·시간 초과면 2) 이후에서 직전 관찰 실행의 원격 주소로 대체한다(결측 방지).
  let registry: Awaited<ReturnType<typeof fetchRegistryTargets>> | null = null;
  let registryError = '';
  let registryFetchedAt: string | null = null; // Registry 목록을 다 받은 시각. 대체(fallback) 실행은 null → registry_snapshot_at 을 본다
  try {
    const budgetSec = envSeconds('REGISTRY_BUDGET_SEC', 480);
    registry = await fetchRegistryTargets({ baseUrl: registryUrl, deadline: Date.now() + budgetSec * 1000 });
    registryFetchedAt = new Date().toISOString();
    console.log('registry stats', JSON.stringify(registry.stats));
    if (registry.targets.length === 0) throw new Error('registry: 0 probeable targets (응답 형식 변경 가능성)');
  } catch (e) {
    registryError = e instanceof Error ? e.message : 'registry failed';
    registry = null;
    registryFetchedAt = null;
    console.log(`::warning::Registry 목록 받기 실패 → 직전 관찰 주소로 대체 시도: ${registryError}`);
  }

  const registrySec = Math.round((Date.now() - t0) / 1000);

  // 2) 코호트 확정/로드 → probe 작업 목록
  let cohortIds: string[] = [];
  let cohortCreated = false;
  let cohortSource = 'none';
  // 확장 코호트: base 멤버 목록(행마다 소속 표시용). 읽기 실패·빈 base 는 중단 — base 없이 새 코호트를 만들지 않는다
  let baseIds = new Set<string>();
  if (cohortBase) {
    if (!cohortReadCfg) fail('COHORT_BASE 를 쓰려면 DB 읽기 설정(LOWDOWN_SUPABASE_URL, LOWDOWN_SCANNER_KEY)이 필요합니다.');
    baseIds = new Set(await fetchCohort(cohortReadCfg, cohortBase));
    if (baseIds.size === 0) fail(`COHORT_BASE ${cohortBase} 코호트가 비어 있습니다.`);
    console.log(`cohort base ${cohortBase}: ${baseIds.size} targets`);
  }
  // 대상 → 원격 호스트 목록 (호스트 상한·집중도 계산용). 지금 Registry 기준
  const hostsOf = new Map<string, string[]>();
  if (registry) {
    for (const t of registry.targets) {
      hostsOf.set(`mcp:${t.name}`, [...new Set(t.remotes.map((r) => capHost(r.url)).filter((h): h is string => h !== null))]);
    }
  }

  if (planOnly) {
    if (!registry) fail(`PLAN_ONLY: Registry 목록을 받지 못했습니다: ${registryError}`);
    runPlanOnly({ baseIds: [...baseIds], candidates: registry.targets.map((t) => `mcp:${t.name}`), size: cohortSize, hostsOf, cohortBase });
    return;
  }
  if (cohortReadCfg) {
    cohortIds = await fetchCohort(cohortReadCfg, cohortVersion); // 읽기 실패 시 throw — 조용히 새 코호트를 만들지 않는다
    cohortSource = 'stored';
  }
  if (cohortIds.length > 0 && cohortBase) {
    const stored = new Set(cohortIds);
    const missingBase = [...baseIds].filter((id) => !stored.has(id)).length;
    if (missingBase > 0) fail(`저장된 ${cohortVersion} 에 ${cohortBase} 멤버 ${missingBase}개가 없습니다. 코호트 구성이 설계와 다릅니다.`);
  }
  if (cohortIds.length === 0) {
    if (!registry) fail(`코호트가 없고 Registry 목록도 받지 못했습니다: ${registryError}`);
    const candidates = registry.targets.map((t) => `mcp:${t.name}`);
    if (cohortBase && hostCap > 0) {
      const capped = extendCohortCapped([...baseIds], candidates, cohortSize, hostCap, hostsOf);
      if (capped.shortfall > 0) fail(`호스트 상한 ${hostCap} 으로 ${cohortSize}개를 채우지 못했습니다 (미달 ${capped.shortfall}). 상한을 넘겨 채우지 않습니다.`);
      console.log(`cohort host cap ${hostCap}: added ${capped.added}, skipped_by_cap ${capped.skippedByCap}`);
      cohortIds = capped.ids;
    } else {
      cohortIds = cohortBase ? extendCohort([...baseIds], candidates, cohortSize) : selectCohort(candidates, cohortSize);
    }
    cohortCreated = true;
    cohortSource = supabase ? 'created' : 'preview';
    if (supabase) {
      await saveCohort(supabase, cohortVersion, cohortIds);
      console.log(`cohort ${cohortVersion} created: ${cohortIds.length} targets (Day 0)`);
    } else {
      console.log(`cohort ${cohortVersion} preview (not saved): ${cohortIds.length} targets`);
    }
  }
  let plan: { jobs: CohortJob[]; gaps: CohortGap[] };
  let fallbackMeta: Record<string, unknown> = {};
  let stats: Record<string, unknown>;
  if (registry) {
    plan = planCohortJobs(registry.targets, cohortIds, registry.registryInfo);
    stats = { ...registry.stats };
  } else {
    if (!cohortReadCfg) fail(`Registry 목록을 받지 못했고 직전 관찰을 읽을 DB 설정도 없습니다: ${registryError}`);
    let fb;
    try {
      fb = await fetchFallbackJobs(cohortReadCfg, { minRows: Math.ceil(cohortSize / 2), cohortIds });
    } catch (e) {
      fail(`Registry 목록 실패(${registryError}) 그리고 대체도 실패: ${e instanceof Error ? e.message : 'unknown'}`);
    }
    plan = { jobs: fb.jobs, gaps: [] }; // 그날 Registry 를 못 봤으므로 사유 분리(gaps)는 기록하지 않는다
    fallbackMeta = { registry_fallback: true, registry_snapshot_run: fb.sourceRunId, registry_snapshot_at: fb.sourceObservedAt };
    stats = { registry_fallback: true, registry_error: registryError, snapshot_run: fb.sourceRunId, snapshot_rows: fb.sourceRows };
    console.log(`::warning::직전 관찰 실행 ${fb.sourceRunId} (${fb.sourceObservedAt}) 의 원격 주소 ${fb.jobs.length}개로 관찰합니다.`);
  }
  // 모든 관찰 행에 붙는 실행 정보: 어떤 코드(commit)가, 언제 받은 Registry 목록으로 관찰했는지
  const runMeta: Record<string, unknown> = {
    cohort_version: cohortVersion,
    scanner_commit: commit,
    registry_fetched_at: registryFetchedAt,
    ...fallbackMeta,
  };
  let jobs = plan.jobs;
  if (jobs.length === 0) fail('코호트에서 probe 할 remote 가 0개입니다 (Registry 와 코호트가 맞지 않음).');
  const gapReasonCounts = Object.fromEntries(count(plan.gaps.map((g) => g.reason)));
  const cohortInfo = {
    cohort_version: cohortVersion,
    cohort_base: cohortBase ? `${cohortBase} (${baseIds.size})` : 'none',
    cohort_host_cap: hostCap > 0 ? hostCap : 'none',
    cohort_source: cohortSource,
    cohort_created: cohortCreated,
    cohort_size: cohortIds.length,
    cohort_missing: registry ? plan.gaps.length : 'unknown (registry fallback)',
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
  const hostTop = topHosts(jobs.map((j) => j.remote.url));
  console.log(`probing ${jobs.length} remotes (concurrency=${concurrency}) top_hosts=${JSON.stringify(hostTop)}`);
  // base 멤버는 [base, version], 추가분은 [version]. 행의 cohort_version 은 이번 실행의 코호트(version)
  const cohortVersionsOf = (targetId: string): string[] => (baseIds.has(targetId) ? [cohortBase, cohortVersion] : [cohortVersion]);
  const tProbe = Date.now();

  // 3) 호스트당 동시 1건, 호스트 간 최대 concurrency 건(호스트를 번갈아 선택) → 80행마다 즉시 저장 (중간 실패해도 앞선 데이터 보존)
  //    한 호스트에 대상이 몰려도 그 호스트로는 한 번에 1건만 보낸다. 상대 서버 부하·속도 제한 때문에 결과가 흔들리는 것을 줄인다.
  const CHUNK = 80;
  const all: ObservationRow[] = [];
  let pending: ObservationRow[] = [];
  let inserted = 0;
  const flush = async (): Promise<void> => {
    if (pending.length === 0) return;
    const batch = pending;
    pending = [];
    if (supabase) {
      inserted += await insertObservations(batch, supabase);
      console.log(`inserted ${inserted}/${jobs.length}`);
    }
  };
  const hostBusyMs = new Map<string, number>();
  const probeOne = async (job: CohortJob): Promise<ObservationRow> => {
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
        metadata: { ...p.metadata, ...runMeta, ...(cohortBase ? { cohort_versions: cohortVersionsOf(`mcp:${job.name}`) } : {}) },
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
        metadata: { remote_url: job.remote.url, remote_index: job.index, registry_version: job.version, scanner_version: SCANNER_VERSION, internal_error: true, ...runMeta, ...(cohortBase ? { cohort_versions: cohortVersionsOf(`mcp:${job.name}`) } : {}) },
      };
    }
  };
  await runPerHostRoundRobin(
    jobs,
    (job) => hostOf(job.remote.url),
    concurrency,
    async (job) => {
      const t = Date.now();
      const row = await probeOne(job);
      const h = hostOf(job.remote.url);
      hostBusyMs.set(h, (hostBusyMs.get(h) ?? 0) + (Date.now() - t));
      return row;
    },
    {
      onResult: async (_job, row) => {
        all.push(row);
        pending.push(row);
        if (pending.length >= CHUNK) await flush();
      },
    },
  );
  await flush();
  // 가장 오래 붙잡힌 호스트 = probe 시간의 하한. timeout 을 정할 때 본다.
  const slowestHosts = [...hostBusyMs.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([h, ms]) => [h, Math.round(ms / 1000)]);

  const probeSec = Math.round((Date.now() - tProbe) / 1000);

  // 4) 직후 재시도 (실패해도 본 데이터에는 영향 없음)
  const tRetry = Date.now();
  let retryStats: Record<string, number | string> = {};
  try {
    retryStats = await retryFailed(all, { supabase, concurrency });
  } catch (e) {
    console.error(`retry 단계 실패(관찰 데이터는 저장 완료): ${e instanceof Error ? e.message : 'unknown'}`);
    retryStats = { retry: 'error' };
  }

  const retrySec = Math.round((Date.now() - tRetry) / 1000);

  // 5) 시장판 1단계: Registry 비교 기록 (관찰과 독립. 실패해도 계속)
  let diffStats: Record<string, string | number> = {};
  if (process.env.REGISTRY_DIFF?.trim() === '1') {
    const tDiff = Date.now();
    if (!registry) {
      diffStats = { registry_diff: 'skipped (registry fallback)' };
    } else if (!cohortReadCfg) {
      diffStats = { registry_diff: 'skipped (no db config)' };
    } else {
      try {
        const prev = await fetchRegistryState(cohortReadCfg);
        const d = diffRegistry(prev, registry.declarations, { now: registryFetchedAt ?? new Date().toISOString(), scanRunId: runId });
        let written = 'dry-run (not written)';
        if (supabase && d.mode !== 'skipped') {
          // 이벤트 먼저: 상태 갱신이 실패하면 다음 실행에서 같은 변화가 다시 잡힌다(유실보다 중복이 낫다)
          const ev = await insertRegistryChanges(supabase, d.events);
          const st = await upsertRegistryState(supabase, d.upserts);
          written = `events ${ev}, state ${st}`;
        }
        const newHosts = topHosts(d.events.filter((e) => e.kind === 'new').flatMap((e) => e.hosts.map((h) => `https://${h}/`)));
        diffStats = {
          registry_diff: d.mode + (d.skipReason ? ` (${d.skipReason})` : ''),
          registry_state_prev: prev.length,
          registry_declarations: registry.declarations.size,
          registry_diff_counts: JSON.stringify(d.counts),
          registry_diff_new_top_hosts: JSON.stringify(newHosts),
          registry_diff_written: written,
          registry_diff_sec: Math.round((Date.now() - tDiff) / 1000),
        };
        if (dryRun) for (const e of d.events.slice(0, 5)) console.log('registry change sample', JSON.stringify(e));
      } catch (e) {
        console.error(`registry diff 실패(관찰 데이터는 저장 완료): ${e instanceof Error ? e.message : 'unknown'}`);
        diffStats = { registry_diff: 'error' };
      }
    }
    console.log('registry diff', JSON.stringify(diffStats));
  }
  const totalSec = Math.round((Date.now() - t0) / 1000);
  const summary = summarize(all, runId, {
    dry_run: dryRun,
    inserted,
    elapsed_sec: `total ${totalSec} (registry ${registrySec}, probe ${probeSec}, retry ${retrySec})`,
    top_hosts: JSON.stringify(hostTop),
    probe_per_host_concurrency: 1,
    probe_slowest_hosts_sec: JSON.stringify(slowestHosts),
    est_bytes: `${all.length} rows × ~976 B ≈ ${((all.length * 976) / 1e6).toFixed(2)} MB`,
    scanner_version: SCANNER_VERSION,
    scanner_commit: commit ?? 'none',
    registry_fetched_at: registryFetchedAt ?? 'none (fallback)',
    ...cohortInfo,
    ...stats,
    ...retryStats,
    ...diffStats,
  });
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

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

/** 선정 계산만: 상한별 비교표를 출력한다. probe·DB 쓰기 없음. 같은 입력을 역순으로 넣어 재현성도 확인한다. */
function runPlanOnly(o: { baseIds: string[]; candidates: string[]; size: number; hostsOf: Map<string, string[]>; cohortBase: string }): void {
  const capsRaw = process.env.PLAN_CAPS?.trim() || '0,3,5,10';
  const caps = capsRaw.split(',').map((x) => Number.parseInt(x.trim(), 10));
  if (caps.some((c) => !(c >= 0))) fail(`PLAN_CAPS 값이 올바르지 않습니다: ${capsRaw}`);

  const baseInRegistry = o.baseIds.filter((id) => o.hostsOf.has(id)).length;
  const b = hostConcentration(o.baseIds, o.hostsOf);
  const lines = [
    `## Lowdown Scanner plan-only (선정 계산만, probe·저장 없음)`,
    ``,
    `- base: ${o.cohortBase} ${o.baseIds.length} (지금 Registry 에 있는 멤버 ${baseInRegistry}, 없는 멤버는 할당량에 세지 않음)`,
    `- candidates (probe 가능 대상): ${o.candidates.length}`,
    `- target size: ${o.size} (추가분 ${o.size - o.baseIds.length})`,
    `- base 집중도: 고유 호스트 ${b.uniqueHosts}, 상위1 ${pct(b.top1Share)}, 상위3 ${pct(b.top3Share)}, top ${JSON.stringify(b.top)}`,
    ``,
    `| cap | added | shortfall | skipped_by_cap | v2 unique hosts | v2 top1 | v2 top3 | extras unique hosts | extras top1 | reproducible |`,
    `|---|---|---|---|---|---|---|---|---|---|`,
  ];
  const tops: string[] = [];
  for (const cap of caps) {
    const r = extendCohortCapped(o.baseIds, o.candidates, o.size, cap, o.hostsOf);
    const again = extendCohortCapped(o.baseIds, [...o.candidates].reverse(), o.size, cap, o.hostsOf);
    const same = r.ids.length === again.ids.length && r.ids.every((id, i) => id === again.ids[i]);
    const v2 = hostConcentration(r.ids, o.hostsOf);
    const extras = hostConcentration(r.ids.slice(o.baseIds.length), o.hostsOf);
    lines.push(
      `| ${cap === 0 ? '0 (없음)' : cap} | ${r.added} | ${r.shortfall} | ${r.skippedByCap} | ${v2.uniqueHosts} | ${pct(v2.top1Share)} | ${pct(v2.top3Share)} | ${extras.uniqueHosts} | ${pct(extras.top1Share)} | ${same} |`,
    );
    tops.push(`- cap ${cap} v2 top5: ${JSON.stringify(v2.top)}`);
  }
  lines.push('', ...tops, '');
  const out = lines.join('\n');
  console.log(out);
  const summaryFile = process.env.GITHUB_STEP_SUMMARY;
  if (summaryFile) appendFileSync(summaryFile, `${out}\n`);
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
