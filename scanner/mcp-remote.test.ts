import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, describe, test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

// 원격 MCP (api/mcp.ts): 세션 없는 Streamable HTTP, 읽기 전용 get_lowdown, 조회 API 를 ref=mcp&nc=1 로 부른다.
type Mod = { default: (req: any, res: any) => Promise<unknown>; lookupUrl: (h: string, t: string, m: string | null) => string };
const load = async () => (await import('../api/mcp.ts' as string)) as Mod;

const seen: Array<{ url: string; ua: string | null }> = [];
const realFetch = globalThis.fetch;
let server: http.Server;
let base = '';

before(async () => {
  // 조회 API 호출만 가짜로 (MCP 클라이언트 ↔ 로컬 서버는 진짜 fetch)
  globalThis.fetch = (async (u: any, init?: any) => {
    const url = String(u instanceof Request ? u.url : u);
    if (url.startsWith('https://lowdown.test/api/find')) {
      seen.push({ url, ua: new Headers(init?.headers).get('user-agent') });
      return new Response(JSON.stringify({ query: 'state=answered', count: 1, results: [{ name: 'a.b/c' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.startsWith('https://lowdown.test/api/reputation/')) {
      seen.push({ url, ua: new Headers(init?.headers).get('user-agent') });
      if (url.includes('mcp%3Adown')) return new Response('{}', { status: 503 });
      return new Response(JSON.stringify({ target: 'mcp:a.b/c', message: 'Answered initialize and tools/list.' }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return realFetch(u, init);
  }) as typeof fetch;
  const { default: handler } = await load();
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      const r: any = req;
      // Vercel 처럼: 깨진 JSON 이면 req.body 를 읽을 때 예외
      let parsed: unknown;
      let bad = false;
      try { parsed = body ? JSON.parse(body) : undefined; } catch { bad = true; }
      Object.defineProperty(r, 'body', { configurable: true, get() { if (bad) throw new Error('Invalid JSON'); return parsed; } });
      r.query = {};
      r.headers.host = 'lowdown.test';
      const s: any = res;
      s.status = (c: number) => { res.statusCode = c; return s; };
      s.json = (b: unknown) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(b)); return s; };
      await handler(r, s);
    });
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', () => ok()));
  base = `http://127.0.0.1:${(server.address() as any).port}/mcp`;
});
after(() => { globalThis.fetch = realFetch; server.close(); });

describe('원격 MCP', () => {
  test('조회 주소: ref=mcp, nc=1, menu(full 은 생략)', async () => {
    const { lookupUrl } = await load();
    assert.equal(lookupUrl('h', 'mcp:a.b/c', null), 'https://h/api/reputation/mcp%3Aa.b%2Fc?ref=mcp&nc=1');
    assert.equal(lookupUrl('h', 'mcp:a.b/c', 'install-check'), 'https://h/api/reputation/mcp%3Aa.b%2Fc?ref=mcp&nc=1&menu=install-check');
    assert.equal(lookupUrl('h', 'x', 'full'), 'https://h/api/reputation/x?ref=mcp&nc=1');
  });

  test('도구 목록 · 읽기 전용 표시 · 호출 · 503', async () => {
    const client = new Client({ name: 'test', version: '0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(base), { requestInit: { headers: { 'user-agent': 'Claude-User/1.0' } } }));
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name), ['get_lowdown', 'find_servers']);
    const instructions = client.getInstructions() ?? '';
    assert.match(instructions, /whether to install, add, connect or trust an MCP server, use get_lowdown/);
    assert.match(instructions, /or one part: status, packages, tools, declared-vs-observed, content-flags, tool-list, registry, history, agent-reports; omit for everything\./);
    assert.match(instructions, /'install-check'.*'change-watch'/);
    assert.match(instructions, /https:\/\/lowdown-proxy\.vercel\.app\/menu\.json/);
    assert.match(instructions, /use find_servers/);
    assert.equal(tools[1]!.annotations?.readOnlyHint, true);
    assert.equal(tools[0]!.title, 'Look up recorded facts about an MCP server');
    assert.equal(tools[0]!.annotations?.readOnlyHint, true);
    assert.equal(tools[0]!.annotations?.destructiveHint, false);

    const ok: any = await client.callTool({ name: 'get_lowdown', arguments: { target: 'mcp:a.b/c', menu: 'install-check' } });
    assert.equal(ok.isError ?? false, false, JSON.stringify(ok));
    assert.match(ok.content[0].text, /Answered initialize/);
    assert.equal(seen.at(-1)!.url, 'https://lowdown.test/api/reputation/mcp%3Aa.b%2Fc?ref=mcp&nc=1&menu=install-check');
    assert.equal(seen.at(-1)!.ua, 'Claude-User/1.0');

    const down: any = await client.callTool({ name: 'get_lowdown', arguments: { target: 'mcp:down/x' } });
    assert.equal(down.isError, true);
    assert.match(down.content[0].text, /503/);

    const found: any = await client.callTool({ name: 'find_servers', arguments: { state: 'answered', sort: 'tools', limit: 10 } });
    assert.equal(found.isError ?? false, false, JSON.stringify(found));
    assert.match(found.content[0].text, /a\.b\/c/);
    assert.equal(seen.at(-1)!.url, 'https://lowdown.test/api/find?ref=mcp&nc=1&state=answered&sort=tools&limit=10');
    assert.equal(seen.at(-1)!.ua, 'Claude-User/1.0');

    const badFind: any = await client.callTool({ name: 'find_servers', arguments: { state: 'nope' } });
    assert.equal(badFind.isError, true);

    const bad: any = await client.callTool({ name: 'get_lowdown', arguments: { target: 'has space' } });
    assert.equal(bad.isError, true);
    await client.close();
  });

  test('깨진 JSON 본문은 400 (-32700), 500 이 아님', async () => {
    const r = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: '{jsonrpc:2.0,id:1,method:tools/list}',
    });
    assert.equal(r.status, 400);
    const j = (await r.json()) as any;
    assert.equal(j.error.code, -32700);
  });

  test('GET 은 405', async () => {
    const r = await realFetch(base, { method: 'GET', headers: { accept: 'text/event-stream' } });
    assert.equal(r.status, 405);
  });
});

// ── 메시지별 기록 (mcp_calls, 2026-11-05) ─────────────────────
// 원칙: 관측은 응답을 바꾸지 않는다. 기록 켬/끔·기록 실패와 상관없이 상태·헤더·본문이 같아야 한다.
describe('원격 MCP 메시지별 기록', () => {
  const rows: any[] = [];
  let failRows = false;
  const prev = { url: process.env.LOWDOWN_SUPABASE_URL, key: process.env.LOWDOWN_SUPABASE_KEY };
  let inner: typeof fetch;
  before(() => {
    inner = globalThis.fetch;
    globalThis.fetch = (async (u: any, init?: any) => {
      const url = String(u instanceof Request ? u.url : u);
      if (url === 'https://supabase.test/rest/v1/mcp_calls') {
        if (failRows) throw new Error('db down');
        rows.push(...JSON.parse(init.body));
        return new Response(null, { status: 201 });
      }
      return inner(u, init);
    }) as typeof fetch;
  });
  after(() => {
    globalThis.fetch = inner;
    if (prev.url === undefined) delete process.env.LOWDOWN_SUPABASE_URL; else process.env.LOWDOWN_SUPABASE_URL = prev.url;
    if (prev.key === undefined) delete process.env.LOWDOWN_SUPABASE_KEY; else process.env.LOWDOWN_SUPABASE_KEY = prev.key;
  });
  const on = () => { process.env.LOWDOWN_SUPABASE_URL = 'https://supabase.test'; process.env.LOWDOWN_SUPABASE_KEY = 'k'; };
  const off = () => { delete process.env.LOWDOWN_SUPABASE_URL; delete process.env.LOWDOWN_SUPABASE_KEY; };
  const settle = async (n: number) => { for (let i = 0; i < 50 && rows.length < n; i++) await new Promise((r) => setTimeout(r, 10)); };
  const post = async (body: unknown, extra: Record<string, string> = {}) => {
    const r = await realFetch(base, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'user-agent': 'probe-test/1', ...extra },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
    const headers = Object.fromEntries([...r.headers].filter(([k]) => k !== 'date'));
    return { status: r.status, headers, text: await r.text() };
  };
  test('server/discover (2026-07-28): SDK 가 처리하는 버전만 알리고, _meta 의 clientInfo 를 기록', async () => {
    on(); rows.length = 0;
    const meta = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientInfo': { name: 'new-client', version: '2.0' }, 'io.modelcontextprotocol/clientCapabilities': {} };
    const r = await post({ jsonrpc: '2.0', id: 'd1', method: 'server/discover', params: { _meta: meta } });
    assert.equal(r.status, 200);
    const j = JSON.parse(r.text);
    assert.equal(j.id, 'd1');
    assert.equal(j.result.resultType, 'complete');
    assert.ok(j.result.supportedVersions.includes('2025-11-25'));
    assert.ok(!j.result.supportedVersions.includes('2026-07-28'));
    assert.deepEqual(j.result.capabilities, { tools: {} });
    assert.equal(j.result._meta['io.modelcontextprotocol/serverInfo'].name, 'lowdown');
    assert.match(j.result.instructions, /get_lowdown/);
    assert.equal(j.result.cacheScope, 'public');
    await settle(1);
    const d = rows.find((x) => x.rpc_method === 'server/discover');
    assert.equal(d.outcome, 'ok');
    assert.equal(d.declared_client_name, 'new-client');
    assert.equal(d.declared_client_version, '2.0');
    assert.equal(d.protocol_version, '2026-07-28');
    // 알림(id 없음)·배치는 이 경로를 타지 않는다
    const n = await post({ jsonrpc: '2.0', method: 'server/discover' });
    assert.notEqual(n.status, 200);
  });

  const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'probe-client', version: '9.1' } } };

  test('initialize · 알림 · tools/list · tools/call 을 메시지별로 기록 (인자 값은 저장하지 않음)', async () => {
    on(); rows.length = 0;
    const client = new Client({ name: 'probe-client', version: '9.1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(base), { requestInit: { headers: { 'user-agent': 'Claude-User/1.0', 'x-agent-id': 'eip155:8453:0xabc/7' } } }));
    await client.listTools();
    await client.callTool({ name: 'get_lowdown', arguments: { target: 'mcp:a.b/c', menu: 'install-check' } });
    await client.callTool({ name: 'get_lowdown', arguments: { target: 'mcp:down/x' } });
    await client.callTool({ name: 'find_servers', arguments: { does: 'secret words', limit: 3 } });
    await client.close();
    await settle(6);
    const by = (m: string) => rows.filter((r) => r.rpc_method === m);
    const i = by('initialize')[0];
    assert.equal(i.declared_client_name, 'probe-client');
    assert.equal(i.declared_client_version, '9.1');
    assert.equal(i.outcome, 'ok');
    assert.equal(i.declared_agent_id, 'eip155:8453:0xabc/7');
    assert.equal(i.user_agent, 'Claude-User/1.0');
    assert.ok(i.protocol_version);
    const n = by('notifications/initialized')[0];
    assert.equal(n.is_notification, true);
    assert.equal(n.outcome, 'no_response');
    assert.equal(by('tools/list')[0].outcome, 'ok');
    const calls = by('tools/call');
    assert.deepEqual(calls.map((c) => [c.tool_name, c.menu, c.outcome]), [
      ['get_lowdown', 'install-check', 'ok'],
      ['get_lowdown', null, 'tool_error'],
      ['find_servers', null, 'ok'],
    ]);
    // 후속 요청에는 clientInfo 가 없다 → 다른 요청을 같은 클라이언트로 추정해 채우지 않는다
    assert.equal(by('tools/list')[0].declared_client_name, null);
    // SDK 클라이언트는 initialize 뒤 GET /mcp(서버 스트림)를 한 번 열어 본다 → 405, http_error 로 남는다
    const gets = rows.filter((r) => r.http_method === 'GET');
    assert.ok(gets.every((g) => g.outcome === 'http_error' && g.error_code === 405 && g.rpc_method === null));
    for (const r of rows.filter((x) => x.http_method === 'POST')) {
      assert.equal(typeof r.request_id, 'string');
      assert.equal(r.http_method, 'POST');
      assert.equal(r.batch_size, 1);
      assert.equal(typeof r.duration_ms, 'number');
    }
    const all = JSON.stringify(rows);
    assert.doesNotMatch(all, /a\.b\/c|down\/x|secret words/); // 도구 인자·검색어 미저장
    assert.doesNotMatch(all, /127\.0\.0\.1/); // IP 미저장
  });

  test('배치: 메시지마다 1줄, batch_size 는 전체 수, request_id 같음, 결과는 각각 판정', async () => {
    on(); rows.length = 0;
    const r = await post([init, { jsonrpc: '2.0', method: 'notifications/initialized' }, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, { jsonrpc: '2.0', id: 3, method: 'nope/unknown' }]);
    await settle(4);
    assert.equal(rows.length, 4);
    assert.ok(rows.every((x) => x.batch_size === 4 && x.request_id === rows[0].request_id));
    assert.deepEqual(rows.map((x) => x.msg_index), [0, 1, 2, 3]);
    const res = rows.map((x) => x.outcome);
    // 서버가 배치를 받으면 메시지별 결과, 거절하면 요청 전체 오류로 같은 판정이 붙는다(어느 쪽이든 응답은 서버 그대로)
    if (r.status === 200) {
      assert.deepEqual(res, ['ok', 'no_response', 'ok', 'rpc_error']);
      assert.equal(rows[3].error_code, -32601);
    } else {
      assert.ok(res.every((o, i) => (i === 1 ? o === 'http_error' : o === 'rpc_error' || o === 'http_error')), JSON.stringify(rows));
    }
  });

  test('GET 405 → http_error, 깨진 JSON → rpc_error(-32700)', async () => {
    on(); rows.length = 0;
    const g = await realFetch(base, { method: 'GET', headers: { accept: 'text/event-stream', 'user-agent': 'node' } });
    assert.equal(g.status, 405);
    await settle(1);
    assert.equal(rows[0].http_method, 'GET');
    assert.equal(rows[0].outcome, 'http_error');
    assert.equal(rows[0].error_code, 405);
    assert.equal(rows[0].rpc_method, null);
    assert.equal(rows[0].batch_size, 0);
    rows.length = 0;
    const b = await post('{jsonrpc:2.0,id:1,method:tools/list}');
    assert.equal(b.status, 400);
    await settle(1);
    assert.equal(rows[0].outcome, 'rpc_error');
    assert.equal(rows[0].error_code, -32700);
  });

  test('기록 켬·끔·기록 실패에도 상태·헤더·본문이 같다', async () => {
    const cases: unknown[] = [init, { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_lowdown', arguments: { target: 'mcp:a.b/c' } } },
      { jsonrpc: '2.0', method: 'notifications/initialized' }, '{broken'];
    for (const c of cases) {
      off(); const a = await post(c);
      on(); failRows = false; const b = await post(c);
      failRows = true; const d = await post(c);
      failRows = false;
      assert.deepEqual(b, a, `기록 켬 ≠ 끔: ${JSON.stringify(c)}`);
      assert.deepEqual(d, a, `기록 실패 ≠ 끔: ${JSON.stringify(c)}`);
    }
  });
});
