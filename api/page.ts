import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";

// 사람·검색 봇이 읽는 서버 기록 페이지 (vercel.json rewrites → /api/page?kind=...)
//   /servers/{ns}/{name}  kind=server  서버 1개: GET /api/reputation/mcp:{ns}/{name} 응답을 HTML 로 (판정 로직을 다시 만들지 않는다)
//   /servers              kind=index   관찰 중인 서버 목록 (target_status_summary)
//   /sitemap.xml          kind=sitemap 같은 목록 + 마지막 점검일
// 방문은 discovery_hits 에 경로·User-Agent 로 남긴다(검색·AI 사용자 봇이 페이지를 읽었는지 측정). IP 는 저장하지 않는다.
// API 호출에는 방문자의 User-Agent 를 그대로 넘기고 ref=page 를 붙인다 → 조회 기록에서 봇 분류와 페이지 경유가 구분된다.
// 원격 서버가 보낸 문자열은 API 가 이미 형식 검사를 했고, 여기서도 모든 값을 HTML 이스케이프한다.

export const SITE = "https://lowdown-proxy.vercel.app";
// 대량 사용 안내 (2026-10-30): 전체가 필요한 수집기는 페이지를 하나씩 열지 말고 하루치 파일로 → Vercel 사용량과 무관.
// Link 헤더 값은 api/reputation/[target].ts 의 BULK_DATA_LINK 와 같아야 한다(그 모듈을 불러오면 함수가 커져서 복사해 둔다).
export const BULK_DATA_LINK = '<https://github.com/PetShopBros/lowdown-data>; rel="related"; title="Daily dataset for bulk use (CC BY 4.0)"';
const BULK_LINE =
  `<p><strong>All servers at once:</strong> download the daily files instead of opening every page or calling the API once per server (CC BY 4.0, updated daily): ` +
  `<a href="https://petshopbros.github.io/lowdown-data/days/latest.json">latest day (JSON)</a> · ` +
  `<a href="https://github.com/PetShopBros/lowdown-data/tree/main/scanner_observations">raw observations (CSV, Parquet)</a> · ` +
  `<a href="https://github.com/PetShopBros/lowdown-data/blob/main/MANIFEST.csv">file list</a> · ` +
  `<a href="https://huggingface.co/datasets/art2meta/lowdown-mcp-observations">Hugging Face copy</a></p>`;
const NAME_RE = /^[A-Za-z0-9._~-]{1,200}\/[A-Za-z0-9._~-]{1,200}$/;
const MAX_LIST = 10_000;

function getSupabase() {
  const url = process.env.LOWDOWN_SUPABASE_URL;
  const key = process.env.LOWDOWN_SUPABASE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

function header(req: VercelRequest, name: string, max: number): string | null {
  const v = req.headers[name];
  const s = Array.isArray(v) ? v[0] : v;
  return typeof s === "string" && s.length > 0 ? s.slice(0, max) : null;
}

export const esc = (v: unknown): string =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const int = (v: unknown): number | null => (Number.isInteger(v) && (v as number) >= 0 ? (v as number) : null);
const day = (v: unknown): string | null => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null);
export const pagePath = (name: string) => `/servers/${name}`;

const KIND_TEXT: Record<string, string> = {
  schema_changed: "input or output schemas changed",
  description_changed: "descriptions changed",
  tool_names_changed: "tool names changed",
  server_version_changed: "server version changed",
};
const FLAG_TEXT: Record<string, string> = {
  description_url: "a tool description with a URL appeared",
  hidden_direction_controls: "a definition with text-direction control characters appeared",
  hidden_tag_characters: "a definition with Unicode tag characters appeared",
  hidden_zero_width: "a definition with zero-width characters appeared",
  hidden_joiners: "a definition with joiner characters appeared (these are normal in Persian, Arabic and Indic text and in emoji)",
};
const STATE_TEXT: Record<string, string> = {
  answered: "answered initialize and tools/list",
  auth_required: "required authentication (HTTP 401/403)",
  payment_required: "required payment (HTTP 402)",
  list_failed: "answered initialize but not tools/list",
  no_response: "did not respond",
  invalid_response: "did not answer as an MCP server",
  mixed: "its remotes gave different results",
};

const STYLE = `:root{--bg:#fff;--fg:#1a1a1a;--muted:#5f6368;--line:#e3e3e3;--link:#1a56db}
@media (prefers-color-scheme:dark){:root{--bg:#121212;--fg:#ececec;--muted:#a0a0a0;--line:#2c2c2c;--link:#8ab4f8}}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.6 system-ui,-apple-system,Segoe UI,sans-serif}
main{max-width:760px;margin:0 auto;padding:24px 16px 48px}
h1{font-size:1.5rem;line-height:1.3;word-break:break-word;margin:.2em 0 .4em}h2{font-size:1.1rem;margin:1.8em 0 .4em}
a{color:var(--link)}.lead{font-size:1.05rem}.muted{color:var(--muted);font-size:.9rem}
ul{padding-left:1.2em}li{margin:.2em 0}code{font-size:.9em;word-break:break-all}
footer{margin-top:2.5em;border-top:1px solid var(--line);padding-top:1em}
.scroll{overflow-x:auto}table{border-collapse:collapse;width:100%;font-size:.9rem}
th,td{text-align:left;padding:.35em .45em;border-bottom:1px solid var(--line);vertical-align:top}
.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}.tiles{display:flex;flex-wrap:wrap;gap:12px;margin:1em 0}
.tile{border:1px solid var(--line);border-radius:8px;padding:.6em .9em;min-width:9em}.tile b{display:block;font-size:1.4rem}
.bar{display:inline-block;height:.7em;background:var(--link);opacity:.55;vertical-align:middle}`;

function shell(o: { title: string; description: string; canonical: string; noindex: boolean; body: string }): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(o.title)}</title>
<meta name="description" content="${esc(o.description.slice(0, 300))}">
${o.noindex ? '<meta name="robots" content="noindex">\n' : ""}<link rel="canonical" href="${esc(o.canonical)}">
<meta property="og:site_name" content="Lowdown">
<meta property="og:type" content="website">
<meta property="og:title" content="${esc(o.title)}">
<meta property="og:description" content="${esc(o.description.slice(0, 300))}">
<meta property="og:url" content="${esc(o.canonical)}">
<style>${STYLE}</style></head>
<body><main>
${o.body}
</main></body></html>`;
}

/** GET /api/reputation 응답(JSON) → 서버 기록 페이지. 응답이 페이지를 만들 만하지 않으면 null(404). */
export function renderServerPage(name: string, j: Record<string, any>): { html: string; noindex: boolean } | null {
  const st = j.status && typeof j.status === "object" ? j.status : null;
  const reg = j.registry && typeof j.registry === "object" ? j.registry : null;
  const inRegistry = reg && (reg.listed === true || reg.removed_at);
  if (!st && !inRegistry) return null;
  const sc = j.scanner && typeof j.scanner === "object" ? j.scanner : null;
  const noindex = !st; // 관찰 기록이 없는 서버는 내용이 빈약하므로 색인에서 뺀다
  const message = typeof j.message === "string" ? j.message : "";
  const canonical = `${SITE}${pagePath(name)}`;
  const parts: string[] = [];

  parts.push(`<p class="muted"><a href="${SITE}/servers">MCP servers observed by Lowdown</a></p>`);
  parts.push(`<h1>${esc(name)} MCP server: daily status and tool changes</h1>`);
  parts.push(`<p class="lead">${esc(message)}</p>`);
  const lookupTop = typeof j.source?.lookup === "string" && j.source.lookup.startsWith(SITE) ? j.source.lookup : `${SITE}/api/reputation/mcp:${name}`;
  parts.push(
    `<p class="muted">Lowdown observes this server daily, so this record changes from day to day. A copy older than 1 day may be outdated. ` +
      `Current record (JSON): <a href="${esc(lookupTop)}"><code>GET ${esc(lookupTop)}</code></a></p>`,
  );
  parts.push(
    `<p class="muted">Before installing or connecting: <a href="${esc(`${lookupTop}?menu=install-check`)}"><code>GET ${esc(lookupTop)}?menu=install-check</code></a> · ` +
      `other questions: <a href="${SITE}/menu.json">menu</a></p>`,
  );

  // 응답하는가
  parts.push(`<h2>Does it respond?</h2>`);
  if (st) {
    const c = st.checks_30d ?? {};
    const latest = day(st.latest_check);
    parts.push(`<p>Latest daily check: <strong>${esc(latest)}</strong>: the server ${esc(STATE_TEXT[st.state] ?? "was checked")}.${st.stale ? ` That check is ${esc(int(st.days_since_latest_check))} days old, so it is not a current status.` : ""}</p>`);
    parts.push(
      `<ul><li>Observed days in the last 30: ${esc(int(c.observed))}</li><li>Answered initialize and tools/list: ${esc(int(c.answered))}</li>` +
        `<li>Required authentication: ${esc(int(c.auth_required))}</li><li>No response: ${esc(int(c.no_response))}</li><li>Remotes differed: ${esc(int(c.mixed))}</li></ul>`,
    );
  } else {
    parts.push(`<p>Lowdown has no daily check recorded for this server. This says nothing about its status.</p>`);
  }

  // 인증
  parts.push(`<h2>Does it require authentication?</h2>`);
  if (st) {
    const c = st.checks_30d ?? {};
    const a = int(c.auth_required) ?? 0;
    parts.push(
      a > 0
        ? `<p>It returned HTTP 401/403 on ${esc(a)} of ${esc(int(c.observed))} observed days. Lowdown checks without credentials, so the tools behind authentication were not listed.</p>`
        : `<p>It did not return HTTP 401/403 on any of the ${esc(int(c.observed))} observed days. Lowdown checks without credentials.</p>`,
    );
  } else {
    parts.push(`<p>Not recorded.</p>`);
  }

  // 도구 변경
  parts.push(`<h2>Did its tools change recently?</h2>`);
  const dc = sc?.definition_changes;
  if (dc && typeof dc === "object") {
    if (typeof dc.note === "string") parts.push(`<p>${esc(dc.note)}</p>`);
    const events = Array.isArray(dc.events) ? dc.events : [];
    if (events.length > 0) {
      const items = events.map((e: any) => {
        const kinds = (Array.isArray(e.kinds) ? e.kinds : []).map((k: string) => KIND_TEXT[k]).filter(Boolean).join(", ");
        const tc = e.tool_count && int(e.tool_count.from) !== null ? `; tool count ${esc(int(e.tool_count.from))} → ${esc(int(e.tool_count.to))}` : "";
        const flags = Array.isArray(e.new_flags)
          ? e.new_flags
              .map((f: any) => {
                const t = FLAG_TEXT[f?.rule];
                if (!t) return null;
                const doms = Array.isArray(f.new_domains) && f.new_domains.length ? ` (${f.new_domains.map(esc).join(", ")})` : "";
                return `${esc(t)}${doms}`;
              })
              .filter(Boolean)
          : [];
        const flagText = flags.length ? `; ${flags.join("; ")}` : "";
        return `<li><strong>${esc(day(e.day))}</strong>: ${esc(kinds || "changed")}${tc}${flagText}</li>`;
      });
      parts.push(`<ul>${items.join("")}</ul>`);
    }
  } else {
    parts.push(`<p>No comparison of tool definitions is recorded.</p>`);
  }

  // 도구 목록
  parts.push(`<h2>What tools does it list?</h2>`);
  const names: string[] = Array.isArray(sc?.tools?.names) ? sc.tools.names.filter((n: unknown) => typeof n === "string") : [];
  if (names.length > 0) {
    parts.push(`<p>${esc(names.length)} tool${names.length === 1 ? "" : "s"} on ${esc(day(sc.tools.observed_at))}:</p>`);
    parts.push(`<ul>${names.slice(0, 200).map((n) => `<li><code>${esc(n)}</code></li>`).join("")}</ul>`);
  } else {
    parts.push(`<p>No tool list is recorded (for example, the server required authentication or did not answer tools/list).</p>`);
  }

  // Registry
  if (reg) {
    parts.push(`<h2>MCP Registry declaration</h2><ul>`);
    if (reg.name) parts.push(`<li>Registry name: <code>${esc(reg.name)}</code></li>`);
    if (reg.declared_version) parts.push(`<li>Declared version: ${esc(reg.declared_version)}</li>`);
    if (reg.status) parts.push(`<li>Status: ${esc(reg.status)}</li>`);
    if (Array.isArray(reg.remote_hosts) && reg.remote_hosts.length) parts.push(`<li>Declared hosts: ${reg.remote_hosts.map((h: unknown) => `<code>${esc(h)}</code>`).join(", ")}</li>`);
    if (reg.removed_at) parts.push(`<li>Removed from the Registry: ${esc(day(reg.removed_at))}</li>`);
    parts.push(`</ul>`);
  }

  const lookup = typeof j.source?.lookup === "string" && j.source.lookup.startsWith(SITE) ? j.source.lookup : `${SITE}/api/reputation/mcp:${name}`;
  parts.push(
    `<footer class="muted"><p>This page is Lowdown's record of observations, not the official page of this server. ` +
      `Lowdown checks a sample of MCP Registry servers once a day from one network location (POST initialize, then tools/list; no tool calls, no credentials). ` +
      `Each line is a recorded fact with a date, not a score or a judgment. A day without a check is not counted as a failure.</p>` +
      `<p>Data: <a href="${esc(lookup)}">JSON for this server</a> · <a href="https://github.com/PetShopBros/lowdown-data">daily dataset (CC BY 4.0)</a> · <a href="${SITE}/llms.txt">llms.txt</a></p></footer>`,
  );

  const html = shell({
    title: `${name} MCP server: daily status and tool changes | Lowdown`,
    description: message,
    canonical,
    noindex,
    body: parts.join("\n"),
  });
  return { html, noindex };
}

/** /privacy: 원격 MCP·조회 API 의 개인정보 처리 안내 (Claude Connectors Directory 등 제출 필수 항목). 사실만, 기록 코드와 같아야 한다. */
export function renderPrivacy(): string {
  return shell({
    title: "Lowdown privacy policy",
    description: "What Lowdown records when you use its lookup API, server pages, or remote MCP server, and what it does not record.",
    canonical: `${SITE}/privacy`,
    noindex: false,
    body:
      `<h1>Privacy policy</h1>` +
      `<p class="muted">Effective 2026-11-05 (previous version 2026-10-30, before remote MCP call records and the public aggregates). Applies to ${esc(SITE)} (lookup API, server pages, discovery files, status and agent pages) and the remote MCP server at ${esc(SITE)}/mcp. Operated by ART2META (Republic of Korea).</p>` +
      `<h2>What Lowdown records</h2><ul>` +
      `<li><strong>Requests:</strong> the path and query of each request (for example the server name you looked up and the menu you chose), the HTTP method, the User-Agent header, the Referer header, and the time.</li>` +
      `<li><strong>Lookups:</strong> the lookup target or the Find conditions (including the words given in <code>does</code>), the User-Agent, the <code>ref</code> tag (for example <code>mcp</code> for the remote MCP server), the menu, and the kind of answer returned.</li>` +
      `<li><strong>Remote MCP calls:</strong> for each JSON-RPC message sent to <code>/mcp</code>, the method (for example <code>initialize</code>, <code>tools/list</code>, <code>tools/call</code>), the tool name and menu, whether it succeeded and the error code if not, the response time, the protocol version, the client name and version your MCP client declares in <code>initialize</code>, the optional <code>x-agent-id</code> header, and the User-Agent. Tool argument values are not stored in this record.</li>` +
      `<li><strong>Reported interactions:</strong> only if you call the reporting endpoint or the local proxy reports for you: the identifiers and outcome you send.</li>` +
      `<li><strong>Feedback:</strong> only what you send to the feedback endpoint.</li></ul>` +
      `<h2>What Lowdown does not record</h2><ul>` +
      `<li>IP addresses. Lowdown does not store them.</li>` +
      `<li>Cookies, accounts, or sign-in data. Lowdown has no accounts and sets no cookies.</li>` +
      `<li>The content of your conversation with an AI assistant. The remote MCP server receives only the tool arguments: a lookup target and menu, or Find conditions.</li></ul>` +
      `<h2>How records are used</h2>` +
      `<p>To count how Lowdown is used (for example how many lookups come through the remote MCP server), to find errors, and to decide what to build. Individual request, lookup and MCP call records are not published and are not sold. Lookup targets, Find conditions and IP addresses are never published.</p>` +
      `<p>Lowdown publishes aggregates computed from these records: <a href="${SITE}/status.json">/status.json</a> (operating counts, updated hourly) and <a href="${SITE}/agents">/agents</a> (visits in the last 30 days grouped by the name a client declares in its User-Agent, with days seen, visit and request counts, path kinds, and remote MCP stages). Names are shown as declared, not as verified identities. Requests made by AI assistants on behalf of a person (for example Claude-User) are counted only in totals. To have a declared name removed from /agents, open a <a href="https://github.com/PetShopBros/lowdown-proxy/issues">GitHub issue</a> or write to the address below.</p>` +
      `<p>The public dataset contains Scanner observations and Registry records, not request records.</p>` +
      `<h2>Retention</h2>` +
      `<p>Records are kept without a fixed deletion date, as part of Lowdown's long-term record.</p>` +
      `<h2>Service providers</h2>` +
      `<p>Lowdown runs on Vercel (hosting) and Supabase (database). They process requests under their own terms and may keep operational logs, including IP addresses, as their own services do.</p>` +
      `<h2>Contact</h2>` +
      `<p>Questions or requests: <a href="mailto:atom.art2meta@gmail.com">atom.art2meta@gmail.com</a> or <a href="https://github.com/PetShopBros/lowdown-proxy/issues">GitHub issues</a>.</p>`,
  });
}

/** /terms: 이용약관 (ChatGPT 플러그인 등 공개 제출 필수 항목). 무료·인증 없음·관측 사실·보증 없음. */
export function renderTerms(): string {
  return shell({
    title: "Lowdown terms of service",
    description: "Terms for using Lowdown's lookup API, server pages, daily dataset, and remote MCP server.",
    canonical: `${SITE}/terms`,
    noindex: false,
    body:
      `<h1>Terms of service</h1>` +
      `<p class="muted">Effective 2026-10-30. Applies to ${esc(SITE)} (lookup API, server pages, discovery files), the remote MCP server at ${esc(SITE)}/mcp, and the public daily dataset. Operated by ART2META (Republic of Korea).</p>` +
      `<h2>The service</h2>` +
      `<p>Lowdown records what MCP Registry servers declare and what is observed about them once a day, and returns those records with dates and sources. It is free to use. No account, sign-in, or API key is needed.</p>` +
      `<h2>What the records are and are not</h2><ul>` +
      `<li>Records are observed facts from one network location at the time stated. They can be incomplete, delayed, or wrong, and they change from day to day.</li>` +
      `<li>Lowdown does not score, grade, rank, certify, or endorse any server. A record is not a security assessment, and the absence of a record says nothing about a server.</li>` +
      `<li>Decisions you or your software make using the records are your own. Check the current record before relying on an older copy.</li></ul>` +
      `<h2>Data license</h2>` +
      `<p>MCP Registry records and Lowdown Scanner observations are available under <a href="https://creativecommons.org/licenses/by/4.0/">CC BY 4.0</a>. Keep the <code>source</code> block or cite "Lowdown (https://github.com/PetShopBros/lowdown-data)" with the retrieval date when you republish them. The source code is available under the MIT license in the repository.</p>` +
      `<h2>Fair use of the service</h2><ul>` +
      `<li>To read records for many servers, use the <a href="https://github.com/PetShopBros/lowdown-data">daily dataset</a> instead of calling the lookup API once per server.</li>` +
      `<li>Do not try to disrupt the service, bypass its limits, or submit false reports through the reporting endpoint.</li>` +
      `<li>Lowdown may limit or refuse requests that harm the service for other users.</li></ul>` +
      `<h2>No warranty</h2>` +
      `<p>The service and data are provided "as is", without warranties of any kind, to the extent permitted by law. ART2META is not liable for losses arising from use of the records, to the extent permitted by law.</p>` +
      `<h2>Changes</h2>` +
      `<p>These terms may change. The effective date above shows the latest version. The service may change or stop.</p>` +
      `<h2>Privacy and contact</h2>` +
      `<p>See the <a href="${SITE}/privacy">privacy policy</a>. Questions: <a href="mailto:atom.art2meta@gmail.com">atom.art2meta@gmail.com</a> or <a href="https://github.com/PetShopBros/lowdown-proxy/issues">GitHub issues</a>. These terms are governed by the laws of the Republic of Korea.</p>`,
  });
}

// ── 상황판 (2026-11-05): 홈 상단에 최신 스냅샷 요약 ──
// api/status.ts 의 latestStatus·statusCacheSeconds 와 같은 내용(API 파일끼리 import 하지 않는 규칙). 바꿀 때 status.ts·discovery.ts 도 같이.
const STATUS_REFRESH_MINUTE = 57;
const STALE_AFTER_MS = 2 * 3_600_000;
export function statusCacheSeconds(now = Date.now()): number {
  const d = new Date(now);
  const next = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), STATUS_REFRESH_MINUTE, 0));
  if (next.getTime() <= now) next.setUTCHours(next.getUTCHours() + 1);
  return Math.min(3600, Math.max(60, Math.ceil((next.getTime() - now) / 1000)));
}
export type StatusSnapshot = { id: number; generated_at: string; data: Record<string, any> };
async function latestStatus(): Promise<StatusSnapshot | null> {
  const base = process.env.LOWDOWN_SUPABASE_URL;
  const key = process.env.LOWDOWN_SUPABASE_KEY;
  if (!base || !key) return null;
  try {
    const r = await fetch(`${base}/rest/v1/status_snapshots?select=id,generated_at,data&order=hour_bucket.desc&limit=1`, {
      headers: { apikey: key, Authorization: `Bearer ${key}`, accept: "application/json" },
      signal: AbortSignal.timeout(4000),
    });
    if (!r.ok) return null;
    const row = ((await r.json()) as StatusSnapshot[])[0];
    return row && typeof row.data === "object" && row.data !== null ? row : null;
  } catch {
    return null;
  }
}

/** 홈 상단 상황판 HTML. 문장은 스냅샷의 summary_lines·highlights 그대로(세 위치가 같은 문장). 없으면 빈 문자열. */
export function renderStatus(s: StatusSnapshot | null, now = Date.now()): string {
  if (!s) return "";
  const d = s.data;
  const age = now - Date.parse(s.generated_at);
  const stale = !(age >= 0 && age <= STALE_AFTER_MS);
  const lines = (Array.isArray(d.summary_lines) ? d.summary_lines : []).filter((x: unknown) => typeof x === "string");
  const hl = (Array.isArray(d.highlights) ? d.highlights : []).filter((h: any) => typeof h?.text === "string");
  const monitors = (Array.isArray(d.regular_monitors) ? d.regular_monitors : []).slice(0, 10);
  return (
    `<h2>Status <span class="muted">(updated hourly)</span></h2>` +
    (hl.length ? `<p><strong>Highlights, last 7 days</strong></p><ul>${hl.map((h: any) => `<li>${esc(h.text)}</li>`).join("")}</ul>` : "") +
    `<ul>${lines.map((l: string) => `<li>${esc(l)}</li>`).join("")}</ul>` +
    (monitors.length
      ? `<p class="muted">Regular visitors (declared check tools): ${monitors
          .map((m: any) => `${esc(m.name)}${typeof m.median_interval_minutes === "number" ? ` (about every ${esc(Math.round(m.median_interval_minutes))} min)` : ""}`)
          .join(", ")}</p>`
      : "") +
    `<p class="muted">Snapshot ${esc(d.snapshot_id ?? s.id)}, generated ${esc(d.generated_at ?? s.generated_at)}` +
    (stale ? " (more than 2 hours old; the hourly update may be delayed)" : "") +
    `. Names come from User-Agent declarations, not verified identities. <a href="${SITE}/status.json">status.json</a> has the full data and definitions. Visitors by name: <a href="${SITE}/agents">Agent Observatory</a>.</p>`
  );
}


// ── Agent Observatory (2026-11-05) ─────────────────────────────
// /agents, /agents/{kind}/{slug}: 매시 54분 스냅샷(agent_snapshots, supabase/2026-11-05_agents.sql)을 그대로 보여준다.
// api/agents.ts 의 latestAgents·agentsCacheSeconds 와 같은 내용(API 파일끼리 import 하지 않는 규칙). 바꿀 때 둘 다.
// 이름은 User-Agent 선언에서 뽑은 것. 점수·순위·판정 없음. 사람이 실행한 AI 요청·범용 라이브러리·이름 없는 요청·제외 요청은 합계만.
const AGENTS_REFRESH_MINUTE = 59;
export function agentsCacheSeconds(now = Date.now()): number {
  const d = new Date(now);
  const next = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), AGENTS_REFRESH_MINUTE, 0));
  if (next.getTime() <= now) next.setUTCHours(next.getUTCHours() + 1);
  return Math.min(3600, Math.max(60, Math.ceil((next.getTime() - now) / 1000)));
}
export type AgentSnapshot = { id: number; generated_at: string; data: Record<string, any> };
async function latestAgents(): Promise<AgentSnapshot | null> {
  const base = process.env.LOWDOWN_SUPABASE_URL;
  const key = process.env.LOWDOWN_SUPABASE_KEY;
  if (!base || !key) return null;
  try {
    const r = await fetch(`${base}/rest/v1/agent_snapshots?select=id,generated_at,data&order=hour_bucket.desc&limit=1`, {
      headers: { apikey: key, Authorization: `Bearer ${key}`, accept: "application/json" },
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) return null;
    const row = ((await r.json()) as AgentSnapshot[])[0];
    return row && typeof row.data === "object" && row.data !== null ? row : null;
  } catch {
    return null;
  }
}

export const AGENT_KINDS = ["prober", "crawler", "other"] as const;
const SLUG_RE = /^[a-z0-9._-]{1,100}$/;
const KIND_LABEL: Record<string, string> = { prober: "declares a check tool", crawler: "declares a crawler", other: "name only" };
const PATH_LABEL: Record<string, string> = {
  mcp: "/mcp", lookup_api: "lookup API", find_api: "find API", server_pages: "server pages", discovery_files: "discovery files",
  well_known: "/.well-known", home: "home", other: "other",
};
const n = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const fmt = (v: unknown): string => n(v).toLocaleString("en-US");
const dayOf = (v: unknown): string => (typeof v === "string" ? v.slice(0, 10) : "");

function pathMixText(pm: unknown): string {
  if (!pm || typeof pm !== "object") return "";
  return Object.entries(pm as Record<string, unknown>)
    .filter(([, v]) => n(v) > 0)
    .sort((a, b) => n(b[1]) - n(a[1]))
    .map(([k, v]) => `${esc(PATH_LABEL[k] ?? k)} ${esc(fmt(v))}`)
    .join(" · ");
}
function mcpText(m: any): string {
  const st = (k: string) => `${fmt(m?.[k]?.attempts)}/${fmt(m?.[k]?.ok)}`;
  return `${st("initialize")} · ${st("tools_list")} · ${st("tools_call")}`;
}
const intervalText = (a: any): string =>
  typeof a.median_interval_minutes === "number" ? `about every ${esc(Math.round(a.median_interval_minutes))} min` : "unknown";

function agentsHeader(d: Record<string, any>): string {
  return (
    `<p class="lead">User-Agent declarations and observed request activity of systems that visited Lowdown in the last 30 days. ` +
    `A name is not a verified identity and not a count of independent operators. No score, rank or verdict.</p>`
  );
}
function snapshotLine(s: AgentSnapshot, now: number): string {
  const d = s.data;
  const age = now - Date.parse(s.generated_at);
  const stale = !(age >= 0 && age <= 2 * 3_600_000);
  return (
    `<p class="muted">Updated hourly. Snapshot ${esc(d.snapshot_id ?? s.id)}, generated ${esc(d.generated_at ?? s.generated_at)}` +
    (stale ? " (more than 2 hours old; the hourly update may be delayed)" : "") +
    `. Window ${esc(dayOf(d.window?.from))} to ${esc(dayOf(d.window?.to))} (UTC). ` +
    `MCP messages recorded since ${esc(dayOf(d.mcp_recorded_since) || "n/a")}; earlier periods have no record, not zero calls. ` +
    `Definitions and limits: <a href="${SITE}/agents.json">agents.json</a>.</p>`
  );
}

/** /agents 목록 */
export function renderAgents(s: AgentSnapshot, now = Date.now()): string {
  const d = s.data;
  const agents: any[] = Array.isArray(d.agents) ? d.agents : [];
  const t = d.totals ?? {};
  const ag = d.aggregates ?? {};
  const rows = agents
    .filter((a) => AGENT_KINDS.includes(a?.declared_kind) && typeof a?.slug === "string" && SLUG_RE.test(a.slug))
    .map((a) =>
      `<tr><td><a href="/agents/${esc(a.declared_kind)}/${esc(encodeURIComponent(a.slug))}">${esc(a.name)}</a>${a.regular ? ` <span class="muted">regular</span>` : ""}</td>` +
      `<td>${esc(KIND_LABEL[a.declared_kind] ?? "")}</td>` +
      `<td class="num">${esc(fmt(a.days_seen))}</td><td class="num">${esc(fmt(a.visits))}</td><td class="num">${esc(fmt(a.requests))}</td>` +
      `<td>${intervalText(a)}</td><td>${esc(dayOf(a.last_seen))}</td>` +
      `<td class="muted">${pathMixText(a.path_mix)}</td><td class="num">${mcpText(a.mcp)}</td></tr>`,
    );
  return shell({
    title: "Agent Observatory: systems that visit Lowdown",
    description: `User-Agent declarations and request activity of ${agents.length} named systems that visited Lowdown in the last 30 days. Not verified identities; no scores.`,
    canonical: `${SITE}/agents`,
    noindex: false,
    body:
      `<h1>Agent Observatory</h1>` + agentsHeader(d) +
      `<div class="tiles">` +
      `<div class="tile"><b>${esc(fmt(t.names))}</b>names seen</div>` +
      `<div class="tile"><b>${esc(fmt(t.regular_names))}</b>regular (3+ days)</div>` +
      `<div class="tile"><b>${esc(fmt(t.by_kind?.prober))}</b>declare a check tool</div>` +
      `<div class="tile"><b>${esc(fmt(t.by_kind?.crawler))}</b>declare a crawler</div>` +
      `<div class="tile"><b>${esc(fmt(t.tools_call_ok))}</b>successful MCP tools/call</div>` +
      `</div>` +
      snapshotLine(s, now) +
      `<div class="scroll"><table><thead><tr><th>Name (declared)</th><th>Kind (declared)</th><th class="num">Days</th><th class="num">Visits</th><th class="num">Requests</th>` +
      `<th>Interval</th><th>Last seen</th><th>Paths</th><th class="num">MCP init · list · call<br><span class="muted">attempts/ok</span></th></tr></thead>` +
      `<tbody>${rows.join("")}</tbody></table></div>` +
      `<h2>Counted only in totals</h2><ul>` +
      `<li>AI assistants acting for a person (for example Claude-User): ${esc(fmt(ag.ai_user?.requests))} requests. Not listed by name.</li>` +
      `<li>Generic HTTP library names (for example node, python-httpx): ${esc(fmt(ag.http_libraries?.requests))} requests. A library name does not identify an agent.</li>` +
      `<li>No name in the User-Agent (including browser-style strings): ${esc(fmt(ag.unnamed?.requests))} requests.</li>` +
      `<li>Names removed on request: ${esc(fmt(ag.opted_out?.names))} names, ${esc(fmt(ag.opted_out?.requests))} requests. The names are not published.</li></ul>` +
      `<h2>Order and removal</h2>` +
      `<p>Order is days seen, then requests, then name. It is not a ranking. Which servers a visitor looked up is not shown. ` +
      `To remove a name from this list, open an issue at <a href="https://github.com/PetShopBros/lowdown-proxy/issues">GitHub</a> or write to <a href="mailto:atom.art2meta@gmail.com">atom.art2meta@gmail.com</a>. Removed names stay in the totals; records are kept.</p>` +
      `<footer class="muted"><a href="${SITE}/">Lowdown</a> · <a href="${SITE}/status.json">status.json</a> · <a href="${SITE}/agents.json">agents.json</a> · <a href="${SITE}/privacy">privacy</a></footer>`,
  });
}

/** /agents/{kind}/{slug} 상세. 없으면 null(404). */
export function renderAgent(s: AgentSnapshot, kind: string, slug: string, now = Date.now()): string | null {
  if (!(AGENT_KINDS as readonly string[]).includes(kind) || !SLUG_RE.test(slug)) return null;
  const agents: any[] = Array.isArray(s.data.agents) ? s.data.agents : [];
  const a = agents.find((x) => x?.declared_kind === kind && x?.slug === slug);
  if (!a) return null;
  const daily: any[] = Array.isArray(a.daily) ? a.daily : [];
  const max = Math.max(1, ...daily.map((x) => n(x?.requests)));
  const urls: string[] = (Array.isArray(a.declared_urls) ? a.declared_urls : []).filter((u: unknown) => typeof u === "string" && /^https?:\/\//.test(u));
  const clients: string[] = (Array.isArray(a.declared_client_names) ? a.declared_client_names : []).filter((c: unknown) => typeof c === "string");
  const m = a.mcp ?? {};
  const stage = (k: string, label: string) => `<tr><td>${label}</td><td class="num">${esc(fmt(m[k]?.attempts))}</td><td class="num">${esc(fmt(m[k]?.ok))}</td></tr>`;
  return shell({
    title: `${String(a.name ?? slug).slice(0, 80)}: observed visits to Lowdown`,
    description: `User-Agent declaration and observed request activity for the name ${String(a.name ?? slug).slice(0, 80)} in the last 30 days. Not a verified identity; no score.`,
    canonical: `${SITE}/agents/${kind}/${encodeURIComponent(slug)}`,
    noindex: false,
    body:
      `<p class="muted"><a href="/agents">Agent Observatory</a></p>` +
      `<h1>${esc(a.name)}</h1>` +
      `<p class="lead">${esc(KIND_LABEL[kind] ?? "")} (User-Agent declaration). A name is not a verified identity; the same name may be used by different operators.</p>` +
      `<ul>` +
      `<li>Declared User-Agent: <code>${esc(a.declared_user_agent)}</code>${n(a.user_agent_variants) > 1 ? ` <span class="muted">(${esc(fmt(a.user_agent_variants))} different User-Agent strings under this name)</span>` : ""}</li>` +
      (urls.length ? `<li>Addresses written in the User-Agent (self-description, not proof of identity; Lowdown does not open them): ${urls.map((u) => `<code>${esc(u)}</code>`).join(", ")}</li>` : "") +
      (clients.length ? `<li>clientInfo names sent in MCP initialize: ${clients.map((c) => `<code>${esc(c)}</code>`).join(", ")}</li>` : "") +
      `<li>First seen ${esc(dayOf(a.first_seen))}, last seen ${esc(dayOf(a.last_seen))} (UTC)</li>` +
      `<li>Last 30 days: ${esc(fmt(a.days_seen))} days, ${esc(fmt(a.visits))} visits, ${esc(fmt(a.requests))} requests; interval ${intervalText(a)}${a.regular ? "; regular visitor" : ""}</li>` +
      `<li>Paths: ${pathMixText(a.path_mix) || "none"}</li>` +
      `</ul>` +
      `<h2>Remote MCP</h2>` +
      `<table><thead><tr><th>Stage</th><th class="num">Attempts</th><th class="num">OK</th></tr></thead><tbody>` +
      stage("initialize", "initialize") + stage("tools_list", "tools/list") + stage("tools_call", "tools/call") +
      `</tbody></table>` +
      `<p class="muted">OK means Lowdown returned a result without an error; it does not mean the visitor achieved its goal.</p>` +
      `<h2>Requests per day (UTC)</h2>` +
      `<table><tbody>${daily
        .map((x) => `<tr><td>${esc(dayOf(x?.day))}</td><td class="num">${esc(fmt(x?.requests))}</td><td style="width:60%"><span class="bar" style="width:${Math.max(1, Math.round((n(x?.requests) / max) * 100))}%"></span></td></tr>`)
        .join("")}</tbody></table>` +
      snapshotLine(s, now) +
      `<footer class="muted"><a href="/agents">All names</a> · <a href="${SITE}/agents.json">agents.json</a> · To remove this name from the list: <a href="https://github.com/PetShopBros/lowdown-proxy/issues">GitHub</a> or <a href="mailto:atom.art2meta@gmail.com">atom.art2meta@gmail.com</a></footer>`,
  });
}

export interface ListRow {
  target_id: string;
  latest_day: string | null;
  latest_state: string | null;
}

/** target_status_summary 행 → 페이지 이름. mcp:{ns}/{name} 이고 안전한 문자만. */
export function nameOf(targetId: unknown): string | null {
  if (typeof targetId !== "string" || !targetId.startsWith("mcp:")) return null;
  const n = targetId.slice(4);
  return NAME_RE.test(n) ? n : null;
}

export function renderIndex(rows: ListRow[], opts: { home?: boolean; statusHtml?: string } = {}): string {
  const items = rows
    .map((r) => ({ n: nameOf(r.target_id), r }))
    .filter((x): x is { n: string; r: ListRow } => x.n !== null)
    .map(({ n, r }) => `<li><a href="${esc(pagePath(n))}">${esc(n)}</a> <span class="muted">${esc(STATE_TEXT[r.latest_state ?? ""] ?? "")}${day(r.latest_day) ? `, ${esc(day(r.latest_day))}` : ""}</span></li>`);
  const home = opts.home === true;
  return shell({
    title: home ? "Lowdown: daily evidence about MCP servers" : "MCP servers observed by Lowdown: daily status and tool changes",
    description: `Daily status and tool definition changes for ${items.length} MCP Registry servers observed by Lowdown.`,
    canonical: home ? `${SITE}/` : `${SITE}/servers`,
    noindex: false,
    body:
      (home
        ? `<h1>Lowdown</h1><p class="lead">Lowdown records, once a day, what MCP Registry servers actually do: whether they answer initialize and tools/list, whether they require authentication, and when their tool definitions change. Recorded facts with dates, not scores.</p>` +
          `<p>Look up one server: <code>GET ${SITE}/api/reputation/mcp:{namespace}/{name}</code> · <a href="${SITE}/llms.txt">llms.txt</a> · <a href="${SITE}/openapi.json">OpenAPI</a> · <a href="https://github.com/PetShopBros/lowdown-data">daily dataset (CC BY 4.0)</a> · <a href="https://github.com/PetShopBros/lowdown-proxy">source</a></p>` +
          BULK_LINE +
          (opts.statusHtml ?? "") +
          `<h2>Observed servers</h2>`
        : `<h1>MCP servers observed by Lowdown</h1>` + BULK_LINE) +
      `<p class="lead">${esc(items.length)} MCP Registry servers with a recorded daily check. Each page states whether the server answered initialize and tools/list, whether it required authentication, and how its tool definitions changed, with dates.</p>` +
      `<p class="muted">Recorded facts from one network location, not scores. <a href="${SITE}/llms.txt">llms.txt</a> · <a href="https://github.com/PetShopBros/lowdown-data">dataset</a></p>` +
      `<ul>${items.join("")}</ul>`,
  });
}

export function renderSitemap(rows: ListRow[]): string {
  const urls = rows
    .map((r) => ({ n: nameOf(r.target_id), d: day(r.latest_day) }))
    .filter((x): x is { n: string; d: string | null } => x.n !== null)
    .map(({ n, d }) => `<url><loc>${esc(`${SITE}${pagePath(n)}`)}</loc>${d ? `<lastmod>${d}</lastmod>` : ""}</url>`);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n<url><loc>${SITE}/servers</loc></url>\n${urls.join("\n")}\n</urlset>\n`;
}

// ── sitemap 분할 (2026-11-05) ──────────────────────────────
// /sitemap.xml 은 sitemap index. 하위: /sitemaps/pages.xml(고정 페이지) + /sitemaps/servers-N.xml(서버 5,000개씩, 자동으로 늘어남).
// 배경: 목록을 MAX_LIST(10,000)로 잘라 sitemap 을 만들어 12,127개 중 약 2,100개 서버 페이지가 빠졌다(GPTBot 서버 상세 수집이 정확히 10,000에서 멈춤).
// 포함: target_status_summary 의 서버(관측 기록이 있어 페이지가 열림) 중 이름 형식이 맞고, Registry 에서 deleted 가 아닌 것. target_id 순.
// lastmod: 최신 일일 점검 날짜(latest_day)가 있을 때만(그날 페이지 내용이 갱신됨). 없으면 넣지 않는다.
export const SITEMAP_PART_SIZE = 5_000; // 규격 상한 50,000 보다 작게
const MAX_SITEMAP_ROWS = 500_000;
export const STATIC_PAGES = ["/", "/servers", "/agents", "/privacy", "/terms"] as const;
export type SitemapEntry = { loc: string; lastmod: string | null };

/** 목록 → 중복 없는 서버 URL (target_id 순). deleted 와 이름 형식 밖은 뺀다. */
export function sitemapEntries(rows: ListRow[], deleted: ReadonlySet<string> = new Set()): SitemapEntry[] {
  const seen = new Set<string>();
  const out: SitemapEntry[] = [];
  for (const r of [...rows].sort((a, b) => (a.target_id < b.target_id ? -1 : a.target_id > b.target_id ? 1 : 0))) {
    if (deleted.has(r.target_id)) continue;
    const n = nameOf(r.target_id);
    if (!n) continue;
    const loc = `${SITE}${pagePath(n)}`;
    if (seen.has(loc)) continue;
    seen.add(loc);
    out.push({ loc, lastmod: day(r.latest_day) });
  }
  return out;
}

export function sitemapParts(entries: SitemapEntry[], size = SITEMAP_PART_SIZE): SitemapEntry[][] {
  const parts: SitemapEntry[][] = [];
  for (let i = 0; i < entries.length; i += size) parts.push(entries.slice(i, i + size));
  return parts;
}

const maxDay = (es: SitemapEntry[]): string | null => es.reduce<string | null>((m, e) => (e.lastmod && (!m || e.lastmod > m) ? e.lastmod : m), null);

export function renderSitemapIndex(parts: SitemapEntry[][]): string {
  const items = [`<sitemap><loc>${SITE}/sitemaps/pages.xml</loc></sitemap>`].concat(
    parts.map((p, i) => {
      const lm = maxDay(p);
      return `<sitemap><loc>${SITE}/sitemaps/servers-${i + 1}.xml</loc>${lm ? `<lastmod>${lm}</lastmod>` : ""}</sitemap>`;
    }),
  );
  return `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${items.join("\n")}\n</sitemapindex>\n`;
}

export function renderUrlset(entries: SitemapEntry[]): string {
  const urls = entries.map((e) => `<url><loc>${esc(e.loc)}</loc>${e.lastmod ? `<lastmod>${e.lastmod}</lastmod>` : ""}</url>`);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join("\n")}\n</urlset>\n`;
}

/** /sitemaps/{file} → 'pages' | 서버 묶음 번호(1부터) | null */
export function sitemapFile(file: unknown): "pages" | number | null {
  if (file === "pages.xml") return "pages";
  const m = typeof file === "string" ? /^servers-([1-9]\d{0,3})\.xml$/.exec(file) : null;
  return m ? Number(m[1]) : null;
}

async function deletedTargets(supabase: any): Promise<Set<string> | null> {
  const out = new Set<string>();
  for (let from = 0; from < MAX_SITEMAP_ROWS; from += 1000) {
    const r = await supabase.from("server_cards").select("target_id").eq("registry_status", "deleted").order("target_id", { ascending: true }).range(from, from + 999);
    if (r.error) return null;
    const rows = (r.data ?? []) as Array<{ target_id: string }>;
    for (const x of rows) out.add(x.target_id);
    if (rows.length < 1000) break;
  }
  return out;
}

async function listRows(supabase: any, max = MAX_LIST): Promise<ListRow[] | null> {
  const out: ListRow[] = [];
  for (let from = 0; from < max; from += 1000) {
    const r = await supabase.from("target_status_summary").select("target_id,latest_day,latest_state").order("target_id", { ascending: true }).range(from, from + 999);
    if (r.error) return null;
    const rows = (r.data ?? []) as ListRow[];
    out.push(...rows);
    if (rows.length < 1000) break;
  }
  return out;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET" && req.method !== "HEAD") return res.status(405).send("Method not allowed");
  const kind = typeof req.query.kind === "string" ? req.query.kind : "";
  const ua = header(req, "user-agent", 300);
  const supabase = getSupabase();

  const unavailable = () => {
    res.setHeader("Retry-After", "120");
    res.setHeader("Cache-Control", "no-store");
    return res.status(503).send("Temporarily unavailable. Retry later.");
  };

  let path = "";
  let status = 200;
  let body = "";
  let type = "text/html; charset=utf-8";

  if (kind === "server") {
    const ns = typeof req.query.ns === "string" ? req.query.ns : "";
    const nm = typeof req.query.name === "string" ? req.query.name : "";
    const name = `${ns}/${nm}`;
    if (!NAME_RE.test(name)) return res.status(404).send("Not found");
    path = pagePath(name);
    const host = header(req, "host", 200) ?? "lowdown-proxy.vercel.app";
    let r: Response;
    try {
      // nc=1(실사용·검색 봇) 이면 안쪽 API 조회도 캐시를 건너뛰게 넘긴다
      r = await fetch(`https://${host}/api/reputation/mcp:${name}?ref=page${req.query.nc === "1" ? "&nc=1" : ""}`, {
        headers: { "user-agent": ua ?? "", accept: "application/json" },
        signal: AbortSignal.timeout(9000),
      });
    } catch {
      return unavailable();
    }
    if (r.status === 503) return unavailable();
    if (!r.ok) return res.status(404).send("Not found");
    const page = renderServerPage(name, (await r.json()) as Record<string, any>);
    if (!page) {
      status = 404;
      body = "Not found";
      type = "text/plain; charset=utf-8";
    } else body = page.html;
  } else if (kind === "terms") {
    path = "/terms";
    body = renderTerms();
  } else if (kind === "privacy") {
    path = "/privacy";
    body = renderPrivacy();
  } else if (kind === "agents" || kind === "agent") {
    const snap = await latestAgents();
    if (!snap) return unavailable();
    if (kind === "agents") {
      path = "/agents";
      body = renderAgents(snap);
    } else {
      const ak = typeof req.query.akind === "string" ? req.query.akind : "";
      const slug = typeof req.query.slug === "string" ? req.query.slug : "";
      const html = renderAgent(snap, ak, slug);
      if (!html) return res.status(404).send("Not found");
      path = `/agents/${ak}/${slug}`;
      body = html;
    }
  } else if (kind === "sitemap" || kind === "sitemap-part") {
    if (!supabase) return unavailable();
    const which = kind === "sitemap" ? null : sitemapFile(req.query.file);
    if (kind === "sitemap-part" && which === null) return res.status(404).send("Not found");
    type = "application/xml; charset=utf-8";
    if (which === "pages") {
      path = "/sitemaps/pages.xml";
      body = renderUrlset(STATIC_PAGES.map((p) => ({ loc: `${SITE}${p}`, lastmod: null })));
    } else {
      const [rows, deleted] = await Promise.all([listRows(supabase, MAX_SITEMAP_ROWS), deletedTargets(supabase)]);
      if (!rows || !deleted) return unavailable();
      const parts = sitemapParts(sitemapEntries(rows, deleted));
      if (which === null) {
        path = "/sitemap.xml";
        body = renderSitemapIndex(parts);
      } else {
        const part = parts[which - 1];
        if (!part) return res.status(404).send("Not found");
        path = `/sitemaps/servers-${which}.xml`;
        body = renderUrlset(part);
      }
    }
  } else if (kind === "index" || kind === "home") {
    if (!supabase) return unavailable();
    const statusP = kind === "home" ? latestStatus() : Promise.resolve(null);
    const rows = await listRows(supabase);
    if (!rows) return unavailable();
    // 첫 주소로 들어온 방문은 utm_source(예: chatgpt.com)까지 남긴다 — AI 답변에서 클릭해 온 방문을 셀 수 있게
    const utm = typeof req.query.utm_source === "string" && /^[A-Za-z0-9._-]{1,64}$/.test(req.query.utm_source) ? req.query.utm_source : null;
    path = kind === "index" ? "/servers" : `/${utm ? `?utm_source=${utm}` : ""}`;
    body = renderIndex(rows, { home: kind === "home", statusHtml: renderStatus(await statusP) });
  } else {
    return res.status(404).send("Not found");
  }

  // 방문 기록 (실패해도 페이지는 내려준다)
  try {
    if (supabase) {
      const { error } = await supabase.from("discovery_hits").insert({ path, method: req.method, user_agent: ua, referer: header(req, "referer", 300) } as never);
      if (error) console.error("discovery_hits insert failed", error.message);
    }
  } catch (err) {
    console.error("discovery_hits insert failed", err);
  }

  res.setHeader("Content-Type", type);
  res.setHeader("Link", BULK_DATA_LINK);
  // CDN 캐시 (2026-10-30): 수집기 반복 방문은 6시간 캐시로 받는다 → 캐시 적중은 함수·방문 기록에 안 잡힘(첫 방문만 기록).
  // 실사용·검색 봇(Claude-User 등)은 vercel.json rewrite 가 nc=1 을 붙여 보낸다 → 캐시하지 않고 매번 기록.
  // 홈은 상황판이 들어 있어 다음 매시 57분까지만 캐시한다(status.json·llms.txt 와 같은 시각에 바뀜, 2026-11-05).
  // /agents 는 스냅샷(매시 54분) 뒤 59분까지(agents.json 과 같은 시각).
  const sMaxAge = kind === "home" ? `s-maxage=${statusCacheSeconds()}, stale-while-revalidate=300`
    : kind === "agents" || kind === "agent" ? `s-maxage=${agentsCacheSeconds()}, stale-while-revalidate=300`
    : "s-maxage=21600, stale-while-revalidate=86400";
  res.setHeader("Cache-Control", req.query.nc === "1" ? "no-store" : `public, max-age=0, ${sMaxAge}`);
  return res.status(status).send(req.method === "HEAD" ? "" : body);
}
