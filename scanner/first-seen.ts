// 최초 관측 기록 (Scanner 0.4.0~) — "First observed by Lowdown"
//   Lowdown 이 관찰한 범위(코호트, 이후 신규 서버 첫 관찰)에서 처음 본 값만 기록한다. 시장에 새로 나왔다는 뜻이 아니다.
//   kind:
//     capability        initialize 결과 capabilities 의 최상위 키 이름 (experimental 안쪽은 보지 않음)
//     protocol_version  initialize 결과 protocolVersion
//     tool_name         tools/list 의 도구 이름 (형식 통과분만, 설명문은 저장하지 않음)
//   첫 실행(테이블이 비어 있음)은 전부 baseline 으로 넣고 "처음 관측"으로 보지 않는다.
//   targets/hosts/namespaces 는 가장 최근에 그 값을 본 실행 기준의 고유 수(누적 아님). 바뀐 행만 갱신한다.
//   공개(일일 페이지·피드)는 isPublishable 기준: tool_name 은 고유 호스트 2개 이상 + Registry 네임스페이스 2개 이상.
//     이 기준은 한 운영자가 목록을 도배하는 것을 줄이는 노출 정책이지 보안 필터가 아니다. 형식 검증·출력 이스케이프는 따로 한다.
//
//   도구 이름 목록은 scanner_tool_sets 에 (target_id, names_hash) 가 처음 나타날 때만 1행 저장한다.
//   names_hash = 정렬한 이름 목록의 SHA-256. 이름 집합이 같으면 입력 스키마나 설명이 바뀌어도 새로 저장하지 않는다.
//   tools/list 가 다음 페이지를 알렸으면(tools_has_more) 첫 페이지 이름만 있으므로 partial=true.

import type { ObservationRow, SupabaseConfig } from './lib.ts';
import { capHost, supabaseHeaders } from './lib.ts';
import { postBatches } from './registry-diff.ts';
import type { DiffIoDeps } from './registry-diff.ts';

export type FirstSeenKind = 'capability' | 'protocol_version' | 'tool_name';

export interface FirstSeenRow {
  kind: FirstSeenKind;
  value: string;
  first_seen_on: string; // UTC 날짜
  first_seen_at: string;
  first_target_id: string;
  baseline: boolean;
  targets: number;
  hosts: number;
  namespaces: number;
  scan_run_id: string;
  updated_at: string;
}

export interface ToolSetRow {
  target_id: string;
  names_hash: string;
  names: string[];
  rejected: number;
  partial: boolean;
  schema_hash: string | null;
  first_seen_at: string;
  scan_run_id: string;
}

const PROTOCOL_VERSION = /^[0-9A-Za-z._-]{1,32}$/;

/** mcp:io.github.user/server → io.github.user (게시자에 가까운 단위). 형식이 아니면 이름 전체 */
export function namespaceOf(targetId: string): string {
  const name = targetId.startsWith('mcp:') ? targetId.slice(4) : targetId;
  const i = name.indexOf('/');
  return (i > 0 ? name.slice(0, i) : name).toLowerCase();
}

interface Agg {
  kind: FirstSeenKind;
  value: string;
  firstTarget: string;
  targets: Set<string>;
  hosts: Set<string>;
  namespaces: Set<string>;
}

const keyOf = (kind: string, value: string) => `${kind}\u0000${value}`;

/** 오늘 관찰 행(+ 행별 도구 이름)에서 값별 고유 대상·호스트·네임스페이스를 모은다. reached_level 1 이상만. */
export function aggregateObserved(rows: readonly ObservationRow[], toolNamesOf: (row: ObservationRow) => readonly string[] | undefined): Map<string, Agg> {
  const m = new Map<string, Agg>();
  const add = (kind: FirstSeenKind, value: string, row: ObservationRow) => {
    const k = keyOf(kind, value);
    let a = m.get(k);
    if (!a) {
      a = { kind, value, firstTarget: row.target_id, targets: new Set(), hosts: new Set(), namespaces: new Set() };
      m.set(k, a);
    }
    if (row.target_id < a.firstTarget) a.firstTarget = row.target_id; // 결정적
    a.targets.add(row.target_id);
    const url = row.metadata.remote_url;
    const h = typeof url === 'string' ? capHost(url) : null;
    if (h) a.hosts.add(h);
    a.namespaces.add(namespaceOf(row.target_id));
  };
  for (const r of rows) {
    if (r.reached_level < 1) continue;
    const caps = r.metadata.capabilities;
    if (Array.isArray(caps)) for (const c of caps) if (typeof c === 'string') add('capability', c, r);
    const pv = r.metadata.protocol_version;
    if (typeof pv === 'string' && PROTOCOL_VERSION.test(pv)) add('protocol_version', pv, r);
    for (const n of toolNamesOf(r) ?? []) add('tool_name', n, r);
  }
  return m;
}

export interface FirstSeenResult {
  mode: 'bootstrap' | 'diff' | 'skipped';
  skipReason?: string;
  upserts: FirstSeenRow[];
  /** 이번 실행에서 처음 관측된 행(baseline 제외) */
  firstObserved: FirstSeenRow[];
}

/** 순수 함수: 이전 기록 + 오늘 집계 → 갱신할 행. 쓰기는 하지 않는다. */
export function computeFirstSeen(prev: readonly FirstSeenRow[], today: ReadonlyMap<string, Agg>, ctx: { now: string; scanRunId: string }): FirstSeenResult {
  if (today.size === 0) return { mode: 'skipped', skipReason: 'nothing observed', upserts: [], firstObserved: [] };
  const day = ctx.now.slice(0, 10);
  const bootstrap = prev.length === 0;
  const prevBy = new Map(prev.map((r) => [keyOf(r.kind, r.value), r]));
  const upserts: FirstSeenRow[] = [];
  const firstObserved: FirstSeenRow[] = [];
  for (const [k, a] of today) {
    const counts = { targets: a.targets.size, hosts: a.hosts.size, namespaces: a.namespaces.size };
    const p = prevBy.get(k);
    if (!p) {
      const row: FirstSeenRow = {
        kind: a.kind,
        value: a.value,
        first_seen_on: day,
        first_seen_at: ctx.now,
        first_target_id: a.firstTarget,
        baseline: bootstrap,
        ...counts,
        scan_run_id: ctx.scanRunId,
        updated_at: ctx.now,
      };
      upserts.push(row);
      if (!bootstrap) firstObserved.push(row);
    } else if (p.targets !== counts.targets || p.hosts !== counts.hosts || p.namespaces !== counts.namespaces) {
      upserts.push({ ...p, ...counts, updated_at: ctx.now });
    }
  }
  return { mode: bootstrap ? 'bootstrap' : 'diff', upserts, firstObserved };
}

/** 공개 기준(노출 정책). tool_name 만 호스트·네임스페이스 2개 이상. */
export function isPublishable(r: Pick<FirstSeenRow, 'kind' | 'hosts' | 'namespaces' | 'baseline'>): boolean {
  if (r.kind !== 'tool_name') return true;
  return r.hosts >= 2 && r.namespaces >= 2;
}

/** 대상별 도구 이름 목록 행. 같은 (대상, names_hash) 는 한 번만. */
export function toolSetRows(rows: readonly ObservationRow[], toolNamesOf: (row: ObservationRow) => readonly string[] | undefined, ctx: { now: string; scanRunId: string }): ToolSetRow[] {
  const seen = new Set<string>();
  const out: ToolSetRow[] = [];
  for (const r of rows) {
    const names = toolNamesOf(r);
    const nh = r.metadata.names_hash;
    if (!names || typeof nh !== 'string') continue;
    const k = `${r.target_id}\u0000${nh}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({
      target_id: r.target_id,
      names_hash: nh,
      names: [...names],
      rejected: typeof r.metadata.tool_names_rejected === 'number' ? r.metadata.tool_names_rejected : 0,
      partial: r.metadata.tools_has_more === true,
      schema_hash: typeof r.metadata.schema_hash === 'string' ? r.metadata.schema_hash : null,
      first_seen_at: ctx.now,
      scan_run_id: ctx.scanRunId,
    });
  }
  return out;
}

// ─────────────────────────────────────────────
// DB 입출력 (PostgREST)
// ─────────────────────────────────────────────

const FS_COLUMNS = 'id,kind,value,first_seen_on,first_seen_at,first_target_id,baseline,targets,hosts,namespaces,scan_run_id,updated_at';

/** scanner_first_seen 전체. id keyset. 읽기 실패는 throw(조용히 bootstrap 하지 않음). */
export async function fetchFirstSeen(cfg: SupabaseConfig, deps: DiffIoDeps = {}): Promise<FirstSeenRow[]> {
  const f = deps.fetchImpl ?? fetch;
  const pageSize = deps.pageSize ?? 1000;
  const base = `${cfg.url.replace(/\/+$/, '')}/rest/v1/scanner_first_seen`;
  const out: FirstSeenRow[] = [];
  let lastId = 0;
  for (;;) {
    const qs = new URLSearchParams({ select: FS_COLUMNS, order: 'id.asc', limit: String(pageSize), id: `gt.${lastId}` });
    let res: Response;
    try {
      res = await f(`${base}?${qs.toString()}`, { headers: supabaseHeaders(cfg.key, { Accept: 'application/json' }), signal: AbortSignal.timeout(30_000) });
    } catch {
      throw new Error('scanner_first_seen read failed: network');
    }
    if (!res.ok) throw new Error(`scanner_first_seen read failed: HTTP ${res.status}`);
    const page = (await res.json()) as Array<FirstSeenRow & { id: number }>;
    if (!Array.isArray(page)) throw new Error('scanner_first_seen read failed: unexpected response');
    for (const { id: _id, ...r } of page) out.push(r);
    if (page.length < pageSize) break;
    const last = page[page.length - 1]?.id;
    if (typeof last !== 'number' || last <= lastId) throw new Error('scanner_first_seen read failed: pagination did not advance');
    lastId = last;
  }
  return out;
}

/** (kind, value) 충돌 시 덮어씀. first_seen_* 는 계산에서 이전 값을 그대로 넘기므로 바뀌지 않는다. */
export function upsertFirstSeen(cfg: SupabaseConfig, rows: readonly FirstSeenRow[], deps: DiffIoDeps = {}): Promise<number> {
  return postBatches(cfg, 'scanner_first_seen?on_conflict=kind,value', rows, 'resolution=merge-duplicates,return=minimal', deps);
}

/** (target_id, names_hash) 가 이미 있으면 무시 — 처음 나타난 목록만 남는다. */
export function insertToolSets(cfg: SupabaseConfig, rows: readonly ToolSetRow[], deps: DiffIoDeps = {}): Promise<number> {
  return postBatches(cfg, 'scanner_tool_sets?on_conflict=target_id,names_hash', rows, 'resolution=ignore-duplicates,return=minimal', deps);
}
