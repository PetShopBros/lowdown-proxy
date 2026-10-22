// Lowdown 시장판 3단계 — 일일 기록 페이지·피드 (의존성 0)
// 원칙
//   - 사실 종류를 섞지 않는다: Registry 선언 변화 / Scanner 관찰(숫자만) / First observed by Lowdown / 도구 정의 변화(숫자만)
//   - 항목별 해석 문장·점수·순위 없음. 정렬은 이름순. 해석은 about 페이지에 한 번만.
//   - 외부에서 온 문자열은 허용 형식만 통과(나머지는 개수로만). 설명문·원격 URL·원문은 싣지 않는다.
//   - 하루 JSON 이 유일한 원본: HTML·RSS·JSON Feed 는 디스크의 하루 JSON 들에서만 만든다(서로 다른 사실이 나가지 않게).
//   - 하루 JSON 에는 생성 시각을 넣지 않는다(같은 데이터로 다시 돌리면 같은 바이트 → 커밋 없음).

export const DAY_SCHEMA = 'lowdown-market-day/1';
export const FEED_DAYS = 30;

// ─────────────────────────────────────────────
// 허용 형식
// ─────────────────────────────────────────────

const REGISTRY_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const HOSTNAME = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;
const VERSION = /^[0-9A-Za-z.+_-]{1,64}$/;
const STATUS = /^[a-z_]{1,32}$/;
const FIRST_SEEN_VALUE: Record<string, RegExp> = {
  capability: /^[A-Za-z][A-Za-z0-9_]{0,31}$/,
  protocol_version: /^[0-9A-Za-z._-]{1,32}$/,
  tool_name: /^[A-Za-z0-9_.\-/]{1,64}$/,
};
const DAY = /^\d{4}-\d{2}-\d{2}$/;

export const safeName = (v: unknown): string | null => (typeof v === 'string' && REGISTRY_NAME.test(v) ? v : null);
export const safeHost = (v: unknown): string | null => (typeof v === 'string' && HOSTNAME.test(v) ? v : null);
const safeVersion = (v: unknown): string | null => (typeof v === 'string' && VERSION.test(v) ? v : null);
const safeStatus = (v: unknown): string | null => (typeof v === 'string' && STATUS.test(v) ? v : null);

// ─────────────────────────────────────────────
// 입력 (DB 에서 읽은 행) → 하루 JSON
// ─────────────────────────────────────────────

export const REGISTRY_KINDS = ['new', 'removed', 'restored', 'version', 'status', 'remotes', 'packages', 'description'] as const;
export type RegistryKind = (typeof REGISTRY_KINDS)[number];

export interface RegistryChangeInput {
  name: unknown;
  kind: unknown;
  old_value: unknown;
  new_value: unknown;
  hosts: unknown;
}

export interface RegistryItem {
  name: string;
  hosts?: string[];
  old?: string | null;
  new?: string | null;
}

export interface ObservationSummary {
  cohort_version: string;
  cohort_size: number;
  targets_observed: number;
  probe_attempts: number;
  reached_level: { '0': number; '1': number; '2': number };
}

export interface ToolDefinitionSummary {
  /** 두 실행 모두에서 tools/list 까지 성공한 (대상, 원격) 수 = 비교 분모 */
  compared: number;
  description_changed: number;
  schema_changed: number;
  /** 변경이 있었던 Registry 네임스페이스 수 (한 게시자 몰림을 숫자로만 보여줌) */
  namespaces_with_changes: number;
  previous_data_as_of: string;
}

/** 재사용될 때 출처가 함께 이동하도록 하루 JSON 에 싣는 출처 정보(CC BY 4.0 출처 표기용). 생성 시각은 넣지 않는다(멱등). */
export interface DaySource {
  name: 'Lowdown';
  page: string;
  dataset: string;
  license: 'CC BY 4.0';
  license_url: string;
  cite: string;
}

export const DATASET_URL = 'https://github.com/PetShopBros/lowdown-data';
export const LICENSE_URL = 'https://creativecommons.org/licenses/by/4.0/';

export function daySource(day: string, dataAsOf: string, siteBaseUrl: string): DaySource {
  const page = `${siteBaseUrl}days/${day}.html`;
  return {
    name: 'Lowdown',
    page,
    dataset: DATASET_URL,
    license: 'CC BY 4.0',
    license_url: LICENSE_URL,
    cite: `Lowdown, MCP daily record ${day} (data as of ${dataAsOf}), ${page}, CC BY 4.0`,
  };
}

export interface MarketDay {
  schema: typeof DAY_SCHEMA;
  day: string;
  data_as_of: string;
  scan_run_id: string;
  /** 10/22 부터. 이전 날짜 파일에는 없다(과거 기록은 고치지 않음). */
  source?: DaySource;
  registry: {
    counts: Record<RegistryKind, number>;
    /** 허용 형식이 아니어서 이름을 싣지 않은 이벤트 수 */
    unlisted: number;
    items: Record<RegistryKind, RegistryItem[]>;
  };
  observations: { current: ObservationSummary; previous: ObservationSummary | null };
  tool_definitions: ToolDefinitionSummary | null;
  first_observed: Array<{ kind: string; value: string }>;
}

const byName = (a: { name: string }, b: { name: string }) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

export function registrySection(rows: readonly RegistryChangeInput[]): MarketDay['registry'] {
  const counts = Object.fromEntries(REGISTRY_KINDS.map((k) => [k, 0])) as Record<RegistryKind, number>;
  const items = Object.fromEntries(REGISTRY_KINDS.map((k) => [k, [] as RegistryItem[]])) as Record<RegistryKind, RegistryItem[]>;
  let unlisted = 0;
  for (const r of rows) {
    const kind = REGISTRY_KINDS.find((k) => k === r.kind);
    if (!kind) continue;
    counts[kind]++;
    const name = safeName(r.name);
    if (!name) {
      unlisted++;
      continue;
    }
    const hosts = (Array.isArray(r.hosts) ? r.hosts : []).map(safeHost).filter((h): h is string => h !== null).sort();
    const item: RegistryItem = { name };
    if (kind === 'new' || kind === 'removed' || kind === 'restored' || kind === 'remotes') item.hosts = [...new Set(hosts)];
    if (kind === 'version') {
      item.old = safeVersion(r.old_value);
      item.new = safeVersion(r.new_value);
    }
    if (kind === 'status') {
      item.old = safeStatus(r.old_value);
      item.new = safeStatus(r.new_value);
    }
    // packages / description / remotes: 값(URL·패키지 키·해시)은 싣지 않는다 — "바뀌었다"만
    items[kind].push(item);
  }
  for (const k of REGISTRY_KINDS) items[k].sort(byName);
  return { counts, unlisted, items };
}

export interface FirstSeenInput {
  kind: unknown;
  value: unknown;
  hosts: unknown;
  namespaces: unknown;
}

/** 공개 기준(노출 정책)은 first-seen.ts isPublishable 과 같다: tool_name 은 호스트 2 + 네임스페이스 2 이상 */
export function firstObservedSection(rows: readonly FirstSeenInput[]): MarketDay['first_observed'] {
  const out: MarketDay['first_observed'] = [];
  for (const r of rows) {
    if (typeof r.kind !== 'string' || typeof r.value !== 'string') continue;
    const re = FIRST_SEEN_VALUE[r.kind];
    if (!re || !re.test(r.value)) continue;
    if (r.kind === 'tool_name' && !(Number(r.hosts) >= 2 && Number(r.namespaces) >= 2)) continue;
    out.push({ kind: r.kind, value: r.value });
  }
  return out.sort((a, b) => (a.kind + '\u0000' + a.value < b.kind + '\u0000' + b.value ? -1 : 1));
}

export interface DefRowInput {
  target_id: string;
  remote_url: string | null;
  reached_level: number;
  desc_hash: string | null;
  schema_hash: string | null;
}

function namespaceOf(targetId: string): string {
  const name = targetId.startsWith('mcp:') ? targetId.slice(4) : targetId;
  const i = name.indexOf('/');
  return (i > 0 ? name.slice(0, i) : name).toLowerCase();
}

/** 직전 실행 대비 서버 단위 정의 변화 (숫자만). 비교 단위는 (대상, 원격 주소) — 원격이 여러 개인 서버의 가짜 변경 방지. */
export function toolDefinitionSection(current: readonly DefRowInput[], previous: readonly DefRowInput[], previousDataAsOf: string): ToolDefinitionSummary {
  const key = (r: DefRowInput) => `${r.target_id}\u0000${r.remote_url ?? ''}`;
  const ok = (r: DefRowInput) => r.reached_level === 2 && typeof r.desc_hash === 'string' && typeof r.schema_hash === 'string';
  const prev = new Map<string, DefRowInput>();
  for (const r of previous) if (ok(r)) prev.set(key(r), r);
  let compared = 0;
  let desc = 0;
  let schema = 0;
  const ns = new Set<string>();
  const seen = new Set<string>();
  for (const r of current) {
    if (!ok(r)) continue;
    const k = key(r);
    if (seen.has(k)) continue;
    seen.add(k);
    const p = prev.get(k);
    if (!p) continue;
    compared++;
    const d = p.desc_hash !== r.desc_hash;
    const s = p.schema_hash !== r.schema_hash;
    if (d) desc++;
    if (s) schema++;
    if (d || s) ns.add(namespaceOf(r.target_id));
  }
  return { compared, description_changed: desc, schema_changed: schema, namespaces_with_changes: ns.size, previous_data_as_of: previousDataAsOf };
}

export function buildDay(input: {
  day: string;
  dataAsOf: string;
  scanRunId: string;
  registryRows: readonly RegistryChangeInput[];
  observations: { current: ObservationSummary; previous: ObservationSummary | null };
  toolDefinitions: ToolDefinitionSummary | null;
  firstSeenRows: readonly FirstSeenInput[];
  /** 주면 출처(source)를 싣는다. 끝에 / 포함 */
  siteBaseUrl?: string;
}): MarketDay {
  if (!DAY.test(input.day)) throw new Error(`invalid day ${input.day}`);
  return {
    schema: DAY_SCHEMA,
    day: input.day,
    data_as_of: input.dataAsOf,
    scan_run_id: input.scanRunId,
    ...(input.siteBaseUrl ? { source: daySource(input.day, input.dataAsOf, input.siteBaseUrl) } : {}),
    registry: registrySection(input.registryRows),
    observations: input.observations,
    tool_definitions: input.toolDefinitions,
    first_observed: firstObservedSection(input.firstSeenRows),
  };
}

/** 하루 JSON 직렬화 — 결정적(키 순서 고정, 끝 줄바꿈). */
export function serializeDay(d: MarketDay): string {
  return `${JSON.stringify(d, null, 2)}\n`;
}

export function parseDay(text: string): MarketDay {
  const d = JSON.parse(text) as MarketDay;
  if (d?.schema !== DAY_SCHEMA || typeof d.day !== 'string' || !DAY.test(d.day)) throw new Error('not a market day file');
  return d;
}

/**
 * 같은 날짜를 다시 돌릴 때의 규칙(멱등):
 *  - 기존 파일과 바이트가 같으면 아무것도 쓰지 않는다.
 *  - 가장 최근 날짜(또는 새 날짜)만 쓴다. 더 새로운 날짜가 이미 있으면 과거 기록은 고치지 않는다.
 */
export function dayWriteDecision(day: string, existingDays: readonly string[], existingText: string | null, nextText: string): 'write' | 'unchanged' | 'past_day_locked' {
  if (existingText === nextText) return 'unchanged';
  const newest = [...existingDays].sort().at(-1);
  if (newest !== undefined && day < newest) return 'past_day_locked';
  return 'write';
}

// ─────────────────────────────────────────────
// 렌더링 (HTML·RSS·JSON Feed·sitemap) — 모두 하루 JSON 에서만
// ─────────────────────────────────────────────

export interface SiteConfig {
  baseUrl: string; // 끝에 / 포함
  apiBase: string; // 예: https://lowdown-proxy.vercel.app
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const n = (v: number) => v.toLocaleString('en-US');

const KIND_TITLE: Record<RegistryKind, string> = {
  new: 'New names',
  removed: 'Removed from the latest list',
  restored: 'Restored',
  version: 'Version changed',
  status: 'Status changed',
  remotes: 'Remote declaration changed',
  packages: 'Package declaration changed',
  description: 'Description changed',
};

const pl = (v: number, one: string, many: string) => `${n(v)} ${v === 1 ? one : many}`;

export function daySummaryText(d: MarketDay): string {
  const r = d.registry.counts;
  const o = d.observations.current;
  const parts = [
    `Registry: ${pl(r.new, 'new name', 'new names')}, ${pl(r.removed, 'removal', 'removals')}, ${pl(r.version, 'version change', 'version changes')}, ${pl(r.status, 'status change', 'status changes')}, ${pl(r.remotes, 'remote change', 'remote changes')}, ${pl(r.description, 'description change', 'description changes')}.`,
    `Observed sample: ${n(o.targets_observed)} of ${pl(o.cohort_size, 'server', 'servers')}; tools/list reached on ${n(o.reached_level['2'])} of ${pl(o.probe_attempts, 'attempt', 'attempts')}.`,
  ];
  if (d.tool_definitions) {
    const t = d.tool_definitions;
    parts.push(`Tool definitions vs previous run: ${pl(t.description_changed, 'description change', 'description changes')} and ${pl(t.schema_changed, 'schema change', 'schema changes')} among ${pl(t.compared, 'compared server', 'compared servers')}.`);
  }
  if (d.first_observed.length > 0) parts.push(`First observed by Lowdown: ${pl(d.first_observed.length, 'value', 'values')}.`);
  return parts.join(' ');
}

const CSS = `:root{--bg:#fff;--fg:#1a1a1a;--muted:#5c5c5c;--line:#e3e3e3;--accent:#0b5cad;--chip:#f3f4f6}
@media (prefers-color-scheme:dark){:root{--bg:#111315;--fg:#e8e8e8;--muted:#a3a3a3;--line:#2c2f33;--accent:#6aa9ec;--chip:#1c1f23}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:860px;margin:0 auto;padding:24px 16px 64px}a{color:var(--accent)}h1{font-size:1.5rem;margin:0 0 4px}
h2{font-size:1.15rem;margin:32px 0 8px;padding-top:16px;border-top:1px solid var(--line)}h3{font-size:1rem;margin:20px 0 6px}
.muted{color:var(--muted)}.nums{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:8px;margin:8px 0}
.num{background:var(--chip);border-radius:8px;padding:8px 10px}.num b{display:block;font-size:1.15rem;font-variant-numeric:tabular-nums}
ul{padding-left:20px}li{margin:2px 0;overflow-wrap:anywhere}code{font-size:.9em}table{border-collapse:collapse;width:100%}
td,th{border-bottom:1px solid var(--line);padding:4px 6px;text-align:left;font-variant-numeric:tabular-nums}
nav{display:flex;flex-wrap:wrap;gap:12px;margin:8px 0 16px}footer{margin-top:40px;font-size:.85rem}`;

function page(title: string, body: string, cfg: SiteConfig, canonical: string, description: string, extraHead = ''): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${esc(canonical)}">
<link rel="alternate" type="application/rss+xml" title="Lowdown daily record (RSS)" href="${esc(cfg.baseUrl)}feed.xml">
<link rel="alternate" type="application/feed+json" title="Lowdown daily record (JSON Feed)" href="${esc(cfg.baseUrl)}feed.json">
<link rel="license" href="${LICENSE_URL}">${extraHead}
<style>${CSS}</style>
</head>
<body><main>
<nav><a href="${esc(cfg.baseUrl)}">Latest</a><a href="${esc(cfg.baseUrl)}days/">Archive</a><a href="${esc(cfg.baseUrl)}about.html">About this record</a><a href="${esc(cfg.baseUrl)}feed.xml">RSS</a><a href="${esc(cfg.baseUrl)}feed.json">JSON Feed</a></nav>
${body}
<footer class="muted">Data: CC BY 4.0, Lowdown (<a href="https://github.com/PetShopBros/lowdown-data">lowdown-data</a>). Facts as recorded; no scores or rankings. See <a href="${esc(cfg.baseUrl)}about.html">About this record</a>.</footer>
</main></body>
</html>
`;
}

function lookupLink(name: string, cfg: SiteConfig): string {
  return `${cfg.apiBase}/api/reputation/mcp:${name}?ref=market`;
}

function nameItem(it: RegistryItem, kind: RegistryKind, cfg: SiteConfig): string {
  const link = `<a href="${esc(lookupLink(it.name, cfg))}" rel="nofollow"><code>${esc(it.name)}</code></a>`;
  if (kind === 'version' || kind === 'status') return `<li>${link} <span class="muted">${esc(it.old ?? '(other)')} → ${esc(it.new ?? '(other)')}</span></li>`;
  return `<li>${link}</li>`;
}

/** 신규·삭제·복귀·원격 변경은 호스트로 묶는다(같은 호스트 ≠ 같은 서비스). 호스트가 없으면 "(no remote host)". */
function groupedByHost(items: readonly RegistryItem[], kind: RegistryKind, cfg: SiteConfig): string {
  const groups = new Map<string, RegistryItem[]>();
  for (const it of items) {
    const hs = it.hosts && it.hosts.length > 0 ? it.hosts : ['(no remote host)'];
    const k = hs.join(', ');
    const g = groups.get(k);
    if (g) g.push(it);
    else groups.set(k, [it]);
  }
  const keys = [...groups.keys()].sort();
  return keys
    .map((k) => {
      const g = groups.get(k)!;
      return `<h3>${esc(k)} <span class="muted">(${n(g.length)})</span></h3>\n<ul>${g.map((it) => nameItem(it, kind, cfg)).join('')}</ul>`;
    })
    .join('\n');
}

function numBox(label: string, value: string): string {
  return `<div class="num"><span class="muted">${esc(label)}</span><b>${esc(value)}</b></div>`;
}

function delta(cur: number, prev: number | undefined): string {
  if (prev === undefined) return n(cur);
  const d = cur - prev;
  return `${n(cur)} (${d >= 0 ? '+' : ''}${n(d)})`;
}

export function renderDayHtml(d: MarketDay, cfg: SiteConfig, opts: { canonical: string; prev?: string; next?: string }): string {
  const r = d.registry;
  const o = d.observations.current;
  const p = d.observations.previous ?? undefined;
  const parts: string[] = [];
  parts.push(`<h1>MCP daily record — ${esc(d.day)}</h1>`);
  parts.push(`<p class="muted">Data as of ${esc(d.data_as_of.slice(0, 16).replace('T', ' '))} UTC. Machine-readable: <a href="${esc(cfg.baseUrl)}days/${esc(d.day)}.json">${esc(d.day)}.json</a>.${opts.prev ? ` Previous: <a href="${esc(cfg.baseUrl)}days/${esc(opts.prev)}.html">${esc(opts.prev)}</a>.` : ''}${opts.next ? ` Next: <a href="${esc(cfg.baseUrl)}days/${esc(opts.next)}.html">${esc(opts.next)}</a>.` : ''}</p>`);

  parts.push(`<h2>1. Registry declarations</h2>`);
  parts.push(`<p class="muted">Changes in what the official MCP Registry declares, compared with the previous day's list.</p>`);
  parts.push(`<div class="nums">${REGISTRY_KINDS.map((k) => numBox(KIND_TITLE[k], n(r.counts[k]))).join('')}</div>`);
  if (r.unlisted > 0) parts.push(`<p class="muted">${n(r.unlisted)} events are counted but not listed (name outside the allowed format).</p>`);
  for (const k of REGISTRY_KINDS) {
    if (r.items[k].length === 0) continue;
    parts.push(`<h3>${esc(KIND_TITLE[k])} (${n(r.items[k].length)})</h3>`);
    if (k === 'new' || k === 'removed' || k === 'restored' || k === 'remotes') parts.push(groupedByHost(r.items[k], k, cfg));
    else parts.push(`<ul>${r.items[k].map((it) => nameItem(it, k, cfg)).join('')}</ul>`);
  }

  parts.push(`<h2>2. Lowdown observations (fixed sample)</h2>`);
  parts.push(`<p class="muted">Counts only. Sample ${esc(o.cohort_version)}; change vs previous run in parentheses.</p>`);
  parts.push(
    `<div class="nums">${[
      numBox('Sample size', n(o.cohort_size)),
      numBox('Servers observed', delta(o.targets_observed, p?.targets_observed)),
      numBox('Probe attempts', delta(o.probe_attempts, p?.probe_attempts)),
      numBox('Reached tools/list', delta(o.reached_level['2'], p?.reached_level['2'])),
      numBox('Initialize only', delta(o.reached_level['1'], p?.reached_level['1'])),
      numBox('Not reached', delta(o.reached_level['0'], p?.reached_level['0'])),
    ].join('')}</div>`,
  );

  parts.push(`<h2>3. Tool definitions (server level)</h2>`);
  if (d.tool_definitions) {
    const t = d.tool_definitions;
    parts.push(`<p class="muted">Counts only, compared with the run of ${esc(t.previous_data_as_of.slice(0, 10))}. Descriptions are not published.</p>`);
    parts.push(
      `<div class="nums">${[
        numBox('Compared servers', n(t.compared)),
        numBox('Description changed', n(t.description_changed)),
        numBox('Schema changed', n(t.schema_changed)),
        numBox('Namespaces with changes', n(t.namespaces_with_changes)),
      ].join('')}</div>`,
    );
  } else {
    parts.push(`<p class="muted">No previous run to compare.</p>`);
  }

  parts.push(`<h2>4. First observed by Lowdown</h2>`);
  if (d.first_observed.length === 0) parts.push(`<p class="muted">None today.</p>`);
  else {
    parts.push(`<table><thead><tr><th>Kind</th><th>Value</th></tr></thead><tbody>${d.first_observed.map((f) => `<tr><td>${esc(f.kind)}</td><td><code>${esc(f.value)}</code></td></tr>`).join('')}</tbody></table>`);
  }
  // 대량으로 가져가는 쪽이 API 링크를 하나씩 따라가지 않고 하루 JSON 을 고르도록 기계용 대체 경로를 head 에 둔다.
  const jsonHead = `\n<link rel="alternate" type="application/json" title="Lowdown daily record ${esc(d.day)} (JSON, CC BY 4.0)" href="${esc(cfg.baseUrl)}days/${esc(d.day)}.json">`;
  return page(`MCP daily record ${d.day} — Lowdown`, parts.join('\n'), cfg, opts.canonical, daySummaryText(d), jsonHead);
}

export function renderArchiveHtml(days: readonly MarketDay[], cfg: SiteConfig): string {
  const sorted = [...days].sort((a, b) => (a.day < b.day ? 1 : -1));
  const rows = sorted
    .map((d) => `<tr><td><a href="${esc(cfg.baseUrl)}days/${esc(d.day)}.html">${esc(d.day)}</a></td><td>${n(d.registry.counts.new)}</td><td>${n(d.registry.counts.removed)}</td><td>${n(d.registry.counts.version)}</td><td>${n(d.observations.current.reached_level['2'])}</td><td><a href="${esc(cfg.baseUrl)}days/${esc(d.day)}.json">json</a></td></tr>`)
    .join('');
  const body = `<h1>Archive</h1><p class="muted">One record per UTC day. Past days are not rewritten.</p>
<table><thead><tr><th>Day</th><th>New</th><th>Removed</th><th>Version changes</th><th>Reached tools/list</th><th>Data</th></tr></thead><tbody>${rows}</tbody></table>`;
  return page('Archive — Lowdown MCP daily record', body, cfg, `${cfg.baseUrl}days/`, 'Daily records of MCP Registry changes and Lowdown observations.');
}

export function renderAboutHtml(cfg: SiteConfig): string {
  const body = `<h1>About this record</h1>
<p>Lowdown publishes one record per UTC day. Each record keeps different kinds of facts apart. Nothing here is a score, a ranking, or a verdict about any server.</p>
<h2>1. Registry declarations</h2>
<p>What the official MCP Registry declares (latest version of each name), compared with the previous day's list. These are the Registry's own declarations, recorded by Lowdown since 2026-10-19. Names are grouped by remote host; servers on the same host are not necessarily the same service. Description, package and remote changes are shown as "changed" only; their contents are not published here.</p>
<h2>2. Lowdown observations</h2>
<p>A fixed sample of Registry servers is probed once a day from one network location (GitHub Actions) with <code>initialize</code> and <code>tools/list</code>. Lowdown never calls tools. Only counts are published here. A server that was not reached was not reachable from that location at that time; this is not evidence that it is down, broken, or malicious.</p>
<h2>3. Tool definitions</h2>
<p>For servers reached on two consecutive runs, Lowdown compares hashes of the tool definitions (names, descriptions, schemas). A change means the definition differs from the previous run. It is not evidence of malicious intent, and an unchanged definition is not evidence of safety. Descriptions are not published.</p>
<h2>4. First observed by Lowdown</h2>
<p>A value (capability key, protocol version, or tool name) that Lowdown had not seen before within its own sample. It does not mean the value is new to the market. Tool names are listed only when seen on at least two hosts and two Registry namespaces.</p>
<h2>Data and feeds</h2>
<ul>
<li>Daily JSON for each record: <code>days/YYYY-MM-DD.json</code> (the HTML pages and feeds are generated from these files).</li>
<li><a href="${esc(cfg.baseUrl)}feed.xml">RSS</a> and <a href="${esc(cfg.baseUrl)}feed.json">JSON Feed</a>: one item per day, last ${FEED_DAYS} days.</li>
<li>Raw observations: <a href="https://github.com/PetShopBros/lowdown-data">lowdown-data</a> and <a href="https://huggingface.co/datasets/art2meta/lowdown-mcp-observations">Hugging Face</a>.</li>
<li>Per-server lookup: <code>${esc(cfg.apiBase)}/api/reputation/mcp:&lt;registry name&gt;</code></li>
</ul>
<p>License: CC BY 4.0.</p>`;
  return page('About this record — Lowdown', body, cfg, `${cfg.baseUrl}about.html`, 'How the Lowdown MCP daily record is produced and what each section means.');
}

const rfc822 = (iso: string) => new Date(iso).toUTCString();

export function renderRss(days: readonly MarketDay[], cfg: SiteConfig): string {
  const items = [...days]
    .sort((a, b) => (a.day < b.day ? 1 : -1))
    .slice(0, FEED_DAYS)
    .map((d) => {
      const url = `${cfg.baseUrl}days/${d.day}.html`;
      return `<item><title>${esc(`MCP daily record ${d.day}`)}</title><link>${esc(url)}</link><guid isPermaLink="true">${esc(url)}</guid><pubDate>${rfc822(d.data_as_of)}</pubDate><description>${esc(daySummaryText(d))}</description></item>`;
    });
  const last = [...days].sort((a, b) => (a.day < b.day ? 1 : -1))[0];
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>Lowdown MCP daily record</title><link>${esc(cfg.baseUrl)}</link><description>Daily facts about MCP Registry declarations and Lowdown observations. No scores or rankings.</description><language>en</language>${last ? `<lastBuildDate>${rfc822(last.data_as_of)}</lastBuildDate>` : ''}
${items.join('\n')}
</channel></rss>
`;
}

export function renderJsonFeed(days: readonly MarketDay[], cfg: SiteConfig): string {
  const items = [...days]
    .sort((a, b) => (a.day < b.day ? 1 : -1))
    .slice(0, FEED_DAYS)
    .map((d) => ({
      id: `${cfg.baseUrl}days/${d.day}.html`,
      url: `${cfg.baseUrl}days/${d.day}.html`,
      title: `MCP daily record ${d.day}`,
      content_text: daySummaryText(d),
      date_published: d.data_as_of,
      _lowdown: { day: d.day, data: `${cfg.baseUrl}days/${d.day}.json` },
    }));
  const feed = {
    version: 'https://jsonfeed.org/version/1.1',
    title: 'Lowdown MCP daily record',
    home_page_url: cfg.baseUrl,
    feed_url: `${cfg.baseUrl}feed.json`,
    description: 'Daily facts about MCP Registry declarations and Lowdown observations. No scores or rankings.',
    language: 'en',
    _lowdown: { dataset: DATASET_URL, license: 'CC BY 4.0', license_url: LICENSE_URL, attribution: 'Lowdown (https://github.com/PetShopBros/lowdown-data), CC BY 4.0' },
    items,
  };
  return `${JSON.stringify(feed, null, 2)}\n`;
}

export function renderSitemap(days: readonly MarketDay[], cfg: SiteConfig): string {
  const urls = [cfg.baseUrl, `${cfg.baseUrl}about.html`, `${cfg.baseUrl}days/`, ...[...days].map((d) => d.day).sort().map((day) => `${cfg.baseUrl}days/${day}.html`)];
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((u) => `<url><loc>${esc(u)}</loc></url>`).join('\n')}
</urlset>
`;
}

/** 디스크의 하루 JSON 들 → 사이트 파일 전체 (경로 → 내용). 같은 입력이면 같은 출력. */
export function renderSite(days: readonly MarketDay[], cfg: SiteConfig): Map<string, string> {
  const files = new Map<string, string>();
  const sorted = [...days].sort((a, b) => (a.day < b.day ? -1 : 1));
  sorted.forEach((d, i) => {
    files.set(`days/${d.day}.html`, renderDayHtml(d, cfg, { canonical: `${cfg.baseUrl}days/${d.day}.html`, prev: sorted[i - 1]?.day, next: sorted[i + 1]?.day }));
  });
  const latest = sorted.at(-1);
  if (latest) files.set('index.html', renderDayHtml(latest, cfg, { canonical: `${cfg.baseUrl}days/${latest.day}.html`, prev: sorted.at(-2)?.day }));
  files.set('days/index.html', renderArchiveHtml(sorted, cfg));
  files.set('about.html', renderAboutHtml(cfg));
  files.set('feed.xml', renderRss(sorted, cfg));
  files.set('feed.json', renderJsonFeed(sorted, cfg));
  files.set('sitemap.xml', renderSitemap(sorted, cfg));
  files.set('robots.txt', `User-agent: *\nAllow: /\nSitemap: ${cfg.baseUrl}sitemap.xml\n`);
  files.set('.nojekyll', '');
  return files;
}
