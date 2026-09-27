import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { getNodeId } from "./node-identity.js";

const BASE_URL = process.env.LOWDOWN_API_URL ?? "https://lowdown-proxy.vercel.app";
const NODE_ID = getNodeId();

const server = new McpServer({
  name: "lowdown",
  version: "0.1.0",
});

// ── 1. get_lowdown ──────────────────────────────────────────────
server.tool(
  "get_lowdown",
  "Get the interaction history and reputation of an agent, tool, or service. " +
  "Call this before choosing between providers to make an informed decision.",
  {
    target: z.string().describe(
      "Identifier of the agent/tool/service. e.g. 'mcp:vendor/tool-name' or 'agent:some-agent-id'"
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
    latency_ms: z.number().optional().describe("How long it took in milliseconds"),
    source: z.enum(["organic", "seeded", "synthetic"]).optional(),
  },
  async ({ actor, target, target_type, task_type, outcome, latency_ms, source }) => {
    const res = await fetch(`${BASE_URL}/api/interactions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ actor, target, target_type, task_type, outcome, latency_ms, source }),
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
  "Compare multiple tools or agents by their recorded interaction data. " +
  "Returns a ranked list with success rates and confidence levels.",
  {
    candidates: z.array(z.string()).min(2).max(5).describe(
      "List of tool/agent identifiers to compare"
    ),
    task_type: z.string().optional().describe(
      "Filter by task type if you want task-specific comparison"
    ),
  },
  async ({ candidates, task_type }) => {
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