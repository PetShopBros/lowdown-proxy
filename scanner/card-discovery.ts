// 명함(카드) 확인 — 사용: node scanner/card-discovery.ts [--dry-run] [--force] [--slice=0..6] [--limit=N]
// 필수 환경변수: LOWDOWN_SUPABASE_URL, LOWDOWN_SCANNER_KEY
// 선택: CARD_CONCURRENCY(기본 16), CARD_TIME_BUDGET_MIN(기본 40), CARD_TIMEOUT_MS(기본 8000), CARD_QUIET_TIMEOUT_MS(기본 3000), CARD_HOST_GAP_MS(기본 250)
//
// 하루에 호스트(origin) 7분의 1씩 → 호스트마다 주 1회. 같은 호스트에는 요청을 차례로, 간격을 두고 보낸다.
// 쓰는 곳: card_endpoint_checks·card_host_checks(사실), card_check_changes(바뀐 때만), card_bodies(찾은 원문, sha256당 1번),
//          card_declarations(찾은 카드의 선언 → pg_cron 이 subject_links 로), card_runs(실행 기록).
// 기존 관찰(scanner_observations)에는 쓰지 않는다. DB 에 무거운 집계를 보내지 않는다(대상은 card_targets 를 id 순서로 페이지 단위).

import { appendFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { supabaseHeaders, type SupabaseConfig } from './lib.ts';
import { postBatches } from './registry-diff.ts';
import { pool } from './erc8004-lib.ts';
import {
  HOST_PATHS,
  SHARED_HOST_MIN,
  baseResult,
  carryDates,
  changed,
  endpointCardUrl,
  fetchCard,
  hostOf,
  normList,
  originOf,
  parseA2aCard,
  parseAiCatalog,
  parseServerCard,
  sliceForDay,
  sliceOf,
  type CardKind,
  type CheckResult,
  type Fetched,
} from './card-lib.ts';

function fail(message: string): never {
  console.error(`::error::${message}`);
  process.exit(1);
}
const intEnv = (name: string, dflt: number) => {
  const v = Number(process.env[name]);
  return Number.isInteger(v) && v > 0 ? v : dflt;
};
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function dbGet<T>(cfg: SupabaseConfig, path: string): Promise<T[]> {
  const res = await fetch(`${cfg.url.replace(/\/+$/, '')}/rest/v1/${path}`, { headers: supabaseHeaders(cfg.key, { Accept: 'application/json' }), signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`${path.split('?')[0]} read failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  return (await res.json()) as T[];
}

async function dbPatch(cfg: SupabaseConfig, path: string, body: object): Promise<void> {
  const res = await fetch(`${cfg.url.replace(/\/+$/, '')}/rest/v1/${path}`, {
    method: 'PATCH',
    headers: supabaseHeaders(cfg.key, { 'Content-Type': 'application/json', Prefer: 'return=minimal' }),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`${path.split('?')[0]} update failed: HTTP ${res.status}`);
}

type Target = { endpoint_id: number; endpoint: string; registry_names: string[]; quiet: boolean };

export interface OriginWork {
  origin: string;
  host: string;
  slice: number;
  shared: boolean;
  endpoints: Target[];
  quiet: boolean; // 이 호스트의 주소가 모두 오래 응답 없음
}

/** 대상 → 호스트(origin)별 묶음. 공용 호스트는 호스트 이름 기준 주소 수로 정한다(포트가 달라도 같은 호스트). */
export function groupTargets(targets: readonly Target[]): OriginWork[] {
  const perHost = new Map<string, number>();
  const byOrigin = new Map<string, OriginWork>();
  for (const t of targets) {
    const origin = originOf(t.endpoint);
    if (!origin || !origin.startsWith('https://')) continue;
    const host = hostOf(origin);
    perHost.set(host, (perHost.get(host) ?? 0) + 1);
    let w = byOrigin.get(origin);
    if (!w) byOrigin.set(origin, (w = { origin, host, slice: sliceOf(origin), shared: false, endpoints: [], quiet: true }));
    w.endpoints.push(t);
    w.quiet = w.quiet && t.quiet;
  }
  for (const w of byOrigin.values()) w.shared = (perHost.get(w.host) ?? 0) >= SHARED_HOST_MIN;
  return [...byOrigin.values()].sort((a, b) => a.origin.localeCompare(b.origin));
}

export interface Declaration {
  card_url: string;
  kind: CardKind;
  origin: string;
  claimed_name: string | null;
  endpoints: Array<{ url: string; type: string | null; versions: string[] }>;
  interfaces: Array<{ url: string; binding: string | null }>;
  sha256: string | null;
  observed_at: string;
}

export interface OriginOutcome {
  host: Record<string, unknown>;
  endpoints: Array<Record<string, unknown>>;
  changes: Array<Record<string, unknown>>;
  bodies: Array<{ sha256: string; kind: CardKind; bytes: number; body: string }>;
  declarations: Declaration[];
  requests: number;
}

type Fetcher = (url: string, kind: CardKind) => Promise<Fetched>;

/** 호스트 하나: 도메인 카드 3종 → 주소마다 server-card. 같은 호스트에는 차례로. */
export async function checkOrigin(
  w: OriginWork,
  prevHost: Record<string, any> | null,
  prevEndpoints: Map<string, Record<string, any>>,
  fetcher: Fetcher,
  nowIso: string,
  runId: string,
  gap: () => Promise<void> = async () => {},
): Promise<OriginOutcome> {
  const out: OriginOutcome = { host: {}, endpoints: [], changes: [], bodies: [], declarations: [], requests: 0 };
  const get = async (url: string, kind: CardKind) => {
    if (out.requests > 0) await gap();
    out.requests++;
    return fetcher(url, kind);
  };
  const keepBody = (kind: CardKind, f: Fetched) => {
    if (f.outcome === 'found' && f.text && f.sha256 && !out.bodies.some((b) => b.sha256 === f.sha256)) out.bodies.push({ sha256: f.sha256, kind, bytes: f.bytes ?? 0, body: f.text });
  };
  const record = (key: string, prev: Record<string, any> | null | undefined, cur: CheckResult) => {
    const withDates = carryDates(prev, cur, nowIso);
    // 변경 기록: 이전 결과와 다를 때. 첫 확인은 기준선(확인 표 자체)이라 찾은 카드만 남긴다 — 없는 카드 수만 건을 쌓지 않는다.
    if (prev ? changed(prev, cur) : cur.outcome === 'found') {
      out.changes.push({ url: cur.url, kind: cur.kind, observed_at: nowIso, from_outcome: prev?.outcome ?? null, to_outcome: cur.outcome, from_sha256: prev?.sha256 ?? null, to_sha256: cur.sha256 ?? null, run_id: runId });
    }
    void key;
    return withDates;
  };
  /** 경로 후보를 차례로: not_found 일 때만 다음 경로 */
  const firstOf = async (paths: readonly string[], kind: CardKind) => {
    const tried: Fetched[] = [];
    for (const p of paths) {
      const f = await get(w.origin + p, kind);
      tried.push(f);
      if (f.outcome !== 'not_found') break;
    }
    const last = tried[tried.length - 1]!;
    // 하나라도 찾았으면 그것, 아니면 마지막 결과(모두 not_found 면 not_found)
    return { f: tried.find((t) => t.outcome === 'found') ?? last, tried };
  };
  const triedList = (t: Fetched[]) => (t.length > 1 ? t.map((x) => ({ url: x.url, outcome: x.outcome, http_status: x.http_status })) : undefined);
  const prevResults = (prevHost?.results ?? {}) as Record<string, any>;
  const results: Record<string, CheckResult> = {};

  // 1) AI Catalog
  {
    const f = await get(w.origin + HOST_PATHS.ai_catalog[0], 'ai_catalog');
    let cur = baseResult('ai_catalog', f);
    if (f.outcome === 'found') {
      const facts = parseAiCatalog(JSON.parse(f.text!));
      if (!facts) cur = { ...cur, outcome: 'wrong_shape', sha256: null };
      else {
        keepBody('ai_catalog', f);
        const cards: Array<Record<string, unknown>> = [];
        for (const inline of facts.mcp_card_inline) {
          cards.push({ source: 'inline', claimed_name: inline.claimed_name, declared_endpoints: normList(inline.endpoints.map((e) => e.url)) });
          out.declarations.push({ card_url: f.url, kind: 'mcp_server_card', origin: w.origin, claimed_name: inline.claimed_name, endpoints: inline.endpoints, interfaces: [], sha256: f.sha256, observed_at: nowIso });
        }
        for (const u of facts.mcp_card_urls.slice(0, 3)) {
          const c = await get(u, 'mcp_server_card');
          const parsed = c.outcome === 'found' ? parseServerCard(JSON.parse(c.text!)) : null;
          const outcome = c.outcome === 'found' && !parsed ? 'wrong_shape' : c.outcome;
          cards.push({ source: 'url', url: u, outcome, claimed_name: parsed?.claimed_name ?? null, declared_endpoints: parsed ? normList(parsed.endpoints.map((e) => e.url)) : [] });
          if (parsed) {
            keepBody('mcp_server_card', c);
            out.declarations.push({ card_url: u, kind: 'mcp_server_card', origin: w.origin, claimed_name: parsed.claimed_name, endpoints: parsed.endpoints, interfaces: [], sha256: c.sha256, observed_at: nowIso });
          }
        }
        // 목록 자체는 카드가 아니라 선언으로 넣지 않는다(목록이 가리키는·담은 MCP 카드만 위에서 넣었다)
        cur = { ...cur, entries: facts.entries, entry_types: facts.entry_types, mcp_cards: cards };
      }
    }
    results.ai_catalog = record('ai_catalog', prevResults.ai_catalog, cur);
  }

  // 2) A2A Agent Card (현재 경로 → 404 면 옛 경로)
  {
    const { f, tried } = await firstOf(HOST_PATHS.a2a_agent_card, 'a2a_agent_card');
    let cur: CheckResult = { ...baseResult('a2a_agent_card', f), tried: triedList(tried) };
    if (f.outcome === 'found') {
      const facts = parseA2aCard(JSON.parse(f.text!));
      if (!facts) cur = { ...cur, outcome: 'wrong_shape', sha256: null };
      else {
        keepBody('a2a_agent_card', f);
        cur = { ...cur, legacy_path: f.url.endsWith('/agent.json'), claimed_name: facts.claimed_name, protocol_version: facts.protocol_version, interfaces: facts.interfaces.slice(0, 5) };
        out.declarations.push({ card_url: f.url, kind: 'a2a_agent_card', origin: w.origin, claimed_name: facts.claimed_name, endpoints: [], interfaces: facts.interfaces, sha256: f.sha256, observed_at: nowIso });
      }
    }
    results.a2a_agent_card = record('a2a_agent_card', prevResults.a2a_agent_card, cur);
  }

  // 3) .well-known 의 MCP Server Card (규격 밖·비권장 경로지만 실제로 쓰임)
  {
    const { f, tried } = await firstOf(HOST_PATHS.mcp_well_known, 'mcp_server_card');
    let cur: CheckResult = { ...baseResult('mcp_server_card', f), tried: triedList(tried) };
    if (f.outcome === 'found') {
      const facts = parseServerCard(JSON.parse(f.text!));
      if (!facts) cur = { ...cur, outcome: 'wrong_shape', sha256: null };
      else {
        keepBody('mcp_server_card', f);
        cur = { ...cur, claimed_name: facts.claimed_name, name_format_ok: facts.name_format_ok, declared_endpoints: normList(facts.endpoints.map((e) => e.url)), transports: [...new Set(facts.endpoints.map((e) => e.type).filter(Boolean))] };
        out.declarations.push({ card_url: f.url, kind: 'mcp_server_card', origin: w.origin, claimed_name: facts.claimed_name, endpoints: facts.endpoints, interfaces: [], sha256: f.sha256, observed_at: nowIso });
      }
    }
    results.mcp_well_known = record('mcp_well_known', prevResults.mcp_well_known, cur);
  }

  out.host = { origin: w.origin, host: w.host, slice: w.slice, shared: w.shared, endpoints: w.endpoints.length, checked_at: nowIso, results, run_id: runId };

  // 4) 주소마다 <MCP 주소>/server-card
  for (const t of w.endpoints) {
    const f = await get(endpointCardUrl(t.endpoint), 'mcp_server_card');
    let cur = baseResult('mcp_server_card', f);
    if (f.outcome === 'found') {
      const facts = parseServerCard(JSON.parse(f.text!));
      if (!facts) cur = { ...cur, outcome: 'wrong_shape', sha256: null };
      else {
        keepBody('mcp_server_card', f);
        const declared = normList(facts.endpoints.map((e) => e.url));
        cur = {
          ...cur,
          claimed_name: facts.claimed_name,
          name_format_ok: facts.name_format_ok,
          declared_endpoints: declared,
          transports: [...new Set(facts.endpoints.map((e) => e.type).filter(Boolean))],
          supported_protocol_versions: [...new Set(facts.endpoints.flatMap((e) => e.versions))].slice(0, 10),
        };
        out.declarations.push({ card_url: f.url, kind: 'mcp_server_card', origin: w.origin, claimed_name: facts.claimed_name, endpoints: facts.endpoints, interfaces: [], sha256: f.sha256, observed_at: nowIso });
      }
    }
    const result = record(t.endpoint, prevEndpoints.get(t.endpoint)?.result, cur);
    out.endpoints.push({ endpoint: t.endpoint, origin: w.origin, slice: w.slice, registry_names: t.registry_names, checked_at: nowIso, result, run_id: runId });
  }
  return out;
}

async function readTargets(cfg: SupabaseConfig): Promise<Target[]> {
  const out: Target[] = [];
  let last = 0;
  for (;;) {
    const page = await dbGet<Target>(cfg, `card_targets?select=endpoint_id,endpoint,registry_names,quiet&endpoint_id=gt.${last}&order=endpoint_id.asc&limit=1000`);
    out.push(...page);
    if (page.length < 1000) break;
    last = page[page.length - 1]!.endpoint_id;
  }
  return out;
}

async function readPrev<T extends Record<string, any>>(cfg: SupabaseConfig, table: string, key: string, cols: string, slice: number): Promise<Map<string, T>> {
  const m = new Map<string, T>();
  let last = '';
  for (;;) {
    const page = await dbGet<T>(cfg, `${table}?select=${cols}&slice=eq.${slice}${last ? `&${key}=gt.${encodeURIComponent(last)}` : ''}&order=${key}.asc&limit=1000`);
    for (const r of page) m.set(r[key], r);
    if (page.length < 1000) break;
    last = page[page.length - 1]![key];
  }
  return m;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const force = args.includes('--force');
  const sliceArg = Number(args.find((a) => a.startsWith('--slice='))?.slice(8));
  const limitArg = Number(args.find((a) => a.startsWith('--limit='))?.slice(8));
  const url = process.env.LOWDOWN_SUPABASE_URL?.trim();
  const key = process.env.LOWDOWN_SCANNER_KEY?.trim();
  if (!url || !key) fail('LOWDOWN_SUPABASE_URL / LOWDOWN_SCANNER_KEY 가 없습니다.');
  const cfg = { url, key };
  const started = Date.now();
  const deadline = started + intEnv('CARD_TIME_BUDGET_MIN', 40) * 60_000;
  const day = new Date(started).toISOString().slice(0, 10);
  const slice = Number.isInteger(sliceArg) && sliceArg >= 0 && sliceArg < 7 ? sliceArg : sliceForDay(started);
  const runId = randomUUID();
  const todayStart = `${day}T00:00:00Z`;

  if (!dryRun && !force) {
    const done = await dbGet<{ day: string }>(cfg, `card_runs?select=day&day=eq.${day}&finished_at=not.is.null&limit=1`);
    if (done.length) {
      console.log(`card discovery: ${day} already finished, skipping (use --force to run again)`);
      return;
    }
  }

  const targets = await readTargets(cfg);
  const all = groupTargets(targets);
  const prevHosts = await readPrev<Record<string, any>>(cfg, 'card_host_checks', 'origin', 'origin,checked_at,results', slice);
  const prevEndpoints = await readPrev<Record<string, any>>(cfg, 'card_endpoint_checks', 'endpoint', 'endpoint,result', slice);
  // 오늘 이미 확인한 호스트는 건너뛴다(예비 실행이 이어서 할 때 중복 요청을 막는다)
  let work = all.filter((w) => w.slice === slice && !(prevHosts.get(w.origin)?.checked_at >= todayStart && !force));
  // 주소가 많은 호스트(같은 호스트에는 차례로 보내 오래 걸림)를 먼저 시작해 끝이 늘어지지 않게 한다
  work.sort((a, b) => b.endpoints.length - a.endpoints.length || a.origin.localeCompare(b.origin));
  if (Number.isInteger(limitArg) && limitArg > 0) work = work.slice(0, limitArg);
  const totalEndpoints = work.reduce((n, w) => n + w.endpoints.length, 0);
  console.log(`card discovery run ${runId}: day ${day}, slice ${slice}, targets ${targets.length}, origins ${all.length} (this slice ${work.length}, endpoints ${totalEndpoints}, shared ${work.filter((w) => w.shared).length}), dry_run=${dryRun}`);

  if (!dryRun) await postBatches(cfg, 'card_runs?on_conflict=day', [{ day, slice, run_id: runId, started_at: new Date(started).toISOString(), finished_at: null, stats: {} }], 'resolution=merge-duplicates,return=minimal', {});

  const timeout = intEnv('CARD_TIMEOUT_MS', 8000);
  const quietTimeout = intEnv('CARD_QUIET_TIMEOUT_MS', 3000);
  const gapMs = intEnv('CARD_HOST_GAP_MS', 250);
    const outcomes = await pool(work, intEnv('CARD_CONCURRENCY', 32), deadline - 3 * 60_000, async (w) => {
    const nowIso = new Date().toISOString();
    const fetcher: Fetcher = (u, kind) => fetchCard(u, kind, w.quiet ? quietTimeout : timeout);
    return checkOrigin(w, prevHosts.get(w.origin) ?? null, prevEndpoints, fetcher, nowIso, runId, () => sleep(gapMs));
  });

  const hosts = outcomes.map((o) => o.host);
  const endpoints = outcomes.flatMap((o) => o.endpoints);
  const changes = outcomes.flatMap((o) => o.changes);
  const bodies = [...new Map(outcomes.flatMap((o) => o.bodies).map((b) => [b.sha256, b])).values()];
  const declarations = outcomes.flatMap((o) => o.declarations);
  const requests = outcomes.reduce((n, o) => n + o.requests, 0);
  const tally = (rows: Array<{ outcome?: unknown }>) => {
    const m: Record<string, number> = {};
    for (const r of rows) m[String(r.outcome)] = (m[String(r.outcome)] ?? 0) + 1;
    return m;
  };
  const stats = {
    origins: hosts.length,
    origins_planned: work.length,
    endpoints: endpoints.length,
    requests,
    changes: changes.length,
    bodies: bodies.length,
    declarations: declarations.length,
    endpoint_server_card: tally(endpoints.map((e) => e.result as CheckResult)),
    ai_catalog: tally(hosts.map((h) => (h.results as any).ai_catalog)),
    a2a_agent_card: tally(hosts.map((h) => (h.results as any).a2a_agent_card)),
    mcp_well_known: tally(hosts.map((h) => (h.results as any).mcp_well_known)),
    seconds: Math.round((Date.now() - started) / 1000),
  };
  console.log(JSON.stringify(stats));

  if (!dryRun) {
    // 원문 → 변경 → 선언 → 사실(호스트·주소) → 실행 끝 표시. 중간에 끊기면 다음 실행이 오늘 안 된 호스트부터 이어서 한다.
    if (bodies.length) await postBatches(cfg, 'card_bodies?on_conflict=sha256', bodies, 'resolution=ignore-duplicates,return=minimal', { batchSize: 100 });
    if (changes.length) await postBatches(cfg, 'card_check_changes', changes, 'return=minimal', { batchSize: 1000 });
    if (declarations.length) await postBatches(cfg, 'card_declarations', declarations, 'return=minimal', { batchSize: 500 });
    if (hosts.length) await postBatches(cfg, 'card_host_checks?on_conflict=origin', hosts, 'resolution=merge-duplicates,return=minimal', { batchSize: 500 });
    if (endpoints.length) await postBatches(cfg, 'card_endpoint_checks?on_conflict=endpoint', endpoints, 'resolution=merge-duplicates,return=minimal', { batchSize: 500 });
    const complete = hosts.length === work.length;
    await dbPatch(cfg, `card_runs?day=eq.${day}`, { finished_at: complete ? new Date().toISOString() : null, stats: { ...stats, complete } });
    if (!complete) console.log(`::warning::time budget reached: ${hosts.length}/${work.length} origins checked; the next run today continues`);
  }
  console.log(`card discovery done in ${stats.seconds}s${dryRun ? ' (dry-run, nothing written)' : ''}`);
  const out = process.env.GITHUB_OUTPUT;
  if (out) appendFileSync(out, `card_origins=${hosts.length}\ncard_declarations=${declarations.length}\n`);
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('card-discovery.ts')) main().catch((e: unknown) => fail(e instanceof Error ? e.message : 'card discovery failed'));
