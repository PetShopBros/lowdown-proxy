import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";

function getSupabase() {
  const url = process.env.LOWDOWN_SUPABASE_URL;
  const key = process.env.LOWDOWN_SUPABASE_KEY;
  if (!url || !key) throw new Error("Supabase env missing");
  return createClient(url, key, { auth: { persistSession: false } });
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { actor, target, target_type, task_type, outcome, failure_type, latency_ms, source } = req.body ?? {};

  if (!actor || !target || !target_type || !task_type || !outcome) {
    return res.status(400).json({ error: "actor, target, target_type, task_type, outcome required" });
  }

  const validTargetTypes = ["agent", "tool", "service", "human"];
  const validOutcomes = ["success", "partial", "failure"];
  const validSources = ["organic", "seeded", "synthetic"];

  if (!validTargetTypes.includes(target_type)) return res.status(400).json({ error: "invalid target_type" });
  if (!validOutcomes.includes(outcome)) return res.status(400).json({ error: "invalid outcome" });
  if (source && !validSources.includes(source)) return res.status(400).json({ error: "invalid source" });

  const validFailureTypes = ["invalid_arguments", "timeout", "server_error", "tool_error", "unknown"];
  if (failure_type && !validFailureTypes.includes(failure_type)) return res.status(400).json({ error: "invalid failure_type" });

  try {
    const supabase = getSupabase();
    const { error } = await supabase.from("interactions").insert({
      actor,
      target,
      target_type,
      task_type,
      outcome,
      failure_type: failure_type ?? null,
      latency_ms: latency_ms ?? null,
      source: source ?? "organic",
    } as never);

    if (error) return res.status(500).json({ error: error.message });

    return res.status(201).json({ ok: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Internal server error" });
  }
}
