import { createHash } from "node:crypto";

/**
 * 프록시가 관찰한 JSON-RPC 응답 하나를 interaction 기록으로 분류한다. (순수 함수 — 테스트 대상)
 *
 * 기준 (MCP spec, server/tools "Error Handling"):
 * - 도구 실행 오류는 JSON-RPC 에러가 아니라 tools/call 결과의 `isError: true` 로 온다 → 실패(tool).
 * - 요청 자체가 잘못된 경우(-32700/-32600/-32601/-32602)는 서버 장애가 아니다 → error_layer "request".
 *   성공률 집계에서 빠지고, 클라이언트 요청 오류로 따로 센다.
 * - 그 밖의 JSON-RPC 에러(-32603, 서버 정의 코드, 타임아웃)는 서버 쪽 실패 → error_layer "server".
 * - tools/call 이 아닌 요청(initialize, tools/list, ping …)은 request_kind "protocol" 로 남기고 성공률에는 넣지 않는다.
 */

export type RequestKind = "tool_call" | "protocol" | "reported";
export type ErrorLayer = "request" | "server" | "tool";
export type FailureType =
  | "invalid_arguments"
  | "protocol_error"
  | "timeout"
  | "server_error"
  | "tool_error"
  | "unknown";

export interface Classification {
  request_kind: Exclude<RequestKind, "reported">;
  outcome: "success" | "failure";
  failure_type?: FailureType;
  error_layer?: ErrorLayer;
}

const REQUEST_ERROR_CODES = new Set([-32700, -32600, -32601, -32602]);

export function classifyResponse(method: string, msg: any): Classification {
  const request_kind = method === "tools/call" ? "tool_call" : "protocol";

  if (msg?.error) {
    const code = typeof msg.error.code === "number" ? msg.error.code : undefined;
    const message = String(msg.error.message ?? "").toLowerCase();
    if (code !== undefined && REQUEST_ERROR_CODES.has(code)) {
      return {
        request_kind,
        outcome: "failure",
        failure_type: code === -32602 ? "invalid_arguments" : "protocol_error",
        error_layer: "request",
      };
    }
    let failure_type: FailureType = "unknown";
    if (message.includes("timeout") || message.includes("timed out")) failure_type = "timeout";
    else if (code === -32603) failure_type = "server_error";
    else if (code === -32000) failure_type = "tool_error";
    return { request_kind, outcome: "failure", failure_type, error_layer: "server" };
  }

  if (request_kind === "tool_call" && msg?.result?.isError === true) {
    return { request_kind, outcome: "failure", failure_type: "tool_error", error_layer: "tool" };
  }

  return { request_kind, outcome: "success" };
}

// ── schema_hash: Scanner(scanner/lib.ts hashTools)와 같은 계산 → 프록시 기록과 Scanner 관찰을 비교할 수 있다 ──

export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  const o = v as Record<string, unknown>;
  const parts = Object.keys(o)
    .sort()
    .filter((k) => o[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`);
  return `{${parts.join(",")}}`;
}

/** name + inputSchema + outputSchema. 도구 순서·키 순서와 무관. */
export function schemaHash(tools: unknown[]): string {
  const objs = tools.map((t) =>
    typeof t === "object" && t !== null && !Array.isArray(t) ? (t as Record<string, unknown>) : {},
  );
  const byName = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  const schema = objs
    .map((t) => canonicalJson({ name: t.name, inputSchema: t.inputSchema, outputSchema: t.outputSchema }))
    .sort(byName);
  return createHash("sha256").update(`[${schema.join(",")}]`).digest("hex");
}

/** 서버가 initialize 에서 알려준 버전. 문자열이 아니면 버린다. */
export function serverVersionOf(msg: any): string | undefined {
  const v = msg?.result?.serverInfo?.version;
  return typeof v === "string" && v.length > 0 ? v.slice(0, 100) : undefined;
}

const RUNNERS = new Set([
  "npx", "npx.cmd", "uvx", "uv", "bunx", "pnpx", "pnpm", "yarn", "dlx", "run", "tool", "exec",
  "node", "node.exe", "python", "python3", "python.exe", "deno", "bun", "cmd", "cmd.exe",
]);

/**
 * --target 이 없을 때 쓸 라벨. 명령줄 전체(인자에 키·경로가 있을 수 있음)를 공개 기록에 넣지 않기 위해
 * 실행기(npx/uvx/node …)와 옵션을 건너뛴 첫 토큰 하나만 쓴다. 경로면 파일 이름만.
 */
export function defaultTargetLabel(command: string, args: string[]): string {
  const tokens = [command, ...args];
  for (const raw of tokens) {
    const base = raw.split(/[\\/]/).pop() ?? raw;
    if (raw.startsWith("-") || raw.toLowerCase() === "/c") continue;
    if (RUNNERS.has(base.toLowerCase())) continue;
    if (raw.startsWith("@")) return raw.slice(0, 200); // 스코프 패키지 이름은 '/' 를 포함하므로 그대로
    return base.slice(0, 200);
  }
  return "unknown";
}
