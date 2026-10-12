import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createRequire } from "node:module";
import { z } from "zod";

import { getNodeId } from "./node-identity.js";

const BASE_URL = process.env.LOWDOWN_API_URL ?? "https://lowdown-proxy.vercel.app";
const NODE_ID = getNodeId();
// dist/mcp-server.js 기준 ../package.json (npm 패키지에 항상 포함됨)
const PKG_VERSION: string = (() => {
  try {
    return (createRequire(import.meta.url)("../package.json") as { version: string }).version;
  } catch {
    return "0.0.0";
  }
})();

const server = new McpServer({
  name: "lowdown",
  version: PKG_VERSION,
});

// ── 1. get_lowdown ──────────────────────────────────────────────
server.tool(
  "get_lowdown",
  "Look up what Lowdown has recorded about an agent, tool, or service. " +
  "Returns interactions reported by agents (count, outcomes, success rate) and, for MCP Registry servers, " +
  "a separate `scanner` block: daily Lowdown Scanner observations of initialize and tools/list reachability, " +
  "HTTP status, tool count, and tool-schema changes over the last 30 days. " +
  "Scanner data is observation, not a score. A target outside the observed sample returns `observed: false`, " +
  "which says nothing about its status.",
  {
    target: z.string().describe(
      "MCP Registry name with the mcp: prefix (e.g. 'mcp:io.github.user/server'), a short name, or an id such as 'agent:some-agent-id'"
    ),
  },
  async ({ target }) => {
    const res = await fetch(
      `${BASE_URL}/api/reputation/${encodeURIComponent(target)}`,
      { headers: { "x-lowdown-source": "organic", "x-lowdown-node-id": NODE_ID } }
    );
    const data = await res.json() as any;
    return {
      content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    };
  }
);

// ── 2. record_interaction ───────────────────────────────────────
server.tool(
  "record_interaction",
  "Record an interaction with an agent, tool, or service after using it. " +
  "Helps build the shared reputation dataset for the community.",
  {
    actor: z.string().describe("Your agent/system identifier"),
    target: z.string().describe("Identifier of what you used"),
    target_type: z.enum(["agent", "tool", "service", "human"]),
    task_type: z.string().describe("What kind of task was performed. e.g. 'web_search', 'code_gen'"),
    outcome: z.enum(["success", "partial", "failure"]),
failure_type: z.enum(["invalid_arguments", "timeout", "server_error", "tool_error", "unknown"])
  .optional()
  .describe("Required when outcome is failure. Distinguish tool failure vs argument error."),
latency_ms: z.number().optional().describe("How long it took in milliseconds"),
    source: z.enum(["organic", "seeded", "synthetic"]).optional(),
  },
  async ({ actor, target, target_type, task_type, outcome, failure_type, latency_ms, source }) => {
    const res = await fetch(`${BASE_URL}/api/interactions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ actor, target, target_type, task_type, outcome, failure_type, latency_ms, source }),
    });
    const data = await res.json() as any;
    return {
      content: [{ type: "text", text: data.ok ? "Recorded." : `Error: ${data.error}` }],
    };
  }
);

// ── 3. compare_tools ────────────────────────────────────────────
server.tool(
  "compare_tools",
  "Compare 2 to 5 tools or agents by the interactions reported to Lowdown. " +
  "Candidates are ordered by reported success rate (candidates without data last), with interaction count and confidence. " +
  "Scanner observations are not used for the ordering. " +
  "A suggestion is included only when the first candidate has at least 5 reported interactions.",
  {
    candidates: z.array(z.string()).min(2).max(5).describe(
      "List of tool/agent identifiers to compare"
    ),
    task_type: z.string().optional().describe(
      "Filter by task type if you want task-specific comparison"
    ),
  },
  async ({ candidates, task_type }) => {
    // compare_calls 로그 (fire-and-forget)
    void fetch(`${BASE_URL}/api/compare-log`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ candidates, task_type: task_type ?? null, node_id: NODE_ID }),
    }).catch(() => {});

    // 후보들을 병렬로 조회 (task_type 있으면 필터 적용)
    const results = await Promise.all(
      candidates.map(async (target) => {
        try {
          const url = task_type
            ? `${BASE_URL}/api/reputation/${encodeURIComponent(target)}?task_type=${encodeURIComponent(task_type)}`
            : `${BASE_URL}/api/reputation/${encodeURIComponent(target)}`;
          const res = await fetch(url, { headers: { "x-lowdown-source": "organic" } });
          return await res.json() as any;
        } catch {
          return { target, interactions: 0, success_rate: null as any, confidence: "none" };
        }
      })
    );

    // 규칙 기반 정렬: success_rate 내림차순, 데이터 없으면 맨 뒤
    const ranked = [...results].sort((a, b) => {
      if (a.success_rate === null && b.success_rate === null) return 0;
      if (a.success_rate === null) return 1;
      if (b.success_rate === null) return -1;
      return Number(b.success_rate) - Number(a.success_rate);
    });

    const summary = ranked
      .map((r, i) => {
        const rate = r.success_rate !== null ? `${(Number(r.success_rate) * 100).toFixed(0)}%` : "no data";
        const latency = r.avg_latency_ms ? `, latency: ${r.avg_latency_ms}ms` : "";
        return `${i + 1}. ${r.target} — success: ${rate}, interactions: ${r.interactions}, confidence: ${r.confidence}${latency}`;
      })
      .join("\n");

    // recommendation + reason 자동 생성
    const best = ranked[0];
    let recommendation: { target: string; reason: string } | null = null;

    if (best?.interactions >= 5 && best?.success_rate !== null) {
      const rate = `${(Number(best.success_rate) * 100).toFixed(0)}%`;
      const latencyNote = best.avg_latency_ms ? ` with avg latency ${best.avg_latency_ms}ms` : "";
      const taskNote = task_type ? ` for ${task_type}` : "";
      recommendation = {
        target: best.target,
        reason: `Highest success rate${taskNote} (${rate}) across ${best.interactions} observations${latencyNote}.`,
      };
    }

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          task_type: task_type ?? null,
          candidates: ranked,
          recommendation: recommendation ?? { target: null, reason: "Insufficient interaction history for a reliable comparison." },
        }, null, 2),
      }],
    };
  }
);

// ── 4. get_node_stats ───────────────────────────────────────────
server.tool(
  "get_node_stats",
  "Get your node's contribution stats and network position. " +
  "Shows how much your proxy has contributed to the Lowdown network.",
  {},
  async () => {
    const res = await fetch(
      `${BASE_URL}/api/node/${encodeURIComponent(NODE_ID)}`,
      { headers: { "x-lowdown-source": "organic" } }
    );
    const data = await res.json() as any;
    return {
      content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    };
  }
);

// ── 서버 시작 ───────────────────────────────────────────────────
const transport = new StdioServerTransport();
await server.connect(transport);