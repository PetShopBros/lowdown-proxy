import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

// Lowdown Public Status v1 (2026-11-05): /status.json · /llms.txt · 홈이 같은 스냅샷·같은 문장·같은 캐시 만료 시각을 쓰는지.
const status = (await import('../api/status.ts' as string)) as any;
const discovery = (await import('../api/discovery.ts' as string)) as any;
const page = (await import('../api/page.ts' as string)) as any;
const mcp = (await import('../api/mcp.ts' as string)) as any;

const NOW = Date.parse('2026-11-05T10:00:00Z');
const snap = (generatedAt: string) => ({
  id: 7,
  generated_at: generatedAt,
  data: {
    schema_version: 1,
    snapshot_id: 7,
    generated_at: generatedAt,
    update_interval: 'hourly',
    summary_lines: ['Observing 9,876 MCP Registry servers with daily checks.', 'Last 30 days: 52 names declaring an MCP check tool <and> 17 names.'],
    highlights: [{ kind: 'milestone', occurred_at: '2026-11-05T09:52:00Z', text: '2026-11-05: 50 names declaring an MCP check tool visited Lowdown in the last 30 days.' }],
    regular_monitors: [{ name: 'histor', median_interval_minutes: 31.2, interval: 'measured' }, { name: 'slow', median_interval_minutes: null, interval: 'unknown' }],
  },
});

describe('상황판 캐시 시각', () => {
  test('세 위치가 같은 계산: 다음 매시 57분(UTC)까지, 60~3600초', () => {
    for (const f of [status.statusCacheSeconds, discovery.statusCacheSeconds, page.statusCacheSeconds]) {
      assert.equal(f(Date.parse('2026-11-05T10:00:00Z')), 57 * 60);
      assert.equal(f(Date.parse('2026-11-05T10:57:00Z')), 3600);
      assert.equal(f(Date.parse('2026-11-05T10:56:30Z')), 60);
      assert.equal(f(Date.parse('2026-11-05T23:58:00Z')), 59 * 60);
    }
  });
});

describe('/status.json', () => {
  test('stale: 2시간 이내 false, 넘으면 true, 숫자는 그대로', () => {
    const fresh = status.withStale(snap('2026-11-05T09:52:00Z'), NOW);
    assert.equal(fresh.stale, false);
    assert.equal(fresh.snapshot_id, 7);
    const old = status.withStale(snap('2026-11-05T07:52:00Z'), NOW);
    assert.equal(old.stale, true);
    assert.deepEqual(old.summary_lines, fresh.summary_lines);
  });

  test('스냅샷을 읽지 못하면 503 no-store, 읽으면 JSON + 정렬된 캐시', async () => {
    const realFetch = globalThis.fetch;
    const prev = { u: process.env.LOWDOWN_SUPABASE_URL, k: process.env.LOWDOWN_SUPABASE_KEY };
    process.env.LOWDOWN_SUPABASE_URL = 'https://db.test';
    process.env.LOWDOWN_SUPABASE_KEY = 'k';
    const call = async () => {
      const out: any = { headers: {} as Record<string, string> };
      const res: any = {
        setHeader: (k: string, v: string) => { out.headers[k.toLowerCase()] = v; },
        status: (c: number) => { out.status = c; return res; },
        json: (b: unknown) => { out.body = b; return res; },
        send: (b: string) => { out.body = b; return res; },
        end: () => res,
      };
      await status.default({ method: 'GET', headers: {}, query: {} }, res);
      return out;
    };
    try {
      globalThis.fetch = (async () => new Response('[]', { status: 200 })) as typeof fetch;
      const none = await call();
      assert.equal(none.status, 503);
      assert.equal(none.headers['cache-control'], 'no-store');
      const s = snap(new Date().toISOString());
      globalThis.fetch = (async (u: any) => {
        assert.match(String(u), /status_snapshots\?select=id,generated_at,data&order=hour_bucket\.desc&limit=1/);
        return new Response(JSON.stringify([s]), { status: 200 });
      }) as typeof fetch;
      const ok = await call();
      assert.equal(ok.status, 200);
      assert.match(ok.headers['cache-control'], /^public, max-age=0, s-maxage=\d+, stale-while-revalidate=300$/);
      const j = JSON.parse(ok.body);
      assert.equal(j.update_interval, 'hourly');
      assert.equal(j.stale, false);
      assert.deepEqual(j.summary_lines, s.data.summary_lines);
    } finally {
      globalThis.fetch = realFetch;
      if (prev.u === undefined) delete process.env.LOWDOWN_SUPABASE_URL; else process.env.LOWDOWN_SUPABASE_URL = prev.u;
      if (prev.k === undefined) delete process.env.LOWDOWN_SUPABASE_KEY; else process.env.LOWDOWN_SUPABASE_KEY = prev.k;
    }
  });
});

describe('llms.txt 요약', () => {
  const LLMS = '# Lowdown\n\n> Lowdown is a record.\n\n## Bulk use\n\nDownload.\n';
  test('첫 절(## ) 앞에 들어가고, 스냅샷 문장·강조·생성 시각을 그대로 쓴다', () => {
    const block = discovery.statusBlock(snap('2026-11-05T09:52:00Z'), NOW);
    const out = discovery.insertStatus(LLMS, block);
    assert.ok(out.startsWith('# Lowdown\n\n> Lowdown is a record.\n\n## Status (updated hourly)\n'));
    assert.ok(out.indexOf('## Status') < out.indexOf('## Bulk use'));
    for (const l of snap('x').data.summary_lines) assert.ok(out.includes(`- ${l}`));
    assert.ok(out.includes('- 2026-11-05: 50 names declaring'));
    assert.ok(out.includes('Snapshot 7, generated 2026-11-05T09:52:00Z.'));
    assert.ok(out.includes('https://lowdown-proxy.vercel.app/status.json'));
    assert.doesNotMatch(out, /real[- ]?time/i);
  });
  test('오래된 스냅샷은 지연 표시, 스냅샷이 없으면 원본 그대로', () => {
    assert.match(discovery.statusBlock(snap('2026-11-05T05:00:00Z'), NOW), /more than 2 hours old/);
    assert.equal(discovery.insertStatus(LLMS, discovery.statusBlock(null)), LLMS);
  });
});

describe('홈 상황판', () => {
  test('같은 문장(이스케이프), 강조, 정기 방문자 주기, 정의 안내', () => {
    const html = page.renderStatus(snap('2026-11-05T09:52:00Z'), NOW);
    assert.match(html, /Status <span class="muted">\(updated hourly\)<\/span>/);
    assert.ok(html.includes('Last 30 days: 52 names declaring an MCP check tool &lt;and&gt; 17 names.'));
    assert.ok(html.includes('2026-11-05: 50 names declaring'));
    assert.ok(html.includes('histor (about every 31 min)'));
    assert.ok(html.includes('slow') && !html.includes('slow (about'));
    assert.ok(html.includes('not verified identities'));
    assert.equal(page.renderStatus(null), '');
    const home = page.renderIndex([], { home: true, statusHtml: html });
    assert.ok(home.indexOf('(updated hourly)') < home.indexOf('Observed servers'));
  });
});

describe('MCP 안내문', () => {
  test('상황판 주소만 있고 숫자는 넣지 않는다', () => {
    assert.match(mcp.INSTRUCTIONS, /operating status, updated hourly: https:\/\/lowdown-proxy\.vercel\.app\/status\.json\./);
    assert.doesNotMatch(mcp.INSTRUCTIONS, /\d{2,}\s+(names|servers|observations)/);
  });
});
