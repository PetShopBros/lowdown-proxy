import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  accumulate,
  buildMonthly,
  countRows,
  declaredVsObserved,
  newState,
  normVersion,
  parseMonth,
  renderMonthly,
  statusDist,
  streamObservations,
  toolChanges,
  toolCountDist,
  transitions,
  weekOf,
  weeklyCohortTrend,
} from './monthly-lib.ts';
import type { CountsInput, MonthRow, RegistryDecl } from './monthly-lib.ts';

const NOV = parseMonth('2026-11');
const H1 = 'a'.repeat(64);
const H2 = 'b'.repeat(64);

let nextId = 1;
function row(target: string, at: string, over: Partial<MonthRow> = {}): MonthRow {
  return {
    id: nextId++,
    target_id: target,
    observed_at: at,
    source: 'scanner',
    http_status: 200,
    reached_level: 2,
    error_type: null,
    remote_url: `https://${target.slice(4)}.example.com/mcp`,
    tool_set_hash: H1,
    tool_count: '4',
    server_version: '1.0.0',
    ...over,
  };
}

// a: 매일 L2, 도구 정의가 11/3에 바뀜 / b: 11/1 L2 → 11/3 401 / c: 원격 두 개(하나 L2, 하나 timeout) / d: 호출 안 함
// e: 순환, 11/7 timeout → 11/10 L1 / f: 10월에만 관찰(월 집계에서 빠짐) / x: declared(빠짐)
function sample(): MonthRow[] {
  return [
    row('mcp:f', '2026-10-30T19:00:00Z'),
    row('mcp:a', '2026-11-01T19:00:00Z'),
    row('mcp:b', '2026-11-01T19:00:01Z'),
    row('mcp:c', '2026-11-01T19:00:02Z', { remote_url: 'https://c1.example.com/mcp', tool_count: '30' }),
    row('mcp:c', '2026-11-01T19:00:03Z', { remote_url: 'https://c2.example.com/mcp', http_status: null, reached_level: 0, error_type: 'timeout', tool_set_hash: null }),
    row('mcp:d', '2026-11-01T19:00:04Z', { http_status: null, reached_level: 0, error_type: 'blocked_url', tool_set_hash: null }),
    row('endpoint:x', '2026-11-01T19:00:05Z', { source: 'scanner_declared' }),
    row('mcp:a', '2026-11-02T19:00:00Z'),
    row('mcp:a', '2026-11-03T19:00:00Z', { tool_set_hash: H2, tool_count: '5' }),
    row('mcp:b', '2026-11-03T19:00:01Z', { http_status: 401, reached_level: 0, tool_set_hash: null, server_version: null }),
    row('mcp:e', '2026-11-07T19:00:00Z', { source: 'scanner_rotating', http_status: null, reached_level: 0, error_type: 'timeout', tool_set_hash: null }),
    row('mcp:e', '2026-11-10T19:00:00Z', { source: 'scanner_rotating', reached_level: 1, tool_set_hash: null, server_version: 'v2.0.0' }),
  ];
}

function built() {
  const s = newState();
  accumulate(s, sample(), NOV, new Set(['mcp:a', 'mcp:b', 'mcp:f']));
  return s;
}

describe('parseMonth / weekOf', () => {
  test('범위와 형식', () => {
    assert.deepEqual(NOV, { label: '2026-11', start: '2026-11-01T00:00:00.000Z', end: '2026-12-01T00:00:00.000Z', startDay: '2026-11-01', endDay: '2026-12-01' });
    assert.equal(parseMonth('2026-12').endDay, '2027-01-01');
    assert.throws(() => parseMonth('2026-13'));
    assert.throws(() => parseMonth('202611'));
  });
  test('월요일 시작 주', () => {
    assert.equal(weekOf('2026-11-09'), '2026-11-09'); // 월
    assert.equal(weekOf('2026-11-15'), '2026-11-09'); // 일
    assert.equal(weekOf('2026-11-01'), '2026-10-26');
  });
});

describe('축약과 집계', () => {
  const s = built();

  test('월 범위 밖·declared 행은 월 집계에 넣지 않는다', () => {
    assert.equal(s.targets.size, 5);
    assert.ok(!s.targets.has('mcp:f'));
    assert.ok(!s.targets.has('endpoint:x'));
    assert.equal(s.rows, 10);
  });

  test('Q1·Q3 마지막 관찰 날 기준, 원격이 여럿이면 최고 단계가 대표', () => {
    const d = statusDist(s);
    assert.equal(d.servers, 5);
    assert.equal(d.not_called, 1); // d
    assert.equal(d.attempted, 4);
    assert.deepEqual(d.reached_level, { '0': 1, '1': 1, '2': 2 }); // b=0, e=1, a·c=2
    assert.equal(d.status_401_403, 1);
    assert.deepEqual(d.by_basis, { fixed: 4, rotating: 1, requested: 0 });
    assert.deepEqual(
      d.error_type.map((x) => [x.key, x.count]),
      [['none', 4]],
    ); // c 의 대표는 L2 원격(timeout 원격이 아님)
  });

  test('Q2 첫 날 → 마지막 날, 관찰 방식별', () => {
    const t = transitions(s);
    assert.deepEqual(t.fixed, { compared: 2, became_reachable: 0, became_unreachable: 1, unchanged: 1 }); // a 그대로, b 내려감
    assert.deepEqual(t.rotating, { compared: 1, became_reachable: 1, became_unreachable: 0, unchanged: 0 });
  });

  test('Q8 같은 원격에서 두 번 이상 받은 서버만 분모', () => {
    const t = toolChanges(s);
    assert.deepEqual(t.fixed, { eligible: 1, changed: 1 }); // a 만 (b·c 는 L2 한 번)
    assert.deepEqual(t.rotating, { eligible: 0, changed: 0 });
  });

  test('Q8 원격이 다르면 해시가 달라도 변경이 아니다', () => {
    const s2 = newState();
    accumulate(
      s2,
      [
        row('mcp:m', '2026-11-01T19:00:00Z', { remote_url: 'https://m1.example.com/mcp', tool_set_hash: H1 }),
        row('mcp:m', '2026-11-01T19:00:01Z', { remote_url: 'https://m2.example.com/mcp', tool_set_hash: H2 }),
        row('mcp:m', '2026-11-02T19:00:00Z', { remote_url: 'https://m1.example.com/mcp', tool_set_hash: H1 }),
        row('mcp:m', '2026-11-02T19:00:01Z', { remote_url: 'https://m2.example.com/mcp', tool_set_hash: H2 }),
      ],
      NOV,
      new Set(),
    );
    assert.deepEqual(toolChanges(s2).fixed, { eligible: 1, changed: 0 });
  });

  test('Q9 도구 수', () => {
    const t = toolCountDist(s);
    assert.equal(t.servers, 2); // a(5), c(30)
    assert.equal(t.median, 17.5);
    assert.equal(t.buckets.find((b) => b.key === '1-5')!.count, 1);
    assert.equal(t.buckets.find((b) => b.key === '21-50')!.count, 1);
  });

  test('Q7 선언 vs 관측', () => {
    const reg = new Map<string, RegistryDecl>([
      ['a', { version: '1.0.0', hosts: ['a.example.com'] }],
      ['c', { version: '0.9.0', hosts: ['c9.example.com'] }],
      ['e', { version: '2.0.0', hosts: [] }],
      ['b', { version: '1.0.0', hosts: ['b.example.com'] }], // 마지막 날 L0 → 비교하지 않음
    ]);
    assert.deepEqual(declaredVsObserved(s, reg), { servers: 3, version_compared: 3, version_mismatch: 1, host_compared: 2, host_mismatch: 1 });
    assert.equal(normVersion('v2.0.0'), '2.0.0');
    assert.equal(normVersion('version-2'), 'version-2');
  });

  test('Q4 코호트 추이는 10월 행도 쓰고, 그 주 마지막 날 단계', () => {
    const w = weeklyCohortTrend(s);
    assert.deepEqual(w, [
      { week: '2026-10-26', observed: 3, level2: 3 }, // f(10/30), a·b(11/1)
      { week: '2026-11-02', observed: 2, level2: 1 }, // a(11/3 L2), b(11/3 L0)
    ]);
  });
});

const COUNTS: CountsInput = {
  registry_changes: { new: 3, removed: 1 },
  registry_active: 100,
  registry_with_remotes: 40,
  npm_changes: { deprecated: 2 },
  npm_state: { found: 50, not_found: 2, deprecated: 3 },
  pypi_changes: {},
  pypi_state: { found: 10, not_found: 0, archived: 1, quarantined: 0, deprecated: 0 },
  notable: { R1_first_change_after_stable: 4, R2_changed_same_server_version: 6, R3_tool_removed: 1, P1_npm_deprecated: 9 },
  sandbox: { versions: 200, npm: 150, pypi: 50, done: 190, ok: 80 },
};

describe('buildMonthly / renderMonthly', () => {
  const data = buildMonthly(built(), new Map(), COUNTS, NOV, { version: '2026-10-07-v1', size: 3, from: '2026-10-07' }, new Date('2026-11-20T00:00:00Z'));
  const md = renderMonthly(data);

  test('달이 끝나기 전이면 초안 표시', () => {
    assert.equal(data.partial, true);
    assert.match(md, /^# Lowdown MCP Report — 2026-11\n\n> DRAFT/);
    const closed = buildMonthly(built(), new Map(), COUNTS, NOV, { version: 'v1', size: 3, from: '2026-10-07' }, new Date('2026-12-01T03:00:00Z'));
    assert.equal(closed.partial, false);
  });

  test('서버 이름·주소·호스트가 결과에 나가지 않는다', () => {
    for (const out of [md, JSON.stringify(data)]) {
      assert.doesNotMatch(out, /mcp:[a-z]/);
      assert.doesNotMatch(out, /example\.com/);
      assert.doesNotMatch(out, /endpoint:/);
      assert.doesNotMatch(out, new RegExp(H1));
    }
  });

  test('핵심 숫자와 6절은 합계만', () => {
    assert.match(md, /Remote MCP servers observed: 5 \(4 probed, 1 not called\)/);
    assert.match(md, /Returned 401 or 403: 1 \(25\.0% of probed\)/);
    assert.match(md, /radar rules \(R1–R3\): 11, of which 6 without a server version change/);
    assert.match(md, /200 package versions run; 40\.0% answered/);
    assert.doesNotMatch(md, /P1_npm_deprecated/);
  });

  test('절마다 기준과 재계산 가능 여부, 해설 자리', () => {
    assert.equal((md.match(/Reproducible from the public dataset: yes/g) ?? []).length, 6);
    assert.equal((md.match(/Reproducible from the public dataset: no/g) ?? []).length, 2);
    assert.equal((md.match(/<!-- TODO: commentary -->/g) ?? []).length, 7);
  });
});

describe('DB 읽기', () => {
  const cfg = { url: 'https://db.example', key: 'sb_secret_x' };

  test('관찰 행 keyset: 다음 페이지 하한을 마지막 시각으로 좁히고 source 를 거른다', async () => {
    const urls: string[] = [];
    const pages = [
      [row('mcp:a', '2026-11-01T00:00:01Z'), row('mcp:b', '2026-11-01T00:00:02Z')],
      [row('mcp:c', '2026-11-01T00:00:03Z')],
    ];
    const fetchImpl = (async (u: string) => {
      urls.push(decodeURIComponent(u));
      return new Response(JSON.stringify(pages[urls.length - 1] ?? []), { status: 200 });
    }) as unknown as typeof fetch;
    const seen: number[] = [];
    const total = await streamObservations(cfg, '2026-10-07T00:00:00.000Z', NOV.end, (p) => seen.push(p.length), { fetchImpl, pageSize: 2 });
    assert.equal(total, 3);
    assert.deepEqual(seen, [2, 1]);
    assert.match(urls[0]!, /source=in\.\(scanner,scanner_rotating,scanner_requested\)/);
    assert.match(urls[0]!, /observed_at=gte\.2026-10-07T00:00:00\.000Z/);
    assert.match(urls[0]!, /observed_at=lt\.2026-12-01T00:00:00\.000Z/);
    assert.match(urls[1]!, /observed_at=gte\.2026-11-01T00:00:02Z/);
  });

  test('countRows: HEAD + count=exact, Content-Range 에서 숫자', async () => {
    let init: RequestInit | undefined;
    let url = '';
    const fetchImpl = (async (u: string, i: RequestInit) => {
      url = decodeURIComponent(u);
      init = i;
      return new Response(null, { status: 200, headers: { 'content-range': '*/42' } });
    }) as unknown as typeof fetch;
    assert.equal(await countRows(cfg, 'registry_changes', { kind: 'eq.new' }, { fetchImpl }), 42);
    assert.equal(init?.method, 'HEAD');
    assert.equal((init?.headers as Record<string, string>).Prefer, 'count=exact');
    assert.match(url, /\/rest\/v1\/registry_changes\?select=\*&kind=eq\.new$/);
    await assert.rejects(countRows(cfg, 'bad;table', {}, { fetchImpl }));
  });
});
