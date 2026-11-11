// scanner/payment-lib.ts — HTTP 402 응답에서 결제 조건을 읽는다 (2026-11-12, 설계: 프로젝트 문서 claude/lowdown-payment-facts-2026-11-12.md)
//
// 원칙
//   - 이미 받은 402 응답(initialize·tools/list)만 읽는다. 요청을 늘리지 않고, 결제하지 않고, 도구를 부르지 않는다.
//   - 원문은 저장하지 않는다. 형식 검증을 통과한 필드만 남기고, 맞지 않는 필드는 버리고 버린 수만 센다.
//   - 결제 조건을 "관측"한 것이지, 결제가 되는지·수취 주소가 유효한지 확인한 것이 아니다.
//   - 읽기 실패는 관측 실패가 아니다. 어떤 입력에도 예외를 던지지 않는다(probeRemote 결과를 바꾸지 않음).
//
// 형식 (공식 문서 확인 2026-11-12)
//   x402 v2: 응답 헤더 PAYMENT-REQUIRED = base64(JSON PaymentRequired{x402Version:2, resource, accepts[{scheme, network(CAIP-2), amount, asset, payTo, maxTimeoutSeconds}]})
//            본문에 같은 JSON 을 그대로 두는 구현도 있다.
//   x402 v1: 본문 JSON {x402Version:1, accepts[{scheme, network, maxAmountRequired, asset, payTo, maxTimeoutSeconds}]}
//   MPP:     WWW-Authenticate: Payment id="…", realm="…", method="…", intent="…", request="<base64url JSON>"

/** 402 본문을 이만큼까지만 읽는다(httpsPost). 넘으면 본문은 읽지 않은 것으로 친다. */
export const PAYMENT_BODY_MAX = 16 * 1024;
/** 헤더 값(base64)을 이만큼까지만 해석한다. */
export const PAYMENT_HEADER_MAX = 8 * 1024;
/** 결제 선택지·MPP 도전은 이만큼까지만 남긴다. */
export const PAYMENT_OPTIONS_MAX = 5;

export type PaymentParse = 'ok' | 'none' | 'too_large' | 'invalid';

export interface PaymentOption {
  scheme?: string;
  network?: string;
  asset?: string;
  amount?: string;
  pay_to?: string;
  max_timeout_s?: number;
}

export interface MppChallenge {
  method?: string;
  intent?: string;
  amount?: string;
  currency?: string;
  recipient?: string;
}

export interface PaymentObservation {
  /** 읽은 결과. none = 402 인데 알아볼 수 있는 결제 조건이 없음 */
  parse: PaymentParse;
  /** 어느 단계의 402 였나 */
  stage: 'initialize' | 'tools/list';
  protocol?: 'x402' | 'mpp';
  /** x402 버전(1·2). MPP 는 없음 */
  version?: number;
  /** x402 를 어디서 읽었나 */
  source?: 'header' | 'body';
  options?: PaymentOption[];
  challenges?: MppChallenge[];
  /** 남긴 수보다 선택지가 많았음 */
  more?: boolean;
  /** 형식이 맞지 않아 버린 필드 수 */
  dropped?: number;
}

const RE = {
  scheme: /^[A-Za-z0-9_:.-]{1,32}$/,
  network: /^[A-Za-z0-9_:.-]{1,64}$/,
  token: /^[A-Za-z0-9_:.-]{1,128}$/, // asset·payTo·recipient·currency: 주소·식별자 (공백·따옴표·제어문자 없음)
  amount: /^\d{1,40}$/, // 최소 단위 정수 문자열
  word: /^[A-Za-z0-9_.-]{1,32}$/, // MPP method·intent
};

type Counter = { dropped: number };

function pick(v: unknown, re: RegExp, c: Counter): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) v = String(v);
  if (typeof v === 'string' && re.test(v)) return v;
  c.dropped++;
  return undefined;
}

function pickTimeout(v: unknown, c: Counter): number | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 7 * 86_400) return v;
  c.dropped++;
  return undefined;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function x402Option(a: unknown, version: number, c: Counter): PaymentOption | null {
  if (!isObj(a)) {
    c.dropped++;
    return null;
  }
  const o: PaymentOption = {
    scheme: pick(a.scheme, RE.scheme, c),
    network: pick(a.network, RE.network, c),
    asset: pick(a.asset, RE.token, c),
    // v1 은 maxAmountRequired, v2 는 amount
    amount: pick(version === 1 ? (a.maxAmountRequired ?? a.amount) : (a.amount ?? a.maxAmountRequired), RE.amount, c),
    pay_to: pick(a.payTo, RE.token, c),
    max_timeout_s: pickTimeout(a.maxTimeoutSeconds, c),
  };
  for (const k of Object.keys(o) as (keyof PaymentOption)[]) if (o[k] === undefined) delete o[k];
  return Object.keys(o).length ? o : null;
}

/** x402 PaymentRequired JSON → 관측. x402 모양이 아니면 null */
function fromX402(j: unknown, source: 'header' | 'body', stage: PaymentObservation['stage']): PaymentObservation | null {
  if (!isObj(j)) return null;
  const v = j.x402Version;
  if (v !== 1 && v !== 2) return null;
  if (!Array.isArray(j.accepts)) return null;
  const c: Counter = { dropped: 0 };
  const options: PaymentOption[] = [];
  for (const a of j.accepts.slice(0, PAYMENT_OPTIONS_MAX)) {
    const o = x402Option(a, v, c);
    if (o) options.push(o);
  }
  const out: PaymentObservation = { parse: options.length ? 'ok' : 'invalid', stage, protocol: 'x402', version: v, source, options };
  if (j.accepts.length > PAYMENT_OPTIONS_MAX) out.more = true;
  if (c.dropped) out.dropped = c.dropped;
  return out;
}

function decodeBase64Json(s: string): unknown {
  const t = s.trim().replace(/-/g, '+').replace(/_/g, '/');
  if (!/^[A-Za-z0-9+/]+=*$/.test(t)) return undefined;
  try {
    return JSON.parse(Buffer.from(t, 'base64').toString('utf8'));
  } catch {
    return undefined;
  }
}

/** WWW-Authenticate 값에서 Payment 도전들을 뽑는다. 여러 헤더가 ", " 로 합쳐져 와도 나눈다. */
export function mppChallenges(header: string): string[] {
  const parts = header.split(/(?:^|,)\s*(?=Payment\s)/i).map((p) => p.trim()).filter((p) => /^Payment\s/i.test(p));
  return parts;
}

function authParams(ch: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([A-Za-z][A-Za-z0-9_-]*)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s,]+))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(ch))) {
    const k = m[1]!.toLowerCase();
    if (!(k in out)) out[k] = (m[2] ?? m[3] ?? '').replace(/\\(.)/g, '$1');
  }
  return out;
}

function fromMpp(header: string, stage: PaymentObservation['stage']): PaymentObservation | null {
  const chs = mppChallenges(header);
  if (!chs.length) return null;
  const c: Counter = { dropped: 0 };
  const challenges: MppChallenge[] = [];
  for (const ch of chs.slice(0, PAYMENT_OPTIONS_MAX)) {
    const p = authParams(ch.replace(/^Payment\s+/i, ''));
    const x: MppChallenge = { method: pick(p.method, RE.word, c), intent: pick(p.intent, RE.word, c) };
    if (p.request !== undefined) {
      const r = p.request.length <= PAYMENT_HEADER_MAX ? decodeBase64Json(p.request) : undefined;
      if (isObj(r)) {
        x.amount = pick(r.amount, RE.amount, c);
        x.currency = pick(r.currency, RE.token, c);
        x.recipient = pick(r.recipient, RE.token, c);
      } else c.dropped++;
    }
    for (const k of Object.keys(x) as (keyof MppChallenge)[]) if (x[k] === undefined) delete x[k];
    if (Object.keys(x).length) challenges.push(x);
  }
  const out: PaymentObservation = { parse: challenges.length ? 'ok' : 'invalid', stage, protocol: 'mpp', challenges };
  if (chs.length > PAYMENT_OPTIONS_MAX) out.more = true;
  if (c.dropped) out.dropped = c.dropped;
  return out;
}

function header(h: Record<string, string | string[] | undefined>, name: string): string | undefined {
  const v = h[name];
  return Array.isArray(v) ? v.join(', ') : v;
}

/**
 * 402 응답 → 결제 조건 관측. 402 가 아니면 null. 어떤 입력에도 예외를 던지지 않는다.
 * 순서: x402 헤더(PAYMENT-REQUIRED) → 본문 JSON(x402 v1·v2) → MPP(WWW-Authenticate: Payment). 처음 읽힌 것 하나만 남긴다.
 */
export function parsePaymentRequired(res: {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body?: string;
  bodyTooLarge?: boolean;
  stage: PaymentObservation['stage'];
}): PaymentObservation | null {
  if (res.status !== 402) return null;
  const stage = res.stage;
  try {
    let tooLarge = res.bodyTooLarge === true;
    const ph = header(res.headers, 'payment-required');
    if (ph !== undefined) {
      if (ph.length > PAYMENT_HEADER_MAX) tooLarge = true;
      else {
        const r = fromX402(decodeBase64Json(ph), 'header', stage);
        if (r) return r;
      }
    }
    if (typeof res.body === 'string' && res.body.length > 0) {
      if (res.body.length > PAYMENT_BODY_MAX) tooLarge = true;
      else {
        let j: unknown;
        try {
          j = JSON.parse(res.body);
        } catch {
          j = undefined;
        }
        const r = fromX402(j, 'body', stage);
        if (r) return r;
      }
    }
    const wa = header(res.headers, 'www-authenticate');
    if (wa !== undefined && wa.length <= PAYMENT_HEADER_MAX * 2) {
      const r = fromMpp(wa, stage);
      if (r) return r;
    }
    return { parse: tooLarge ? 'too_large' : 'none', stage };
  } catch {
    return { parse: 'invalid', stage };
  }
}
