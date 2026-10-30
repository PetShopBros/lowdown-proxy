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
