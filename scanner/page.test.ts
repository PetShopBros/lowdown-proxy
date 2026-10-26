import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';

// 서버 기록 페이지: API 응답을 그대로 HTML 로, 모든 값 이스케이프, 관찰 없는 서버는 noindex, 없는 이름은 404.
type Mod = {
  default: (req: unknown, res: unknown) => Promise<unknown>;
  renderServerPage: (name: string, j: Record<string, unknown>) => { html: string; noindex: boolean } | null;
  renderIndex: (rows: Array<Record<string, unknown>>) => string;
  renderSitemap: (rows: Array<Record<string, unknown>>) => string;
  nameOf: (t: unknown) => string | null;
};
const load = async () => (await import('../api/page.ts' as string)) as Mod;

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const api = (o: Record<string, unknown> = {}) => ({
  target: 'mcp:ai.trendsmcp/google-trends',
  message: 'Answered initialize and tools/list on all 21 daily checks recorded in the last 30 days (2026-10-06 to 2026-10-26); 5 tools listed. On 2026-10-24 a tool description with a URL appeared (new domain: www.trendsmcp.ai).',
  status: { state: 'answered', latest_check: '2026-10-26', stale: false, days_since_latest_check: 0, checks_30d: { observed: 21, answered: 21, auth_required: 0, no_response: 0, mixed: 0 } },
  registry: { listed: true, name: 'ai.trendsmcp/google-trends', declared_version: '1.0.7', status: 'active', remote_hosts: ['google-trends.api.trendsmcp.ai'] },
  scanner: {
    definition_changes: {
      note: 'Tool definitions changed on 2 of 20 compared days.',
      events: [
        { day: '2026-10-24', kinds: ['schema_changed', 'tool_names_changed'], tool_count: { from: 4, to: 5 }, new_flags: [{ rule: 'description_url', definitions: { from: 0, to: 1 }, new_domains: ['www.trendsmcp.ai'] }] },
      ],
    },
    tools: { names: ['trends___get_growth', '<script>alert(1)</script>'], observed_at: '2026-10-26T01:18:12Z' },
  },
  source: { lookup: 'https://lowdown-proxy.vercel.app/api/reputation/mcp:ai.trendsmcp/google-trends' },
  ...o,
});

describe('서버 기록 페이지', () => {
  test('제목·첫 단락은 API 첫 문장, 질문형 소제목, 표지와 도메인', async () => {
    const { renderServerPage } = await load();
    const p = renderServerPage('ai.trendsmcp/google-trends', api())!;
    assert.equal(p.noindex, false);
    assert.match(p.html, /<title>ai\.trendsmcp\/google-trends MCP server: daily status and tool changes \| Lowdown<\/title>/);
    assert.match(p.html, /<p class="lead">Answered initialize and tools\/list on all 21 daily checks/);
    assert.match(p.html, /<h2>Does it respond\?<\/h2>/);
    assert.match(p.html, /<h2>Does it require authentication\?<\/h2>[\s\S]*did not return HTTP 401\/403 on any of the 21 observed days/);
    assert.match(p.html, /2026-10-24<\/strong>: input or output schemas changed, tool names changed; tool count 4 → 5; a tool description with a URL appeared \(www\.trendsmcp\.ai\)/);
    assert.match(p.html, /<link rel="canonical" href="https:\/\/lowdown-proxy\.vercel\.app\/servers\/ai\.trendsmcp\/google-trends">/);
    assert.match(p.html, /not the official page of this server/);
    assert.match(p.html, /<meta property="og:site_name" content="Lowdown">/);
    assert.match(p.html, /<meta property="og:url" content="https:\/\/lowdown-proxy\.vercel\.app\/servers\/ai\.trendsmcp\/google-trends">/);
    assert.ok(!p.html.includes('noindex'));
  });

  test('원격 서버가 보낸 문자열은 이스케이프된다', async () => {
    const { renderServerPage } = await load();
    const p = renderServerPage('ai.trendsmcp/google-trends', api({ message: 'x"><script>bad()</script>' }))!;
    assert.ok(!p.html.includes('<script>'));
    assert.match(p.html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  });

  test('관찰 기록이 없으면 noindex, Registry 에도 없으면 null(404)', async () => {
    const { renderServerPage } = await load();
    const p = renderServerPage('io.github.x/y', api({ status: undefined, scanner: { observed: false } }))!;
    assert.equal(p.noindex, true);
    assert.match(p.html, /<meta name="robots" content="noindex">/);
    assert.match(p.html, /no daily check recorded/);
    assert.equal(renderServerPage('io.github.x/y', { message: 'no MCP Registry record found', registry: { listed: false } }), null);
  });

  test('목록·sitemap: 안전한 이름만, 마지막 점검일', async () => {
    const { renderIndex, renderSitemap, nameOf } = await load();
    const rows = [
      { target_id: 'mcp:ai.trendsmcp/google-trends', latest_day: '2026-10-26', latest_state: 'answered' },
      { target_id: 'mcp:bad name/<x>', latest_day: '2026-10-26', latest_state: 'answered' },
      { target_id: 'npm:pkg', latest_day: '2026-10-26', latest_state: 'answered' },
    ];
    assert.equal(nameOf('mcp:a.b/c-d_e'), 'a.b/c-d_e');
    assert.equal(nameOf('mcp:a/b/c'), null);
    const idx = renderIndex(rows);
    assert.match(idx, /href="\/servers\/ai\.trendsmcp\/google-trends"/);
    assert.ok(!idx.includes('bad name'));
    assert.match(idx, /1 MCP Registry servers with a recorded daily check/);
    const sm = renderSitemap(rows);
    assert.match(sm, /<url><loc>https:\/\/lowdown-proxy\.vercel\.app\/servers\/ai\.trendsmcp\/google-trends<\/loc><lastmod>2026-10-26<\/lastmod><\/url>/);
    assert.equal((sm.match(/<url>/g) ?? []).length, 2); // 목록 페이지 + 1
  });
});

function fakeRes() {
  const r = {
    code: 0, headers: {} as Record<string, string>, body: '' as unknown,
    setHeader(k: string, v: string) { r.headers[k.toLowerCase()] = v; return r; },
    status(c: number) { r.code = c; return r; },
    send(b: unknown) { r.body = b; return r; },
  };
  return r;
}

describe('페이지 핸들러', () => {
  const call = async (query: Record<string, string>, ua = 'ClaudeBot/1.0') => {
    delete process.env.LOWDOWN_SUPABASE_URL;
    delete process.env.LOWDOWN_SUPABASE_KEY;
    const { default: handler } = await load();
    const res = fakeRes();
    await handler({ method: 'GET', query, headers: { host: 'lowdown-proxy.vercel.app', 'user-agent': ua } }, res);
    return res;
  };

  test('방문자 User-Agent 와 ref=page 로 API 를 부르고, HTML 을 캐시 없이 내려준다', async () => {
    const seen: Array<{ url: string; ua: string | null }> = [];
    globalThis.fetch = (async (u: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(u), ua: new Headers(init?.headers).get('user-agent') });
      return new Response(JSON.stringify(api()), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    const res = await call({ kind: 'server', ns: 'ai.trendsmcp', name: 'google-trends' }, 'Claude-SearchBot/1.0');
    assert.equal(res.code, 200);
    assert.equal(seen[0]!.url, 'https://lowdown-proxy.vercel.app/api/reputation/mcp:ai.trendsmcp/google-trends?ref=page');
    assert.equal(seen[0]!.ua, 'Claude-SearchBot/1.0');
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.match(String(res.body), /<!doctype html>/);
  });

  test('API 가 503 이면 페이지도 503 + Retry-After', async () => {
    globalThis.fetch = (async () => new Response('{}', { status: 503 })) as typeof fetch;
    const res = await call({ kind: 'server', ns: 'a', name: 'b' });
    assert.equal(res.code, 503);
    assert.equal(res.headers['retry-after'], '120');
  });

  test('형식이 맞지 않는 이름은 API 를 부르지 않고 404', async () => {
    let called = false;
    globalThis.fetch = (async () => { called = true; return new Response('{}'); }) as typeof fetch;
    const res = await call({ kind: 'server', ns: '..', name: '<x>' });
    assert.equal(res.code, 404);
    assert.equal(called, false);
  });
});
