// 시장판 1단계 — Registry 비교 기록 (probe 없음)
//   어제까지의 상태(registry_state)와 오늘 받은 Registry 목록을 비교해 달라진 것만 registry_changes 에 남긴다.
//   첫 실행(state 가 비어 있음)은 전체를 baseline 으로 넣고 이벤트를 만들지 않는다.
//   설명문 원문은 다루지 않는다(해시만). 이름·주소는 Registry 공개 값 그대로 저장하되, 공개 화면에는 나중에 허용 문자만 내보낸다.

import type { RegistryDeclaration, SupabaseConfig } from './lib.ts';
import { supabaseHeaders } from './lib.ts';

export type ChangeKind = 'new' | 'removed' | 'restored' | 'version' | 'status' | 'remotes' | 'packages' | 'description';

export interface RegistryStateRow {
  name: string;
  version: string;
  status: string | null;
  remotes_key: string;
  packages_key: string;
  desc_hash: string;
  hosts: string[];
  first_seen_at: string;
  baseline: boolean;
  removed_at: string | null;
  updated_at: string;
}

export interface RegistryChangeRow {
  detected_on: string; // UTC 날짜
  detected_at: string;
  scan_run_id: string;
  name: string;
  kind: ChangeKind;
  old_value: string | null;
  new_value: string | null;
  hosts: string[];
}

export interface DiffResult {
  mode: 'bootstrap' | 'diff' | 'skipped';
  skipReason?: string;
  upserts: RegistryStateRow[];
  events: RegistryChangeRow[];
  counts: Record<string, number>;
}

export interface DiffLimits {
  /** 어제 살아 있던 항목 중 이 비율 넘게 "사라짐"이면 목록 이상으로 보고 기록하지 않는다 */
  maxRemovedFraction: number;
  /** 하루 이벤트가 이보다 많으면 기록하지 않는다(Registry 대규모 재구성 등) */
  maxEvents: number;
}

export const DEFAULT_DIFF_LIMITS: DiffLimits = { maxRemovedFraction: 0.05, maxEvents: 20_000 };

function stateFrom(name: string, d: RegistryDeclaration, now: string, baseline: boolean, firstSeen = now): RegistryStateRow {
  return {
    name,
    version: d.version,
    status: d.status,
    remotes_key: d.remotesKey,
    packages_key: d.packagesKey,
    desc_hash: d.descHash,
    hosts: d.hosts,
    first_seen_at: firstSeen,
    baseline,
    removed_at: null,
    updated_at: now,
  };
}

/** 순수 함수: 어제 상태 + 오늘 선언 → 갱신할 상태 행과 이벤트. 쓰기는 하지 않는다. */
export function diffRegistry(
  prev: readonly RegistryStateRow[],
  today: ReadonlyMap<string, RegistryDeclaration>,
  ctx: { now: string; scanRunId: string },
  limits: DiffLimits = DEFAULT_DIFF_LIMITS,
): DiffResult {
  const day = ctx.now.slice(0, 10);
  if (today.size === 0) return { mode: 'skipped', skipReason: 'empty registry list', upserts: [], events: [], counts: {} };

  if (prev.length === 0) {
    const upserts = [...today.entries()].map(([name, d]) => stateFrom(name, d, ctx.now, true));
    return { mode: 'bootstrap', upserts, events: [], counts: { baseline: upserts.length } };
  }

  const prevByName = new Map(prev.map((r) => [r.name, r]));
  const upserts: RegistryStateRow[] = [];
  const events: RegistryChangeRow[] = [];
  const ev = (name: string, kind: ChangeKind, oldV: string | null, newV: string | null, hosts: string[]) =>
    events.push({ detected_on: day, detected_at: ctx.now, scan_run_id: ctx.scanRunId, name, kind, old_value: oldV, new_value: newV, hosts });

  for (const [name, d] of today) {
    const p = prevByName.get(name);
    if (!p) {
      upserts.push(stateFrom(name, d, ctx.now, false));
      ev(name, 'new', null, d.version, d.hosts);
      continue;
    }
    let changed = false;
    if (p.removed_at) {
      ev(name, 'restored', null, d.version, d.hosts);
      changed = true;
    }
    if (p.version !== d.version) {
      ev(name, 'version', p.version, d.version, d.hosts);
      changed = true;
    }
    if ((p.status ?? null) !== (d.status ?? null)) {
      ev(name, 'status', p.status, d.status, d.hosts);
      changed = true;
    }
    if (p.remotes_key !== d.remotesKey) {
      ev(name, 'remotes', p.remotes_key || null, d.remotesKey || null, [...new Set([...p.hosts, ...d.hosts])].sort());
      changed = true;
    }
    if (p.packages_key !== d.packagesKey) {
      ev(name, 'packages', p.packages_key || null, d.packagesKey || null, d.hosts);
      changed = true;
    }
    if (p.desc_hash !== d.descHash) {
      ev(name, 'description', p.desc_hash || null, d.descHash || null, d.hosts);
      changed = true;
    }
    if (changed) upserts.push(stateFrom(name, d, ctx.now, p.baseline, p.first_seen_at));
  }

  const alive = prev.filter((r) => !r.removed_at);
  let removed = 0;
  for (const p of alive) {
    if (today.has(p.name)) continue;
    removed++;
    ev(p.name, 'removed', p.version, null, p.hosts);
    upserts.push({ ...p, removed_at: ctx.now, updated_at: ctx.now });
  }

  const counts: Record<string, number> = {};
  for (const e of events) counts[e.kind] = (counts[e.kind] ?? 0) + 1;

  if (alive.length > 0 && removed / alive.length > limits.maxRemovedFraction) {
    return { mode: 'skipped', skipReason: `removed ${removed}/${alive.length} exceeds ${limits.maxRemovedFraction}`, upserts: [], events: [], counts };
  }
  if (events.length > limits.maxEvents) {
    return { mode: 'skipped', skipReason: `events ${events.length} exceeds ${limits.maxEvents}`, upserts: [], events: [], counts };
  }
  return { mode: 'diff', upserts, events, counts };
}

// ─────────────────────────────────────────────
// DB 입출력 (PostgREST)
// ─────────────────────────────────────────────

export interface DiffIoDeps {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  pageSize?: number;
  batchSize?: number;
  maxAttempts?: number;
}

const STATE_COLUMNS = 'name,version,status,remotes_key,packages_key,desc_hash,hosts,first_seen_at,baseline,removed_at,updated_at';

/** registry_state 전체. name 기준 keyset 페이지네이션. 읽기 실패는 throw(조용히 bootstrap 하지 않음). */
export async function fetchRegistryState(cfg: SupabaseConfig, deps: DiffIoDeps = {}): Promise<RegistryStateRow[]> {
  const f = deps.fetchImpl ?? fetch;
  const pageSize = deps.pageSize ?? 1000;
  const base = `${cfg.url.replace(/\/+$/, '')}/rest/v1/registry_state`;
  const out: RegistryStateRow[] = [];
  let after: string | null = null;
  for (;;) {
    const qs = new URLSearchParams({ select: STATE_COLUMNS, order: 'name.asc', limit: String(pageSize) });
    if (after !== null) qs.set('name', `gt.${after}`);
    let res: Response;
    try {
      res = await f(`${base}?${qs.toString()}`, { headers: supabaseHeaders(cfg.key, { Accept: 'application/json' }), signal: AbortSignal.timeout(30_000) });
    } catch {
      throw new Error('registry_state read failed: network');
    }
    if (!res.ok) throw new Error(`registry_state read failed: HTTP ${res.status}`);
    const page = (await res.json()) as RegistryStateRow[];
    if (!Array.isArray(page)) throw new Error('registry_state read failed: unexpected response');
    out.push(...page);
    if (page.length < pageSize) break;
    const last = page[page.length - 1]?.name;
    if (typeof last !== 'string' || last === after) throw new Error('registry_state read failed: pagination did not advance');
    after = last;
  }
  return out;
}

async function postBatches(
  cfg: SupabaseConfig,
  path: string,
  rows: readonly object[],
  prefer: string,
  deps: DiffIoDeps,
): Promise<number> {
  const f = deps.fetchImpl ?? fetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const size = deps.batchSize ?? 1000;
  const maxAttempts = deps.maxAttempts ?? 4;
  const endpoint = `${cfg.url.replace(/\/+$/, '')}/rest/v1/${path}`;
  let written = 0;
  for (let i = 0; i < rows.length; i += size) {
    const body = JSON.stringify(rows.slice(i, i + size));
    for (let attempt = 1; ; attempt++) {
      let res: Response | null = null;
      try {
        res = await f(endpoint, {
          method: 'POST',
          headers: supabaseHeaders(cfg.key, { 'Content-Type': 'application/json', Prefer: prefer }),
          body,
          signal: AbortSignal.timeout(60_000),
        });
      } catch {
        res = null;
      }
      if (res && res.status >= 200 && res.status < 300) {
        written += Math.min(size, rows.length - i);
        break;
      }
      const retryable = !res || res.status >= 500 || res.status === 429 || res.status === 408;
      if (!retryable || attempt >= maxAttempts) {
        let snippet = '';
        try {
          snippet = res ? (await res.text()).slice(0, 300) : '';
        } catch {
          // 무시
        }
        throw new Error(`${path} write failed: HTTP ${res?.status ?? 'network'} ${snippet}`.trim());
      }
      await sleep(1000 * 2 ** (attempt - 1));
    }
  }
  return written;
}

/** 상태 행 upsert (name 충돌 시 덮어씀 — 재시도해도 결과가 같다) */
export function upsertRegistryState(cfg: SupabaseConfig, rows: readonly RegistryStateRow[], deps: DiffIoDeps = {}): Promise<number> {
  return postBatches(cfg, 'registry_state?on_conflict=name', rows, 'resolution=merge-duplicates,return=minimal', deps);
}

/** 이벤트 insert. (detected_on, name, kind) unique 로 같은 날 재실행 시 중복은 무시 */
export function insertRegistryChanges(cfg: SupabaseConfig, rows: readonly RegistryChangeRow[], deps: DiffIoDeps = {}): Promise<number> {
  return postBatches(cfg, 'registry_changes?on_conflict=detected_on,name,kind', rows, 'resolution=ignore-duplicates,return=minimal', deps);
}
