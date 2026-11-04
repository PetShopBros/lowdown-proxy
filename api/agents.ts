import type { VercelRequest, VercelResponse } from "@vercel/node";

// /agents.json: Agent Observatory (2026-11-05, supabase/2026-11-05_agents.sql). vercel.json rewrite → /api/agents
// 매시 54분 pg_cron 이 만든 가장 최근 스냅샷 1줄을 그대로 내보낸다. 다시 집계하지 않는다.
// /agents, /agents/{kind}/{slug}(api/page.ts)도 같은 스냅샷을 읽는다. 스냅샷 읽기·캐시 계산은 page.ts 와 같은 내용(파일끼리 import 하지 않는 규칙).
// 캐시: 다음 매시 59분(스냅샷 54분 + 5분)까지. stale: 스냅샷이 2시간 넘게 오래되면 true.

export const AGENTS_REFRESH_MINUTE = 59;
const STALE_AFTER_MS = 2 * 3_600_000;
const UNAVAILABLE_RETRY_SECONDS = 120;

export function agentsCacheSeconds(now = Date.now()): number {
  const d = new Date(now);
  const next = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), AGENTS_REFRESH_MINUTE, 0));
  if (next.getTime() <= now) next.setUTCHours(next.getUTCHours() + 1);
  return Math.min(3600, Math.max(60, Math.ceil((next.getTime() - now) / 1000)));
}

export type AgentSnapshot = { id: number; generated_at: string; data: Record<string, any> };

export async function latestAgents(): Promise<AgentSnapshot | null> {
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

export function withStale(s: AgentSnapshot, now = Date.now()): Record<string, any> {
  const age = now - Date.parse(s.generated_at);
  return { ...s.data, snapshot_id: s.data.snapshot_id ?? s.id, stale: !(age >= 0 && age <= STALE_AFTER_MS) };
}

// 응답 스키마 v1: api/reputation/[target].ts 의 apiError 와 같은 내용
function apiError(code: string, message: string, extra: Record<string, unknown> = {}, retryAfterSeconds?: number): Record<string, unknown> {
  return { error: code, message, retryable: retryAfterSeconds !== undefined, ...(retryAfterSeconds !== undefined ? { retry_after_seconds: retryAfterSeconds } : {}), ...extra };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.setHeader("Allow", "GET, HEAD, OPTIONS");
    return res.status(405).json(apiError("method_not_allowed", "Method not allowed"));
  }
  const s = await latestAgents();
  if (!s) {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Retry-After", String(UNAVAILABLE_RETRY_SECONDS));
    return res.status(503).json(apiError("temporarily_unavailable", "Agent Observatory is temporarily unavailable. Retry later.", {}, UNAVAILABLE_RETRY_SECONDS));
  }
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", `public, max-age=0, s-maxage=${agentsCacheSeconds()}, stale-while-revalidate=300`);
  if (req.method === "HEAD") return res.status(200).end();
  return res.status(200).send(JSON.stringify(withStale(s), null, 2));
}
