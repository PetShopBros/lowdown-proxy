// Lowdown 서버별 관측 페이지(B유형: 선언 패키지 상태) — 순수 함수
//   대상: 공식 MCP Registry 항목 중, 선언한 npm·PyPI 패키지가 원본에서 아래 상태인 것.
//     npm : HTTP 404(다음 확인에서도 404) · latest 버전 deprecated
//     PyPI: HTTP 404(다음 확인에서도 404) · latest 릴리스 yanked · project-status 가 active 가 아님
//   Lowdown 만 가진 사실은 두 출처의 연결이다: "Registry 항목 X 가 선언한 패키지 Y 가 원본에서 이 상태".
//   원칙
//     1) 사실만. 원본의 용어(deprecated, yanked, archived, HTTP 404)만 쓰고 위험·방치 같은 해석을 하지 않는다.
//     2) 기준선(첫 확인 때 이미 그 상태)에는 "바뀌었다"고 쓰지 않는다.
//     3) 페이지에는 매일 바뀌는 값(마지막 확인 시각)을 넣지 않는다 → 사실이 바뀔 때만 파일이 바뀐다.
//        매일 바뀌는 값은 servers.json(목록) 하나에만.
//     4) 같은 입력이면 같은 바이트(생성 시각 없음). 페이지는 지우지 않는다(조건에서 빠져도 기록을 남긴다).
//     5) 외부 문자열(Registry 이름·패키지 이름·버전)은 형식 검사 후 HTML 이스케이프. 설명·README·문구는 쓰지 않는다.

import { DATASET_URL, LICENSE_URL } from './market-lib.ts';
import type { NpmChangeRow, NpmStateRow } from './npm-lib.ts';
import { isNpmName } from './npm-lib.ts';
import type { PypiChangeRow, PypiStateRow } from './pypi-lib.ts';
import { isPypiName, normalizePypiName } from './pypi-lib.ts';

export const SERVER_SCHEMA = 'lowdown-server-page/1';
export const INDEX_SCHEMA = 'lowdown-server-index/1';

export type FactCode = 'declared_package_not_found' | 'declared_package_deprecated' | 'declared_package_yanked' | 'declared_package_project_status';
export const FACT_CODES: readonly FactCode[] = ['declared_package_not_found', 'declared_package_deprecated', 'declared_package_yanked', 'declared_package_project_status'];

export interface SiteConfig {
  /** 끝에 / 포함. 예: https://petshopbros.github.io/lowdown-pages/ */
  baseUrl: string;
  /** 예: https://lowdown-proxy.vercel.app */
  apiBase: string;
  /** 시장판(일일 기록) 주소. 끝에 / 포함 */
  marketUrl: string;
}

// ─────────────────────────────────────────────
// 입력
// ─────────────────────────────────────────────

export interface RegistryEntryRow {
  name: string;
  version: string | null;
  status: string | null;
  packages_key: string | null;
  first_seen_at: string;
  baseline: boolean;
  removed_at: string | null;
}

export interface RegistryChangeRow {
  id?: number;
  detected_on: string;
  name: string;
  kind: string;
  old_value: string | null;
  new_value: string | null;
}

export interface DeclaredPackage {
  registry_type: 'npm' | 'pypi';
  identifier: string;
  declared_version: string | null;
  transport: string | null;
}

const SAFE_TOKEN = /^[0-9A-Za-z.+_!~-]{1,64}$/;
const tok = (s: string | undefined): string | null => (s && SAFE_TOKEN.test(s) ? s : null);

/** packages_key("registryType identifier version transport" 줄, 정렬·줄바꿈) → npm·PyPI 선언만. 형식이 아닌 이름은 버린다. */
export function parseDeclared(packagesKey: string | null): DeclaredPackage[] {
  const out: DeclaredPackage[] = [];
  const seen = new Set<string>();
  for (const line of (packagesKey ?? '').split('\n')) {
    // 형식: 정확히 네 칸("registryType identifier version transport", 빈 칸 허용 — scanner/lib.ts 가 빈 값도 ' ' 로 잇는다). 아니면 버린다.
    // trim 하지 않는다: transport 가 비면 줄 끝이 공백이라 trim 하면 칸 수가 줄어든다.
    const fields = line.replace(/\r$/, '').split(' ');
    if (fields.length !== 4) continue;
    const [type, ident, version, transport] = fields;
    if (type === 'npm') {
      if (!ident || !isNpmName(ident)) continue;
    } else if (type === 'pypi') {
      if (!ident || !isPypiName(ident)) continue;
    } else continue;
    const key = `${type} ${type === 'pypi' ? normalizePypiName(ident) : ident}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ registry_type: type, identifier: ident, declared_version: tok(version), transport: tok(transport) });
  }
  return out;
}

// ─────────────────────────────────────────────
// 주소
// ─────────────────────────────────────────────

const SEGMENT = /^[a-z0-9][a-z0-9._-]{0,199}$/;

/** Registry 이름 → servers/<namespace>/<name> (소문자). 형식이 아니면 null(페이지를 만들지 않는다). */
export function serverPath(name: string): string | null {
  const lower = name.toLowerCase();
  const parts = lower.split('/');
  if (parts.length !== 2) return null;
  const [ns, rest] = parts as [string, string];
  if (!SEGMENT.test(ns) || !SEGMENT.test(rest) || ns.includes('..') || rest.includes('..')) return null;
  return `servers/${ns}/${rest}`;
}

// ─────────────────────────────────────────────
// 사실 계산
// ─────────────────────────────────────────────

/** 언제부터인가의 근거: change = 그 상태로 바뀐 이벤트 날짜 / first_check = 첫 확인 때 이미 그 상태 / recorded_by = 이 날짜에는 이미 그 상태로 기록됨 */
export type SinceBasis = 'change' | 'first_check' | 'recorded_by';

export interface Since {
  on: string;
  basis: SinceBasis;
}

export interface Fact {
  code: FactCode;
  registry_type: 'npm' | 'pypi';
  identifier: string;
  /** deprecated·yanked 인 버전 */
  version?: string | null;
  /** PyPI project-status */
  project_status?: string;
  /** PyPI 404 의 종류: no_project = 그 이름의 프로젝트 없음, no_releases = 프로젝트는 있으나 릴리스 없음, null = 구분 근거 없음 */
  not_found_kind?: 'no_project' | 'no_releases' | null;
  since: Since;
}

export interface PackageEvent {
  detected_on: string;
  kind: string;
  old_value: string | null;
  new_value: string | null;
}

export interface NpmStateView {
  status: 'found' | 'not_found';
  latest: string | null;
  deprecated: boolean | null;
  /** 404 가 다음 확인에서도 이어졌는가 */
  not_found_confirmed: boolean;
}

export interface PypiStateView {
  status: 'found' | 'not_found';
  latest: string | null;
  latest_yanked: boolean | null;
  project_status: string | null;
  not_found_kind: 'no_project' | 'no_releases' | null;
  not_found_confirmed: boolean;
}

export interface PackageRecord extends DeclaredPackage {
  state: NpmStateView | PypiStateView | null;
  first_checked_on: string | null;
  events: PackageEvent[];
}

const day = (iso: string) => iso.slice(0, 10);

/** 상태에 들어간 뒤 성공 응답(200/404)을 한 번 더 받았는가. 기준선이면 첫 확인 뒤 한 번 더. */
export function confirmedSinceEntered(s: { checked_at: string; changed_at: string | null; first_checked_at: string }): boolean {
  const entered = s.changed_at ?? s.first_checked_at;
  return Date.parse(s.checked_at) > Date.parse(entered);
}

function sinceFor(events: readonly PackageEvent[], match: (e: PackageEvent) => boolean, s: { changed_at: string | null; first_checked_at: string }): Since {
  const ev = [...events].filter(match).sort((a, b) => (a.detected_on < b.detected_on ? 1 : a.detected_on > b.detected_on ? -1 : 0))[0];
  if (ev) return { on: ev.detected_on, basis: 'change' };
  if (s.changed_at === null) return { on: day(s.first_checked_at), basis: 'first_check' };
  return { on: day(s.changed_at), basis: 'recorded_by' };
}

const asEvents = (rows: ReadonlyArray<NpmChangeRow | PypiChangeRow>): PackageEvent[] =>
  rows
    .map((r) => ({ detected_on: r.detected_on, kind: r.kind, old_value: tok(r.old_value ?? undefined), new_value: tok(r.new_value ?? undefined) }))
    .sort((a, b) => (a.detected_on < b.detected_on ? -1 : a.detected_on > b.detected_on ? 1 : a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0));

export function npmFacts(identifier: string, s: NpmStateRow, events: readonly PackageEvent[]): Fact[] {
  const facts: Fact[] = [];
  if (s.status === 'not_found' && confirmedSinceEntered(s)) {
    facts.push({ code: 'declared_package_not_found', registry_type: 'npm', identifier, since: sinceFor(events, (e) => e.kind === 'not_found', s) });
  }
  if (s.status === 'found' && s.deprecated === true) {
    facts.push({ code: 'declared_package_deprecated', registry_type: 'npm', identifier, version: tok(s.latest ?? undefined), since: sinceFor(events, (e) => e.kind === 'deprecated', s) });
  }
  return facts;
}

const NON_ACTIVE = new Set(['archived', 'quarantined', 'deprecated']);

export function pypiNotFoundKind(s: Pick<PypiStateRow, 'index_status'>): 'no_project' | 'no_releases' | null {
  return s.index_status === 'not_found' ? 'no_project' : s.index_status === 'found' ? 'no_releases' : null;
}

export function pypiFacts(identifier: string, s: PypiStateRow, events: readonly PackageEvent[]): Fact[] {
  const facts: Fact[] = [];
  if (s.status === 'not_found' && confirmedSinceEntered(s)) {
    facts.push({ code: 'declared_package_not_found', registry_type: 'pypi', identifier, not_found_kind: pypiNotFoundKind(s), since: sinceFor(events, (e) => e.kind === 'not_found', s) });
  }
  if (s.status === 'found' && s.latest_yanked === true) {
    facts.push({ code: 'declared_package_yanked', registry_type: 'pypi', identifier, version: tok(s.latest ?? undefined), since: sinceFor(events, (e) => e.kind === 'yanked', s) });
  }
  if (s.project_status && NON_ACTIVE.has(s.project_status)) {
    const ps = s.project_status;
    facts.push({ code: 'declared_package_project_status', registry_type: 'pypi', identifier, project_status: ps, since: sinceFor(events, (e) => e.kind === 'status_changed' && e.new_value === ps, s) });
  }
  return facts;
}

// ─────────────────────────────────────────────
// 서버 기록
// ─────────────────────────────────────────────

export interface ServerRecord {
  schema: typeof SERVER_SCHEMA;
  name: string;
  page_url: string;
  json_url: string;
  api_url: string;
  facts: Fact[];
  registry: {
    status: string | null;
    version: string | null;
    first_seen_on: string;
    baseline: boolean;
    removed_on: string | null;
    changes: PackageEvent[];
  };
  packages: PackageRecord[];
  limits: string[];
  source: { name: 'Lowdown'; dataset: string; license: 'CC BY 4.0'; license_url: string; attribution: string };
}

export const LIMITS = [
  'Package code was not installed or run.',
  'Deprecation messages, yank reasons, descriptions and READMEs are not stored.',
  'Deprecated, yanked and project status are flags set on npm or PyPI by the package owner or index. They are not a judgment by Lowdown.',
  'HTTP 404 facts are listed only after a later check also returned 404.',
  '"First recorded" is the date Lowdown first saw a state, not the date the state began.',
];

export interface BuildInput {
  entry: RegistryEntryRow;
  npmState: ReadonlyMap<string, NpmStateRow>;
  pypiState: ReadonlyMap<string, PypiStateRow>;
  npmEvents: ReadonlyMap<string, readonly NpmChangeRow[]>;
  pypiEvents: ReadonlyMap<string, readonly PypiChangeRow[]>;
  registryChanges: readonly RegistryChangeRow[];
  path: string;
  cfg: SiteConfig;
}

export function buildServerRecord(i: BuildInput): ServerRecord {
  const packages: PackageRecord[] = [];
  const facts: Fact[] = [];
  for (const d of parseDeclared(i.entry.packages_key)) {
    if (d.registry_type === 'npm') {
      const s = i.npmState.get(d.identifier);
      const events = asEvents(i.npmEvents.get(d.identifier) ?? []);
      if (s) facts.push(...npmFacts(d.identifier, s, events));
      packages.push({
        ...d,
        state: s ? { status: s.status, latest: tok(s.latest ?? undefined), deprecated: s.deprecated, not_found_confirmed: s.status === 'not_found' && confirmedSinceEntered(s) } : null,
        first_checked_on: s ? day(s.first_checked_at) : null,
        events,
      });
    } else {
      const key = normalizePypiName(d.identifier);
      const s = i.pypiState.get(key);
      const events = asEvents(i.pypiEvents.get(key) ?? []);
      if (s) facts.push(...pypiFacts(d.identifier, s, events));
      packages.push({
        ...d,
        state: s
          ? {
              status: s.status,
              latest: tok(s.latest ?? undefined),
              latest_yanked: s.latest_yanked,
              project_status: s.project_status,
              not_found_kind: s.status === 'not_found' ? pypiNotFoundKind(s) : null,
              not_found_confirmed: s.status === 'not_found' && confirmedSinceEntered(s),
            }
          : null,
        first_checked_on: s ? day(s.first_checked_at) : null,
        events,
      });
    }
  }
  const changes = i.registryChanges
    .filter((c) => c.name === i.entry.name)
    .map((c) => ({
      detected_on: c.detected_on,
      kind: c.kind,
      // 값은 버전·상태만(짧고 형식이 정해진 값). 원격·패키지·설명 변경은 종류만 싣는다.
      old_value: c.kind === 'version' || c.kind === 'status' ? tok(c.old_value ?? undefined) : null,
      new_value: c.kind === 'version' || c.kind === 'status' ? tok(c.new_value ?? undefined) : null,
    }))
    .sort((a, b) => (a.detected_on < b.detected_on ? -1 : a.detected_on > b.detected_on ? 1 : a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0));
  facts.sort((a, b) => FACT_CODES.indexOf(a.code) - FACT_CODES.indexOf(b.code) || (a.identifier < b.identifier ? -1 : a.identifier > b.identifier ? 1 : 0));
  return {
    schema: SERVER_SCHEMA,
    name: i.entry.name,
    page_url: `${i.cfg.baseUrl}${i.path}.html`,
    json_url: `${i.cfg.baseUrl}${i.path}.json`,
    api_url: `${i.cfg.apiBase}/api/reputation/mcp:${i.entry.name}`,
    facts,
    registry: {
      status: tok(i.entry.status ?? undefined),
      version: tok(i.entry.version ?? undefined),
      first_seen_on: day(i.entry.first_seen_at),
      baseline: i.entry.baseline,
      removed_on: i.entry.removed_at ? day(i.entry.removed_at) : null,
      changes,
    },
    packages,
    limits: LIMITS,
    source: { name: 'Lowdown', dataset: DATASET_URL, license: 'CC BY 4.0', license_url: LICENSE_URL, attribution: 'Lowdown (https://github.com/PetShopBros/lowdown-data), CC BY 4.0' },
  };
}

/** 새 페이지를 만드는 조건: 지금 Registry 목록에 있고, 사실이 하나 이상 */
export function qualifies(r: ServerRecord): boolean {
  return r.registry.removed_on === null && r.facts.length > 0;
}

/** 이 페이지의 사실이 마지막으로 바뀐 날(sitemap lastmod). 확인 시각은 쓰지 않는다. */
export function lastFactOn(r: ServerRecord): string {
  const dates = [r.registry.first_seen_on, ...r.registry.changes.map((c) => c.detected_on), ...r.facts.map((f) => f.since.on)];
  if (r.registry.removed_on) dates.push(r.registry.removed_on);
  for (const p of r.packages) {
    if (p.first_checked_on) dates.push(p.first_checked_on);
    for (const e of p.events) dates.push(e.detected_on);
  }
  return dates.sort().at(-1)!;
}

export function serializeRecord(r: ServerRecord): string {
  return `${JSON.stringify(r, null, 2)}\n`;
}

// ─────────────────────────────────────────────
// 문장
// ─────────────────────────────────────────────

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

export function factSentence(f: Fact): string {
  const id = f.identifier;
  switch (f.code) {
    case 'declared_package_not_found':
      if (f.registry_type === 'npm') return `the npm registry returns HTTP 404 for the package ${id}`;
      if (f.not_found_kind === 'no_project') return `PyPI has no project named ${id}`;
      if (f.not_found_kind === 'no_releases') return `PyPI lists the project ${id} but it has no releases`;
      return `the PyPI JSON API returns HTTP 404 for ${id}`;
    case 'declared_package_deprecated':
      return `npm marks the latest version of ${id}${f.version ? ` (${f.version})` : ''} as deprecated`;
    case 'declared_package_yanked':
      return `the latest PyPI release of ${id}${f.version ? ` (${f.version})` : ''} is yanked`;
    case 'declared_package_project_status':
      return `PyPI marks the project ${id} as ${f.project_status}`;
  }
}

export function sinceSentence(s: Since): string {
  if (s.basis === 'change') return `Lowdown recorded this change on ${s.on}.`;
  if (s.basis === 'first_check') return `This was already the case when Lowdown first checked the package on ${s.on}.`;
  return `Lowdown had recorded this state by ${s.on}.`;
}

export function summaryText(r: ServerRecord): string {
  const n = r.packages.length;
  const head = `The MCP Registry entry ${r.name} declares ${n === 1 ? 'one package' : `${n} packages`}.`;
  if (r.facts.length === 0) {
    const gone = r.registry.removed_on ? ` The entry has not been in the Registry's latest list since ${r.registry.removed_on}.` : '';
    return `${head} Lowdown currently records no package status flags for these packages; earlier records are listed below.${gone}`;
  }
  const parts = r.facts.map(factSentence);
  const body = parts.length === 1 ? parts[0]! : `${parts.slice(0, -1).join('; ')}; and ${parts.at(-1)!}`;
  return `${head} Lowdown recorded that ${body}.`;
}

function packageStatusText(p: PackageRecord): string {
  const s = p.state;
  if (!s) return 'Not checked yet';
  if ('deprecated' in s) {
    if (s.status === 'not_found') return s.not_found_confirmed ? 'HTTP 404 (confirmed by a later check)' : 'HTTP 404 on the last check (not yet confirmed)';
    if (s.deprecated === true) return `Latest version ${s.latest ?? '(unknown)'} marked deprecated`;
    return `Found, latest ${s.latest ?? '(unknown)'}`;
  }
  const extra = s.project_status && NON_ACTIVE.has(s.project_status) ? `; project status ${s.project_status}` : '';
  if (s.status === 'not_found') {
    const kind = s.not_found_kind === 'no_project' ? 'No project with this name' : s.not_found_kind === 'no_releases' ? 'Project exists but has no releases' : 'HTTP 404 from the JSON API';
    return `${kind}${s.not_found_confirmed ? ' (confirmed by a later check)' : ' (not yet confirmed)'}${extra}`;
  }
  if (s.latest_yanked === true) return `Latest release ${s.latest ?? '(unknown)'} yanked${extra}`;
  return `Found, latest ${s.latest ?? '(unknown)'}${extra}`;
}

export function packageEventText(registryType: 'npm' | 'pypi', e: PackageEvent): string {
  const o = e.old_value ?? '(unknown)';
  const v = e.new_value ?? '(unknown)';
  switch (e.kind) {
    case 'latest_changed':
      return `Latest version changed: ${o} → ${v}`;
    case 'deprecated':
      return `Latest version ${o} marked deprecated`;
    case 'undeprecated':
      return `Latest version ${o} no longer marked deprecated`;
    case 'not_found':
      return `${registryType === 'npm' ? 'npm registry' : 'PyPI JSON API'} returned HTTP 404 (previous latest ${o})`;
    case 'restored':
      return `Found again (latest ${v})`;
    case 'yanked':
      return `Latest release ${o} yanked`;
    case 'unyanked':
      return `Latest release ${o} no longer yanked`;
    case 'status_changed':
      return `Project status changed: ${o} → ${v}`;
    default:
      return e.kind;
  }
}

const REGISTRY_KIND_TEXT: Record<string, string> = {
  new: 'First seen in the Registry list',
  removed: "Removed from the Registry's latest list",
  restored: "Back in the Registry's latest list",
  version: 'Declared version changed',
  status: 'Registry status changed',
  remotes: 'Remote declaration changed',
  packages: 'Package declaration changed',
  description: 'Description changed',
};

export function registryChangeText(c: PackageEvent): string {
  const base = REGISTRY_KIND_TEXT[c.kind] ?? c.kind;
  if ((c.kind === 'version' || c.kind === 'status') && (c.old_value || c.new_value)) return `${base}: ${c.old_value ?? '(none)'} → ${c.new_value ?? '(none)'}`;
  return base;
}

const npmPage = (id: string) => `https://www.npmjs.com/package/${id}`;
const pypiPage = (id: string) => `https://pypi.org/project/${normalizePypiName(id)}/`;

// ─────────────────────────────────────────────
// HTML
// ─────────────────────────────────────────────

const CSS = `:root{--bg:#fff;--fg:#1a1a1a;--muted:#5c5c5c;--line:#e3e3e3;--accent:#0b5cad;--chip:#f3f4f6}
@media (prefers-color-scheme:dark){:root{--bg:#111315;--fg:#e8e8e8;--muted:#a3a3a3;--line:#2c2f33;--accent:#6aa9ec;--chip:#1c1f23}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:860px;margin:0 auto;padding:24px 16px 64px}a{color:var(--accent)}h1{font-size:1.4rem;margin:0 0 8px;overflow-wrap:anywhere}
h2{font-size:1.1rem;margin:32px 0 8px;padding-top:16px;border-top:1px solid var(--line)}
.muted{color:var(--muted)}.lead{font-size:1.02rem}ul{padding-left:20px}li{margin:2px 0;overflow-wrap:anywhere}code{font-size:.9em}
.table{overflow-x:auto}table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid var(--line);padding:4px 6px;text-align:left;vertical-align:top;overflow-wrap:anywhere}
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
<link rel="license" href="${LICENSE_URL}">${extraHead}
<style>${CSS}</style>
</head>
<body><main>
<nav><a href="${esc(cfg.baseUrl)}">All server records</a><a href="${esc(cfg.marketUrl)}">Daily record</a><a href="${esc(cfg.marketUrl)}about.html">About Lowdown records</a></nav>
${body}
<footer class="muted">Data: CC BY 4.0, Lowdown (<a href="${DATASET_URL}">lowdown-data</a>). Facts as recorded; no scores or rankings.</footer>
</main></body>
</html>
`;
}

const clip = (s: string, max: number) => (s.length <= max ? s : `${s.slice(0, max - 1)}…`);

export function renderServerHtml(r: ServerRecord, cfg: SiteConfig): string {
  const parts: string[] = [];
  parts.push(`<h1><code>${esc(r.name)}</code></h1>`);
  parts.push(`<p class="muted">MCP Registry entry and declared package status, as recorded by Lowdown.</p>`);
  parts.push(`<p class="lead">${esc(summaryText(r))}</p>`);

  if (r.facts.length > 0) {
    parts.push('<h2>Recorded facts</h2><ul>');
    for (const f of r.facts) {
      const s = factSentence(f);
      // 문장 첫 글자만 대문자로. 'npm' 은 소문자 고유명사라 그대로 둔다.
      const cap = s.startsWith('npm ') ? s : s.charAt(0).toUpperCase() + s.slice(1);
      parts.push(`<li>${esc(cap)}. <span class="muted">${esc(sinceSentence(f.since))}</span></li>`);
    }
    parts.push('</ul>');
  }

  parts.push('<h2>Declared packages</h2><div class="table"><table><thead><tr><th>Type</th><th>Package</th><th>Declared version</th><th>Transport</th><th>Status recorded by Lowdown</th><th>First checked</th></tr></thead><tbody>');
  for (const p of r.packages) {
    const link = p.registry_type === 'npm' ? npmPage(p.identifier) : pypiPage(p.identifier);
    parts.push(
      `<tr><td>${p.registry_type === 'npm' ? 'npm' : 'PyPI'}</td><td><a href="${esc(link)}"><code>${esc(p.identifier)}</code></a></td><td>${esc(p.declared_version ?? '—')}</td><td>${esc(p.transport ?? '—')}</td><td>${esc(packageStatusText(p))}</td><td>${esc(p.first_checked_on ?? '—')}</td></tr>`,
    );
  }
  parts.push('</tbody></table></div>');

  const evRows = r.packages.flatMap((p) => p.events.map((e) => ({ p, e })));
  parts.push('<h2>Package status history</h2>');
  if (evRows.length === 0) parts.push('<p class="muted">No status changes recorded since Lowdown began checking these packages.</p>');
  else {
    parts.push('<div class="table"><table><thead><tr><th>Date (UTC)</th><th>Package</th><th>Recorded change</th></tr></thead><tbody>');
    evRows.sort((a, b) => (a.e.detected_on < b.e.detected_on ? 1 : a.e.detected_on > b.e.detected_on ? -1 : a.p.identifier < b.p.identifier ? -1 : a.p.identifier > b.p.identifier ? 1 : 0));
    for (const { p, e } of evRows) parts.push(`<tr><td>${esc(e.detected_on)}</td><td><code>${esc(p.identifier)}</code></td><td>${esc(packageEventText(p.registry_type, e))}</td></tr>`);
    parts.push('</tbody></table></div>');
  }

  parts.push('<h2>Registry entry history</h2><ul>');
  parts.push(
    `<li>${esc(r.registry.first_seen_on)}: ${
      r.registry.baseline ? 'Already listed when Lowdown began comparing the Registry list.' : 'First seen in the Registry list by Lowdown.'
    }</li>`,
  );
  for (const c of r.registry.changes) if (c.kind !== 'new') parts.push(`<li>${esc(c.detected_on)}: ${esc(registryChangeText(c))}</li>`);
  parts.push('</ul>');
  const cur = [r.registry.version ? `declared version ${r.registry.version}` : null, r.registry.status ? `Registry status ${r.registry.status}` : null].filter(Boolean).join(', ');
  if (cur) parts.push(`<p class="muted">Latest Registry record: ${esc(cur)}.${r.registry.removed_on ? ` Not in the latest list since ${esc(r.registry.removed_on)}.` : ''}</p>`);

  parts.push('<h2>Scope and limits</h2><ul>');
  parts.push('<li>Checked: npm registry package metadata (latest version, deprecated flag on the latest version) and PyPI JSON and Simple APIs (latest release, yanked flag, project status).</li>');
  for (const l of r.limits) parts.push(`<li>${esc(l)}</li>`);
  parts.push('</ul>');

  parts.push('<h2>Data</h2><ul>');
  parts.push(`<li>This record as JSON: <a href="${esc(r.json_url)}">${esc(r.json_url)}</a></li>`);
  parts.push(`<li>Lowdown lookup API: <a href="${esc(`${r.api_url}?ref=page`)}" rel="nofollow">${esc(r.api_url)}</a></li>`);
  parts.push(`<li>Raw daily observations: <a href="${DATASET_URL}">lowdown-data</a> (CC BY 4.0)</li>`);
  parts.push('</ul>');

  const head = `\n<link rel="alternate" type="application/json" title="${esc(r.name)} (JSON, CC BY 4.0)" href="${esc(r.json_url)}">`;
  return page(`${r.name} — MCP Registry entry and declared package status (Lowdown record)`, parts.join('\n'), cfg, r.page_url, clip(summaryText(r), 300), head);
}

const FACT_TITLE: Record<FactCode, string> = {
  declared_package_not_found: 'Declared package returns HTTP 404',
  declared_package_deprecated: 'Declared npm package marked deprecated',
  declared_package_yanked: 'Latest release of declared PyPI package yanked',
  declared_package_project_status: 'Declared PyPI project not active (archived, quarantined or deprecated)',
};

export function renderIndexHtml(records: readonly ServerRecord[], cfg: SiteConfig): string {
  const parts: string[] = [];
  const current = records.filter((r) => r.facts.length > 0);
  parts.push('<h1>MCP server records: declared package status</h1>');
  parts.push(
    `<p class="lead">Official MCP Registry entries whose declared npm or PyPI packages carry a status flag on npm or PyPI. ${current.length.toLocaleString('en-US')} entries currently have at least one recorded fact.</p>`,
  );
  parts.push('<p class="muted">Each record links an MCP Registry entry to the state of the packages it declares. The Registry does not show package state, and npm and PyPI do not show Registry entries; these records connect the two. Facts only: no scores, rankings or safety judgments. Records are not removed when a state changes; the change is added to the history.</p>');
  for (const code of FACT_CODES) {
    const items = current.filter((r) => r.facts.some((f) => f.code === code)).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    if (items.length === 0) continue;
    parts.push(`<h2>${esc(FACT_TITLE[code])} (${items.length.toLocaleString('en-US')})</h2><ul>`);
    for (const r of items) parts.push(`<li><a href="${esc(r.page_url)}"><code>${esc(r.name)}</code></a></li>`);
    parts.push('</ul>');
  }
  const past = records.filter((r) => r.facts.length === 0).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  if (past.length > 0) {
    parts.push(`<h2>Earlier records (${past.length.toLocaleString('en-US')})</h2><p class="muted">No current status flag; the history is kept.</p><ul>`);
    for (const r of past) parts.push(`<li><a href="${esc(r.page_url)}"><code>${esc(r.name)}</code></a></li>`);
    parts.push('</ul>');
  }
  parts.push('<h2>Data</h2><ul>');
  parts.push(`<li>List with last check dates (JSON, updated daily): <a href="${esc(cfg.baseUrl)}servers.json">${esc(cfg.baseUrl)}servers.json</a></li>`);
  parts.push(`<li>Each record has a JSON version linked from its page (schema <code>${SERVER_SCHEMA}</code>).</li>`);
  parts.push('</ul>');
  return page('MCP server records: declared package status — Lowdown', parts.join('\n'), cfg, cfg.baseUrl, 'Official MCP Registry entries whose declared npm or PyPI packages are deprecated, yanked, not active or return HTTP 404, as recorded by Lowdown.');
}

export function renderSitemap(records: readonly ServerRecord[], cfg: SiteConfig): string {
  const sorted = [...records].sort((a, b) => (a.page_url < b.page_url ? -1 : 1));
  const all = sorted.map(lastFactOn).sort();
  const lines = ['<?xml version="1.0" encoding="UTF-8"?>', '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'];
  lines.push(`<url><loc>${esc(cfg.baseUrl)}</loc>${all.length ? `<lastmod>${all.at(-1)}</lastmod>` : ''}</url>`);
  for (const r of sorted) lines.push(`<url><loc>${esc(r.page_url)}</loc><lastmod>${lastFactOn(r)}</lastmod></url>`);
  lines.push('</urlset>');
  return `${lines.join('\n')}\n`;
}

/** 매일 바뀌는 값은 여기에만: 각 서버의 마지막 확인 날짜, 전체 data_as_of */
export function renderIndexJson(records: readonly ServerRecord[], lastChecked: ReadonlyMap<string, string>, dataAsOf: string | null): string {
  const servers = [...records]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((r) => ({ name: r.name, page: r.page_url, json: r.json_url, facts: [...new Set(r.facts.map((f) => f.code))], last_checked_on: lastChecked.get(r.name) ?? null }));
  return `${JSON.stringify({ schema: INDEX_SCHEMA, data_as_of: dataAsOf, count: servers.length, with_facts: servers.filter((s) => s.facts.length > 0).length, license: 'CC BY 4.0', license_url: LICENSE_URL, servers }, null, 2)}\n`;
}

// ─────────────────────────────────────────────
// 전체 계획
// ─────────────────────────────────────────────

export interface PlanInput {
  entries: readonly RegistryEntryRow[];
  npmState: readonly NpmStateRow[];
  pypiState: readonly PypiStateRow[];
  npmChanges: readonly NpmChangeRow[];
  pypiChanges: readonly PypiChangeRow[];
  registryChanges: readonly RegistryChangeRow[];
  /** 이미 페이지가 있는 Registry 이름(지우지 않기 위해) */
  published: ReadonlySet<string>;
  cfg: SiteConfig;
}

export interface SitePlan {
  files: Map<string, string>;
  records: ServerRecord[];
  qualifying: number;
  keptFromBefore: number;
  skippedNames: number;
}

function groupBy<T>(rows: readonly T[], key: (r: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const r of rows) {
    const k = key(r);
    const g = m.get(k);
    if (g) g.push(r);
    else m.set(k, [r]);
  }
  return m;
}

export function planSite(i: PlanInput): SitePlan {
  const npmState = new Map(i.npmState.map((s) => [s.ident, s]));
  const pypiState = new Map(i.pypiState.map((s) => [s.ident, s]));
  const npmEvents = groupBy(i.npmChanges, (c) => c.ident);
  const pypiEvents = groupBy(i.pypiChanges, (c) => c.ident);
  const regChanges = groupBy(i.registryChanges, (c) => c.name);

  const records: ServerRecord[] = [];
  const paths = new Map<string, string>();
  let qualifying = 0;
  let kept = 0;
  let skipped = 0;
  for (const entry of [...i.entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    if (!entry.packages_key) {
      if (!i.published.has(entry.name)) continue;
    }
    const path = serverPath(entry.name);
    if (!path) {
      if (i.published.has(entry.name)) throw new Error(`published server name no longer maps to a path: ${entry.name}`);
      skipped++;
      continue;
    }
    const rec = buildServerRecord({ entry, npmState, pypiState, npmEvents, pypiEvents, registryChanges: regChanges.get(entry.name) ?? [], path, cfg: i.cfg });
    const q = qualifies(rec);
    if (!q && !i.published.has(entry.name)) continue;
    const other = paths.get(path);
    if (other !== undefined) throw new Error(`path collision after lowercasing: ${other} and ${entry.name} → ${path}`);
    paths.set(path, entry.name);
    if (q) qualifying++;
    else kept++;
    records.push(rec);
  }
  for (const name of i.published) if (!records.some((r) => r.name === name)) throw new Error(`published server missing from Registry state: ${name}`);

  const files = new Map<string, string>();
  for (const r of records) {
    const path = serverPath(r.name)!;
    files.set(`${path}.json`, serializeRecord(r));
    files.set(`${path}.html`, renderServerHtml(r, i.cfg));
  }
  files.set('index.html', renderIndexHtml(records, i.cfg));
  files.set('sitemap.xml', renderSitemap(records, i.cfg));
  return { files, records, qualifying, keptFromBefore: kept, skippedNames: skipped };
}

/** servers.json 용: 서버별 마지막 확인 날짜(선언 패키지의 checked_at 중 가장 늦은 것), 전체 data_as_of */
export function lastCheckedDates(records: readonly ServerRecord[], npmState: readonly NpmStateRow[], pypiState: readonly PypiStateRow[]): { byName: Map<string, string>; dataAsOf: string | null } {
  const npm = new Map(npmState.map((s) => [s.ident, s.checked_at]));
  const pypi = new Map(pypiState.map((s) => [s.ident, s.checked_at]));
  const byName = new Map<string, string>();
  let max: string | null = null;
  for (const r of records) {
    let latest: string | null = null;
    for (const p of r.packages) {
      const c = p.registry_type === 'npm' ? npm.get(p.identifier) : pypi.get(normalizePypiName(p.identifier));
      if (c && (latest === null || c > latest)) latest = c;
    }
    if (latest) {
      byName.set(r.name, day(latest));
      if (max === null || latest > max) max = latest;
    }
  }
  return { byName, dataAsOf: max };
}
