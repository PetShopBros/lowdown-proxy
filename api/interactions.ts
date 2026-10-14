import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";

function getSupabase() {
  const url = process.env.LOWDOWN_SUPABASE_URL;
  const key = process.env.LOWDOWN_SUPABASE_KEY;
  if (!url || !key) throw new Error("Supabase env missing");
  return createClient(url, key, { auth: { persistSession: false } });
}

// 공개 기록 경로(0.1.17~): 프록시와 record_interaction 은 DB 키 없이 이 API 로 기록한다.
// 스팸 대책: 값 검증 + 같은 node_id(없으면 actor)당 분당 RATE_LIMIT 건.
export const RATE_LIMIT_PER_MIN = 120;

const TARGET_TYPES = ["agent", "tool", "service", "human"];
const OUTCOMES = ["success", "partial", "failure"];
const SOURCES = ["organic", "seeded", "synthetic"];
const FAILURE_TYPES = ["invalid_arguments", "protocol_error", "timeout", "server_error", "tool_error", "unknown"];
const REQUEST_KINDS = ["tool_call", "protocol", "reported"];
const ERROR_LAYERS = ["request", "server", "tool"];

type Body = Record<string, unknown>;

const isText = (v: unknown, max: number) => typeof v === "string" && v.trim().length > 0 && v.length <= max;
const optText = (v: unknown, max: number) => v === undefined || v === null || isText(v, max);

/** 검증 통과 시 insert 할 행, 실패 시 오류 메시지. */
export function validateInteraction(body: Body): { row: Record<string, unknown> } | { error: string } {
  const { actor, target, target_type, task_type, outcome } = body;
  if (!actor || !target || !target_type || !task_type || !outcome) {
    return { error: "actor, target, target_type, task_type, outcome required" };
  }
  if (!isText(actor, 200) || !isText(target, 200) || !isText(task_type, 200)) {
    return { error: "actor, target, task_type must be non-empty strings of at most 200 characters" };
  }
  if (!TARGET_TYPES.includes(target_type as string)) return { error: "invalid target_type" };
  if (!OUTCOMES.includes(outcome as string)) return { error: "invalid outcome" };

  const source = body.source ?? "organic";
  if (!SOURCES.includes(source as string)) return { error: "invalid source" };

  const failure_type = body.failure_type ?? null;
  if (failure_type !== null && !FAILURE_TYPES.includes(failure_type as string)) return { error: "invalid failure_type" };

  const request_kind = body.request_kind ?? "reported";
  if (!REQUEST_KINDS.includes(request_kind as string)) return { error: "invalid request_kind" };

  const error_layer = body.error_layer ?? null;
  if (error_layer !== null && !ERROR_LAYERS.includes(error_layer as string)) return { error: "invalid error_layer" };
  if (error_layer !== null && outcome === "success") return { error: "error_layer requires a non-success outcome" };

  const latency_ms = body.latency_ms ?? null;
  if (latency_ms !== null && !(Number.isInteger(latency_ms) && (latency_ms as number) >= 0 && (latency_ms as number) <= 3_600_000)) {
    return { error: "latency_ms must be an integer between 0 and 3600000" };
  }

  const node_id = body.node_id ?? null;
  if (node_id !== null && !(typeof node_id === "string" && /^ld_[0-9a-f]{12}$/.test(node_id))) {
    return { error: "invalid node_id" };
  }

  const schema_hash = body.schema_hash ?? null;
  if (schema_hash !== null && !(typeof schema_hash === "string" && /^[0-9a-f]{8,64}$/.test(schema_hash))) {
    return { error: "invalid schema_hash" };
  }
  if (!optText(body.server_version, 100)) return { error: "server_version must be at most 100 characters" };
  if (!optText(body.recorder_version, 32)) return { error: "recorder_version must be at most 32 characters" };

  return {
    row: {
      actor,
      target,
      target_type,
      task_type,
      outcome,
      failure_type,
      latency_ms,
      source,
      node_id,
      request_kind,
      error_layer,
      server_version: body.server_version ?? null,
      schema_hash,
      recorder_version: body.recorder_version ?? null,
    },
  };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();

  if (req.method === "GET") {
    const { actor, task_type, limit = "100" } = req.query as Record<string, string>;
    if (!actor) return res.status(400).json({ error: "actor required" });
    const n = Math.min(Math.max(Number.parseInt(limit, 10) || 100, 1), 500);
    const supabase = getSupabase();
    let query = supabase
      .from("interactions")
      .select("*")
      .eq("actor", actor)
      .order("created_at", { ascending: false })
      .limit(n);
    if (task_type) query = query.eq("task_type", task_type);
    const { data, error } = await query;
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ ok: true, data });
  }

  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const body = (req.body ?? {}) as Body;
  if (typeof body !== "object" || Array.isArray(body)) return res.status(400).json({ error: "JSON object body required" });
  const v = validateInteraction(body);
  if ("error" in v) return res.status(400).json({ error: v.error });

  try {
    const supabase = getSupabase();

    // 분당 한도: node_id 가 있으면 node_id, 없으면 actor 기준
    const since = new Date(Date.now() - 60_000).toISOString();
    const key = v.row.node_id ? ["node_id", v.row.node_id] : ["actor", v.row.actor];
    const { count, error: countError } = await supabase
      .from("interactions")
      .select("id", { count: "exact", head: true })
      .eq(key[0] as string, key[1] as string)
      .gte("created_at", since);
    if (!countError && (count ?? 0) >= RATE_LIMIT_PER_MIN) {
      res.setHeader("Retry-After", "60");
      return res.status(429).json({ error: `rate limit: at most ${RATE_LIMIT_PER_MIN} records per minute` });
    }

    const { error } = await supabase.from("interactions").insert(v.row as never);
    if (error) return res.status(500).json({ error: error.message });

    return res.status(201).json({ ok: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Internal server error" });
  }
}
