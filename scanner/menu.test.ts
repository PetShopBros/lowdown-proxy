// 메뉴판(public/menu.json)·메뉴 목록·피드백 형식이 서로 맞는지 + 피드백 검증
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

const repPath = '../api/reputation/[target].ts';
const fbPath = '../api/feedback.ts';

describe('메뉴판·목록 일치', () => {
  test('public/menu.json = menuCard() (메뉴를 바꾸면 menu.json 을 다시 만든다)', async () => {
    const m = (await import(repPath)) as any;
    const file = JSON.parse(readFileSync(new URL('../public/menu.json', import.meta.url), 'utf8'));
    assert.deepEqual(file, m.menuCard());
  });

  test('피드백의 메뉴 이름·선택지 = 조회 API 의 메뉴', async () => {
    const m = (await import(repPath)) as any;
    const f = (await import(fbPath)) as any;
    const names = [...Object.keys(m.DISHES), ...Object.keys(m.SETS), ...Object.keys(m.PLANNED)].sort();
    assert.deepEqual([...f.MENU_NAMES].sort(), names);
    assert.deepEqual([...f.FEEDBACK_MISSING], [...m.MENU_FEEDBACK_MISSING]);
  });

  test('openapi.json 의 menu 값 = 단품 + 세트', async () => {
    const m = (await import(repPath)) as any;
    const o = JSON.parse(readFileSync(new URL('../public/openapi.json', import.meta.url), 'utf8'));
    const p = Object.entries(o.paths).find(([k]) => k.includes('reputation'))![1] as any;
    const menu = p.get.parameters.find((x: any) => x.name === 'menu');
    assert.deepEqual([...menu.schema.enum].sort(), [...Object.keys(m.DISHES), ...Object.keys(m.SETS)].sort());
  });

  test('parseMenu: 없음·full → null, 단품·세트 → 이름, 나머지 400', async () => {
    const m = (await import(repPath)) as any;
    assert.deepEqual(m.parseMenu(undefined), { ok: true, menu: null });
    assert.deepEqual(m.parseMenu('full'), { ok: true, menu: null });
    assert.deepEqual(m.parseMenu(['status', 'tools']), { ok: true, menu: 'status' });
    assert.equal(m.parseMenu('radar').body.error, 'menu_not_available');
    assert.equal(m.parseMenu('x'.repeat(41)).body.error, 'invalid_menu');
  });

  test('applyMenu: content-flags 는 new_flags 가 있는 변경만, 해시·원문 없이', async () => {
    const m = (await import(repPath)) as any;
    const body = {
      target: 't', message: 'm',
      scanner: { definition_changes: { content_flags_checked: true, content_flags_basis: 'b', events: [
        { day: '2026-10-20', kinds: ['description_changed'], new_flags: [{ flag: 'description_url', domains: ['x.example'] }] },
        { day: '2026-10-21', kinds: ['schema_changed'], new_flags: [] },
        { day: '2026-10-22', kinds: ['schema_changed'], new_flags: null },
      ] } },
      source: { name: 'Lowdown' },
    };
    const r = m.applyMenu(body, 'content-flags');
    assert.deepEqual(r, {
      target: 't', message: 'm', menu: 'content-flags',
      content_flags: { checked: true, events: [{ day: '2026-10-20', new_flags: [{ flag: 'description_url', domains: ['x.example'] }] }], basis: 'b' },
      source: { name: 'Lowdown' },
    });
    assert.equal(m.applyMenu(body, null), body);
  });
});

describe('피드백 검증', () => {
  test('정해진 선택지만, note 는 200자 이하·제어 문자 제거, 중복 제거·정렬', async () => {
    const f = (await import(fbPath)) as any;
    const ok = f.parseFeedback({ useful: 'partly', menu: 'install-check', target: 'mcp:io.github.acme/solo', missing: ['alerts', 'stdio_results', 'alerts'], note: ' wanted\nstdio ' });
    assert.deepEqual(ok, { ok: true, row: { target: 'mcp:io.github.acme/solo', menu: 'install-check', useful: 'partly', missing: ['alerts', 'stdio_results'], note: 'wanted stdio' } });
    assert.equal(f.parseFeedback({ useful: 'great' }).ok, false);
    assert.equal(f.parseFeedback({ useful: 'yes', missing: ['free-text'] }).ok, false);
    assert.equal(f.parseFeedback({ useful: 'yes', menu: 'nope' }).ok, false);
    assert.equal(f.parseFeedback({ useful: 'yes', target: '<script>' }).ok, false);
    assert.equal(f.parseFeedback({ useful: 'yes', note: 'x'.repeat(201) }).ok, false);
    assert.equal(f.parseFeedback([]).ok, false);
    assert.deepEqual(f.parseFeedback({ useful: 'no' }), { ok: true, row: { target: null, menu: null, useful: 'no', missing: [], note: null } });
  });
});
