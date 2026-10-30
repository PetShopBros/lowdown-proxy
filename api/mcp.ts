import type { VercelRequest, VercelResponse } from "@vercel/node";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

// 원격 MCP 서버 (2026-10-30). https://lowdown-proxy.vercel.app/mcp (vercel.json rewrite → /api/mcp)
// 로컬 stdio 서버(src/mcp-server.ts)와 같은 조회를 HTTPS 주소 하나로 연다. 인증 없음(공개 데이터).
// Streamable HTTP, 세션 없음(stateless), 일반 JSON 응답 → 요청 1건 = 함수 1회.
// 1차는 읽기 전용 도구만: get_lowdown. 쓰기(record_interaction)·노드 통계·비교는 열지 않는다.
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
  const server = new McpServer({ name: "lowdown", version: VERSION });

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
          "Optional. 'install-check' (before installing: status, packages, declared-vs-observed, content-flags), 'change-watch' (what changed recently), " +
          "or one part: status, packages, tools, declared-vs-observed, content-flags, tool-list, registry, history, agent-reports. Omit or 'full' for everything.",
        ),
      },
      annotations: { title: "Look up recorded facts about an MCP server", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ target, menu }) => {
      const t = target.trim();
      if (!TARGET_RE.test(t)) return { isError: true, content: [{ type: "text", text: "target must be printable ASCII without spaces, up to 300 characters." }] };
      let r: Response;
      try {
        r = await doFetch(lookupUrl(ctx.host, t, menu ?? null), {
          headers: { "user-agent": ctx.ua ?? "lowdown-remote-mcp", accept: "application/json" },
          signal: AbortSignal.timeout(20_000),
        });
      } catch {
        return { isError: true, content: [{ type: "text", text: "Lowdown lookup did not answer. Retry later." }] };
      }
      const text = await r.text();
      if (r.status === 503) return { isError: true, content: [{ type: "text", text: "Lowdown cannot read its records right now (HTTP 503). Retry later; this is not 'no record'." }] };
      if (!r.ok) return { isError: true, content: [{ type: "text", text: `Lowdown lookup answered HTTP ${r.status}: ${text.slice(0, 2000)}` }] };
      return { content: [{ type: "text", text }] };
    },
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
  const host = header(req, "host", 200) ?? "lowdown-proxy.vercel.app";
  const server = buildServer({ host, ua: header(req, "user-agent", 300) });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("mcp error", err);
    if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
  }
}
