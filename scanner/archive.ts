// 날짜별 보관 — lowdown-data 저장소에 닫힌 날(UTC)마다 CSV.gz 1개 + MANIFEST.csv
// 사용: node scanner/archive.ts <outDir> [--dry-run] [--max-days N]
// 필수 환경변수: LOWDOWN_SUPABASE_URL, LOWDOWN_SCANNER_KEY
// 규칙: 한 번 쓴 파일은 다시 쓰지 않는다. DB 행 수와 다르면 쓰지 않고 실패한다.
//       디스크와 MANIFEST 가 어긋나면 아무것도 쓰지 않고 실패한다(사람이 확인).

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  closedDays,
  countRows,
  dayRange,
  fetchRegistryChangesDay,
  gzipFile,
  MANIFEST_FILE,
  type ManifestEntry,
  observationDayFilters,
  OBSERVATIONS_FROM,
  parseManifest,
  pathFor,
  planDays,
  REGISTRY_CHANGE_COLUMNS,
  REGISTRY_CHANGES_FROM,
  serializeManifest,
  snapshotDue,
  toCsv,
} from './archive-lib.ts';
import { EXPORT_COLUMNS, fetchMonthRows } from './lib.ts';
import { fetchRegistryState } from './registry-diff.ts';

const STATE_COLUMNS = ['name', 'version', 'status', 'remotes_key', 'packages_key', 'desc_hash', 'hosts', 'first_seen_at', 'baseline', 'removed_at', 'updated_at'] as const;
const AUDIT_DAYS = 3;

function fail(message: string): never {
  console.error(`::error::${message}`);
  process.exit(1);
}

function setOutput(key: string, value: string | number): void {
  const out = process.env.GITHUB_OUTPUT;
  if (out) appendFileSync(out, `${key}=${value}\n`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const outDir = args[0];
  if (!outDir || outDir.startsWith('--')) fail('사용법: node scanner/archive.ts <outDir> [--dry-run] [--max-days N]');
  const dryRun = args.includes('--dry-run');
  const mi = args.indexOf('--max-days');
  const maxDays = mi >= 0 ? Number.parseInt(args[mi + 1] ?? '', 10) : 60;
  if (!(maxDays >= 1 && maxDays <= 400)) fail('--max-days 는 1~400 사이여야 합니다.');

  const url = process.env.LOWDOWN_SUPABASE_URL?.trim();
  const key = process.env.LOWDOWN_SCANNER_KEY?.trim();
  if (!url || !key) fail('LOWDOWN_SUPABASE_URL / LOWDOWN_SCANNER_KEY 가 없습니다.');
  const cfg = { url, key };

  const manifestPath = join(outDir, MANIFEST_FILE);
  const manifest: ManifestEntry[] = existsSync(manifestPath) ? parseManifest(readFileSync(manifestPath, 'utf8')) : [];
  const now = new Date();
  const exists = (p: string) => existsSync(join(outDir, p));

  const obsPlan = planDays('observations', closedDays(OBSERVATIONS_FROM, now), manifest, exists);
  const chgPlan = planDays('registry_changes', closedDays(REGISTRY_CHANGES_FROM, now), manifest, exists);
  const conflicts = [...obsPlan.conflicts, ...chgPlan.conflicts];
  for (const e of manifest) if (!exists(e.path)) conflicts.push(`${e.path}: in MANIFEST but file missing`);
  if (conflicts.length > 0) fail(`보관 파일과 MANIFEST 가 어긋납니다(아무것도 쓰지 않음):\n${[...new Set(conflicts)].join('\n')}`);

  console.log(`plan: observations ${obsPlan.todo.length} day(s), registry_changes ${chgPlan.todo.length} day(s), dry_run=${dryRun}`);

  const write = (entry: Omit<ManifestEntry, 'written_at'>, data: Buffer) => {
    const full = join(outDir, entry.path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(`${full}.tmp`, data);
    renameSync(`${full}.tmp`, full);
    manifest.push({ ...entry, written_at: new Date().toISOString() });
    writeFileSync(manifestPath, serializeManifest(manifest)); // 하루씩 진행분을 남긴다
  };

  let written = 0;
  let dayFiles = 0;

  // 1) 관찰 행 — 날짜별 CSV.gz (열은 기존 월별 CSV 와 같음)
  for (const day of obsPlan.todo.slice(0, maxDays)) {
    const rows = await fetchMonthRows(cfg, dayRange(day));
    const count = await countRows(cfg, 'scanner_observations', observationDayFilters(day));
    if (rows.length !== count) fail(`${day}: 읽은 행 ${rows.length} ≠ DB 행 수 ${count} (쓰지 않음)`);
    const gz = gzipFile(toCsv(EXPORT_COLUMNS, rows));
    console.log(`observations ${day}: ${rows.length} rows, ${gz.bytes} B`);
    dayFiles++;
    if (!dryRun) write({ dataset: 'observations', day, path: pathFor('observations', day), rows: rows.length, bytes: gz.bytes, sha256: gz.sha256 }, gz.data);
    written++;
  }

  // 2) Registry 변경 이벤트 — 날짜별 CSV.gz
  for (const day of chgPlan.todo.slice(0, maxDays)) {
    const rows = await fetchRegistryChangesDay(cfg, day);
    const count = await countRows(cfg, 'registry_changes', [['detected_on', `eq.${day}`]]);
    if (rows.length !== count) fail(`registry_changes ${day}: 읽은 행 ${rows.length} ≠ DB 행 수 ${count} (쓰지 않음)`);
    const gz = gzipFile(toCsv(REGISTRY_CHANGE_COLUMNS, rows));
    console.log(`registry_changes ${day}: ${rows.length} rows, ${gz.bytes} B`);
    dayFiles++;
    if (!dryRun) write({ dataset: 'registry_changes', day, path: pathFor('registry_changes', day), rows: rows.length, bytes: gz.bytes, sha256: gz.sha256 }, gz.data);
    written++;
  }

  // 3) Registry 상태 스냅샷 — 매달 1회 (변경 이벤트만으로는 기준선을 복원할 수 없으므로)
  const snapDay = snapshotDue(manifest, now);
  if (snapDay && !exists(pathFor('registry_state_snapshot', snapDay))) {
    const rows = await fetchRegistryState(cfg);
    const count = await countRows(cfg, 'registry_state', []);
    if (rows.length === 0) console.log('registry_state snapshot: 0 rows (skip)');
    else if (rows.length !== count) console.log(`::warning::registry_state snapshot: 읽은 행 ${rows.length} ≠ DB ${count} (Scanner 실행 중일 수 있음, 다음 실행에서 다시)`);
    else {
      const gz = gzipFile(toCsv(STATE_COLUMNS, rows as unknown as Array<Record<string, unknown>>));
      console.log(`registry_state snapshot ${snapDay}: ${rows.length} rows, ${gz.bytes} B`);
      if (!dryRun) write({ dataset: 'registry_state_snapshot', day: snapDay, path: pathFor('registry_state_snapshot', snapDay), rows: rows.length, bytes: gz.bytes, sha256: gz.sha256 }, gz.data);
      written++;
    }
  }

  // 4) 점검: 최근 보관한 관찰 날의 DB 행 수가 MANIFEST 와 같은지 (보관 뒤 DB 가 바뀌었는지)
  const recent = manifest.filter((e) => e.dataset === 'observations').sort((a, b) => b.day.localeCompare(a.day)).slice(0, AUDIT_DAYS);
  let mismatch = 0;
  for (const e of recent) {
    const count = await countRows(cfg, 'scanner_observations', observationDayFilters(e.day));
    if (count !== e.rows) {
      mismatch++;
      console.log(`::warning::audit ${e.day}: MANIFEST ${e.rows} rows, DB now ${count} rows (보관 파일은 바꾸지 않음)`);
    }
  }

  const left = obsPlan.todo.length + chgPlan.todo.length - dayFiles;
  console.log(`archive done: written ${written}${dryRun ? ' (dry-run, not written)' : ''}, remaining ${Math.max(0, left)}, audit_mismatch ${mismatch}`);
  setOutput('written', written);
  setOutput('audit_mismatch', mismatch);
}

main().catch((e: unknown) => {
  fail(e instanceof Error ? e.message : 'archive failed');
});
