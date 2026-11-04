import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

// Agent Observatory (2026-11-05): /agents.json · /agents · /agents/{kind}/{slug} 가 같은 스냅샷을 쓰고, 선언과 관측만 보여주는지.
const agents = (await import('../api/agents.ts' as string)) as any;
const page = (await import('../api/page.ts' as string)) as any;

const NOW = Date.parse('2026-11-05T04:00:00Z');
const entry = (o: Record<string, unknown>) => ({
  name: 'histor', name_key: 'histor', declared_kind: 'prober', slug: 'histor', path: '/agents/prober/histor',
  declared_user_agent: 'histor/0.5.1 (+https://histor.modelmarket.dev/#crawler; read-only: discover + tools/list)',
  user_agent_variants: 1, declared_urls: ['https://histor.modelmarket.dev/'],
  first_seen: '2026-11-03T14:59:01Z', last_seen: '2026-11-05T03:43:00Z', days_seen: 3, visits: 120, requests: 480,
  median_interval_minutes: 31, interval: 'measured', regular: true,
  path_mix: { mcp: 479, discovery_files: 1 },
  mcp: { initialize: { attempts: 10, ok: 10 }, tools_list: { attempts: 10, ok: 10 }, tools_call: { attempts: 0, ok: 0 } },
  declared_client_names: ['histor'], daily: [{ day: '2026-11-04', requests: 300 }, { day: '2026-11-05', requests: 180 }],
  ...o,
});
const snap = (generatedAt = '2026-11-05T03:54:00Z') => ({
  id: 3, generated_at: generatedAt,
  data: {
    schema_version: 1, snapshot_id: 3, generated_at: generatedAt, update_interval: 'hourly',
    window: { from: '2026-10-06T03:54:00Z', to: '2026-11-05T03:54:00Z' }, mcp_recorded_since: '2026-11-04T16:51:00Z',
    totals: { names: 3, regular_names: 1, by_kind: { prober: 2, crawler: 1 }, tools_call_ok: 0 },
    agents: [
      entry({}),
      entry({ name: '<script>alert(1)</script>', name_key: '<script>alert(1)</script>', slug: '-script-alert-1---script-', regular: false, declared_urls: ['javascript:alert(1)'], median_interval_minutes: null, interval: 'unknown' }),
      entry({ name: 'Reflectionbot', name_key: 'reflectionbot', declared_kind: 'crawler', slug: 'reflectionbot', user_agent_variants: 2, regular: false }),
      entry({ name: 'bad', declared_kind: 'ai_user', slug: 'bad' }),
      entry({ name: 'bad2', slug: '../etc' }),
    ],
    aggregates: { ai_user: { requests: 1083 }, http_libraries: { requests: 1706 }, unnamed: { requests: 5678 }, opted_out: { names: 1, requests: 4 } },
  },
});

describe('캐시 시각', () => {
  test('agents.json·페이지가 같은 계산: 다음 매시 59분(UTC)까지', () => {
    for (const f of [agents.agentsCacheSeconds, page.agentsCacheSeconds]) {
      assert.equal(f(Date.parse('2026-11-05T04:00:00Z')), 59 * 60);
      assert.equal(f(Date.parse('2026-11-05T04:59:00Z')), 3600);
      assert.equal(f(Date.parse('2026-11-05T04:58:30Z')), 60);
    }
  });
});

describe('/agents.json', () => {
  test('stale 표시, 스냅샷 그대로', () => {
    assert.equal(agents.withStale(snap(), NOW).stale, false);
    assert.equal(agents.withStale(snap('2026-11-05T01:00:00Z'), NOW).stale, true);
    assert.equal(agents.withStale(snap(), NOW).agents.length, 5);
  });
  test('스냅샷을 읽지 못하면 503 표준 오류', async () => {
    const prev = { u: process.env.LOWDOWN_SUPABASE_URL, k: process.env.LOWDOWN_SUPABASE_KEY };
    delete process.env.LOWDOWN_SUPABASE_URL; delete process.env.LOWDOWN_SUPABASE_KEY;
    const out: any = { headers: {} };
    const res: any = { setHeader: (k: string, v: string) => { out.headers[k.toLowerCase()] = v; }, status: (c: number) => { out.status = c; return res; }, json: (b: unknown) => { out.body = b; return res; }, send: () => res, end: () => res };
    await agents.default({ method: 'GET', headers: {}, query: {} }, res);
    assert.equal(out.status, 503);
    assert.equal(out.body.error, 'temporarily_unavailable');
    assert.equal(out.headers['retry-after'], String(out.body.retry_after_seconds));
    if (prev.u !== undefined) process.env.LOWDOWN_SUPABASE_URL = prev.u;
    if (prev.k !== undefined) process.env.LOWDOWN_SUPABASE_KEY = prev.k;
  });
});

describe('/agents 목록', () => {
  const html = page.renderAgents(snap(), NOW);
  test('선언 이름·성격, 이스케이프, 성격·주소가 이상한 항목은 빼고 링크는 kind/slug', () => {
    assert.match(html, /<a href="\/agents\/prober\/histor">histor<\/a> <span class="muted">regular<\/span>/);
    assert.match(html, /<a href="\/agents\/crawler\/reflectionbot">Reflectionbot<\/a>/);
    assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
    assert.ok(!html.includes('<script>alert(1)</script>'));
    assert.ok(!html.includes('>bad<') && !html.includes('../etc') && !html.includes('bad2'));
  });
  test('관측 수치·주기·경로·MCP 단계, 합계만 두는 묶음, 기록 시작일', () => {
    assert.ok(html.includes('about every 31 min'));
    assert.ok(html.includes('/mcp 479 · discovery files 1'));
    assert.ok(html.includes('10/10 · 10/10 · 0/0'));
    assert.ok(html.includes('1,083 requests') && html.includes('1,706 requests') && html.includes('5,678 requests'));
    assert.ok(html.includes('Names removed on request: 1 names'));
    assert.ok(html.includes('MCP messages recorded since 2026-11-04'));
    assert.ok(html.includes('not a verified identity'));
    assert.match(html, /It is not a ranking/);
    assert.doesNotMatch(html, /trustworthy|trusted|safe server|malicious|suspicious/i); // 판정 표현 없음
  });
});

describe('/agents/{kind}/{slug}', () => {
  test('상세: UA 원문, 선언 주소(http만), clientInfo, 단계별 시도·성공, 날짜별 막대', () => {
    const d = page.renderAgent(snap(), 'prober', 'histor', NOW);
    assert.ok(d);
    assert.ok(d.includes('histor/0.5.1 (+https://histor.modelmarket.dev/#crawler; read-only: discover + tools/list)'));
    assert.ok(d.includes('<code>https://histor.modelmarket.dev/</code>'));
    assert.ok(d.includes('<code>histor</code>'));
    assert.match(d, /<tr><td>tools\/call<\/td><td class="num">0<\/td><td class="num">0<\/td><\/tr>/);
    assert.match(d, /width:100%/);
    assert.match(d, /width:60%/);
    assert.ok(d.includes('does not mean the visitor achieved its goal'));
  });
  test('주소는 http(s) 만, UA 변형 수 표시', () => {
    const x = page.renderAgent(snap(), 'prober', '-script-alert-1---script-', NOW);
    assert.ok(x && !x.includes('javascript:'));
    const r = page.renderAgent(snap(), 'crawler', 'reflectionbot', NOW);
    assert.ok(r.includes('2 different User-Agent strings under this name'));
  });
  test('없는 이름·성격·잘못된 slug 는 404(null)', () => {
    assert.equal(page.renderAgent(snap(), 'prober', 'nosuch', NOW), null);
    assert.equal(page.renderAgent(snap(), 'ai_user', 'bad', NOW), null);
    assert.equal(page.renderAgent(snap(), 'prober', '../etc', NOW), null);
    assert.equal(page.renderAgent(snap(), 'crawler', 'histor', NOW), null);
  });
});
