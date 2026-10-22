// npm 패키지 일별 상태 기록 — 사용: node scanner/npm-snapshot.ts [--dry-run] [--limit=N]
// 필수 환경변수: LOWDOWN_SUPABASE_URL, LOWDOWN_SCANNER_KEY
// 선택: NPM_CONCURRENCY(기본 6), NPM_MAX_REQUESTS(기본 15000), NPM_TIME_BUDGET_MIN(기본 25)
// 본 관찰(scan.ts)과 따로 돈다. 실패해도 관찰에는 영향이 없다.

import { appendFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import {
  fetchAll,
  fetchDeclaredPackageKeys,
  fetchNpmPackage,
  fetchNpmState,
  insertNpmChanges,
  npmIdentsFromPackagesKeys,
  planSnapshot,
  upsertNpmState,
} from './npm-lib.ts';

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
  const { idents, invalid } = npmIdentsFromPackagesKeys(keys);
  const targets = limit && limit > 0 ? idents.slice(0, limit) : idents;
  const prev = await fetchNpmState(cfg);
  console.log(`npm targets: ${targets.length} (declared ${idents.length}, invalid names ${invalid}), known state ${prev.length}, dry_run=${dryRun}`);

  const { observations, skipped } = await fetchAll(targets, (id) => fetchNpmPackage(id), {
    concurrency: intEnv('NPM_CONCURRENCY', 6),
    maxRequests: intEnv('NPM_MAX_REQUESTS', 15_000),
    deadline: started + intEnv('NPM_TIME_BUDGET_MIN', 25) * 60_000,
  });

  const plan = planSnapshot(prev, observations, ctx);
  const s = plan.stats;
  console.log(`npm checked ${s.checked}, found ${s.found}, not_found ${s.not_found}, errors ${s.errors}, skipped ${skipped}, baseline ${s.baseline}, events ${s.events}, held_not_found ${s.held_not_found}, sec ${Math.round((Date.now() - started) / 1000)}`);
  const byKind = new Map<string, number>();
  for (const e of plan.events) byKind.set(e.kind, (byKind.get(e.kind) ?? 0) + 1);
  if (byKind.size > 0) console.log(`npm events: ${[...byKind].map(([k, n]) => `${k} ${n}`).join(', ')}`);
  if (s.held_not_found > 0) console.log(`::warning::npm: ${s.held_not_found} packages turned 404 at once; held as errors (not recorded as not_found)`);
  if (plan.abort) fail(`npm snapshot not written: ${plan.abort}`);

  let written = 0;
  let eventsWritten = 0;
  if (!dryRun) {
    written = await upsertNpmState(cfg, plan.rows);
    eventsWritten = await insertNpmChanges(cfg, plan.events);
  }
  console.log(`npm written: state ${written}, events ${eventsWritten}${dryRun ? ' (dry-run)' : ''}`);
  const out = process.env.GITHUB_OUTPUT;
  if (out) appendFileSync(out, `npm_checked=${s.checked}\nnpm_events=${s.events}\nnpm_errors=${s.errors}\n`);
}

main().catch((e: unknown) => fail(e instanceof Error ? e.message : 'npm snapshot failed'));
