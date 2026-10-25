// Lowdown 시장판 3단계 — 일일 기록 페이지·피드 생성 → <dataRepoDir>/docs (GitHub Pages: main /docs)
// 사용: node scanner/market.ts <dataRepoDir>
// 필수 환경변수: LOWDOWN_SUPABASE_URL, LOWDOWN_SCANNER_KEY (읽기만 한다)
// 선택: MARKET_BASE_URL(기본 https://petshopbros.github.io/lowdown-data/), MARKET_API_BASE(기본 https://lowdown-proxy.vercel.app)
// 안전장치
//   - REPORT.md 와 같은 기준: 최신 run 이 코호트의 절반 미만이면(부분 실행) 아무것도 쓰지 않고 실패한다.
//   - 하루 JSON 이 유일한 원본. 같은 데이터로 다시 돌리면 같은 바이트(커밋 없음). 더 새로운 날짜가 있으면 과거 날짜는 고치지 않는다.
//   - HTML·RSS·JSON Feed·sitemap 은 디스크의 하루 JSON 들에서만 다시 만든다.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fetchRegistryChangesDay } from './archive-lib.ts';
import { fetchCohort, supabaseHeaders } from './lib.ts';
import type { SupabaseConfig } from './lib.ts';
import { applyCorrection, buildDay, declaredKey, dayWriteDecision, packageSide, parseDay, registryCoversSince, renderSite, serializeDay, toolDefinitionSection } from './market-lib.ts';
import type { DefRowInput, FirstSeenInput, MarketDay, ObservationSummary, PackageChangeInput, PackagesSection, RegistryChangeInput } from './market-lib.ts';
import { getKeyset } from './npm-lib.ts';
import { parseDeclared } from './pages-lib.ts';
import { buildReport, fetchReportRows, MIN_RUN_COVERAGE, WINDOW_DAYS } from './report-lib.ts';
import type { ReportRow } from './report-lib.ts';

function fail(message: string): never {
  console.error(`::error::${message}`);
  process.exit(1);
}

async function getAll<T>(cfg: SupabaseConfig, table: string, params: Record<string, string>, keyset: boolean): Promise<T[]> {
  const base = `${cfg.url.replace(/\/+$/, '')}/rest/v1/${table}`;
  const out: T[] = [];
  const pageSize = 1000;
  let lastId = 0;
  for (let offset = 0; ; offset += pageSize) {
    const qs = new URLSearchParams({ ...params, limit: String(pageSize) });
    if (keyset) {
      qs.set('id', `gt.${lastId}`);
      qs.set('order', 'id.asc');
    } else qs.set('offset', String(offset));
    const res = await fetch(`${base}?${qs.toString()}`, { headers: supabaseHeaders(cfg.key, { Accept: 'application/json' }), signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`${table} read failed: HTTP ${res.status}`);
    const page = (await res.json()) as Array<T & { id?: number }>;
    if (!Array.isArray(page)) throw new Error(`${table} read failed: unexpected response`);
    out.push(...page);
    if (page.length < pageSize) break;
    if (keyset) {
      const last = page[page.length - 1]?.id;
      if (typeof last !== 'number' || last <= lastId) throw new Error(`${table} read: keyset did not advance`);
      lastId = last;
    }
  }
  return out;
}

function summarize(rows: readonly ReportRow[], cohortVersion: string, cohortSize: number): ObservationSummary {
  const attempts = rows.filter((r) => r.error_type !== 'blocked_url');
  const reached = { '0': 0, '1': 0, '2': 0 };
  for (const r of attempts) if (r.reached_level === 0 || r.reached_level === 1 || r.reached_level === 2) reached[String(r.reached_level) as '0' | '1' | '2']++;
  return { cohort_version: cohortVersion, cohort_size: cohortSize, targets_observed: new Set(rows.map((r) => r.target_id)).size, probe_attempts: attempts.length, reached_level: reached };
}

function writeIfChanged(path: string, text: string): boolean {
  if (existsSync(path) && readFileSync(path, 'utf8') === text) return false;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  return true;
}

const MIN_REGISTRY_ACTIVE = 1000;

/** 그날(UTC) 스냅샷이 돌았는가: 그날 확인한 상태 행이 하나라도 있으면 돈 것으로 본다 */
async function snapshotRan(cfg: SupabaseConfig, table: string, day: string, next: string): Promise<boolean> {
  const qs = new URLSearchParams({ select: 'ident', and: `(checked_at.gte.${day}T00:00:00Z,checked_at.lt.${next}T00:00:00Z)`, limit: '1' });
  const res = await fetch(`${cfg.url.replace(/\/+$/, '')}/rest/v1/${table}?${qs.toString()}`, { headers: supabaseHeaders(cfg.key, { Accept: 'application/json' }), signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`${table} read failed: HTTP ${res.status}`);
  const rows = (await res.json()) as unknown[];
  return Array.isArray(rows) && rows.length > 0;
}

/**
 * 선언 패키지 섹션: 시장판 날짜(day)의 전날(UTC) npm·PyPI 스냅샷 변화 중 지금 Registry 항목이 선언한 패키지만.
 * 읽기 실패면 섹션을 싣지 않는다(다른 섹션은 그대로). 0 을 "변화 없음"으로 싣지 않기 위해서다.
 */
async function packagesSection(cfg: SupabaseConfig, day: string): Promise<PackagesSection | null> {
  const snap = new Date(Date.parse(`${day}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
  try {
    const entries = await getKeyset<{ name: string; packages_key: string | null; removed_at: string | null } & Record<string, unknown>>(cfg, 'registry_state', 'name,packages_key,removed_at', 'name', [], {});
    const active = entries.filter((e) => e.removed_at === null);
    if (active.length < MIN_REGISTRY_ACTIVE) throw new Error(`active Registry entries ${active.length} < ${MIN_REGISTRY_ACTIVE}`);
    const declaredBy = new Map<string, string[]>();
    for (const e of active) {
      for (const p of parseDeclared(e.packages_key)) {
        const k = declaredKey(p.registry_type, p.identifier);
        (declaredBy.get(k) ?? declaredBy.set(k, []).get(k)!).push(e.name);
      }
    }
    const sel = 'id,ident,kind,old_value,new_value';
    const npmRows = await getAll<PackageChangeInput>(cfg, 'npm_package_changes', { select: sel, detected_on: `eq.${snap}` }, true);
    const pypiRows = await getAll<PackageChangeInput>(cfg, 'pypi_package_changes', { select: sel, detected_on: `eq.${snap}` }, true);
    const npmRan = await snapshotRan(cfg, 'npm_package_state', snap, day);
    const pypiRan = await snapshotRan(cfg, 'pypi_package_state', snap, day);
    const out: PackagesSection = {
      snapshot_day: snap,
      npm: packageSide('npm', npmRows, declaredBy, npmRan || npmRows.length > 0),
      pypi: packageSide('pypi', pypiRows, declaredBy, pypiRan || pypiRows.length > 0),
    };
    console.log(`packages ${snap}: npm ${out.npm.compared ? `${out.npm.events.length} facts, ${out.npm.latest_changed} new versions` : 'not compared'}; pypi ${out.pypi.compared ? `${out.pypi.events.length} facts, ${out.pypi.latest_changed} new versions` : 'not compared'}`);
    return out;
  } catch (e) {
    console.log(`::warning::packages section skipped: ${e instanceof Error ? e.message : 'read failed'}`);
    return null;
  }
}

async function main(): Promise<void> {
  const repoDir = process.argv[2];
  if (!repoDir || repoDir.startsWith('--')) fail('사용법: node scanner/market.ts <dataRepoDir>');
  const url = process.env.LOWDOWN_SUPABASE_URL?.trim();
  const key = process.env.LOWDOWN_SCANNER_KEY?.trim();
  if (!url || !key) fail('LOWDOWN_SUPABASE_URL / LOWDOWN_SCANNER_KEY 가 없습니다.');
  const cfg = { url, key };
  const site = {
    baseUrl: (process.env.MARKET_BASE_URL?.trim() || 'https://petshopbros.github.io/lowdown-data/').replace(/\/?$/, '/'),
    apiBase: (process.env.MARKET_API_BASE?.trim() || 'https://lowdown-proxy.vercel.app').replace(/\/+$/, ''),
  };
  const docs = join(repoDir, 'docs');

  // 1) 최신 run — REPORT.md 와 같은 안전장치(부분 실행이면 buildReport 가 throw)
  const now = new Date();
  const rows = await fetchReportRows(cfg, new Date(now.getTime() - WINDOW_DAYS * 86_400_000).toISOString());
  if (rows.length === 0) fail(`최근 ${WINDOW_DAYS}일 안에 관찰 행이 없습니다.`);
  const byRun = new Map<string, ReportRow[]>();
  for (const r of rows) (byRun.get(r.scan_run_id) ?? byRun.set(r.scan_run_id, []).get(r.scan_run_id)!).push(r);
  const runs = [...byRun.entries()]
    .map(([id, g]) => ({ id, rows: g, start: g.reduce((m, r) => (r.observed_at < m ? r.observed_at : m), g[0]!.observed_at), end: g.reduce((m, r) => (r.observed_at > m ? r.observed_at : m), g[0]!.observed_at) }))
    .sort((a, b) => (a.end < b.end ? -1 : 1));
  const latest = runs.at(-1)!;
  const version = (rs: readonly ReportRow[]) => {
    const c = new Map<string, number>();
    for (const r of rs) if (r.cohort_version) c.set(r.cohort_version, (c.get(r.cohort_version) ?? 0) + 1);
    return [...c.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? null;
  };
  const curVersion = version(latest.rows);
  if (!curVersion) fail('최신 run 에서 cohort_version 을 찾을 수 없습니다.');
  const cohortIds = await fetchCohort(cfg, curVersion);
  buildReport(rows, cohortIds, curVersion, null, now); // 부분 실행·빈 코호트면 throw
  const current = summarize(latest.rows, curVersion, cohortIds.length);

  // 직전 run: 자기 코호트의 절반 이상을 관찰한 가장 최근 run
  let previous: { run: (typeof runs)[number]; summary: ObservationSummary } | null = null;
  for (let i = runs.length - 2; i >= 0 && !previous; i--) {
    const run = runs[i]!;
    const v = version(run.rows);
    if (!v) continue;
    const size = v === curVersion ? cohortIds.length : (await fetchCohort(cfg, v)).length;
    const s = summarize(run.rows, v, size);
    if (size > 0 && s.targets_observed >= Math.ceil(size * MIN_RUN_COVERAGE)) previous = { run, summary: s };
  }

  // Registry 비교는 실행 시작 시 받은 목록 기준이라 날짜는 실행 시작일(UTC)
  const day = latest.start.slice(0, 10);

  // 2) 사실 종류별 입력
  // 그날 Registry 목록을 받지 못했으면(fallback) 비교를 건너뛴 날이다 — 0 을 "변경 없음"으로 싣지 않는다
  const fbQs = new URLSearchParams({ select: 'registry_fallback:metadata->>registry_fallback', scan_run_id: `eq.${latest.id}`, source: 'eq.scanner', limit: '1' });
  const fbRes = await fetch(`${cfg.url.replace(/\/+$/, '')}/rest/v1/scanner_observations?${fbQs.toString()}`, {
    headers: supabaseHeaders(cfg.key, { Accept: 'application/json' }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!fbRes.ok) throw new Error(`scanner_observations read failed: HTTP ${fbRes.status}`);
  const fb = (await fbRes.json()) as Array<{ registry_fallback: string | null }>;
  const registryCompared = !(Array.isArray(fb) && fb[0]?.registry_fallback === 'true');
  const registryRows = registryCompared ? await fetchRegistryChangesDay(cfg, day) : [];
  const firstSeenRows = await getAll<FirstSeenInput>(cfg, 'scanner_first_seen', { select: 'id,kind,value,hosts,namespaces', first_seen_on: `eq.${day}`, baseline: 'is.false' }, true);
  let toolDefinitions = null;
  if (previous) {
    const sel = 'id,target_id,reached_level,remote_url:metadata->>remote_url,desc_hash:metadata->>desc_hash,schema_hash:metadata->>schema_hash';
    const cur = await getAll<DefRowInput>(cfg, 'scanner_observations', { select: sel, scan_run_id: `eq.${latest.id}`, source: 'eq.scanner' }, true);
    const prev = await getAll<DefRowInput>(cfg, 'scanner_observations', { select: sel, scan_run_id: `eq.${previous.run.id}`, source: 'eq.scanner' }, true);
    toolDefinitions = toolDefinitionSection(cur, prev, previous.run.end);
  }

  const packages = await packagesSection(cfg, day);

  const daysDirEarly = join(docs, 'days');
  const priorDays: MarketDay[] = existsSync(daysDirEarly)
    ? readdirSync(daysDirEarly)
        .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f) && f.slice(0, 10) < day)
        .map((f) => applyCorrection(parseDay(readFileSync(join(daysDirEarly, f), 'utf8'))))
    : [];
  const d = buildDay({
    day,
    dataAsOf: latest.end,
    scanRunId: latest.id,
    registryRows: registryRows as unknown as RegistryChangeInput[],
    observations: { current, previous: previous?.summary ?? null },
    toolDefinitions,
    firstSeenRows,
    siteBaseUrl: site.baseUrl,
    registryCompared,
    registryCoversSince: registryCoversSince(priorDays, day),
    ...(packages ? { packages } : {}),
  });
  if (!registryCompared) console.log(`::warning::market day ${day}: Registry not compared (registry fallback)`);

  // 3) 하루 JSON (멱등, 과거 날짜 잠금)
  const daysDir = join(docs, 'days');
  mkdirSync(daysDir, { recursive: true });
  const existingDays = readdirSync(daysDir).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).map((f) => f.slice(0, 10));
  const dayPath = join(daysDir, `${day}.json`);
  const nextText = serializeDay(d);
  const decision = dayWriteDecision(day, existingDays, existsSync(dayPath) ? readFileSync(dayPath, 'utf8') : null, nextText);
  if (decision === 'write') writeFileSync(dayPath, nextText);
  console.log(`market day ${day}: ${decision} (run ${latest.id}, data_as_of ${latest.end})`);

  // 3b) 명시적 정정(DAY_CORRECTIONS)만 잠긴 과거 날짜에 반영한다. 정정 기록이 그 날 JSON 에 함께 남는다.
  for (const f of readdirSync(daysDir).filter((x) => /^\d{4}-\d{2}-\d{2}\.json$/.test(x))) {
    const path = join(daysDir, f);
    const text = readFileSync(path, 'utf8');
    const fixed = serializeDay(applyCorrection(parseDay(text)));
    if (fixed !== text) {
      writeFileSync(path, fixed);
      console.log(`market day ${f.slice(0, 10)}: correction applied`);
    }
  }

  // 4) 사이트 전체를 하루 JSON 들에서만 다시 만든다
  const all: MarketDay[] = readdirSync(daysDir)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .map((f) => parseDay(readFileSync(join(daysDir, f), 'utf8')));
  let changed = 0;
  for (const [rel, text] of renderSite(all, site)) if (writeIfChanged(join(docs, rel), text)) changed++;
  console.log(`market site: ${all.length} days, ${changed} files changed, base ${site.baseUrl}`);
}

main().catch((e: unknown) => fail(e instanceof Error ? e.message : 'market failed'));
