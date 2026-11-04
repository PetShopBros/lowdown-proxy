import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";

// /llms.txt, /openapi.json, /robots.txt, /menu.json 을 내려주면서 방문을 기록한다 (vercel.json rewrites → /api/discovery?file=...).
// 목적: AI 크롤러·에이전트가 발견용 파일을 읽었는지 이름(user_agent)까지 남기기. IP 는 저장하지 않는다.
// 기록이 실패해도 파일은 항상 내려준다.

const FILES: Record<string, string> = {
  "llms.txt": "text/plain; charset=utf-8",
  "openapi.json": "application/json; charset=utf-8",
  "robots.txt": "text/plain; charset=utf-8",
  "menu.json": "application/json; charset=utf-8", // 메뉴판 (api/reputation/[target].ts 의 menuCard() 와 같아야 한다)
};

// 대량 사용 안내 (2026-10-30): api/reputation/[target].ts 의 BULK_DATA_LINK 와 같아야 한다.
const BULK_DATA_LINK = '<https://github.com/PetShopBros/lowdown-data>; rel="related"; title="Daily dataset for bulk use (CC BY 4.0)"';

// ── 상황판 요약 (2026-11-05): llms.txt 첫 설명 문단 뒤에 최신 스냅샷 요약을 끼운다 ──
// api/status.ts 의 latestStatus·statusCacheSeconds 와 같은 내용(API 파일끼리 import 하지 않는 규칙). 바꿀 때 status.ts·page.ts 도 같이.
const STATUS_REFRESH_MINUTE = 57;
const STALE_AFTER_MS = 2 * 3_600_000;
export function statusCacheSeconds(now = Date.now()): number {
  const d = new Date(now);
  const next = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), STATUS_REFRESH_MINUTE, 0));
  if (next.getTime() <= now) next.setUTCHours(next.getUTCHours() + 1);
  return Math.min(3600, Math.max(60, Math.ceil((next.getTime() - now) / 1000)));
}
type StatusSnapshot = { id: number; generated_at: string; data: Record<string, any> };
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
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/** llms.txt 에 넣을 상황판 블록 (Markdown). 스냅샷이 없으면 빈 문자열. */
export function statusBlock(s: StatusSnapshot | null, now = Date.now()): string {
  if (!s) return "";
  const d = s.data;
  const age = now - Date.parse(s.generated_at);
  const stale = !(age >= 0 && age <= STALE_AFTER_MS);
  const lines = strs(d.summary_lines).map((l) => `- ${l}`);
  const hl = (Array.isArray(d.highlights) ? d.highlights : []).map((h: any) => (typeof h?.text === "string" ? `- ${h.text}` : null)).filter(Boolean);
  return (
    `## Status (updated hourly)\n\n` +
    `Snapshot ${d.snapshot_id ?? s.id}, generated ${d.generated_at ?? s.generated_at}` +
    (stale ? " (more than 2 hours old; the hourly update may be delayed)" : "") +
    `. Full data, definitions and limits: [status.json](https://lowdown-proxy.vercel.app/status.json)\n\n` +
    lines.join("\n") + "\n" +
    (hl.length ? `\nHighlights from the last 7 days:\n\n${hl.join("\n")}\n` : "") +
    "\n"
  );
}

/** 첫 설명(제목·인용 문단) 뒤, 첫 '## ' 절 앞에 블록을 넣는다. 자리가 없으면 맨 끝. */
export function insertStatus(llms: string, block: string): string {
  if (!block) return llms;
  const i = llms.indexOf("\n## ");
  return i < 0 ? `${llms.replace(/\s*$/, "")}\n\n${block}` : `${llms.slice(0, i + 1)}${block}${llms.slice(i + 1)}`;
}

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

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET" && req.method !== "HEAD") return res.status(405).json({ error: "Method not allowed" });

  const file = typeof req.query.file === "string" ? req.query.file : "";
  const contentType = FILES[file];
  if (!contentType) return res.status(404).json({ error: "not found" });

  // 정적 원본(public/)을 같은 배포에서 읽는다. /public/... 경로는 rewrite 대상이 아니라 순환하지 않는다.
  const host = header(req, "host", 200) ?? "lowdown-proxy.vercel.app";
  let body: string;
  const statusP = file === "llms.txt" ? latestStatus() : Promise.resolve(null);
  try {
    const r = await fetch(`https://${host}/public/${file}`, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) return res.status(502).json({ error: "upstream" });
    body = await r.text();
  } catch {
    return res.status(502).json({ error: "upstream" });
  }
  // llms.txt: 최신 상황판 요약을 넣는다. 읽지 못하면 원본 그대로.
  if (file === "llms.txt") body = insertStatus(body, statusBlock(await statusP));

  try {
    const supabase = getSupabase();
    if (supabase) {
      // supabase-js 는 실패해도 throw 하지 않고 error 를 돌려준다 → 직접 확인해 로그에 남긴다
      const { error } = await supabase.from("discovery_hits").insert({
        path: `/${file}`,
        method: req.method,
        user_agent: header(req, "user-agent", 300),
        referer: header(req, "referer", 300),
      } as never);
      if (error) console.error("discovery_hits insert failed", error.message);
    }
  } catch (err) {
    console.error("discovery_hits insert failed", err);
  }

  res.setHeader("Content-Type", contentType);
  res.setHeader("Link", BULK_DATA_LINK);
  // CDN 캐시 (2026-10-30): 수집기 반복 방문은 6시간 캐시로 받는다 → 캐시 적중은 함수·기록에 안 잡힘(첫 방문만 기록).
  // 실사용·검색 봇(Claude-User 등)은 vercel.json rewrite 가 nc=1 을 붙여 보낸다 → 캐시하지 않고 매번 기록.
  // llms.txt 는 상황판 요약이 들어 있어 다음 매시 57분까지만 캐시한다(status.json·홈과 같은 시각에 바뀜, 2026-11-05).
  const sMaxAge = file === "llms.txt" ? `s-maxage=${statusCacheSeconds()}, stale-while-revalidate=300` : "s-maxage=21600, stale-while-revalidate=86400";
  res.setHeader("Cache-Control", req.query.nc === "1" ? "no-store" : `public, max-age=0, ${sMaxAge}`);
  if (req.method === "HEAD") return res.status(200).end();
  return res.status(200).send(body);
}
