import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// stdio MCP 서버(dist/mcp-server.js, npm 의 lowdown-mcp): annotations · 오류 응답 (2026-11-15).
// 가짜 조회 API 를 띄우고 LOWDOWN_API_URL 로 가리킨다. HOME 은 임시 폴더(노드 식별자 파일이 실제 홈에 생기지 않게).

let api: http.Server;
let base = "";
let client: Client;

before(async () => {
  api = http.createServer((req, res) => {
    const url = req.url ?? "";
    if (url.startsWith("/api/reputation/mcp%3Adown")) { res.writeHead(503, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "temporarily_unavailable", message: "Lowdown cannot read its records right now.", retryable: true })); return; }
    if (url.startsWith("/api/reputation/notjson")) { res.writeHead(502, { "content-type": "text/html" }); res.end("<html>bad gateway</html>"); return; }
    if (url.startsWith("/api/reputation/")) { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ target: "mcp:a.b/c", message: "Lowdown has no record for this name." })); return; }
    if (url.startsWith("/api/node/")) { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ node_id: "x", interactions: 0 })); return; }
    res.writeHead(404); res.end();
  });
  await new Promise<void>((ok) => api.listen(0, "127.0.0.1", () => ok()));
  base = `http://127.0.0.1:${(api.address() as any).port}`;
  const home = mkdtempSync(join(tmpdir(), "lowdown-home-"));
  client = new Client({ name: "test", version: "1" });
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL("../dist/mcp-server.js", import.meta.url))],
    env: { ...process.env, LOWDOWN_API_URL: base, HOME: home, USERPROFILE: home } as Record<string, string>,
  }));
});
after(async () => { await client?.close(); api.close(); });

describe("stdio MCP 서버", () => {
  test("도구 4개 모두 annotations: 쓰기는 record_interaction 하나뿐", async () => {
    const { tools } = await client.listTools();
    const by = Object.fromEntries(tools.map((t) => [t.name, t]));
    assert.deepEqual(Object.keys(by).sort(), ["compare_tools", "get_lowdown", "get_node_stats", "record_interaction"]);
    for (const n of ["get_lowdown", "compare_tools", "get_node_stats"]) {
      assert.equal(by[n]!.annotations?.readOnlyHint, true, n);
      assert.equal(by[n]!.annotations?.destructiveHint, false, n);
      assert.ok(by[n]!.title, n);
    }
    assert.equal(by.record_interaction!.annotations?.readOnlyHint, false);
    assert.equal(by.record_interaction!.annotations?.destructiveHint, false);
    assert.equal(by.record_interaction!.annotations?.idempotentHint, false);
    assert.match(by.get_lowdown!.description ?? "", /no record for the name/);
    assert.match(by.get_lowdown!.description ?? "", /retryable: true/);
  });

  test("get_lowdown: 기록 없음은 오류가 아니고, 503 은 retryable 오류, JSON 아닌 응답도 오류(예외 아님)", async () => {
    const ok: any = await client.callTool({ name: "get_lowdown", arguments: { target: "mcp:a.b/c" } });
    assert.notEqual(ok.isError, true);
    assert.match(ok.content[0].text, /no record/);
    const down: any = await client.callTool({ name: "get_lowdown", arguments: { target: "mcp:down" } });
    assert.equal(down.isError, true);
    const d = JSON.parse(down.content[0].text);
    assert.equal(d.error, "temporarily_unavailable");
    assert.equal(d.retryable, true);
    assert.equal(d.http_status, 503);
    const bad: any = await client.callTool({ name: "get_lowdown", arguments: { target: "notjson" } });
    assert.equal(bad.isError, true);
    const b = JSON.parse(bad.content[0].text);
    assert.equal(b.http_status, 502);
    assert.equal(b.retryable, true);
  });
});
