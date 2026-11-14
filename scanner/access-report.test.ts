import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { buildAccess, CITE_ISSUED_FROM, fetchAccessRows, fetchIssuance, renderAccess, splitToolOutcome, type AccessRow } from './access-report-lib.ts';
import { parseMonth } from './monthly-lib.ts';

// Data Access Report (2026-11-14): access_daily 분류별 합계, 대상 이름은 내부 json 에만, Ecosystem 보고서와 섞지 않음.
const row = (o: Partial<AccessRow>): AccessRow => ({ day: '2026-11-10', category: 'read_crawler', ua_name: 'GPTBot', path_kind: 'server_page', target: '', evidence: 'self_declared_user_agent', hits: 1, ...o });
const nov = parseMonth('2026-11');

const rows: AccessRow[] = [
  row({ hits: 100 }),
  row({ ua_name: 'ClaudeBot', hits: 40, path_kind: 'sitemap_part' }),
  row({ category: 'read_prober', ua_name: 'mcp-checker', hits: 5, path_kind: 'mcp' }),
  row({ category: 'read_other', ua_name: '-', hits: 7, path_kind: '/' }),
  row({ category: 'self', ua_name: 'lowdown-scanner', hits: 999 }),
  row({ category: 'citation', ua_name: '-', target: 'mcp:com.apify/apify-mcp-server', evidence: 'ref_cite', hits: 2, day: '2026-11-14' }),
  row({ category: 'citation', ua_name: '-', target: 'mcp:io.x/y', evidence: 'utm_source:chatgpt.com', hits: 1, day: '2026-11-15' }),
  row({ category: 'ai_labeled', ua_name: 'ChatGPT-User', target: 'mcp:io.x/y', hits: 1, day: '2026-11-13' }),
  row({ category: 'ai_labeled', ua_name: 'ChatGPT-User', path_kind: 'server_index', target: '', hits: 2, day: '2026-11-14' }),
  row({ category: 'ai_mcp', ua_name: 'Claude-User', path_kind: 'mcp', hits: 30 }),
  row({ category: 'execution', ua_name: 'openai-mcp', path_kind: 'get_lowdown:ok', hits: 9 }),
  row({ category: 'execution', ua_name: 'openai-mcp', path_kind: 'get_lowdown:error', hits: 1 }),
  row({ category: 'execution', ua_name: '-', path_kind: 'find_servers:ok', hits: 3 }),
  row({ day: '2026-10-31', hits: 500 }), // 기간 밖
];

describe('Data Access Report', () => {
  test('분류별 합계, 기간 밖·self 제외', () => {
    const d = buildAccess(rows, null, nov, new Date('2026-12-01T01:00:00Z'));
    assert.equal(d.partial, false);
    assert.equal(d.read.total, 152);
    assert.equal(d.read.crawler, 140);
    assert.equal(d.read.prober, 5);
    assert.equal(d.read.other, 7);
    assert.deepEqual(d.read.top_ua[0], { name: 'GPTBot', hits: 100 });
    assert.equal(d.self_excluded_hits, 999);
    assert.equal(d.citation.link_access.total, 3);
    assert.deepEqual(d.citation.link_access.by_evidence, { ref_cite: 2, 'utm_source:chatgpt.com': 1 });
    assert.equal(d.citation.link_access.distinct_targets, 2);
    assert.equal(d.ai_labeled.total, 3);
    assert.equal(d.ai_labeled.distinct_targets, 1);
    assert.equal(d.ai_labeled.days, 2);
    assert.equal(d.ai_mcp.total, 30);
    assert.equal(d.execution.total, 13);
    assert.deepEqual(d.execution.by_outcome, { ok: 12, error: 1 });
    assert.deepEqual(d.execution.by_tool.get_lowdown, { ok: 9, error: 1 });
    assert.equal(d.demand_map_conditions.c1_distinct_targets, 1);
    assert.equal(d.demand_map_conditions.c2, 'not_assessed');
    assert.equal(d.first_day, '2026-11-10');
  });

  test('md 에는 대상 서버 이름이 없고, json 내부 블록에만 있다', () => {
    const d = buildAccess(rows, null, nov, new Date('2026-11-14T05:00:00Z'));
    const md = renderAccess(d);
    assert.match(md, /^# Lowdown Data Access Report — 2026-11\n\n> DRAFT/);
    assert.ok(!md.includes('apify'));
    assert.ok(!md.includes('io.x/y'));
    assert.equal(d.internal.citation_targets[0]!.target, 'mcp:com.apify/apify-mcp-server');
    assert.equal(d.internal.ai_labeled_targets[0]!.target, 'mcp:io.x/y');
    assert.match(md, /does not show that an AI answer cited Lowdown/);
    assert.match(md, /not demand or interest/);
    assert.match(md, /Ecosystem Observation Report/);
    assert.match(md, /Links issued: not counted/);
    assert.match(md, /Link accesses: 3 .*2 distinct servers, 2 days\./);
    assert.match(md, /: 3, 1 distinct server, 2 days\n/);
    assert.match(md, /Citations confirmed .*none recorded/);
    assert.match(md, /2026-11-14: Server pages start to carry the Evidence Snapshot/);
    assert.ok(!/verified crawler|demand score|interest score/i.test(md));
  });

  test('발급 수·수동 확인 수가 있으면 표시', () => {
    const issued = { counted_from: CITE_ISSUED_FROM, total: 50, direct: 20, page: 25, mcp: 4, other_ref: 1, crawler: 30 };
    const md = renderAccess(buildAccess(rows, issued, nov, new Date('2026-12-01T00:00:00Z'), 2));
    assert.match(md, /Links issued: 50 lookup responses carried a cite link since 2026-11-14 \(direct 20, via server pages 25, via remote MCP 4, other 1; of all, 30 to crawlers\)/);
    assert.match(md, /undercounts/);
    assert.match(md, /Citations confirmed .*: 2/);
  });

  test('날 수가 1이면 day, 2 이상이면 days', () => {
    const one = renderAccess(buildAccess([row({ category: 'citation', ua_name: '-', target: 'mcp:a/b', evidence: 'ref_cite', hits: 6, day: '2026-11-13' })], null, nov, new Date('2026-12-01T00:00:00Z')));
    assert.match(one, /1 distinct server, 1 day\./);
    assert.ok(!one.includes('1 days'));
    assert.ok(!one.includes('1 distinct servers'));
  });

  test('도구:결과 나누기', () => {
    assert.deepEqual(splitToolOutcome('get_lowdown:ok'), ['get_lowdown', 'ok']);
    assert.deepEqual(splitToolOutcome('a:b:error'), ['a:b', 'error']);
    assert.deepEqual(splitToolOutcome('-'), ['-', '-']);
  });

  test('access_daily 는 범위·주키 순서로 페이지를 넘겨 읽는다', async () => {
    const urls: string[] = [];
    const ranges: string[] = [];
    const pages = [[row({}), row({ ua_name: 'B' })], [row({ ua_name: 'C' })]];
    const fetchImpl = (async (u: string, init: RequestInit) => {
      urls.push(u);
      ranges.push((init.headers as Record<string, string>).Range!);
      return new Response(JSON.stringify(pages.shift() ?? []), { status: 200 });
    }) as typeof fetch;
    const out = await fetchAccessRows({ url: 'https://db.example', key: 'k' }, nov, { fetchImpl, pageSize: 2 });
    assert.equal(out.length, 3);
    assert.deepEqual(ranges, ['0-1', '2-3']);
    assert.match(decodeURIComponent(urls[0]!), /and=\(day\.gte\.2026-11-01,day\.lt\.2026-12-01\)/);
    assert.match(decodeURIComponent(urls[0]!), /order=day\.asc,category\.asc/);
  });

  test('발급 수: 인용 링크 시작 전 기간은 null, 이후는 확정 조회만·self 제외로 센다', async () => {
    assert.equal(await fetchIssuance({ url: 'https://db.example', key: 'k' }, parseMonth('2026-10')), null);
    const urls: string[] = [];
    const counts = [50, 20, 25, 4, 30];
    const fetchImpl = (async (u: string) => {
      urls.push(decodeURIComponent(u));
      return new Response(null, { status: 200, headers: { 'content-range': `*/${counts.shift()}` } });
    }) as typeof fetch;
    const i = await fetchIssuance({ url: 'https://db.example', key: 'k' }, nov, { fetchImpl });
    assert.deepEqual(i, { counted_from: CITE_ISSUED_FROM, total: 50, direct: 20, page: 25, mcp: 4, other_ref: 1, crawler: 30 });
    assert.match(urls[0]!, /created_at\.gte\.2026-11-14T00:00:00\.000Z/);
    assert.match(urls[0]!, /result_kind=in\.\(observed,registry_only\)/);
    assert.match(urls[0]!, /user_agent\.not\.like\.lowdown-scanner\/\*/);
    assert.match(urls[1]!, /ref=is\.null/);
  });
});
