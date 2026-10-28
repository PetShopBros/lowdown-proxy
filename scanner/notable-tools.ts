// 레이다 2단계: 최근 관찰 → 확인된 도구 정의 변경(R1·R2·R3) → scanner_notable (비공개, published=false)
// 사용: node scanner/notable-tools.ts [--days=N] [--dry-run]
//   --days : 읽을 관찰 기간(기본 21일). 매일 같은 기간을 다시 계산하고, 이미 있는 행은 건너뛴다(ignore-duplicates).
//            기간 앞쪽 변경은 안정 일수가 덜 세어져 빠질 수는 있어도, 없는 사실이 생기지는 않는다.
// 필수 환경변수: LOWDOWN_SUPABASE_URL, LOWDOWN_SCANNER_KEY. 원자료는 읽기만 한다.

import { insertNotable, summarize } from './notable-lib.ts';
import { buildToolNotable, fetchObservations } from './notable-tools-lib.ts';

function fail(message: string): never {
  console.error(`::error::${message}`);
  process.exit(1);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const daysArg = args.find((a) => a.startsWith('--days='))?.slice(7);
  const days = daysArg === undefined ? 21 : Number(daysArg);
  if (!Number.isInteger(days) || days < 9 || days > 60) fail(`--days 는 9~60 사이 정수여야 합니다: ${daysArg}`);

  const url = process.env.LOWDOWN_SUPABASE_URL?.trim();
  const key = process.env.LOWDOWN_SCANNER_KEY?.trim();
  if (!url || !key) fail('LOWDOWN_SUPABASE_URL / LOWDOWN_SCANNER_KEY 가 없습니다.');
  const cfg = { url, key };

  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const obs = await fetchObservations(cfg, since);
  const { rows, skipped } = buildToolNotable(obs);
  console.log(`notable-tools: observations ${obs.length} since ${since.slice(0, 10)}, rows ${rows.length}, skipped names ${skipped}`);

  const byDay = new Map<string, typeof rows>();
  for (const r of rows) {
    if (!byDay.has(r.day)) byDay.set(r.day, []);
    byDay.get(r.day)!.push(r);
  }
  for (const [day, list] of [...byDay].sort((a, b) => (a[0] < b[0] ? 1 : -1))) {
    const s = summarize(list);
    const rules = Object.entries(s.byRule).map(([k, v]) => `${k}=${v}`).join(', ');
    console.log(`  ${day}: rows ${list.length} (${rules}), lines after grouping ${s.lines}`);
  }

  const written = dryRun || rows.length === 0 ? 0 : await insertNotable(cfg, rows);
  console.log(`notable-tools written: ${written}${dryRun ? ' (dry-run)' : ''} (existing rows are skipped)`);
}

main().catch((e: unknown) => fail(e instanceof Error ? e.message : 'notable-tools failed'));
