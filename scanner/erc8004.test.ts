import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  decodeAbiString,
  extractServices,
  fetchRegistrationFile,
  findDeployBlock,
  isPrivateHost,
  MAX_FILE_BYTES,
  parseLog,
  readLogs,
  resolveUri,
  RpcError,
  TOPIC_REGISTERED,
  TOPIC_TRANSFER,
  TOPIC_URI_UPDATED,
  type RpcLog,
} from './erc8004-lib.ts';

// ERC-8004 수집 (scanner/erc8004-lib.ts): 로그 해석, 등록 파일 가져오기, 범위 줄이기
const word = (n: bigint | number) => BigInt(n).toString(16).padStart(64, '0');
function abiString(s: string): string {
  const hex = Buffer.from(s, 'utf8').toString('hex');
  const padded = hex.padEnd(Math.ceil(hex.length / 64) * 64 || 64, '0');
  return '0x' + word(32) + word(hex.length / 2) + padded;
}
const addrTopic = (a: string) => '0x' + '0'.repeat(24) + a.slice(2).toLowerCase();
const OWNER = '0x1111111111111111111111111111111111111111';
const REG = '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432';
const log = (topics: string[], data: string, block = 100, idx = 0): RpcLog => ({ address: REG, topics, data, blockNumber: '0x' + block.toString(16), transactionHash: '0xAB', logIndex: '0x' + idx.toString(16) });

describe('로그 해석', () => {
  test('ABI string: 짧은 것·긴 것·빈 것·깨진 것', () => {
    assert.equal(decodeAbiString(abiString('ipfs://bafy')), 'ipfs://bafy');
    const long = 'https://example.com/' + 'a'.repeat(100);
    assert.equal(decodeAbiString(abiString(long)), long);
    assert.equal(decodeAbiString(abiString('')), '');
    assert.equal(decodeAbiString('0x' + word(32) + word(1000)), null);
  });

  test('Registered · URIUpdated · Transfer', () => {
    const r = parseLog(8453, log([TOPIC_REGISTERED, '0x' + word(42), addrTopic(OWNER)], abiString('https://a.example/agent.json'), 0x10, 3))!;
    assert.deepEqual([r.kind, r.agent_id, r.uri, r.actor, r.block_number, r.log_index, r.registry, r.tx_hash], ['registered', '42', 'https://a.example/agent.json', OWNER, 16, 3, REG.toLowerCase(), '0xab']);
    const u = parseLog(1, log([TOPIC_URI_UPDATED, '0x' + word(7), addrTopic(OWNER)], abiString('ipfs://x')))!;
    assert.deepEqual([u.kind, u.agent_id, u.uri], ['uri_updated', '7', 'ipfs://x']);
    const t = parseLog(1, log([TOPIC_TRANSFER, addrTopic('0x' + '0'.repeat(40)), addrTopic(OWNER), '0x' + word(7)], '0x'))!;
    assert.deepEqual([t.kind, t.agent_id, t.actor, t.from_address], ['transfer', '7', OWNER, '0x' + '0'.repeat(40)]);
    assert.equal(parseLog(1, log(['0xdead'], '0x')), null);
  });

  test('64KB 넘는 URI 는 잘라서 표시', () => {
    const r = parseLog(1, log([TOPIC_REGISTERED, '0x' + word(1), addrTopic(OWNER)], abiString('data:application/json,' + 'x'.repeat(70_000))))!;
    assert.equal(r.uri_truncated, true);
    assert.equal(r.uri!.length, 65_536);
  });
});

describe('등록 파일', () => {
  test('URI 종류', () => {
    assert.deepEqual(resolveUri('ipfs://bafyabc/agent.json'), { via: 'ipfs_gateway', url: 'https://ipfs.io/ipfs/bafyabc/agent.json' });
    assert.deepEqual(resolveUri('https://x.dev/a.json'), { via: 'https', url: 'https://x.dev/a.json' });
    assert.deepEqual(resolveUri('http://x.dev/a.json'), { via: 'unsupported' });
    assert.deepEqual(resolveUri('ar://abc'), { via: 'unsupported' });
    const b64 = 'data:application/json;base64,' + Buffer.from('{"name":"a"}').toString('base64');
    assert.deepEqual(resolveUri(b64), { via: 'data', text: '{"name":"a"}' });
    assert.deepEqual(resolveUri('data:application/json,%7B%22n%22%3A1%7D'), { via: 'data', text: '{"n":1}' });
  });

  test('서비스: 명세 services, 옛 endpoints, 이상한 값 건너뜀', () => {
    assert.deepEqual(extractServices({ services: [{ name: 'MCP', endpoint: 'https://m.x/mcp', version: '2025-06-18' }, { name: 'A2A' }, 5] }), [{ name: 'MCP', endpoint: 'https://m.x/mcp', version: '2025-06-18' }]);
    assert.deepEqual(extractServices({ endpoints: [{ type: 'mcp', url: 'https://m.x' }] }), [{ name: 'mcp', endpoint: 'https://m.x' }]);
    assert.deepEqual(extractServices({}), []);
    assert.equal(extractServices([1]), null);
  });

  test('사설 호스트', () => {
    for (const h of ['localhost', '127.0.0.1', '10.1.2.3', '192.168.0.1', '172.20.0.1', 'a.internal', 'x.local', '[::1]', '']) assert.ok(isPrivateHost(h), h);
    for (const h of ['example.com', '172.15.0.1', '8.8.8.8']) assert.ok(!isPrivateHost(h), h);
  });

  const mock = (routes: Record<string, () => Response>) => (async (u: any) => {
    const r = routes[String(u)];
    if (!r) throw new TypeError('fetch failed');
    return r();
  }) as typeof fetch;

  test('가져오기: 성공·data·리다이렉트(사설 차단)·HTTP 오류·JSON 아님·배열·너무 큼·빈 URI', async () => {
    const body = JSON.stringify({ type: 'x', name: 'a', services: [{ name: 'MCP', endpoint: 'https://m.x/mcp' }] });
    const f = mock({
      'https://ok.example/a.json': () => new Response(body, { status: 200 }),
      'https://ipfs.io/ipfs/bafy1': () => new Response(body, { status: 200 }),
      'https://redir.example/a': () => new Response('', { status: 302, headers: { location: 'https://127.0.0.1/a' } }),
      'https://redir2.example/a': () => new Response('', { status: 301, headers: { location: '/b' } }),
      'https://redir2.example/b': () => new Response(body, { status: 200 }),
      'https://404.example/a': () => new Response('no', { status: 404 }),
      'https://html.example/a': () => new Response('<html>', { status: 200 }),
      'https://arr.example/a': () => new Response('[1]', { status: 200 }),
      'https://big.example/a': () => new Response('x'.repeat(MAX_FILE_BYTES + 10), { status: 200 }),
    });
    const ok = await fetchRegistrationFile('https://ok.example/a.json', false, f);
    assert.equal(ok.outcome, 'ok');
    assert.equal(ok.fetch_via, 'https');
    assert.equal(ok.http_status, 200);
    assert.equal(ok.sha256!.length, 64);
    assert.deepEqual(ok.services, [{ name: 'MCP', endpoint: 'https://m.x/mcp' }]);
    assert.equal((await fetchRegistrationFile('ipfs://bafy1', false, f)).fetch_via, 'ipfs_gateway');
    const d = await fetchRegistrationFile('data:application/json;base64,' + Buffer.from(body).toString('base64'), false, f);
    assert.deepEqual([d.outcome, d.fetch_via, d.http_status], ['ok', 'data', null]);
    assert.equal((await fetchRegistrationFile('https://redir.example/a', false, f)).outcome, 'private_host');
    assert.equal((await fetchRegistrationFile('https://redir2.example/a', false, f)).outcome, 'ok');
    assert.deepEqual([(await fetchRegistrationFile('https://404.example/a', false, f)).outcome, (await fetchRegistrationFile('https://404.example/a', false, f)).http_status], ['http_error', 404]);
    assert.equal((await fetchRegistrationFile('https://html.example/a', false, f)).outcome, 'invalid_json');
    assert.equal((await fetchRegistrationFile('https://arr.example/a', false, f)).outcome, 'not_object');
    assert.equal((await fetchRegistrationFile('https://big.example/a', false, f)).outcome, 'too_large');
    assert.equal((await fetchRegistrationFile('https://down.example/a', false, f)).outcome, 'network');
    assert.equal((await fetchRegistrationFile('https://localhost/a', false, f)).outcome, 'private_host');
    assert.equal((await fetchRegistrationFile('', false, f)).outcome, 'empty_uri');
    assert.equal((await fetchRegistrationFile('ipfs://x', true, f)).outcome, 'uri_truncated');
    assert.equal((await fetchRegistrationFile('ftp://x', false, f)).outcome, 'unsupported_scheme');
  });
});

describe('체인 읽기', () => {
  test('배포 블록 이분 탐색', async () => {
    const rpc = async (_m: string, p: unknown[]) => (BigInt(p[1] as string) >= 12345n ? '0x6080' : '0x');
    assert.equal(await findDeployBlock(rpc, REG, 100000n), 12345n);
  });

  test('범위 오류면 반으로 줄이고, 다 읽으면 끝까지·구간마다 onChunk', async () => {
    const asked: Array<[number, number]> = [];
    const rpc = async (_m: string, p: any[]) => {
      const a = Number(BigInt(p[0].fromBlock));
      const b = Number(BigInt(p[0].toBlock));
      asked.push([a, b]);
      if (b - a + 1 > 2500) throw new RpcError('query exceeds max block range 2500', 200, -32600);
      return a <= 5000 && 5000 <= b ? [log([TOPIC_REGISTERED, '0x' + word(1), addrTopic(OWNER)], abiString('x'), 5000)] : [];
    };
    const chunks: Array<[number, number]> = [];
    const r = await readLogs(rpc, REG, 1n, 9000n, { maxRange: 10_000, deadline: Infinity, maxCalls: 100, onChunk: async (logs, upTo) => { chunks.push([logs.length, Number(upTo)]); } });
    assert.equal(r.complete, true);
    assert.equal(r.readTo, 9000n);
    assert.equal(chunks.reduce((n, c) => n + c[0], 0), 1);
    assert.equal(chunks.at(-1)![1], 9000);
    assert.ok(asked.some(([a, b]) => b - a + 1 <= 2500));
  });

  test('범위 제한을 배우면 다시 넓히지 않는다', async () => {
    let calls = 0;
    const rpc = async (_m: string, p: any[]) => {
      calls++;
      const a = Number(BigInt(p[0].fromBlock));
      const b = Number(BigInt(p[0].toBlock));
      if (b - a + 1 > 1000) throw new RpcError('ranges over 10000 blocks are not supported on free plan', 400, 35);
      return [];
    };
    const r = await readLogs(rpc, REG, 1n, 20_000n, { maxRange: 10_000, deadline: Infinity, maxCalls: 1000, onChunk: async () => {} });
    assert.equal(r.complete, true);
    assert.ok(calls <= 40, `calls ${calls}`); // 실패 4번(10000→5000→2500→1250→625) + 625씩 32번. 배우지 않으면 성공마다 넓혀 실패가 반복된다
  });

  test('1000건이 오면 잘렸을 수 있어 범위를 줄여 다시 읽는다', async () => {
    const at = Array.from({ length: 1500 }, (_, i) => 1000 + i); // 블록 1000~2499 에 1건씩
    const rpc = async (_m: string, p: any[]) => {
      const a = Number(BigInt(p[0].fromBlock));
      const b = Number(BigInt(p[0].toBlock));
      return at.filter((x) => x >= a && x <= b).slice(0, 1000).map((x) => log([TOPIC_REGISTERED, '0x' + word(x), addrTopic(OWNER)], abiString('u'), x));
    };
    let n = 0;
    const r = await readLogs(rpc, REG, 1n, 5000n, { maxRange: 10_000, deadline: Infinity, maxCalls: 100, onChunk: async (logs) => { n += logs.length; } });
    assert.equal(r.complete, true);
    assert.equal(n, 1500);
  });

  test('429 는 쉬었다 다시', async () => {
    const { makeRpc } = await import('./erc8004-lib.ts');
    let k = 0;
    const f = (async () => (++k < 3 ? new Response('busy', { status: 429 }) : new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x10' })))) as unknown as typeof fetch;
    const rpc = makeRpc('https://x', f, 1000, async () => {});
    assert.equal(await rpc('eth_blockNumber', []), '0x10');
    assert.equal(k, 3);
  });

  test('호출 상한에 걸리면 읽은 데까지', async () => {
    const rpc = async () => [];
    const r = await readLogs(rpc, REG, 1n, 100_000n, { maxRange: 1000, deadline: Infinity, maxCalls: 3, onChunk: async () => {} });
    assert.deepEqual([r.complete, r.readTo, r.calls], [false, 3000n, 3]);
  });

  test('범위와 무관한 오류는 그대로 던진다', async () => {
    const rpc = async () => { throw new RpcError('invalid params', 200, -32602); };
    await assert.rejects(readLogs(rpc, REG, 1n, 10n, { maxRange: 10, deadline: Infinity, maxCalls: 5, onChunk: async () => {} }), /invalid params/);
  });
});
