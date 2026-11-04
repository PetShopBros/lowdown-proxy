import type { VercelRequest, VercelResponse } from "@vercel/node";

// /status.json: Lowdown Public Status v1 (2026-11-05, supabase/2026-11-05_status.sql). vercel.json rewrite → /api/status
// 매시 52분 pg_cron 이 만든 가장 최근 스냅샷 1줄을 그대로 내보낸다. 여기서는 다시 집계하지 않는다.
// /llms.txt(api/discovery.ts)·홈(api/page.ts)도 같은 스냅샷을 읽는다. 다른 API 파일을 import 하지 않는 규칙 때문에
//   스냅샷 읽기·캐시 시간 계산은 세 파일에 같은 내용으로 둔다(바꿀 때 셋 다).
// 캐시: 다음 매시 57분(스냅샷 52분 + 5분)까지 → 세 위치가 같은 시각에 함께 새 스냅샷으로 바뀐다.
// stale: 스냅샷이 2시간 넘게 오래되면 true (집계가 멈췄다는 표시. 숫자는 마지막 정상 스냅샷 그대로).

export const STATUS_REFRESH_MINUTE = 57; // cron '52 * * * *' + 5분
export const STALE_AFTER_MS = 2 * 3_600_000;

/** 다음 매시 57분(UTC)까지 남은 초. 60~3600 사이. */
export function statusCacheSeconds(now = Date.now()): number {
  const d = new Date(now);
  const next = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), STATUS_REFRESH_MINUTE, 0));
  if (next.getTime() <= now) next.setUTCHours(next.getUTCHours() + 1);
  return Math.min(3600, Math.max(60, Math.ceil((next.getTime() - now) / 1000)));
}

export type StatusSnapshot = { id: number; generated_at: string; data: Record<string, any> };

/** 가장 최근 스냅샷. 읽지 못하면 null (호출하는 쪽은 상황판 없이 계속). */
export async function latestStatus(): Promise<StatusSnapshot | null> {
  const base = process.env.LOWDOWN_SUPABASE_URL;
  const key = process.env.LOWDOWN_SUPABASE_KEY;
  if (!base || !key) return null;
  try {
    const r = await fetch(`${base}/rest/v1/status_snapshots?select=id,generated_at,data&order=hour_bucket.desc&limit=1`, {
      headers: { apikey: key, Authorization: `Bearer ${key}`, accept: "application/json" },
      signal: AbortSignal.timeout(4000),
    });
    if (!r.ok) return null;
    const rows = (await r.json()) as StatusSnapshot[];
    const row = rows[0];
    return row && typeof row.data === "object" && row.data !== null ? row : null;
  } catch {
    return null;
  }
}

export function withStale(s: StatusSnapshot, now = Date.now()): Record<string, any> {
  const age = now - Date.parse(s.generated_at);
  return { ...s.data, snapshot_id: s.data.snapshot_id ?? s.id, stale: !(age >= 0 && age <= STALE_AFTER_MS) };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET" && req.method !== "HEAD") return res.status(405).json({ error: "Method not allowed" });
  const s = await latestStatus();
  if (!s) {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Retry-After", "120");
    return res.status(503).json({ error: "Status is temporarily unavailable. Retry later." });
  }
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", `public, max-age=0, s-maxage=${statusCacheSeconds()}, stale-while-revalidate=300`);
  if (req.method === "HEAD") return res.status(200).end();
  return res.status(200).send(JSON.stringify(withStale(s), null, 2));
}
