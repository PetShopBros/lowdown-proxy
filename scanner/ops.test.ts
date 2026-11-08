import { test } from 'node:test';
import assert from 'node:assert/strict';
import { judgeDb, judgeRuns, renderMarkdown, unrecovered, type RunLike, type WorkflowCheck } from './ops-lib.ts';

const now = new Date('2026-11-08T03:37:00Z');
const R = (created_at: string, conclusion: string | null, status = 'completed'): RunLike => ({ created_at, completed_at: status === 'completed' ? created_at : null, status, conclusion });
const W = (maxAgeHours: number | null): WorkflowCheck => ({ id: 'x', kind: 'workflow', workflow: 'x.yml', maxAgeHours });

test('judgeRuns: 성공 → ok, 마지막이 실패 → failing(마지막 성공 뒤 첫 실패부터)', () => {
  assert.equal(judgeRuns(W(26), [R('2026-11-08T01:00:00Z', 'success')], now).status, 'ok');
  const r = judgeRuns(W(26), [R('2026-11-05T01:00:00Z', 'success'), R('2026-11-06T01:00:00Z', 'failure'), R('2026-11-07T01:00:00Z', 'failure'), R('2026-11-08T01:00:00Z', 'failure')], now);
  assert.equal(r.status, 'failing');
  assert.equal(r.failing_since, '2026-11-06T01:00:00Z');
  assert.equal(r.failures_24h, 1);
  assert.equal(unrecovered([r], now).length, 1);
});

test('judgeRuns: skipped·진행 중은 빼고, 오래된 성공은 stale', () => {
  const r = judgeRuns(W(26), [R('2026-11-06T00:00:00Z', 'success'), R('2026-11-08T01:00:00Z', 'skipped'), R('2026-11-08T03:00:00Z', null, 'in_progress')], now);
  assert.equal(r.status, 'stale');
  assert.equal(r.failing_since, '2026-11-07T02:00:00.000Z');
  assert.equal(judgeRuns(W(null), [], now).status, 'not_seen');
  assert.equal(judgeRuns(W(26), [], now).status, 'stale');
});

test('judgeRuns: 실패 뒤 성공하면 ok(복구)', () => {
  assert.equal(judgeRuns(W(26), [R('2026-11-07T01:00:00Z', 'failure'), R('2026-11-08T01:00:00Z', 'success')], now).status, 'ok');
});

test('judgeDb: 허용 간격 안이면 ok, 넘으면 stale, 오류는 error', () => {
  const c = { id: 'db/x', kind: 'db' as const, table: 'x', column: 'created_at', maxAgeHours: 3 };
  assert.equal(judgeDb(c, '2026-11-08T02:00:00Z', now).status, 'ok');
  const s = judgeDb(c, '2026-11-07T00:00:00Z', now);
  assert.equal(s.status, 'stale');
  assert.equal(s.failing_since, '2026-11-07T03:00:00.000Z');
  assert.equal(judgeDb(c, null, now, 'HTTP 500').status, 'error');
});

test('renderMarkdown: 복구 안 됨을 맨 위에, 오류 원문 없음', () => {
  const rows = [judgeRuns({ ...W(26), id: 'scanner/report' }, [R('2026-11-02T01:00:00Z', 'success'), R('2026-11-03T01:00:00Z', 'failure'), R('2026-11-08T01:00:00Z', 'failure')], now), judgeDb({ id: 'db/edge_hits', kind: 'db', table: 'edge_hits', column: 'created_at', maxAgeHours: 3 }, null, now, 'secret detail')];
  const md = renderMarkdown(rows, now);
  assert.match(md, /24시간 넘게 복구되지 않음 \(1\)/);
  assert.match(md, /\*\*scanner\/report\*\* — ❌ failing, 5일째/);
  assert.doesNotMatch(md, /secret detail/);
});
