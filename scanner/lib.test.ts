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
  canonicalJson,
  classifyNetworkError,
  csvEscape,
  extractRpcMessage,
  fetchMonthRows,
  fetchRegistryTargets,
  hashTools,
  httpsPost,
  insertObservations,
  isBlockedIp,
  monthRanges,
  parseSafeUrl,
  probeRemote,
  rowsToCsv,
  runPool,
  supabaseHeaders,
  TransportError,
} from './lib.ts';
import type { ObservationRow, PostFn, PostResult } from './lib.ts';

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
    const { targets, stats } = await fetchRegistryTargets({ fetchImpl: mockRegistry(pages, seen), sleep: async () => {} });
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
