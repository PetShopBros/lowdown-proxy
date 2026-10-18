// Registry 전체 버전 집계 (과거 복원 준비) — DB 를 쓰지 않는다
// 사용: node scanner/registry-backfill.ts --count [--out=<file.json>]
//   GET /v0.1/servers 를 version 파라미터 없이 끝까지 받아 "모든 서버의 모든 버전"을 센다.
//   출력: 총 버전 수, 서버 수, 원격/패키지 구성, 상태별, 최초 게시 월별(신규 서버 수), 버전 수 분포,
//         예상 용량(DB 행 기준 / 원본 JSON gzip 기준). 관측(probe) 가능 여부와 무관하게 전부 센다.
// 선택 환경변수: REGISTRY_URL, BACKFILL_BUDGET_SEC(기본 1800)

import { writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { capHost, DEFAULT_REGISTRY_URL, USER_AGENT } from './lib.ts';

const OFFICIAL_META = 'io.modelcontextprotocol.registry/official';

export interface VersionEntry {
  name: string;
  version: string;
  status: string | null;
  isLatest: boolean | null;
  publishedAt: string | null;
  updatedAt: string | null;
  statusChangedAt: string | null;
  remotes: number;
  packages: number;
  hosts: string[];
  rawBytes: number;
}

export function parseEntry(entry: unknown): VersionEntry | null {
  const e = entry as { server?: Record<string, unknown>; _meta?: Record<string, unknown> } | null;
  const s = e?.server;
  if (!s || typeof s.name !== 'string') return null;
  const m = (e?._meta?.[OFFICIAL_META] ?? {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' ? v : null);
  const remotes = (Array.isArray(s.remotes) ? s.remotes : []) as Array<{ url?: unknown }>;
  const packages = Array.isArray(s.packages) ? s.packages.length : 0;
  return {
    name: s.name,
    version: String(s.version ?? ''),
    status: str(m.status),
    isLatest: typeof m.isLatest === 'boolean' ? m.isLatest : null,
    publishedAt: str(m.publishedAt),
    updatedAt: str(m.updatedAt),
    statusChangedAt: str(m.statusChangedAt),
    remotes: remotes.length,
    packages,
    hosts: [...new Set(remotes.map((r) => (typeof r?.url === 'string' ? capHost(r.url) : null)).filter((h): h is string => h !== null))],
    rawBytes: Buffer.byteLength(JSON.stringify(entry)),
  };
}

export interface CountSummary {
  pages: number;
  versions: number;
  names: number;
  duplicate_name_version: number;
  versions_with_remotes: number;
  versions_packages_only: number;
  versions_neither: number;
  status: Record<string, number>;
  latest_status: Record<string, number>;
  latest_count: number;
  published_min: string | null;
  published_max: string | null;
  missing_published_at: number;
  new_servers_by_month: Record<string, number>;
  versions_by_month: Record<string, number>;
  versions_per_name: { max: number; p50: number; p90: number; p99: number; mean: number };
  top_hosts_new_servers: Array<[string, number]>;
  bytes: { raw_json_avg: number; raw_json_total_mb: number; raw_json_gzip_mb: number; est_db_row_bytes: number; est_db_total_mb: number };
}

function bump(m: Record<string, number>, k: string): void {
  m[k] = (m[k] ?? 0) + 1;
}

function pct(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
}

/** 순수 집계. est_db_row_bytes 는 registry_versions 한 행(요약 컬럼 + 인덱스 여유) 추정치 */
export function summarize(entries: readonly VersionEntry[], pages: number, gzipBytes: number): CountSummary {
  const status: Record<string, number> = {};
  const latestStatus: Record<string, number> = {};
  const byMonth: Record<string, number> = {};
  const newByMonth: Record<string, number> = {};
  const perName = new Map<string, VersionEntry[]>();
  const seen = new Set<string>();
  let dup = 0;
  let withRemotes = 0;
  let pkgOnly = 0;
  let neither = 0;
  let latest = 0;
  let missingPub = 0;
  let pubMin: string | null = null;
  let pubMax: string | null = null;
  let raw = 0;
  for (const e of entries) {
    const key = `${e.name}@${e.version}`;
    if (seen.has(key)) {
      dup++;
      continue;
    }
    seen.add(key);
    raw += e.rawBytes;
    bump(status, e.status ?? 'unknown');
    if (e.isLatest) {
      latest++;
      bump(latestStatus, e.status ?? 'unknown');
    }
    if (e.remotes > 0) withRemotes++;
    else if (e.packages > 0) pkgOnly++;
    else neither++;
    if (e.publishedAt) {
      bump(byMonth, e.publishedAt.slice(0, 7));
      if (!pubMin || e.publishedAt < pubMin) pubMin = e.publishedAt;
      if (!pubMax || e.publishedAt > pubMax) pubMax = e.publishedAt;
    } else missingPub++;
    const list = perName.get(e.name) ?? [];
    list.push(e);
    perName.set(e.name, list);
  }
  const hostNew = new Map<string, number>();
  const counts: number[] = [];
  for (const list of perName.values()) {
    counts.push(list.length);
    const first = list.filter((e) => e.publishedAt).sort((a, b) => (a.publishedAt! < b.publishedAt! ? -1 : 1))[0];
    if (first?.publishedAt) bump(newByMonth, first.publishedAt.slice(0, 7));
    for (const h of first?.hosts ?? []) hostNew.set(h, (hostNew.get(h) ?? 0) + 1);
  }
  counts.sort((a, b) => a - b);
  const versions = seen.size;
  const estRow = 260; // 이름·버전·시각 4개·상태·원격/패키지 요약·해시·호스트 + 튜플/인덱스 여유(추정)
  const sortObj = (o: Record<string, number>) => Object.fromEntries(Object.entries(o).sort((a, b) => (a[0] < b[0] ? -1 : 1)));
  return {
    pages,
    versions,
    names: perName.size,
    duplicate_name_version: dup,
    versions_with_remotes: withRemotes,
    versions_packages_only: pkgOnly,
    versions_neither: neither,
    status,
    latest_status: latestStatus,
    latest_count: latest,
    published_min: pubMin,
    published_max: pubMax,
    missing_published_at: missingPub,
    new_servers_by_month: sortObj(newByMonth),
    versions_by_month: sortObj(byMonth),
    versions_per_name: {
      max: counts[counts.length - 1] ?? 0,
      p50: pct(counts, 0.5),
      p90: pct(counts, 0.9),
      p99: pct(counts, 0.99),
      mean: counts.length ? Math.round((versions / counts.length) * 100) / 100 : 0,
    },
    top_hosts_new_servers: [...hostNew.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 10),
    bytes: {
      raw_json_avg: versions ? Math.round(raw / versions) : 0,
      raw_json_total_mb: Math.round((raw / 1e6) * 10) / 10,
      raw_json_gzip_mb: Math.round((gzipBytes / 1e6) * 10) / 10,
      est_db_row_bytes: estRow,
      est_db_total_mb: Math.round(((versions * estRow) / 1e6) * 10) / 10,
    },
  };
}

/** 모든 버전 페이지를 받는다. 페이지당 재시도(2·4·8·16·32초), 시간 상한, 커서 정체 감지 */
export async function fetchAllVersions(
  opts: { baseUrl?: string; deadline?: number; fetchImpl?: typeof fetch; sleep?: (ms: number) => Promise<void>; pageSize?: number; onPage?: (n: number) => void } = {},
): Promise<{ pages: number; rawPages: string[]; entries: VersionEntry[] }> {
  const base = (opts.baseUrl ?? DEFAULT_REGISTRY_URL).replace(/\/+$/, '');
  const f = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const pageSize = opts.pageSize ?? 100;
  const rawPages: string[] = [];
  const entries: VersionEntry[] = [];
  let cursor: string | undefined;
  let pages = 0;
  for (;;) {
    if (opts.deadline !== undefined && Date.now() > opts.deadline) throw new Error(`time budget exceeded after ${pages} pages`);
    const qs = new URLSearchParams({ limit: String(pageSize) });
    if (cursor) qs.set('cursor', cursor);
    let text = '';
    for (let attempt = 1; ; attempt++) {
      let status = 0;
      try {
        const res = await f(`${base}/v0.1/servers?${qs.toString()}`, { headers: { Accept: 'application/json', 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(30_000) });
        status = res.status;
        if (res.ok) {
          text = await res.text();
          break;
        }
      } catch {
        // 재시도
      }
      if (!(status === 0 || status >= 500 || status === 429) || attempt >= 6) throw new Error(`page ${pages + 1} failed (HTTP ${status || 'network'})`);
      await sleep(1000 * 2 ** attempt);
    }
    const page = JSON.parse(text) as { servers?: unknown[]; metadata?: { nextCursor?: unknown } };
    if (!Array.isArray(page.servers)) throw new Error('unexpected response shape (no servers[])');
    pages++;
    rawPages.push(text);
    for (const s of page.servers) {
      const e = parseEntry(s);
      if (e) entries.push(e);
    }
    opts.onPage?.(pages);
    const next = page.metadata?.nextCursor;
    if (typeof next !== 'string' || next.length === 0) break;
    if (next === cursor) throw new Error('pagination did not advance');
    cursor = next;
  }
  return { pages, rawPages, entries };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (!args.includes('--count')) {
    console.error('사용법: node scanner/registry-backfill.ts --count [--out=<file.json>]  (DB 쓰기 없음)');
    process.exit(1);
  }
  const out = args.find((a) => a.startsWith('--out='))?.slice('--out='.length);
  const budget = Number.parseInt(process.env.BACKFILL_BUDGET_SEC?.trim() || '1800', 10);
  const t0 = Date.now();
  const { pages, rawPages, entries } = await fetchAllVersions({
    baseUrl: process.env.REGISTRY_URL?.trim() || undefined,
    deadline: Date.now() + budget * 1000,
    onPage: (n) => {
      if (n % 50 === 0) console.log(`pages ${n} (${Math.round((Date.now() - t0) / 1000)}s)`);
    },
  });
  const gz = gzipSync(Buffer.from(rawPages.join('\n'))).length;
  const summary = summarize(entries, pages, gz);
  console.log(JSON.stringify({ elapsed_sec: Math.round((Date.now() - t0) / 1000), ...summary }, null, 2));
  if (out) writeFileSync(out, JSON.stringify(summary, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('registry-backfill.ts')) {
  main().catch((e: unknown) => {
    console.error(`::error::${e instanceof Error ? e.message : 'failed'}`);
    process.exit(1);
  });
}
