// ERC-8004 등록 수집 — 순수 함수와 입출력 (scanner/erc8004.ts 가 쓴다). DB 구조: supabase/2026-11-05_erc8004.sql
// 체인에서는 읽기만 한다(eth_getLogs, eth_getCode, eth_blockNumber). 거래·서명·가스 없음.
// 등록 파일은 공개 데이터. 사설 주소로는 요청하지 않고, 크기·시간 상한을 둔다. 판정하지 않는다.

import { createHash } from 'node:crypto';

export const IDENTITY_REGISTRY = '0x8004a169fb4a3325136eb29fa0ceb6d2e539a432'; // 메인넷 공통 (erc-8004/erc-8004-contracts README)

// keccak256 이벤트 서명 (Transfer 값은 ERC-721 표준 값과 같음을 확인했다)
export const TOPIC_REGISTERED = '0xca52e62c367d81bb2e328eb795f7c7ba24afb478408a26c0e201d155c449bc4a'; // Registered(uint256,string,address)
export const TOPIC_URI_UPDATED = '0x3a2c7fffc2cba7582c690e3b82c453ea02a308326a98a3ad7576c606336409fb'; // URIUpdated(uint256,string,address)
export const TOPIC_TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'; // Transfer(address,address,uint256)

export interface ChainConf {
  chainId: number;
  name: string;
  rpc: string;
  confirmations: number; // 이만큼 뒤까지만 읽는다(재편성 대비)
  startBlock: bigint; // 처음 읽기 시작할 블록(메인넷 출시 2026-01-29 보다 앞). 보관 노드 탐색은 호출이 많아 쓰지 않는다
  maxRange: number; // getLogs 한 번의 최대 블록 수(시작값, 오류 시 반으로 줄인다)
}

// 기본 RPC (2026-11-05 Lightsail 서버에서 확인, 키 없음): base.drpc.org · eth.drpc.org
//   과거 구간 getLogs 가능. 무료 요금제는 한 번에 100블록은 되고 500블록은 안 된다(오류 문구의 10000 은 실제 한도가 아님)
//   → readLogs 가 성공한 크기와 실패한 크기 사이를 좁혀 실제 한도를 찾는다.
//   eth.blockscout.com 은 몇 번 호출 뒤 이 서버 IP 도 429("Increase limits") — 키를 받으면 ERC8004_RPC_* 로 바꾼다.
//   안 된 곳: publicnode(과거 구간 토큰 요구), base.blockscout·llamarpc(Cloudflare 확인 화면), mainnet.base.org(429),
//             1rpc(50블록), meowrpc·developer-access(getLogs 미지원). GitHub Actions IP 는 blockscout 가 429 → 서버에서 돈다.
// 순서: 이더리움(따라잡을 양 약 200만 블록) 먼저, Base(약 1,200만 블록) 나중.
//   읽기 시간은 체인마다 나누고 앞 체인이 일찍 끝나면 남은 시간은 뒤 체인(Base)으로 간다(erc8004.ts).
export const CHAINS: readonly ChainConf[] = [
  { chainId: 1, name: 'ethereum', rpc: 'https://eth.drpc.org', confirmations: 12, maxRange: 10_000, startBlock: 24_300_000n },
  { chainId: 8453, name: 'base', rpc: 'https://base.drpc.org', confirmations: 30, maxRange: 10_000, startBlock: 40_000_000n },
];
export const MAX_LOGS_PER_CALL = 1000;

export const MAX_URI_CHARS = 65_536;
export const MAX_FILE_BYTES = 256 * 1024;
export const IPFS_GATEWAY = 'https://ipfs.io/ipfs/';

// ─────────────────────────────────────────────
// JSON-RPC
// ─────────────────────────────────────────────

export interface RpcLog {
  address: string;
  topics: string[];
  data: string;
  blockNumber: string;
  transactionHash: string;
  logIndex: string;
  removed?: boolean;
}

export type RpcCall = (method: string, params: unknown[]) => Promise<unknown>;

export function makeRpc(
  url: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 30_000,
  sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
  minIntervalMs = 0,
  now: () => number = Date.now,
): RpcCall {
  let id = 0;
  let last = 0;
  const once = async (method: string, params: unknown[]) => {
    // 공개 인스턴스는 초당 요청이 적다 → 호출 사이 간격을 둔다
    const wait = last + minIntervalMs - now();
    if (wait > 0) await sleep(wait);
    last = now();
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'lowdown-scanner-erc8004 (+https://github.com/PetShopBros/lowdown-proxy)' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let j: any;
    try {
      j = JSON.parse(text);
    } catch {
      throw new RpcError(`HTTP ${res.status} non-JSON`, res.status, undefined, Number(res.headers.get('retry-after')) || undefined);
    }
    if (j?.error) throw new RpcError(String(j.error.message ?? 'rpc error').slice(0, 200), res.status, j.error.code);
    if (!res.ok) throw new RpcError(`HTTP ${res.status}`, res.status, undefined, Number(res.headers.get('retry-after')) || undefined);
    return j.result;
  };
  // 429·5xx·연결 오류는 쉬고 다시(최대 6번: 2·4·8·16·30초, Retry-After 가 있으면 그 값). 공개 인스턴스의 초당 요청 제한 대비.
  return async (method, params) => {
    for (let attempt = 1; ; attempt++) {
      try {
        return await once(method, params);
      } catch (e) {
        const retry = e instanceof RpcError ? e.status === 429 || e.status >= 500 : true;
        if (!retry || attempt >= 6) throw e;
        const ra = e instanceof RpcError && e.retryAfter ? Math.min(60, e.retryAfter) * 1000 : 0;
        await sleep(Math.max(ra, Math.min(30_000, 2000 * 2 ** (attempt - 1))));
      }
    }
  };
}

export class RpcError extends Error {
  readonly status: number;
  readonly code: number | undefined;
  readonly retryAfter: number | undefined; // 초
  constructor(message: string, status: number, code?: number, retryAfter?: number) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

const hexToBigInt = (h: string) => BigInt(h);
export const toHex = (n: bigint | number) => '0x' + BigInt(n).toString(16);

/** 레지스트리 코드가 처음 있는 블록 (이분 탐색, eth_getCode 약 25번) */
export async function findDeployBlock(rpc: RpcCall, address: string, head: bigint): Promise<bigint> {
  const has = async (b: bigint) => {
    const code = (await rpc('eth_getCode', [address, toHex(b)])) as string;
    return typeof code === 'string' && code !== '0x' && code.length > 2;
  };
  if (!(await has(head))) throw new Error(`no contract code at ${address}`);
  let lo = 0n;
  let hi = head;
  while (lo < hi) {
    const mid = (lo + hi) / 2n;
    if (await has(mid)) hi = mid;
    else lo = mid + 1n;
  }
  return lo;
}

const RANGE_ERR = /range|limit|too many|exceed|block range|query returned more|response size|timeout|10000/i;

/**
 * [from, to] 의 레지스트리 로그를 읽는다. 범위 오류면 범위를 반으로 줄여 다시 읽는다.
 * onChunk 는 끝난 구간마다 호출(커서를 조금씩 저장). 시간·호출 상한에 걸리면 읽은 데까지 돌려준다.
 */
export async function readLogs(
  rpc: RpcCall,
  address: string,
  from: bigint,
  to: bigint,
  opts: { maxRange: number; deadline: number; maxCalls: number; now?: () => number; onChunk: (logs: RpcLog[], upTo: bigint) => Promise<void> },
): Promise<{ readTo: bigint; calls: number; complete: boolean }> {
  const now = opts.now ?? Date.now;
  // 범위 한도 찾기: ok = 범위 제한 없이 성공한 가장 큰 크기, bad = 범위 오류가 난 가장 작은 크기. 다음 크기는 둘 사이 가운데.
  //   1000건 상한(잘림)·5xx 로 줄인 것은 한도로 배우지 않는다(구간마다 다르다).
  const max = BigInt(Math.max(1, opts.maxRange));
  let ok = 0n;
  let bad = max + 1n;
  const next = () => (ok === 0n ? (bad > max ? max : bad / 2n > 0n ? bad / 2n : 1n) : bad - ok > 1n ? (ok + bad) / 2n : ok);
  let range = max;
  let cur = from;
  let calls = 0;
  let readTo = from - 1n;
  while (cur <= to) {
    if (now() >= opts.deadline || calls >= opts.maxCalls) return { readTo, calls, complete: false };
    const end = cur + range - 1n > to ? to : cur + range - 1n;
    calls++;
    let logs: RpcLog[];
    try {
      logs = (await rpc('eth_getLogs', [{ address, fromBlock: toHex(cur), toBlock: toHex(end), topics: [[TOPIC_REGISTERED, TOPIC_URI_UPDATED, TOPIC_TRANSFER]] }])) as RpcLog[];
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (range > 1n && RANGE_ERR.test(msg)) {
        if (range < bad) bad = range;
        range = next();
        if (range >= bad) range = bad - 1n > 0n ? bad - 1n : 1n;
        continue;
      }
      if (range > 1n && e instanceof RpcError && (e.status === 413 || e.status >= 500)) { // makeRpc 재시도 뒤에도 실패한 5xx
        range = range / 2n;
        continue;
      }
      throw e;
    }
    if (Array.isArray(logs) && logs.length >= MAX_LOGS_PER_CALL && range > 1n) {
      range = range / 2n; // 1000건 = 잘렸을 수 있다 → 범위를 줄여 같은 시작점부터 다시
      continue;
    }
    await opts.onChunk(Array.isArray(logs) ? logs.filter((l) => !l.removed) : [], end);
    if (end - cur + 1n === range && range > ok) ok = range; // 마지막 짧은 구간은 한도 학습에 쓰지 않음
    readTo = end;
    cur = end + 1n;
    range = next();
  }
  return { readTo, calls, complete: true };
}

// ─────────────────────────────────────────────
// 로그 해석
// ─────────────────────────────────────────────

/** ABI 로 인코딩된 단일 string (data 전체가 string 하나) */
export function decodeAbiString(data: string): string | null {
  const h = data.startsWith('0x') ? data.slice(2) : data;
  if (h.length < 128) return h.length === 0 ? '' : null;
  const off = Number(BigInt('0x' + h.slice(0, 64)));
  if (!Number.isSafeInteger(off) || off * 2 + 64 > h.length) return null;
  const len = Number(BigInt('0x' + h.slice(off * 2, off * 2 + 64)));
  const start = off * 2 + 64;
  if (!Number.isSafeInteger(len) || start + len * 2 > h.length) return null;
  return Buffer.from(h.slice(start, start + len * 2), 'hex').toString('utf8');
}

const topicAddress = (t: string | undefined) => (t && t.length >= 42 ? ('0x' + t.slice(-40)).toLowerCase() : null);

export interface EventRow {
  chain_id: number;
  registry: string;
  block_number: number;
  tx_hash: string;
  log_index: number;
  kind: 'registered' | 'uri_updated' | 'transfer';
  agent_id: string;
  uri: string | null;
  uri_truncated: boolean;
  actor: string | null;
  from_address: string | null;
}

export function parseLog(chainId: number, l: RpcLog): EventRow | null {
  const t0 = l.topics?.[0]?.toLowerCase();
  const base = {
    chain_id: chainId,
    registry: l.address.toLowerCase(),
    block_number: Number(hexToBigInt(l.blockNumber)),
    tx_hash: l.transactionHash.toLowerCase(),
    log_index: Number(hexToBigInt(l.logIndex)),
  };
  const uriOf = () => {
    const s = decodeAbiString(l.data);
    if (s === null) return { uri: null, uri_truncated: false };
    return s.length > MAX_URI_CHARS ? { uri: s.slice(0, MAX_URI_CHARS), uri_truncated: true } : { uri: s, uri_truncated: false };
  };
  if ((t0 === TOPIC_REGISTERED || t0 === TOPIC_URI_UPDATED) && l.topics.length >= 3) {
    return { ...base, kind: t0 === TOPIC_REGISTERED ? 'registered' : 'uri_updated', agent_id: hexToBigInt(l.topics[1]!).toString(), ...uriOf(), actor: topicAddress(l.topics[2]), from_address: null };
  }
  if (t0 === TOPIC_TRANSFER && l.topics.length >= 4) {
    return { ...base, kind: 'transfer', agent_id: hexToBigInt(l.topics[3]!).toString(), uri: null, uri_truncated: false, actor: topicAddress(l.topics[2]), from_address: topicAddress(l.topics[1]) };
  }
  return null;
}

// ─────────────────────────────────────────────
// 등록 파일
// ─────────────────────────────────────────────

const PRIVATE_HOST = /^(localhost|0\.0\.0\.0|\[::1?\]|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[f[cd]|\[fe80)|\.(localhost|local|internal|lan|home\.arpa)$/i;
export const isPrivateHost = (h: string) => h === '' || PRIVATE_HOST.test(h);

export type FileOutcome = 'ok' | 'empty_uri' | 'unsupported_scheme' | 'private_host' | 'http_error' | 'timeout' | 'network' | 'too_large' | 'invalid_json' | 'not_object' | 'uri_truncated';

export interface FileResult {
  outcome: FileOutcome;
  http_status: number | null;
  bytes: number | null;
  sha256: string | null;
  body: unknown;
  services: Array<{ name: string; endpoint: string; version?: string }> | null;
  fetch_via: 'https' | 'ipfs_gateway' | 'data' | null;
}

const empty = (outcome: FileOutcome, extra: Partial<FileResult> = {}): FileResult => ({ outcome, http_status: null, bytes: null, sha256: null, body: null, services: null, fetch_via: null, ...extra });

/** agentURI → 가져올 방법. ipfs://cid/path → 공개 게이트웨이, https → 그대로, data: → 직접 해석 */
export function resolveUri(uri: string): { via: 'https' | 'ipfs_gateway'; url: string } | { via: 'data'; text: string | null } | { via: 'unsupported' } {
  const u = uri.trim();
  if (/^data:/i.test(u)) {
    const m = /^data:([^,]*),(.*)$/is.exec(u);
    if (!m) return { via: 'data', text: null };
    try {
      const text = /;base64/i.test(m[1]!) ? Buffer.from(m[2]!, 'base64').toString('utf8') : decodeURIComponent(m[2]!);
      return { via: 'data', text };
    } catch {
      return { via: 'data', text: null };
    }
  }
  const ipfs = /^ipfs:\/\/(?:ipfs\/)?([A-Za-z0-9]+(?:\/[^?#]*)?)$/i.exec(u);
  if (ipfs) return { via: 'ipfs_gateway', url: IPFS_GATEWAY + ipfs[1] };
  if (/^https:\/\//i.test(u)) return { via: 'https', url: u };
  return { via: 'unsupported' };
}

/** 등록 파일에서 서비스 목록 (명세 services, 옛 형식 endpoints). 이름·주소는 문자열만, 최대 50개 */
export function extractServices(body: unknown): FileResult['services'] {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const b = body as Record<string, unknown>;
  const list = Array.isArray(b.services) ? b.services : Array.isArray(b.endpoints) ? b.endpoints : [];
  const out: NonNullable<FileResult['services']> = [];
  for (const s of list.slice(0, 50)) {
    if (!s || typeof s !== 'object') continue;
    const o = s as Record<string, unknown>;
    const name = typeof o.name === 'string' ? o.name : typeof o.type === 'string' ? o.type : '';
    const endpoint = typeof o.endpoint === 'string' ? o.endpoint : typeof o.url === 'string' ? o.url : '';
    if (!name || !endpoint) continue;
    out.push(typeof o.version === 'string' ? { name: name.slice(0, 100), endpoint: endpoint.slice(0, 2000), version: o.version.slice(0, 40) } : { name: name.slice(0, 100), endpoint: endpoint.slice(0, 2000) });
  }
  return out;
}

function parseBody(text: string, via: FileResult['fetch_via'], status: number | null): FileResult {
  const bytes = Buffer.byteLength(text, 'utf8');
  const sha256 = createHash('sha256').update(text).digest('hex');
  if (bytes > MAX_FILE_BYTES) return empty('too_large', { bytes, sha256, fetch_via: via, http_status: status });
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return empty('invalid_json', { bytes, sha256, fetch_via: via, http_status: status });
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return empty('not_object', { bytes, sha256, fetch_via: via, http_status: status });
  return { outcome: 'ok', http_status: status, bytes, sha256, body, services: extractServices(body), fetch_via: via };
}

/** 본문을 상한까지만 읽는다 */
async function readCapped(res: Response, cap: number): Promise<string | null> {
  if (!res.body) return await res.text();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > cap) {
      try { await reader.cancel(); } catch { /* 무시 */ }
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function fetchRegistrationFile(uri: string | null, truncated: boolean, fetchImpl: typeof fetch = fetch, timeoutMs = 15_000): Promise<FileResult> {
  if (truncated) return empty('uri_truncated');
  if (!uri || !uri.trim()) return empty('empty_uri');
  const r = resolveUri(uri);
  if (r.via === 'unsupported') return empty('unsupported_scheme');
  if (r.via === 'data') return r.text === null ? empty('invalid_json', { fetch_via: 'data' }) : parseBody(r.text, 'data', null);
  let url = r.url;
  for (let hop = 0; hop <= 3; hop++) {
    let host: string;
    try {
      host = new URL(url).hostname.toLowerCase();
    } catch {
      return empty('unsupported_scheme', { fetch_via: r.via });
    }
    if (isPrivateHost(host)) return empty('private_host', { fetch_via: r.via });
    let res: Response;
    try {
      res = await fetchImpl(url, {
        redirect: 'manual',
        headers: { accept: 'application/json, */*;q=0.5', 'user-agent': 'lowdown-scanner-erc8004 (+https://github.com/PetShopBros/lowdown-proxy)' },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      return empty(e instanceof Error && /timeout|abort/i.test(e.name + e.message) ? 'timeout' : 'network', { fetch_via: r.via });
    }
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      const next = new URL(res.headers.get('location')!, url);
      if (next.protocol !== 'https:') return empty('unsupported_scheme', { fetch_via: r.via, http_status: res.status });
      url = next.toString();
      continue;
    }
    if (!res.ok) return empty('http_error', { http_status: res.status, fetch_via: r.via });
    let text: string | null;
    try {
      text = await readCapped(res, MAX_FILE_BYTES);
    } catch {
      return empty('network', { http_status: res.status, fetch_via: r.via });
    }
    if (text === null) return empty('too_large', { http_status: res.status, fetch_via: r.via, bytes: MAX_FILE_BYTES + 1 });
    return parseBody(text, r.via, res.status);
  }
  return empty('http_error', { fetch_via: r.via });
}

/** 동시에 n 개씩, 시간 상한까지 */
export async function pool<T, R>(items: readonly T[], n: number, deadline: number, one: (t: T) => Promise<R>, now: () => number = Date.now): Promise<R[]> {
  const out: R[] = [];
  let i = 0;
  async function worker() {
    while (i < items.length && now() < deadline) {
      const t = items[i++]!;
      out.push(await one(t));
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, n) }, worker));
  return out;
}
