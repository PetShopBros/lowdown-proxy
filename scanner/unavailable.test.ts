import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';

// DB 오류를 "데이터 없음"(200)으로 답하지 않는다 — 2026-10-25 DB 포화 때 수집기가 빈 답을 받아 간 일 때문.
type Mod = {
  default: (req: unknown, res: unknown) => Promise<unknown>;
  coreUnavailable: (f: { summaryError: boolean; scannerFailed: boolean; registryFailed: boolean }) => boolean;
  RETRY_AFTER_SECONDS: number;
  UNAVAILABLE_BODY: Record<string, unknown>;
};
const load = async () => (await import('../api/reputation/[target].ts' as string)) as Mod;

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** PostgREST 흉내: failing 에 든 테이블은 500, 나머지는 빈 배열. 쓰기(POST)는 201. 기록된 조회 행을 돌려준다. */
function fakeDb(failing: string[]) {
  const inserted: Array<Record<string, unknown>> = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const method = (init?.method ?? 'GET').toUpperCase();
    const table = /\/rest\/v1\/([a-z_]+)/.exec(url)?.[1] ?? '';
    if (method === 'POST') {
      if (table === 'reputation_lookups' && typeof init?.body === 'string') inserted.push(JSON.parse(init.body));
      return new Response(null, { status: 201 });
    }
    if (failing.includes(table)) {
      return new Response(JSON.stringify({ message: 'canceling statement due to statement timeout', code: '57014' }), { status: 500, headers: { 'content-type': 'application/json' } });
    }
    return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return inserted;
}

function fakeRes() {
  const r = {
    code: 0,
    headers: {} as Record<string, string>,
    body: undefined as unknown,
    setHeader(k: string, v: string) { r.headers[k.toLowerCase()] = v; return r; },
    status(c: number) { r.code = c; return r; },
    json(b: unknown) { r.body = b; return r; },
    end() { return r; },
  };
  return r;
}

async function call(target: string) {
  process.env.LOWDOWN_SUPABASE_URL = 'https://db.example.test';
  process.env.LOWDOWN_SUPABASE_KEY = 'test-key';
  process.env.LOWDOWN_PAGES_INDEX_URL = 'https://pages.example.test/servers.json';
  const { default: handler } = await load();
  const res = fakeRes();
  await handler({ method: 'GET', query: { target }, headers: { 'user-agent': 'ClaudeBot/1.0' } }, res);
  return res;
}

describe('핵심 조회 실패 → 503', () => {
  test('판정 표: 하나라도 실패하면 true, 모두 정상이면 false', async () => {
    const { coreUnavailable } = await load();
    assert.equal(coreUnavailable({ summaryError: false, scannerFailed: false, registryFailed: false }), false);
    assert.equal(coreUnavailable({ summaryError: true, scannerFailed: false, registryFailed: false }), true);
    assert.equal(coreUnavailable({ summaryError: false, scannerFailed: true, registryFailed: false }), true);
    assert.equal(coreUnavailable({ summaryError: false, scannerFailed: false, registryFailed: true }), true);
  });

  test('Registry 조회 오류 → 503, Retry-After, 조회 기록은 unavailable', async () => {
    const inserted = fakeDb(['registry_state']);
    const { RETRY_AFTER_SECONDS, UNAVAILABLE_BODY } = await load();
    const res = await call('mcp:io.github.user/server');
    assert.equal(res.code, 503);
    assert.equal(res.headers['retry-after'], String(RETRY_AFTER_SECONDS));
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.deepEqual(res.body, UNAVAILABLE_BODY);
    assert.equal(inserted[0]?.result_kind, 'unavailable');
  });

  test('Scanner 조회 오류 → 503', async () => {
    fakeDb(['scanner_summary']);
    const res = await call('mcp:io.github.user/server');
    assert.equal(res.code, 503);
  });

  test('평판 집계 오류 → 503', async () => {
    fakeDb(['reputation_summary']);
    const res = await call('mcp:io.github.user/server');
    assert.equal(res.code, 503);
  });

  test('오류 없이 조회했는데 없음 → 200, 관찰 없음이라고 답한다(장애와 구분)', async () => {
    const inserted = fakeDb([]);
    const res = await call('mcp:io.github.user/server');
    assert.equal(res.code, 200);
    const body = res.body as Record<string, any>;
    assert.equal(body.scanner?.observed, false);
    assert.notEqual(inserted[0]?.result_kind, 'unavailable');
  });

  test('보조 조회(npm 상태) 오류는 503 이 아니다', async () => {
    fakeDb(['npm_package_state', 'pypi_package_state', 'sandbox_summary']);
    const res = await call('mcp:io.github.user/server');
    assert.equal(res.code, 200);
  });
});
