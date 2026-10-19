// 날짜별 보관(archive): 공개 데이터의 영구 원본.
//   - 닫힌 날(UTC, 오늘 이전)마다 파일 1개(CSV.gz). 한 번 쓴 파일은 다시 쓰지 않는다.
//   - MANIFEST.csv 에 파일마다 행 수·바이트·SHA-256 을 남긴다. 쓰기 전에 DB 행 수와 대조한다.
//   - 행이 0인 날도 헤더만 있는 파일을 남겨 "확인했고 0건"을 기록한다.
// 순수 함수(계획·직렬화)와 DB 입출력을 분리해 테스트한다.

import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { csvEscape, supabaseHeaders, type SupabaseConfig } from './lib.ts';

export type ArchiveDataset = 'observations' | 'registry_changes' | 'registry_state_snapshot' | 'observations_parquet';

export interface ManifestEntry {
  dataset: ArchiveDataset;
  day: string; // YYYY-MM-DD (스냅샷은 찍은 날, parquet 은 YYYY-MM)
  path: string; // 저장소 기준 상대 경로, '/' 구분
  rows: number;
  bytes: number;
  sha256: string;
  written_at: string;
}

export const MANIFEST_FILE = 'MANIFEST.csv';
export const MANIFEST_COLUMNS = ['dataset', 'day', 'path', 'rows', 'bytes', 'sha256', 'written_at'] as const;
const DATASETS: readonly ArchiveDataset[] = ['observations', 'registry_changes', 'registry_state_snapshot', 'observations_parquet'];

// 보관 시작일: 관찰은 첫 실행일, Registry 변경은 기준선(10/19) 다음 기록부터 존재
export const OBSERVATIONS_FROM = '2026-10-06';
export const REGISTRY_CHANGES_FROM = '2026-10-19';

const DAY = /^\d{4}-\d{2}-\d{2}$/;

export function pathFor(dataset: ArchiveDataset, day: string): string {
  const [y, m] = day.split('-');
  switch (dataset) {
    case 'observations':
      return `scanner_observations/daily/${y}/${m}/${day}.csv.gz`;
    case 'registry_changes':
      return `registry_changes/daily/${y}/${m}/${day}.csv.gz`;
    case 'registry_state_snapshot':
      return `registry_state/snapshots/${day}.csv.gz`;
    case 'observations_parquet':
      return `scanner_observations/parquet/${day}.parquet`;
  }
}

/** from 부터 오늘(UTC) 전날까지. 오늘은 아직 닫히지 않았으므로 넣지 않는다. */
export function closedDays(from: string, now: Date): string[] {
  if (!DAY.test(from)) throw new Error(`invalid day: ${from}`);
  const today = now.toISOString().slice(0, 10);
  const out: string[] = [];
  for (let t = Date.parse(`${from}T00:00:00Z`); ; t += 86_400_000) {
    const d = new Date(t).toISOString().slice(0, 10);
    if (d >= today) break;
    out.push(d);
  }
  return out;
}

export function dayRange(day: string): { label: string; start: string; end: string } {
  const start = new Date(`${day}T00:00:00Z`);
  const end = new Date(start.getTime() + 86_400_000);
  return { label: day, start: start.toISOString(), end: end.toISOString() };
}

export function toCsv(columns: readonly string[], rows: ReadonlyArray<Record<string, unknown>>): string {
  const lines = [columns.join(',')];
  for (const r of rows) lines.push(columns.map((c) => csvEscape(r[c])).join(','));
  return `${lines.join('\n')}\n`;
}

/** 같은 입력이면 같은 바이트(gzip 헤더 시각 0) → SHA-256 으로 재현 확인 가능 */
export function gzipFile(text: string): { data: Buffer; bytes: number; sha256: string } {
  const data = gzipSync(Buffer.from(text, 'utf8'), { level: 9 });
  return { data, bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') };
}

// ─────────────────────────────────────────────
// MANIFEST.csv
// ─────────────────────────────────────────────

export function parseManifest(text: string): ManifestEntry[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '');
  if (lines.length === 0) return [];
  if (lines[0] !== MANIFEST_COLUMNS.join(',')) throw new Error('MANIFEST.csv: unexpected header');
  const out: ManifestEntry[] = [];
  for (const [i, line] of lines.slice(1).entries()) {
    const f = line.split(',');
    if (f.length !== MANIFEST_COLUMNS.length) throw new Error(`MANIFEST.csv line ${i + 2}: expected ${MANIFEST_COLUMNS.length} fields`);
    const [dataset, day, path, rows, bytes, sha256, written_at] = f as [string, string, string, string, string, string, string];
    if (!DATASETS.includes(dataset as ArchiveDataset)) throw new Error(`MANIFEST.csv line ${i + 2}: unknown dataset`);
    out.push({ dataset: dataset as ArchiveDataset, day, path, rows: Number(rows), bytes: Number(bytes), sha256, written_at });
  }
  return out;
}

export function serializeManifest(entries: readonly ManifestEntry[]): string {
  const sorted = [...entries].sort((a, b) => (a.dataset === b.dataset ? a.day.localeCompare(b.day) : a.dataset.localeCompare(b.dataset)));
  const lines = [MANIFEST_COLUMNS.join(',')];
  for (const e of sorted) {
    for (const v of [e.dataset, e.day, e.path, e.sha256, e.written_at]) if (v.includes(',')) throw new Error('MANIFEST.csv: comma in value');
    lines.push([e.dataset, e.day, e.path, e.rows, e.bytes, e.sha256, e.written_at].join(','));
  }
  return `${lines.join('\n')}\n`;
}

export interface ArchivePlan {
  todo: string[]; // 새로 쓸 날
  conflicts: string[]; // 파일은 있는데 MANIFEST 에 없거나, MANIFEST 에는 있는데 파일이 없음 → 덮어쓰지 않고 실패
}

/** 닫힌 날 중 아직 보관하지 않은 날. 디스크와 MANIFEST 가 어긋나면 손대지 않고 conflicts 로 돌려준다. */
export function planDays(dataset: ArchiveDataset, days: readonly string[], manifest: readonly ManifestEntry[], fileExists: (path: string) => boolean): ArchivePlan {
  const recorded = new Set(manifest.filter((e) => e.dataset === dataset).map((e) => e.day));
  const todo: string[] = [];
  const conflicts: string[] = [];
  for (const day of days) {
    const p = pathFor(dataset, day);
    const inManifest = recorded.has(day);
    const onDisk = fileExists(p);
    if (inManifest && onDisk) continue;
    if (inManifest !== onDisk) conflicts.push(`${p}: ${inManifest ? 'in MANIFEST but file missing' : 'file exists but not in MANIFEST'}`);
    else todo.push(day);
  }
  return { todo, conflicts };
}

/** 이번 달 스냅샷이 아직 없으면 오늘 날짜로 하나 */
export function snapshotDue(manifest: readonly ManifestEntry[], now: Date): string | null {
  const month = now.toISOString().slice(0, 7);
  const has = manifest.some((e) => e.dataset === 'registry_state_snapshot' && e.day.startsWith(month));
  return has ? null : now.toISOString().slice(0, 10);
}

// ─────────────────────────────────────────────
// DB 입출력
// ─────────────────────────────────────────────

export interface ArchiveIoDeps {
  fetchImpl?: typeof fetch;
  pageSize?: number;
}

/** 조건에 맞는 행 수 (Content-Range 총계). 실패는 throw. */
export async function countRows(cfg: SupabaseConfig, table: string, filters: ReadonlyArray<[string, string]>, deps: ArchiveIoDeps = {}): Promise<number> {
  const f = deps.fetchImpl ?? fetch;
  const qs = new URLSearchParams({ select: '*', limit: '1' });
  for (const [k, v] of filters) qs.append(k, v);
  let res: Response;
  try {
    res = await f(`${cfg.url.replace(/\/+$/, '')}/rest/v1/${table}?${qs.toString()}`, {
      headers: supabaseHeaders(cfg.key, { Accept: 'application/json', Prefer: 'count=exact' }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new Error(`${table} count failed: network`);
  }
  if (!res.ok) throw new Error(`${table} count failed: HTTP ${res.status}`);
  const total = /\/(\d+)\s*$/.exec(res.headers.get('content-range') ?? '')?.[1];
  if (total === undefined) throw new Error(`${table} count failed: no content-range total`);
  return Number.parseInt(total, 10);
}

export function observationDayFilters(day: string): Array<[string, string]> {
  const r = dayRange(day);
  return [
    ['observed_at', `gte.${r.start}`],
    ['observed_at', `lt.${r.end}`],
  ];
}

export const REGISTRY_CHANGE_COLUMNS = ['detected_on', 'detected_at', 'scan_run_id', 'name', 'kind', 'old_value', 'new_value', 'hosts'] as const;

/** 하루치 registry_changes. (detected_on, name, kind) 가 유일하므로 name, kind 순 offset 페이지. */
export async function fetchRegistryChangesDay(cfg: SupabaseConfig, day: string, deps: ArchiveIoDeps = {}): Promise<Array<Record<string, unknown>>> {
  const f = deps.fetchImpl ?? fetch;
  const pageSize = deps.pageSize ?? 1000;
  const base = `${cfg.url.replace(/\/+$/, '')}/rest/v1/registry_changes`;
  const out: Array<Record<string, unknown>> = [];
  for (let offset = 0; ; offset += pageSize) {
    const qs = new URLSearchParams({
      select: REGISTRY_CHANGE_COLUMNS.join(','),
      detected_on: `eq.${day}`,
      order: 'name.asc,kind.asc',
      limit: String(pageSize),
      offset: String(offset),
    });
    let res: Response;
    try {
      res = await f(`${base}?${qs.toString()}`, { headers: supabaseHeaders(cfg.key, { Accept: 'application/json' }), signal: AbortSignal.timeout(30_000) });
    } catch {
      throw new Error('registry_changes read failed: network');
    }
    if (!res.ok) throw new Error(`registry_changes read failed: HTTP ${res.status}`);
    const page = (await res.json()) as Array<Record<string, unknown>>;
    if (!Array.isArray(page)) throw new Error('registry_changes read failed: unexpected response');
    out.push(...page);
    if (page.length < pageSize) break;
  }
  return out;
}
