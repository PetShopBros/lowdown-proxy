// Lowdown MCP Scanner — 일 1회 실행 진입점
//   Registry → active && isLatest → streamable-http remote → SSRF 검증 → initialize → tools/list → scanner_observations
//
// 필수 환경변수(dry-run 이면 불필요): LOWDOWN_SUPABASE_URL, LOWDOWN_SCANNER_KEY(scanner 전용 service key), LOWDOWN_NODE_ID
// 선택: DRY_RUN=1 또는 --dry-run, SCAN_LIMIT=<N> 또는 --limit=<N>, SCAN_CONCURRENCY=<N, 기본 8>, REGISTRY_URL
// target_id 는 기존 Lowdown 표기와 맞춰 `mcp:` + Registry 이름 (예: mcp:io.github.user/server)

import { randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import {
  DEFAULT_REGISTRY_URL,
  fetchRegistryTargets,
  insertObservations,
  probeRemote,
  runPool,
} from './lib.ts';
import type { ObservationRow, RegistryRemote } from './lib.ts';

function fail(message: string): never {
  console.error(`::error::${message}`);
  process.exit(1);
}

function requireEnv(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) fail(`환경변수 ${name} 가 없습니다. GitHub Secrets 설정을 확인하세요.`);
  return v;
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

  let supabase: { url: string; key: string } | undefined;
  let nodeId = process.env.LOWDOWN_NODE_ID?.trim() || 'dry-run';
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

  const runId = randomUUID();
  const registryUrl = process.env.REGISTRY_URL?.trim() || DEFAULT_REGISTRY_URL;
  console.log(`scan_run_id=${runId} dry_run=${dryRun} registry=${registryUrl}`);

  // 1) Registry 수집 (실패하면 명확하게 실패)
  const { targets, stats } = await fetchRegistryTargets({ baseUrl: registryUrl });
  console.log('registry stats', JSON.stringify(stats));
  if (targets.length === 0) fail('Registry 에서 probe 가능한 대상이 0개입니다 (응답 형식 변경 가능성).');

  // 2) probe 작업 목록
  type Job = { name: string; version: string; remote: RegistryRemote; index: number };
  let jobs: Job[] = targets.flatMap((t) => t.remotes.map((remote, index) => ({ name: t.name, version: t.version, remote, index })));
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
        return { scan_run_id: runId, node_id: nodeId, target_id: `mcp:${job.name}`, target_type: 'mcp_server', observed_at: observedAt, source: 'scanner', ...p };
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
          metadata: { remote_url: job.remote.url, remote_index: job.index, registry_version: job.version, internal_error: true },
        };
      }
    });
    all.push(...rows);
    if (supabase) {
      inserted += await insertObservations(rows, supabase);
      console.log(`inserted ${inserted}/${jobs.length}`);
    }
  }

  const summary = summarize(all, runId, { dry_run: dryRun, inserted, ...stats });
  console.log(summary);
  if (dryRun) {
    console.log('sample rows:');
    for (const r of all.slice(0, 5)) console.log(JSON.stringify(r));
  }
  const summaryFile = process.env.GITHUB_STEP_SUMMARY;
  if (summaryFile) appendFileSync(summaryFile, `${summary}\n`);
}

main().catch((e: unknown) => {
  fail(e instanceof Error ? e.message : 'scanner failed');
});
