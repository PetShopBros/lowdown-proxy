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
  // 조회 유입 측정용 태그 (예: ?ref=report). 안전한 문자만 허용.
  const refRaw = req.query.ref;
  const ref = typeof refRaw === "string" && /^[A-Za-z0-9._:-]{1,64}$/.test(refRaw) ? refRaw : null;


  try {
    const supabase = getSupabase();

    // task_type 필터가 있으면 interactions 테이블에서 직접 집계
    let data: any = null;
    let error: any = null;

    if (taskType) {
      const { data: rows } = await supabase
        .from("interactions")
        .select("outcome, latency_ms, failure_type")
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
            .select("outcome, latency_ms, failure_type")
            .eq("target", (fuzzyTargets as any).target)
            .eq("task_type", taskType);

          if (fuzzyRows && fuzzyRows.length > 0) {
            const success = fuzzyRows.filter((r: any) => r.outcome === "success").length;
            const latencies = fuzzyRows.map((r: any) => r.latency_ms).filter(Boolean);
            const failureBreakdown = buildFailureBreakdown(fuzzyRows);
            data = {
              target: (fuzzyTargets as any).target,
              interactions: fuzzyRows.length,
              success_rate: success / fuzzyRows.length,
              avg_latency_ms: latencies.length
                ? Math.round(latencies.reduce((a: number, b: number) => a + b, 0) / latencies.length)
                : null,
              failure_breakdown: failureBreakdown,
            };
          }
        }
      } else {
        const success = rows.filter((r: any) => r.outcome === "success").length;
        const latencies = rows.map((r: any) => r.latency_ms).filter(Boolean);
        const failureBreakdown = buildFailureBreakdown(rows);
        data = {
          target,
          interactions: rows.length,
          success_rate: success / rows.length,
          avg_latency_ms: latencies.length
            ? Math.round(latencies.reduce((a: number, b: number) => a + b, 0) / latencies.length)
            : null,
          failure_breakdown: failureBreakdown,
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

    // Scanner 관찰 데이터: interactions/success_rate 와 합산하지 않고 별도 `scanner` 블록으로만 노출.
    // 실패해도 기존 응답에는 영향 없음. task_type 필터 요청에는 붙이지 않는다.
    const scannerLookup = taskType ? null : await findScanner(supabase, target);

    // 조회 자체를 로깅 (organic vs seeded 구분)
    const source = req.headers["x-lowdown-source"] === "seeded" ? "seeded" : "organic";
    const requester = (req.headers["x-lowdown-actor"] as string) ?? null;

    const userAgent = (req.headers["user-agent"] as string) ?? null;

    await supabase.from("reputation_lookups").insert({
      requester,
      target,
      source,
      user_agent: userAgent,
      ...(ref ? { ref } : {}),
    } as never);

    if (error || !data) {
      return res.status(200).json({
        target,
        task_type: taskType ?? undefined,
        interactions: 0,
        success_rate: null,
        confidence: "none",
        message: "No interactions recorded yet.",
        ...scannerFields(scannerLookup),
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
      ...(data.failure_breakdown ? { failure_breakdown: data.failure_breakdown } : {}),
      ...(taskType ? {} : {
        reviews: Number(data.reviews ?? 0),
        avg_rating: data.avg_rating,
        review_conversion_rate: data.review_conversion_rate,
      }),
      confidence,
      ...scannerFields(scannerLookup),
    };

    // node_id 없으면 기본 응답
    if (!nodeId) {
      return res.status(200).json(baseResponse);
    }

    // node_id 있으면 상세 데이터 추가
    const { data: breakdown } = await supabase
      .from("interactions")
      .select("task_type, outcome, latency_ms, failure_type, created_at")
      .eq("target", target)
      .order("created_at", { ascending: false })
      .limit(50);

    const taskBreakdown: Record<string, { success: number; failure: number; failure_types?: Record<string, number> }> = {};
    const recentTrends: { date: string; count: number }[] = [];
    const dateCounts: Record<string, number> = {};

    for (const row of breakdown ?? []) {
      // task_breakdown
      const t = row.task_type ?? "unknown";
      if (!taskBreakdown[t]) taskBreakdown[t] = { success: 0, failure: 0 };
      if (row.outcome === "success") {
        taskBreakdown[t].success++;
      } else {
        taskBreakdown[t].failure++;
        if (row.failure_type) {
          taskBreakdown[t].failure_types = taskBreakdown[t].failure_types ?? {};
          taskBreakdown[t].failure_types[row.failure_type] = (taskBreakdown[t].failure_types[row.failure_type] ?? 0) + 1;
        }
      }

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

function buildFailureBreakdown(rows: any[]): Record<string, number> | null {
  const failed = rows.filter((r) => r.outcome !== "success");
  if (failed.length === 0) return null;
  const breakdown: Record<string, number> = {};
  for (const r of failed) {
    const key = r.failure_type ?? "unknown";
    breakdown[key] = (breakdown[key] ?? 0) + 1;
  }
  return breakdown;
}

// ── Scanner 관찰 블록 ────────────────────────────────────────────
interface ScannerLookup {
  summary: Record<string, unknown> | null;
  candidates: string[];
  // 조회는 정상 수행했고 일치하는 관찰이 없음(조회 오류와 구분)
  unobserved?: boolean;
}

const SCANNER_UNOBSERVED = {
  observed: false,
  note: "No Lowdown Scanner observation exists for this target. The Scanner observes a fixed set of 2,000 MCP Registry entries daily; absence of data says nothing about the target's status.",
};

function scannerFields(lookup: ScannerLookup | null): Record<string, unknown> {
  if (!lookup) return {};
  if (lookup.summary) return { scanner: lookup.summary };
  if (lookup.candidates.length > 0) return { scanner_candidates: lookup.candidates };
  if (lookup.unobserved) return { scanner: SCANNER_UNOBSERVED };
  return {};
}

/**
 * scanner_summary(공개 집계 view)에서 target 을 찾는다.
 * 1) 정확히 일치 (입력 그대로, 없으면 `mcp:` 접두사 붙여서)
 * 2) 3자 이상이면 부분 일치: 1건이면 그 대상, 여러 건이면 후보 이름(최대 5개)만 반환
 * 어떤 오류가 나도 null — 기존 reputation 응답을 막지 않는다.
 */
async function findScanner(supabase: any, target: string): Promise<ScannerLookup | null> {
  try {
    const ids = target.startsWith("mcp:") ? [target] : [target, `mcp:${target}`];
    for (const id of ids) {
      const exact = await supabase.from("scanner_summary").select("*").eq("target_id", id).limit(1);
      if (exact.error) return null;
      const row = (exact.data ?? [])[0];
      if (row) return { summary: shapeScanner(row), candidates: [] };
    }

    if (target.length < 3) return { summary: null, candidates: [], unobserved: true };
    const pattern = `%${target.replace(/[\\%_]/g, "\\$&")}%`;
    const fuzzy = await supabase
      .from("scanner_summary")
      .select("*")
      .ilike("target_id", pattern)
      .order("observations_30d", { ascending: false })
      .limit(6);
    if (fuzzy.error) return null;
    const rows = (fuzzy.data ?? []) as any[];
    if (rows.length === 1) return { summary: shapeScanner(rows[0]), candidates: [] };
    if (rows.length > 1) return { summary: null, candidates: rows.slice(0, 5).map((r) => String(r.target_id)) };
    return { summary: null, candidates: [], unobserved: true };
  } catch {
    return null;
  }
}

function shapeScanner(r: any): Record<string, unknown> {
  const version = typeof r.latest_server_version === "string" && /^[0-9A-Za-z.+_-]{1,32}$/.test(r.latest_server_version)
    ? r.latest_server_version
    : null;
  return {
    target: r.target_id,
    last_observed_at: r.last_observed_at,
    observations_30d: Number(r.observations_30d ?? 0),
    remotes_observed: Number(r.remotes_observed ?? 0),
    latest: {
      reached_level: r.latest_reached_level,
      http_status: r.latest_http_status,
      error_type: r.latest_error_type,
      latency_ms: r.latest_latency_ms,
      tool_count: r.latest_tool_count,
      schema_hash: r.latest_schema_hash,
      server_version: version,
    },
    schema_versions_30d: Number(r.schema_versions_30d ?? 0),
    status_distribution_30d: r.status_distribution_30d ?? {},
    note: "Observed by Lowdown Scanner (initialize + tools/list only; no tool calls). Not included in success_rate.",
  };
}
