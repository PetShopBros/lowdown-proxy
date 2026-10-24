// Lowdown 서버별 관측 페이지(B유형) 생성 → <pagesRepoDir>/docs (GitHub Pages: main /docs)
// 사용: node scanner/pages.ts <pagesRepoDir> [--dry-run]
// 필수 환경변수: LOWDOWN_SUPABASE_URL, LOWDOWN_SCANNER_KEY (읽기만 한다)
// 선택: PAGES_BASE_URL(기본 https://petshopbros.github.io/lowdown-pages/), MARKET_API_BASE(기본 https://lowdown-proxy.vercel.app),
//       MARKET_BASE_URL(기본 https://petshopbros.github.io/lowdown-data/)
// 안전장치
//   - 읽은 행 수가 비정상적으로 적으면(읽기 실패 의심) 아무것도 쓰지 않고 실패한다.
//   - 사실이 있는 서버 수가 직전 servers.json 의 절반 미만으로 떨어지면 실패한다(데이터 문제 의심).
//   - 이미 있는 페이지는 지우지 않는다. 소문자 주소가 겹치면 실패한다.
//   - 바뀐 파일만 쓴다. 같은 데이터면 servers.json 외에는 바이트가 같다.

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { supabaseHeaders, type SupabaseConfig } from './lib.ts';
import { fetchNpmState, getKeyset, type NpmChangeRow } from './npm-lib.ts';
import { lastCheckedDates, planSite, renderIndexJson, SERVER_SCHEMA, type RegistryChangeRow, type RegistryEntryRow } from './pages-lib.ts';
import { fetchPypiState, type PypiChangeRow } from './pypi-lib.ts';

const MIN_REGISTRY_ACTIVE = 1000;
const MIN_NPM_STATE = 1000;
const MIN_PYPI_STATE = 100;
const MIN_KEEP_SHARE = 0.5;

function fail(message: string): never {
  console.error(`::error::${message}`);
  process.exit(1);
}

/** id(숫자) keyset 으로 전체 읽기 */
async function getById<T extends { id: number }>(cfg: SupabaseConfig, table: string, select: string): Promise<T[]> {
  const base = `${cfg.url.replace(/\/+$/, '')}/rest/v1/${table}`;
  const out: T[] = [];
  let lastId = 0;
  for (;;) {
    const qs = new URLSearchParams({ select, id: `gt.${lastId}`, order: 'id.asc', limit: '1000' });
    const res = await fetch(`${base}?${qs.toString()}`, { headers: supabaseHeaders(cfg.key, { Accept: 'application/json' }), signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`${table} read failed: HTTP ${res.status}`);
    const page = (await res.json()) as T[];
    if (!Array.isArray(page)) throw new Error(`${table} read failed: unexpected response`);
    out.push(...page);
    if (page.length < 1000) break;
    const last = page[page.length - 1]!.id;
    if (typeof last !== 'number' || last <= lastId) throw new Error(`${table} read: keyset did not advance`);
    lastId = last;
  }
  return out;
}

function walkJson(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walkJson(p));
    else if (e.isFile() && e.name.endsWith('.json')) out.push(p);
  }
  return out;
}

function dirBytes(dir: string): number {
  if (!existsSync(dir)) return 0;
  let n = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    n += e.isDirectory() ? dirBytes(p) : statSync(p).size;
  }
  return n;
}

function writeIfChanged(path: string, text: string): boolean {
  if (existsSync(path) && readFileSync(path, 'utf8') === text) return false;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  return true;
}

async function main(): Promise<void> {
  const repoDir = process.argv[2];
  if (!repoDir || repoDir.startsWith('--')) fail('사용법: node scanner/pages.ts <pagesRepoDir> [--dry-run]');
  const dryRun = process.argv.includes('--dry-run');
  const url = process.env.LOWDOWN_SUPABASE_URL?.trim();
  const key = process.env.LOWDOWN_SCANNER_KEY?.trim();
  if (!url || !key) fail('LOWDOWN_SUPABASE_URL / LOWDOWN_SCANNER_KEY 가 없습니다.');
  const cfg = { url, key };
  const site = {
    baseUrl: (process.env.PAGES_BASE_URL?.trim() || 'https://petshopbros.github.io/lowdown-pages/').replace(/\/?$/, '/'),
    apiBase: (process.env.MARKET_API_BASE?.trim() || 'https://lowdown-proxy.vercel.app').replace(/\/+$/, ''),
    marketUrl: (process.env.MARKET_BASE_URL?.trim() || 'https://petshopbros.github.io/lowdown-data/').replace(/\/?$/, '/'),
  };
  const docs = join(repoDir, 'docs');

  // 1) 이미 있는 페이지(지우지 않는다) + 직전 목록
  const published = new Set<string>();
  for (const f of walkJson(join(docs, 'servers'))) {
    try {
      const j = JSON.parse(readFileSync(f, 'utf8')) as { schema?: string; name?: string };
      if (j.schema === SERVER_SCHEMA && typeof j.name === 'string') published.add(j.name);
    } catch {
      fail(`기존 페이지 JSON 을 읽을 수 없습니다: ${f}`);
    }
  }
  let prevWithFacts: number | null = null;
  const prevIndexPath = join(docs, 'servers.json');
  if (existsSync(prevIndexPath)) {
    const j = JSON.parse(readFileSync(prevIndexPath, 'utf8')) as { with_facts?: unknown };
    if (typeof j.with_facts === 'number') prevWithFacts = j.with_facts;
  }

  // 2) 읽기
  const entries = await getKeyset<RegistryEntryRow & Record<string, unknown>>(cfg, 'registry_state', 'name,version,status,packages_key,first_seen_at,baseline,removed_at', 'name', [], {});
  const npmState = await fetchNpmState(cfg);
  const pypiState = await fetchPypiState(cfg);
  const npmChanges = await getById<NpmChangeRow & { id: number }>(cfg, 'npm_package_changes', 'id,detected_on,ident,kind,old_value,new_value,scan_run_id');
  const pypiChanges = await getById<PypiChangeRow & { id: number }>(cfg, 'pypi_package_changes', 'id,detected_on,ident,kind,old_value,new_value,scan_run_id');
  const registryChanges = await getById<RegistryChangeRow & { id: number }>(cfg, 'registry_changes', 'id,detected_on,name,kind,old_value,new_value');

  const active = entries.filter((e) => e.removed_at === null).length;
  console.log(`read: registry_state ${entries.length} (active ${active}), npm_state ${npmState.length}, pypi_state ${pypiState.length}, npm_changes ${npmChanges.length}, pypi_changes ${pypiChanges.length}, registry_changes ${registryChanges.length}`);
  if (active < MIN_REGISTRY_ACTIVE) fail(`활성 Registry 항목이 ${active}개뿐입니다(최소 ${MIN_REGISTRY_ACTIVE}). 읽기 실패로 보고 멈춥니다.`);
  if (npmState.length < MIN_NPM_STATE) fail(`npm 상태가 ${npmState.length}행뿐입니다(최소 ${MIN_NPM_STATE}).`);
  if (pypiState.length < MIN_PYPI_STATE) fail(`PyPI 상태가 ${pypiState.length}행뿐입니다(최소 ${MIN_PYPI_STATE}).`);

  // 3) 계획
  const plan = planSite({ entries, npmState, pypiState, npmChanges, pypiChanges, registryChanges, published, cfg: site });
  const withFacts = plan.records.filter((r) => r.facts.length > 0).length;
  console.log(`plan: ${plan.records.length} pages (new-or-current with facts ${plan.qualifying}, kept from before ${plan.keptFromBefore}), skipped names ${plan.skippedNames}`);
  const byCode = new Map<string, number>();
  for (const r of plan.records) for (const c of new Set(r.facts.map((f) => f.code))) byCode.set(c, (byCode.get(c) ?? 0) + 1);
  console.log(`facts: ${[...byCode.entries()].map(([k, v]) => `${k}=${v}`).join(', ') || '(none)'}`);
  if (prevWithFacts !== null && prevWithFacts > 0 && withFacts < Math.ceil(prevWithFacts * MIN_KEEP_SHARE)) {
    fail(`사실이 있는 서버가 ${prevWithFacts} → ${withFacts} 로 절반 미만이 됐습니다. 데이터 문제로 보고 멈춥니다.`);
  }

  const { byName, dataAsOf } = lastCheckedDates(plan.records, npmState, pypiState);
  plan.files.set('servers.json', renderIndexJson(plan.records, byName, dataAsOf));
  plan.files.set('.nojekyll', '');

  if (dryRun) {
    const bytes = [...plan.files.values()].reduce((n, t) => n + Buffer.byteLength(t), 0);
    console.log(`dry-run: ${plan.files.size} files, ${(bytes / 1048576).toFixed(2)} MB (nothing written)`);
    return;
  }

  // 4) 쓰기(바뀐 파일만)
  let changed = 0;
  for (const [rel, text] of plan.files) if (writeIfChanged(join(docs, rel), text)) changed++;
  console.log(`pages site: ${plan.files.size} files, ${changed} changed, docs ${(dirBytes(docs) / 1048576).toFixed(2)} MB, base ${site.baseUrl}`);
}

main().catch((e: unknown) => fail(e instanceof Error ? e.message : 'pages failed'));
