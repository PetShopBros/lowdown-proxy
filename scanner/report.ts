// Lowdown Scanner 공개 리포트 생성 — <outDir>/REPORT.md
// 사용: node scanner/report.ts <outDir>
// 필수 환경변수: LOWDOWN_SUPABASE_URL, LOWDOWN_SCANNER_KEY
// 최신 run(최근 8일 창)을 읽어 메모리에서 집계하고 집계값만 출력한다. 오류는 조용히 넘기지 않는다.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fetchCohort } from './lib.ts';
import { buildReport, fetchFirstObservedAt, fetchReportRows, latestRun, renderReport, WINDOW_DAYS } from './report-lib.ts';

function fail(message: string): never {
  console.error(`::error::${message}`);
  process.exit(1);
}

async function main(): Promise<void> {
  const outDir = process.argv[2];
  if (!outDir || outDir.startsWith('--')) fail('사용법: node scanner/report.ts <outDir>');
  const url = process.env.LOWDOWN_SUPABASE_URL?.trim();
  const key = process.env.LOWDOWN_SCANNER_KEY?.trim();
  if (!url || !key) fail('LOWDOWN_SUPABASE_URL / LOWDOWN_SCANNER_KEY 가 없습니다.');
  const cfg = { url, key };

  const now = new Date();
  const since = new Date(now.getTime() - WINDOW_DAYS * 86_400_000).toISOString();
  const rows = await fetchReportRows(cfg, since);
  if (rows.length === 0) fail(`최근 ${WINDOW_DAYS}일 안에 관찰 행이 없습니다.`);

  const latest = latestRun(rows);
  if (!latest?.cohortVersion) fail('최신 run 에서 metadata.cohort_version 을 찾을 수 없습니다.');
  const cohortIds = await fetchCohort(cfg, latest.cohortVersion);
  const first = await fetchFirstObservedAt(cfg);

  const data = buildReport(rows, cohortIds, latest.cohortVersion, first, now);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'REPORT.md'), renderReport(data));
  console.log(
    `REPORT.md written: data_as_of=${data.data_as_of} cohort=${data.cohort_version}(${data.cohort_size}) rows=${data.latest.rows} probe_attempts=${data.latest.probe_attempts} unobserved=${data.cohort_unobserved}`,
  );
}

main().catch((e: unknown) => {
  fail(e instanceof Error ? e.message : 'report failed');
});