import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";

// 서버별 README 배지 (2026-11-24, 1차) — /servers/{ns}/{name}/badge.svg, /servers/{ns}/{name}/badge.json
// 뜻: "Lowdown 이 이 서버를 기록하고 있다"와 마지막 관측일. 판정·점수·인증이 아니다(safe·trusted·certified 같은 단어 금지).
// 상태 3가지: observed(최근 관측, 파랑) / last seen(관측이 오래됨, 회색) / not observed(기록 없음, 연회색).
//   stale 판정은 카드의 status.stale 을 그대로 쓴다(서버 페이지와 같은 기준: 매일 2일, 순환 4일).
// 원천: server_cards.body 하나(요청당 쿼리 1개). feed.ts 와 같은 캐시(CDN 6시간).
// 없는 서버·틀린 이름도 200 + not observed — 남의 README 에서 이미지가 깨지지 않게.
// 클릭 링크는 운영자가 붙이는 Markdown 쪽(서버 페이지 ?ref=badge). 요청 수는 middleware 가 edge_hits 에 남긴다.
// API 파일끼리 import 하지 않는 규칙에 따라 이 파일은 혼자 완결된다. 순수 함수는 scanner/badge.test.ts 에서 시험.

export const BADGE_SITE = "https://lowdown.art2meta.com";
const NAME_RE = /^[A-Za-z0-9._~-]{1,200}\/[A-Za-z0-9._~-]{1,200}$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

type J = Record<string, any>;

export type BadgeState = "observed" | "stale" | "not_observed";

export type Badge = {
  state: BadgeState;
  day: string | null; // 마지막 관측일 YYYY-MM-DD
  label: string;
  message: string;
  color: string; // 오른쪽 칸 배경
  textColor: string; // 오른쪽 칸 글자
};

const LABEL = "Lowdown";
const LABEL_BG = "#555555";
const COLORS: Record<BadgeState, { bg: string; fg: string }> = {
  observed: { bg: "#185FA5", fg: "#FFFFFF" },
  stale: { bg: "#888780", fg: "#FFFFFF" },
  not_observed: { bg: "#B4B2A9", fg: "#2C2C2A" },
};

function getSupabase() {
  const url = process.env.LOWDOWN_SUPABASE_URL;
  const key = process.env.LOWDOWN_SUPABASE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

const dayOf = (v: unknown): string | null => {
  const s = typeof v === "string" ? v.slice(0, 10) : null;
  return s && DAY_RE.test(s) ? s : null;
};

/** 카드 → 배지. 카드가 없거나 마지막 관측일이 없으면 not observed. */
export function badgeFor(card: J | null): Badge {
  const st = card && typeof card === "object" ? card.status : null;
  const latest = st && typeof st === "object" && typeof st.state === "string" ? dayOf(st.latest_check) : null;
  let state: BadgeState;
  if (!latest) state = "not_observed";
  else if (st.stale === true) state = "stale";
  else state = "observed";
  const mmdd = latest ? latest.slice(5) : "";
  const message = state === "observed" ? `observed · ${mmdd}` : state === "stale" ? `last seen · ${mmdd}` : "not observed";
  return { state, day: latest, label: LABEL, message, color: COLORS[state].bg, textColor: COLORS[state].fg };
}

// Verdana 11px 대략 글자 폭(px). shields.io 처럼 정확히 잴 필요는 없고, 글자가 칸을 넘지 않을 만큼만.
function charWidth(c: string): number {
  if (" .,:;·|!'ijl".includes(c)) return 3.9;
  if ("-()[]frt".includes(c)) return 4.6;
  if ("mwMW".includes(c)) return 10.2;
  if (/[A-Z]/.test(c)) return 7.6;
  if (/[0-9]/.test(c)) return 7.0;
  return 6.7;
}
export function textWidth(s: string): number {
  let w = 0;
  for (const c of s) w += charWidth(c);
  return Math.ceil(w);
}

const xmlEscape = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

// 단순화 로고(2026-11-24 B안): 반원 점 5개 + 큰 점 1개. 어두운 왼쪽 칸 위라 밝은 색.
const LOGO =
  `<g fill="#B5D4F4"><circle cx="11" cy="4.6" r="1.3"/><circle cx="7.6" cy="6" r="1.4"/><circle cx="5.8" cy="10" r="1.5"/>` +
  `<circle cx="7.6" cy="14" r="1.4"/><circle cx="11" cy="15.4" r="1.3"/></g><circle cx="15.2" cy="10" r="2.2" fill="#FFFFFF"/>`;
const LOGO_W = 21; // 로고가 차지하는 왼쪽 폭

export function renderSvg(b: Badge): string {
  const leftW = LOGO_W + textWidth(b.label) + 6;
  const rightW = textWidth(b.message) + 14;
  const w = leftW + rightW;
  const title = b.day ? `${b.label}: ${b.message.replace(/ · \d{2}-\d{2}$/, "")} ${b.day}` : `${b.label}: ${b.message}`;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="20" viewBox="0 0 ${w} 20" role="img" aria-label="${xmlEscape(title)}">`,
    `<title>${xmlEscape(title)}</title>`,
    `<clipPath id="r"><rect width="${w}" height="20" rx="3" fill="#FFFFFF"/></clipPath>`,
    `<g clip-path="url(#r)"><rect width="${leftW}" height="20" fill="${LABEL_BG}"/><rect x="${leftW}" width="${rightW}" height="20" fill="${b.color}"/></g>`,
    LOGO,
    `<g font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11">`,
    `<text x="${LOGO_W}" y="14" fill="#FFFFFF">${xmlEscape(b.label)}</text>`,
    `<text x="${leftW + 7}" y="14" fill="${b.textColor}">${xmlEscape(b.message)}</text>`,
    `</g></svg>`,
  ].join("") + "\n";
}

/** shields.io endpoint 형식(https://shields.io/badges/endpoint-badge). 스키마 밖 키는 넣지 않는다. */
export function badgeJson(b: Badge): Record<string, unknown> {
  return {
    schemaVersion: 1,
    label: b.label,
    message: b.message,
    color: b.color.slice(1),
    labelColor: LABEL_BG.slice(1),
    cacheSeconds: 21600,
  };
}

/** 운영자가 README 에 붙이는 한 줄. 클릭은 서버 페이지(?ref=badge 로 유입 구분). */
export function badgeMarkdown(name: string): string {
  const page = `${BADGE_SITE}/servers/${name}`;
  return `[![Lowdown](${page}/badge.svg)](${page}?ref=badge)`;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET" && req.method !== "HEAD") return res.status(405).send("Method not allowed");
  const ns = typeof req.query.ns === "string" ? req.query.ns : "";
  const nm = typeof req.query.name === "string" ? req.query.name : "";
  const format = req.query.format === "json" ? "json" : "svg";
  const name = `${ns}/${nm}`;

  const send = (b: Badge, cache: string, status = 200) => {
    res.setHeader("Cache-Control", cache);
    if (format === "json") {
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.setHeader("Access-Control-Allow-Origin", "*");
      return res.status(status).send(req.method === "HEAD" ? "" : JSON.stringify(badgeJson(b)));
    }
    res.setHeader("Content-Type", "image/svg+xml; charset=utf-8");
    return res.status(status).send(req.method === "HEAD" ? "" : renderSvg(b));
  };
  // 서버 페이지·피드와 같은 캐시: 6시간 CDN. 브라우저·GitHub 이미지 프록시는 매번 확인(max-age=0).
  const CACHE = "public, max-age=0, s-maxage=21600, stale-while-revalidate=86400";

  if (!NAME_RE.test(name)) return send(badgeFor(null), CACHE);

  const supabase = getSupabase();
  // DB 를 못 읽을 때 "not observed"로 답하면 사실과 다르다 → 503, 캐시 안 함
  const unavailable = () => {
    res.setHeader("Retry-After", "120");
    return send({ ...badgeFor(null), message: "unavailable" }, "no-store", 503);
  };
  if (!supabase) return unavailable();
  const r = await supabase.from("server_cards").select("body").eq("target_id", `mcp:${name}`).limit(1);
  if (r.error) return unavailable();
  const row = (r.data ?? [])[0] as { body: unknown } | undefined;
  if (!row) return send(badgeFor(null), CACHE);
  let card: J | null = null;
  try {
    card = typeof row.body === "string" ? JSON.parse(row.body) : (row.body as J);
  } catch {
    return unavailable();
  }
  return send(badgeFor(card && typeof card === "object" ? card : null), CACHE);
}
