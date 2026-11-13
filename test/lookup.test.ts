// 연결 시점 확인(0.1.22) 테스트. 실행: npm test  (먼저 tsc 로 dist 를 만든다)
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";

import { META_KEY, addBundleToInitialize, bundleFrom, fetchBundle, inferLookupTarget, lookupEnabled } from "../dist/lookup.js";

const BODY = {
  schema_version: 1,
  target: "npm:@acme/mcp-server",
  resolved_target: "mcp:io.github.acme/mcp-server",
  summary: { auth: "not_required", auth_basis: "latest_check", last_answered: "2026-11-13", last_reached: "2026-11-13", latest_check: "2026-11-13", state: "answered" },
  message: "Answered initialize and tools/list on all 12 daily checks recorded in the last 30 days (2026-11-02 to 2026-11-13); 4 tools listed. MCP Registry declaration recorded; no agent-reported interactions.",
  evidence_levels: { present: ["registry_declaration", "protocol_check_without_credentials", "package_registry_metadata"] },
  packages: [{ registry: "npm", name: "@acme/mcp-server", declared_version: "1.0.0", npm: { status: "found", latest: "1.0.1", latest_deprecated: false } }],
  menu: "install-check",
  source: { name: "Lowdown", cite_url: "https://lowdown-proxy.vercel.app/servers/io.github.acme/mcp-server?ref=cite" },
};

describe("inferLookupTarget", () => {
  test("npx·bunx·npm exec·pnpm dlx → npm:, 버전·옵션 제거", () => {
    assert.equal(inferLookupTarget("npx", ["-y", "@modelcontextprotocol/server-everything@latest", "--api-key", "sk-secret"]), "npm:@modelcontextprotocol/server-everything");
    assert.equal(inferLookupTarget("npx", ["-y", "-p", "lowdown-proxy", "lowdown-mcp"]), "npm:lowdown-proxy");
    assert.equal(inferLookupTarget("npx", ["--package=some-mcp@1.2.3", "some-bin"]), "npm:some-mcp");
    assert.equal(inferLookupTarget("npx", ["--registry", "https://r.example", "pkg-a"]), "npm:pkg-a");
    assert.equal(inferLookupTarget("cmd", ["/c", "npx", "-y", "some-mcp"]), "npm:some-mcp");
    assert.equal(inferLookupTarget("C:\\nvm4w\\nodejs\\npx.cmd", ["-y", "some-mcp"]), "npm:some-mcp");
    assert.equal(inferLookupTarget("npm", ["exec", "--", "some-mcp"]), "npm:some-mcp");
    assert.equal(inferLookupTarget("pnpm", ["dlx", "some-mcp"]), "npm:some-mcp");
    assert.equal(inferLookupTarget("bunx", ["some-mcp"]), "npm:some-mcp");
  });
  test("uvx·uv tool run·pipx run → pypi:", () => {
    assert.equal(inferLookupTarget("uvx", ["mcp-server-fetch"]), "pypi:mcp-server-fetch");
    assert.equal(inferLookupTarget("uvx", ["--python", "3.12", "mcp-server-git==0.6.2"]), "pypi:mcp-server-git");
    assert.equal(inferLookupTarget("uvx", ["--from", "awslabs.core-mcp-server@latest", "awslabs.core-mcp-server"]), "pypi:awslabs.core-mcp-server");
    assert.equal(inferLookupTarget("uv", ["tool", "run", "some-mcp[extra]"]), "pypi:some-mcp");
    assert.equal(inferLookupTarget("pipx", ["run", "some-mcp"]), "pypi:some-mcp");
  });
  test("추측하지 않는 경우 → null", () => {
    assert.equal(inferLookupTarget("node", ["C:\\work\\server.js"]), null);
    assert.equal(inferLookupTarget("python", ["-m", "my_server"]), null);
    assert.equal(inferLookupTarget("docker", ["run", "-i", "mcp/fetch"]), null);
    assert.equal(inferLookupTarget("npx", ["./local-dir"]), null);
    assert.equal(inferLookupTarget("npx", ["github:user/repo"]), null);
    assert.equal(inferLookupTarget("npx", ["-c", "some command"]), null);
    assert.equal(inferLookupTarget("uvx", ["git+https://github.com/u/r"]), null);
    assert.equal(inferLookupTarget("npx", ["-y"]), null);
  });
  test("--target 이 mcp:/npm:/pypi: 형식이면 그것", () => {
    assert.equal(inferLookupTarget("node", ["server.js"], "mcp:io.github.u/s"), "mcp:io.github.u/s");
    assert.equal(inferLookupTarget("npx", ["-y", "a"], "my-label"), "npm:a");
  });
  test("LOWDOWN_LOOKUP=0 이면 꺼짐", () => {
    assert.equal(lookupEnabled({ LOWDOWN_LOOKUP: "0" }), false);
    assert.equal(lookupEnabled({}), true);
  });
});

describe("bundleFrom", () => {
  test("한 줄: 확인된 이름 + 응답 message + 인용 주소. _meta 는 응답 값 그대로", () => {
    const b = bundleFrom("npm:@acme/mcp-server", BODY, Date.UTC(2026, 10, 14))!;
    assert.equal(
      b.line,
      "Lowdown install-check for mcp:io.github.acme/mcp-server (dated observations, not a score): " + BODY.message +
        " Record: https://lowdown-proxy.vercel.app/servers/io.github.acme/mcp-server?ref=cite",
    );
    assert.equal(b.meta.resolved_target, "mcp:io.github.acme/mcp-server");
    assert.equal(b.meta.retrieved_at, "2026-11-14T00:00:00.000Z");
    assert.deepEqual(b.meta.summary, BODY.summary);
    assert.equal(b.meta.payment_required, null); // 관측 없음 = null (false 가 아님)
    assert.deepEqual(b.meta.packages, [{ registry: "npm", name: "@acme/mcp-server", status: "found", latest_deprecated: false }]);
    assert.deepEqual(b.meta.evidence_levels, BODY.evidence_levels.present);
  });
  test("cite_url 이 없으면 조회 주소", () => {
    const b = bundleFrom("t", { ...BODY, source: {} })!;
    assert.match(b.line, / Record: https:\/\/lowdown-proxy\.vercel\.app\/api\/reputation\/mcp:io\.github\.acme\/mcp-server\?menu=install-check$/);
    assert.equal(b.meta.record_url, null);
  });
  test("다른 사이트 주소는 쓰지 않는다", () => {
    const b = bundleFrom("t", { ...BODY, source: { cite_url: "https://evil.example/x" } })!;
    assert.equal(b.meta.record_url, null);
    assert.doesNotMatch(b.line, /evil/);
  });
  test("payment 관측이 있으면 그 값", () => {
    const b = bundleFrom("t", { ...BODY, payment: { observed: { latest_check: "2026-11-13", payment_required: true, remotes: [] } } })!;
    assert.equal(b.meta.payment_required, true);
    assert.equal(b.meta.payment_latest_check, "2026-11-13");
  });
  test("message 의 줄바꿈·보이지 않는 문자는 한 줄로, 길면 자른다", () => {
    const b = bundleFrom("t", { ...BODY, message: "a\nb\u200bc " + "x".repeat(900) })!;
    assert.doesNotMatch(b.line, /[\n\u200b]/);
    assert.ok(b.line.length < 700);
  });
  test("기록 없음·오류·확인된 이름 없음 → null (아무것도 붙이지 않음)", () => {
    assert.equal(bundleFrom("t", null), null);
    assert.equal(bundleFrom("t", { error: "not_found" }), null);
    assert.equal(bundleFrom("t", { target: "npm:x", message: "no MCP Registry entry declares the npm package x" }), null);
    assert.equal(bundleFrom("t", { ...BODY, resolved_target: "mcp:bad name/x" }), null);
  });
});

describe("addBundleToInitialize", () => {
  const bundle = bundleFrom("npm:@acme/mcp-server", BODY)!;
  test("instructions 끝에 한 줄, _meta 에 키 하나. 나머지는 그대로", () => {
    const line = JSON.stringify({ jsonrpc: "2.0", id: 0, result: { protocolVersion: "2025-06-18", serverInfo: { name: "s", version: "1" }, instructions: "Use carefully.", _meta: { other: 1 } } });
    const m = JSON.parse(addBundleToInitialize(line, bundle));
    assert.equal(m.result.instructions, `Use carefully.\n\n${bundle.line}`);
    assert.deepEqual(m.result._meta.other, 1);
    assert.equal(m.result._meta[META_KEY].resolved_target, "mcp:io.github.acme/mcp-server");
    assert.equal(m.result.serverInfo.version, "1");
  });
  test("instructions 가 없으면 한 줄만", () => {
    const m = JSON.parse(addBundleToInitialize(JSON.stringify({ id: 0, result: {} }), bundle));
    assert.equal(m.result.instructions, bundle.line);
  });
  test("bundle 없음·오류 응답·JSON 아님 → 원래 줄 그대로", () => {
    const err = JSON.stringify({ id: 0, error: { code: -32603, message: "x" } });
    assert.equal(addBundleToInitialize(err, bundle), err);
    assert.equal(addBundleToInitialize("not json", bundle), "not json");
    const ok = JSON.stringify({ id: 0, result: {} });
    assert.equal(addBundleToInitialize(ok, null), ok);
  });
});

describe("fetchBundle", () => {
  test("install-check 메뉴로 조회, User-Agent 는 lowdown-proxy/… (connect-check)", async () => {
    let seen: { url: string; ua: string } | null = null;
    const fetchImpl = (async (url: string, init: any) => {
      seen = { url, ua: init.headers["user-agent"] };
      return new Response(JSON.stringify(BODY), { status: 200 });
    }) as unknown as typeof fetch;
    const b = await fetchBundle("npm:@acme/mcp-server", { fetchImpl });
    assert.ok(b);
    assert.equal(seen!.url, "https://lowdown-proxy.vercel.app/api/reputation/npm%3A%40acme%2Fmcp-server?menu=install-check");
    assert.match(seen!.ua, /^lowdown-proxy\/\S+ \(connect-check\)$/);
  });
  test("시간 초과·오류 응답·네트워크 오류 → null, throw 하지 않음", async () => {
    const slow = ((_u: string, init: any) =>
      new Promise((_r, rej) => init.signal.addEventListener("abort", () => rej(new Error("aborted"))))) as unknown as typeof fetch;
    const t0 = Date.now();
    assert.equal(await fetchBundle("npm:a", { fetchImpl: slow, timeoutMs: 50 }), null);
    assert.ok(Date.now() - t0 < 1000);
    const e404 = (async () => new Response("{}", { status: 404 })) as unknown as typeof fetch;
    assert.equal(await fetchBundle("npm:a", { fetchImpl: e404 }), null);
    const offline = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;
    assert.equal(await fetchBundle("npm:a", { fetchImpl: offline }), null);
  });
});

// ── 실제 프록시: 가짜 MCP 서버(stdio) + 가짜 Lowdown API(http) ──
const FAKE_SERVER = `
const rl = require("node:readline").createInterface({ input: process.stdin });
rl.on("line", (l) => {
  const m = JSON.parse(l);
  if (m.method === "initialize") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "fake", version: "1.0.0" } } }) + "\\n");
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/message", params: { level: "info", data: "after-init" } }) + "\\n");
  } else if (m.method === "tools/list") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "echo", description: "Echo.", inputSchema: { type: "object" } }] } }) + "\\n");
    setTimeout(() => process.exit(0), 50);
  }
});
`;

async function runThroughProxy(delayMs: number, env: Record<string, string> = {}): Promise<{ lines: any[]; hits: number; ms: number }> {
  let hits = 0;
  const api = createServer((req, res) => {
    hits++;
    setTimeout(() => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(BODY));
    }, delayMs);
  });
  await new Promise<void>((r) => api.listen(0, "127.0.0.1", () => r()));
  const port = (api.address() as any).port;
  const dir = mkdtempSync(join(tmpdir(), "lookup-"));
  const server = join(dir, "server.cjs");
  writeFileSync(server, FAKE_SERVER);
  const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
  const t0 = Date.now();
  const child = spawn(process.execPath, [cli, "--target", "npm:@acme/mcp-server", "--", process.execPath, server], {
    env: { ...process.env, LOWDOWN_RECORD: "0", LOWDOWN_API_URL: `http://127.0.0.1:${port}`, ...env },
    stdio: ["pipe", "pipe", "inherit"],
  });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params: {} }) + "\n");
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) + "\n");
  await new Promise((r) => child.on("exit", r));
  const ms = Date.now() - t0;
  api.closeAllConnections?.();
  api.close();
  return { lines: out.trim().split("\n").map((l) => JSON.parse(l)), hits, ms };
}

describe("프록시 연결 시점 확인 (실제 실행)", () => {
  test("initialize 응답에 붙고, 줄 순서는 그대로, 도구 목록은 바뀌지 않음", async () => {
    const { lines, hits } = await runThroughProxy(0);
    assert.equal(hits, 1);
    assert.deepEqual(lines.map((m) => m.id ?? m.method), [0, "notifications/message", 1]);
    assert.match(lines[0].result.instructions, /^Lowdown install-check for mcp:io\.github\.acme\/mcp-server /);
    assert.equal(lines[0].result._meta[META_KEY].target, "npm:@acme/mcp-server");
    assert.equal(lines[0].result.serverInfo.name, "fake");
    assert.deepEqual(lines[2].result.tools, [{ name: "echo", description: "Echo.", inputSchema: { type: "object" } }]);
  });
  test("조회가 늦으면 기다리지 않고 원래 응답 그대로", async () => {
    const { lines, ms } = await runThroughProxy(3000);
    assert.equal(lines[0].result.instructions, undefined);
    assert.equal(lines[0].result._meta, undefined);
    assert.deepEqual(lines.map((m) => m.id ?? m.method), [0, "notifications/message", 1]);
    assert.ok(ms < 2500, `took ${ms}ms`);
  });
  test("LOWDOWN_LOOKUP=0 이면 조회하지 않음", async () => {
    const { lines, hits } = await runThroughProxy(0, { LOWDOWN_LOOKUP: "0" });
    assert.equal(hits, 0);
    assert.equal(lines[0].result.instructions, undefined);
  });
});
