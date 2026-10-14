import { createRequire } from "node:module";
import type { ErrorLayer, FailureType, RequestKind } from "./classify.js";

export interface InteractionRecord {
  actor: string;
  target: string;
  target_type: "agent" | "tool" | "service" | "human";
  task_type: string;
  outcome: "success" | "partial" | "failure";
  failure_type?: FailureType;
  latency_ms?: number;
  source?: "organic" | "seeded" | "synthetic";
  node_id?: string;
  request_kind?: RequestKind;
  error_layer?: ErrorLayer;
  server_version?: string;
  schema_hash?: string;
  recorder_version?: string;
}

const DEFAULT_API_URL = "https://lowdown-proxy.vercel.app";

/** dist/*.js 기준 ../package.json — 기록 행마다 어떤 판정 로직(버전)이 남긴 기록인지 남긴다. */
export const RECORDER_VERSION: string = (() => {
  try {
    return (createRequire(import.meta.url)("../package.json") as { version: string }).version;
  } catch {
    return "0.0.0";
  }
})();

export function apiBaseUrl(): string {
  return (process.env.LOWDOWN_API_URL ?? DEFAULT_API_URL).replace(/\/+$/, "");
}

let warnedLegacyKey = false;

/**
 * interaction 을 공개 API(POST /api/interactions)로 보낸다. DB 키가 필요 없다.
 * 절대 throw 하지 않는다 — 기록 실패가 프록시 통신을 막아서는 안 된다(패스스루가 본 기능).
 */
export async function recordInteraction(
  record: InteractionRecord,
  deps: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<void> {
  if (process.env.LOWDOWN_RECORD === "0") return;
  if (process.env.LOWDOWN_SUPABASE_KEY && !warnedLegacyKey) {
    warnedLegacyKey = true;
    console.error("[lowdown] LOWDOWN_SUPABASE_KEY 는 더 이상 쓰지 않습니다(기록은 공개 API 경유). 설정에서 지워도 됩니다.");
  }
  const f = deps.fetchImpl ?? fetch;
  try {
    const res = await f(`${apiBaseUrl()}/api/interactions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...record, recorder_version: record.recorder_version ?? RECORDER_VERSION }),
      signal: AbortSignal.timeout(deps.timeoutMs ?? 3000),
    });
    if (!res.ok && process.env.LOWDOWN_DEBUG) {
      console.error(`[lowdown] interaction 기록 실패: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    }
  } catch (err) {
    if (process.env.LOWDOWN_DEBUG) console.error("[lowdown] interaction 기록 예외:", err);
  }
}
