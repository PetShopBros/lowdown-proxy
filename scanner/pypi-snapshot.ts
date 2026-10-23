// PyPI 패키지 일별 상태 기록 — 사용: node scanner/pypi-snapshot.ts [--dry-run] [--limit=N]
// 필수 환경변수: LOWDOWN_SUPABASE_URL, LOWDOWN_SCANNER_KEY
// 선택: PYPI_CONCURRENCY(기본 2), PYPI_MAX_PACKAGES(기본 6000, 패키지당 요청 2건), PYPI_TIME_BUDGET_MIN(기본 25)
// 본 관찰(scan.ts)·npm 스냅샷과 따로 돈다. 실패해도 다른 기록에는 영향이 없다.

import { appendFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fetchAll, fetchDeclaredPackageKeys } from './npm-lib.ts';
import { fetchPypiPackage, fetchPypiState, insertPypiChanges, planPypiSnapshot, pypiIdentsFromPackagesKeys, upsertPypiState, type PypiObservation } from './pypi-lib.ts';

function fail(message: string): never {
  console.error(`::error::${message}`);
  process.exit(1);
}

const intEnv = (name: string, dflt: number) => {
  const v = Number(process.env[name]);
  return Number.isInteger(v) && v > 0 ? v : dflt;
};

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const limitArg = args.find((a) => a.startsWith('--limit='));
  const limit = limitArg ? Number(limitArg.slice(8)) : null;
  const url = process.env.LOWDOWN_SUPABASE_URL?.trim();
  const key = process.env.LOWDOWN_SCANNER_KEY?.trim();
  if (!url || !key) fail('LOWDOWN_SUPABASE_URL / LOWDOWN_SCANNER_KEY 가 없습니다.');
  const cfg = { url, key };

  const started = Date.now();
  const ctx = { now: new Date(started).toISOString(), scanRunId: randomUUID() };

  const keys = await fetchDeclaredPackageKeys(cfg);
  const { idents, invalid } = pypiIdentsFromPackagesKeys(keys);
  const targets = limit && limit > 0 ? idents.slice(0, limit) : idents;
  const prev = await fetchPypiState(cfg);
  console.log(`pypi targets: ${targets.length} (declared ${idents.length}, invalid names ${invalid}), known state ${prev.length}, dry_run=${dryRun}`);

  const { observations, skipped } = await fetchAll<PypiObservation>(targets, (id) => fetchPypiPackage(id), {
    concurrency: intEnv('PYPI_CONCURRENCY', 2),
    maxRequests: intEnv('PYPI_MAX_PACKAGES', 6_000),
    deadline: started + intEnv('PYPI_TIME_BUDGET_MIN', 25) * 60_000,
  });

  const plan = planPypiSnapshot(prev, observations, ctx);
  const s = plan.stats;
  const statusCounts = new Map<string, number>();
  for (const o of observations) if (o.kind !== 'error') statusCounts.set(o.project_status ?? 'unknown', (statusCounts.get(o.project_status ?? 'unknown') ?? 0) + 1);
  console.log(`pypi checked ${s.checked}, found ${s.found}, not_found ${s.not_found}, errors ${s.errors}, skipped ${skipped}, baseline ${s.baseline}, events ${s.events}, held_not_found ${s.held_not_found}, sec ${Math.round((Date.now() - started) / 1000)}`);
  console.log(`pypi project_status: ${[...statusCounts].sort().map(([k, n]) => `${k} ${n}`).join(', ')}`);
  const byKind = new Map<string, number>();
  for (const e of plan.events) byKind.set(e.kind, (byKind.get(e.kind) ?? 0) + 1);
  if (byKind.size > 0) console.log(`pypi events: ${[...byKind].map(([k, n]) => `${k} ${n}`).join(', ')}`);
  if (s.held_not_found > 0) console.log(`::warning::pypi: ${s.held_not_found} packages turned 404 at once; held as errors (not recorded as not_found)`);
  if (plan.abort) fail(`pypi snapshot not written: ${plan.abort}`);

  let written = 0;
  let eventsWritten = 0;
  if (!dryRun) {
    written = await upsertPypiState(cfg, plan.rows);
    eventsWritten = await insertPypiChanges(cfg, plan.events);
  }
  console.log(`pypi written: state ${written}, events ${eventsWritten}${dryRun ? ' (dry-run)' : ''}`);
  const out = process.env.GITHUB_OUTPUT;
  if (out) appendFileSync(out, `pypi_checked=${s.checked}\npypi_events=${s.events}\npypi_errors=${s.errors}\n`);
}

main().catch((e: unknown) => fail(e instanceof Error ? e.message : 'pypi snapshot failed'));
