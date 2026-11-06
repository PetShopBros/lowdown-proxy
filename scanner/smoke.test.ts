import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { checkLookup, checkMcp, checkStatus, checkTodayRows } from './smoke.ts';

// 실제 서비스 점검: 무엇을 실패로 보는가 (가짜 응답으로)
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const B = 'https://x.example';

describe('smoke 점검', () => {
  test('status.json: 200·신선하면 ok, stale·503 이면 실패', async () => {
    assert.equal((await checkStatus(async () => json({ stale: false }), B)).ok, true);
    assert.equal((await checkStatus(async () => json({ stale: true }), B)).detail, 'stale snapshot');
    assert.equal((await checkStatus(async () => json({ error: 'temporarily_unavailable' }, 503), B)).detail, 'HTTP 503');
    const slow: typeof fetch = async () => { const e = new Error('The operation was aborted due to timeout'); e.name = 'TimeoutError'; throw e; };
    assert.deepEqual(await checkStatus(slow, B), { name: 'status.json', ok: false, detail: 'timeout' });
  });

  test('조회: 자기 점검 표시, summary·상태 블록 필수, 오래된 상태는 실패', async () => {
    let headers: any = null;
    const ok = await checkLookup(async (_u, init) => { headers = init?.headers; return json({ summary: { auth: 'required' }, status: { days_since_latest_check: 0, stale: false } }); }, B);
    assert.equal(ok.ok, true);
    assert.equal(headers['x-lowdown-source'], 'seeded');
    assert.match(headers['user-agent'], /^lowdown-smoke\//);
    assert.equal((await checkLookup(async () => json({ status: { days_since_latest_check: 0 } }), B)).detail, 'summary missing');
    assert.match((await checkLookup(async () => json({ summary: { auth: 'x' }, status: { days_since_latest_check: 4, stale: true } }), B)).detail, /stale/);
    assert.equal((await checkLookup(async () => json({ error: 'temporarily_unavailable' }, 503), B)).detail, 'HTTP 503 temporarily_unavailable');
  });

  test('MCP: initialize·tools/list, 두 도구가 있어야 ok (JSON·SSE 둘 다 읽음)', async () => {
    const tools = { jsonrpc: '2.0', id: 2, result: { tools: [{ name: 'get_lowdown' }, { name: 'find_servers' }] } };
    const f: typeof fetch = async (_u, init) => {
      const m = JSON.parse(String(init?.body)).method;
      if (m === 'initialize') return json({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-06-18' } });
      return new Response(`event: message\ndata: ${JSON.stringify(tools)}\n\n`, { headers: { 'content-type': 'text/event-stream' } });
    };
    assert.equal((await checkMcp(f, B)).ok, true);
    const missing: typeof fetch = async (_u, init) =>
      JSON.parse(String(init?.body)).method === 'initialize' ? json({ jsonrpc: '2.0', id: 1, result: {} }) : json({ jsonrpc: '2.0', id: 2, result: { tools: [{ name: 'get_lowdown' }] } });
    assert.match((await checkMcp(missing, B)).detail, /missing find_servers/);
    assert.match((await checkMcp(async () => json({ error: 'x' }, 500), B)).detail, /initialize HTTP 500/);
  });

  test('오늘 관찰 행: N 번째 행 하나만 읽는다', async () => {
    let url = '';
    const has = await checkTodayRows(async (u) => { url = String(u); return json([{ id: 1 }]); }, { url: 'https://db.example', key: 'k' }, Date.parse('2026-11-07T03:07:00Z'), 5000);
    assert.equal(has.ok, true);
    assert.match(url, /offset=4999&limit=1/);
    assert.match(url, /observed_at=gte.2026-11-07T00%3A00%3A00Z/);
    assert.equal((await checkTodayRows(async () => json([]), { url: 'https://db.example', key: 'k' }, Date.now(), 5000)).ok, false);
  });
});
