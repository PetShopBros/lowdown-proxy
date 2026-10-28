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
  try {
    const r = await fetch(`https://${host}/public/${file}`, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) return res.status(502).json({ error: "upstream" });
    body = await r.text();
  } catch {
    return res.status(502).json({ error: "upstream" });
  }

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
  // CDN 캐시를 쓰면 함수가 호출되지 않아 기록이 빠진다 → 캐시하지 않음
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "HEAD") return res.status(200).end();
  return res.status(200).send(body);
}
