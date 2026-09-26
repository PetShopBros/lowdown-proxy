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
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const node_id = req.query.node_id as string;
  if (!node_id) return res.status(400).json({ error: "node_id required" });

  try {
    const supabase = getSupabase();

    // 내 노드 통계
    const { data: nodeData } = await supabase
      .from("node_stats")
      .select("*")
      .eq("node_id", node_id)
      .single();

    // 네트워크 전체 통계
    const { count: totalInteractions } = await supabase
      .from("interactions")
      .select("*", { count: "exact", head: true });

    const { count: totalNodes } = await supabase
      .from("interactions")
      .select("node_id", { count: "exact", head: true })
      .not("node_id", "is", null);

    if (!nodeData) {
      return res.status(200).json({
        node_id,
        status: "unknown",
        contribution: null,
        network: {
          total_interactions: totalInteractions ?? 0,
        },
        message: "No contributions recorded yet for this node.",
      });
    }

    // percentile 계산
    const { count: nodesBelow } = await supabase
      .from("node_stats")
      .select("*", { count: "exact", head: true })
      .lt("interaction_count", nodeData.interaction_count);

    const percentile = totalNodes && totalNodes > 1
      ? Math.round(((nodesBelow ?? 0) / (totalNodes - 1)) * 100)
      : 100;

    return res.status(200).json({
      node_id,
      status: "active",
      contribution: {
        interactions: nodeData.interaction_count,
        targets_observed: nodeData.targets_contributed,
        active_days: nodeData.active_days,
        first_seen: nodeData.first_seen,
        last_seen: nodeData.last_seen,
      },
      network: {
        total_nodes: totalNodes ?? 0,
        total_interactions: totalInteractions ?? 0,
      },
      rank: {
        percentile,
      },
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Internal server error" });
  }
}