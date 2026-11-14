// Lowdown Data Access Report 생성 — <outDir>/ACCESS-YYYY-MM.md (공개 가능한 합계) + <outDir>/access-YYYY-MM.json (내부용, 대상 서버 이름 포함 — 게시하지 않음)
// 사용: node scanner/access-report.ts <YYYY-MM> <outDir> [--confirmed=N]
//   --confirmed: 손으로 확인한 인용 수(공개된 AI 답변에서 Lowdown 인용을 직접 본 횟수). 없으면 "none recorded".
// 필수 환경변수: LOWDOWN_SUPABASE_URL, LOWDOWN_SCANNER_KEY
// 달이 끝나기 전에 돌리면 DRAFT. 오류는 조용히 넘기지 않는다.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildAccess, fetchAccessRows, fetchIssuance, renderAccess } from './access-report-lib.ts';
import { parseMonth } from './monthly-lib.ts';

function fail(message: string): never {
  console.error(`::error::${message}`);
  process.exit(1);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const [label, outDir] = args;
  if (!label || !outDir || outDir.startsWith('--')) fail('사용법: node scanner/access-report.ts <YYYY-MM> <outDir> [--confirmed=N]');
  const range = parseMonth(label);
  const confRaw = args.find((a) => a.startsWith('--confirmed='))?.slice(12);
  const confirmed = confRaw === undefined ? null : Number(confRaw);
  if (confirmed !== null && !(Number.isInteger(confirmed) && confirmed >= 0)) fail(`--confirmed 는 0 이상의 정수여야 합니다: ${confRaw}`);

  const url = process.env.LOWDOWN_SUPABASE_URL?.trim();
  const key = process.env.LOWDOWN_SCANNER_KEY?.trim();
  if (!url || !key) fail('LOWDOWN_SUPABASE_URL / LOWDOWN_SCANNER_KEY 가 없습니다.');
  const cfg = { url, key };

  const t0 = Date.now();
  const rows = await fetchAccessRows(cfg, range);
  if (rows.length === 0) fail(`access_daily 에 ${range.label} 행이 없습니다.`);
  const issued = await fetchIssuance(cfg, range);
  const data = buildAccess(rows, issued, range, new Date(), confirmed);

  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, `ACCESS-${range.label}.md`), renderAccess(data));
  writeFileSync(join(outDir, `access-${range.label}.json`), `${JSON.stringify(data, null, 2)}\n`);
  console.log(`ACCESS-${range.label}.md written: partial=${data.partial} rows=${rows.length} days=${data.days_with_data} ${Math.round((Date.now() - t0) / 1000)}s`);
}

main().catch((e: unknown) => {
  fail(e instanceof Error ? e.message : 'access report failed');
});
