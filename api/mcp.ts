import type { VercelRequest, VercelResponse } from "@vercel/node";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

// 원격 MCP 서버 (2026-10-30). https://lowdown-proxy.vercel.app/mcp (vercel.json rewrite → /api/mcp)
// 로컬 stdio 서버(src/mcp-server.ts)와 같은 조회를 HTTPS 주소 하나로 연다. 인증 없음(공개 데이터).
// Streamable HTTP, 세션 없음(stateless), 일반 JSON 응답 → 요청 1건 = 함수 1회.
// 읽기 전용 도구만: get_lowdown, find_servers(2026-11-01, /api/find 를 부름). 쓰기(record_interaction)·노드 통계·비교는 열지 않는다.
// instructions(2026-11-01): 연결만 하고 도구를 부르지 않는 클라이언트가 많아(10/31 Claude-User tools/call 0건) 쓰임을 initialize 에서 알린다.
// 조회는 같은 배포의 조회 API 를 부른다(판정 로직을 다시 만들지 않음). ref=mcp 로 원격 MCP 경유를 따로 센다.
//   nc=1 → CDN 캐시를 건너뛰어 모든 원격 조회가 reputation_lookups 에 남는다(실사용 측정). 서버 카드가 있으면 카드 1행으로 답한다.
//   middleware.ts 는 ref=mcp 안쪽 호출을 세지 않는다(바깥 /mcp 요청 1건만 edge_hits 에).

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
export const FIND_STATES = ["answered", "auth_required", "list_failed", "no_response", "invalid_response", "mixed"] as const;
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
  "When no name is known yet, use find_servers to list servers by observed facts (for example servers that answered without credentials, sorted by tool count). " +
  "Full menu card: https://lowdown-proxy.vercel.app/menu.json. " +
  "Facts are observations, not scores; absence of data says nothing about a server.";

export type FindArgs = {
  q?: string; state?: string; answered_days?: number; stable_days?: number; tools_min?: number; tools_max?: number;
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

export function buildServer(ctx: { host: string; ua: string | null; fetchImpl?: typeof fetch }): McpServer {
  const doFetch = ctx.fetchImpl ?? fetch;
  const server = new McpServer({ name: "lowdown", version: VERSION }, { instructions: INSTRUCTIONS });

  // 같은 배포의 API 를 부르고 MCP 응답으로 바꾼다 (get_lowdown·find_servers 공통)
  const callApi = async (url: string, what: string) => {
    let r: Response;
    try {
      r = await doFetch(url, {
        headers: { "user-agent": ctx.ua ?? "lowdown-remote-mcp", accept: "application/json" },
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      return { isError: true, content: [{ type: "text" as const, text: `Lowdown ${what} did not answer. Retry later.` }] };
    }
    const text = await r.text();
    if (r.status === 503) return { isError: true, content: [{ type: "text" as const, text: "Lowdown cannot read its records right now (HTTP 503). Retry later; this is not 'no record'." }] };
    if (!r.ok) return { isError: true, content: [{ type: "text" as const, text: `Lowdown ${what} answered HTTP ${r.status}: ${text.slice(0, 2000)}` }] };
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
      if (!TARGET_RE.test(t)) return { isError: true, content: [{ type: "text", text: "target must be printable ASCII without spaces, up to 300 characters." }] };
      return callApi(lookupUrl(ctx.host, t, menu ?? null), "lookup");
    },
  );

  server.registerTool(
    "find_servers",
    {
      title: "Find MCP servers by observed facts",
      description:
        "List public MCP servers by facts Lowdown observed, when you do not have a server name yet. " +
        "Filter by the latest daily check (e.g. state 'answered' = answered initialize and tools/list without credentials), days answered in the last 30, " +
        "how long the tool list has been unchanged, tool count, Registry status and package state; sort by one key. " +
        "No score or ranking: order is only the chosen sort key. Each result carries a lookup URL; call get_lowdown with its name for the full record. " +
        "Tool lists are recorded from 2026-10-20, so a long stable_days returns nothing yet.",
      inputSchema: {
        q: z.string().min(2).max(100).optional().describe("Part of the Registry name, e.g. 'github' or 'io.github.user'"),
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

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "content-type, accept, mcp-protocol-version, mcp-session-id, authorization");
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return res.status(204).end();
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
