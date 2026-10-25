// 원문 비공개 보관 — 사용: node scanner/private-archive.ts <privateRepoDir> [--dry-run]
// 필수 환경변수: LOWDOWN_SUPABASE_URL, LOWDOWN_SCANNER_KEY
// 공개 레포의 Actions 로그로 나가므로 출력은 날짜·행 수·바이트·해시만. 원문은 출력하지 않는다.

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { closedDays, countRows, dayRange, gzipFile } from './archive-lib.ts';
import {
  fetchPrivateDay,
  integrityFailures,
  parsePrivateManifest,
  planPrivateDays,
  PRIVATE_DATASETS,
  PRIVATE_FROM,
  privatePathFor,
  serializePrivateManifest,
  SPECS,
  toJsonl,
  type PrivateDataset,
  type PrivateManifestEntry,
} from './private-archive-lib.ts';

function fail(message: string): never {
  console.error(`::error::${message}`);
  process.exit(1);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const outDir = args[0];
  if (!outDir || outDir.startsWith('--')) fail('사용법: node scanner/private-archive.ts <privateRepoDir> [--dry-run]');
  const dryRun = args.includes('--dry-run');
  const url = process.env.LOWDOWN_SUPABASE_URL?.trim();
  const key = process.env.LOWDOWN_SCANNER_KEY?.trim();
  if (!url || !key) fail('LOWDOWN_SUPABASE_URL / LOWDOWN_SCANNER_KEY 가 없습니다.');
  const cfg = { url, key };

  const manifestPath = join(outDir, 'MANIFEST.csv');
  const manifest: PrivateManifestEntry[] = existsSync(manifestPath) ? parsePrivateManifest(readFileSync(manifestPath, 'utf8')) : [];
  const exists = (p: string) => existsSync(join(outDir, p));
  // 데이터셋마다 시작일·대기일이 다르다
  const daysFor = (d: PrivateDataset) => {
    const spec = SPECS[d];
    return closedDays(spec.from ?? PRIVATE_FROM, new Date(Date.now() - (spec.settleDays ?? 0) * 86_400_000));
  };

  const plans = PRIVATE_DATASETS.map((d) => ({ dataset: d, ...planPrivateDays(d, daysFor(d), manifest, exists) }));
  const conflicts = plans.flatMap((p) => p.conflicts);
  for (const e of manifest) if (!exists(e.path)) conflicts.push(`${e.path}: in MANIFEST but file missing`);
  if (conflicts.length > 0) fail(`보관 파일과 MANIFEST 가 어긋납니다(아무것도 쓰지 않음):\n${[...new Set(conflicts)].join('\n')}`);
  console.log(`private plan: ${plans.map((p) => `${p.dataset} ${p.todo.length} day(s)`).join(', ')}, dry_run=${dryRun}`);

  let written = 0;
  // 한 데이터셋이 실패해도 다른 데이터셋은 계속 보관한다. 실패한 데이터셋은 그 날부터 멈추고, 마지막에 실패로 끝낸다.
  // (이미 쓴 파일은 행 수 확인을 통과한 완전한 파일이라 커밋해도 된다 — backup.yml 의 비공개 커밋은 실패해도 돈다)
  const failures: string[] = [];
  for (const plan of plans) {
    const spec = SPECS[plan.dataset];
    try {
    for (const day of plan.todo) {
      const range = dayRange(day);
      const rows = await fetchPrivateDay(cfg, spec, range);
      const count = await countRows(cfg, spec.table, [
        [spec.timeColumn, `gte.${range.start}`],
        [spec.timeColumn, `lt.${range.end}`],
      ]);
      if (rows.length !== count) throw new Error(`${plan.dataset} ${day}: 읽은 행 ${rows.length} ≠ DB 행 수 ${count} (쓰지 않음)`);
      if (plan.dataset === 'tool_defs') {
        const bad = integrityFailures(rows);
        if (bad.length > 0) throw new Error(`tool_defs ${day}: 무결성 불일치 ${bad.length}행 (쓰지 않음), 예: ${bad.slice(0, 3).join(', ')}`);
      }
      const gz = gzipFile(toJsonl(spec.columns, rows));
      console.log(`${plan.dataset} ${day}: ${rows.length} rows, ${gz.bytes} B, sha256 ${gz.sha256.slice(0, 16)}`);
      if (!dryRun) {
        const path = privatePathFor(plan.dataset, day);
        const full = join(outDir, path);
        mkdirSync(dirname(full), { recursive: true });
        writeFileSync(`${full}.tmp`, gz.data);
        renameSync(`${full}.tmp`, full);
        manifest.push({ dataset: plan.dataset, day, path, rows: rows.length, bytes: gz.bytes, sha256: gz.sha256, written_at: new Date().toISOString() });
        writeFileSync(manifestPath, serializePrivateManifest(manifest));
      }
      written++;
    }
    } catch (e: unknown) {
      // 오류 문구에는 응답 본문이 들어가지 않는다(fetchPrivateDay·countRows 가 상태 코드만 쓴다)
      failures.push(e instanceof Error ? e.message : `${plan.dataset}: failed`);
    }
  }
  console.log(`private archive done: ${written} file(s)${dryRun ? ' (dry-run, not written)' : ''}`);
  const out = process.env.GITHUB_OUTPUT;
  if (out) appendFileSync(out, `written=${written}\n`);
  if (failures.length > 0) fail(`비공개 보관 실패 ${failures.length}건 (나머지는 보관함):\n${failures.join('\n')}`);
}

main().catch((e: unknown) => fail(e instanceof Error ? e.message : 'private archive failed'));
