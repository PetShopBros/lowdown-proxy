import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

// 서버 카드: 오늘(UTC) 데이터 갱신 뒤에 만든 카드만 쓴다. 응답의 retrieved_at 만 바꾼다.
type Rep = {
  cardUsable: (builtAt: unknown, now: number) => boolean;
  cardBody: (body: Record<string, any>, now: number) => Record<string, any>;
  CARD_READY_UTC_HOUR: number;
};
const rep = async () => (await import('../api/reputation/[target].ts' as string)) as Rep;

describe('서버 카드', () => {
  test('오늘 UTC 04:00 이후에 만든 카드만 쓴다', async () => {
    const { cardUsable, CARD_READY_UTC_HOUR } = await rep();
    assert.equal(CARD_READY_UTC_HOUR, 4);
    const now = Date.parse('2026-10-30T05:00:00Z');
    assert.equal(cardUsable('2026-10-30T04:10:00Z', now), true);
    assert.equal(cardUsable('2026-10-30T02:20:00Z', now), false); // 상태 갱신 전
    assert.equal(cardUsable('2026-10-29T20:00:00Z', now), false); // 전날
    assert.equal(cardUsable('2026-10-30T06:00:00Z', now), false); // 미래
    assert.equal(cardUsable(null, now), false);
    assert.equal(cardUsable('x', now), false);
    // 자정 직후~04:00 은 전날 카드를 쓰지 않는다 → 실시간 계산
    assert.equal(cardUsable('2026-10-30T15:10:00Z', Date.parse('2026-10-31T01:00:00Z')), false);
  });

  test('retrieved_at 만 지금 시각으로', async () => {
    const { cardBody } = await rep();
    const body = { message: 'm', source: { retrieved_at: '2026-10-30T04:10:00.000Z', cite: 'c' } };
    const out = cardBody(body, Date.parse('2026-10-30T07:00:00Z'));
    assert.equal(out.source.retrieved_at, '2026-10-30T07:00:00.000Z');
    assert.equal(out.source.cite, 'c');
    assert.equal(out.message, 'm');
    assert.equal(body.source.retrieved_at, '2026-10-30T04:10:00.000Z'); // 원본은 그대로
  });

});

describe('서버 카드 이어 만들기 (2026-11-12)', () => {
  const nb = async () => (await import('./cards-resume.ts' as string)) as {
    needsBuild: (s: any, card: any, now: number, version: string) => boolean;
  };
  const now = Date.parse('2026-11-12T15:10:00Z');
  const s = { target_id: 'mcp:a/b', latest_day: '2026-11-12', latest_state: 'answered', observed_days_30d: 4, answered_days_30d: 4, streak_days: 4 };
  const card = {
    target_id: 'mcp:a/b', built_at: '2026-11-12T05:00:00Z', builder_version: 'cards-3',
    latest_day: '2026-11-12', latest_state: 'answered', observed_days_30d: 4, answered_days_30d: 4, consecutive_days: 4,
  };

  test('오늘 카드가 있고 요약 값이 같으면 건너뛴다', async () => {
    const { needsBuild } = await nb();
    assert.equal(needsBuild(s, card, now, 'cards-3'), false);
  });

  test('카드 없음·다른 버전·오늘 쓸 수 없는 카드는 만든다', async () => {
    const { needsBuild } = await nb();
    assert.equal(needsBuild(s, undefined, now, 'cards-3'), true);
    assert.equal(needsBuild(s, card, now, 'cards-4'), true);
    assert.equal(needsBuild(s, { ...card, built_at: '2026-11-12T03:59:00Z' }, now, 'cards-3'), true); // 04:00 UTC 전
    assert.equal(needsBuild(s, { ...card, built_at: '2026-11-11T20:00:00Z' }, now, 'cards-3'), true); // 전날
    assert.equal(needsBuild(s, { ...card, built_at: null }, now, 'cards-3'), true);
  });

  test('요약 값이 바뀐 대상만 다시 만든다 (오후 실행)', async () => {
    const { needsBuild } = await nb();
    assert.equal(needsBuild({ ...s, latest_day: '2026-11-13' }, card, now, 'cards-3'), true);
    assert.equal(needsBuild({ ...s, latest_state: 'no_response' }, card, now, 'cards-3'), true);
    assert.equal(needsBuild({ ...s, observed_days_30d: 5 }, card, now, 'cards-3'), true);
    assert.equal(needsBuild({ ...s, answered_days_30d: 3 }, card, now, 'cards-3'), true);
    assert.equal(needsBuild({ ...s, streak_days: 1 }, card, now, 'cards-3'), true);
    // 날짜 형식 차이(timestamp 꼴)는 같은 날로 본다
    assert.equal(needsBuild({ ...s, latest_day: '2026-11-12T00:00:00' }, card, now, 'cards-3'), false);
  });
});
