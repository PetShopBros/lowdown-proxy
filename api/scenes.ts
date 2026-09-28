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
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();

  // GET — 씬 목록 조회
  if (req.method === "GET") {
    const { parcel, category } = req.query as Record<string, string>
    const supabase = getSupabase()
    let query = supabase.from("scenes").select("*").order("created_at", { ascending: false })
    if (parcel) query = query.eq("parcel", parcel)
    if (category) query = query.eq("category", category)
    const { data, error } = await query
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ ok: true, data })
  }

  // POST — 씬 등록
  if (req.method === "POST") {
    const { parcel, name, description, category, services, agent_instructions, owner } = req.body ?? {}
    if (!parcel || !name || !category) {
      return res.status(400).json({ error: "parcel, name, category required" })
    }
    const validCategories = ["ai_service", "art", "game", "shop", "event", "education", "other"]
    if (!validCategories.includes(category)) {
      return res.status(400).json({ error: "invalid category" })
    }
    const supabase = getSupabase()
    const { data, error } = await supabase.from("scenes").upsert({
      parcel,
      name,
      description: description ?? null,
      category,
      services: services ?? null,
      agent_instructions: agent_instructions ?? null,
      owner: owner ?? null,
      updated_at: new Date().toISOString()
    }, { onConflict: "parcel" }).select()
    if (error) return res.status(500).json({ error: error.message })
    return res.status(201).json({ ok: true, data })
  }

  return res.status(405).json({ error: "Method not allowed" })
}