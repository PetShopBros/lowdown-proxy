// 레이다 1단계: 그날 패키지 이벤트 → scanner_notable (비공개, published=false)
// 사용: node scanner/notable.ts [--day=YYYY-MM-DD | --from=YYYY-MM-DD] [--dry-run]
//   --day  : 그 하루만 (기본: 오늘 UTC — npm·PyPI 스냅샷의 detected_on 과 같은 날짜)
//   --from : 그날부터 오늘까지 하루씩 (지난 기간 채우기). 이미 있는 행은 건너뛴다(ignore-duplicates).
// 필수 환경변수: LOWDOWN_SUPABASE_URL, LOWDOWN_SCANNER_KEY
// 원자료는 읽기만 한다. 실패해도 다른 기록에는 영향이 없다.

import { buildNotable, fetchNotableInput, insertNotable, summarize } from './notable-lib.ts';

function fail(message: string): never {
  console.error(`::error::${message}`);
  process.exit(1);
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

function daysFrom(from: string, to: string): string[] {
  const out: string[] = [];
  const d = new Date(`${from}T00:00:00Z`);
  for (let i = 0; i < 400; i++) {
    const s = d.toISOString().slice(0, 10);
    if (s > to) break;
    out.push(s);
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const dayArg = args.find((a) => a.startsWith('--day='))?.slice(6);
  const fromArg = args.find((a) => a.startsWith('--from='))?.slice(7);
  const today = new Date().toISOString().slice(0, 10);
  if (dayArg && !DAY.test(dayArg)) fail(`--day 형식이 아닙니다: ${dayArg}`);
  if (fromArg && !DAY.test(fromArg)) fail(`--from 형식이 아닙니다: ${fromArg}`);
  const days = fromArg ? daysFrom(fromArg, today) : [dayArg ?? today];
  if (days.length === 0) fail('대상 날짜가 없습니다.');

  const url = process.env.LOWDOWN_SUPABASE_URL?.trim();
  const key = process.env.LOWDOWN_SCANNER_KEY?.trim();
  if (!url || !key) fail('LOWDOWN_SUPABASE_URL / LOWDOWN_SCANNER_KEY 가 없습니다.');
  const cfg = { url, key };

  let total = 0;
  for (const day of days) {
    const input = await fetchNotableInput(cfg, day);
    const { rows, skipped } = buildNotable(input);
    const s = summarize(rows);
    const rules = Object.entries(s.byRule).map(([k, v]) => `${k}=${v}`).join(', ') || '(none)';
    console.log(`notable ${day}: rows ${rows.length} (${rules}), groups ${s.groups}, lines after grouping ${s.lines}, skipped names ${skipped}`);
    for (const r of rows) console.log(`  ${r.rule_id} ${r.subject_kind}:${r.subject} [${r.group_key}]`);
    if (!dryRun && rows.length > 0) total += await insertNotable(cfg, rows);
  }
  console.log(`notable written: ${total}${dryRun ? ' (dry-run)' : ''}`);
}

main().catch((e: unknown) => fail(e instanceof Error ? e.message : 'notable failed'));
