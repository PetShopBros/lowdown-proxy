import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  classify,
  fetchCard,
  parseA2aCard,
  parseAiCatalog,
  parseServerCard,
  sliceForDay,
  sliceOf,
  originOf,
  endpointCardUrl,
  type CardKind,
  type Fetched,
} from './card-lib.ts';
import { checkOrigin, groupTargets, type OriginWork } from './card-discovery.ts';

const SERVER_CARD = {
  $schema: 'https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json',
  name: 'io.github.acme/weather',
  version: '1.2.0',
  description: 'Weather',
  remotes: [{ type: 'streamable-http', url: 'https://mcp.acme.dev/mcp/', supportedProtocolVersions: ['2025-11-25'] }],
};

function found(url: string, body: unknown): Fetched {
  const text = JSON.stringify(body);
  return { url, outcome: 'found', http_status: 200, content_type: 'application/json', bytes: text.length, sha256: 'h' + text.length, text };
}
const miss = (url: string, outcome: Fetched['outcome'] = 'not_found', status: number | null = 404): Fetched =>
  ({ url, outcome, http_status: status, content_type: null, bytes: null, sha256: null, text: null });

describe('결과 분류: 카드 없음과 확인 실패를 나눈다', () => {
  test('상태·본문별', () => {
    assert.equal(classify(404, null, ''), 'not_found');
    assert.equal(classify(410, null, ''), 'not_found');
    assert.equal(classify(401, null, ''), 'auth_required');
    assert.equal(classify(403, null, ''), 'auth_required');
    assert.equal(classify(500, null, ''), 'http_error');
    assert.equal(classify(200, 'text/html', '<!doctype html><p>home'), 'html_fallback');
    assert.equal(classify(200, 'application/json', '  <html>'), 'html_fallback');
    assert.equal(classify(200, 'application/json', '{bad'), 'invalid_json');
    assert.equal(classify(200, 'application/json', '"text"'), 'wrong_shape');
    assert.equal(classify(200, 'application/json', null), 'too_large');
    assert.equal(classify(200, 'application/json', '{"name":"a/b"}'), 'found');
  });

  test('요청: https 가 아닌 넘김·사설 주소·시간 초과', async () => {
    const redirectToHttp: typeof fetch = async () => new Response(null, { status: 301, headers: { location: 'http://x.example/card' } });
    assert.equal((await fetchCard('https://a.example/x', 'mcp_server_card', 1000, redirectToHttp)).outcome, 'redirect_blocked');
    assert.equal((await fetchCard('https://127.0.0.1/x', 'mcp_server_card', 1000, async () => new Response('{}'))).outcome, 'redirect_blocked');
    const slow: typeof fetch = async () => { const e = new Error('The operation was aborted due to timeout'); e.name = 'TimeoutError'; throw e; };
    assert.equal((await fetchCard('https://a.example/x', 'a2a_agent_card', 1000, slow)).outcome, 'timeout');
    const ok = await fetchCard('https://a.example/x', 'mcp_server_card', 1000, async () => new Response(JSON.stringify(SERVER_CARD), { headers: { 'content-type': 'application/json' } }));
    assert.equal(ok.outcome, 'found');
    assert.match(ok.sha256!, /^[0-9a-f]{64}$/);
    const nf = await fetchCard('https://a.example/x', 'mcp_server_card', 1000, async () => new Response('nope', { status: 404 }));
    assert.deepEqual([nf.outcome, nf.http_status, nf.text], ['not_found', 404, null]);
  });
});

describe('파서: 종류마다 따로, 모양이 아니면 null', () => {
  test('MCP Server Card', () => {
    const f = parseServerCard(SERVER_CARD)!;
    assert.equal(f.claimed_name, 'io.github.acme/weather');
    assert.equal(f.name_format_ok, true);
    assert.deepEqual(f.endpoints, [{ url: 'https://mcp.acme.dev/mcp/', type: 'streamable-http', versions: ['2025-11-25'] }]);
    assert.equal(parseServerCard({ hello: 1 }), null);
    assert.equal(parseServerCard([SERVER_CARD]), null);
    assert.equal(parseServerCard({ name: 'not a registry name' })!.name_format_ok, false);
  });

  test('A2A Agent Card: v1.0 supportedInterfaces, 옛 최상위 url', () => {
    const v1 = parseA2aCard({ name: 'Agent', supportedInterfaces: [{ url: 'https://a.example/a2a', protocolBinding: 'JSONRPC', protocolVersion: '1.0' }] })!;
    assert.deepEqual(v1.interfaces, [{ url: 'https://a.example/a2a', binding: 'JSONRPC' }]);
    assert.equal(v1.protocol_version, '1.0');
    const old = parseA2aCard({ name: 'Old', url: 'https://a.example/rpc', preferredTransport: 'JSONRPC', protocolVersion: '0.3.0' })!;
    assert.deepEqual(old.interfaces, [{ url: 'https://a.example/rpc', binding: 'JSONRPC' }]);
    assert.equal(parseA2aCard({ skills: [] }), null);
  });

  test('AI Catalog: 항목의 url·data 에서 MCP 카드', () => {
    const c = parseAiCatalog({ entries: [
      { identifier: 'a', type: 'application/mcp-server-card+json', url: 'https://x.example/mcp/server-card' },
      { identifier: 'b', type: 'application/mcp-server-card+json', data: SERVER_CARD },
      { identifier: 'c', type: 'application/a2a-agent-card+json', url: 'http://insecure.example/card' },
    ] })!;
    assert.equal(c.entries, 3);
    assert.deepEqual(c.mcp_card_urls, ['https://x.example/mcp/server-card']);
    assert.equal(c.mcp_card_inline[0]!.claimed_name, 'io.github.acme/weather');
    assert.equal(c.entry_types['application/a2a-agent-card+json'], 1);
    assert.equal(parseAiCatalog({ name: 'x' }), null);
  });
});

describe('대상 묶기·요일 나누기', () => {
  test('origin 별 묶음, 공용 호스트(주소 5개 이상), 칸은 주소마다 고정', () => {
    const t = (id: number, endpoint: string, quiet = false) => ({ endpoint_id: id, endpoint, registry_names: [`io.x/s${id}`], quiet });
    const g = groupTargets([
      t(1, 'https://solo.example/mcp', true),
      ...[2, 3, 4, 5, 6].map((i) => t(i, `https://shared.example/s${i}/mcp`)),
      t(7, 'http://plain.example/mcp'),
    ]);
    assert.deepEqual(g.map((w) => [w.origin, w.shared, w.endpoints.length, w.quiet]), [
      ['https://shared.example', true, 5, false],
      ['https://solo.example', false, 1, true],
    ]);
    assert.equal(sliceOf('https://solo.example'), sliceOf('https://solo.example'));
    const seen = new Set(Array.from({ length: 7 }, (_, d) => sliceForDay(d * 86_400_000)));
    assert.equal(seen.size, 7);
    assert.equal(originOf('https://Host.example:8443/mcp'), 'https://host.example:8443');
    assert.equal(endpointCardUrl('https://h.example/mcp/'), 'https://h.example/mcp/server-card');
  });
});

describe('호스트 하나 확인', () => {
  const w: OriginWork = {
    origin: 'https://mcp.acme.dev', host: 'mcp.acme.dev', slice: 3, shared: false, quiet: false,
    endpoints: [{ endpoint_id: 1, endpoint: 'https://mcp.acme.dev/mcp', registry_names: ['io.github.acme/weather'], quiet: false }],
  };
  const responses: Record<string, Fetched> = {
    'https://mcp.acme.dev/.well-known/ai-catalog.json': miss('https://mcp.acme.dev/.well-known/ai-catalog.json', 'timeout', null),
    'https://mcp.acme.dev/.well-known/agent-card.json': miss('https://mcp.acme.dev/.well-known/agent-card.json'),
    'https://mcp.acme.dev/.well-known/agent.json': found('https://mcp.acme.dev/.well-known/agent.json', { name: 'Acme', url: 'https://mcp.acme.dev/a2a' }),
    'https://mcp.acme.dev/.well-known/mcp/server-card.json': miss('https://mcp.acme.dev/.well-known/mcp/server-card.json', 'auth_required', 403),
    'https://mcp.acme.dev/mcp/server-card': found('https://mcp.acme.dev/mcp/server-card', SERVER_CARD),
  };
  const calls: string[] = [];
  const fetcher = async (u: string, _k: CardKind) => {
    calls.push(u);
    return responses[u] ?? miss(u);
  };

  test('경로 후보는 not_found 일 때만 다음으로, 선언·원문·변경 기록', async () => {
    const o = await checkOrigin(w, null, new Map(), fetcher, '2026-11-09T02:00:00.000Z', 'run1');
    // A2A: 현재 경로 404 → 옛 경로. .well-known MCP 카드: 403 이라 다음 경로로 가지 않는다
    assert.ok(calls.includes('https://mcp.acme.dev/.well-known/agent.json'));
    assert.ok(!calls.includes('https://mcp.acme.dev/.well-known/mcp/server-card'));
    assert.equal(o.requests, 5);
    const r = o.host.results as Record<string, any>;
    assert.equal(r.ai_catalog.outcome, 'timeout');
    assert.equal(r.a2a_agent_card.outcome, 'found');
    assert.equal(r.a2a_agent_card.legacy_path, true);
    assert.deepEqual(r.a2a_agent_card.tried.map((x: any) => x.outcome), ['not_found', 'found']);
    assert.equal(r.mcp_well_known.outcome, 'auth_required');
    const ep = o.endpoints[0]!.result as Record<string, any>;
    assert.equal(ep.outcome, 'found');
    assert.equal(ep.claimed_name, 'io.github.acme/weather');
    assert.deepEqual(ep.declared_endpoints, ['https://mcp.acme.dev/mcp']);
    assert.equal(ep.first_found_at, '2026-11-09T02:00:00.000Z');
    assert.equal(ep.last_changed_at, null); // 첫 확인은 "변경"이 아니다
    // A2A 서비스 주소는 MCP 주소로 넣지 않는다
    const a2a = o.declarations.find((d) => d.kind === 'a2a_agent_card')!;
    assert.deepEqual(a2a.endpoints, []);
    assert.equal(a2a.interfaces[0]!.url, 'https://mcp.acme.dev/a2a');
    assert.equal(o.declarations.filter((d) => d.kind === 'mcp_server_card').length, 1);
    assert.equal(o.bodies.length, 2);
    // 첫 확인은 기준선: 찾은 카드(A2A 옛 경로, 주소의 server-card)만 변경 기록에 남긴다
    assert.deepEqual(o.changes.map((c) => c.kind).sort(), ['a2a_agent_card', 'mcp_server_card']);
  });

  test('다시 확인: 같으면 변경 없음, 날짜 이어짐 / 카드가 사라지면 변경 1건', async () => {
    const first = await checkOrigin(w, null, new Map(), fetcher, '2026-11-09T02:00:00.000Z', 'run1');
    const prevHost = { results: first.host.results };
    const prevEp = new Map([[w.endpoints[0]!.endpoint, { result: first.endpoints[0]!.result }]]);
    const again = await checkOrigin(w, prevHost, prevEp, fetcher, '2026-11-16T02:00:00.000Z', 'run2');
    assert.equal(again.changes.length, 0);
    assert.equal((again.endpoints[0]!.result as any).first_found_at, '2026-11-09T02:00:00.000Z');
    const gone = async (u: string, k: CardKind) => (u.endsWith('/mcp/server-card') ? miss(u) : fetcher(u, k));
    const third = await checkOrigin(w, prevHost, prevEp, gone, '2026-11-23T02:00:00.000Z', 'run3');
    assert.equal(third.changes.length, 1);
    assert.deepEqual([third.changes[0]!.from_outcome, third.changes[0]!.to_outcome], ['found', 'not_found']);
    const ep = third.endpoints[0]!.result as any;
    assert.equal(ep.last_changed_at, '2026-11-23T02:00:00.000Z');
    assert.equal(ep.first_found_at, '2026-11-09T02:00:00.000Z'); // 처음 찾은 날은 남는다
  });

  test('JSON 이지만 카드 모양이 아니면 wrong_shape, 선언·원문 없음', async () => {
    const odd = async (u: string, k: CardKind) => (u.endsWith('/mcp/server-card') ? found(u, { status: 'ok' }) : miss(u, 'not_found'));
    const o = await checkOrigin(w, null, new Map(), odd, '2026-11-09T02:00:00.000Z', 'run1');
    assert.equal((o.endpoints[0]!.result as any).outcome, 'wrong_shape');
    assert.equal((o.endpoints[0]!.result as any).sha256, null);
    assert.equal(o.declarations.length, 0);
    assert.equal(o.bodies.length, 0);
  });
});

describe('조회 응답의 cards 블록', async () => {
  const rep = (await import('../api/reputation/[target].ts' as string)) as any;
  test('확인 전: checked false', () => {
    const c = rep.shapeCards('io.github.acme/weather', [], []);
    assert.equal(c.checked, false);
    assert.match(c.basis, /Self-declared/);
  });
  test('주소 카드·호스트 카드, 이름·주소 일치는 사실로만, 공용 호스트 표시', () => {
    const c = rep.shapeCards(
      'io.github.acme/weather',
      [{ endpoint: 'https://mcp.acme.dev/mcp', origin: 'https://mcp.acme.dev', checked_at: '2026-11-09T02:00:00Z', result: {
        kind: 'mcp_server_card', url: 'https://mcp.acme.dev/mcp/server-card', outcome: 'found', http_status: 200, sha256: 'x',
        claimed_name: 'io.github.other/name', declared_endpoints: ['https://mcp.acme.dev/mcp'], transports: ['streamable-http'], first_found_at: '2026-11-09T02:00:00Z', last_changed_at: null,
      } }],
      [{ origin: 'https://mcp.acme.dev', shared: true, checked_at: '2026-11-09T02:00:00Z', results: {
        ai_catalog: { outcome: 'timeout', url: 'https://mcp.acme.dev/.well-known/ai-catalog.json', http_status: null },
        a2a_agent_card: { outcome: 'not_found', url: 'https://mcp.acme.dev/.well-known/agent.json', http_status: 404, tried: [{ url: 'a', outcome: 'not_found' }, { url: 'b', outcome: 'not_found' }] },
        mcp_well_known: { outcome: 'auth_required', url: 'https://mcp.acme.dev/.well-known/mcp/server-card.json', http_status: 403 },
      } }],
    );
    assert.equal(c.checked, true);
    const sc = c.remotes[0].server_card;
    assert.equal(sc.outcome, 'found');
    assert.equal(sc.name_matches_registry, false);
    assert.equal(sc.endpoints_match_registry, true);
    assert.equal(sc.first_found, '2026-11-09');
    assert.equal(sc.http_status, undefined);
    const h = c.hosts[0];
    assert.equal(h.shared, true);
    assert.match(h.note, /declared by the host/);
    assert.deepEqual([h.ai_catalog.outcome, h.a2a_agent_card.outcome, h.mcp_well_known.outcome], ['timeout', 'not_found', 'auth_required']);
    assert.equal(h.mcp_well_known.http_status, 403);
    assert.equal(h.a2a_agent_card.tried.length, 2);
  });
});

describe('시간 상한·연속 실패·이어서 하기', () => {
  const many: OriginWork = {
    origin: 'https://hub.example', host: 'hub.example', slice: 1, shared: true, quiet: false,
    endpoints: Array.from({ length: 12 }, (_, i) => ({ endpoint_id: i + 1, endpoint: `https://hub.example/s${i}/mcp`, registry_names: [`io.hub/s${i}`], quiet: false })),
  };
  const nf = async (u: string) => miss(u);

  test('시간 상한이 지나면 남은 주소는 확인하지 않고 complete=false', async () => {
    let t = 0;
    const o = await checkOrigin(many, null, new Map(), async (u) => { t += 10; return miss(u); }, 'now', 'r', async () => {}, { deadline: 80, now: () => t });
    assert.equal(o.complete, false);
    assert.ok(o.endpoints.length > 0 && o.endpoints.length < 12);
  });

  test('연속 timeout 5번이면 나머지는 요청 없이 skipped_after_timeouts, 변경 기록 없음', async () => {
    let calls = 0;
    const slow = async (u: string) => { calls++; return u.endsWith('/server-card') && !u.includes('/.well-known/') ? miss(u, 'timeout', null) : miss(u); };
    const o = await checkOrigin(many, null, new Map(), slow, 'now', 'r');
    const outcomes = o.endpoints.map((e) => (e.result as any).outcome);
    assert.deepEqual(outcomes.slice(0, 5), Array(5).fill('timeout'));
    assert.deepEqual(outcomes.slice(5), Array(7).fill('skipped_after_timeouts'));
    assert.equal(calls, 5 + 5); // 호스트 카드 5번(경로 후보 포함) + 주소 5번
    assert.equal(o.changes.length, 0);
    assert.equal(o.complete, true);
  });

  test('오늘 이미 한 호스트 카드·주소는 다시 요청하지 않는다', async () => {
    const calls: string[] = [];
    const done = new Set(many.endpoints.slice(0, 10).map((e) => e.endpoint));
    const o = await checkOrigin(many, null, new Map(), async (u) => { calls.push(u); return nf(u); }, 'now', 'r', async () => {}, { hostDone: true, doneEndpoints: done });
    assert.deepEqual(o.host, {});
    assert.equal(calls.length, 2);
    assert.ok(calls.every((u) => u.endsWith('/server-card') && !u.includes('/.well-known/')));
  });
});

// ── 2026-11-11: server card SEP-1649 초안 형식(serverInfo) ──
import { test as __scTest } from 'node:test';
import __scAssert from 'node:assert/strict';
import { parseServerCard as __parseSC } from './card-lib.ts';

__scTest('server card: SEP-1649 초안 (serverInfo + endpoint 문자열 + transport 문자열)', () => {
  const f = __parseSC({ serverInfo: { name: '212medya-growth-check', title: 'x', version: '1.0.0' }, endpoint: 'https://212medya.com.tr/mcp', transport: 'streamable-http', capabilities: { tools: {} } });
  __scAssert.deepEqual(f, { claimed_name: '212medya-growth-check', name_format_ok: false, version: '1.0.0', endpoints: [{ url: 'https://212medya.com.tr/mcp', type: 'streamable-http', versions: [] }], format: 'sep1649_draft' });
});

__scTest('server card: SEP-1649 초안 (transport 객체 url + protocolVersion, 역DNS 이름)', () => {
  const f = __parseSC({ $schema: 'https://static.modelcontextprotocol.io/schemas/mcp-server-card/v1.json', protocolVersion: '2025-06-18', serverInfo: { name: 'io.github.acarchidi/agentforge', version: '1.13.1' }, transport: { type: 'streamable-http', url: 'https://agentforge.example/mcp' } });
  __scAssert.equal(f?.format, 'sep1649_draft');
  __scAssert.equal(f?.name_format_ok, true);
  __scAssert.deepEqual(f?.endpoints, [{ url: 'https://agentforge.example/mcp', type: 'streamable-http', versions: ['2025-06-18'] }]);
});

__scTest('server card: SEP-2127 (name + remotes) 은 그대로, format 없음', () => {
  const f = __parseSC({ name: 'com.acme/tools', version: '1.0.0', remotes: [{ type: 'streamable-http', url: 'https://acme.example/mcp', supportedProtocolVersions: ['2025-11-25'] }] });
  __scAssert.equal(f?.format, undefined);
  __scAssert.equal(f?.claimed_name, 'com.acme/tools');
  __scAssert.deepEqual(f?.endpoints, [{ url: 'https://acme.example/mcp', type: 'streamable-http', versions: ['2025-11-25'] }]);
});

__scTest('server card: 이름도 주소도 없으면 null, http(s) 아닌 주소는 버림', () => {
  __scAssert.equal(__parseSC({ serverInfo: { title: 'x' }, capabilities: {} }), null);
  __scAssert.equal(__parseSC({ capabilities: { tools: {} } }), null);
  __scAssert.equal(__parseSC({ serverInfo: { name: 'x' }, endpoint: 'ftp://nope' })?.endpoints.length, 0);
});
