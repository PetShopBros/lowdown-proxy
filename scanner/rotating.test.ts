import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { pickRotating, rotationGroupForDay, rotationGroupOf, rotationMeta } from './rotating-lib.ts';

// 바깥 고리(순환 관찰): 묶음은 이름마다 고정, 하루 한 묶음, 매일 줄과 겹치지 않음, 사흘이면 전부 한 번씩.
const DAY = 86_400_000;
const names = Array.from({ length: 300 }, (_, i) => `io.github.x/s${i}`);

describe('순환 묶음', () => {
  test('사흘 동안 바깥 대상 전부를 정확히 한 번씩, 매일 줄 대상은 빼고', () => {
    const exclude = new Set(['mcp:io.github.x/s0', 'mcp:io.github.x/s1']);
    const seen = new Map<string, number>();
    const t0 = Date.parse('2026-11-07T01:17:00Z');
    for (let d = 0; d < 3; d++) {
      const p = pickRotating(names, exclude, 3, t0 + d * DAY);
      assert.equal(p.outside, 298);
      for (const id of p.ids) seen.set(id, (seen.get(id) ?? 0) + 1);
    }
    assert.equal(seen.size, 298);
    assert.ok([...seen.values()].every((n) => n === 1));
    assert.ok(!seen.has('mcp:io.github.x/s0'));
    // 나흘째는 첫날과 같은 묶음
    assert.deepEqual(pickRotating(names, exclude, 3, t0 + 3 * DAY).ids, pickRotating(names, exclude, 3, t0).ids);
  });

  test('끔(0)·매일(1)·묶음 고정', () => {
    assert.deepEqual(pickRotating(names, new Set(), 0, Date.now()).ids, []);
    assert.equal(pickRotating(names, new Set(), 1, Date.now()).ids.length, 300);
    assert.equal(rotationGroupOf('io.github.x/s7', 3), rotationGroupOf('io.github.x/s7', 3));
    assert.equal(rotationGroupForDay(0, 3), 0);
    assert.deepEqual(rotationMeta(3, 2), { cohort_version: 'rotating', cohort_versions: ['rotating'], observation_basis: 'rotating', rotation: { days: 3, group: 2 } });
  });
});

describe('상태 첫 문장·블록: 순환 관찰', async () => {
  const rep = (await import('../api/reputation/[target].ts' as string)) as any;
  const NOW = Date.parse('2026-11-16T05:00:00Z');
  const row = (o: Record<string, unknown> = {}) => ({
    target_id: 'mcp:io.github.acme/r', latest_day: '2026-11-15', latest_state: 'answered', latest_remote_states: { answered: 1 }, latest_remotes: 1,
    latest_tool_count: 4, latest_observation_basis: 'rotating', streak_days: 3, streak_start_day: '2026-11-09', streak_break: 'no_earlier_observation',
    observed_days_30d: 3, answered_days_30d: 3, auth_required_days_30d: 0, no_response_days_30d: 0, mixed_days_30d: 0,
    definition_id: 'target_status', definition_version: 2, computed_at: '2026-11-16T03:37:00Z', check_interval_days: 3, scheduled_checks_30d: 3, ...o,
  });

  test('간격·예정 점검 수를 싣고, 문장에 간격을 밝힌다', () => {
    const r = rep.shapeStatus(row(), NOW)!;
    assert.equal(r.block.check_interval_days, 3);
    assert.equal(r.block.observation_basis, 'rotating');
    assert.equal(r.block.checks_30d.scheduled, 3);
    assert.equal(r.lead, 'Answered initialize and tools/list on all 3 checks recorded in the last 30 days (2026-11-09 to 2026-11-15) (Lowdown checks this server every 3 days); 4 tools listed.');
  });

  test('오래됨 기준 = 간격 + 1일: 3일 전은 현재 상태를 말하고, 5일 전은 말하지 않는다', () => {
    assert.equal(rep.shapeStatus(row({ latest_day: '2026-11-13' }), NOW)!.block.stale, false);
    const old = rep.shapeStatus(row({ latest_day: '2026-11-11' }), NOW)!;
    assert.equal(old.block.stale, true);
    assert.match(old.lead, /^No Lowdown check since 2026-11-11/);
  });

  test('예정 점검 중 기록 없는 것과 끊긴 이유', () => {
    const r = rep.shapeStatus(row({ streak_days: 1, streak_start_day: '2026-11-15', streak_break: 'not_observed', observed_days_30d: 2, answered_days_30d: 2, scheduled_checks_30d: 3 }), NOW)!;
    assert.match(r.lead, /2 of 2 checks in the last 30 days had this result\. 1 of 3 scheduled checks have no record\. The scheduled check before 2026-11-15 has no record\.$/);
  });

  test('v1 행(열 없음)은 매일 기준 그대로', () => {
    const { check_interval_days: _a, scheduled_checks_30d: _b, ...v1 } = row({ latest_observation_basis: 'fixed_cohort', definition_version: 1 });
    const r = rep.shapeStatus(v1, NOW)!;
    assert.equal(r.block.check_interval_days, 1);
    assert.equal(r.block.checks_30d.scheduled, undefined);
    assert.match(r.lead, /daily checks/);
  });

  test('빠진 날: 순환이면 예정일만', () => {
    const observed = new Set(['2026-11-09', '2026-11-15']); // 11-12 예정일 빠짐
    const miss = rep.missingDays(observed, '2026-11-09', NOW, new Map(), 3);
    assert.deepEqual(miss.map((m: any) => m.day), ['2026-11-12']);
    assert.equal(rep.missingDays(observed, '2026-11-09', NOW, new Map()).length, 5); // 매일 기준이면 10~14 중 12 포함 5일
  });
});
