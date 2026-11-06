import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

// 응답 스키마 v1 (2026-11-05): 오류 공통 형식, 재시도 정보(헤더 = 본문), 내부 오류 문구 차단, 근거 수준, schema_version.
const rep = (await import('../api/reputation/[target].ts' as string)) as any;
const find = (await import('../api/find.ts' as string)) as any;
const inter = (await import('../api/interactions.ts' as string)) as any;
const fb = (await import('../api/feedback.ts' as string)) as any;
const status = (await import('../api/status.ts' as string)) as any;
const mcp = (await import('../api/mcp.ts' as string)) as any;

type Out = { status?: number; headers: Record<string, string>; body?: any };
function fakeRes(): { res: any; out: Out } {
  const out: Out = { headers: {} };
  const res: any = {
    setHeader: (k: string, v: string) => { out.headers[k.toLowerCase()] = String(v); },
    getHeader: (k: string) => out.headers[k.toLowerCase()],
    status: (c: number) => { out.status = c; return res; },
    json: (b: unknown) => { out.body = b; return res; },
    send: (b: unknown) => { out.body = typeof b === 'string' ? JSON.parse(b) : b; return res; },
    end: () => res,
  };
  return { res, out };
}
const call = async (h: any, req: Record<string, unknown>) => {
  const { res, out } = fakeRes();
  await h({ headers: {}, query: {}, ...req }, res);
  return out;
};

/** 표준 오류 모양 검사: error 코드, message 문장, retryable, 429·503 은 Retry-After 헤더 = retry_after_seconds */
function assertError(out: Out, httpStatus: number, code: string) {
  assert.equal(out.status, httpStatus, JSON.stringify(out.body));
  assert.equal(out.body.error, code);
  assert.match(out.body.error, /^[a-z][a-z_]*$/);
  assert.equal(typeof out.body.message, 'string');
  assert.ok(out.body.message.length > 0);
  const retryable = httpStatus === 429 || httpStatus === 503;
  assert.equal(out.body.retryable, retryable);
  if (retryable) {
    assert.equal(typeof out.body.retry_after_seconds, 'number');
    assert.equal(out.headers['retry-after'], String(out.body.retry_after_seconds));
  } else assert.equal(out.body.retry_after_seconds, undefined);
}

const env = { u: process.env.LOWDOWN_SUPABASE_URL, k: process.env.LOWDOWN_SUPABASE_KEY };
const realFetch = globalThis.fetch;
after(() => {
  globalThis.fetch = realFetch;
  if (env.u === undefined) delete process.env.LOWDOWN_SUPABASE_URL; else process.env.LOWDOWN_SUPABASE_URL = env.u;
  if (env.k === undefined) delete process.env.LOWDOWN_SUPABASE_KEY; else process.env.LOWDOWN_SUPABASE_KEY = env.k;
});

describe('오류 공통 형식', () => {
  test('405: 모든 API 가 method_not_allowed + Allow 헤더, 예전 문장은 message 에', async () => {
    for (const [h, method, allow] of [
      [rep.default, 'POST', 'GET, OPTIONS'], [find.default, 'POST', 'GET, OPTIONS'], [inter.default, 'PUT', 'GET, POST, OPTIONS'],
      [fb.default, 'PUT', 'GET, POST, OPTIONS'], [status.default, 'POST', 'GET, HEAD, OPTIONS'],
    ] as const) {
      const out = await call(h, { method });
      assertError(out, 405, 'method_not_allowed');
      assert.equal(out.body.message, 'Method not allowed');
      assert.equal(out.headers['allow'], allow);
    }
  });

  test('400: 조회 target 없음 → invalid_parameter(parameter target), 메뉴 오류 코드는 그대로 + message', async () => {
    const t = await call(rep.default, { method: 'GET', query: { target: '' } });
    assertError(t, 400, 'invalid_parameter');
    assert.equal(t.body.parameter, 'target');
    assert.equal(t.body.message, 'target required');
    // 문서의 주소 틀을 그대로 보낸 요청: 400, 조회 기록 없음(DB 를 부르기 전에 끝난다), 고치는 방법 안내
    for (const target of ['mcp:{namespace}/{name}', '{name}', 'mcp:io.github.x/{name}']) {
      const p = await call(rep.default, { method: 'GET', query: { target } });
      assertError(p, 400, 'invalid_parameter');
      assert.equal(p.body.parameter, 'target');
      assert.match(p.body.message, /replace \{namespace\}\/\{name\}/);
    }
    assert.equal(rep.isUnfilledTemplate('mcp:io.github.user/server'), false);
    const m1 = rep.parseMenu('Bad Menu');
    assert.equal(m1.body.error, 'invalid_menu');
    assert.equal(m1.body.retryable, false);
    assert.ok(m1.body.menu_card);
    const m2 = rep.parseMenu('stdio');
    assert.equal(m2.body.error, 'menu_not_available');
    assert.match(m2.body.message, /stdio menu is not available yet/);
    assert.equal(m2.body.what && typeof m2.body.what, 'string');
    assert.equal(rep.parseMenu('nosuch').body.error, 'unknown_menu');
  });

  test('400: 검색 파라미터 → invalid_parameter + 허용 값 유지', () => {
    const p = find.parseFind({ state: 'nope' });
    assert.equal(p.ok, false);
    assert.equal(p.body.error, 'invalid_parameter');
    assert.equal(p.body.parameter, 'state');
    assert.equal(p.body.retryable, false);
    assert.match(p.body.message, /Invalid value for state/);
    assert.ok(p.body.allowed && p.body.parameters);
  });

  test('400: 보고·피드백 본문 오류 → invalid_body, 예전 문장 보존', async () => {
    const a = await call(inter.default, { method: 'POST', body: [] });
    assertError(a, 400, 'invalid_body');
    assert.equal(a.body.message, 'JSON object body required');
    const b = await call(inter.default, { method: 'POST', body: { actor: 'a' } });
    assertError(b, 400, 'invalid_body');
    assert.equal(b.body.message, 'actor, target, target_type, task_type, outcome required');
    const g = await call(inter.default, { method: 'GET', query: {} });
    assertError(g, 400, 'invalid_parameter');
    assert.equal(g.body.message, 'actor required');
    const f = await call(fb.default, { method: 'POST', body: '{bad' });
    assertError(f, 400, 'invalid_body');
    assert.equal(f.body.message, 'body must be JSON');
    assert.ok(f.body.format);
  });
});

describe('재시도 정보: Retry-After 헤더 = retry_after_seconds', () => {
  before(() => { delete process.env.LOWDOWN_SUPABASE_URL; delete process.env.LOWDOWN_SUPABASE_KEY; });

  test('조회 503 본문: 상수 하나에서 나온다, 예전 note 유지', () => {
    assert.equal(rep.UNAVAILABLE_BODY.error, 'temporarily_unavailable');
    assert.equal(rep.UNAVAILABLE_BODY.retryable, true);
    assert.equal(rep.UNAVAILABLE_BODY.retry_after_seconds, rep.RETRY_AFTER_SECONDS);
    assert.equal(rep.UNAVAILABLE_BODY.message, rep.UNAVAILABLE_BODY.note);
  });

  test('검색·피드백·상황판 503', async () => {
    assertError(await call(find.default, { method: 'GET', query: { state: 'answered' } }), 503, 'temporarily_unavailable');
    assertError(await call(fb.default, { method: 'POST', body: { useful: 'yes' } }), 503, 'temporarily_unavailable');
    assertError(await call(status.default, { method: 'GET' }), 503, 'temporarily_unavailable');
  });

  test('피드백 하루 한도는 다음 UTC 자정까지', () => {
    assert.equal(fb.secondsUntilUtcMidnight(Date.parse('2026-11-05T23:00:00Z')), 3600);
    assert.equal(fb.secondsUntilUtcMidnight(Date.parse('2026-11-05T00:00:00Z')), 86400);
  });
});

describe('보고 API: 429 와 내부 오류 문구 차단', () => {
  const body = { actor: 'agent-a', target: 'mcp:a/b', target_type: 'tool', task_type: 'search', outcome: 'success' };
  let mode: 'limit' | 'dberror' = 'limit';
  before(() => {
    process.env.LOWDOWN_SUPABASE_URL = 'https://db.test';
    process.env.LOWDOWN_SUPABASE_KEY = 'k';
    globalThis.fetch = (async (u: any, init?: any) => {
      const method = (init?.method ?? 'GET').toUpperCase();
      if (method === 'HEAD') return new Response(null, { status: 200, headers: { 'content-range': mode === 'limit' ? '*/999' : '*/0' } });
      if (method === 'GET') return new Response(JSON.stringify({ message: 'relation "secret_internal" does not exist', code: '42P01' }), { status: 400, headers: { 'content-type': 'application/json' } });
      return new Response(JSON.stringify({ message: 'duplicate key value violates "secret_internal_pk"', code: '23505', details: 'SECRET' }), { status: 409, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
  });
  after(() => { globalThis.fetch = realFetch; });

  test('분당 한도 → rate_limited, 헤더 60 = 본문 60, 예전 문장 보존', async () => {
    mode = 'limit';
    const out = await call(inter.default, { method: 'POST', body });
    assertError(out, 429, 'rate_limited');
    assert.equal(out.body.retry_after_seconds, 60);
    assert.match(out.body.message, /rate limit: at most \d+ records per minute/);
  });

  test('DB 오류는 internal_error 만, 내부 문구는 응답에 없다', async () => {
    mode = 'dberror';
    const w = await call(inter.default, { method: 'POST', body });
    assertError(w, 500, 'internal_error');
    const r = await call(inter.default, { method: 'GET', query: { actor: 'agent-a' } });
    assertError(r, 500, 'internal_error');
    for (const o of [w, r]) assert.doesNotMatch(JSON.stringify(o.body), /secret|42P01|23505|duplicate|relation/i);
  });
});

describe('근거 수준', () => {
  const base = { target: 'mcp:a/b', message: 'm', source: { name: 'Lowdown' } };
  test('있는 근거만, 순서 고정, 도구 실행 검증은 false, 출처는 맨 끝', () => {
    const b = rep.withEvidence({
      ...base, registry: { listed: true }, status: { state: 'answered' }, packages: [{ type: 'npm' }],
      sandbox: [{ ok: true }], interactions: 5, rated_interactions: 3,
    });
    assert.equal(b.schema_version, 1);
    assert.deepEqual(b.evidence_levels.present, ['registry_declaration', 'protocol_check_without_credentials', 'package_registry_metadata', 'sandbox_protocol_check', 'agent_reported_unverified']);
    assert.deepEqual(b.evidence_levels.tool_execution, { verified_by_lowdown: false, agent_reported_tool_calls: 3 });
    assert.match(b.evidence_levels.note, /does not show that its tools run successfully/);
    const keys = Object.keys(b);
    assert.equal(keys[0], 'schema_version');
    assert.equal(keys.at(-1), 'source');
  });
  test('기록이 없으면 빈 목록, 관측 표본 밖 scanner 는 프로토콜 확인으로 치지 않는다', () => {
    const none = rep.withEvidence({ ...base, interactions: 0, registry: { listed: false }, scanner: { observed: false, note: 'x' } });
    assert.deepEqual(none.evidence_levels.present, []);
    assert.equal(none.evidence_levels.tool_execution.agent_reported_tool_calls, 0);
    // 다시 붙여도 같은 결과(카드 본문에 이미 있어도 새로 계산)
    assert.deepEqual(rep.withEvidence(none), none);
  });
  test('맨 앞 요약: 인증·마지막 응답 날짜, resolved_target 바로 다음', () => {
    const b = rep.withEvidence({
      target: 'gh', resolved_target: 'mcp:a/b', message: 'm',
      status: { state: 'auth_required', latest_check: '2026-11-05', stale: false },
      scanner: { daily_30d: [
        { day: '2026-11-01', reached_level: 2, error_type: null, http_status: 200 },
        { day: '2026-11-05', reached_level: 0, error_type: null, http_status: 401 },
      ] },
      source: { name: 'Lowdown' },
    });
    assert.deepEqual(b.summary, { auth: 'required', auth_basis: 'latest_check', last_answered: '2026-11-01', last_reached: '2026-11-05', latest_check: '2026-11-05', state: 'auth_required' });
    const keys = Object.keys(b);
    assert.equal(keys.indexOf('summary'), keys.indexOf('resolved_target') + 1);
    assert.ok(keys.indexOf('summary') < keys.indexOf('message'));
    assert.equal(rep.applyMenu(b, 'install-check').summary.auth, 'required');
    assert.deepEqual(rep.withEvidence(b), b);
    const stale = rep.withEvidence({ ...base, status: { state: 'answered', latest_check: '2026-10-01', stale: true }, scanner: { daily_30d: [] } });
    assert.equal(stale.summary.auth, 'unknown');
    assert.equal(stale.summary.state, null);
    assert.equal(stale.summary.last_answered_note, 'none_in_30d');
    const unobserved = rep.withEvidence({ ...base, scanner: { observed: false, note: 'x' } });
    assert.equal(unobserved.summary.last_answered_note, 'not_observed');
    assert.equal(rep.withEvidence({ task_type: 'x', message: 'm' }).summary, undefined);
  });
  test('메뉴 응답에도 schema_version·evidence_levels 가 남는다', () => {
    const full = rep.withEvidence({ ...base, registry: { listed: true }, status: { state: 'answered' } });
    const m = rep.applyMenu(full, 'status');
    assert.equal(m.schema_version, 1);
    assert.deepEqual(m.evidence_levels, full.evidence_levels);
  });
});

describe('MCP 도구 오류: isError + REST 와 같은 JSON', () => {
  test('조회 API 의 표준 오류는 그대로 + http_status', () => {
    const e = mcp.upstreamError(503, JSON.stringify(rep.UNAVAILABLE_BODY), 'lookup');
    assert.equal(e.error, 'temporarily_unavailable');
    assert.equal(e.retryable, true);
    assert.equal(e.retry_after_seconds, rep.RETRY_AFTER_SECONDS);
    assert.equal(e.http_status, 503);
    const p = mcp.upstreamError(400, JSON.stringify(find.parseFind({ state: 'x' }).body), 'find');
    assert.equal(p.error, 'invalid_parameter');
    assert.equal(p.retryable, false);
  });
  test('JSON 이 아닌 응답도 같은 모양', () => {
    assert.deepEqual(Object.keys(mcp.upstreamError(502, '<html>', 'lookup')).sort(), ['error', 'http_status', 'message', 'retryable']);
    assert.equal(mcp.upstreamError(502, '<html>', 'lookup').error, 'temporarily_unavailable');
    assert.equal(mcp.upstreamError(404, 'nope', 'lookup').error, 'invalid_parameter');
    const t = mcp.toolError({ error: 'invalid_parameter', message: 'm', retryable: false });
    assert.equal(t.isError, true);
    assert.equal(JSON.parse(t.content[0].text).error, 'invalid_parameter');
  });
  test('도구 정의(이름·설명·입력 스키마)는 바뀌지 않는다', async () => {
    const server = mcp.buildServer({ host: 'h', ua: null });
    const tools = (server as any)._registeredTools ?? {};
    assert.deepEqual(Object.keys(tools).sort(), ['find_servers', 'get_lowdown']);
  });
});
