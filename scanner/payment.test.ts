import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { PAYMENT_BODY_MAX, PAYMENT_HEADER_MAX, PAYMENT_OPTIONS_MAX, bolt11Summary, mppChallenges, parsePaymentRequired } from './payment-lib.ts';

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
    assert.deepEqual(parse({ body: JSON.stringify({ accepts: [{ amount: '1' }] }) }), { parse: 'none', cause: 'unknown', stage: 'initialize' });
    assert.deepEqual(parse({ body: JSON.stringify({ x402Version: 3, accepts: [] }) }), { parse: 'none', cause: 'unknown', stage: 'initialize' });
    assert.deepEqual(parse({ body: 'Payment Required' }), { parse: 'none', cause: 'unknown', stage: 'initialize' });
  });

  test('크기 상한: 큰 헤더·본문은 해석하지 않고 too_large', () => {
    assert.deepEqual(parse({ headers: { 'payment-required': 'A'.repeat(PAYMENT_HEADER_MAX + 1) } }), { parse: 'too_large', cause: 'unknown', stage: 'initialize' });
    assert.deepEqual(parse({ body: 'x'.repeat(PAYMENT_BODY_MAX + 1) }), { parse: 'too_large', cause: 'unknown', stage: 'initialize' });
    assert.deepEqual(parse({ bodyTooLarge: true }), { parse: 'too_large', cause: 'unknown', stage: 'initialize' });
  });

  test('MPP: WWW-Authenticate Payment 도전, 다른 스킴과 섞여도 Payment 만', () => {
    const req = Buffer.from(JSON.stringify({ amount: '10000', currency: 'usd', recipient: 'acct_1' })).toString('base64url');
    const h = `Bearer realm="x", Payment id="a", realm="api", method="stripe", intent="charge", request="${req}", Payment id="b", method="tempo", intent="session"`;
    assert.equal(mppChallenges(h).length, 2);
    const r = parse({ headers: { 'www-authenticate': h }, stage: 'tools/list' })!;
    assert.deepEqual(r, {
      parse: 'ok', cause: 'payment_terms', stage: 'tools/list', protocol: 'mpp',
      challenges: [{ method: 'stripe', intent: 'charge', amount: '10000', currency: 'usd', recipient: 'acct_1' }, { method: 'tempo', intent: 'session' }],
    });
  });

  test('MPP request 가 깨졌으면 그 부분만 버린다', () => {
    const r = parse({ headers: { 'www-authenticate': 'Payment id="a", method="tempo", intent="charge", request="!!!"' } })!;
    assert.deepEqual(r.challenges, [{ method: 'tempo', intent: 'charge' }]);
    assert.equal(r.dropped, 1);
  });

  test('Bearer 만 있는 402 는 none', () => {
    assert.deepEqual(parse({ headers: { 'www-authenticate': 'Bearer realm="x"' } }), { parse: 'none', cause: 'unknown', stage: 'initialize' });
  });

  test('L402: 인보이스에서 네트워크·금액만, 토큰·인보이스 원문은 남기지 않음 (bLIP-0026)', () => {
    // bLIP-0026 예시 인보이스 (lnbc1500n = 1500 nano-BTC = 150,000 msat)
    const inv = 'lnbc1500n1pw5kjhmpp5fu6xhthlt2vucmzkx6c7wtlh2r625r30cyjsfqhu8rsx4xpz5lwqdpa2fjkzep6yptksct5yp5hxgrrv96hx6twvusycn3qv9jx7ur5d9hkugr5dusx6cqzpgxqr23s79ruapxc4j5uskt4htly2salw4d';
    const h = `L402 version="0", macaroon="AGIAJEemVQUTEyNCR0exk7ek90Cg==", invoice="${inv}"`;
    const r = parse({ headers: { 'www-authenticate': h } })!;
    assert.deepEqual(r, { parse: 'ok', cause: 'payment_terms', stage: 'initialize', protocol: 'l402', version: 0, invoices: [{ network: 'bitcoin', amount_msat: '150000' }] });
    assert.ok(!JSON.stringify(r).includes('AGIA') && !JSON.stringify(r).includes('pw5kjhm'));
  });

  test('L402: token 이름·옛 LSAT·Bearer 와 섞임·금액 없는 인보이스', () => {
    const r = parse({ headers: { 'www-authenticate': 'Bearer realm="x", LSAT macaroon="abc", invoice="lntb20m1pvjluezpp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqq"' } })!;
    assert.deepEqual([r.protocol, r.invoices], ['l402', [{ network: 'testnet', amount_msat: '2000000000' }]]);
    const t = parse({ headers: { 'www-authenticate': 'L402 token="abc", invoice="lnbcrt1pvjluezpp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqq"' } })!;
    assert.deepEqual(t.invoices, [{ network: 'regtest' }]);
  });

  test('L402: 인보이스가 이상하면 invalid + dropped, MPP 가 있으면 MPP 우선', () => {
    const r = parse({ headers: { 'www-authenticate': 'L402 macaroon="abc", invoice="not-an-invoice"' } })!;
    assert.deepEqual([r.parse, r.protocol, r.dropped], ['invalid', 'l402', 1]);
    const m = parse({ headers: { 'www-authenticate': 'Payment id="a", method="tempo", intent="charge", L402 macaroon="x", invoice="lnbc1pvjluezpp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqq"' } })!;
    assert.equal(m.protocol, 'mpp');
  });

  test('BOLT11 금액 단위', () => {
    const tail = '1pvjluezpp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqq';
    assert.deepEqual(bolt11Summary(`lnbc2500u${tail}`), { network: 'bitcoin', amount_msat: '250000000' });
    assert.deepEqual(bolt11Summary(`lnbc10p${tail}`), { network: 'bitcoin', amount_msat: '1' });
    assert.equal(bolt11Summary(`lnbc11p${tail}`), null); // p 는 10의 배수만
    assert.deepEqual(bolt11Summary(`lntbs5m${tail}`), { network: 'signet', amount_msat: '500000000' });
    assert.deepEqual(bolt11Summary(`lnbc2${tail}`), { network: 'bitcoin', amount_msat: '200000000000' });
    assert.deepEqual(bolt11Summary(`LIGHTNING:LNBC1500N${tail.toUpperCase()}`), { network: 'bitcoin', amount_msat: '150000' });
    assert.equal(bolt11Summary('lnxx1500n1abcdefghijklmnopqrst'), null);
    assert.equal(bolt11Summary('lnbc01500n1abcdefghijklmnopqrst'), null);
  });

  test('호스팅 차단: Vercel X-Vercel-Error → platform_limit (결제 아님)', () => {
    const r = parse({ headers: { 'x-vercel-error': 'DEPLOYMENT_DISABLED' }, body: JSON.stringify({ error: { code: '402', message: 'Payment required' } }) });
    assert.deepEqual(r, { parse: 'none', cause: 'platform_limit', stage: 'initialize', platform: 'vercel', platform_reason: 'DEPLOYMENT_DISABLED' });
    const bad = parse({ headers: { 'x-vercel-error': 'bad value <script>' } });
    assert.deepEqual(bad, { parse: 'none', cause: 'platform_limit', stage: 'initialize', platform: 'vercel' });
  });

  test('호스팅 차단: Alpic JSON-RPC error.data["alpic/reason"] → platform_limit', () => {
    const body = JSON.stringify({ jsonrpc: '2.0', error: { code: -32002, message: 'Request limit reached for the current billing period.', data: { 'alpic/reason': 'request-limit-exceeded' } }, id: null });
    assert.deepEqual(parse({ body }), { parse: 'none', cause: 'platform_limit', stage: 'initialize', platform: 'alpic', platform_reason: 'request-limit-exceeded' });
  });

  test('비표준 x402: 버전 없이 accepts 객체 + 본문 x402 언급 → nonstandard, 모르는 필드는 금액으로 안 씀', () => {
    const body = JSON.stringify({ error: 'Payment Required', message: 'Micro-transaction settlement required via x402 protocol.', accepts: { scheme: 'exact', network: 'solana', maxFeeMicroCents: 150000 } });
    const r = parse({ body });
    assert.equal(r?.parse, 'ok');
    assert.equal(r?.cause, 'payment_terms');
    assert.equal(r?.protocol, 'x402');
    assert.equal(r?.nonstandard, true);
    assert.equal(r?.version, undefined);
    assert.equal(r?.options?.length, 1);
    assert.equal(r?.options?.[0].scheme, 'exact');
    assert.equal(r?.options?.[0].amount, undefined);
    // x402 언급이 없으면 읽지 않는다
    assert.equal(parse({ body: JSON.stringify({ accepts: { scheme: 'exact' } }) })?.parse, 'none');
  });

  test('JSON-RPC error.data 안의 표준 x402', () => {
    const data = { x402Version: 2, accepts: [{ scheme: 'exact', network: 'eip155:8453', amount: '10000', asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', payTo: '0x209693Bc6afc0C5328bA36FaF03C514EF312287C', maxTimeoutSeconds: 60 }] };
    const r = parse({ body: JSON.stringify({ jsonrpc: '2.0', error: { code: 402, message: 'Payment required', data }, id: 1 }) });
    assert.equal(r?.parse, 'ok');
    assert.equal(r?.cause, 'payment_terms');
    assert.equal(r?.version, 2);
    assert.equal(r?.nonstandard, undefined);
    assert.equal(r?.options?.[0].amount, '10000');
  });

  test('어떤 입력에도 예외를 던지지 않는다', () => {
    const weird: unknown[] = [null, 1, [], '{', '{"x402Version":1,"accepts":null}', '{"x402Version":2,"accepts":[null,1,"a",[]]}'];
    for (const body of weird) {
      assert.doesNotThrow(() => parsePaymentRequired({ status: 402, headers: { 'payment-required': String(body) }, body: typeof body === 'string' ? body : undefined, stage: 'initialize' }));
    }
  });
});
