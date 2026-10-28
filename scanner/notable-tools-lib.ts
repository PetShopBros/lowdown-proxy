// 레이다 2단계: 도구 정의 규칙(R1·R2·R3) → scanner_notable — 순수 함수 + DB 읽기
//   원자료: scanner_observations (고정 표본 source='scanner', reached_level=2). 읽기만 한다.
//   비교 단위: (서버, 원격 주소)의 하루 마지막 관찰끼리 (API definition_changes 와 같은 기준).
//   변경: schema_hash 또는 desc_hash 가 다름, 또는 두 날 모두 names_hash 가 있고 다름.
//   확인: D일에 바뀐 정의가 다음 관찰에서도 그대로일 때만 기록한다(하루 늦는 대신 흔들림·매일 바뀌는 값을 거른다).
//     다음 관찰이 없으면 아직 기록하지 않는다. 같은 입력이면 같은 행 → 매일 같은 기간을 다시 돌려도 안전(ignore-duplicates).
//   규칙 (rule_version 1, 2026-10-29 측정: 되돌림 0건)
//     R1_first_change_after_stable    직전 7번 이상의 비교에서 그대로이던 정의가 바뀜 (서버 버전도 바뀌었거나 알 수 없음)
//     R2_changed_same_server_version  R1 과 같되 서버 버전은 그대로 (R1 과 겹치지 않는다)
//     R3_tool_removed                 도구 이름 집합이 바뀌고 도구 수가 줄어듦 (안정 조건 없음, 확인 조건은 같음)
//   서버 하나에 원격이 여럿이면 서버 기준으로 한 행(바뀐 원격 수는 evidence 에). 해시·원격 주소·원문은 내보내지 않는다.

import type { SupabaseConfig } from './lib.ts';
import { supabaseHeaders } from './lib.ts';
import { NOTABLE_RULE_VERSION, type NotableRow, type RuleId } from './notable-lib.ts';
import type { DiffIoDeps } from './registry-diff.ts';

export const STABLE_MIN = 7;

const HASH = /^[0-9a-f]{64}$/;
const TARGET = /^mcp:([A-Za-z0-9._~-]{1,200})\/([A-Za-z0-9._~-]{1,200})$/;
const SAFE_VERSION = /^[0-9A-Za-z.+_!~-]{1,64}$/;

export interface ObsIn {
  id?: number;
  target_id: string;
  observed_at: string;
  remote_url: string | null;
  schema_hash: string | null;
  desc_hash: string | null;
  names_hash: string | null;
  server_version: string | null;
  tool_count: string | number | null;
}

interface Point {
  day: string;
  at: string;
  sh: string;
  dh: string;
  nh: string | null;
  ver: string | null;
  cnt: number | null;
}

interface Change {
  rule: RuleId;
  day: string;
  kinds: string[];
  from: Point;
  to: Point;
  stable: number;
  confirmedOn: string;
}

const intOrNull = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d{1,7}$/.test(v) ? Number(v) : NaN;
  return Number.isInteger(n) && n >= 0 ? n : null;
};

function toPoint(o: ObsIn): Point | null {
  if (typeof o.schema_hash !== 'string' || !HASH.test(o.schema_hash)) return null;
  if (typeof o.desc_hash !== 'string' || !HASH.test(o.desc_hash)) return null;
  const at = String(o.observed_at);
  return {
    day: at.slice(0, 10),
    at,
    sh: o.schema_hash,
    dh: o.desc_hash,
    nh: typeof o.names_hash === 'string' && HASH.test(o.names_hash) ? o.names_hash : null,
    ver: typeof o.server_version === 'string' && SAFE_VERSION.test(o.server_version) ? o.server_version : null,
    cnt: intOrNull(o.tool_count),
  };
}

const sameDef = (a: Point, b: Point) => a.sh === b.sh && a.dh === b.dh && (a.nh === null || b.nh === null || a.nh === b.nh);

/** 원격 하나의 하루 1점 목록 → 확인된 변경 */
export function remoteChanges(points: readonly Point[]): Change[] {
  const out: Change[] = [];
  let stable = 0; // 직전까지 연속으로 "그대로"였던 비교 수
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1]!;
    const cur = points[i]!;
    if (sameDef(prev, cur)) {
      stable++;
      continue;
    }
    const next = points[i + 1];
    const kinds: string[] = [];
    if (cur.sh !== prev.sh) kinds.push('schema');
    if (cur.dh !== prev.dh) kinds.push('desc');
    if (cur.nh && prev.nh && cur.nh !== prev.nh) kinds.push('names');
    if (next && sameDef(cur, next)) {
      const removed = kinds.includes('names') && cur.cnt !== null && prev.cnt !== null && cur.cnt < prev.cnt;
      if (removed) out.push({ rule: 'R3_tool_removed', day: cur.day, kinds, from: prev, to: cur, stable, confirmedOn: next.day });
      if (stable >= STABLE_MIN) {
        const sameVersion = cur.ver !== null && prev.ver !== null && cur.ver === prev.ver;
        out.push({ rule: sameVersion ? 'R2_changed_same_server_version' : 'R1_first_change_after_stable', day: cur.day, kinds, from: prev, to: cur, stable, confirmedOn: next.day });
      }
    }
    stable = 0;
  }
  return out;
}

/** 관찰 행 → 확인된 레이다 행 (서버·규칙·날짜당 1행). minDay 이전 변경은 내지 않는다. */
export function buildToolNotable(rows: readonly ObsIn[], opts: { minDay?: string } = {}): { rows: NotableRow[]; skipped: number } {
  let skipped = 0;
  // (target, remote) → 날짜 → 그날 마지막 관찰
  const byRemote = new Map<string, Map<string, Point>>();
  const targetOf = new Map<string, string>();
  for (const o of rows) {
    if (typeof o.target_id !== 'string' || !TARGET.test(o.target_id)) {
      skipped++;
      continue;
    }
    const p = toPoint(o);
    if (!p) continue;
    const key = `${o.target_id}\u0000${o.remote_url ?? ''}`;
    targetOf.set(key, o.target_id);
    if (!byRemote.has(key)) byRemote.set(key, new Map());
    const days = byRemote.get(key)!;
    const had = days.get(p.day);
    if (!had || had.at <= p.at) days.set(p.day, p);
  }

  // 서버·규칙·날짜로 합친다
  const merged = new Map<string, { target: string; c: Change; remotes: number }>();
  for (const key of [...byRemote.keys()].sort()) {
    const points = [...byRemote.get(key)!.values()].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
    const target = targetOf.get(key)!;
    for (const c of remoteChanges(points)) {
      if (opts.minDay && c.day < opts.minDay) continue;
      const k = `${c.day} ${c.rule} ${target}`;
      const had = merged.get(k);
      if (had) had.remotes++;
      else merged.set(k, { target, c, remotes: 1 });
    }
  }

  const out: NotableRow[] = [];
  for (const { target, c, remotes } of merged.values()) {
    const m = TARGET.exec(target)!;
    const server = `${m[1]}/${m[2]}`;
    out.push({
      day: c.day,
      rule_id: c.rule,
      rule_version: NOTABLE_RULE_VERSION,
      subject_kind: 'server',
      subject: server,
      group_key: `ns:${m[1]!.toLowerCase()}`,
      evidence: {
        server,
        kinds: c.kinds,
        tool_count: c.from.cnt !== null && c.to.cnt !== null ? { from: c.from.cnt, to: c.to.cnt } : null,
        server_version: c.from.ver === c.to.ver ? c.to.ver : { from: c.from.ver, to: c.to.ver },
        unchanged_comparisons_before: c.stable,
        compared_with: c.from.day,
        confirmed_on: c.confirmedOn,
        remotes_changed: remotes,
      },
      published: false,
    });
  }
  out.sort((a, b) => (a.day !== b.day ? (a.day < b.day ? -1 : 1) : a.rule_id !== b.rule_id ? (a.rule_id < b.rule_id ? -1 : 1) : a.subject < b.subject ? -1 : a.subject > b.subject ? 1 : 0));
  return { rows: out, skipped };
}

// ─────────────────────────────────────────────
// DB 읽기 (id keyset, 기간·고정 표본·L2 만)
// ─────────────────────────────────────────────

const OBS_SELECT =
  'id,target_id,observed_at,remote_url:metadata->>remote_url,schema_hash:metadata->>schema_hash,desc_hash:metadata->>desc_hash,' +
  'names_hash:metadata->>names_hash,server_version:metadata->>server_version,tool_count:metadata->>tool_count';

export async function fetchObservations(cfg: SupabaseConfig, sinceIso: string, deps: DiffIoDeps = {}): Promise<ObsIn[]> {
  const f = deps.fetchImpl ?? fetch;
  const pageSize = deps.pageSize ?? 1000;
  const base = `${cfg.url.replace(/\/+$/, '')}/rest/v1/scanner_observations`;
  const out: ObsIn[] = [];
  let lastId = 0;
  for (;;) {
    const qs = new URLSearchParams({ select: OBS_SELECT, order: 'id.asc', limit: String(pageSize) });
    qs.append('id', `gt.${lastId}`);
    qs.append('observed_at', `gte.${sinceIso}`);
    qs.append('source', 'eq.scanner');
    qs.append('reached_level', 'eq.2');
    const res = await f(`${base}?${qs.toString()}`, { headers: supabaseHeaders(cfg.key, { Accept: 'application/json' }), signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new Error(`scanner_observations read failed: HTTP ${res.status}`);
    const page = (await res.json()) as ObsIn[];
    if (!Array.isArray(page)) throw new Error('scanner_observations read failed: unexpected response');
    out.push(...page);
    if (page.length < pageSize) break;
    const last = page[page.length - 1]!.id;
    if (typeof last !== 'number' || last <= lastId) throw new Error('scanner_observations read: keyset did not advance');
    lastId = last;
  }
  return out;
}
