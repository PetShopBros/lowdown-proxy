// find (조건 검색): 쿼리 검증·정규화·결과 모양
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

const findPath = '../api/find.ts';
const load = async () => (await import(findPath)) as any;

describe('find', () => {
  test('기본값: 이름순 20건', async () => {
    const m = await load();
    const r = m.parseFind({});
    assert.equal(r.ok, true);
    assert.equal(r.query.sort, 'name');
    assert.equal(r.query.order, 'asc');
    assert.equal(r.query.limit, 20);
    assert.equal(m.canonical(r.query), '');
  });

  test('정렬 키마다 기본 방향, order 로 바꿀 수 있다', async () => {
    const m = await load();
    assert.equal(m.parseFind({ sort: 'tools' }).query.order, 'desc');
    assert.equal(m.parseFind({ sort: 'stable' }).query.order, 'asc');
    const r = m.parseFind({ sort: 'tools', order: 'asc' });
    assert.equal(m.canonical(r.query), 'sort=tools&order=asc');
  });

  test('no_auth=1 = state=answered, 다른 상태와 같이 쓰면 400', async () => {
    const m = await load();
    assert.equal(m.parseFind({ no_auth: '1' }).query.state, 'answered');
    assert.equal(m.parseFind({ no_auth: '1', state: 'no_response' }).ok, false);
  });

  test('모르는 값·범위 밖은 400 + 허용 값', async () => {
    const m = await load();
    for (const q of [{ sort: 'score' }, { state: 'healthy' }, { limit: '51' }, { limit: '0' }, { answered_days: '31' },
      { offset: '2001' }, { q: 'a' }, { q: 'x%y' }, { registry: 'deleted' }, { package: 'bad' }, { order: 'up' }, { tools_min: '-1' }]) {
      const r = m.parseFind(q);
      assert.equal(r.ok, false, JSON.stringify(q));
      assert.equal(r.body.error, 'invalid_parameter');
      assert.ok(typeof r.body.allowed === 'string');
    }
  });

  test('조회 수 정렬은 없다', async () => {
    const m = await load();
    assert.deepEqual(Object.keys(m.SORTS).sort(), ['answering', 'changed', 'name', 'newest', 'release', 'stable', 'tools', 'updated']);
  });

  test('안내 일치: openapi·menu.json 의 정렬 키 = SORTS', async () => {
    const m = await load();
    const keys = Object.keys(m.SORTS).sort();
    const o = JSON.parse(readFileSync(new URL('../public/openapi.json', import.meta.url), 'utf8'));
    const sort = o.paths['/api/find'].get.parameters.find((x: any) => x.name === 'sort');
    assert.deepEqual([...sort.schema.enum].sort(), keys);
    const card = JSON.parse(readFileSync(new URL('../public/menu.json', import.meta.url), 'utf8'));
    assert.deepEqual([...card.find.sorts].sort(), keys);
    const state = o.paths['/api/find'].get.parameters.find((x: any) => x.name === 'state');
    assert.deepEqual(state.schema.enum, [...m.STATES]);
  });

  test('결과: 오래된 점검은 상태를 말하지 않고, 조회 주소를 붙인다', async () => {
    const m = await load();
    const now = Date.parse('2026-10-31T05:00:00Z');
    const row = { name: 'io.github.a/b', latest_state: 'answered', latest_day: '2026-10-31', tool_count: 4, tool_set_since: '2026-09-01' };
    const r = m.shapeResult(row, 'stable', now);
    assert.equal(r.state, 'answered');
    assert.equal(r.tool_count, 4);
    assert.equal(r.sort_value, '2026-09-01');
    assert.equal(r.lookup, 'https://lowdown-proxy.vercel.app/api/reputation/mcp:io.github.a/b');
    assert.equal(r.page, 'https://lowdown-proxy.vercel.app/servers/io.github.a/b');
    const old = m.shapeResult({ ...row, latest_day: '2026-10-20' }, 'name', now);
    assert.equal(old.stale, true);
    assert.equal(old.state, null);
  });
});