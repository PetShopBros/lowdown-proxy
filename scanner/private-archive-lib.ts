// 원문 비공개 보관 — 비공개 레포(lowdown-private)에 닫힌 날(UTC)마다 JSONL.gz 1개 + MANIFEST.csv
//   대상: scanner_tool_defs(원문) / scanner_tool_set_versions / scanner_tool_flags. 모두 추가만 되고 고치지 않는 테이블.
//   규칙(공개 보관 archive 와 같음): 한 번 쓴 파일은 다시 쓰지 않는다. DB 행 수와 다르면 쓰지 않는다.
//   추가: 정의는 쓰기 전에 행마다 sha256(body) = def_hash 를 다시 확인한다.
//   주의: lowdown-proxy 는 공개 레포라 Actions 로그도 공개된다. 로그·오류 문구에는 개수·해시만, 원문은 절대 넣지 않는다.

import { createHash } from 'node:crypto';
import { supabaseHeaders, type SupabaseConfig } from './lib.ts';

export type PrivateDataset = 'tool_defs' | 'tool_set_versions' | 'tool_flags';
export const PRIVATE_DATASETS: readonly PrivateDataset[] = ['tool_defs', 'tool_set_versions', 'tool_flags'];
export const PRIVATE_FROM = '2026-10-21'; // 0.5.0 첫 저장일

export interface DatasetSpec {
  table: string;
  /** 하루를 가르는 시각 열 */
  timeColumn: string;
  /** keyset 정렬 키(유일) */
  key: string;
  /** 파일에 쓰는 열 — 순서 고정 */
  columns: readonly string[];
  pageSize: number;
}

export const SPECS: Record<PrivateDataset, DatasetSpec> = {
  tool_defs: {
    table: 'scanner_tool_defs',
    timeColumn: 'first_seen_at',
    key: 'def_hash',
    columns: ['def_hash', 'tool_name', 'body', 'tool_schema_hash', 'tool_desc_hash', 'byte_size', 'first_seen_at', 'first_scan_run_id'],
    pageSize: 500,
  },
  tool_set_versions: {
    table: 'scanner_tool_set_versions',
    timeColumn: 'first_seen_at',
    key: 'tool_set_hash',
    columns: ['tool_set_hash', 'def_hashes', 'tool_count', 'first_seen_at', 'first_scan_run_id'],
    pageSize: 1000,
  },
  tool_flags: {
    table: 'scanner_tool_flags',
    timeColumn: 'created_at',
    key: 'id',
    columns: ['id', 'def_hash', 'rule_id', 'rule_version', 'evidence', 'scan_run_id', 'created_at'],
    pageSize: 1000,
  },
};

export function privatePathFor(dataset: PrivateDataset, day: string): string {
  const [y, m] = day.split('-');
  return `${dataset}/daily/${y}/${m}/${day}.jsonl.gz`;
}

/** 열 순서를 고정한 JSONL. 같은 행이면 같은 바이트. */
export function toJsonl(columns: readonly string[], rows: ReadonlyArray<Record<string, unknown>>): string {
  return rows.map((r) => JSON.stringify(Object.fromEntries(columns.map((c) => [c, r[c] ?? null])))).join('\n') + (rows.length ? '\n' : '');
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** 원문 무결성: sha256(body) 가 def_hash 와 다른 행의 def_hash 목록(원문은 돌려주지 않는다). */
export function integrityFailures(rows: ReadonlyArray<Record<string, unknown>>): string[] {
  const bad: string[] = [];
  for (const r of rows) {
    const body = r.body;
    const h = r.def_hash;
    if (typeof body !== 'string' || typeof h !== 'string' || sha256(body) !== h) bad.push(typeof h === 'string' ? h.slice(0, 16) : '(no hash)');
  }
  return bad;
}

// ─────────────────────────────────────────────
// MANIFEST.csv (공개 보관과 같은 열, dataset 만 다름)
// ─────────────────────────────────────────────

export interface PrivateManifestEntry {
  dataset: PrivateDataset;
  day: string;
  path: string;
  rows: number;
  bytes: number;
  sha256: string;
  written_at: string;
}

const COLUMNS = ['dataset', 'day', 'path', 'rows', 'bytes', 'sha256', 'written_at'] as const;

export function parsePrivateManifest(text: string): PrivateManifestEntry[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '');
  if (lines.length === 0) return [];
  if (lines[0] !== COLUMNS.join(',')) throw new Error('MANIFEST.csv: unexpected header');
  return lines.slice(1).map((line, i) => {
    const f = line.split(',');
    if (f.length !== COLUMNS.length) throw new Error(`MANIFEST.csv line ${i + 2}: expected ${COLUMNS.length} fields`);
    const [dataset, day, path, rows, bytes, sha, at] = f as [string, string, string, string, string, string, string];
    if (!PRIVATE_DATASETS.includes(dataset as PrivateDataset)) throw new Error(`MANIFEST.csv line ${i + 2}: unknown dataset`);
    return { dataset: dataset as PrivateDataset, day, path, rows: Number(rows), bytes: Number(bytes), sha256: sha, written_at: at };
  });
}

export function serializePrivateManifest(entries: readonly PrivateManifestEntry[]): string {
  const sorted = [...entries].sort((a, b) => (a.dataset === b.dataset ? a.day.localeCompare(b.day) : a.dataset.localeCompare(b.dataset)));
  return `${[COLUMNS.join(','), ...sorted.map((e) => [e.dataset, e.day, e.path, e.rows, e.bytes, e.sha256, e.written_at].join(','))].join('\n')}\n`;
}

/** 닫힌 날 중 아직 보관하지 않은 날. 디스크와 MANIFEST 가 어긋나면 conflicts. */
export function planPrivateDays(dataset: PrivateDataset, days: readonly string[], manifest: readonly PrivateManifestEntry[], fileExists: (p: string) => boolean): { todo: string[]; conflicts: string[] } {
  const recorded = new Set(manifest.filter((e) => e.dataset === dataset).map((e) => e.day));
  const todo: string[] = [];
  const conflicts: string[] = [];
  for (const day of days) {
    const p = privatePathFor(dataset, day);
    const inManifest = recorded.has(day);
    const onDisk = fileExists(p);
    if (inManifest && onDisk) continue;
    if (inManifest !== onDisk) conflicts.push(`${p}: ${inManifest ? 'in MANIFEST but file missing' : 'file exists but not in MANIFEST'}`);
    else todo.push(day);
  }
  return { todo, conflicts };
}

// ─────────────────────────────────────────────
// DB 읽기 — 하루치, 유일 키 keyset. 오류 문구에 응답 본문을 넣지 않는다(원문이 섞일 수 있음).
// ─────────────────────────────────────────────

export async function fetchPrivateDay(cfg: SupabaseConfig, spec: DatasetSpec, range: { start: string; end: string }, fetchImpl: typeof fetch = fetch): Promise<Array<Record<string, unknown>>> {
  const base = `${cfg.url.replace(/\/+$/, '')}/rest/v1/${spec.table}`;
  const out: Array<Record<string, unknown>> = [];
  let last: string | number | null = null;
  for (;;) {
    const qs = new URLSearchParams({ select: spec.columns.join(','), order: `${spec.key}.asc`, limit: String(spec.pageSize) });
    qs.append(spec.timeColumn, `gte.${range.start}`);
    qs.append(spec.timeColumn, `lt.${range.end}`);
    if (last !== null) qs.append(spec.key, `gt.${last}`);
    let res: Response;
    try {
      res = await fetchImpl(`${base}?${qs.toString()}`, { headers: supabaseHeaders(cfg.key, { Accept: 'application/json' }), signal: AbortSignal.timeout(60_000) });
    } catch {
      throw new Error(`${spec.table} read failed: network`);
    }
    if (!res.ok) throw new Error(`${spec.table} read failed: HTTP ${res.status}`);
    const page = (await res.json()) as Array<Record<string, unknown>>;
    if (!Array.isArray(page)) throw new Error(`${spec.table} read failed: unexpected response`);
    out.push(...page);
    if (page.length < spec.pageSize) break;
    const k = page[page.length - 1]?.[spec.key];
    if ((typeof k !== 'string' && typeof k !== 'number') || (last !== null && k <= last)) throw new Error(`${spec.table} read: keyset did not advance`);
    last = k;
  }
  return out;
}
