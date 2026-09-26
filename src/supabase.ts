import { createClient } from "@supabase/supabase-js";

export interface InteractionRecord {
  actor: string;
  target: string;
  target_type: "agent" | "tool" | "service" | "human";
  task_type: string;
  outcome: "success" | "partial" | "failure";
  latency_ms?: number;
  source?: "organic" | "seeded" | "synthetic";
  node_id?: string;
}

let client: ReturnType<typeof createClient> | null = null;

function getClient() {
  if (client) return client;

  const url = process.env.LOWDOWN_SUPABASE_URL;
  const key = process.env.LOWDOWN_SUPABASE_KEY;

  if (!url || !key) {
    // 설계 원칙: 자격증명이 없어도 프록시 자체는 죽지 않는다.
    // 패스스루가 우선이고, 기록은 부가 기능이다.
    return null;
  }

  client = createClient(url, key, { auth: { persistSession: false } });
  return client;
}

/**
 * interaction을 Supabase에 기록한다.
 * 절대 throw하지 않는다 — 기록 실패가 프록시 통신을 막아서는 안 된다.
 * (기록은 부가 기능, 패스스루가 본 기능)
 */
export async function recordInteraction(record: InteractionRecord): Promise<void> {
  const supabase = getClient();
  if (!supabase) {
    if (process.env.LOWDOWN_DEBUG) {
      console.error("[lowdown] LOWDOWN_SUPABASE_URL/KEY 미설정 — 기록 건너뜀:", record);
    }
    return;
  }

  try {
    // Database 타입을 별도 생성하지 않은 v0 상태라 insert 페이로드는 any로 캐스팅.
    // (나중에 `supabase gen types`로 타입을 뽑으면 제거 가능)
    const { error } = await supabase.from("interactions").insert({
      actor: record.actor,
      target: record.target,
      target_type: record.target_type,
      task_type: record.task_type,
      outcome: record.outcome,
      latency_ms: record.latency_ms ?? null,
      source: record.source ?? "organic",
      node_id: record.node_id ?? null,
    } as never);
    if (error && process.env.LOWDOWN_DEBUG) {
      console.error("[lowdown] interaction 기록 실패:", error.message);
    }
  } catch (err) {
    if (process.env.LOWDOWN_DEBUG) {
      console.error("[lowdown] interaction 기록 예외:", err);
    }
  }
}
