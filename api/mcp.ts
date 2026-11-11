import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createHash, randomUUID } from "node:crypto";
import { waitUntil } from "@vercel/functions";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SUPPORTED_PROTOCOL_VERSIONS } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

// 원격 MCP 서버 (2026-10-30). https://lowdown-proxy.vercel.app/mcp (vercel.json rewrite → /api/mcp)
// 로컬 stdio 서버(src/mcp-server.ts)와 같은 조회를 HTTPS 주소 하나로 연다. 인증 없음(공개 데이터).
// Streamable HTTP, 세션 없음(stateless), 일반 JSON 응답 → 요청 1건 = 함수 1회.
// 읽기 전용 도구만: get_lowdown, find_servers(2026-11-01, /api/find 를 부름). 쓰기(record_interaction)·노드 통계·비교는 열지 않는다.
// instructions(2026-11-01): 연결만 하고 도구를 부르지 않는 클라이언트가 많아(10/31 Claude-User tools/call 0건) 쓰임을 initialize 에서 알린다.
// 조회는 같은 배포의 조회 API 를 부른다(판정 로직을 다시 만들지 않음). ref=mcp 로 원격 MCP 경유를 따로 센다.
//   nc=1 → CDN 캐시를 건너뛰어 모든 원격 조회가 reputation_lookups 에 남는다(실사용 측정). 서버 카드가 있으면 카드 1행으로 답한다.
//   middleware.ts 는 ref=mcp 안쪽 호출을 세지 않는다(바깥 /mcp 요청 1건만 edge_hits 에).
// 메시지별 기록(2026-11-05, supabase/2026-11-05_mcp_calls.sql): JSON-RPC 메시지 1개 = mcp_calls 1줄.
//   initialize·tools/list·tools/call 을 구분하고, 응답(res.end 로 나가는 본문)을 읽어 메시지별 결과를 붙인다.
//   관측은 응답을 바꾸지 않는다: 상태·헤더·본문은 그대로 나가고, 기록은 응답 뒤 waitUntil 로 쓴다. 기록이 실패해도 응답은 같다.
//   저장하지 않는 것: IP, 도구 인자 값, 검색어. clientInfo·x-agent-id 는 자기 선언(declared_*)으로만 둔다.

export const SITE = "https://lowdown-proxy.vercel.app";
const VERSION = "1.0.0";

// 조회 메뉴 (api/reputation/[target].ts 의 SETS·DISHES 와 같아야 한다. 준비 중 메뉴는 넣지 않는다)
export const MENUS = [
  "install-check", "change-watch", "full",
  "status", "packages", "tools", "declared-vs-observed", "content-flags", "tool-list", "registry", "history", "agent-reports",
] as const;

const TARGET_RE = /^[\x21-\x7e]{1,300}$/; // 출력 가능한 ASCII 만(공백·제어문자 없음). 형식 검사는 조회 API 가 한다.

// find (api/find.ts 의 STATES·REGISTRY_STATUSES·PACKAGE_FILTERS·SORTS 키와 같아야 한다).
// API 파일끼리 import 하지 않는 규칙(api/find.ts 머리말) 때문에 값을 여기 따로 둔다. 값 검사는 find API 가 한다.
export const FIND_STATES = ["answered", "auth_required", "payment_required", "list_failed", "no_response", "invalid_response", "mixed"] as const;
export const FIND_SORTS = ["name", "newest", "updated", "tools", "stable", "answering", "changed", "release"] as const;
const FIND_REGISTRY = ["active", "deprecated"] as const;
const FIND_PACKAGE = ["ok", "flagged", "none"] as const;

// initialize 응답의 instructions: 클라이언트가 언제 이 서버를 쓰는지 알 수 있게. 지시문이 아니라 쓰임 설명.
// 연결 때 서버가 클라이언트(모델)에 자동으로 보내는 안내문. 메뉴판 요약을 싣는다(2026-11-02).
// 단품 목록은 MENUS 에서 만든다 → 메뉴를 바꾸면 안내문도 같이 바뀐다. 데이터(오늘의 변경 등)는 넣지 않는다.
const MENU_SETS = ["install-check", "change-watch"] as const;
const MENU_DISHES = MENUS.filter((m) => m !== "full" && !(MENU_SETS as readonly string[]).includes(m));

export const INSTRUCTIONS =
  "Lowdown records dated facts about public MCP servers: daily initialize/tools/list checks, MCP Registry declarations, " +
  "npm/PyPI package state and observed tool-definition changes. " +
  "When a user asks whether to install, add, connect or trust an MCP server, use get_lowdown with its name. " +
  "Menus for get_lowdown: 'install-check' (status, packages, declared vs observed, content flags), 'change-watch' (what changed recently), " +
  `or one part: ${MENU_DISHES.join(", ")}; omit for everything. ` +
  "When no name is known yet, use find_servers to list servers by what they do (does, e.g. 'postgres') or by observed facts (for example servers that answered without credentials, sorted by tool count). " +
  "Full menu card: https://lowdown-proxy.vercel.app/menu.json. " +
  "Lowdown's own operating status, updated hourly: https://lowdown-proxy.vercel.app/status.json. " + // 주소만(숫자는 넣지 않음, 2026-11-05)
  "Facts are observations, not scores; absence of data says nothing about a server.";

export type FindArgs = {
  q?: string; does?: string; state?: string; answered_days?: number; stable_days?: number; tools_min?: number; tools_max?: number;
  registry?: string; package?: string; sort?: string; order?: string; limit?: number; offset?: number;
};

export function findUrl(host: string, a: FindArgs): string {
  const q = new URLSearchParams({ ref: "mcp", nc: "1" });
  for (const [k, v] of Object.entries(a)) if (v !== undefined && v !== null && v !== "") q.set(k, String(v));
  return `https://${host}/api/find?${q.toString()}`;
}

function header(req: VercelRequest, name: string, max: number): string | null {
  const v = req.headers[name];
  const s = Array.isArray(v) ? v[0] : v;
  return typeof s === "string" && s.length > 0 ? s.slice(0, max) : null;
}

export function lookupUrl(host: string, target: string, menu: string | null): string {
  const q = new URLSearchParams({ ref: "mcp", nc: "1" });
  if (menu && menu !== "full") q.set("menu", menu);
  return `https://${host}/api/reputation/${encodeURIComponent(target)}?${q.toString()}`;
}

/** MCP 도구 오류: isError + REST 와 같은 JSON 본문 1개 */
export function toolError(body: Record<string, unknown>) {
  return { isError: true, content: [{ type: "text" as const, text: JSON.stringify(body) }] };
}

/** 조회 API 의 오류 응답 → 표준 오류. 표준 JSON 이면 그대로(+http_status), 아니면 상태 코드로 만든다. */
export function upstreamError(status: number, text: string, what: string): Record<string, unknown> {
  try {
    const j = JSON.parse(text) as Record<string, unknown>;
    if (j && typeof j === "object" && !Array.isArray(j) && typeof j.error === "string") {
      return {
        ...j,
        message: typeof j.message === "string" ? j.message : typeof j.note === "string" ? j.note : `Lowdown ${what} answered HTTP ${status}.`,
        retryable: typeof j.retryable === "boolean" ? j.retryable : status === 429 || status >= 500,
        http_status: status,
      };
    }
  } catch { /* 표준 JSON 이 아님 */ }
  if (status === 429) return { error: "rate_limited", message: `Lowdown ${what} answered HTTP 429. Retry later.`, retryable: true, http_status: status };
  if (status >= 500) {
    return {
      error: "temporarily_unavailable",
      message: status === 503 ? "Lowdown cannot read its records right now. Retry later; this is not 'no record'." : `Lowdown ${what} answered HTTP ${status}. Retry later.`,
      retryable: true,
      http_status: status,
    };
  }
  return { error: "invalid_parameter", message: `Lowdown ${what} answered HTTP ${status}: ${text.slice(0, 500)}`, retryable: false, http_status: status };
}

export function buildServer(ctx: { host: string; ua: string | null; fetchImpl?: typeof fetch }): McpServer {
  const doFetch = ctx.fetchImpl ?? fetch;
  const server = new McpServer({ name: "lowdown", version: VERSION }, { instructions: INSTRUCTIONS });

  // 같은 배포의 API 를 부르고 MCP 응답으로 바꾼다 (get_lowdown·find_servers 공통)
  // 오류(2026-11-05, 응답 스키마 v1): isError 는 그대로, 본문은 REST 와 같은 JSON { error, message, retryable, retry_after_seconds?, http_status? }.
  //   조회 API 가 표준 오류 JSON 을 주면 그대로 넘기고(http_status 만 더함), 아니면 같은 모양으로 만든다.
  const callApi = async (url: string, what: string) => {
    let r: Response;
    try {
      r = await doFetch(url, {
        headers: { "user-agent": ctx.ua ?? "lowdown-remote-mcp", accept: "application/json" },
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      return toolError({ error: "temporarily_unavailable", message: `Lowdown ${what} did not answer. Retry later.`, retryable: true });
    }
    const text = await r.text();
    if (!r.ok) return toolError(upstreamError(r.status, text, what));
    return { content: [{ type: "text" as const, text }] };
  };

  server.registerTool(
    "get_lowdown",
    {
      title: "Look up recorded facts about an MCP server",
      description:
        "Look up recorded facts about an MCP server before installing or connecting to it. " +
        "Accepts an MCP Registry name ('mcp:io.github.user/server'), a short name, or a package ('npm:@scope/name', 'pypi:name'). " +
        "Returns dated facts, not scores: `status` (latest daily initialize/tools/list check: answered, required authentication, or no response), " +
        "`registry` (what the official MCP Registry declares, and changes in the last 30 days), " +
        "`packages` (declared npm/PyPI packages: deprecated, yanked, archived, or 404), " +
        "`scanner` (when tool definitions changed and content markers such as a new URL or invisible characters), and agent reports. " +
        "The optional `menu` returns only one part, e.g. 'install-check' (the facts used before installing). " +
        "Absence of data says nothing about a server's status. Each answer ends with a `source` block (dataset, CC BY 4.0 license, retrieval time).",
      inputSchema: {
        target: z.string().min(1).max(300).describe(
          "MCP Registry name with the mcp: prefix (e.g. 'mcp:io.github.user/server'), a short name, or a package with the npm: or pypi: prefix",
        ),
        menu: z.enum(MENUS).optional().describe(
          "Optional. Before installing, use 'install-check' (status, packages, declared-vs-observed, content-flags). 'change-watch' = what changed recently, " +
          "or one part: status, packages, tools, declared-vs-observed, content-flags, tool-list, registry, history, agent-reports. Omit or 'full' for everything.",
        ),
      },
      annotations: { title: "Look up recorded facts about an MCP server", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ target, menu }) => {
      const t = target.trim();
      if (!TARGET_RE.test(t)) return toolError({ error: "invalid_parameter", message: "target must be printable ASCII without spaces, up to 300 characters.", retryable: false, parameter: "target", example: "mcp:io.github.user/server" });
      return callApi(lookupUrl(ctx.host, t, menu ?? null), "lookup");
    },
  );

  server.registerTool(
    "find_servers",
    {
      title: "Find MCP servers by observed facts",
      description:
        "List public MCP servers by facts Lowdown observed, when you do not have a server name yet. " +
        "Use does to find servers by what they do (words in the Registry name or tool names, e.g. 'postgres'). " +
        "Filter by the latest daily check (e.g. state 'answered' = answered initialize and tools/list without credentials), days answered in the last 30, " +
        "how long the tool list has been unchanged, tool count, Registry status and package state; sort by one key. " +
        "No score or ranking: order is only the chosen sort key. Each result carries a lookup URL; call get_lowdown with its name for the full record. " +
        "Tool lists are recorded from 2026-10-20, so a long stable_days returns nothing yet.",
      inputSchema: {
        q: z.string().min(2).max(100).optional().describe("Part of the Registry name, e.g. 'github' or 'io.github.user'"),
        does: z.string().min(2).max(92).optional().describe("What the server does: 1-3 words separated by spaces, e.g. 'postgres' or 'github issue'. Every word must appear in the Registry name or in a tool name from the latest observed tool list; results show matched_in"),
        state: z.enum(FIND_STATES).optional().describe("Latest daily check result (only servers checked in the last 2 days). 'answered' = answered tools/list with no credentials"),
        answered_days: z.number().int().min(1).max(30).optional().describe("Minimum daily checks in the last 30 days that answered tools/list"),
        stable_days: z.number().int().min(1).max(3650).optional().describe("Current tool list first observed at least this many days ago"),
        tools_min: z.number().int().min(0).max(10000).optional().describe("Minimum tool count"),
        tools_max: z.number().int().min(0).max(10000).optional().describe("Maximum tool count"),
        registry: z.enum(FIND_REGISTRY).optional().describe("MCP Registry status"),
        package: z.enum(FIND_PACKAGE).optional().describe("ok = declared packages with no deprecated/yanked/404 latest; flagged = at least one; none = no declared packages"),
        sort: z.enum(FIND_SORTS).optional().describe("Sort key (default name). tools = tool count, answering = days answered, stable = tool list unchanged longest, newest, updated, changed, release"),
        order: z.enum(["asc", "desc"]).optional().describe("Default depends on sort"),
        limit: z.number().int().min(1).max(50).optional().describe("1-50, default 20"),
        offset: z.number().int().min(0).max(2000).optional().describe("For the next page, use next_offset from the previous answer"),
      },
      annotations: { title: "Find MCP servers by observed facts", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) => callApi(findUrl(ctx.host, args as FindArgs), "find"),
  );
  return server;
}

// ── 메시지별 기록 (mcp_calls) ──────────────────────────────
const KNOWN_TOOLS = new Set(["get_lowdown", "find_servers"]);
const MENU_SET = new Set<string>(MENUS);
const MAX_CAPTURE = 2 * 1024 * 1024; // 응답 본문을 이만큼까지만 읽는다(넘으면 결과 unknown, 응답은 그대로 나감)

export type MsgInfo = {
  idKey: string | null; // 요청 id(JSON 문자열). 알림·형식 밖이면 null
  isNotification: boolean;
  method: string | null;
  tool: string | null;
  menu: string | null;
  clientName: string | null;
  clientVersion: string | null;
  protocol: string | null;
};
export type Outcome = "ok" | "tool_error" | "rpc_error" | "http_error" | "no_response" | "unknown";
export type CallRow = {
  request_id: string; http_method: string; http_status: number | null; batch_size: number; msg_index: number | null;
  rpc_method: string | null; is_notification: boolean; tool_name: string | null; menu: string | null;
  declared_client_name: string | null; declared_client_version: string | null; protocol_version: string | null;
  declared_agent_id: string | null; outcome: Outcome; error_code: number | null; duration_ms: number | null; user_agent: string | null;
};

const s = (v: unknown, max: number): string | null => (typeof v === "string" && v.length > 0 ? v.slice(0, max) : null);
const isObj = (v: unknown): v is Record<string, any> => typeof v === "object" && v !== null && !Array.isArray(v);

// 요청 본문 → 메시지 목록. 인자 값은 읽지 않는다(도구 이름·정해진 메뉴 값·initialize 의 clientInfo 만).
export function describeMessages(body: unknown, headerProtocol: string | null): MsgInfo[] {
  const list = Array.isArray(body) ? body : body === undefined || body === null ? [] : [body];
  return list.map((m): MsgInfo => {
    const o = isObj(m) ? m : {};
    const method = s(o.method, 100);
    const hasId = "id" in o && o.id !== undefined;
    const params = isObj(o.params) ? o.params : {};
    let tool: string | null = null;
    let menu: string | null = null;
    if (method === "tools/call") {
      const name = s(params.name, 100);
      tool = name && KNOWN_TOOLS.has(name) ? name : "unknown";
      const a = isObj(params.arguments) ? params.arguments : {};
      if (tool === "get_lowdown" && typeof a.menu === "string" && MENU_SET.has(a.menu)) menu = a.menu;
    }
    // 2026-07-28 스펙: initialize 없이 요청마다 _meta 에 clientInfo·protocolVersion 을 싣는다(SEP-2575)
    const meta = isObj(params._meta) ? params._meta : {};
    const metaCi = isObj(meta["io.modelcontextprotocol/clientInfo"]) ? meta["io.modelcontextprotocol/clientInfo"] : {};
    const ci = method === "initialize" && isObj(params.clientInfo) ? params.clientInfo : metaCi;
    return {
      idKey: hasId ? JSON.stringify(o.id) : null,
      isNotification: method !== null && !hasId,
      method,
      tool,
      menu,
      clientName: s(ci.name, 100),
      clientVersion: s(ci.version, 50),
      protocol: (method === "initialize" ? s(params.protocolVersion, 20) : s(meta["io.modelcontextprotocol/protocolVersion"], 20)) ?? headerProtocol,
    };
  });
}

// 응답 본문 → 메시지별 결과. 배치의 각 메시지를 id 로 따로 판정한다.
export function judge(msgs: MsgInfo[], httpStatus: number, text: string | null): Array<{ outcome: Outcome; code: number | null }> {
  let parsed: unknown;
  if (text) { try { parsed = JSON.parse(text); } catch { parsed = undefined; } }
  const responses = Array.isArray(parsed) ? parsed : parsed === undefined ? [] : [parsed];
  const byId = new Map<string, Record<string, any>>();
  let orphan: Record<string, any> | null = null; // id 가 null 인 오류(요청 전체 거절: 깨진 JSON·잘못된 요청)
  for (const r of responses) {
    if (!isObj(r)) continue;
    if (r.id === null || r.id === undefined) orphan = orphan ?? r;
    else byId.set(JSON.stringify(r.id), r);
  }
  const httpErr = { outcome: "http_error" as Outcome, code: httpStatus };
  return msgs.map((m) => {
    // 알림은 응답 본문이 없는 것이 정상(202). 받아들였으면 ok (2026-11-06: no_response 로 적어 실패처럼 읽혔다)
    if (m.isNotification) return httpStatus >= 400 ? httpErr : { outcome: "ok", code: null };
    const r = m.idKey !== null ? byId.get(m.idKey) : undefined;
    if (r) {
      if (isObj(r.error)) return { outcome: "rpc_error", code: typeof r.error.code === "number" ? r.error.code : null };
      if (m.method === "tools/call" && isObj(r.result) && r.result.isError === true) return { outcome: "tool_error", code: null };
      return { outcome: "ok", code: null };
    }
    if (orphan && isObj(orphan.error)) return { outcome: "rpc_error", code: typeof orphan.error.code === "number" ? orphan.error.code : null };
    if (httpStatus >= 400) return httpErr;
    return { outcome: "unknown", code: null };
  });
}

// res.write·res.end 로 나가는 본문을 복사만 한다(인자·반환값·순서는 원래대로). 끝나면 onDone 1회.
function tapResponse(res: VercelResponse, onDone: (status: number, text: string | null) => void): void {
  const chunks: Buffer[] = [];
  let size = 0;
  let overflow = false;
  let done = false;
  const collect = (chunk: unknown, enc: unknown) => {
    if (overflow || chunk === undefined || chunk === null || typeof chunk === "function") return;
    const b = typeof chunk === "string" ? Buffer.from(chunk, typeof enc === "string" ? (enc as BufferEncoding) : "utf8")
      : chunk instanceof Uint8Array ? Buffer.from(chunk) : null;
    if (!b) return;
    size += b.length;
    if (size > MAX_CAPTURE) { overflow = true; chunks.length = 0; return; }
    chunks.push(b);
  };
  const origWrite = res.write;
  const origEnd = res.end;
  (res as any).write = function (this: unknown, chunk: unknown, ...rest: unknown[]) {
    try { collect(chunk, rest[0]); } catch { /* 기록 실패는 응답에 영향 없음 */ }
    return (origWrite as any).call(this, chunk, ...rest);
  };
  (res as any).end = function (this: unknown, chunk?: unknown, ...rest: unknown[]) {
    try { collect(chunk, rest[0]); } catch { /* 무시 */ }
    const ret = (origEnd as any).call(this, chunk, ...rest);
    if (!done) {
      done = true;
      try { onDone(res.statusCode, overflow ? null : Buffer.concat(chunks).toString("utf8")); } catch { /* 무시 */ }
    }
    return ret;
  };
}

function sendRows(rows: CallRow[]): void {
  const base = process.env.LOWDOWN_SUPABASE_URL;
  const key = process.env.LOWDOWN_SUPABASE_KEY;
  if (!base || !key || rows.length === 0) return;
  const p = fetch(`${base}/rest/v1/mcp_calls`, {
    method: "POST",
    headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify(rows),
    signal: AbortSignal.timeout(3000),
  })
    .then((r) => { if (!r.ok) console.error("mcp_calls insert failed", r.status); })
    .catch((err) => console.error("mcp_calls insert failed", err));
  try { waitUntil(p); } catch { /* 런타임 밖(테스트 등): 이미 시작한 요청이 그대로 진행 */ }
}

// 요청 1건의 관측 준비. 본문을 알게 되면 setMessages, 응답이 끝나면 기록한다. 여기서 나는 오류는 응답에 영향을 주지 않는다.
function observe(req: VercelRequest, res: VercelResponse) {
  const started = Date.now();
  const requestId = randomUUID();
  let msgs: MsgInfo[] = [];
  const ua = header(req, "user-agent", 300);
  const agentId = header(req, "x-agent-id", 200);
  const headerProtocol = header(req, "mcp-protocol-version", 20);
  try {
    tapResponse(res, (status, text) => {
      const duration = Date.now() - started;
      const base = { request_id: requestId, http_method: s(req.method, 10) ?? "?", http_status: status, batch_size: msgs.length,
        declared_agent_id: agentId, duration_ms: duration, user_agent: ua };
      let rows: CallRow[];
      if (msgs.length === 0) {
        // POST 가 아닌 요청(GET 405 등)은 HTTP 단계 거절 → http_error. POST 인데 메시지가 없으면(깨진 JSON 등) 응답의 JSON-RPC 오류를 따른다.
        const j = req.method !== "POST" ? { outcome: "http_error" as Outcome, code: status }
          : judge([{ idKey: null, isNotification: false, method: null, tool: null, menu: null, clientName: null, clientVersion: null, protocol: null }], status, text)[0]!;
        rows = [{ ...base, msg_index: null, rpc_method: null, is_notification: false, tool_name: null, menu: null,
          declared_client_name: null, declared_client_version: null, protocol_version: headerProtocol, outcome: j.outcome, error_code: j.code }];
      } else {
        const results = judge(msgs, status, text);
        rows = msgs.map((m, i) => ({ ...base, msg_index: i, rpc_method: m.method, is_notification: m.isNotification, tool_name: m.tool, menu: m.menu,
          declared_client_name: m.clientName, declared_client_version: m.clientVersion, protocol_version: m.protocol,
          outcome: results[i]!.outcome, error_code: results[i]!.code }));
      }
      sendRows(rows);
    });
  } catch { /* 관측 준비 실패: 기록 없이 응답만 */ }
  return {
    setMessages(body: unknown) {
      try { msgs = describeMessages(body, headerProtocol); } catch { msgs = []; }
    },
  };
}

// server/discover (MCP 2026-07-28, SEP-2575: 서버 MUST 구현) — SDK(1.32.2, 최신)가 아직 모르는 메서드라 여기서 직접 답한다.
//   supportedVersions 는 SDK 가 실제로 처리하는 버전만 적는다(2025-11-25 이하, initialize 방식). 2026-07-28 을 적지 않으므로
//   새 스펙 클라이언트는 이 답을 보고 initialize 방식으로 내려온다. SDK 가 새 스펙을 지원하면 SDK 쪽으로 넘긴다.
//   단일 메시지일 때만 여기서 답한다(배치 안의 server/discover 는 SDK 가 오류로 답하던 그대로).
export function discoverResult(id: unknown): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id,
    result: {
      resultType: "complete",
      supportedVersions: [...SUPPORTED_PROTOCOL_VERSIONS],
      capabilities: { tools: {} },
      _meta: { "io.modelcontextprotocol/serverInfo": { name: "lowdown", version: VERSION } },
      instructions: INSTRUCTIONS,
      ttlMs: 3_600_000,
      cacheScope: "public",
    },
  };
}
export function isDiscover(body: unknown): body is { id: unknown } {
  return isObj(body) && body.method === "server/discover" && "id" in body && body.id !== undefined && body.id !== null;
}

// ── 서버 카드 (2026-11-05, SEP-2127 Final, experimental-ext-server-card 526201b) ──
//   GET /mcp/server-card            → application/mcp-server-card+json (<streamable-http-url>/server-card, 권장 위치)
//   GET /.well-known/ai-catalog.json → application/ai-catalog+json (카드 1개를 url 로 가리킴)
//   vercel.json rewrite → /api/mcp?meta=server-card|ai-catalog. 이 파일에서 내보내는 이유: supportedProtocolVersions·version 을
//   server/discover(discoverResult)와 같은 값에서 읽어 둘이 어긋나지 않게(스펙: 다르면 클라이언트는 server/discover 를 따름).
//   도구 목록·capabilities 는 넣지 않는다(스펙상 제외). 요청은 middleware.ts 의 edge_hits 에만 남고 mcp_calls 에는 넣지 않는다.
//   name 은 스펙 형식(역도메인/이름)이라 MCP Registry 이름(server.json)과 같게, version 은 serverInfo 와 같게 둔다.
export const SERVER_CARD_NAME = "io.github.PetShopBros/lowdown-proxy";
export const SERVER_CARD_DESCRIPTION = "Look up MCP Registry declarations, npm package status, and daily observations of MCP servers.";
export function serverCard(): Record<string, unknown> {
  return {
    $schema: "https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json",
    name: SERVER_CARD_NAME,
    version: VERSION,
    description: SERVER_CARD_DESCRIPTION,
    title: "Lowdown",
    websiteUrl: SITE,
    repository: { url: "https://github.com/PetShopBros/lowdown-proxy", source: "github" },
    remotes: [{ type: "streamable-http", url: `${SITE}/mcp`, supportedProtocolVersions: [...SUPPORTED_PROTOCOL_VERSIONS] }],
  };
}
export function aiCatalog(): Record<string, unknown> {
  return {
    specVersion: "1.0",
    entries: [{ identifier: "urn:air:lowdown-proxy.vercel.app:mcp:lowdown-proxy", type: "application/mcp-server-card+json", url: `${SITE}/mcp/server-card` }],
  };
}
const META_DOCS: Record<string, { type: string; body: () => Record<string, unknown> }> = {
  "server-card": { type: "application/mcp-server-card+json", body: serverCard },
  "ai-catalog": { type: "application/ai-catalog+json", body: aiCatalog },
};
/** 카드·카탈로그 응답. CORS·캐시·ETag/304 는 docs/discovery.md 의 MUST/SHOULD 그대로. */
export function sendMeta(req: VercelRequest, res: VercelResponse, kind: string) {
  const doc = META_DOCS[kind]!;
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, If-None-Match");
  res.setHeader("Access-Control-Expose-Headers", "ETag");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.setHeader("Allow", "GET, HEAD, OPTIONS");
    return res.status(405).json({ error: "method_not_allowed", message: "Use GET.", retryable: false });
  }
  const text = JSON.stringify(doc.body(), null, 2);
  const etag = `"${createHash("sha256").update(text).digest("hex").slice(0, 32)}"`;
  res.setHeader("ETag", etag);
  res.setHeader("Cache-Control", "public, max-age=3600");
  res.setHeader("Content-Type", `${doc.type}; charset=utf-8`);
  const inm = header(req, "if-none-match", 500);
  if (inm && inm.split(",").map((t) => t.trim().replace(/^W\//, "")).includes(etag)) return res.status(304).end();
  if (req.method === "HEAD") return res.status(200).end();
  return res.status(200).send(text);
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const meta = typeof req.query?.meta === "string" ? req.query.meta : null;
  if (meta && meta in META_DOCS) return sendMeta(req, res, meta);
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "content-type, accept, mcp-protocol-version, mcp-session-id, mcp-method, mcp-name, authorization");
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return res.status(204).end();
  const obs = observe(req, res);
  // 세션 없는 서버: 서버가 먼저 보내는 스트림(GET)·세션 종료(DELETE)는 쓰지 않는다
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST, OPTIONS");
    return res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed. Send MCP JSON-RPC messages with POST." }, id: null });
  }
  // 본문이 JSON 이 아니면 서버 오류(500)가 아니라 JSON-RPC 형식 오류(400, -32700)로 답한다.
  // Vercel 은 Content-Type: application/json 본문이 깨져 있으면 req.body 를 읽을 때 예외를 던진다(2026-10-31, PowerShell 따옴표로 확인).
  let body: unknown;
  try {
    body = req.body;
    if (typeof body === "string") body = JSON.parse(body);
  } catch {
    return res.status(400).json({ jsonrpc: "2.0", error: { code: -32700, message: "Parse error: the request body is not valid JSON." }, id: null });
  }
  obs.setMessages(body);
  if (isDiscover(body)) return res.status(200).json(discoverResult(body.id));
  const host = header(req, "host", 200) ?? "lowdown-proxy.vercel.app";
  const server = buildServer({ host, ua: header(req, "user-agent", 300) });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  } catch (err) {
    console.error("mcp error", err);
    if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
  }
}
