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
      r.body = body ? JSON.parse(body) : undefined;
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
    assert.deepEqual(tools.map((t) => t.name), ['get_lowdown']);
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

    const bad: any = await client.callTool({ name: 'get_lowdown', arguments: { target: 'has space' } });
    assert.equal(bad.isError, true);
    await client.close();
  });

  test('GET 은 405', async () => {
    const r = await realFetch(base, { method: 'GET', headers: { accept: 'text/event-stream' } });
    assert.equal(r.status, 405);
  });
});
