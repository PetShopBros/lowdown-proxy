import { next, type RequestContext } from "@vercel/functions";

// 캐시 앞에서 모든 요청을 센다 (2026-10-30, supabase/2026-10-30_edge_hits.sql).
// 배경: api/* 응답을 CDN 캐시(6시간)로 받으면 캐시 적중은 함수가 돌지 않아 discovery_hits·reputation_lookups 에 안 남는다.
//   Routing Middleware 는 CDN 캐시 전에 매 요청 실행되므로 여기서 경로·User-Agent 를 1줄씩 edge_hits 에 남겨 수집기 건수 추이를 잇는다.
// 기록은 waitUntil 로 응답 뒤에 쓴다(응답을 늦추지 않음). 실패해도 요청은 그대로 통과한다. IP 는 저장하지 않는다.
// 서버 페이지(api/page.ts)가 안에서 부르는 API 호출(ref=page)은 세지 않는다 → 방문 1건이 2건으로 잡히지 않게.
// 봇 분류(bot_kind·bot_name)는 DB 트리거가 classify_user_agent() 로 붙인다.

export const config = {
  matcher: [
    "/",
    "/servers",
    "/servers/:path*",
    "/sitemap.xml",
    "/llms.txt",
    "/openapi.json",
    "/menu.json",
    "/robots.txt",
    "/api/reputation/:path*",
  ],
};

export default function middleware(request: Request, context: RequestContext) {
  const url = new URL(request.url);
  if (url.searchParams.get("ref") !== "page") {
    const base = process.env.LOWDOWN_SUPABASE_URL;
    const key = process.env.LOWDOWN_SUPABASE_KEY;
    if (base && key) {
      context.waitUntil(
        fetch(`${base}/rest/v1/edge_hits`, {
          method: "POST",
          headers: {
            apikey: key,
            Authorization: `Bearer ${key}`,
            "Content-Type": "application/json",
            Prefer: "return=minimal",
          },
          body: JSON.stringify({
            path: (url.pathname + url.search).slice(0, 500),
            method: request.method,
            user_agent: request.headers.get("user-agent")?.slice(0, 300) ?? null,
            referer: request.headers.get("referer")?.slice(0, 300) ?? null,
          }),
          signal: AbortSignal.timeout(3000),
        })
          .then((r) => {
            if (!r.ok) console.error("edge_hits insert failed", r.status);
          })
          .catch((err) => console.error("edge_hits insert failed", err)),
      );
    }
  }
  return next();
}
