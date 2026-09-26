import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";

function getSupabase() {
  const url = process.env.LOWDOWN_SUPABASE_URL;
  const key = process.env.LOWDOWN_SUPABASE_KEY;
  if (!url || !key) throw new Error("Supabase env missing");
  return createClient(url, key, { auth: { persistSession: false } });
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // CORS — 어떤 에이전트/클라이언트도 조회 가능하게
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const target = req.query.target as string;
  if (!target) return res.status(400).json({ error: "target required" });

  try {
    const supabase = getSupabase();

    // reputation_summary 뷰에서 집계 조회
    const { data, error } = await supabase
      .from("reputation_summary")
      .select("*")
      .eq("target", target)
      .single();

    // 조회 자체를 로깅 (organic vs seeded 구분)
    const source = req.headers["x-lowdown-source"] === "seeded" ? "seeded" : "organic";
    const requester = (req.headers["x-lowdown-actor"] as string) ?? null;

    await supabase.from("reputation_lookups").insert({
      requester,
      target,
      source,
    } as never);

    if (error || !data) {
      // 데이터 없으면 "아직 기록 없음" 응답
      return res.status(200).json({
        target,
        interactions: 0,
        reviews: 0,
        success_rate: null,
        avg_rating: null,
        review_conversion_rate: null,
        confidence: "none",
        message: "No interactions recorded yet.",
      });
    }

    // confidence 계산 (interactions 수 기반)
    const interactions = Number(data.interactions ?? 0);
    const confidence =
      interactions >= 100 ? "high" :
      interactions >= 10  ? "medium" : "low";

    return res.status(200).json({
      target,
      target_type: data.target_type,
      interactions,
      reviews: Number(data.reviews ?? 0),
      success_rate: data.success_rate,
      avg_rating: data.avg_rating,
      review_conversion_rate: data.review_conversion_rate,
      confidence,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Internal server error" });
  }
}
