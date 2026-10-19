import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { aggregateObserved, computeFirstSeen, fetchFirstSeen, insertToolSets, isPublishable, namespaceOf, toolSetRows, upsertFirstSeen } from './first-seen.ts';
import type { FirstSeenRow } from './first-seen.ts';
import { capabilityKeys, namesHash, probeRemote, toolNameList } from './lib.ts';
import type { ObservationRow, PostFn } from './lib.ts';

function row(target: string, url: string, over: Partial<ObservationRow> & { meta?: Record<string, unknown> } = {}): ObservationRow {
  const { meta, ...rest } = over;
  return {
    scan_run_id: 'r',
    node_id: 'n',
    target_id: target,
    target_type: 'mcp_server',
    observed_at: '2026-10-20T01:20:00Z',
    source: 'scanner',
    transport: 'streamable-http',
    http_status: 200,
    reached_level: 2,
    latency_ms: 10,
    error_type: null,
    metadata: { remote_url: url, ...meta },
    ...rest,
  } as ObservationRow;
}

describe('0.4.0 수집 형식', () => {
  test('capabilityKeys: 최상위 키만, 형식 통과, 정렬, experimental 안쪽은 보지 않음', () => {
    assert.deepEqual(capabilityKeys({ tools: { listChanged: true }, resources: {}, experimental: { 'x y': 1, evil: 2 }, 'bad key': {}, logging: {} }), [
      'experimental',
      'logging',
      'resources',
      'tools',
    ]);
    assert.equal(capabilityKeys(null), null);
    assert.equal(capabilityKeys([]), null);
    assert.equal(capabilityKeys(Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`k${String(i).padStart(2, '0')}`, {}])))!.length, 20);
  });

  test('toolNameList: 형식 통과만, 중복 제거, 정렬, 걸러진 수', () => {
    const r = toolNameList([{ name: 'b_tool' }, { name: 'a.tool' }, { name: 'a.tool' }, { name: 'has space' }, { name: '<script>' }, {}, 'x', { name: 'x'.repeat(65) }]);
    assert.deepEqual(r.names, ['a.tool', 'b_tool']);
    assert.equal(r.rejected, 5);
    const many = toolNameList(Array.from({ length: 250 }, (_, i) => ({ name: `t${String(i).padStart(3, '0')}` })));
    assert.equal(many.names.length, 200);
    assert.equal(many.rejected, 50);
  });

  test('namesHash: 순서 무관, 이름 집합이 같으면 같다', () => {
    assert.equal(namesHash(['b', 'a']), namesHash(['a', 'b']));
    assert.notEqual(namesHash(['a']), namesHash(['a', 'b']));
  });

  test('probeRemote: capabilities·names_hash 는 metadata, 도구 이름은 행 밖(tool_names)', async () => {
    const post: PostFn = async (_u, body) => {
      const m = body ? (JSON.parse(body) as { method?: string }).method : '';
      const reply = (message: unknown) => ({ status: 200, headers: {}, message, ms: 5 }) as Awaited<ReturnType<PostFn>>;
      if (m === 'initialize') return reply({ id: 1, result: { protocolVersion: '2025-06-18', capabilities: { tools: {}, prompts: {} } } });
      if (m === 'notifications/initialized') return { status: 202, headers: {}, message: null, ms: 1 } as Awaited<ReturnType<PostFn>>;
      return reply({ id: 2, result: { tools: [{ name: 'search', description: 'secret' }, { name: 'bad name' }] } });
    };
    const r = await probeRemote({ type: 'streamable-http', url: 'https://h.example/mcp' }, { registryVersion: '1', index: 0 }, post);
    assert.equal(r.reached_level, 2);
    assert.deepEqual(r.metadata.capabilities, ['prompts', 'tools']);
    assert.equal(r.metadata.names_hash, namesHash(['search']));
    assert.equal(r.metadata.tool_names_rejected, 1);
    assert.deepEqual(r.tool_names, ['search']);
    assert.ok(!JSON.stringify(r.metadata).includes('search'));
    assert.ok(!JSON.stringify(r).includes('secret'));
  });
});

describe('최초 관측 계산', () => {
  const names = new Map<ObservationRow, string[]>();
  const a1 = row('mcp:io.github.alice/one', 'https://a.example/mcp', { meta: { capabilities: ['tools'], protocol_version: '2025-06-18' } });
  const a2 = row('mcp:io.github.alice/two', 'https://a.example/two', { meta: { capabilities: ['tools'], protocol_version: '2025-06-18' } });
  const b1 = row('mcp:io.github.bob/x', 'https://b.example/mcp', { meta: { capabilities: ['tools', 'prompts'], protocol_version: '2025-06-18' } });
  const c1 = row('mcp:com.carol/y', 'https://c.example/mcp', { meta: { protocol_version: 'bad version!' }, reached_level: 1 });
  const dead = row('mcp:io.github.dan/z', 'https://d.example/mcp', { reached_level: 0, meta: { capabilities: ['ghost'] } });
  names.set(a1, ['search']);
  names.set(a2, ['search']);
  names.set(b1, ['search', 'fetch']);
  const rows = [a1, a2, b1, c1, dead];
  const agg = aggregateObserved(rows, (r) => names.get(r));
  const NOW = { now: '2026-10-20T01:30:00.000Z', scanRunId: '00000000-0000-0000-0000-000000000002' };

  test('namespaceOf', () => {
    assert.equal(namespaceOf('mcp:io.github.Alice/one'), 'io.github.alice');
    assert.equal(namespaceOf('mcp:noslash'), 'noslash');
  });

  test('집계: 고유 대상·호스트·네임스페이스 구분, L0 제외, 형식 아닌 버전 제외', () => {
    const s = agg.get('tool_name\u0000search')!;
    assert.deepEqual([s.targets.size, s.hosts.size, s.namespaces.size], [3, 2, 2]);
    const t = agg.get('capability\u0000tools')!;
    assert.deepEqual([t.targets.size, t.hosts.size, t.namespaces.size], [3, 2, 2]);
    assert.equal(agg.has('capability\u0000ghost'), false);
    assert.equal(agg.has('protocol_version\u0000bad version!'), false);
    assert.equal(agg.get('tool_name\u0000fetch')!.hosts.size, 1);
  });

  test('첫 실행은 전부 baseline, 최초 관측 없음', () => {
    const r = computeFirstSeen([], agg, NOW);
    assert.equal(r.mode, 'bootstrap');
    assert.ok(r.upserts.every((u) => u.baseline));
    assert.equal(r.firstObserved.length, 0);
    assert.equal(r.upserts.length, agg.size);
  });

  test('다음 실행: 새 값만 최초 관측, 수가 바뀐 행만 갱신, 그대로인 행은 쓰지 않음', () => {
    const base = computeFirstSeen([], agg, NOW).upserts;
    const e1 = row('mcp:io.github.erin/new', 'https://e.example/mcp', { meta: { capabilities: ['tools', 'tasks'], protocol_version: '2025-06-18' } });
    const n2 = new Map(names);
    n2.set(e1, ['search', 'brand_new']);
    const r = computeFirstSeen(base, aggregateObserved([...rows, e1], (x) => n2.get(x)), { ...NOW, now: '2026-10-21T01:30:00.000Z' });
    assert.equal(r.mode, 'diff');
    assert.deepEqual(r.firstObserved.map((x) => `${x.kind}:${x.value}`).sort(), ['capability:tasks', 'tool_name:brand_new']);
    assert.ok(r.firstObserved.every((x) => !x.baseline && x.first_seen_on === '2026-10-21'));
    const changed = r.upserts.filter((u) => u.baseline).map((u) => `${u.kind}:${u.value}`).sort();
    assert.deepEqual(changed, ['capability:tools', 'protocol_version:2025-06-18', 'tool_name:search']); // 대상·호스트 수 증가
    const search = r.upserts.find((u) => u.value === 'search')!;
    assert.equal(search.first_seen_on, '2026-10-20'); // 처음 본 날은 바뀌지 않음
  });

  test('공개 기준(노출 정책): tool_name 은 호스트 2 + 네임스페이스 2 이상', () => {
    assert.equal(isPublishable({ kind: 'tool_name', hosts: 2, namespaces: 2, baseline: false }), true);
    assert.equal(isPublishable({ kind: 'tool_name', hosts: 5, namespaces: 1, baseline: false }), false); // 한 게시자가 여러 호스트
    assert.equal(isPublishable({ kind: 'tool_name', hosts: 1, namespaces: 3, baseline: false }), false); // 한 호스트
    assert.equal(isPublishable({ kind: 'capability', hosts: 1, namespaces: 1, baseline: false }), true);
  });

  test('toolSetRows: (대상, names_hash) 한 번만, partial·rejected·schema_hash', () => {
    const x = row('mcp:t/a', 'https://x/1', { meta: { names_hash: 'h1', tools_has_more: true, tool_names_rejected: 2, schema_hash: 's1' } });
    const y = row('mcp:t/a', 'https://x/2', { meta: { names_hash: 'h1' } });
    const m = new Map([[x, ['a']], [y, ['a']]]);
    const sets = toolSetRows([x, y, dead], (r) => m.get(r), NOW);
    assert.equal(sets.length, 1);
    assert.deepEqual([sets[0]!.partial, sets[0]!.rejected, sets[0]!.schema_hash, sets[0]!.names], [true, 2, 's1', ['a']]);
  });
});

describe('최초 관측 DB 입출력', () => {
  const cfg = { url: 'https://x.supabase.co/', key: 'sb_secret_abc' };
  test('fetchFirstSeen: id keyset, id 는 결과에서 뺀다, 오류는 throw', async () => {
    const all = Array.from({ length: 3 }, (_, i) => ({ id: i + 1, kind: 'tool_name', value: `v${i}` }));
    const urls: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      urls.push(String(input));
      const after = Number(new URL(String(input)).searchParams.get('id')!.replace('gt.', ''));
      return new Response(JSON.stringify(all.filter((r) => r.id > after).slice(0, 2)), { status: 200 });
    }) as typeof fetch;
    const rows = await fetchFirstSeen(cfg, { fetchImpl, pageSize: 2 });
    assert.equal(rows.length, 3);
    assert.ok(!('id' in rows[0]!));
    assert.equal(urls.length, 2);
    const bad = (async () => new Response('x', { status: 500 })) as typeof fetch;
    await assert.rejects(fetchFirstSeen(cfg, { fetchImpl: bad }), /HTTP 500/);
  });

  test('upsert 는 (kind,value) merge, tool_sets 는 (target_id,names_hash) ignore-duplicates', async () => {
    const seen: Array<{ url: string; prefer: string }> = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(input), prefer: String((init?.headers as Record<string, string>).Prefer) });
      return new Response(null, { status: 201 });
    }) as typeof fetch;
    const fs = [{ kind: 'capability', value: 'tools' } as FirstSeenRow];
    await upsertFirstSeen(cfg, fs, { fetchImpl });
    await insertToolSets(cfg, [{ target_id: 't', names_hash: 'h', names: [], rejected: 0, partial: false, schema_hash: null, first_seen_at: 'x', scan_run_id: 'r' }], { fetchImpl });
    assert.match(seen[0]!.url, /scanner_first_seen\?on_conflict=kind,value$/);
    assert.match(seen[0]!.prefer, /merge-duplicates/);
    assert.match(seen[1]!.url, /scanner_tool_sets\?on_conflict=target_id,names_hash$/);
    assert.match(seen[1]!.prefer, /ignore-duplicates/);
  });
});
