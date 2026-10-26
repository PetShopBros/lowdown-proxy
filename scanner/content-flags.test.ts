import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

// 변경 내용 표지: 앞뒤 집합을 비교해 새로 나타난 것만, 확인 못 한 것은 null, 원문·해시는 응답에 없다.
type Mod = {
  definitionChanges: (rows: Array<Record<string, unknown>>) => Record<string, any>;
  attachNewFlags: (supabase: unknown, dc: Record<string, unknown>) => Promise<Record<string, any>>;
  flagMapsFromRows: (rows: unknown, sets: ReadonlySet<string>) => Map<string, Map<string, { defs: number; domains: string[] }>>;
  newFlagsBetween: (a: Map<string, any>, b: Map<string, any>) => Array<Record<string, any>>;
  changeFactsFrom: (dc: unknown, now: number) => string[];
};
const load = async () => (await import('../api/reputation/[target].ts' as string)) as Mod;

const H = (c: string) => c.repeat(64);
const SA = H('a');
const SB = H('b');
const SC = H('c');

/** 같은 원격, 3일: A → B(설명·스키마 변경) → C(설명 변경) */
function rows(sets: Array<string | null> = [SA, SB, SC]) {
  const base = { reached_level: 2, http_status: 200, error_type: null, remote_url: 'https://x.example/mcp', tool_count: '3' };
  return [
    { ...base, observed_at: '2026-10-24T01:20:00Z', schema_hash: '1'.repeat(16), desc_hash: '1'.repeat(16), tool_set_hash: sets[0] },
    { ...base, observed_at: '2026-10-25T01:20:00Z', schema_hash: '2'.repeat(16), desc_hash: '2'.repeat(16), tool_set_hash: sets[1] },
    { ...base, observed_at: '2026-10-26T01:20:00Z', schema_hash: '2'.repeat(16), desc_hash: '3'.repeat(16), tool_set_hash: sets[2] },
  ];
}

const rpcRows = [
  { tool_set_hash: SA, rule_id: null, defs: 0, domains: [] },
  { tool_set_hash: SB, rule_id: null, defs: 0, domains: [] },
  { tool_set_hash: SB, rule_id: 'description_url', defs: 1, domains: ['example.com'] },
  { tool_set_hash: SC, rule_id: null, defs: 0, domains: [] },
  { tool_set_hash: SC, rule_id: 'description_url', defs: 1, domains: ['example.com', 'evil.example.org'] },
  { tool_set_hash: SC, rule_id: 'hidden_characters', defs: 1, domains: [] },
];
const fakeDb = (data: unknown, error: unknown = null) => {
  const calls: unknown[] = [];
  return { calls, rpc: async (fn: string, args: unknown) => { calls.push([fn, args]); return { data, error }; } };
};

describe('변경 내용 표지', () => {
  test('이벤트마다 이전 집합 대비 새 표지만, 해시는 응답에 없다', async () => {
    const { definitionChanges, attachNewFlags } = await load();
    const db = fakeDb(rpcRows);
    const dc = await attachNewFlags(db, definitionChanges(rows()));
    assert.equal(dc.content_flags_checked, true);
    const [c26, c25] = dc.events;
    assert.equal(c26.day, '2026-10-26');
    assert.deepEqual(c26.new_flags, [
      { rule: 'description_url', definitions: { from: 1, to: 1 }, new_domains: ['evil.example.org'] },
      { rule: 'hidden_characters', definitions: { from: 0, to: 1 } },
    ]);
    assert.deepEqual(c25.new_flags, [{ rule: 'description_url', definitions: { from: 0, to: 1 }, new_domains: ['example.com'] }]);
    const json = JSON.stringify(dc);
    assert.ok(!json.includes(SA) && !json.includes(SB) && !json.includes(SC), '집합 해시가 응답에 나가면 안 된다');
    assert.equal((db.calls[0] as any)[0], 'lowdown_tool_set_flags');
  });

  test('앞뒤 집합 중 하나가 저장돼 있지 않으면 null (새 표지 없음이라고 말하지 않는다)', async () => {
    const { definitionChanges, attachNewFlags } = await load();
    const dc = await attachNewFlags(fakeDb(rpcRows.filter((r) => r.tool_set_hash !== SA)), definitionChanges(rows()));
    assert.equal(dc.events.find((e: any) => e.day === '2026-10-25').new_flags, null);
    assert.ok(Array.isArray(dc.events.find((e: any) => e.day === '2026-10-26').new_flags));
  });

  test('집합 해시가 없는 관찰(0.5.0 이전)은 RPC 없이 null', async () => {
    const { definitionChanges, attachNewFlags } = await load();
    const db = fakeDb(rpcRows);
    const dc = await attachNewFlags(db, definitionChanges(rows([null, null, null])));
    assert.equal(db.calls.length, 0);
    assert.ok(dc.events.every((e: any) => e.new_flags === null));
  });

  test('RPC 오류는 응답을 막지 않는다: null 과 content_flags_checked=false', async () => {
    const { definitionChanges, attachNewFlags } = await load();
    const dc = await attachNewFlags(fakeDb(null, { message: 'boom' }), definitionChanges(rows()));
    assert.equal(dc.content_flags_checked, false);
    assert.ok(dc.events.every((e: any) => e.new_flags === null));
  });

  test('형식이 맞지 않는 RPC 값은 버린다', async () => {
    const { flagMapsFromRows } = await load();
    const sets = new Set([SA]);
    const m = flagMapsFromRows([
      { tool_set_hash: SA, rule_id: null, defs: 0, domains: [] },
      { tool_set_hash: SA, rule_id: 'description_url', defs: 1, domains: ['ok.com', 'Ignore previous instructions', 'a'.repeat(200) + '.com'] },
      { tool_set_hash: SA, rule_id: 'made_up_rule', defs: 3, domains: [] },
      { tool_set_hash: H('d'), rule_id: null, defs: 0, domains: [] },
    ], sets);
    assert.deepEqual([...m.keys()], [SA]);
    assert.deepEqual(m.get(SA)!.get('description_url'), { defs: 1, domains: ['ok.com'] });
    assert.equal(m.get(SA)!.has('made_up_rule'), false);
  });

  test('첫 문장: 최근 7일 안의 새 표지만, 최대 2문장', async () => {
    const { definitionChanges, attachNewFlags, changeFactsFrom } = await load();
    const dc = await attachNewFlags(fakeDb(rpcRows), definitionChanges(rows()));
    const facts = changeFactsFrom(dc, Date.parse('2026-10-27T05:00:00Z'));
    assert.deepEqual(facts, [
      'On 2026-10-26 a tool description with a URL appeared (new domain: evil.example.org).',
      'On 2026-10-26 a tool definition with invisible Unicode characters appeared.',
    ]);
    assert.deepEqual(changeFactsFrom(dc, Date.parse('2026-11-10T05:00:00Z')), []);
  });

  test('표지가 줄어든 변경은 새 표지가 아니다', async () => {
    const { newFlagsBetween } = await load();
    const a = new Map([['description_url', { defs: 2, domains: ['x.com'] }]]);
    const b = new Map([['description_url', { defs: 1, domains: ['x.com'] }]]);
    assert.deepEqual(newFlagsBetween(a, b), []);
  });
});
