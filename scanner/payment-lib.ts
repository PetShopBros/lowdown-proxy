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
//   비표준 x402(2026-11-13 실측): x402Version 없이 accepts 가 객체/배열, 본문에 "x402" 언급 → nonstandard: true
//   JSON-RPC 오류 안의 x402: {"jsonrpc":"2.0","error":{"data":{x402Version, accepts}}}
//   호스팅 차단(결제 아님, 2026-11-13 실측): Vercel `X-Vercel-Error: DEPLOYMENT_DISABLED`, Alpic JSON-RPC error.data["alpic/reason"]
//            → cause: platform_limit. 운영자가 호스팅 요금·한도 문제로 막힌 상태이지 에이전트에게 결제를 받는 서버가 아니다.
//   L402:    WWW-Authenticate: L402 [version="0",] macaroon|token="<base64>", invoice="<BOLT11>" (bLIP-0026, 옛 이름 LSAT)
//            인보이스에서 네트워크(접두어)와 금액(HRP)만 읽는다. 토큰·인보이스 원문·결제 해시는 남기지 않는다(2026-11-12).

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
  /** 비표준(2026-11-13 실측): method·intent·request 없이 realm·depositUrl 만. realm 은 도메인 형식만, 주소 자체는 저장 안 함 */
  realm?: string;
  deposit_url?: true;
}

export interface LightningInvoice {
  /** BOLT11 접두어: bitcoin(lnbc) / testnet(lntb) / signet(lntbs) / regtest(lnbcrt) */
  network?: 'bitcoin' | 'testnet' | 'signet' | 'regtest';
  /** 인보이스에 적힌 금액(밀리사토시, 정수 문자열). 금액 없는 인보이스면 없음 */
  amount_msat?: string;
}

export interface PaymentObservation {
  /** 읽은 결과. none = 402 인데 알아볼 수 있는 결제 조건이 없음 */
  parse: PaymentParse;
  /** 402 의 성격: payment_terms(결제 조건을 밝힘) / platform_limit(호스팅 차단·한도, 결제 아님) / unknown (2026-11-13) */
  cause: 'payment_terms' | 'platform_limit' | 'unknown';
  /** cause = platform_limit 일 때 호스팅 플랫폼과 그 플랫폼이 밝힌 사유 */
  platform?: 'vercel' | 'alpic';
  platform_reason?: string;
  /** x402 를 밝혔지만 표준 모양(x402Version + accepts 배열)이 아님 */
  nonstandard?: boolean;
  /** 어느 단계의 402 였나 */
  stage: 'initialize' | 'tools/list';
  protocol?: 'x402' | 'mpp' | 'l402';
  /** x402 버전(1·2), L402 는 version 파라미터(없으면 없음). MPP 는 없음 */
  version?: number;
  /** x402 를 어디서 읽었나 */
  source?: 'header' | 'body';
  options?: PaymentOption[];
  challenges?: MppChallenge[];
  /** L402 도전의 인보이스(파생값만) */
  invoices?: LightningInvoice[];
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
  domain: /^(?=.{1,253}$)([A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/, // MPP 비표준 realm
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
function fromX402(j: unknown, source: 'header' | 'body', stage: PaymentObservation['stage'], mentionsX402 = false): PaymentObservation | null {
  if (!isObj(j)) return null;
  const v = j.x402Version;
  const standard = (v === 1 || v === 2) && Array.isArray(j.accepts);
  // 비표준: 버전이 없거나 accepts 가 객체여도, 본문이 x402 를 밝히고 accepts 가 있으면 읽는다
  if (!standard && !(mentionsX402 && (Array.isArray(j.accepts) || isObj(j.accepts)))) return null;
  const list: unknown[] = Array.isArray(j.accepts) ? j.accepts : [j.accepts];
  const c: Counter = { dropped: 0 };
  const options: PaymentOption[] = [];
  for (const a of list.slice(0, PAYMENT_OPTIONS_MAX)) {
    const o = x402Option(a, v === 1 ? 1 : 2, c);
    if (o) options.push(o);
  }
  const out: PaymentObservation = { parse: options.length ? 'ok' : 'invalid', cause: 'payment_terms', stage, protocol: 'x402', source, options };
  if (v === 1 || v === 2) out.version = v;
  if (!standard) out.nonstandard = true;
  if (list.length > PAYMENT_OPTIONS_MAX) out.more = true;
  if (c.dropped) out.dropped = c.dropped;
  return out;
}

/** 본문 JSON 에서 x402 를 찾는다: 맨 위, 또는 JSON-RPC error.data 안 */
function fromBodyJson(j: unknown, stage: PaymentObservation['stage'], mentionsX402: boolean): PaymentObservation | null {
  const top = fromX402(j, 'body', stage, mentionsX402);
  if (top) return top;
  if (isObj(j) && isObj(j.error) && isObj(j.error.data)) return fromX402(j.error.data, 'body', stage, mentionsX402);
  return null;
}

const PLATFORM_REASON = /^[A-Za-z0-9_.:-]{1,64}$/;

/** 호스팅 플랫폼이 막은 402 인가 (결제 아님) */
function platformLimit(headers: Record<string, string | string[] | undefined>, j: unknown): { platform: 'vercel' | 'alpic'; platform_reason?: string } | null {
  const ve = header(headers, 'x-vercel-error');
  if (ve !== undefined) return PLATFORM_REASON.test(ve) ? { platform: 'vercel', platform_reason: ve } : { platform: 'vercel' };
  if (isObj(j) && isObj(j.error) && isObj(j.error.data) && j.error.data['alpic/reason'] !== undefined) {
    const r = j.error.data['alpic/reason'];
    return typeof r === 'string' && PLATFORM_REASON.test(r) ? { platform: 'alpic', platform_reason: r } : { platform: 'alpic' };
  }
  return null;
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
  let nonstandard = false;
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
    // 표준 파라미터가 하나도 없으면 비표준 모양(realm·depositUrl)을 본다
    if (!Object.keys(x).length && p.method === undefined && p.intent === undefined && p.request === undefined) {
      const realm = pick(p.realm, RE.domain, c);
      if (realm) x.realm = realm;
      if (typeof p.depositurl === 'string') x.deposit_url = true; // authParams 는 키를 소문자로
      if (Object.keys(x).length) nonstandard = true;
    }
    if (Object.keys(x).length) challenges.push(x);
  }
  const out: PaymentObservation = { parse: challenges.length ? 'ok' : 'invalid', cause: 'payment_terms', stage, protocol: 'mpp', challenges };
  if (nonstandard) out.nonstandard = true;
  if (chs.length > PAYMENT_OPTIONS_MAX) out.more = true;
  if (c.dropped) out.dropped = c.dropped;
  return out;
}

/** BOLT11 HRP → 네트워크·금액. 형식이 아니면 null (2026-11-12) */
export function bolt11Summary(invoice: string): LightningInvoice | null {
  const inv = invoice.trim().toLowerCase().replace(/^lightning:/, '');
  if (inv.length < 20 || inv.length > 4096 || !/^ln[a-z0-9]+$/.test(inv)) return null;
  const sep = inv.lastIndexOf('1');
  if (sep < 4) return null;
  const hrp = inv.slice(2, sep);
  const m = /^(bcrt|bc|tbs|tb)(\d*)([munp]?)$/.exec(hrp);
  if (!m) return null;
  const network = ({ bc: 'bitcoin', tb: 'testnet', tbs: 'signet', bcrt: 'regtest' } as const)[m[1] as 'bc' | 'tb' | 'tbs' | 'bcrt'];
  const out: LightningInvoice = { network };
  if (m[2]) {
    if (m[2].length > 20 || (m[2].length > 1 && m[2].startsWith('0'))) return null;
    const n = BigInt(m[2]);
    // 1 BTC = 10^11 msat. m=10^-3, u=10^-6, n=10^-9, p=10^-12 BTC
    let msat: bigint | null;
    switch (m[3]) {
      case 'm': msat = n * 100_000_000n; break;
      case 'u': msat = n * 100_000n; break;
      case 'n': msat = n * 100n; break;
      case 'p': msat = n % 10n === 0n ? n / 10n : null; break;
      default: msat = n * 100_000_000_000n;
    }
    if (msat === null || msat <= 0n) return null;
    out.amount_msat = msat.toString();
  } else if (m[3]) return null;
  return out;
}

/** WWW-Authenticate 값에서 L402(옛 LSAT) 도전들을 뽑는다 */
export function l402Challenges(header: string): string[] {
  return header.split(/(?:^|,)\s*(?=(?:L402|LSAT)\s)/i).map((p) => p.trim()).filter((p) => /^(?:L402|LSAT)\s/i.test(p));
}

function fromL402(header: string, stage: PaymentObservation['stage']): PaymentObservation | null {
  const chs = l402Challenges(header);
  if (!chs.length) return null;
  const c: Counter = { dropped: 0 };
  const invoices: LightningInvoice[] = [];
  let version: number | undefined;
  for (const ch of chs.slice(0, PAYMENT_OPTIONS_MAX)) {
    const p = authParams(ch.replace(/^(?:L402|LSAT)\s+/i, ''));
    if (version === undefined && p.version !== undefined) {
      if (/^\d{1,3}$/.test(p.version)) version = Number(p.version);
      else c.dropped++;
    }
    if (p.invoice === undefined) continue;
    const s = bolt11Summary(p.invoice);
    if (s) invoices.push(s);
    else c.dropped++;
  }
  const out: PaymentObservation = { parse: invoices.length ? 'ok' : 'invalid', cause: 'payment_terms', stage, protocol: 'l402', invoices };
  if (version !== undefined) out.version = version;
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
 * 순서: x402 헤더(PAYMENT-REQUIRED) → 본문 JSON(x402 v1·v2) → MPP(WWW-Authenticate: Payment) → L402. 처음 읽힌 것 하나만 남긴다.
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
    let j: unknown;
    if (typeof res.body === 'string' && res.body.length > 0) {
      if (res.body.length > PAYMENT_BODY_MAX) tooLarge = true;
      else {
        try {
          j = JSON.parse(res.body);
        } catch {
          j = undefined;
        }
        const r = fromBodyJson(j, stage, /x402(?!version)/i.test(res.body));
        if (r) return r;
      }
    }
    const wa = header(res.headers, 'www-authenticate');
    if (wa !== undefined && wa.length <= PAYMENT_HEADER_MAX * 2) {
      const r = fromMpp(wa, stage) ?? fromL402(wa, stage);
      if (r) return r;
    }
    const pl = platformLimit(res.headers, j);
    if (pl) return { parse: 'none', cause: 'platform_limit', stage, ...pl };
    return { parse: tooLarge ? 'too_large' : 'none', cause: 'unknown', stage };
  } catch {
    return { parse: 'invalid', cause: 'unknown', stage };
  }
}
