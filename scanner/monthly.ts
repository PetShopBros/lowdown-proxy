// Lowdown 월간 MCP 보고서 초안 생성 — <outDir>/MONTHLY-YYYY-MM.md (표만) + <outDir>/monthly-YYYY-MM.json (내부용, 게시하지 않음)
// 사용: node scanner/monthly.ts <YYYY-MM> <outDir> [--trend-from=YYYY-MM-DD]
// 필수 환경변수: LOWDOWN_SUPABASE_URL, LOWDOWN_SCANNER_KEY
// 달이 끝나기 전에 돌리면 초안 표시(DRAFT)를 붙인다. 오류는 조용히 넘기지 않는다.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_COHORT_VERSION, fetchCohort } from './lib.ts';
import { accumulate, buildMonthly, DEFAULT_TREND_FROM, fetchCounts, fetchRegistryDecls, newState, parseMonth, renderMonthly, streamObservations } from './monthly-lib.ts';

function fail(message: string): never {
  console.error(`::error::${message}`);
  process.exit(1);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const [label, outDir] = args;
  if (!label || !outDir || outDir.startsWith('--')) fail('사용법: node scanner/monthly.ts <YYYY-MM> <outDir> [--trend-from=YYYY-MM-DD]');
  const range = parseMonth(label);
  const trendFrom = args.find((a) => a.startsWith('--trend-from='))?.slice(13) ?? DEFAULT_TREND_FROM;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trendFrom) || trendFrom > range.startDay) fail(`--trend-from 은 YYYY-MM-DD 이고 ${range.startDay} 이전이어야 합니다: ${trendFrom}`);

  const url = process.env.LOWDOWN_SUPABASE_URL?.trim();
  const key = process.env.LOWDOWN_SCANNER_KEY?.trim();
  if (!url || !key) fail('LOWDOWN_SUPABASE_URL / LOWDOWN_SCANNER_KEY 가 없습니다.');
  const cfg = { url, key };

  const t0 = Date.now();
  const cohortIds = await fetchCohort(cfg, DEFAULT_COHORT_VERSION);
  const trendIds = new Set(cohortIds);
  const state = newState();
  let pages = 0;
  const rows = await streamObservations(cfg, `${trendFrom}T00:00:00.000Z`, range.end, (page) => {
    accumulate(state, page, range, trendIds);
    if (++pages % 50 === 0) console.log(`  ${pages} pages, ${state.targets.size} servers so far`);
  });
  const registry = await fetchRegistryDecls(cfg);
  const counts = await fetchCounts(cfg, range);
  const data = buildMonthly(state, registry, counts, range, { version: DEFAULT_COHORT_VERSION, size: cohortIds.length, from: trendFrom }, new Date());

  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, `MONTHLY-${range.label}.md`), renderMonthly(data));
  writeFileSync(join(outDir, `monthly-${range.label}.json`), `${JSON.stringify(data, null, 2)}\n`);
  console.log(
    `MONTHLY-${range.label}.md written: partial=${data.partial} rows_read=${rows} month_rows=${data.observation_rows} servers=${data.status.servers} registry=${registry.size} ${Math.round((Date.now() - t0) / 1000)}s`,
  );
}

main().catch((e: unknown) => {
  fail(e instanceof Error ? e.message : 'monthly failed');
});
