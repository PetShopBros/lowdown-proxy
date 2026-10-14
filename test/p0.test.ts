// P0(0.1.17) 판정·기록 경로 테스트. 실행: npm test  (먼저 tsc 로 dist 를 만든다)
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { classifyResponse, defaultTargetLabel, schemaHash } from "../dist/classify.js";
import { buildRecord, trackRequest } from "../dist/proxy.js";
import { recordInteraction } from "../dist/record.js";
import { hashTools } from "../scanner/lib.ts";
import { validateInteraction } from "../api/interactions.ts";
import { isRatedRow, summarizeRows } from "../api/reputation/[target].ts";

describe("classifyResponse", () => {
  test("tools/call 정상 → success / tool_call", () => {
    assert.deepEqual(classifyResponse("tools/call", { id: 1, result: { content: [], isError: false } }), {
      request_kind: "tool_call",
      outcome: "success",
    });
  });
  test("tools/call result.isError → failure / tool_error / tool", () => {
    assert.deepEqual(classifyResponse("tools/call", { id: 1, result: { content: [{ type: "text", text: "bad date" }], isError: true } }), {
      request_kind: "tool_call",
      outcome: "failure",
      failure_type: "tool_error",
      error_layer: "tool",
    });
  });
  test("-32602 → 잘못된 요청(request), 서버 실패 아님", () => {
    const c = classifyResponse("tools/call", { id: 1, error: { code: -32602, message: "Unknown tool: x" } });
    assert.equal(c.error_layer, "request");
    assert.equal(c.failure_type, "invalid_arguments");
  });
  test("-32601 → request / protocol_error", () => {
    const c = classifyResponse("tools/call", { id: 1, error: { code: -32601, message: "Method not found" } });
    assert.equal(c.error_layer, "request");
    assert.equal(c.failure_type, "protocol_error");
  });
  test("-32603 → server / server_error", () => {
    const c = classifyResponse("tools/call", { id: 1, error: { code: -32603, message: "Internal error" } });
    assert.equal(c.error_layer, "server");
    assert.equal(c.failure_type, "server_error");
  });
  test("timeout 메시지 → server / timeout", () => {
    const c = classifyResponse("tools/call", { id: 1, error: { code: -32001, message: "Request timed out" } });
    assert.equal(c.error_layer, "server");
    assert.equal(c.failure_type, "timeout");
  });
  test("tools/call 이 아닌 요청 → protocol", () => {
    assert.equal(classifyResponse("initialize", { id: 0, result: {} }).request_kind, "protocol");
    assert.equal(classifyResponse("tools/list", { id: 0, result: { tools: [] } }).request_kind, "protocol");
    // isError 는 tools/call 결과에서만 의미가 있다
    assert.equal(classifyResponse("ping", { id: 0, result: { isError: true } }).outcome, "success");
  });
});

describe("schemaHash", () => {
  test("Scanner hashTools 와 같은 값 (도구·키 순서 무관)", () => {
    const tools = [
      { name: "b", description: "x", inputSchema: { type: "object", properties: { q: { type: "string" } } } },
      { name: "a", inputSchema: { properties: {}, type: "object" }, outputSchema: { type: "object" } },
    ];
    const reordered = [
      { inputSchema: { type: "object", properties: {} }, name: "a", outputSchema: { type: "object" } },
      { name: "b", inputSchema: { properties: { q: { type: "string" } }, type: "object" }, description: "changed text" },
    ];
    assert.equal(schemaHash(tools), hashTools(tools).schema_hash);
    assert.equal(schemaHash(tools), schemaHash(reordered)); // 설명문은 schema_hash 에 들어가지 않는다
  });
});

describe("buildRecord (프록시 흐름)", () => {
  const opts = { actor: "a1", targetLabel: "server-everything", source: "organic" as const, nodeId: "ld_0123456789ab" };

  test("initialize → server_version, tools/list → schema_hash 가 이후 행에 찍힌다", () => {
    const pending = new Map();
    const state: { serverVersion?: string; schemaHash?: string } = {};
    trackRequest(pending, JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params: {} }), 1000);
    const r0 = buildRecord(pending, state, JSON.stringify({ jsonrpc: "2.0", id: 0, result: { serverInfo: { name: "s", version: "2.1.0" } } }), opts, 1012);
    assert.equal(r0?.request_kind, "protocol");
    assert.equal(r0?.server_version, "2.1.0");
    assert.equal(r0?.latency_ms, 12);

    const tools = [{ name: "echo", inputSchema: { type: "object" } }];
    trackRequest(pending, JSON.stringify({ id: 1, method: "tools/list" }));
    buildRecord(pending, state, JSON.stringify({ id: 1, result: { tools } }), opts);
    assert.equal(state.schemaHash, schemaHash(tools));

    trackRequest(pending, JSON.stringify({ id: 2, method: "tools/call", params: { name: "echo", arguments: {} } }));
    const r2 = buildRecord(pending, state, JSON.stringify({ id: 2, result: { content: [], isError: true } }), opts);
    assert.equal(r2?.task_type, "echo");
    assert.equal(r2?.outcome, "failure");
    assert.equal(r2?.error_layer, "tool");
    assert.equal(r2?.server_version, "2.1.0");
    assert.equal(r2?.schema_hash, schemaHash(tools));
    assert.equal(r2?.node_id, "ld_0123456789ab");
  });

  test("페이지 일부인 tools/list 는 해시하지 않는다", () => {
    const pending = new Map();
    const state: { schemaHash?: string } = {};
    trackRequest(pending, JSON.stringify({ id: 1, method: "tools/list" }));
    buildRecord(pending, state, JSON.stringify({ id: 1, result: { tools: [{ name: "a" }], nextCursor: "p2" } }), opts);
    trackRequest(pending, JSON.stringify({ id: 2, method: "tools/list", params: { cursor: "p2" } }));
    buildRecord(pending, state, JSON.stringify({ id: 2, result: { tools: [{ name: "b" }] } }), opts);
    assert.equal(state.schemaHash, undefined);
  });

  test("대기 중이 아닌 응답·알림·JSON 아님 → 기록 없음", () => {
    const pending = new Map();
    assert.equal(buildRecord(pending, {}, JSON.stringify({ id: 9, result: {} }), opts), null);
    assert.equal(buildRecord(pending, {}, JSON.stringify({ method: "notifications/progress" }), opts), null);
    assert.equal(buildRecord(pending, {}, "not json", opts), null);
  });
});

describe("defaultTargetLabel", () => {
  test("명령줄 전체가 아니라 패키지/파일 이름 하나", () => {
    assert.equal(defaultTargetLabel("npx", ["-y", "@modelcontextprotocol/server-everything", "--api-key", "sk-secret"]), "@modelcontextprotocol/server-everything");
    assert.equal(defaultTargetLabel("node", ["C:\\Users\\A\\work\\server.js", "--token=abc"]), "server.js");
    assert.equal(defaultTargetLabel("cmd", ["/c", "npx", "-y", "some-mcp"]), "some-mcp");
    assert.equal(defaultTargetLabel("uvx", ["mcp-server-fetch"]), "mcp-server-fetch");
    assert.equal(defaultTargetLabel("/usr/local/bin/my-server", []), "my-server");
  });
});

describe("recordInteraction (공개 API 경유)", () => {
  test("POST /api/interactions 로 recorder_version 을 붙여 보낸다", async () => {
    let called: { url: string; body: any } | null = null;
    const fetchImpl = (async (url: string, init: any) => {
      called = { url, body: JSON.parse(init.body) };
      return new Response("{}", { status: 201 });
    }) as unknown as typeof fetch;
    process.env.LOWDOWN_API_URL = "https://example.test/";
    await recordInteraction({ actor: "a", target: "t", target_type: "tool", task_type: "x", outcome: "success" }, { fetchImpl });
    delete process.env.LOWDOWN_API_URL;
    assert.equal(called!.url, "https://example.test/api/interactions");
    assert.equal(typeof called!.body.recorder_version, "string");
  });
  test("네트워크 오류여도 throw 하지 않는다", async () => {
    const fetchImpl = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    await recordInteraction({ actor: "a", target: "t", target_type: "tool", task_type: "x", outcome: "success" }, { fetchImpl });
  });
  test("LOWDOWN_RECORD=0 이면 보내지 않는다", async () => {
    let n = 0;
    const fetchImpl = (async () => {
      n++;
      return new Response("{}");
    }) as unknown as typeof fetch;
    process.env.LOWDOWN_RECORD = "0";
    await recordInteraction({ actor: "a", target: "t", target_type: "tool", task_type: "x", outcome: "success" }, { fetchImpl });
    delete process.env.LOWDOWN_RECORD;
    assert.equal(n, 0);
  });
});

describe("validateInteraction (POST /api/interactions)", () => {
  const base = { actor: "a", target: "t", target_type: "tool", task_type: "echo", outcome: "success" };
  test("기존 클라이언트 페이로드(dcl-agent-mcp 형태)는 그대로 통과, request_kind 기본값 reported", () => {
    const v = validateInteraction({ ...base, source: "organic", result: "ignored" }) as any;
    assert.equal(v.row.request_kind, "reported");
    assert.equal(v.row.source, "organic");
    assert.equal("result" in v.row, false);
  });
  test("프록시 페이로드", () => {
    const v = validateInteraction({
      ...base, outcome: "failure", failure_type: "tool_error", error_layer: "tool", request_kind: "tool_call",
      latency_ms: 12, node_id: "ld_0123456789ab", server_version: "1.0.0", schema_hash: "a".repeat(64), recorder_version: "0.1.17",
    }) as any;
    assert.equal(v.row.error_layer, "tool");
  });
  test("거절: 형식 오류", () => {
    const bad: Array<Record<string, unknown>> = [
      { ...base, actor: "x".repeat(201) },
      { ...base, node_id: "ld_XYZ" },
      { ...base, latency_ms: -1 },
      { ...base, latency_ms: 1.5 },
      { ...base, failure_type: "nope" },
      { ...base, request_kind: "nope" },
      { ...base, error_layer: "tool" }, // success 인데 error_layer
      { ...base, schema_hash: "not-hex" },
      { ...base, target_type: "entity" },
    ];
    for (const b of bad) assert.ok("error" in validateInteraction(b), JSON.stringify(b));
  });
});

describe("성공률 기준 (reputation)", () => {
  test("organic 도구 호출·보고만 rated. protocol·잘못된 요청·seeded·synthetic 제외, 0.1.16 이하 행도 처리", () => {
    const rows = [
      { outcome: "success", source: "organic", request_kind: "tool_call", task_type: "echo" },
      { outcome: "failure", source: "organic", request_kind: "tool_call", error_layer: "tool", failure_type: "tool_error", task_type: "echo" },
      { outcome: "failure", source: "organic", request_kind: "tool_call", error_layer: "request", failure_type: "invalid_arguments", task_type: "echo" },
      { outcome: "success", source: "organic", request_kind: "protocol", task_type: "tools/list" },
      { outcome: "success", source: "organic", request_kind: null, task_type: "initialize" }, // 구 행, 비도구
      { outcome: "success", source: "organic", request_kind: null, task_type: "explore" }, // 구 행, 보고
      { outcome: "failure", source: "synthetic", request_kind: "reported", task_type: "echo" },
      { outcome: "success", source: "seeded", request_kind: "reported", task_type: "echo" },
    ];
    assert.deepEqual(rows.map(isRatedRow), [true, true, false, false, false, true, false, false]);
    const s = summarizeRows("t", rows);
    assert.equal(s.interactions, 8);
    assert.equal(s.rated_interactions, 3);
    assert.equal(s.success_rate, 0.667);
    assert.equal(s.protocol_requests, 2);
    assert.equal(s.rejected_requests, 1);
    assert.deepEqual([s.organic_count, s.seeded_count, s.synthetic_count], [6, 1, 1]);
    assert.deepEqual(s.failure_breakdown, { tool_error: 1 });
  });
  test("rated 0 건이면 success_rate null", () => {
    assert.equal(summarizeRows("t", [{ outcome: "success", source: "synthetic", task_type: "x" }]).success_rate, null);
  });
});
