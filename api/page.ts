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
footer{margin-top:2.5em;border-top:1px solid var(--line);padding-top:1em}`;

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

export function renderIndex(rows: ListRow[], opts: { home?: boolean } = {}): string {
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
          `<h2>Observed servers</h2>`
        : `<h1>MCP servers observed by Lowdown</h1>`) +
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

async function listRows(supabase: any): Promise<ListRow[] | null> {
  const out: ListRow[] = [];
  for (let from = 0; from < MAX_LIST; from += 1000) {
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
      r = await fetch(`https://${host}/api/reputation/mcp:${name}?ref=page`, {
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
  } else if (kind === "index" || kind === "home" || kind === "sitemap") {
    if (!supabase) return unavailable();
    const rows = await listRows(supabase);
    if (!rows) return unavailable();
    // 첫 주소로 들어온 방문은 utm_source(예: chatgpt.com)까지 남긴다 — AI 답변에서 클릭해 온 방문을 셀 수 있게
    const utm = typeof req.query.utm_source === "string" && /^[A-Za-z0-9._-]{1,64}$/.test(req.query.utm_source) ? req.query.utm_source : null;
    path = kind === "index" ? "/servers" : kind === "home" ? `/${utm ? `?utm_source=${utm}` : ""}` : "/sitemap.xml";
    if (kind === "index" || kind === "home") body = renderIndex(rows, { home: kind === "home" });
    else {
      body = renderSitemap(rows);
      type = "application/xml; charset=utf-8";
    }
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
  // CDN 캐시를 쓰면 함수가 호출되지 않아 방문 기록이 빠진다 → 캐시하지 않음
  res.setHeader("Cache-Control", "no-store");
  return res.status(status).send(req.method === "HEAD" ? "" : body);
}
