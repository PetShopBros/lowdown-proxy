import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { PAYMENT_BODY_MAX, PAYMENT_HEADER_MAX, PAYMENT_OPTIONS_MAX, mppChallenges, parsePaymentRequired } from './payment-lib.ts';

// 402 결제 조건 읽기 (2026-11-12): 관측만, 원문 저장 없음, 형식이 맞는 필드만, 예외 없음
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64');
const parse = (r: { status?: number; headers?: Record<string, string>; body?: string; bodyTooLarge?: boolean; stage?: 'initialize' | 'tools/list' }) =>
  parsePaymentRequired({ status: r.status ?? 402, headers: r.headers ?? {}, body: r.body, bodyTooLarge: r.bodyTooLarge, stage: r.stage ?? 'initialize' });

describe('402 결제 조건', () => {
  test('402 가 아니면 null', () => {
    assert.equal(parse({ status: 401, body: JSON.stringify({ x402Version: 1, accepts: [] }) }), null);
    assert.equal(parse({ status: 200 }), null);
  });

  test('x402 v2 헤더 우선, 본문과 다르면 헤더를 쓴다', () => {
    const r = parse({
      headers: { 'payment-required': b64({ x402Version: 2, accepts: [{ scheme: 'exact', network: 'eip155:8453', amount: '1', asset: '0xa', payTo: '0xb' }] }) },
      body: JSON.stringify({ x402Version: 1, accepts: [{ scheme: 'exact', network: 'base', maxAmountRequired: '9', payTo: '0xz' }] }),
    })!;
    assert.equal(r.source, 'header');
    assert.equal(r.version, 2);
    assert.deepEqual(r.options, [{ scheme: 'exact', network: 'eip155:8453', asset: '0xa', amount: '1', pay_to: '0xb' }]);
  });

  test('base64url 헤더도 읽는다', () => {
    const v = Buffer.from(JSON.stringify({ x402Version: 2, accepts: [{ amount: '7', payTo: 'So1anaAddr' }] })).toString('base64url');
    assert.deepEqual(parse({ headers: { 'payment-required': v } })!.options, [{ amount: '7', pay_to: 'So1anaAddr' }]);
  });

  test('헤더가 깨졌으면 본문으로 넘어간다', () => {
    const r = parse({ headers: { 'payment-required': '%%%not-base64' }, body: JSON.stringify({ x402Version: 1, accepts: [{ maxAmountRequired: '5', payTo: '0xp' }] }) })!;
    assert.deepEqual([r.parse, r.source, r.version], ['ok', 'body', 1]);
  });

  test('형식이 맞지 않는 값은 그 필드만 버리고 센다(원문 저장 없음)', () => {
    const r = parse({
      body: JSON.stringify({
        x402Version: 1,
        accepts: [{ scheme: 'exact', network: 'base', maxAmountRequired: '1.5', asset: 'has space', payTo: '<script>', maxTimeoutSeconds: -1, description: 'secret text' }],
      }),
    })!;
    assert.deepEqual(r.options, [{ scheme: 'exact', network: 'base' }]);
    assert.equal(r.dropped, 4);
    assert.ok(!JSON.stringify(r).includes('secret') && !JSON.stringify(r).includes('script'));
  });

  test('남길 필드가 하나도 없으면 invalid', () => {
    const r = parse({ body: JSON.stringify({ x402Version: 2, accepts: [{ amount: 'abc' }, 'nope'] }) })!;
    assert.deepEqual([r.parse, r.protocol, r.options], ['invalid', 'x402', []]);
    assert.equal(r.dropped, 2);
  });

  test('선택지는 상한까지만, 넘으면 more', () => {
    const accepts = Array.from({ length: PAYMENT_OPTIONS_MAX + 3 }, (_, i) => ({ amount: String(i + 1), payTo: `0x${i}` }));
    const r = parse({ body: JSON.stringify({ x402Version: 2, accepts }) })!;
    assert.equal(r.options!.length, PAYMENT_OPTIONS_MAX);
    assert.equal(r.more, true);
  });

  test('x402 모양이 아니면(버전 없음·accepts 없음) 다음 방식으로', () => {
    assert.deepEqual(parse({ body: JSON.stringify({ accepts: [{ amount: '1' }] }) }), { parse: 'none', stage: 'initialize' });
    assert.deepEqual(parse({ body: JSON.stringify({ x402Version: 3, accepts: [] }) }), { parse: 'none', stage: 'initialize' });
    assert.deepEqual(parse({ body: 'Payment Required' }), { parse: 'none', stage: 'initialize' });
  });

  test('크기 상한: 큰 헤더·본문은 해석하지 않고 too_large', () => {
    assert.deepEqual(parse({ headers: { 'payment-required': 'A'.repeat(PAYMENT_HEADER_MAX + 1) } }), { parse: 'too_large', stage: 'initialize' });
    assert.deepEqual(parse({ body: 'x'.repeat(PAYMENT_BODY_MAX + 1) }), { parse: 'too_large', stage: 'initialize' });
    assert.deepEqual(parse({ bodyTooLarge: true }), { parse: 'too_large', stage: 'initialize' });
  });

  test('MPP: WWW-Authenticate Payment 도전, 다른 스킴과 섞여도 Payment 만', () => {
    const req = Buffer.from(JSON.stringify({ amount: '10000', currency: 'usd', recipient: 'acct_1' })).toString('base64url');
    const h = `Bearer realm="x", Payment id="a", realm="api", method="stripe", intent="charge", request="${req}", Payment id="b", method="tempo", intent="session"`;
    assert.equal(mppChallenges(h).length, 2);
    const r = parse({ headers: { 'www-authenticate': h }, stage: 'tools/list' })!;
    assert.deepEqual(r, {
      parse: 'ok', stage: 'tools/list', protocol: 'mpp',
      challenges: [{ method: 'stripe', intent: 'charge', amount: '10000', currency: 'usd', recipient: 'acct_1' }, { method: 'tempo', intent: 'session' }],
    });
  });

  test('MPP request 가 깨졌으면 그 부분만 버린다', () => {
    const r = parse({ headers: { 'www-authenticate': 'Payment id="a", method="tempo", intent="charge", request="!!!"' } })!;
    assert.deepEqual(r.challenges, [{ method: 'tempo', intent: 'charge' }]);
    assert.equal(r.dropped, 1);
  });

  test('Bearer 만 있는 402 는 none', () => {
    assert.deepEqual(parse({ headers: { 'www-authenticate': 'Bearer realm="x"' } }), { parse: 'none', stage: 'initialize' });
  });

  test('어떤 입력에도 예외를 던지지 않는다', () => {
    const weird: unknown[] = [null, 1, [], '{', '{"x402Version":1,"accepts":null}', '{"x402Version":2,"accepts":[null,1,"a",[]]}'];
    for (const body of weird) {
      assert.doesNotThrow(() => parsePaymentRequired({ status: 402, headers: { 'payment-required': String(body) }, body: typeof body === 'string' ? body : undefined, stage: 'initialize' }));
    }
  });
});
