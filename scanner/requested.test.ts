import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { fetchRecentLookups, fetchRequestedIds, pickRequested, reactivateRequested, registryNameOf, saveRequested, type LookupRef } from './requested-lib.ts';

const L = (target: string, bot_kind: string | null, at = '2026-10-26T01:00:00Z'): LookupRef => ({ target, bot_kind, created_at: at });
const probeable = new Set(['a/x', 'b/y', 'c/z', 'd/w']);

describe('조회된 대상 관찰', () => {
  test('이름 정규화: mcp: 접두 허용, npm:/pypi:/빈 값 제외', () => {
    assert.equal(registryNameOf('mcp:a/x'), 'a/x');
    assert.equal(registryNameOf(' a/x '), 'a/x');
    assert.equal(registryNameOf('npm:foo'), null);
    assert.equal(registryNameOf('PyPI:foo'), null);
    assert.equal(registryNameOf(''), null);
    assert.equal(registryNameOf(5), null);
  });

  test('선정: probe 가능·제외 아님만, 크롤러 아닌 조회 우선, 한도 초과분은 미룸', () => {
    const lookups = [L('a/x', 'crawler'), L('a/x', 'crawler'), L('a/x', 'crawler'), L('b/y', null), L('c/z', 'ai_user'), L('c/z', 'crawler'), L('d/w', 'crawler'), L('unknown/q', null), L('mcp:e/v', null)];
    const r = pickRequested(lookups, { probeable, exclude: new Set(['mcp:d/w']), dailyCap: 2, remaining: 10 });
    assert.deepEqual(r.picks.map((p) => p.target_id), ['mcp:c/z', 'mcp:b/y']); // 둘 다 크롤러 아닌 조회 1건 → 전체 조회 많은 c/z 먼저
    assert.equal(r.eligible, 3); // a/x, b/y, c/z
    assert.equal(r.deferred, 1);
    const first = r.picks.find((p) => p.target_id === 'mcp:c/z')!;
    assert.equal(first.first_lookups, 2);
  });

  test('남은 자리가 0이면 아무것도 새로 넣지 않는다, 같은 입력은 같은 결과(순서 무관)', () => {
    const lookups = [L('a/x', null), L('b/y', null)];
    assert.equal(pickRequested(lookups, { probeable, exclude: new Set(), dailyCap: 5, remaining: 0 }).picks.length, 0);
    const a = pickRequested(lookups, { probeable, exclude: new Set(), dailyCap: 5, remaining: 5 }).picks;
    const b = pickRequested([...lookups].reverse(), { probeable, exclude: new Set(), dailyCap: 5, remaining: 5 }).picks;
    assert.deepEqual(a.map((p) => p.target_id), b.map((p) => p.target_id));
  });

  test('실사용 자리: 전체 상한이 차도 AI 사용자 조회 대상은 별도로 받는다(분류 없음·크롤러는 아님)', () => {
    const lookups = [L('a/x', 'crawler'), L('b/y', null), L('c/z', 'ai_user'), L('d/w', 'ai_user'), L('d/w', 'ai_user')];
    const full = pickRequested(lookups, { probeable, exclude: new Set(), dailyCap: 5, remaining: 0, userDailyCap: 5, userRemaining: 5 });
    assert.deepEqual(full.picks.map((p) => p.target_id), ['mcp:d/w', 'mcp:c/z']); // AI 사용자 조회 많은 순
    assert.equal(full.userPicks, 2);
    assert.equal(full.deferred, 2); // a/x(크롤러), b/y(분류 없음)는 미룸
    // 일반 자리에 이미 든 대상은 실사용 자리를 쓰지 않는다
    const open = pickRequested(lookups, { probeable, exclude: new Set(), dailyCap: 5, remaining: 5, userDailyCap: 5 });
    assert.equal(open.picks.length, 4);
    assert.equal(open.userPicks, 0);
    // 실사용 자리 하루 상한·남은 자리
    assert.equal(pickRequested(lookups, { probeable, exclude: new Set(), dailyCap: 5, remaining: 0, userDailyCap: 1, userRemaining: 5 }).picks.length, 1);
    assert.equal(pickRequested(lookups, { probeable, exclude: new Set(), dailyCap: 5, remaining: 0, userDailyCap: 5, userRemaining: 0 }).picks.length, 0);
    // 옵션이 없으면 예전과 같다(실사용 자리 0)
    assert.equal(pickRequested(lookups, { probeable, exclude: new Set(), dailyCap: 5, remaining: 0 }).picks.length, 0);
  });

  test('일반 자리 닫음(2026-11-22, dailyCap 0): AI 사용자 조회 대상만, 고정 코호트·활성 대상 제외', () => {
    const lookups = [L('a/x', 'ai_user'), L('b/y', 'ai_user'), L('c/z', 'ai_user'), L('c/z', 'ai_user'), L('d/w', null)];
    const r = pickRequested(lookups, { probeable, exclude: new Set(['mcp:a/x', 'mcp:b/y']), dailyCap: 0, remaining: 0, userDailyCap: 100, userRemaining: 998 });
    assert.deepEqual(r.picks.map((p) => p.target_id), ['mcp:c/z']);
    assert.equal(r.userPicks, 1);
    assert.equal(r.picks[0]!.first_bot_kind, 'ai_user');
  });

  test('DB 읽기: result_kind 필터·페이지, 오류에 응답 본문 없음', async () => {
    const urls: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      urls.push(String(input));
      return new Response(JSON.stringify(urls.length === 1 ? [{ target: 'a/x', bot_kind: 'crawler', created_at: 't1' }, { target: 'b/y', bot_kind: null, created_at: 't2' }] : [{ target: 'c/z', bot_kind: null, created_at: 't3' }]), { status: 200 });
    }) as typeof fetch;
    const rows = await fetchRecentLookups({ url: 'https://db', key: 'k' }, '2026-10-24T00:00:00Z', { fetchImpl, pageSize: 2 });
    assert.equal(rows.length, 3);
    const u = new URL(urls[1]!);
    assert.equal(u.searchParams.get('result_kind'), 'eq.registry_only');
    assert.equal(u.searchParams.get('bot_kind'), null);
    assert.equal(u.searchParams.get('offset'), '2');
    const bad = (async () => new Response('secret', { status: 500 })) as typeof fetch;
    await assert.rejects(fetchRecentLookups({ url: 'https://db', key: 'k' }, 's', { fetchImpl: bad }), (e: Error) => !e.message.includes('secret'));
  });

  test('DB 읽기 aiUserOnly: AI 사용자만, registry_only·observed 둘 다, 기간 필터 유지', async () => {
    const urls: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      urls.push(String(input));
      return new Response(JSON.stringify([{ target: 'mcp:c/z', bot_kind: 'ai_user', created_at: 't1' }]), { status: 200 });
    }) as typeof fetch;
    const rows = await fetchRecentLookups({ url: 'https://db', key: 'k' }, '2026-11-20T00:00:00Z', { fetchImpl }, { aiUserOnly: true });
    assert.equal(rows.length, 1);
    const u = new URL(urls[0]!);
    assert.equal(u.searchParams.get('result_kind'), 'in.(registry_only,observed)');
    assert.equal(u.searchParams.get('bot_kind'), 'eq.ai_user');
    assert.equal(u.searchParams.get('created_at'), 'gte.2026-11-20T00:00:00Z');
  });

  test('활성 목록: 은퇴한 행(retired_at 있음)은 읽지 않는다, 페이지 읽기', async () => {
    const urls: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      urls.push(String(input));
      return new Response(JSON.stringify(urls.length === 1 ? [{ target_id: 'mcp:a/x' }, { target_id: 'mcp:b/y' }] : [{ target_id: 'mcp:c/z' }]), { status: 200 });
    }) as typeof fetch;
    const ids = await fetchRequestedIds({ url: 'https://db', key: 'k' }, { fetchImpl, pageSize: 2 });
    assert.deepEqual(ids, ['mcp:a/x', 'mcp:b/y', 'mcp:c/z']);
    for (const s of urls) assert.equal(new URL(s).searchParams.get('retired_at'), 'is.null');
    const bad = (async () => new Response('secret', { status: 500 })) as typeof fetch;
    await assert.rejects(fetchRequestedIds({ url: 'https://db', key: 'k' }, { fetchImpl: bad }), (e: Error) => !e.message.includes('secret'));
  });

  test('저장: 중복 무시 헤더, 5xx 는 재시도', async () => {
    let calls = 0;
    let prefer = '';
    const fetchImpl = (async (_u: string | URL | Request, init?: RequestInit) => {
      calls++;
      prefer = String((init?.headers as Record<string, string>).Prefer);
      return new Response('', { status: calls === 1 ? 503 : 201 });
    }) as typeof fetch;
    const n = await saveRequested({ url: 'https://db', key: 'sb_k' }, [{ target_id: 'mcp:a/x', first_bot_kind: null, first_lookups: 1 }], { fetchImpl, sleep: async () => {} });
    assert.equal(n, 1);
    assert.equal(calls, 2);
    assert.match(prefer, /ignore-duplicates/);
    assert.equal(await saveRequested({ url: 'u', key: 'k' }, [], { fetchImpl }), 0);
  });

  test('되살리기: 은퇴한 행만(PATCH, retired_at=not.is.null), first_* 는 보내지 않음, 형식 아닌 id 제외, 50개씩', async () => {
    const calls: Array<{ url: URL; method: string; body: Record<string, unknown> }> = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      calls.push({ url, method: String(init?.method), body: JSON.parse(String(init?.body)) });
      const n = (url.searchParams.get('target_id')!.match(/"/g) ?? []).length / 2;
      return new Response(JSON.stringify(Array.from({ length: Math.min(n, 2) }, (_, i) => ({ target_id: `x${i}` }))), { status: 200 });
    }) as typeof fetch;
    const ids = [...Array.from({ length: 60 }, (_, i) => `mcp:ns/s${String(i).padStart(2, '0')}`), 'mcp:bad"id', 'npm:foo', 'mcp:ns/s00'];
    const n = await reactivateRequested({ url: 'https://db', key: 'k' }, ids, { fetchImpl, sleep: async () => {} });
    assert.equal(calls.length, 2); // 60개 → 50 + 10
    assert.equal(n, 4); // 시험용 응답: 요청마다 2행
    for (const c of calls) {
      assert.equal(c.method, 'PATCH');
      assert.equal(c.url.searchParams.get('retired_at'), 'not.is.null');
      assert.deepEqual(Object.keys(c.body).sort(), ['reactivated_at', 'retired_at']);
      assert.equal(c.body.retired_at, null);
      assert.ok(!c.url.searchParams.get('target_id')!.includes('bad'));
    }
    assert.match(calls[0]!.url.searchParams.get('target_id')!, /^in\.\("mcp:ns\/s00","mcp:ns\/s01",/);
    assert.equal(await reactivateRequested({ url: 'u', key: 'k' }, ['npm:x'], { fetchImpl }), 0);
    const bad = (async () => new Response('secret', { status: 400 })) as typeof fetch;
    await assert.rejects(reactivateRequested({ url: 'https://db', key: 'k' }, ['mcp:a/x'], { fetchImpl: bad }), (e: Error) => !e.message.includes('secret'));
  });
});
