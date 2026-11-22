import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";

// 서버별 RSS 피드 (2026-11-22, P1) — /servers/{ns}/{name}/feed.xml
// 원천: server_cards.body 하나(요청당 쿼리 1개). 카드는 하루 단위로 다시 만들어지므로 피드도 하루 단위로 바뀐다.
// 항목: 도구 정의 변경(scanner.definition_changes), 응답 상태 변화(scanner.daily_30d 에서 계산),
//       Registry 변화(registry.changes_30d), 패키지 변화(packages[].{npm|pypi}.recent_events).
//       변경이 하나도 없으면 "관측 시작" 항목 1개.
// 원칙: 관측 사실만. 판정·점수 없음. 결제 여부로 기록 차등 없음.
// API 파일끼리 import 하지 않는 규칙에 따라 이 파일은 혼자 완결된다(page.ts 와 같은 방식). 순수 함수는 scanner/feed.test.ts 에서 시험.

const BASE = "https://lowdown-proxy.vercel.app";
const NAME_RE = /^[A-Za-z0-9._~-]{1,200}\/[A-Za-z0-9._~-]{1,200}$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_ITEMS = 50;

type J = Record<string, any>;

export type FeedItem = {
  day: string;
  kind: "definition" | "status" | "registry" | "package" | "start";
  title: string;
  description: string;
  guid: string;
};

function getSupabase() {
  const url = process.env.LOWDOWN_SUPABASE_URL;
  const key = process.env.LOWDOWN_SUPABASE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

// XML 1.0 에서 허용되지 않는 제어 문자는 빼고, 특수 문자는 바꾼다
export function xmlEscape(s: unknown): string {
  return String(s ?? "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// 키 순서와 상관없이 같은 내용이면 같은 문자열
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as J;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(v ?? null);
}

// 같은 서버·종류·날짜에 이벤트가 여러 개여도 겹치지 않고, 다시 만들어도 같은 값
export function guidFor(name: string, kind: string, day: string, event: unknown): string {
  const h = createHash("sha256").update(canonical(event), "utf8").digest("hex").slice(0, 12);
  return `lowdown:${name}:${kind}:${day}:${h}`;
}

const str = (v: unknown, max = 80): string | null => (typeof v === "string" && v.length > 0 ? v.slice(0, max) : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const dayOf = (v: unknown): string | null => {
  const s = typeof v === "string" ? v.slice(0, 10) : null;
  return s && DAY_RE.test(s) ? s : null;
};

function intervalText(card: J): string {
  const d = num(card?.status?.check_interval_days);
  if (d === null) return "";
  return d === 1 ? " Lowdown checks this server daily." : ` Lowdown checks this server every ${d} days.`;
}

const DEF_KIND_TEXT: Record<string, string> = {
  schema_changed: "tool input/output schemas",
  description_changed: "tool descriptions",
  tool_names_changed: "tool names",
};

function definitionItems(name: string, card: J): FeedItem[] {
  const events = card?.scanner?.definition_changes?.events;
  if (!Array.isArray(events)) return [];
  const out: FeedItem[] = [];
  for (const ev of events) {
    const day = dayOf(ev?.day);
    if (!day) continue;
    const kinds: string[] = Array.isArray(ev.kinds) ? ev.kinds.filter((k: unknown) => typeof k === "string") : [];
    const parts = kinds.filter((k) => DEF_KIND_TEXT[k]).map((k) => DEF_KIND_TEXT[k]);
    const sv = ev.server_version && str(ev.server_version.from) && str(ev.server_version.to)
      ? `server version ${str(ev.server_version.from)} → ${str(ev.server_version.to)}` : null;
    const tc = ev.tool_count && num(ev.tool_count.from) !== null && num(ev.tool_count.to) !== null
      ? `tool count ${ev.tool_count.from} → ${ev.tool_count.to}` : null;
    const flags: string[] = Array.isArray(ev.new_flags)
      ? ev.new_flags.map((f: unknown) => (typeof f === "string" ? f : str((f as J)?.flag) ?? str((f as J)?.kind))).filter(Boolean) : [];
    const title = parts.length > 0
      ? `Tool definitions changed: ${parts.join(", ")}`
      : sv ? `Server version changed: ${sv.replace("server version ", "")}` : "Tool definitions changed";
    const facts = [
      parts.length > 0 ? `Changed: ${parts.join(", ")}.` : "",
      sv ? `${sv[0].toUpperCase()}${sv.slice(1)}.` : "",
      tc ? `${tc[0].toUpperCase()}${tc.slice(1)}.` : "",
      flags.length > 0 ? `New content markers: ${flags.join(", ")}.` : "",
      dayOf(ev.compared_with) ? `Compared with the observation of ${dayOf(ev.compared_with)}.` : "",
      ev.returned_to_earlier_definition === true ? "The new definition matches one observed earlier." : "",
    ].filter(Boolean).join(" ");
    out.push({ day, kind: "definition", title, description: `${day}: ${facts}`.trim(), guid: guidFor(name, "definition", day, ev) });
  }
  return out;
}

// 그날 관측의 상태. 재시도에서 더 멀리 간 경우는 재시도 결과를 쓴다.
export function dayState(d: J): string {
  const lvl = Math.max(num(d?.reached_level) ?? 0, num(d?.retry_reached_level) ?? 0);
  if (lvl >= 2) return "responded";
  const http = num(d?.http_status);
  if (http === 401 || http === 403) return "auth_required";
  if (lvl === 1) return "initialize_only";
  if (http !== null) return `http_${http}`;
  return "no_response";
}

const STATE_TEXT = (s: string): string =>
  s === "responded" ? "answered initialize and tools/list"
  : s === "auth_required" ? "required authentication (HTTP 401/403)"
  : s === "initialize_only" ? "answered initialize but not tools/list"
  : s === "no_response" ? "did not respond"
  : s.startsWith("http_") ? `returned HTTP ${s.slice(5)}`
  : s;

// 실제로 관측한 날끼리만 비교한다. 관측이 없는 날은 건너뛴다(빈 날 = 중단이 아님).
function statusItems(name: string, card: J): FeedItem[] {
  const daily = card?.scanner?.daily_30d;
  if (!Array.isArray(daily)) return [];
  const days = daily
    .filter((d: J) => dayOf(d?.day))
    .sort((a: J, b: J) => String(a.day).localeCompare(String(b.day)));
  const out: FeedItem[] = [];
  const every = intervalText(card);
  for (let i = 1; i < days.length; i++) {
    const prev = days[i - 1]!;
    const cur = days[i]!;
    const ps = dayState(prev);
    const cs = dayState(cur);
    if (ps === cs) continue;
    const day = dayOf(cur.day)!;
    const title = cs === "responded" ? "Responding again" : `Check result changed: ${STATE_TEXT(cs)}`;
    const description = `${day}: the server ${STATE_TEXT(cs)}. Previous check (${dayOf(prev.day)}): it ${STATE_TEXT(ps)}.${every} This is the result of a scheduled check, not continuous monitoring.`;
    out.push({ day, kind: "status", title, description, guid: guidFor(name, "status", day, { from: ps, to: cs, prev: prev.day }) });
  }
  return out;
}

function registryItems(name: string, card: J): FeedItem[] {
  const ch = card?.registry?.changes_30d;
  if (!Array.isArray(ch)) return [];
  const out: FeedItem[] = [];
  for (const c of ch) {
    const day = dayOf(c?.on) ?? dayOf(c?.detected_on);
    const kind = str(c?.kind, 40);
    if (!day || !kind) continue;
    const oldV = str(c.old) ?? str(c.old_value);
    const newV = str(c.new) ?? str(c.new_value);
    let title: string;
    if (kind === "new") title = "Listed in the MCP Registry";
    else if (kind === "version" && oldV && newV) title = `Registry version ${oldV} → ${newV}`;
    else if (kind === "packages") title = "Registry package declaration changed";
    else if (kind === "remotes") title = "Registry remote endpoints changed";
    else if (kind === "status" && newV) title = `Registry status: ${newV}`;
    else title = `Registry record changed (${kind})`;
    const extra = oldV && newV && kind !== "version" ? ` ${oldV} → ${newV}.` : "";
    out.push({ day, kind: "registry", title, description: `${day}: ${title}.${extra} Recorded from the official MCP Registry.`, guid: guidFor(name, "registry", day, c) });
  }
  return out;
}

function packageItems(name: string, card: J): FeedItem[] {
  const pk = card?.packages;
  if (!Array.isArray(pk)) return [];
  const out: FeedItem[] = [];
  for (const p of pk) {
    const reg = str(p?.registry, 20);
    const pname = str(p?.name, 200);
    if (!reg || !pname) continue;
    const st = p[reg];
    const evs = st?.recent_events;
    if (!Array.isArray(evs)) continue;
    const label = reg === "npm" ? "npm" : reg === "pypi" ? "PyPI" : reg;
    for (const e of evs) {
      const day = dayOf(e?.on) ?? dayOf(e?.detected_on);
      const kind = str(e?.kind, 40);
      if (!day || !kind) continue;
      const oldV = str(e.old) ?? str(e.old_value);
      const newV = str(e.new) ?? str(e.new_value);
      const title = kind === "latest_changed" && oldV && newV
        ? `${label} ${pname}: latest ${oldV} → ${newV}`
        : `${label} ${pname}: ${kind}${newV ? ` (${newV})` : ""}`;
      out.push({ day, kind: "package", title, description: `${day}: ${title}. Recorded from the ${label} registry.`, guid: guidFor(name, "package", day, { reg, pname, e }) });
    }
  }
  return out;
}

function startItem(name: string, card: J, builtAt: string | null): FeedItem | null {
  const day = dayOf(card?.scanner?.first_observed_at) ?? dayOf(card?.registry?.first_recorded_at) ?? dayOf(builtAt);
  if (!day) return null;
  const description = `${day}: Lowdown started recording this server. No changes were observed in the last 30 days.${intervalText(card)}`;
  return { day, kind: "start", title: "Lowdown started recording this server", description, guid: guidFor(name, "start", day, { name }) };
}

const KIND_ORDER: Record<FeedItem["kind"], number> = { status: 0, definition: 1, registry: 2, package: 3, start: 4 };

export function feedItems(name: string, card: J, builtAt: string | null): FeedItem[] {
  const items = [...statusItems(name, card), ...definitionItems(name, card), ...registryItems(name, card), ...packageItems(name, card)];
  if (items.length === 0) {
    const s = startItem(name, card, builtAt);
    if (s) items.push(s);
  }
  // 최신순, 같은 날은 종류 순서, 그다음 guid 로 고정
  items.sort((a, b) => b.day.localeCompare(a.day) || KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.guid.localeCompare(b.guid));
  return items.slice(0, MAX_ITEMS);
}

export function renderFeed(name: string, card: J, builtAt: string | null): string {
  const page = `${BASE}/servers/${name}`;
  const self = `${page}/feed.xml`;
  const json = `${BASE}/api/reputation/mcp:${name}`;
  const items = feedItems(name, card, builtAt);
  const built = builtAt && !Number.isNaN(Date.parse(builtAt)) ? new Date(builtAt).toUTCString() : null;
  const channelDesc = `Dated facts Lowdown observed about the MCP server ${name}: tool definition changes, check results, MCP Registry and package changes, last 30 days. ` +
    `Facts, not judgments. Rebuilt once a day; this feed may lag by up to 6 hours. Current record (JSON): ${json}`;
  const lines = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">`,
    `<channel>`,
    `<title>${xmlEscape(`${name} — Lowdown observed changes`)}</title>`,
    `<link>${xmlEscape(page)}</link>`,
    `<atom:link href="${xmlEscape(self)}" rel="self" type="application/rss+xml"/>`,
    `<description>${xmlEscape(channelDesc)}</description>`,
    `<language>en</language>`,
    `<ttl>360</ttl>`,
    ...(built ? [`<lastBuildDate>${xmlEscape(built)}</lastBuildDate>`] : []),
    ...items.map((it) => [
      `<item>`,
      `<title>${xmlEscape(it.title)}</title>`,
      `<link>${xmlEscape(page)}</link>`,
      `<guid isPermaLink="false">${xmlEscape(it.guid)}</guid>`,
      `<pubDate>${new Date(`${it.day}T00:00:00Z`).toUTCString()}</pubDate>`,
      `<category>${xmlEscape(it.kind)}</category>`,
      `<description>${xmlEscape(`${it.description} Record: ${json}`)}</description>`,
      `</item>`,
    ].join("")),
    `</channel>`,
    `</rss>`,
  ];
  return lines.join("\n") + "\n";
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET" && req.method !== "HEAD") return res.status(405).send("Method not allowed");
  const ns = typeof req.query.ns === "string" ? req.query.ns : "";
  const nm = typeof req.query.name === "string" ? req.query.name : "";
  const name = `${ns}/${nm}`;
  if (!NAME_RE.test(name)) return res.status(404).send("Not found");

  const unavailable = () => {
    res.setHeader("Retry-After", "120");
    res.setHeader("Cache-Control", "no-store");
    return res.status(503).send("Temporarily unavailable. Retry later.");
  };

  const supabase = getSupabase();
  if (!supabase) return unavailable();
  const r = await supabase.from("server_cards").select("body,built_at").eq("target_id", `mcp:${name}`).limit(1);
  if (r.error) return unavailable();
  const row = (r.data ?? [])[0] as { body: unknown; built_at: string | null } | undefined;
  if (!row) return res.status(404).send("Not found");
  let card: J;
  try {
    card = typeof row.body === "string" ? JSON.parse(row.body) : (row.body as J);
  } catch {
    return unavailable();
  }
  if (!card || typeof card !== "object") return unavailable();

  const body = renderFeed(name, card, row.built_at ?? null);
  res.setHeader("Content-Type", "application/rss+xml; charset=utf-8");
  // 서버 페이지와 같은 캐시: 6시간 CDN, 실사용·검색 봇(nc=1)은 캐시하지 않음
  res.setHeader("Cache-Control", req.query.nc === "1" ? "no-store" : "public, max-age=0, s-maxage=21600, stale-while-revalidate=86400");
  return res.status(200).send(req.method === "HEAD" ? "" : body);
}
