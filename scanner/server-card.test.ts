import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

// 서버 카드 (api/mcp.ts, SEP-2127): /mcp/server-card · /.well-known/ai-catalog.json
type Mod = {
  default: (req: any, res: any) => Promise<unknown>;
  serverCard: () => any;
  aiCatalog: () => any;
  discoverResult: (id: unknown) => any;
  SITE: string;
};
const load = async () => (await import('../api/mcp.ts' as string)) as Mod;

function call(handler: Mod['default'], meta: string, method = 'GET', headers: Record<string, string> = {}) {
  return new Promise<{ status: number; headers: Record<string, string>; body: string }>((ok) => {
    const h: Record<string, string> = {};
    let status = 200;
    const res: any = {
      setHeader: (k: string, v: string) => { h[k.toLowerCase()] = String(v); },
      status: (c: number) => { status = c; return res; },
      end: (b?: string) => ok({ status, headers: h, body: b ?? '' }),
      send: (b: string) => ok({ status, headers: h, body: b }),
      json: (b: unknown) => ok({ status, headers: h, body: JSON.stringify(b) }),
      on: () => res,
    };
    void handler({ method, query: { meta }, headers: { host: 'lowdown.test', ...headers } }, res);
  });
}

describe('서버 카드', () => {
  test('카드 형식: 스키마 v1, 이름 형식, 설명 100자 이하, 도구·capabilities 없음', async () => {
    const { serverCard } = await load();
    const c = serverCard();
    assert.equal(c.$schema, 'https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json');
    assert.match(c.name, /^[a-zA-Z0-9.-]+\/[a-zA-Z0-9._-]+$/);
    assert.ok(c.description.length >= 1 && c.description.length <= 100);
    assert.ok(c.title.length <= 100);
    assert.equal(c.tools, undefined);
    assert.equal(c.capabilities, undefined);
    assert.equal(c.remotes.length, 1);
    assert.equal(c.remotes[0].type, 'streamable-http');
    assert.equal(c.remotes[0].url, 'https://lowdown-proxy.vercel.app/mcp');
  });

  test('server/discover 와 버전·이름이 어긋나지 않는다', async () => {
    const { serverCard, discoverResult } = await load();
    const c = serverCard();
    const d = discoverResult(1).result;
    assert.deepEqual(c.remotes[0].supportedProtocolVersions, d.supportedVersions);
    assert.equal(c.version, d._meta['io.modelcontextprotocol/serverInfo'].version);
  });

  test('카드 이름 = MCP Registry 이름(server.json), 원격 주소도 같다', async () => {
    const { serverCard } = await load();
    const sj = JSON.parse(readFileSync(new URL('../server.json', import.meta.url), 'utf8'));
    const c = serverCard();
    assert.equal(c.name, sj.name);
    assert.equal(c.description, sj.description);
    assert.equal(c.remotes[0].url, sj.remotes[0].url);
  });

  test('버전 한 곳: 원격 serverInfo = package.json = server.json(항목·npm 패키지)', async () => {
    const { serverCard } = await load();
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    const sj = JSON.parse(readFileSync(new URL('../server.json', import.meta.url), 'utf8'));
    assert.equal(serverCard().version, pkg.version);
    assert.equal(sj.version, pkg.version);
    assert.equal(sj.packages.find((p: any) => p.registryType === 'npm' && p.identifier === 'lowdown-proxy').version, pkg.version);
  });

  test('AI Catalog: 카드 1개를 url 로 가리킴', async () => {
    const { aiCatalog } = await load();
    const a = aiCatalog();
    assert.equal(a.specVersion, '1.0');
    assert.equal(a.entries.length, 1);
    assert.equal(a.entries[0].type, 'application/mcp-server-card+json');
    assert.equal(a.entries[0].url, 'https://lowdown-proxy.vercel.app/mcp/server-card');
    assert.match(a.entries[0].identifier, /^urn:air:[^:]+:mcp:[^:]+$/);
  });

  test('HTTP: 미디어 타입 · CORS · 캐시 · ETag/304 · 405', async () => {
    const { default: handler } = await load();
    const r = await call(handler, 'server-card');
    assert.equal(r.status, 200);
    assert.equal(r.headers['content-type'], 'application/mcp-server-card+json; charset=utf-8');
    assert.equal(r.headers['access-control-allow-origin'], '*');
    assert.equal(r.headers['access-control-allow-methods'], 'GET');
    assert.equal(r.headers['access-control-allow-headers'], 'Content-Type, If-None-Match');
    assert.equal(r.headers['access-control-expose-headers'], 'ETag');
    assert.equal(r.headers['cache-control'], 'public, max-age=3600');
    assert.ok(r.headers.etag);
    assert.equal(JSON.parse(r.body).name, 'io.github.PetShopBros/lowdown-proxy');

    const n = await call(handler, 'server-card', 'GET', { 'if-none-match': r.headers.etag! });
    assert.equal(n.status, 304);
    assert.equal(n.body, '');
    const w = await call(handler, 'server-card', 'GET', { 'if-none-match': `W/${r.headers.etag}` });
    assert.equal(w.status, 304);
    const other = await call(handler, 'server-card', 'GET', { 'if-none-match': '"nope"' });
    assert.equal(other.status, 200);

    const head = await call(handler, 'server-card', 'HEAD');
    assert.equal(head.status, 200);
    assert.equal(head.body, '');
    const opt = await call(handler, 'server-card', 'OPTIONS');
    assert.equal(opt.status, 204);
    const post = await call(handler, 'server-card', 'POST');
    assert.equal(post.status, 405);

    const cat = await call(handler, 'ai-catalog');
    assert.equal(cat.status, 200);
    assert.equal(cat.headers['content-type'], 'application/ai-catalog+json; charset=utf-8');
    assert.equal(JSON.parse(cat.body).entries[0].url, 'https://lowdown-proxy.vercel.app/mcp/server-card');
  });

  test('알 수 없는 meta 는 MCP 처리로 넘어간다(GET → 405 JSON-RPC)', async () => {
    const { default: handler } = await load();
    const r = await call(handler, 'nope');
    assert.equal(r.status, 405);
    assert.equal(JSON.parse(r.body).jsonrpc, '2.0');
  });
});
