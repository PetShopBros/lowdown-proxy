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
  const taskType = (req.query.task_type as string) ?? null;


  try {
    const supabase = getSupabase();

    // task_type 필터가 있으면 interactions 테이블에서 직접 집계
    let data: any = null;
    let error: any = null;

    if (taskType) {
      const { data: rows } = await supabase
        .from("interactions")
        .select("outcome, latency_ms")
        .eq("target", target)
        .eq("task_type", taskType);

      if (!rows || rows.length === 0) {
        // 퍼지 매칭
        const { data: fuzzyTargets } = await supabase
          .from("reputation_summary")
          .select("target")
          .ilike("target", `%${target}%`)
          .limit(1)
          .single();

        if (fuzzyTargets) {
          const { data: fuzzyRows } = await supabase
            .from("interactions")
            .select("outcome, latency_ms")
            .eq("target", (fuzzyTargets as any).target)
            .eq("task_type", taskType);

          if (fuzzyRows && fuzzyRows.length > 0) {
            const success = fuzzyRows.filter((r: any) => r.outcome === "success").length;
            const latencies = fuzzyRows.map((r: any) => r.latency_ms).filter(Boolean);
            data = {
              target: (fuzzyTargets as any).target,
              interactions: fuzzyRows.length,
              success_rate: success / fuzzyRows.length,
              avg_latency_ms: latencies.length
                ? Math.round(latencies.reduce((a: number, b: number) => a + b, 0) / latencies.length)
                : null,
            };
          }
        }
      } else {
        const success = rows.filter((r: any) => r.outcome === "success").length;
        const latencies = rows.map((r: any) => r.latency_ms).filter(Boolean);
        data = {
          target,
          interactions: rows.length,
          success_rate: success / rows.length,
          avg_latency_ms: latencies.length
            ? Math.round(latencies.reduce((a: number, b: number) => a + b, 0) / latencies.length)
            : null,
        };
      }
    } else {
      // 기존 reputation_summary 뷰 조회
      const result = await supabase
        .from("reputation_summary")
        .select("*")
        .eq("target", target)
        .single();
      data = result.data;
      error = result.error;

      if (error || !data) {
        const { data: fuzzy } = await supabase
          .from("reputation_summary")
          .select("*")
          .ilike("target", `%${target}%`)
          .order("interactions", { ascending: false })
          .limit(1)
          .single();
        if (fuzzy) { data = fuzzy; error = null; }
      }
    }

    // 조회 자체를 로깅 (organic vs seeded 구분)
    const source = req.headers["x-lowdown-source"] === "seeded" ? "seeded" : "organic";
    const requester = (req.headers["x-lowdown-actor"] as string) ?? null;

    const userAgent = (req.headers["user-agent"] as string) ?? null;

    await supabase.from("reputation_lookups").insert({
      requester,
      target,
      source,
      user_agent: userAgent,
    } as never);

    if (error || !data) {
      return res.status(200).json({
        target,
        task_type: taskType ?? undefined,
        interactions: 0,
        success_rate: null,
        confidence: "none",
        message: "No interactions recorded yet.",
      });
    }

    // confidence 계산 (interactions 수 기반)
    const interactions = Number(data.interactions ?? 0);
    const confidence =
      interactions >= 100 ? "high" :
      interactions >= 10  ? "medium" : "low";

    const nodeId = (req.headers["x-lowdown-node-id"] as string) ?? null;

    // 기본 응답
    const baseResponse = {
      target,
      task_type: taskType ?? undefined,
      target_type: data.target_type,
      interactions,
      success_rate: data.success_rate,
      avg_latency_ms: data.avg_latency_ms ?? undefined,
      ...(taskType ? {} : {
        reviews: Number(data.reviews ?? 0),
        avg_rating: data.avg_rating,
        review_conversion_rate: data.review_conversion_rate,
      }),
      confidence,
    };

    // node_id 없으면 기본 응답
    if (!nodeId) {
      return res.status(200).json(baseResponse);
    }

    // node_id 있으면 상세 데이터 추가
    const { data: breakdown } = await supabase
      .from("interactions")
      .select("task_type, outcome, latency_ms, created_at")
      .eq("target", target)
      .order("created_at", { ascending: false })
      .limit(50);

    const taskBreakdown: Record<string, { success: number; failure: number }> = {};
    const recentTrends: { date: string; count: number }[] = [];
    const dateCounts: Record<string, number> = {};

    for (const row of breakdown ?? []) {
      // task_breakdown
      const t = row.task_type ?? "unknown";
      if (!taskBreakdown[t]) taskBreakdown[t] = { success: 0, failure: 0 };
      if (row.outcome === "success") taskBreakdown[t].success++;
      else taskBreakdown[t].failure++;

      // recent_trends (날짜별 카운트)
      const date = row.created_at?.slice(0, 10);
      if (date) dateCounts[date] = (dateCounts[date] ?? 0) + 1;
    }

    for (const [date, count] of Object.entries(dateCounts).sort()) {
      recentTrends.push({ date, count });
    }

    return res.status(200).json({
      ...baseResponse,
      task_breakdown: taskBreakdown,
      recent_trends: recentTrends,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Internal server error" });
  }
}
