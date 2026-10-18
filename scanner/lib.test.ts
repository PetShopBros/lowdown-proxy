import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { createServer } from 'node:https';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import {
  attachRetry,
  canonicalJson,
  capHost,
  classifyNetworkError,
  countObservationsSince,
  csvEscape,
  extendCohort,
  extendCohortCapped,
  extractRpcMessage,
  fetchCohort,
  fetchFallbackJobs,
  fetchMonthRows,
  fetchRegistryTargets,
  hashTools,
  hostConcentration,
  hostOf,
  httpsPost,
  insertCohortGaps,
  insertObservations,
  isBlockedIp,
  isRetryable,
  monthRanges,
  parseSafeUrl,
  planCohortJobs,
  probeRemote,
  rowsToCsv,
  runPerHostRoundRobin,
  runPool,
  saveCohort,
  SCANNER_VERSION,
  scannerCommit,
  selectCohort,
  supabaseHeaders,
  topHosts,
  TransportError,
  utcDayStart,
} from './lib.ts';
import type { ObservationRow, PostFn, PostResult, RetryInfo } from './lib.ts';

// ───────────── SSRF ─────────────
describe('SSRF', () => {
  test('공개 https 만 통과', () => {
    assert.equal(parseSafeUrl('https://api.example.com/mcp').hostname, 'api.example.com');
    assert.equal(parseSafeUrl('https://8.8.8.8/mcp').hostname, '8.8.8.8');
  });
  test('차단 대상', () => {
    for (const u of [
      'http://api.example.com/mcp',
      'https://user:pw@api.example.com/',
      'https://localhost/mcp',
      'https://foo.localhost/mcp',
      'https://printer.local/mcp',
      'https://svc.internal/mcp',
      'https://intranet/mcp',
      'https://127.0.0.1/mcp',
      'https://2130706433/mcp', // 10진 표기 127.0.0.1
      'https://0x7f.1/mcp',
      'https://10.1.2.3/mcp',
      'https://169.254.169.254/latest/meta-data',
      'https://192.168.0.1/',
      'https://100.64.0.1/',
      'https://[::1]/mcp',
      'https://[::ffff:127.0.0.1]/mcp',
      'https://[fe80::1]/mcp',
      'https://[fd00::1]/mcp',
      'not a url',
      'ftp://example.com/',
    ]) {
      assert.throws(() => parseSafeUrl(u), /blocked url/, u);
    }
  });
  test('isBlockedIp 경계', () => {
    assert.equal(isBlockedIp('8.8.8.8'), false);
    assert.equal(isBlockedIp('172.15.255.255'), false);
    assert.equal(isBlockedIp('172.16.0.1'), true);
    assert.equal(isBlockedIp('172.32.0.1'), false);
    assert.equal(isBlockedIp('2606:4700:4700::1111'), false);
    assert.equal(isBlockedIp('::ffff:10.0.0.1'), true);
    assert.equal(isBlockedIp('garbage'), true);
  });
});

// ───────────── 파싱/해시/분류 ─────────────
describe('parsing', () => {
  test('JSON / SSE / 배열 / 쓰레기', () => {
    assert.deepEqual(extractRpcMessage('{"jsonrpc":"2.0","id":1,"result":{"a":1}}', false, 1)?.result, { a: 1 });
    assert.equal(extractRpcMessage('{"jsonrpc":"2.0","id":2,"result":{}}', false, 1), null);
    assert.ok(extractRpcMessage('[{"id":9,"result":1},{"id":1,"result":2}]', false, 1));
    const sse =
      'event: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress"}\n\n' +
      'event: message\ndata: {"jsonrpc":"2.0","id":1,\ndata: "result":{"ok":true}}\n\n';
    assert.deepEqual(extractRpcMessage(sse, true, 1)?.result, { ok: true });
    assert.equal(extractRpcMessage('<html>nope</html>', false, 1), null);
    assert.equal(extractRpcMessage('data: {"id":1,"res', true, 1), null); // 덜 받은 이벤트
    assert.ok(extractRpcMessage('data: {"id":1,"result":{}}\n\n', false, 1)); // content-type 이 틀려도 SSE 형식 fallback
  });
  test('해시: 키/툴 순서 무관, 변경 감지', () => {
    const a = [
      { name: 'a', description: 'd1', inputSchema: { type: 'object', properties: { x: { type: 'string' }, y: { type: 'number' } } } },
      { name: 'b', description: 'd2', inputSchema: { type: 'object' } },
    ];
    const reordered = [
      { inputSchema: { type: 'object' }, description: 'd2', name: 'b' },
      { description: 'd1', name: 'a', inputSchema: { properties: { y: { type: 'number' }, x: { type: 'string' } }, type: 'object' } },
    ];
    assert.deepEqual(hashTools(a), hashTools(reordered));
    const schemaChanged = structuredClone(a);
    (schemaChanged[0]!.inputSchema.properties as Record<string, unknown>).z = { type: 'boolean' };
    assert.notEqual(hashTools(schemaChanged).schema_hash, hashTools(a).schema_hash);
    assert.equal(hashTools(schemaChanged).desc_hash, hashTools(a).desc_hash);
    const descChanged = structuredClone(a);
    descChanged[1]!.description = 'changed';
    assert.equal(hashTools(descChanged).schema_hash, hashTools(a).schema_hash);
    assert.notEqual(hashTools(descChanged).desc_hash, hashTools(a).desc_hash);
    assert.equal(canonicalJson({ b: 1, a: [2, { d: 1, c: undefined }] }), '{"a":[2,{"d":1}],"b":1}');
    assert.doesNotThrow(() => hashTools([1, null, 'x', [], {}]));
  });
  test('에러 분류', () => {
    const c = (code: string) => classifyNetworkError(Object.assign(new Error('x'), { code }));
    assert.equal(c('ENOTFOUND'), 'dns');
    assert.equal(c('EAI_AGAIN'), 'dns');
    assert.equal(c('ECONNREFUSED'), 'conn_refused');
    assert.equal(c('ECONNRESET'), 'conn_reset');
    assert.equal(c('ETIMEDOUT'), 'timeout');
    assert.equal(c('CERT_HAS_EXPIRED'), 'tls');
    assert.equal(c('DEPTH_ZERO_SELF_SIGNED_CERT'), 'tls');
    assert.equal(c('ERR_TLS_CERT_ALTNAME_INVALID'), 'tls');
    assert.equal(c('EPROTO'), 'tls');
    assert.equal(c('EWHATEVER'), 'network_error');
    assert.equal(classifyNetworkError(new AggregateError([Object.assign(new Error('x'), { code: 'ECONNREFUSED' })])), 'conn_refused');
    assert.equal(classifyNetworkError(new TransportError('timeout', 't')), 'timeout');
  });
});

// ───────────── probeRemote (mock 전송) ─────────────
function res(over: Partial<PostResult> & { message?: PostResult['message'] }): PostResult {
  return { status: 200, headers: {}, contentType: 'application/json', message: null, parseError: false, ms: 42, ...over };
}
const INIT_OK = { id: 1, result: { protocolVersion: '2025-06-18', serverInfo: { name: 'x', version: '1.2.3' }, capabilities: {} } };
const LIST_OK = { id: 2, result: { tools: [{ name: 't1', description: 'secret desc', inputSchema: { type: 'object' } }, { name: 't2' }] } };
const REMOTE = { type: 'streamable-http', url: 'https://mcp.example.com/mcp' };
const CTX = { registryVersion: '1.0.0', index: 0 };

describe('probeRemote', () => {
  test('L2 성공 + 세션 흐름 + 설명문 미저장', async () => {
    const calls: Array<{ body: string | null; method?: string; headers?: Record<string, string> }> = [];
    const post: PostFn = async (_u, body, o) => {
      calls.push({ body, method: o.method, headers: o.headers });
      if (o.method === 'DELETE') return res({ status: 204 });
      const m = body ? (JSON.parse(body) as { method?: string }).method : '';
      if (m === 'initialize') return res({ message: INIT_OK, headers: { 'mcp-session-id': 'sess-1' } });
      if (m === 'notifications/initialized') return res({ status: 202 });
      return res({ message: LIST_OK, ms: 77 });
    };
    const r = await probeRemote(REMOTE, CTX, post);
    assert.equal(r.reached_level, 2);
    assert.equal(r.http_status, 200);
    assert.equal(r.error_type, null);
    assert.equal(r.latency_ms, 42);
    assert.equal(r.metadata.tool_count, 2);
    assert.equal(r.metadata.server_version, '1.2.3');
    assert.equal(r.metadata.list_latency_ms, 77);
    assert.match(String(r.metadata.schema_hash), /^[0-9a-f]{64}$/);
    assert.ok(!JSON.stringify(r.metadata).includes('secret desc'));
    assert.ok(!JSON.stringify(r.metadata).includes('t1'));
    // 후속 요청에 세션/프로토콜 헤더, 마지막에 DELETE
    assert.equal(calls[1]!.headers?.['Mcp-Session-Id'], 'sess-1');
    assert.equal(calls[2]!.headers?.['MCP-Protocol-Version'], '2025-06-18');
    assert.equal(calls.at(-1)!.method, 'DELETE');
  });
  test('401 + WWW-Authenticate → 사실만 기록', async () => {
    const post: PostFn = async () => res({ status: 401, headers: { 'www-authenticate': 'Bearer resource_metadata="https://x/.well-known/oauth-protected-resource"' } });
    const r = await probeRemote(REMOTE, CTX, post);
    assert.deepEqual([r.reached_level, r.http_status, r.error_type], [0, 401, null]);
    assert.equal(r.metadata.www_authenticate, true);
    assert.equal(r.metadata.www_authenticate_resource_metadata, true);
  });
  test('403 헤더 없음', async () => {
    const r = await probeRemote(REMOTE, CTX, async () => res({ status: 403 }));
    assert.deepEqual([r.reached_level, r.http_status], [0, 403]);
    assert.equal(r.metadata.www_authenticate, false);
  });
  test('전송 실패 → http_status null + error_type', async () => {
    const r = await probeRemote(REMOTE, CTX, async () => {
      throw new TransportError('timeout', 't', 10_001);
    });
    assert.deepEqual([r.reached_level, r.http_status, r.error_type, r.latency_ms], [0, null, 'timeout', 10_001]);
  });
  test('200 인데 JSON-RPC 아님 → invalid_response', async () => {
    const r = await probeRemote(REMOTE, CTX, async () => res({ contentType: 'text/html', parseError: true }));
    assert.deepEqual([r.reached_level, r.http_status, r.error_type], [0, 200, 'invalid_response']);
  });
  test('initialize JSON-RPC error → 코드만 기록', async () => {
    const r = await probeRemote(REMOTE, CTX, async () => res({ message: { id: 1, error: { code: -32601, message: 'x'.repeat(500) } } }));
    assert.equal(r.reached_level, 0);
    assert.equal(r.metadata.rpc_error_code, -32601);
    assert.ok(!JSON.stringify(r.metadata).includes('xxxx'));
  });
  test('L1: tools/list 401 / 타임아웃 / 비정상 결과', async () => {
    const make =
      (list: () => Promise<PostResult>): PostFn =>
      async (_u, body, o) => {
        if (o.method === 'DELETE') return res({ status: 204 });
        const m = body ? (JSON.parse(body) as { method?: string }).method : '';
        if (m === 'initialize') return res({ message: INIT_OK });
        if (m === 'notifications/initialized') return res({ status: 202 });
        return list();
      };
    const a = await probeRemote(REMOTE, CTX, make(async () => res({ status: 401 })));
    assert.deepEqual([a.reached_level, a.http_status, a.error_type], [1, 401, null]);
    const b = await probeRemote(REMOTE, CTX, make(async () => { throw new TransportError('timeout', 't', 1); }));
    assert.deepEqual([b.reached_level, b.http_status, b.error_type], [1, 200, 'timeout']);
    const c = await probeRemote(REMOTE, CTX, make(async () => res({ message: { id: 2, result: { tools: 'nope' } } })));
    assert.deepEqual([c.reached_level, c.error_type], [1, 'invalid_response']);
  });
  test('initialized 알림 실패해도 tools/list 진행', async () => {
    const post: PostFn = async (_u, body, o) => {
      if (o.method === 'DELETE') return res({ status: 204 });
      const m = body ? (JSON.parse(body) as { method?: string }).method : '';
      if (m === 'initialize') return res({ message: INIT_OK });
      if (m === 'notifications/initialized') throw new TransportError('conn_reset', 'x');
      return res({ message: LIST_OK });
    };
    assert.equal((await probeRemote(REMOTE, CTX, post)).reached_level, 2);
  });
  test('악성 세션 ID 는 헤더로 쓰지 않음', async () => {
    let seen: Record<string, string> | undefined;
    const post: PostFn = async (_u, body, o) => {
      if (o.method === 'DELETE') return res({ status: 204 });
      const m = body ? (JSON.parse(body) as { method?: string }).method : '';
      if (m === 'initialize') return res({ message: INIT_OK, headers: { 'mcp-session-id': 'bad id\twith space' } });
      if (m === 'tools/list') seen = o.headers;
      return res({ message: LIST_OK, status: m === 'notifications/initialized' ? 202 : 200 });
    };
    await probeRemote(REMOTE, CTX, post);
    assert.equal(seen?.['Mcp-Session-Id'], undefined);
  });
});

// ───────────── 실제 전송 계층 (로컬 HTTPS 서버) ─────────────
describe('httpsPost over local HTTPS', () => {
  let server: Server;
  let base = '';
  let ca = '';
  let deleted = 0;
  let skip = false;

  const readBody = (req: IncomingMessage) =>
    new Promise<string>((resolve) => {
      let b = '';
      req.on('data', (c: Buffer) => (b += c.toString()));
      req.on('end', () => resolve(b));
    });

  before(async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ld-cert-'));
    try {
      execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(dir, 'k.pem'), '-out', join(dir, 'c.pem'), '-days', '2', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], { stdio: 'ignore' });
    } catch {
      skip = true;
      return;
    }
    ca = readFileSync(join(dir, 'c.pem'), 'utf8');
    server = createServer({ key: readFileSync(join(dir, 'k.pem')), cert: ca }, (req: IncomingMessage, res: ServerResponse) => {
      void (async () => {
        const body = await readBody(req);
        const path = req.url ?? '';
        const rpc = body ? (JSON.parse(body) as { id?: number; method?: string }) : {};
        const json = (obj: unknown, headers: Record<string, string> = {}) => {
          res.writeHead(200, { 'content-type': 'application/json', ...headers });
          res.end(JSON.stringify(obj));
        };
        if (path === '/mcp') {
          if (req.method === 'DELETE') {
            deleted++;
            res.writeHead(204).end();
          } else if (rpc.method === 'initialize') {
            json({ jsonrpc: '2.0', id: rpc.id, result: { protocolVersion: '2025-06-18', serverInfo: { name: 's', version: '9.9.9' } } }, { 'mcp-session-id': 'abc123' });
          } else if (rpc.method === 'notifications/initialized') {
            res.writeHead(202).end();
          } else if (rpc.method === 'tools/list') {
            if (req.headers['mcp-session-id'] !== 'abc123') {
              res.writeHead(400).end('no session');
              return;
            }
            json({ jsonrpc: '2.0', id: rpc.id, result: { tools: [{ name: 'a', inputSchema: { type: 'object' } }] } });
          }
        } else if (path === '/sse') {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.write('event: message\ndata: {"jsonrpc":"2.0","method":"notifications/message"}\n\n');
          setTimeout(() => {
            res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { ok: true } })}\n\n`);
            // 스트림을 열어둔 채로 둔다 — 클라이언트가 결과를 받는 즉시 끝내야 함
          }, 30);
        } else if (path === '/401') {
          res.writeHead(401, { 'www-authenticate': 'Bearer realm="x"' }).end('{"error":"auth"}');
        } else if (path === '/302') {
          res.writeHead(302, { location: 'https://127.0.0.1:1/' }).end();
        } else if (path === '/big') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(`{"id":${rpc.id},"result":"${'x'.repeat(2 << 20)}"}`);
        } else if (path === '/html') {
          res.writeHead(200, { 'content-type': 'text/html' }).end('<html>hello</html>');
        } else if (path === '/slow') {
          // 응답하지 않음
        } else {
          res.writeHead(404).end();
        }
      })();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `https://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(() => {
    server?.closeAllConnections();
    server?.close();
  });

  const post = (path: string, id = 1, over = {}) =>
    httpsPost(`${base}${path}`, JSON.stringify({ jsonrpc: '2.0', id, method: 'initialize' }), { timeoutMs: 2_000, maxBytes: 1 << 20, expectId: id, allowPrivate: true, ca, ...over });

  test('전체 probe 흐름 (initialize → initialized → tools/list → DELETE)', async (t) => {
    if (skip) return t.skip('openssl 없음');
    const wrapped: PostFn = (u, b, o) => httpsPost(u, b, { ...o, allowPrivate: true, ca });
    const r = await probeRemote({ type: 'streamable-http', url: `${base}/mcp` }, CTX, wrapped);
    assert.equal(r.reached_level, 2);
    assert.equal(r.metadata.tool_count, 1);
    assert.equal(r.metadata.server_version, '9.9.9');
    assert.equal(r.metadata.session_id_issued, true);
    assert.equal(deleted, 1);
  });
  test('SSE: 결과 수신 즉시 종료(스트림이 열려 있어도)', async (t) => {
    if (skip) return t.skip('openssl 없음');
    const t0 = Date.now();
    const r = await post('/sse');
    assert.deepEqual(r.message?.result, { ok: true });
    assert.ok(Date.now() - t0 < 1_500);
  });
  test('401: 본문 안 읽고 헤더만', async (t) => {
    if (skip) return t.skip('openssl 없음');
    const r = await post('/401');
    assert.equal(r.status, 401);
    assert.equal(r.headers['www-authenticate'], 'Bearer realm="x"');
    assert.equal(r.message, null);
  });
  test('302 리다이렉트는 따라가지 않음', async (t) => {
    if (skip) return t.skip('openssl 없음');
    assert.equal((await post('/302')).status, 302);
  });
  test('본문 크기 상한 초과 → parseError', async (t) => {
    if (skip) return t.skip('openssl 없음');
    const r = await post('/big');
    assert.equal(r.parseError, true);
    assert.equal(r.message, null);
  });
  test('HTML 200 → message null', async (t) => {
    if (skip) return t.skip('openssl 없음');
    const r = await post('/html');
    assert.equal(r.status, 200);
    assert.equal(r.parseError, true);
  });
  test('타임아웃', async (t) => {
    if (skip) return t.skip('openssl 없음');
    await assert.rejects(post('/slow', 1, { timeoutMs: 300 }), (e: unknown) => e instanceof TransportError && e.errorType === 'timeout' && (e.ms ?? 0) >= 250);
  });
  test('연결 거부', async () => {
    await assert.rejects(
      httpsPost('https://127.0.0.1:1/mcp', '{}', { timeoutMs: 2_000, maxBytes: 10, expectId: 1, allowPrivate: true }),
      (e: unknown) => e instanceof TransportError && e.errorType === 'conn_refused',
    );
  });
  test('SSRF: allowPrivate 없으면 로컬은 연결 전에 차단', async () => {
    for (const u of ['https://127.0.0.1:1/mcp', 'https://localhost:1/mcp', 'https://[::1]:1/mcp', 'http://example.com/mcp']) {
      await assert.rejects(
        httpsPost(u, '{}', { timeoutMs: 2_000, maxBytes: 10, expectId: 1 }),
        (e: unknown) => e instanceof TransportError && e.errorType === 'blocked_url',
        u,
      );
    }
  });
  test('DNS 실패 → dns (또는 샌드박스에서 해석 불가)', async () => {
    await assert.rejects(
      httpsPost('https://nonexistent-host.invalid/mcp', '{}', { timeoutMs: 5_000, maxBytes: 10, expectId: 1 }),
      (e: unknown) => e instanceof TransportError && e.errorType === 'dns',
    );
  });
});

// ───────────── Registry ─────────────
function entry(name: string, version: string, opts: { status?: string; latest?: boolean; remotes?: unknown[] } = {}) {
  return {
    server: { name, version, ...(opts.remotes ? { remotes: opts.remotes } : {}) },
    _meta: { 'io.modelcontextprotocol.registry/official': { status: opts.status ?? 'active', isLatest: opts.latest ?? true } },
  };
}
function mockRegistry(pages: unknown[][], seen: string[] = []): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    seen.push(url.search);
    const cursor = url.searchParams.get('cursor');
    const idx = cursor ? Number(cursor.replace('c', '')) : 0;
    const body = { servers: pages[idx], metadata: { count: pages[idx]!.length, ...(idx + 1 < pages.length ? { nextCursor: `c${idx + 1}` } : {}) } };
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
}

describe('fetchRegistryTargets', () => {
  const http = (url: string) => ({ type: 'streamable-http', url });
  test('페이지네이션 + active/isLatest 필터 + remote 분류', async () => {
    const seen: string[] = [];
    const pages = [
      [
        entry('a/old', '1.0.0', { latest: false, remotes: [http('https://a.example.com')] }),
        entry('a/new', '2.0.0', { remotes: [http('https://a.example.com'), http('https://a.example.com'), { type: 'sse', url: 'https://sse.example.com' }, http('https://{tenant}.example.com')] }),
        entry('b/deprecated', '1.0.0', { status: 'deprecated', remotes: [http('https://b.example.com')] }),
      ],
      [entry('c/local', '1.0.0'), entry('d/two', '1.0.0', { remotes: [http('https://d1.example.com'), http('https://d2.example.com')] })],
    ];
    const { targets, stats, registryInfo } = await fetchRegistryTargets({ fetchImpl: mockRegistry(pages, seen), sleep: async () => {} });
    assert.deepEqual(targets.map((t) => t.name), ['a/new', 'd/two']);
    assert.deepEqual(targets[0]!.remotes, [http('https://a.example.com')]);
    assert.equal(stats.pages, 2);
    assert.equal(stats.entries, 5);
    assert.equal(stats.active_latest, 3 - 0 + 1 - 1 + 0); // a/new, c/local, d/two
    assert.equal(stats.skipped_non_streamable_http, 1);
    assert.equal(stats.skipped_templated_url, 1);
    assert.equal(stats.remotes_probeable, 3);
    assert.match(seen[0]!, /limit=100/);
    assert.match(seen[0]!, /version=latest/);
    assert.match(seen[1]!, /cursor=c1/);
    // registryInfo: probe 대상이 아닌 항목도 사유 판단용으로 기록된다
    assert.deepEqual(registryInfo.get('a/old'), { version: '1.0.0', status: 'active', isLatest: false, hasAnyRemotes: false, hasProbeableRemote: false });
    assert.deepEqual(registryInfo.get('b/deprecated'), { version: '1.0.0', status: 'deprecated', isLatest: true, hasAnyRemotes: false, hasProbeableRemote: false });
    assert.deepEqual(registryInfo.get('c/local'), { version: '1.0.0', status: 'active', isLatest: true, hasAnyRemotes: false, hasProbeableRemote: false });
    assert.deepEqual(registryInfo.get('a/new'), { version: '2.0.0', status: 'active', isLatest: true, hasAnyRemotes: true, hasProbeableRemote: true });
  });
  test('커서 무시 서버 → 명확히 실패(무한루프 방지)', async () => {
    const f = (async () => new Response(JSON.stringify({ servers: [entry('a/x', '1.0.0')], metadata: { nextCursor: 'same' } }), { status: 200 })) as typeof fetch;
    await assert.rejects(fetchRegistryTargets({ fetchImpl: f, sleep: async () => {} }), /did not advance/);
  });
  test('형식 이상 / 5xx 재시도 후 실패', async () => {
    const bad = (async () => new Response('{"nope":1}', { status: 200 })) as typeof fetch;
    await assert.rejects(fetchRegistryTargets({ fetchImpl: bad }), /unexpected response shape/);
    let n = 0;
    const flaky = (async () => (++n < 3 ? new Response('x', { status: 503 }) : new Response(JSON.stringify({ servers: [] }), { status: 200 }))) as typeof fetch;
    const r = await fetchRegistryTargets({ fetchImpl: flaky, sleep: async () => {} });
    assert.equal(r.targets.length, 0);
    assert.equal(n, 3);
    const dead = (async () => new Response('x', { status: 500 })) as typeof fetch;
    await assert.rejects(fetchRegistryTargets({ fetchImpl: dead, sleep: async () => {} }), /HTTP 500/);
    const notFound = (async () => new Response('x', { status: 404 })) as typeof fetch;
    await assert.rejects(fetchRegistryTargets({ fetchImpl: notFound, sleep: async () => {} }), /HTTP 404/);
  });
});

// ───────────── Supabase ─────────────
const ROW: ObservationRow = {
  scan_run_id: '00000000-0000-4000-8000-000000000000',
  node_id: 'ld_test',
  target_id: 't',
  target_type: 'mcp_server',
  observed_at: '2026-10-07T00:00:00.000Z',
  source: 'scanner',
  transport: 'streamable-http',
  http_status: 200,
  reached_level: 2,
  latency_ms: 10,
  error_type: null,
  metadata: { remote_url: 'https://x' },
};
const CFG = { url: 'https://proj.supabase.co/', key: 'sb_secret_abc' };

describe('supabase', () => {
  test('헤더: sb_ 키는 apikey 만, JWT 는 Authorization 도', () => {
    assert.deepEqual(supabaseHeaders('sb_secret_abc'), { apikey: 'sb_secret_abc' });
    assert.deepEqual(supabaseHeaders('eyJhbGci.x.y'), { apikey: 'eyJhbGci.x.y', Authorization: 'Bearer eyJhbGci.x.y' });
  });
  test('배치 분할 + 엔드포인트', async () => {
    const calls: Array<{ url: string; n: number }> = [];
    const f = (async (u: string, init: RequestInit) => {
      calls.push({ url: u, n: (JSON.parse(String(init.body)) as unknown[]).length });
      return new Response(null, { status: 201 });
    }) as unknown as typeof fetch;
    const n = await insertObservations(Array.from({ length: 5 }, () => ROW), CFG, { fetchImpl: f, batchSize: 2 });
    assert.equal(n, 5);
    assert.deepEqual(calls.map((c) => c.n), [2, 2, 1]);
    assert.equal(calls[0]!.url, 'https://proj.supabase.co/rest/v1/scanner_observations');
  });
  test('5xx/네트워크 오류 재시도 → 성공, 유실 후 409 는 성공으로 간주', async () => {
    let n = 0;
    const f = (async () => {
      n++;
      if (n === 1) throw new Error('socket hang up');
      if (n === 2) return new Response('x', { status: 502 });
      return new Response('dup', { status: 409 });
    }) as unknown as typeof fetch;
    assert.equal(await insertObservations([ROW], CFG, { fetchImpl: f, sleep: async () => {} }), 1);
    assert.equal(n, 3);
  });
  test('첫 시도 409/400/401 은 즉시 실패(조용히 성공 금지)', async () => {
    for (const status of [409, 400, 401, 404]) {
      let n = 0;
      const f = (async () => {
        n++;
        return new Response('{"message":"no"}', { status });
      }) as unknown as typeof fetch;
      await assert.rejects(insertObservations([ROW], CFG, { fetchImpl: f, sleep: async () => {} }), new RegExp(`HTTP ${status}`));
      assert.equal(n, 1);
    }
  });
  test('재시도 소진 시 실패', async () => {
    const f = (async () => new Response('x', { status: 503 })) as unknown as typeof fetch;
    await assert.rejects(insertObservations([ROW], CFG, { fetchImpl: f, sleep: async () => {}, maxAttempts: 3 }), /HTTP 503/);
  });
});

describe('insertCohortGaps', () => {
  const GAP = { target_id: 'mcp:gone/server', reason: 'not_in_registry' as const, registry_version: null, registry_status: null, scan_run_id: 'r1', cohort_version: 'v1', observed_at: '2026-10-12T00:00:00Z' };
  test('빈 배열은 요청 없이 0', async () => {
    const f = (async () => { throw new Error('호출되면 안 됨'); }) as unknown as typeof fetch;
    assert.equal(await insertCohortGaps([], CFG, { fetchImpl: f }), 0);
  });
  test('엔드포인트 + 성공', async () => {
    const calls: Array<{ url: string; n: number }> = [];
    const f = (async (u: string, init: RequestInit) => {
      calls.push({ url: u, n: (JSON.parse(String(init.body)) as unknown[]).length });
      return new Response(null, { status: 201 });
    }) as unknown as typeof fetch;
    const n = await insertCohortGaps([GAP, GAP], CFG, { fetchImpl: f });
    assert.equal(n, 2);
    assert.equal(calls[0]!.url, 'https://proj.supabase.co/rest/v1/scanner_cohort_gaps');
    assert.equal(calls[0]!.n, 2);
  });
  test('5xx 재시도 후 성공, 첫 시도 401 은 즉시 실패', async () => {
    let n = 0;
    const flaky = (async () => (++n < 2 ? new Response('x', { status: 503 }) : new Response(null, { status: 201 }))) as unknown as typeof fetch;
    assert.equal(await insertCohortGaps([GAP], CFG, { fetchImpl: flaky, sleep: async () => {} }), 1);
    const dead = (async () => new Response('{"message":"no"}', { status: 401 })) as unknown as typeof fetch;
    await assert.rejects(insertCohortGaps([GAP], CFG, { fetchImpl: dead, sleep: async () => {} }), /HTTP 401/);
  });
});

describe('예비 실행: 오늘 관찰 수', () => {
  test('utcDayStart: UTC 기준 자정 (KST 이른 아침도 전날 UTC)', () => {
    assert.equal(utcDayStart(new Date('2026-10-12T01:17:00Z')), '2026-10-12T00:00:00.000Z');
    assert.equal(utcDayStart(new Date('2026-10-11T23:59:59Z')), '2026-10-11T00:00:00.000Z');
  });
  test('Content-Range 총계를 읽고, 필터·헤더를 보낸다', async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const f = (async (u: string, init: RequestInit) => {
      calls.push({ url: u, headers: init.headers as Record<string, string> });
      return new Response('[]', { status: 200, headers: { 'Content-Range': '0-0/1996' } });
    }) as unknown as typeof fetch;
    assert.equal(await countObservationsSince(CFG, '2026-10-12T00:00:00.000Z', { fetchImpl: f }), 1996);
    const u = new URL(calls[0]!.url);
    assert.equal(u.pathname, '/rest/v1/scanner_observations');
    assert.equal(u.searchParams.get('source'), 'eq.scanner');
    assert.equal(u.searchParams.get('observed_at'), 'gte.2026-10-12T00:00:00.000Z');
    assert.equal(calls[0]!.headers.Prefer, 'count=exact');
  });
  test('0행(*/0)은 0, 오류·총계 없음은 throw', async () => {
    const empty = (async () => new Response('[]', { status: 200, headers: { 'Content-Range': '*/0' } })) as unknown as typeof fetch;
    assert.equal(await countObservationsSince(CFG, 'x', { fetchImpl: empty }), 0);
    const bad = (async () => new Response('x', { status: 500 })) as unknown as typeof fetch;
    await assert.rejects(countObservationsSince(CFG, 'x', { fetchImpl: bad }), /HTTP 500/);
    const noRange = (async () => new Response('[]', { status: 200 })) as unknown as typeof fetch;
    await assert.rejects(countObservationsSince(CFG, 'x', { fetchImpl: noRange }), /content-range/);
  });
});

// ───────────── 고정 코호트 ─────────────
describe('cohort', () => {
  const ids = Array.from({ length: 50 }, (_, i) => `mcp:io.example/server-${i}`);
  test('selectCohort: 입력 순서와 무관하게 결정적, 중복 제거, size 상한', () => {
    const a = selectCohort(ids, 10);
    const b = selectCohort([...ids].reverse(), 10);
    assert.deepEqual(a, b);
    assert.equal(a.length, 10);
    assert.deepEqual(selectCohort([...ids, ...ids], 10), a);
    assert.equal(selectCohort(ids, 1000).length, 50);
    assert.deepEqual(selectCohort([], 5), []);
  });
  test('selectCohort: 새 대상이 끼어들어도 기존 선택은 해시 순서로만 바뀜(그래서 저장이 필요)', () => {
    const before = selectCohort(ids, 10);
    const after = selectCohort([...ids, ...Array.from({ length: 200 }, (_, i) => `mcp:new/s-${i}`)], 10);
    assert.notDeepEqual(before, after); // 확정 저장 없이 매번 상위 N 을 뽑으면 코호트가 흔들린다
  });
  test('fetchCohort: 페이지네이션 + 필터/정렬 + 헤더', async () => {
    const urls: string[] = [];
    const f = (async (u: string, init: RequestInit) => {
      urls.push(u);
      assert.equal((init.headers as Record<string, string>).apikey, 'sb_secret_abc');
      const q = new URL(u).searchParams;
      const off = Number(q.get('offset'));
      const all = ['a', 'b', 'c', 'd', 'e'];
      return new Response(JSON.stringify(all.slice(off, off + 2).map((target_id) => ({ target_id }))), { status: 200 });
    }) as unknown as typeof fetch;
    const out = await fetchCohort(CFG, 'v1', { fetchImpl: f, pageSize: 2 });
    assert.deepEqual(out, ['a', 'b', 'c', 'd', 'e']);
    assert.equal(urls.length, 3);
    const q = new URL(urls[0]!).searchParams;
    assert.equal(q.get('cohort_version'), 'eq.v1');
    assert.equal(q.get('order'), 'target_id.asc');
    assert.equal(new URL(urls[0]!).pathname, '/rest/v1/scanner_cohort');
  });
  test('fetchCohort: 빈 결과는 빈 배열, 오류는 throw(조용히 새 코호트 금지)', async () => {
    const empty = (async () => new Response('[]', { status: 200 })) as unknown as typeof fetch;
    assert.deepEqual(await fetchCohort(CFG, 'v1', { fetchImpl: empty }), []);
    for (const status of [401, 404, 500]) {
      const bad = (async () => new Response('{"message":"x"}', { status })) as unknown as typeof fetch;
      await assert.rejects(fetchCohort(CFG, 'v1', { fetchImpl: bad }), new RegExp(`HTTP ${status}`));
    }
    const net = (async () => {
      throw new Error('boom');
    }) as unknown as typeof fetch;
    await assert.rejects(fetchCohort(CFG, 'v1', { fetchImpl: net }), /network/);
  });
  test('saveCohort: 단일 요청, on_conflict + ignore-duplicates, 재시도', async () => {
    const calls: Array<{ url: string; prefer: string; n: number }> = [];
    let n = 0;
    const f = (async (u: string, init: RequestInit) => {
      n++;
      if (n === 1) return new Response('x', { status: 503 });
      const body = JSON.parse(String(init.body)) as Array<{ cohort_version: string; target_id: string }>;
      calls.push({ url: u, prefer: (init.headers as Record<string, string>).Prefer ?? '', n: body.length });
      assert.equal(body[0]!.cohort_version, 'v1');
      return new Response(null, { status: 201 });
    }) as unknown as typeof fetch;
    await saveCohort(CFG, 'v1', ['a', 'b', 'c'], { fetchImpl: f, sleep: async () => {} });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.n, 3);
    assert.match(calls[0]!.url, /scanner_cohort\?on_conflict=cohort_version,target_id$/);
    assert.match(calls[0]!.prefer, /resolution=ignore-duplicates/);
    const dead = (async () => new Response('{"message":"no"}', { status: 401 })) as unknown as typeof fetch;
    await assert.rejects(saveCohort(CFG, 'v1', ['a'], { fetchImpl: dead, sleep: async () => {} }), /HTTP 401/);
  });
  test('planCohortJobs: 현재 remote 로 작업 생성, registryInfo 없으면 not_in_registry', () => {
    const targets = [
      { name: 'a/x', version: '1.0.0', remotes: [{ type: 'streamable-http', url: 'https://a1.example.com' }, { type: 'streamable-http', url: 'https://a2.example.com' }] },
      { name: 'b/y', version: '2.0.0', remotes: [{ type: 'streamable-http', url: 'https://b.example.com' }] },
      { name: 'z/outside', version: '1.0.0', remotes: [{ type: 'streamable-http', url: 'https://z.example.com' }] },
    ];
    const { jobs, gaps } = planCohortJobs(targets, ['mcp:a/x', 'mcp:gone/server', 'mcp:b/y']);
    assert.deepEqual(jobs.map((j) => `${j.name}#${j.index}:${j.remote.url}`), ['a/x#0:https://a1.example.com', 'a/x#1:https://a2.example.com', 'b/y#0:https://b.example.com']);
    assert.deepEqual(gaps, [{ target_id: 'mcp:gone/server', reason: 'not_in_registry', registry_version: null, registry_status: null }]);
  });
  test('planCohortJobs: 사유별 분류 (no_remote / remote_not_probeable / not_active / not_in_registry)', () => {
    const targets = [{ name: 'a/x', version: '1.0.0', remotes: [{ type: 'streamable-http', url: 'https://a1.example.com' }] }];
    const registryInfo = new Map<string, import('./lib.ts').RegistryGapInfo>([
      ['no-remote/server', { version: '0.22.1', status: 'active', isLatest: true, hasAnyRemotes: false, hasProbeableRemote: false }],
      ['sse-only/server', { version: '1.0.0', status: 'active', isLatest: true, hasAnyRemotes: true, hasProbeableRemote: false }],
      ['deprecated/server', { version: '1.0.0', status: 'deprecated', isLatest: true, hasAnyRemotes: true, hasProbeableRemote: true }],
      ['old-version/server', { version: '0.9.0', status: 'active', isLatest: false, hasAnyRemotes: true, hasProbeableRemote: true }],
    ]);
    const { gaps } = planCohortJobs(
      targets,
      ['mcp:a/x', 'mcp:no-remote/server', 'mcp:sse-only/server', 'mcp:deprecated/server', 'mcp:old-version/server', 'mcp:never-seen/server'],
      registryInfo,
    );
    assert.deepEqual(
      gaps.map((g) => [g.target_id, g.reason]),
      [
        ['mcp:no-remote/server', 'no_remote'],
        ['mcp:sse-only/server', 'remote_not_probeable'],
        ['mcp:deprecated/server', 'not_active'],
        ['mcp:old-version/server', 'not_active'],
        ['mcp:never-seen/server', 'not_in_registry'],
      ],
    );
    assert.deepEqual(gaps[0], { target_id: 'mcp:no-remote/server', reason: 'no_remote', registry_version: '0.22.1', registry_status: 'active' });
  });
});

// ───────────── export / 유틸 ─────────────
describe('export & utils', () => {
  test('monthRanges (UTC, 연도 경계)', () => {
    const r = monthRanges(new Date('2026-01-15T00:00:00Z'), 2);
    assert.deepEqual(r.map((x) => x.label), ['2025-12', '2026-01']);
    assert.equal(r[0]!.start, '2025-12-01T00:00:00.000Z');
    assert.equal(r[0]!.end, '2026-01-01T00:00:00.000Z');
    assert.equal(r[1]!.end, '2026-02-01T00:00:00.000Z');
  });
  test('CSV 이스케이프', () => {
    assert.equal(csvEscape(null), '');
    assert.equal(csvEscape('a,b'), '"a,b"');
    assert.equal(csvEscape('say "hi"'), '"say ""hi"""');
    assert.equal(csvEscape({ k: 'v,1' }), '"{""k"":""v,1""}"');
    const csv = rowsToCsv([{ id: 1, scan_run_id: 'r', node_id: 'n', target_id: 'io.x/y', target_type: 'mcp_server', observed_at: 'now', transport: 'streamable-http', http_status: null, reached_level: 0, latency_ms: 5, error_type: 'dns', source: 'scanner', metadata: { a: 1 } }]);
    assert.equal(csv.split('\n')[0], 'id,scan_run_id,node_id,target_id,target_type,observed_at,transport,http_status,reached_level,latency_ms,error_type,source,metadata');
    assert.equal(csv.split('\n')[1], '1,r,n,io.x/y,mcp_server,now,streamable-http,,0,5,dns,scanner,"{""a"":1}"');
    assert.ok(csv.endsWith('\n'));
  });
  test('fetchMonthRows keyset 페이지네이션', async () => {
    const urls: string[] = [];
    const f = (async (u: string) => {
      urls.push(u);
      const gt = Number(new URL(u).searchParams.get('id')!.replace('gt.', ''));
      const all = [1, 2, 3, 4, 5];
      return new Response(JSON.stringify(all.filter((i) => i > gt).slice(0, 2).map((id) => ({ id }))), { status: 200 });
    }) as unknown as typeof fetch;
    const rows = await fetchMonthRows(CFG, monthRanges(new Date('2026-10-07T00:00:00Z'), 1)[0]!, { fetchImpl: f, pageSize: 2 });
    assert.deepEqual(rows.map((r) => r.id), [1, 2, 3, 4, 5]);
    assert.equal(urls.length, 3);
    const q = new URL(urls[0]!).searchParams;
    assert.deepEqual(q.getAll('observed_at'), ['gte.2026-10-01T00:00:00.000Z', 'lt.2026-11-01T00:00:00.000Z']);
  });
  test('runPool 동시성 상한과 순서 보존', async () => {
    let active = 0;
    let peak = 0;
    const out = await runPool([1, 2, 3, 4, 5, 6, 7], 3, async (x) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 10));
      active--;
      return x * 2;
    });
    assert.deepEqual(out, [2, 4, 6, 8, 10, 12, 14]);
    assert.ok(peak <= 3);
    assert.deepEqual(await runPool([], 3, async (x) => x), []);
  });
});

// ───────────── 직후 재시도 ─────────────
describe('직후 재시도', () => {
  test('재시도 대상: 일시적 연결 실패와 408/429/5xx 만', () => {
    for (const e of ['timeout', 'conn_reset', 'conn_refused', 'network_error']) {
      assert.equal(isRetryable({ error_type: e, http_status: null }), true, e);
    }
    // tools/list 타임아웃(level 1)도 error_type=timeout 이라 포함
    assert.equal(isRetryable({ error_type: 'timeout', http_status: 200 }), true);
    for (const e of ['dns', 'tls', 'blocked_url', 'invalid_response']) {
      assert.equal(isRetryable({ error_type: e, http_status: null }), false, e);
    }
    for (const s of [408, 429, 500, 502, 503, 521, 530]) assert.equal(isRetryable({ error_type: null, http_status: s }), true, String(s));
    for (const s of [200, 301, 400, 401, 403, 404, 405, 410]) assert.equal(isRetryable({ error_type: null, http_status: s }), false, String(s));
    assert.equal(isRetryable({ error_type: null, http_status: null }), false);
  });

  test('hostOf', () => {
    assert.equal(hostOf('https://Gateway.Pipeworx.io/moralis/mcp'), 'gateway.pipeworx.io');
    assert.equal(hostOf('https://a.example:8443/x'), 'a.example:8443');
    assert.equal(hostOf('not a url'), 'not a url');
  });

  test('호스트당 동시 1건, 호스트 간 병렬, 전부 처리', async () => {
    const items = ['a1', 'a2', 'a3', 'b1', 'b2', 'c1'];
    const active = new Map<string, number>();
    let maxPerHost = 0;
    let maxTotal = 0;
    let total = 0;
    const { results, skipped } = await runPerHostRoundRobin(items, (s) => s[0] as string, 8, async (s) => {
      const h = s[0] as string;
      active.set(h, (active.get(h) ?? 0) + 1);
      total++;
      maxPerHost = Math.max(maxPerHost, active.get(h) as number);
      maxTotal = Math.max(maxTotal, total);
      await new Promise((r) => setTimeout(r, 5));
      active.set(h, (active.get(h) as number) - 1);
      total--;
      return s.toUpperCase();
    });
    assert.equal(maxPerHost, 1);
    assert.equal(maxTotal, 3); // 호스트 3개 → 최대 3건 동시
    assert.deepEqual(results.map((r) => r.result).sort(), items.map((s) => s.toUpperCase()).sort());
    assert.deepEqual(skipped, []);
  });

  test('호스트를 번갈아 처리 (concurrency 1)', async () => {
    const order: string[] = [];
    await runPerHostRoundRobin(['a1', 'a2', 'a3', 'b1', 'b2'], (s) => s[0] as string, 1, async (s) => {
      order.push(s);
    });
    assert.deepEqual(order, ['a1', 'b1', 'a2', 'b2', 'a3']);
  });

  test('시간 예산 이후에는 새 항목을 시작하지 않음', async () => {
    let t = 0;
    const { results, skipped } = await runPerHostRoundRobin(
      ['a1', 'a2', 'a3', 'b1'],
      (s) => s[0] as string,
      1,
      async (s) => {
        t += 10;
        return s;
      },
      { deadline: 20, now: () => t },
    );
    assert.deepEqual(results.map((r) => r.item), ['a1', 'b1']);
    assert.deepEqual(skipped.sort(), ['a2', 'a3']);
  });

  test('onResult: 항목마다 호출, 호스트를 놓은 뒤 호출', async () => {
    const seen: string[] = [];
    let running = 0;
    const { results } = await runPerHostRoundRobin(
      ['a1', 'a2', 'b1'],
      (s) => s[0] as string,
      2,
      async (s) => {
        running++;
        await new Promise((r) => setTimeout(r, 2));
        running--;
        return s.toUpperCase();
      },
      {
        onResult: async (item, result) => {
          seen.push(`${item}:${result}`);
          await new Promise((r) => setTimeout(r, 5)); // 저장이 느려도 전부 처리
        },
      },
    );
    assert.equal(results.length, 3);
    assert.deepEqual(seen.sort(), ['a1:A1', 'a2:A2', 'b1:B1']);
  });

  test('onResult 가 throw 하면 reject', async () => {
    await assert.rejects(
      runPerHostRoundRobin(['a1', 'b1'], (s) => s[0] as string, 1, async (s) => s, {
        onResult: () => {
          throw new Error('insert failed');
        },
      }),
      /insert failed/,
    );
  });

  test('빈 목록', async () => {
    const r = await runPerHostRoundRobin([], () => 'x', 4, async () => 1);
    assert.deepEqual(r, { results: [], skipped: [] });
  });

  const retry: RetryInfo = { retried_at: '2026-10-12T01:30:00.000Z', reached_level: 2, http_status: 200, error_type: null, latency_ms: 300, per_host_concurrency: 1 };
  const key = { scan_run_id: '00000000-0000-0000-0000-000000000001', target_id: 'mcp:io.github.x/y', remote_url: 'https://h.example/mcp' };

  test('attachRetry: RPC 호출 형식과 결과', async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen = { url, init };
      return new Response('true', { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as unknown as typeof fetch;
    const ok = await attachRetry({ url: 'https://db.example/', key: 'sb_secret_x' }, key, retry, { fetchImpl });
    assert.equal(ok, true);
    assert.ok(seen);
    const s = seen as { url: string; init: RequestInit };
    assert.equal(s.url, 'https://db.example/rest/v1/rpc/scanner_attach_retry');
    assert.equal(s.init.method, 'POST');
    assert.deepEqual(JSON.parse(String(s.init.body)), { p_run: key.scan_run_id, p_target: key.target_id, p_remote_url: key.remote_url, p_retry: retry });
    assert.equal((s.init.headers as Record<string, string>).apikey, 'sb_secret_x');
  });

  test('attachRetry: 이미 retry 가 있으면 false', async () => {
    const fetchImpl = (async () => new Response('false', { status: 200 })) as unknown as typeof fetch;
    assert.equal(await attachRetry({ url: 'https://db.example', key: 'sb_secret_x' }, key, retry, { fetchImpl }), false);
  });

  test('attachRetry: 5xx 는 재시도 후 성공, 4xx 는 즉시 실패', async () => {
    let n = 0;
    const flaky = (async () => (++n < 2 ? new Response('x', { status: 503 }) : new Response('true', { status: 200 }))) as unknown as typeof fetch;
    assert.equal(await attachRetry({ url: 'https://db.example', key: 'k' }, key, retry, { fetchImpl: flaky, sleep: async () => {} }), true);
    assert.equal(n, 2);
    let m = 0;
    const denied = (async () => {
      m++;
      return new Response('{"message":"permission denied"}', { status: 401 });
    }) as unknown as typeof fetch;
    await assert.rejects(attachRetry({ url: 'https://db.example', key: 'k' }, key, retry, { fetchImpl: denied, sleep: async () => {} }), /HTTP 401/);
    assert.equal(m, 1);
  });
});

// ───────────── Registry 장애 대비 ─────────────
describe('Registry 장애 대비', () => {
  test('페이지 재시도 6회, 대기 2·4·8·16·32초', async () => {
    let n = 0;
    const waits: number[] = [];
    const dead = (async () => {
      n++;
      throw new Error('net');
    }) as unknown as typeof fetch;
    await assert.rejects(
      fetchRegistryTargets({ fetchImpl: dead, sleep: async (ms) => void waits.push(ms) }),
      /page 1 failed \(HTTP network\)/,
    );
    assert.equal(n, 6);
    assert.deepEqual(waits, [2000, 4000, 8000, 16000, 32000]);
  });

  test('시간 상한을 넘기면 다음 페이지를 요청하지 않고 실패', async () => {
    let calls = 0;
    let t = 0;
    const f = (async () => {
      calls++;
      t += 100;
      return new Response(JSON.stringify({ servers: [{ server: { name: `x/${calls}`, version: '1' } }], metadata: { nextCursor: `c${calls}` } }), { status: 200 });
    }) as unknown as typeof fetch;
    await assert.rejects(fetchRegistryTargets({ fetchImpl: f, sleep: async () => {}, deadline: 250, now: () => t }), /time budget exceeded after 3 pages/);
    assert.equal(calls, 3);
  });

  test('시간 상한을 넘길 재시도 대기는 하지 않음', async () => {
    let n = 0;
    const waits: number[] = [];
    const dead = (async () => {
      n++;
      return new Response('x', { status: 503 });
    }) as unknown as typeof fetch;
    await assert.rejects(
      fetchRegistryTargets({ fetchImpl: dead, sleep: async (ms) => void waits.push(ms), deadline: 5000, now: () => 0 }),
      /HTTP 503/,
    );
    assert.deepEqual(waits, [2000, 4000]); // 8초 대기는 상한(5초)을 넘으므로 하지 않고 실패
    assert.equal(n, 3);
  });

  const FB_CFG = { url: 'https://db.example/', key: 'sb_secret_x' };
  const RUN = '00000000-0000-0000-0000-0000000000aa';
  function fbRows(n: number) {
    const rows: Array<Record<string, unknown>> = [];
    for (let i = 1; i <= n; i++) {
      rows.push({
        id: i,
        target_id: `mcp:io.github.t/s${i}`,
        transport: 'streamable-http',
        observed_at: `2026-10-11T23:0${i % 10}:00Z`,
        metadata: { remote_url: `https://h${i}.example/mcp`, remote_index: 0, registry_version: `1.${i}` },
      });
    }
    return rows;
  }
  function fbFetch(rows: Array<Record<string, unknown>>, seen: string[] = []) {
    return (async (url: string) => {
      seen.push(url);
      const u = new URL(url);
      if (u.searchParams.get('order') === 'id.desc') {
        return new Response(JSON.stringify(rows.length ? [{ scan_run_id: RUN, observed_at: '2026-10-11T23:02:00Z' }] : []), { status: 200 });
      }
      const gt = Number((u.searchParams.get('id') ?? 'gt.0').slice(3));
      const limit = Number(u.searchParams.get('limit'));
      return new Response(JSON.stringify(rows.filter((r) => Number(r.id) > gt).slice(0, limit)), { status: 200 });
    }) as unknown as typeof fetch;
  }

  test('fetchFallbackJobs: 직전 실행 행으로 작업 목록, 페이지네이션, 중복·코호트 밖 제외', async () => {
    const rows = fbRows(5);
    rows.push({ ...rows[0], id: 6 }); // 같은 대상·주소 중복
    rows.push({ id: 7, target_id: 'mcp:outside/x', transport: 'streamable-http', observed_at: '2026-10-11T23:09:00Z', metadata: { remote_url: 'https://o.example/mcp' } });
    rows.push({ id: 8, target_id: 'mcp:io.github.t/s1', transport: 'streamable-http', observed_at: '2026-10-11T23:09:30Z', metadata: {} }); // 주소 없음
    const seen: string[] = [];
    const cohortIds = rows.slice(0, 5).map((r) => String(r.target_id)).concat(['mcp:io.github.t/s1']);
    const fb = await fetchFallbackJobs(FB_CFG, { minRows: 4, cohortIds }, { fetchImpl: fbFetch(rows, seen), pageSize: 3 });
    assert.equal(fb.sourceRunId, RUN);
    assert.equal(fb.sourceRows, 8);
    assert.equal(fb.jobs.length, 5);
    assert.deepEqual(fb.jobs[0], { name: 'io.github.t/s1', version: '1.1', remote: { type: 'streamable-http', url: 'https://h1.example/mcp' }, index: 0 });
    assert.ok(seen.some((u) => u.includes('scan_run_id=eq.' + RUN) && u.includes('id=gt.3')), 'keyset 페이지네이션');
    assert.ok(seen.every((u) => u.startsWith('https://db.example/rest/v1/scanner_observations?')));
  });

  test('fetchFallbackJobs: 직전 실행이 부분 실행이거나 관찰이 없으면 대체하지 않음', async () => {
    await assert.rejects(fetchFallbackJobs(FB_CFG, { minRows: 10 }, { fetchImpl: fbFetch(fbRows(3)) }), /only 3 rows/);
    await assert.rejects(fetchFallbackJobs(FB_CFG, { minRows: 1 }, { fetchImpl: fbFetch([]) }), /no previous observations/);
    const err = (async () => new Response('x', { status: 503 })) as unknown as typeof fetch;
    await assert.rejects(fetchFallbackJobs(FB_CFG, { minRows: 1 }, { fetchImpl: err }), /HTTP 503/);
  });
});

describe('scanner 버전 정보', () => {
  test('GITHUB_SHA 40자 → 앞 12자(소문자)', () => {
    assert.equal(scannerCommit('0123456789ABCDEF0123456789abcdef01234567'), '0123456789ab');
  });
  test('없거나 형식이 아니면 null (로컬 실행)', () => {
    assert.equal(scannerCommit(undefined), null);
    assert.equal(scannerCommit(''), null);
    assert.equal(scannerCommit('abc123'), null);
    assert.equal(scannerCommit('g'.repeat(40)), null);
  });
  test('probe 메타데이터에 현재 SCANNER_VERSION 기록', async () => {
    const r = await probeRemote({ type: 'streamable-http', url: 'https://example.com/mcp' }, { registryVersion: '1.0.0', index: 0 }, async () => {
      throw new TransportError('timeout', 'timeout');
    });
    assert.equal(r.metadata.scanner_version, SCANNER_VERSION);
  });
});

describe('확장 코호트 (v2 = v1 전부 + 추가분)', () => {
  const ids = Array.from({ length: 50 }, (_, i) => `mcp:io.example/s${i}`);
  test('base 전부 포함, 추가분은 base 밖에서 SHA-256 순서, 총 size 개', () => {
    const base = selectCohort(ids, 10);
    const v2 = extendCohort(base, ids, 25);
    assert.equal(v2.length, 25);
    assert.equal(new Set(v2).size, 25);
    for (const id of base) assert.ok(v2.includes(id));
    assert.deepEqual(v2.slice(10), selectCohort(ids.filter((id) => !base.includes(id)), 15));
  });
  test('Registry 에서 사라진 base 멤버도 유지', () => {
    const base = ['mcp:gone/one', ...selectCohort(ids, 4)];
    const v2 = extendCohort(base, ids, 10);
    assert.ok(v2.includes('mcp:gone/one'));
    assert.equal(v2.length, 10);
  });
  test('후보 순서와 무관하게 결정적', () => {
    const base = selectCohort(ids, 5);
    assert.deepEqual(extendCohort(base, ids, 20), extendCohort(base, [...ids].reverse(), 20));
  });
  test('빈 base, base > size 는 실패', () => {
    assert.throws(() => extendCohort([], ids, 10));
    assert.throws(() => extendCohort(ids, ids, 10));
  });
  test('topHosts: 호스트별 개수 내림차순, 잘못된 URL 은 invalid', () => {
    const r = topHosts(['https://a.com/1', 'https://b.com/x', 'https://a.com/2', 'not a url'], 2);
    assert.deepEqual(r, [['a.com', 2], ['b.com', 1]]);
    assert.deepEqual(topHosts(['nope'], 5), [['invalid', 1]]);
  });
});

describe('호스트 상한 코호트', () => {
  // 후보 60개: spam.host 에 30개, 나머지는 각자 다른 호스트
  const ids = Array.from({ length: 60 }, (_, i) => `mcp:io.example/s${i}`);
  const hostsOf = new Map<string, string[]>(ids.map((id, i) => [id, [i < 30 ? 'spam.host' : `h${i}.example.com`]]));
  test('capHost: 소문자, 포트 제외, 끝 점 제거, 공용 도메인 하위는 별개, 잘못된 URL 은 null', () => {
    assert.equal(capHost('https://API.Example.com:8443/mcp'), 'api.example.com');
    assert.equal(capHost('https://a.example.com./mcp'), 'a.example.com');
    assert.notEqual(capHost('https://a.workers.dev/x'), capHost('https://b.workers.dev/x'));
    assert.equal(capHost('not a url'), null);
  });
  test('cap 0 은 extendCohort 와 같은 결과', () => {
    const base = selectCohort(ids, 10);
    assert.deepEqual(extendCohortCapped(base, ids, 40, 0, hostsOf).ids, extendCohort(base, ids, 40));
  });
  test('base 멤버를 할당량에 먼저 센다: base 에 이미 cap 이상이면 추가분에서 0개', () => {
    const base = ids.slice(0, 5); // spam.host 5개
    const r = extendCohortCapped(base, ids, 30, 3, hostsOf);
    const spamExtras = r.ids.slice(5).filter((id) => hostsOf.get(id)?.[0] === 'spam.host');
    assert.equal(spamExtras.length, 0);
    assert.equal(r.ids.length, 30);
    assert.equal(r.shortfall, 0);
  });
  test('상한 때문에 못 채우면 shortfall 로 남기고 넘겨 채우지 않는다', () => {
    const base = ids.slice(30, 31);
    const r = extendCohortCapped(base, ids, 60, 1, hostsOf);
    assert.equal(r.added, 30); // spam 1 + 나머지 29
    assert.equal(r.shortfall, 29);
    assert.ok(r.skippedByCap > 0);
  });
  test('원격이 여러 호스트면 각 호스트에 1씩, 하나라도 꽉 차면 건너뜀', () => {
    const m = new Map<string, string[]>([
      ['mcp:a', ['x.com']],
      ['mcp:b', ['x.com', 'y.com']],
      ['mcp:c', ['y.com']],
    ]);
    const r = extendCohortCapped(['mcp:a'], ['mcp:a', 'mcp:b', 'mcp:c'], 3, 1, m);
    assert.ok(!r.ids.includes('mcp:b'));
    assert.ok(r.ids.includes('mcp:c'));
  });
  test('결정적: 후보 순서와 무관', () => {
    const base = selectCohort(ids, 5);
    assert.deepEqual(extendCohortCapped(base, ids, 25, 2, hostsOf).ids, extendCohortCapped(base, [...ids].reverse(), 25, 2, hostsOf).ids);
  });
  test('hostConcentration: 고유 호스트, 상위 비중', () => {
    const c = hostConcentration(ids, hostsOf, 2);
    assert.equal(c.uniqueHosts, 31);
    assert.equal(c.withHosts, 60);
    assert.equal(c.top[0]?.[0], 'spam.host');
    assert.equal(c.top1Share, 0.5);
  });
});
