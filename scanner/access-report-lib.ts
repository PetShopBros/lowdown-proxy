// Lowdown Data Access Report (2026-11-14) — 측정 체계 5번. 프로젝트 문서 claude/lowdown-measurement-plan-2026-11-14.md
// Ecosystem Observation Report(monthly-lib.ts, 관측 데이터)와 섞지 않는다. 여기는 Lowdown 데이터가 어떻게 읽히고 쓰였는지만.
//
// 원천
//   access_daily (비공개, 10/30~): 분류별 하루 합계. supabase/2026-11-14_access_metrics.sql · 2026-11-14_citation.sql
//   reputation_lookups: 인용 링크 발급 수(응답에 cite_url 이 실린 조회) — Registry 이름이 확정된 조회(result_kind observed·registry_only)로 센다.
//
// 원칙: 숫자를 수요로 읽지 않는다. UA 는 자기 선언(IP 미저장 → 진위 확인 불가). 대상 서버 이름은 내부 json 에만(md 에 넣지 않는다).
// 재요청 간격(FRESHNESS)과 고유 경로 수는 access_daily 에 없어서 v1 에 넣지 않는다(edge_hits 전수 읽기는 DB 부담).

import { fetchRetry } from './rest-retry.ts';
import { supabaseHeaders, type SupabaseConfig } from './lib.ts';
import { countRows, type MonthRange } from './monthly-lib.ts';

export interface AccessRow {
  day: string;
  category: string;
  ua_name: string;
  path_kind: string;
  target: string;
  evidence: string;
  hits: number;
}

/** 인용 링크(ref=cite)가 조회 응답에 실리기 시작한 날(c7bd7e9 배포 2026-11-13 20:40 UTC, 서버 카드는 다음 날 다시 만들어짐) */
export const CITE_ISSUED_FROM = '2026-11-14T00:00:00.000Z';
/** cite_url 이 실리는 응답 종류: Registry 이름이 확정된 조회 */
export const CITE_RESULT_KINDS = ['observed', 'registry_only'] as const;

/** 이 보고서가 다루는 기간에 Lowdown 쪽에서 바뀐 것(날짜만, 인과 주장 없음) */
export const MILESTONES: ReadonlyArray<{ day: string; what: string }> = [
  { day: '2026-10-30', what: 'access_daily starts (earlier days have no classified access record).' },
  { day: '2026-11-13', what: 'Lookup responses start to carry a cite link (`?ref=cite`).' },
  { day: '2026-11-14', what: 'lowdown-proxy 0.1.22 adds the install-check record to `initialize` (connect-check User-Agent).' },
  { day: '2026-11-14', what: 'Server pages start to carry the Evidence Snapshot JSON block (`#lowdown-evidence`).' },
];

const READ_CATS = ['read_crawler', 'read_prober', 'read_other'] as const;
const TOP = 10;

export interface Issuance {
  counted_from: string;
  total: number;
  direct: number; // ref 없음 (조회 API 를 바로 부른 요청)
  page: number; // ref=page (서버 페이지를 만들 때의 안쪽 조회)
  mcp: number; // ref=mcp (원격 MCP 경유)
  other_ref: number;
  crawler: number; // 그중 크롤러로 분류된 요청
}

export interface AccessData {
  report: 'lowdown.data-access-report';
  month: string;
  period: { start: string; end: string };
  partial: boolean;
  generated_at: string;
  days_with_data: number;
  first_day: string | null;
  last_day: string | null;
  self_excluded_hits: number;
  read: { total: number; crawler: number; prober: number; other: number; top_ua: Array<{ name: string; hits: number }>; path_kinds: Record<string, number> };
  citation: {
    issued: Issuance | null;
    link_access: { total: number; by_evidence: Record<string, number>; distinct_targets: number; days: number };
    confirmed: number | null;
  };
  ai_labeled: { total: number; distinct_targets: number; days: number; by_ua: Record<string, number>; by_path_kind: Record<string, number> };
  ai_mcp: { total: number; by_ua: Record<string, number> };
  execution: { total: number; by_outcome: Record<string, number>; by_tool: Record<string, Record<string, number>> };
  demand_map_conditions: { c1_distinct_targets: number; c1_days: number; c2: 'not_assessed'; c3: 'not_assessed' };
  milestones: typeof MILESTONES;
  /** 내부용(게시 금지): 대상 서버별 합계 */
  internal: { ai_labeled_targets: Array<{ target: string; hits: number; days: number }>; citation_targets: Array<{ target: string; hits: number; days: number }> };
}

const add = (m: Record<string, number>, k: string, n: number) => {
  m[k] = (m[k] ?? 0) + n;
};
const sortDesc = (m: Record<string, number>): Record<string, number> =>
  Object.fromEntries(Object.entries(m).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));

function targetList(rows: AccessRow[]): Array<{ target: string; hits: number; days: number }> {
  const m = new Map<string, { hits: number; days: Set<string> }>();
  for (const r of rows) {
    if (!r.target) continue;
    const e = m.get(r.target) ?? { hits: 0, days: new Set<string>() };
    e.hits += r.hits;
    e.days.add(r.day);
    m.set(r.target, e);
  }
  return [...m.entries()].map(([target, e]) => ({ target, hits: e.hits, days: e.days.size })).sort((a, b) => b.hits - a.hits || a.target.localeCompare(b.target));
}

/** 'tool:outcome' → [tool, outcome]. 도구 이름에 ':' 가 있어도 마지막 ':' 로 나눈다 */
export function splitToolOutcome(pk: string): [string, string] {
  const i = pk.lastIndexOf(':');
  return i <= 0 ? [pk || '-', '-'] : [pk.slice(0, i), pk.slice(i + 1) || '-'];
}

export function buildAccess(rows: AccessRow[], issued: Issuance | null, range: MonthRange, now: Date, confirmed: number | null = null): AccessData {
  const inRange = rows.filter((r) => r.day >= range.startDay && r.day < range.endDay && Number.isFinite(r.hits) && r.hits >= 0);
  const days = [...new Set(inRange.map((r) => r.day))].sort();
  const by = (cat: string) => inRange.filter((r) => r.category === cat);
  const sum = (rs: AccessRow[]) => rs.reduce((a, r) => a + r.hits, 0);
  const daysOf = (rs: AccessRow[]) => new Set(rs.map((r) => r.day)).size;

  const reads = inRange.filter((r) => (READ_CATS as readonly string[]).includes(r.category));
  const ua: Record<string, number> = {};
  const pk: Record<string, number> = {};
  for (const r of reads) {
    if (r.category !== 'read_other' && r.ua_name !== '-') add(ua, r.ua_name, r.hits);
    add(pk, r.path_kind, r.hits);
  }

  const cit = by('citation');
  const citEv: Record<string, number> = {};
  for (const r of cit) add(citEv, r.evidence, r.hits);

  const ail = by('ai_labeled');
  const ailUa: Record<string, number> = {};
  const ailPk: Record<string, number> = {};
  for (const r of ail) {
    add(ailUa, r.ua_name, r.hits);
    add(ailPk, r.path_kind, r.hits);
  }
  const aim = by('ai_mcp');
  const aimUa: Record<string, number> = {};
  for (const r of aim) add(aimUa, r.ua_name, r.hits);

  const ex = by('execution');
  const exOut: Record<string, number> = {};
  const exTool: Record<string, Record<string, number>> = {};
  for (const r of ex) {
    const [tool, outcome] = splitToolOutcome(r.path_kind);
    add(exOut, outcome, r.hits);
    add((exTool[tool] ??= {}), outcome, r.hits);
  }

  const ailTargets = targetList(ail);
  return {
    report: 'lowdown.data-access-report',
    month: range.label,
    period: { start: range.startDay, end: range.endDay },
    partial: now.toISOString() < range.end,
    generated_at: now.toISOString(),
    days_with_data: days.length,
    first_day: days[0] ?? null,
    last_day: days[days.length - 1] ?? null,
    self_excluded_hits: sum(by('self')),
    read: {
      total: sum(reads),
      crawler: sum(by('read_crawler')),
      prober: sum(by('read_prober')),
      other: sum(by('read_other')),
      top_ua: Object.entries(sortDesc(ua)).slice(0, TOP).map(([name, hits]) => ({ name, hits })),
      path_kinds: sortDesc(pk),
    },
    citation: {
      issued,
      link_access: { total: sum(cit), by_evidence: sortDesc(citEv), distinct_targets: new Set(cit.map((r) => r.target).filter(Boolean)).size, days: daysOf(cit) },
      confirmed,
    },
    ai_labeled: { total: sum(ail), distinct_targets: ailTargets.length, days: daysOf(ail), by_ua: sortDesc(ailUa), by_path_kind: sortDesc(ailPk) },
    ai_mcp: { total: sum(aim), by_ua: sortDesc(aimUa) },
    execution: { total: sum(ex), by_outcome: sortDesc(exOut), by_tool: Object.fromEntries(Object.entries(exTool).sort((a, b) => sum2(b[1]) - sum2(a[1]) || a[0].localeCompare(b[0]))) },
    demand_map_conditions: { c1_distinct_targets: ailTargets.length, c1_days: daysOf(ail), c2: 'not_assessed', c3: 'not_assessed' },
    milestones: MILESTONES.filter((m) => m.day >= range.startDay && m.day < range.endDay),
    internal: { ai_labeled_targets: ailTargets, citation_targets: targetList(cit) },
  };
}
const sum2 = (m: Record<string, number>) => Object.values(m).reduce((a, b) => a + b, 0);

// ── 출력 ─────────────────────────────────────────────
const n = (v: number) => v.toLocaleString('en-US');
const daysText = (v: number) => `${n(v)} ${v === 1 ? 'day' : 'days'}`;
const serversText = (v: number) => `${n(v)} distinct ${v === 1 ? 'server' : 'servers'}`;
const pct = (a: number, b: number) => (b > 0 ? `${((a / b) * 100).toFixed(1)}%` : '—');
const kv = (m: Record<string, number>, limit = TOP) => {
  const e = Object.entries(m).slice(0, limit);
  return e.length ? e.map(([k, v]) => `\`${k}\` ${n(v)}`).join(' · ') : 'none';
};

/** 공개 가능한 합계만. internal(대상 서버 이름)은 넣지 않는다. */
export function renderAccess(d: AccessData): string {
  const r = d.read;
  const c = d.citation;
  const x = d.execution;
  const ok = x.by_outcome.ok ?? 0;
  const out: string[] = [
    `# Lowdown Data Access Report — ${d.month}`,
    '',
    d.partial
      ? `> DRAFT: generated ${d.generated_at} before the month closed. Numbers will change.`
      : `> Generated ${d.generated_at}. Period: ${d.period.start} to ${d.period.end} (UTC, end excluded).`,
    '',
    'How Lowdown\'s records were read and used. Observations about MCP servers are in the separate Ecosystem Observation Report; the two are not mixed.',
    'Each section below is an independent observed event, not a step in a funnel. User-Agent names are self-declared; Lowdown does not store IP addresses, so names cannot be verified.',
    `Days with classified records in this period: ${n(d.days_with_data)}${d.first_day ? ` (${d.first_day} to ${d.last_day})` : ''}. Lowdown's own requests (scanner, tests, smoke checks: ${n(d.self_excluded_hits)}) are excluded everywhere.`,
    '',
    '## 1. Reads',
    '',
    `- Requests: ${n(r.total)} — crawlers ${n(r.crawler)} (${pct(r.crawler, r.total)}), checkers ${n(r.prober)}, other ${n(r.other)}`,
    `- Most frequent declared names (crawlers and checkers): ${r.top_ua.length ? r.top_ua.map((u) => `${u.name} ${n(u.hits)}`).join(' · ') : 'none'}`,
    `- By path kind: ${kv(r.path_kinds)}`,
    '',
    '_Reads show distribution, not demand or interest._',
    '',
    '## 2. Citation links',
    '',
    c.issued
      ? `- Links issued: ${n(c.issued.total)} lookup responses carried a cite link since ${c.issued.counted_from.slice(0, 10)} (direct ${n(c.issued.direct)}, via server pages ${n(c.issued.page)}, via remote MCP ${n(c.issued.mcp)}, other ${n(c.issued.other_ref)}; of all, ${n(c.issued.crawler)} to crawlers). Responses served from cache are not recorded, so this undercounts.`
      : '- Links issued: not counted for this period (cite links started on 2026-11-13).',
    `- Link accesses: ${n(c.link_access.total)} (${kv(c.link_access.by_evidence)}), ${serversText(c.link_access.distinct_targets)}, ${daysText(c.link_access.days)}. Crawler and checker requests to these links are counted as reads, not here.`,
    `- Citations confirmed (checked by hand in a published answer): ${c.confirmed === null ? 'none recorded' : n(c.confirmed)}`,
    '',
    '_A link access means a request arrived through the link. It does not show that an AI answer cited Lowdown._',
    '',
    '## 3. AI-labeled client requests',
    '',
    `- Server pages and lookups opened by clients that declare an AI assistant (for example ChatGPT-User, Claude-User): ${n(d.ai_labeled.total)}, ${serversText(d.ai_labeled.distinct_targets)}, ${daysText(d.ai_labeled.days)}`,
    `- By declared name: ${kv(d.ai_labeled.by_ua)}`,
    `- By path kind: ${kv(d.ai_labeled.by_path_kind)}`,
    `- Requests to the remote MCP endpoint from the same kind of clients (connection handshakes included, counted apart): ${n(d.ai_mcp.total)}`,
    '',
    '_These requests do not show that a person asked a question or that an answer used the record._',
    '',
    '## 4. External tool calls',
    '',
    `- \`tools/call\` on the remote MCP server: ${n(x.total)} (ok ${n(ok)}, ${pct(ok, x.total)})`,
    `- By outcome: ${kv(x.by_outcome)}`,
    `- By tool: ${Object.entries(x.by_tool).slice(0, TOP).map(([t, m]) => `\`${t}\` ${n(sum2(m))}`).join(' · ') || 'none'}`,
    '',
    '_A tool call does not show that an end user adopted the result._',
    '',
    '## 5. Changes on Lowdown\'s side in this period',
    '',
    ...(d.milestones.length ? d.milestones.map((m) => `- ${m.day}: ${m.what}`) : ['- none']),
    '',
    '_Dates only. No claim that a change caused any number above._',
    '',
    '## 6. Not included',
    '',
    '- Re-read intervals and distinct paths (not in the daily summary table).',
    '- Topics or categories "of interest" to crawlers.',
    '- Server names behind the counts in sections 2 and 3.',
    '',
    '## 7. Method',
    '',
    '- Source: Lowdown\'s request records (path, User-Agent, time; no IP addresses), summarized once a day into categories: reads (crawler, checker, other), citation-link access, AI-labeled requests, remote MCP requests, and `tools/call` records. See the [privacy policy](https://lowdown-proxy.vercel.app/privacy).',
    '- Categories follow the declared User-Agent. A crawler opening a cite link counts as a read.',
    '',
  ];
  return out.join('\n');
}

// ── 읽기 ─────────────────────────────────────────────
export interface AccessDeps {
  fetchImpl?: typeof fetch;
  pageSize?: number;
}

/** access_daily [startDay, endDay) — 작은 요약 표라 주키 순서 + 범위 페이지로 읽는다 */
export async function fetchAccessRows(cfg: SupabaseConfig, range: MonthRange, deps: AccessDeps = {}): Promise<AccessRow[]> {
  const base = cfg.url.replace(/\/+$/, '');
  const size = deps.pageSize ?? 1000;
  const out: AccessRow[] = [];
  for (let from = 0; ; from += size) {
    const qs = new URLSearchParams({
      select: 'day,category,ua_name,path_kind,target,evidence,hits',
      and: `(day.gte.${range.startDay},day.lt.${range.endDay})`,
      order: 'day.asc,category.asc,ua_name.asc,path_kind.asc,target.asc',
    });
    const url = `${base}/rest/v1/access_daily?${qs.toString()}`;
    const init = (): RequestInit => ({ headers: supabaseHeaders(cfg.key, { Range: `${from}-${from + size - 1}` }), signal: AbortSignal.timeout(30_000) });
    let res: Response;
    if (deps.fetchImpl) {
      res = await deps.fetchImpl(url, init());
      if (!res.ok) throw new Error(`access_daily read failed: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`.trim());
    } else res = await fetchRetry(url, init, 'access_daily read');
    const page = (await res.json()) as AccessRow[];
    for (const p of page) out.push({ ...p, day: String(p.day).slice(0, 10), hits: Number(p.hits) });
    if (page.length < size) break;
  }
  return out;
}

const NOT_SELF = '(user_agent.is.null,and(user_agent.not.like.lowdown-scanner/*,user_agent.not.like.lowdown-test/*,user_agent.not.like.lowdown-smoke/*))';

/** 인용 링크 발급 수: CITE_ISSUED_FROM 이후, Registry 이름이 확정된 조회. 기간이 그보다 앞이면 null */
export async function fetchIssuance(cfg: SupabaseConfig, range: MonthRange, deps: AccessDeps = {}): Promise<Issuance | null> {
  if (range.end <= CITE_ISSUED_FROM) return null;
  const from = range.start > CITE_ISSUED_FROM ? range.start : CITE_ISSUED_FROM;
  const f = { and: `(created_at.gte.${from},created_at.lt.${range.end})`, result_kind: `in.(${CITE_RESULT_KINDS.join(',')})`, or: NOT_SELF };
  const c = (extra: Record<string, string>) => countRows(cfg, 'reputation_lookups', { ...f, ...extra }, deps);
  const total = await c({});
  const direct = await c({ ref: 'is.null' });
  const page = await c({ ref: 'eq.page' });
  const mcp = await c({ ref: 'eq.mcp' });
  const crawler = await c({ bot_kind: 'eq.crawler' });
  return { counted_from: from, total, direct, page, mcp, other_ref: Math.max(0, total - direct - page - mcp), crawler };
}
