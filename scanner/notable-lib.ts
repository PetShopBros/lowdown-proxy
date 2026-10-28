// 레이다 1단계: 패키지 규칙 → "눈여겨볼 사실"(scanner_notable) — 순수 함수 + DB 입출력
//   규칙과 원칙은 supabase/2026-10-29_scanner_notable.sql 머리말과 같다.
//   - 원본(npm·PyPI)이 직접 표시한 값의 전환만. 기준선은 올리지 않는다(P7 만 예외: 새 선언의 첫 확인이 404).
//   - 외부 문자열(패키지 이름·버전·상태)은 형식 검사를 통과한 것만 쓴다. 설명·사유 문구는 쓰지 않는다.
//   - 같은 입력이면 같은 행(정렬 고정). published 는 항상 false(공개는 다음 단계).

import { supabaseHeaders, type SupabaseConfig } from './lib.ts';
import { getKeyset, isNpmName } from './npm-lib.ts';
import { isPypiName, normalizePypiName, PROJECT_STATUSES } from './pypi-lib.ts';
import { postBatches, type DiffIoDeps } from './registry-diff.ts';

export const NOTABLE_RULE_VERSION = 1;

export const RULE_IDS = [
  'P1_npm_deprecated',
  'P2_npm_not_found',
  'P4_pypi_archived',
  'P5_pypi_latest_yanked',
  'P6_pypi_not_found',
  'P7_declared_missing_package',
] as const;
export type RuleId = (typeof RULE_IDS)[number];

export interface NotableRow {
  day: string;
  rule_id: RuleId;
  rule_version: number;
  subject_kind: 'npm' | 'pypi';
  subject: string;
  group_key: string;
  evidence: Record<string, unknown>;
  published: false;
}

// ─────────────────────────────────────────────
// 입력
// ─────────────────────────────────────────────

export interface ChangeIn {
  detected_on: string;
  ident: string;
  kind: string;
  old_value: string | null;
  new_value: string | null;
}

export interface NewStateIn {
  ident: string;
  status: string;
  baseline: boolean;
  first_checked_at: string;
}

export interface DeclarationIn {
  name: string;
  packages_key: string | null;
}

export interface NotableInput {
  day: string;
  npmChanges: readonly ChangeIn[];
  pypiChanges: readonly ChangeIn[];
  /** 그날 처음 확인된 npm 패키지 상태 행 (first_checked_at 이 day) */
  npmFirstChecked: readonly NewStateIn[];
  pypiFirstChecked: readonly NewStateIn[];
  /** 각 테이블의 첫 전수 확인일 (가장 이른 first_checked_at 의 날짜). 그날은 P7 을 만들지 않는다. */
  npmInitialDay: string | null;
  pypiInitialDay: string | null;
  declarations: readonly DeclarationIn[];
}

const SAFE_VERSION = /^[0-9A-Za-z.+_!~-]{1,64}$/;
const ver = (v: string | null): string | null => (v && SAFE_VERSION.test(v) ? v : null);
const day10 = (iso: string) => iso.slice(0, 10);

// ─────────────────────────────────────────────
// 선언 색인: 패키지 → 지금 그것을 선언한 Registry 이름들
// ─────────────────────────────────────────────

export function declarationIndex(decls: readonly DeclarationIn[]): Map<string, string[]> {
  const idx = new Map<string, Set<string>>();
  for (const d of decls) {
    for (const line of (d.packages_key ?? '').split('\n')) {
      const fields = line.replace(/\r$/, '').split(' ');
      if (fields.length !== 4) continue;
      const [type, ident] = fields as [string, string, string, string];
      let key: string | null = null;
      if (type === 'npm' && isNpmName(ident)) key = `npm ${ident}`;
      else if (type === 'pypi' && isPypiName(ident)) key = `pypi ${normalizePypiName(ident)}`;
      if (!key) continue;
      if (!idx.has(key)) idx.set(key, new Set());
      idx.get(key)!.add(d.name);
    }
  }
  const out = new Map<string, string[]>();
  for (const [k, v] of idx) out.set(k, [...v].sort());
  return out;
}

/** 같은 날 묶음 키: npm scope(@scope) → 없으면 첫 Registry 네임스페이스 → 없으면 패키지 자체 */
export function groupKeyOf(kind: 'npm' | 'pypi', ident: string, registryNames: readonly string[]): string {
  if (kind === 'npm' && ident.startsWith('@') && ident.includes('/')) return `npm:${ident.slice(0, ident.indexOf('/'))}`;
  const first = registryNames[0];
  if (first && first.includes('/')) return `ns:${first.slice(0, first.indexOf('/')).toLowerCase()}`;
  return `${kind}:${ident}`;
}

// ─────────────────────────────────────────────
// 규칙
// ─────────────────────────────────────────────

export function buildNotable(input: NotableInput): { rows: NotableRow[]; skipped: number } {
  const idx = declarationIndex(input.declarations);
  const rows: NotableRow[] = [];
  let skipped = 0;

  const push = (rule_id: RuleId, kind: 'npm' | 'pypi', ident: string, evidence: Record<string, unknown>) => {
    const registry_names = idx.get(`${kind} ${ident}`) ?? [];
    rows.push({
      day: input.day,
      rule_id,
      rule_version: NOTABLE_RULE_VERSION,
      subject_kind: kind,
      subject: ident,
      group_key: groupKeyOf(kind, ident, registry_names),
      evidence: { package: ident, ...evidence, registry_names },
      published: false,
    });
  };

  for (const c of input.npmChanges) {
    if (c.detected_on !== input.day) continue;
    if (!isNpmName(c.ident)) {
      skipped++;
      continue;
    }
    if (c.kind === 'deprecated') push('P1_npm_deprecated', 'npm', c.ident, { version: ver(c.old_value) });
    else if (c.kind === 'not_found') push('P2_npm_not_found', 'npm', c.ident, { last_seen_latest: ver(c.old_value) });
  }

  const statuses = new Set<string>(PROJECT_STATUSES);
  for (const c of input.pypiChanges) {
    if (c.detected_on !== input.day) continue;
    const ident = normalizePypiName(c.ident);
    if (!isPypiName(c.ident)) {
      skipped++;
      continue;
    }
    if (c.kind === 'status_changed' && (c.new_value === 'archived' || c.new_value === 'quarantined')) {
      push('P4_pypi_archived', 'pypi', ident, {
        old_status: c.old_value && statuses.has(c.old_value) ? c.old_value : null,
        new_status: c.new_value,
      });
    } else if (c.kind === 'yanked') push('P5_pypi_latest_yanked', 'pypi', ident, { version: ver(c.old_value) });
    else if (c.kind === 'not_found') push('P6_pypi_not_found', 'pypi', ident, { last_seen_latest: ver(c.old_value) });
  }

  // P7: 새로 선언된 패키지의 첫 확인이 404. 첫 전수 확인일(기준선 전체)은 제외, 지금 선언 중인 것만.
  const p7 = (kind: 'npm' | 'pypi', list: readonly NewStateIn[], initialDay: string | null) => {
    if (initialDay === null || input.day <= initialDay) return;
    for (const s of list) {
      if (s.status !== 'not_found' || !s.baseline || day10(s.first_checked_at) !== input.day) continue;
      const ok = kind === 'npm' ? isNpmName(s.ident) : isPypiName(s.ident);
      if (!ok) {
        skipped++;
        continue;
      }
      const ident = kind === 'pypi' ? normalizePypiName(s.ident) : s.ident;
      if (!idx.has(`${kind} ${ident}`)) continue;
      push('P7_declared_missing_package', kind, ident, { registry_type: kind, first_checked_at: s.first_checked_at });
    }
  };
  p7('npm', input.npmFirstChecked, input.npmInitialDay);
  p7('pypi', input.pypiFirstChecked, input.pypiInitialDay);

  // 같은 (rule, kind, subject) 는 한 번만, 순서 고정
  const seen = new Set<string>();
  const out = rows
    .filter((r) => {
      const k = `${r.rule_id} ${r.subject_kind} ${r.subject}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .sort((a, b) => (a.rule_id === b.rule_id ? (a.subject < b.subject ? -1 : a.subject > b.subject ? 1 : 0) : a.rule_id < b.rule_id ? -1 : 1));
  return { rows: out, skipped };
}

/** 하루 요약: 규칙별 건수, 묶음(2건 이상) 수, 묶은 뒤 줄 수 */
export function summarize(rows: readonly NotableRow[]): { byRule: Record<string, number>; groups: number; lines: number } {
  const byRule: Record<string, number> = {};
  const byGroup = new Map<string, number>();
  for (const r of rows) {
    byRule[r.rule_id] = (byRule[r.rule_id] ?? 0) + 1;
    const g = `${r.rule_id} ${r.group_key}`;
    byGroup.set(g, (byGroup.get(g) ?? 0) + 1);
  }
  const groups = [...byGroup.values()].filter((n) => n > 1).length;
  return { byRule, groups, lines: byGroup.size };
}

// ─────────────────────────────────────────────
// DB 입출력
// ─────────────────────────────────────────────

/** 작은 표 읽기(한 번, 상한 초과면 실패 → 잘린 결과로 쓰지 않는다) */
async function getSmall<T>(cfg: SupabaseConfig, table: string, params: Array<[string, string]>, deps: DiffIoDeps, max = 10_000): Promise<T[]> {
  const f = deps.fetchImpl ?? fetch;
  const qs = new URLSearchParams(params);
  qs.set('limit', String(max));
  const res = await f(`${cfg.url.replace(/\/+$/, '')}/rest/v1/${table}?${qs.toString()}`, {
    headers: supabaseHeaders(cfg.key, { Accept: 'application/json' }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`${table} read failed: HTTP ${res.status}`);
  const rows = (await res.json()) as T[];
  if (!Array.isArray(rows)) throw new Error(`${table} read failed: unexpected response`);
  if (rows.length >= max) throw new Error(`${table} read: ${rows.length} rows hit the limit ${max}`);
  return rows;
}

function nextDay(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/** 가장 이른 first_checked_at 의 날짜 (첫 전수 확인일) */
async function initialDay(cfg: SupabaseConfig, table: string, deps: DiffIoDeps): Promise<string | null> {
  const res = await (deps.fetchImpl ?? fetch)(`${cfg.url.replace(/\/+$/, '')}/rest/v1/${table}?select=first_checked_at&order=first_checked_at.asc&limit=1`, {
    headers: supabaseHeaders(cfg.key, { Accept: 'application/json' }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`${table} read failed: HTTP ${res.status}`);
  const r = (await res.json()) as Array<{ first_checked_at: string }>;
  return Array.isArray(r) && r[0] && typeof r[0].first_checked_at === 'string' ? day10(r[0].first_checked_at) : null;
}

export async function fetchNotableInput(cfg: SupabaseConfig, day: string, deps: DiffIoDeps = {}): Promise<NotableInput> {
  const changeCols = 'detected_on,ident,kind,old_value,new_value';
  const stateCols = 'ident,status,baseline,first_checked_at';
  const dayRange: Array<[string, string]> = [
    ['first_checked_at', `gte.${day}T00:00:00Z`],
    ['first_checked_at', `lt.${nextDay(day)}T00:00:00Z`],
  ];
  const [npmChanges, pypiChanges, npmFirstChecked, pypiFirstChecked, npmInitialDay, pypiInitialDay, declarations] = await Promise.all([
    getSmall<ChangeIn>(cfg, 'npm_package_changes', [['select', changeCols], ['detected_on', `eq.${day}`], ['kind', 'in.(deprecated,not_found)']], deps),
    getSmall<ChangeIn>(cfg, 'pypi_package_changes', [['select', changeCols], ['detected_on', `eq.${day}`], ['kind', 'in.(status_changed,yanked,not_found)']], deps),
    getSmall<NewStateIn>(cfg, 'npm_package_state', [['select', stateCols], ['status', 'eq.not_found'], ...dayRange], deps),
    getSmall<NewStateIn>(cfg, 'pypi_package_state', [['select', stateCols], ['status', 'eq.not_found'], ...dayRange], deps),
    initialDay(cfg, 'npm_package_state', deps),
    initialDay(cfg, 'pypi_package_state', deps),
    getKeyset<DeclarationIn & Record<string, unknown>>(cfg, 'registry_state', 'name,packages_key', 'name', [['removed_at', 'is.null'], ['packages_key', 'neq.']], deps),
  ]);
  return { day, npmChanges, pypiChanges, npmFirstChecked, pypiFirstChecked, npmInitialDay, pypiInitialDay, declarations };
}

export function insertNotable(cfg: SupabaseConfig, rows: readonly NotableRow[], deps: DiffIoDeps = {}): Promise<number> {
  return postBatches(cfg, 'scanner_notable?on_conflict=day,rule_id,subject_kind,subject', rows, 'resolution=ignore-duplicates,return=minimal', deps);
}
