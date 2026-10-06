// scanner_observations 공개 데이터셋 CSV export (주 1회, lowdown-data 레포로)
// 사용: node scanner/export.ts <outDir> [--months 2]
// 필수 환경변수: LOWDOWN_SUPABASE_URL, LOWDOWN_SCANNER_KEY
// 출력: <outDir>/scanner_observations/YYYY-MM.csv (월별, id 오름차순 → 변경 없으면 git diff 없음)

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fetchMonthRows, monthRanges, rowsToCsv } from './lib.ts';

function fail(message: string): never {
  console.error(`::error::${message}`);
  process.exit(1);
}

const args = process.argv.slice(2);
const outDir = args[0];
if (!outDir || outDir.startsWith('--')) fail('사용법: node scanner/export.ts <outDir> [--months N]');
const mi = args.indexOf('--months');
const months = mi >= 0 ? Number.parseInt(args[mi + 1] ?? '', 10) : 2;
if (!(months >= 1 && months <= 24)) fail('--months 는 1~24 사이여야 합니다.');

const url = process.env.LOWDOWN_SUPABASE_URL?.trim();
const key = process.env.LOWDOWN_SCANNER_KEY?.trim();
if (!url || !key) fail('LOWDOWN_SUPABASE_URL / LOWDOWN_SCANNER_KEY 가 없습니다.');

const dir = join(outDir, 'scanner_observations');
mkdirSync(dir, { recursive: true });

let total = 0;
for (const range of monthRanges(new Date(), months)) {
  const rows = await fetchMonthRows({ url, key }, range);
  if (rows.length === 0) {
    console.log(`${range.label}: 0 rows (skip)`);
    continue;
  }
  writeFileSync(join(dir, `${range.label}.csv`), rowsToCsv(rows));
  total += rows.length;
  console.log(`${range.label}: ${rows.length} rows`);
}
console.log(`exported ${total} rows`);
