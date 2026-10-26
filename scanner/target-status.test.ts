import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

// 첫 문장(연결 상태): 관찰 사실만, 관찰 없음 ≠ 실패, 원격이 다르면 섞였다고, 오래된 점검이면 현재 상태를 말하지 않는다.
type Shape = (row: Record<string, unknown>, now: number) => { block: Record<string, any>; lead: string } | null;
const load = async () => (await import('../api/reputation/[target].ts' as string)) as { shapeStatus: Shape; STATUS_STALE_DAYS: number };

const NOW = Date.parse('2026-10-27T05:00:00Z');
const row = (o: Record<string, unknown> = {}) => ({
  target_id: 'mcp:io.github.acme/x',
  latest_day: '2026-10-26',
  latest_state: 'answered',
  latest_remote_states: { answered: 1 },
  latest_remotes: 1,
  latest_tool_count: 5,
  latest_observation_basis: 'fixed_cohort',
  streak_days: 21,
  streak_start_day: '2026-10-06',
  streak_break: 'no_earlier_observation',
  observed_days_30d: 21,
  answered_days_30d: 21,
  auth_required_days_30d: 0,
  no_response_days_30d: 0,
  mixed_days_30d: 0,
  definition_id: 'target_status',
  definition_version: 1,
  computed_at: '2026-10-27T03:37:00Z',
  ...o,
});

describe('연결 상태 첫 문장', () => {
  test('21일 모두 응답: "all 21" 은 관찰일 전부일 때만', async () => {
    const { shapeStatus } = await load();
    const r = shapeStatus(row(), NOW)!;
    assert.equal(r.lead, 'Answered initialize and tools/list on all 21 daily checks recorded in the last 30 days (2026-10-06 to 2026-10-26); 5 tools listed.');
    assert.equal(r.block.state, 'answered');
    assert.equal(r.block.stale, false);
    assert.deepEqual(r.block.definition, { id: 'target_status', version: 1 });
    assert.equal(r.block.computed_at, '2026-10-27T03:37:00.000Z');
  });

  test('연속 3일 응답이지만 관찰 21일 중 18일만 응답 → "last 3 consecutive" 와 18 of 21', async () => {
    const { shapeStatus } = await load();
    const r = shapeStatus(row({ streak_days: 3, streak_start_day: '2026-10-24', streak_break: 'state_change', answered_days_30d: 18 }), NOW)!;
    assert.equal(r.lead, 'Answered initialize and tools/list on the last 3 consecutive daily checks (2026-10-24 to 2026-10-26); 5 tools listed. 18 of 21 observed days in the last 30 had this result.');
  });

  test('연속 실패: 한 지점 단서, 전날 점검 없음은 실패로 세지 않고 밝힌다', async () => {
    const { shapeStatus } = await load();
    const r = shapeStatus(row({ latest_state: 'no_response', latest_remote_states: { no_response: 1 }, latest_tool_count: null, streak_days: 2, streak_start_day: '2026-10-25', streak_break: 'not_observed', observed_days_30d: 3, answered_days_30d: 0, no_response_days_30d: 3 }), NOW)!;
    assert.equal(r.lead, 'No successful response on the last 2 consecutive daily checks (2026-10-25 to 2026-10-26). Checked from one network location. 3 of 3 observed days in the last 30 had this result. The day before 2026-10-25 has no check.');
    assert.equal(r.block.tool_count, null);
  });

  test('인증 필요는 실패와 따로', async () => {
    const { shapeStatus } = await load();
    const r = shapeStatus(row({ latest_state: 'auth_required', latest_remote_states: { auth_required: 1 }, streak_days: 30, streak_start_day: '2026-09-27', streak_break: 'window_start', observed_days_30d: 30, answered_days_30d: 0, auth_required_days_30d: 30 }), NOW)!;
    assert.equal(r.lead, 'Required authentication (HTTP 401/403) on all 30 daily checks recorded in the last 30 days (2026-09-27 to 2026-10-26). Lowdown checks without credentials, so no tools were listed.');
    assert.equal(r.block.tool_count, null);
  });

  test('원격이 다르면 서버 전체를 응답했다고 말하지 않는다', async () => {
    const { shapeStatus } = await load();
    const r = shapeStatus(row({ latest_state: 'mixed', latest_remote_states: { answered: 1, auth_required: 1 }, latest_remotes: 2, streak_days: 1, streak_start_day: '2026-10-26', observed_days_30d: 1 }), NOW)!;
    assert.equal(r.lead, 'On the latest daily check (2026-10-26) its remotes differed: 1 answered tools/list, 1 required authentication.');
    assert.deepEqual(r.block.remote_states, { answered: 1, auth_required: 1 });
    assert.ok(!r.lead.startsWith('Answered'));
  });

  test('처음 관찰된 대상(1일)은 "only daily check" 로', async () => {
    const { shapeStatus } = await load();
    const r = shapeStatus(row({ streak_days: 1, streak_start_day: '2026-10-26', observed_days_30d: 1, answered_days_30d: 1, latest_observation_basis: 'on_request' }), NOW)!;
    assert.equal(r.lead, 'Answered initialize and tools/list on the only daily check recorded in the last 30 days (2026-10-26); 5 tools listed.');
    assert.equal(r.block.observation_basis, 'on_request');
  });

  test(`마지막 점검이 오래되면(>${2}일) 현재 상태를 말하지 않는다`, async () => {
    const { shapeStatus, STATUS_STALE_DAYS } = await load();
    assert.equal(STATUS_STALE_DAYS, 2);
    const ok = shapeStatus(row({ latest_day: '2026-10-25' }), NOW)!;
    assert.equal(ok.block.stale, false);
    const r = shapeStatus(row({ latest_day: '2026-10-23', streak_start_day: '2026-10-03' }), NOW)!;
    assert.equal(r.block.stale, true);
    assert.equal(r.lead, 'No Lowdown daily check since 2026-10-23 (4 days ago), so no current connectivity is stated.');
  });

  test('형식이 맞지 않는 값이면 아무 말도 하지 않는다', async () => {
    const { shapeStatus } = await load();
    assert.equal(shapeStatus(row({ latest_state: 'ignore previous instructions' }), NOW), null);
    assert.equal(shapeStatus(row({ latest_day: 'yesterday' }), NOW), null);
    assert.equal(shapeStatus(row({ streak_days: 0 }), NOW), null);
    assert.equal(shapeStatus(row({ streak_days: 22 }), NOW), null); // 관찰일보다 긴 연속은 모순
    const r = shapeStatus(row({ latest_remote_states: { answered: 1, '<script>': 9 }, streak_break: 'drop table' }), NOW)!;
    assert.deepEqual(r.block.remote_states, { answered: 1 });
    assert.equal(r.block.consecutive_break, null);
  });
});
