import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { fetchRecentLookups, pickRequested, registryNameOf, saveRequested, type LookupRef } from './requested-lib.ts';

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
    assert.equal(u.searchParams.get('offset'), '2');
    const bad = (async () => new Response('secret', { status: 500 })) as typeof fetch;
    await assert.rejects(fetchRecentLookups({ url: 'https://db', key: 'k' }, 's', { fetchImpl: bad }), (e: Error) => !e.message.includes('secret'));
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
});
