import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";

// POST /api/feedback — Lowdown 응답이 쓸모 있었는지 남기는 창구 (에이전트·사람 모두).
//   정해진 선택지(useful, missing) + 200자 이하 자유 입력(note). note 는 외부 문자열이라 저장만 하고 어디에도 다시 내보내지 않는다.
//   GET 은 받는 형식을 알려 준다. 하루 상한(FEEDBACK_DAILY_CAP)을 넘으면 429. IP 는 저장하지 않는다.
//   메뉴 이름·선택지는 api/reputation/[target].ts 의 메뉴와 같아야 한다(scanner/menu.test.ts 가 확인).
//   API 함수 파일끼리는 import 하지 않는다 → 목록을 이 파일에 둔다.

export const MENU_NAMES = [
  "status", "packages", "tools", "declared-vs-observed", "content-flags", "tool-list", "registry", "history", "agent-reports",
  "install-check", "change-watch", "full",
  "stdio", "radar", "watch", "bulk-history",
] as const;
export const FEEDBACK_DAILY_CAP = 1000;

// ── 피드백 (POST /api/feedback) — 정해진 선택지 + 짧은 자유 입력. 자유 입력은 저장만, 다시 내보내지 않는다 ──
export const FEEDBACK_USEFUL = ["yes", "no", "partly"] as const;
export const FEEDBACK_MISSING = ["stdio_results", "risk_facts", "longer_history", "more_servers", "alerts", "faster_response", "other"] as const;
export const FEEDBACK_NOTE_MAX = 200;

export type FeedbackParse =
  | { ok: true; row: { target: string | null; menu: string | null; useful: string; missing: string[]; note: string | null } }
  | { ok: false; error: string };

export function parseFeedback(body: unknown): FeedbackParse {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, error: "body must be a JSON object" };
  const b = body as Record<string, unknown>;
  const useful = b.useful;
  if (typeof useful !== "string" || !(FEEDBACK_USEFUL as readonly string[]).includes(useful)) return { ok: false, error: `useful must be one of ${FEEDBACK_USEFUL.join(", ")}` };
  let target: string | null = null;
  if (b.target !== undefined && b.target !== null) {
    if (typeof b.target !== "string" || !/^[A-Za-z0-9@._~:\/+-]{1,300}$/.test(b.target)) return { ok: false, error: "target is not a valid identifier" };
    target = b.target;
  }
  let menu: string | null = null;
  if (b.menu !== undefined && b.menu !== null) {
    if (typeof b.menu !== "string" || !(MENU_NAMES as readonly string[]).includes(b.menu)) return { ok: false, error: "menu is not a menu name" };
    menu = b.menu;
  }
  let missing: string[] = [];
  if (b.missing !== undefined && b.missing !== null) {
    if (!Array.isArray(b.missing) || b.missing.length > FEEDBACK_MISSING.length) return { ok: false, error: "missing must be a list" };
    for (const m of b.missing) if (typeof m !== "string" || !(FEEDBACK_MISSING as readonly string[]).includes(m)) return { ok: false, error: `missing items must be from ${FEEDBACK_MISSING.join(", ")}` };
    missing = [...new Set(b.missing as string[])].sort();
  }
  let note: string | null = null;
  if (b.note !== undefined && b.note !== null) {
    if (typeof b.note !== "string") return { ok: false, error: "note must be text" };
    // 제어 문자 제거, 길이 제한. 저장만 하고 어디에도 다시 내보내지 않는다.
    const clean = b.note.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
    if (clean.length > FEEDBACK_NOTE_MAX) return { ok: false, error: `note is longer than ${FEEDBACK_NOTE_MAX} characters` };
    note = clean.length > 0 ? clean : null;
  }
  return { ok: true, row: { target, menu, useful, missing, note } };
}

export const FEEDBACK_FORMAT = {
  method: "POST",
  content_type: "application/json",
  body: {
    useful: `required: ${FEEDBACK_USEFUL.join(" | ")}`,
    target: "optional: the target you looked up, e.g. mcp:{namespace}/{name}",
    menu: "optional: the menu you used",
    missing: `optional list: ${FEEDBACK_MISSING.join(", ")}`,
    note: `optional text, up to ${FEEDBACK_NOTE_MAX} characters (stored, never shown back)`,
  },
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
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method === "GET") return res.status(200).json(FEEDBACK_FORMAT);
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  let body: unknown = req.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      return res.status(400).json({ error: "body must be JSON", format: FEEDBACK_FORMAT });
    }
  }
  const parsed = parseFeedback(body);
  if (!parsed.ok) return res.status(400).json({ error: parsed.error, format: FEEDBACK_FORMAT });

  const supabase = getSupabase();
  if (!supabase) return res.status(503).json({ error: "unavailable" });
  try {
    const since = new Date();
    since.setUTCHours(0, 0, 0, 0);
    const { count, error: countError } = await supabase.from("lowdown_feedback").select("id", { count: "exact", head: true }).gte("created_at", since.toISOString());
    if (countError) return res.status(503).json({ error: "unavailable" });
    if ((count ?? 0) >= FEEDBACK_DAILY_CAP) {
      res.setHeader("Retry-After", "3600");
      return res.status(429).json({ error: "daily limit reached" });
    }
    const { error } = await supabase.from("lowdown_feedback").insert({ ...parsed.row, user_agent: header(req, "user-agent", 300) } as never);
    if (error) return res.status(503).json({ error: "unavailable" });
    return res.status(201).json({ ok: true });
  } catch (err) {
    console.error(err);
    return res.status(503).json({ error: "unavailable" });
  }
}
