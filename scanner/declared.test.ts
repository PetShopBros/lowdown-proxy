import { test } from 'node:test';
import assert from 'node:assert/strict';
import { endpointTargetId, fetchDeclaredTargets, normEndpoint, pickDeclared, type DeclaredTarget } from './declared-lib.ts';

const t = (url: string, at: string | null = '2026-11-05T00:00:00Z', extra: Partial<DeclaredTarget> = {}): DeclaredTarget => ({
  url,
  host: null,
  probeable: true,
  sources: ['erc8004_registration'],
  first_declared_at: at,
  ...extra,
});

test('normEndpoint: DB 규칙과 같다', () => {
  assert.equal(normEndpoint('HTTPS://Example.COM:443/mcp/'), 'https://example.com/mcp');
  assert.equal(normEndpoint('https://a.io/mcp?key=1#x'), 'https://a.io/mcp');
  assert.equal(normEndpoint('http://a.io:80/'), 'http://a.io');
  assert.equal(normEndpoint('https://u:p@a.io/mcp'), null);
  assert.equal(normEndpoint('ipfs://abc'), null);
  assert.equal(normEndpoint('not a url'), null);
});

test('endpointTargetId', () => {
  assert.equal(endpointTargetId('https://a.io/mcp'), 'endpoint:https://a.io/mcp');
});

test('pickDeclared: 먼저 선언된 순, 이미 보는 주소·중복·관찰 불가 제외', () => {
  const r = pickDeclared(
    [
      t('https://b.io/mcp', '2026-11-05T02:00:00Z'),
      t('https://a.io/mcp', '2026-11-05T01:00:00Z'),
      t('https://A.io/mcp/', '2026-11-05T03:00:00Z'), // 같은 주소
      t('https://c.io/mcp', '2026-11-05T00:30:00Z'),
      t('http://d.io/mcp'), // https 아님
      t('https://e.io/mcp', null, { probeable: false }),
    ],
    { excludeUrls: new Set(['https://c.io/mcp']), dailyCap: 10, hostCap: 5 },
  );
  assert.deepEqual(r.picks.map((p) => p.url), ['https://a.io/mcp', 'https://b.io/mcp']);
  assert.equal(r.picks[0]?.target_id, 'endpoint:https://a.io/mcp');
  assert.equal(r.alreadyObserved, 1);
  assert.equal(r.eligible, 2);
});

test('pickDeclared: 호스트 상한과 하루 상한', () => {
  const many = Array.from({ length: 5 }, (_, i) => t(`https://big.io/s${i}`, `2026-11-05T00:0${i}:00Z`));
  const r = pickDeclared([...many, t('https://x.io/mcp', '2026-11-05T01:00:00Z'), t('https://y.io/mcp', '2026-11-05T02:00:00Z')], {
    excludeUrls: new Set(),
    dailyCap: 3,
    hostCap: 2,
  });
  assert.deepEqual(r.picks.map((p) => p.url), ['https://big.io/s0', 'https://big.io/s1', 'https://x.io/mcp']);
  assert.equal(r.skippedByHostCap, 3);
  assert.equal(r.deferred, 1);
});

test('fetchDeclaredTargets: 페이지 읽기, 실패는 throw', async () => {
  const pages = [
    [{ url: 'https://a.io/mcp', host: 'a.io', probeable: true, sources: ['erc8004_registration'], first_declared_at: '2026-11-05T00:00:00Z' }, { url: 'https://b.io/mcp', probeable: true, sources: [] }],
    [{ url: 'https://c.io/mcp', probeable: true, sources: null }],
  ];
  const urls: string[] = [];
  let i = 0;
  const fetchImpl = (async (u: string) => {
    urls.push(u);
    return new Response(JSON.stringify(pages[i++] ?? []), { status: 200 });
  }) as unknown as typeof fetch;
  const rows = await fetchDeclaredTargets({ url: 'https://db.example', key: 'k' }, { fetchImpl, pageSize: 2 });
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[2]?.sources, []);
  assert.match(urls[0] ?? '', /lowdown_probe_targets_declared\?.*probeable=is.true/);
  const bad = (async () => new Response('x', { status: 500 })) as unknown as typeof fetch;
  await assert.rejects(fetchDeclaredTargets({ url: 'https://db.example', key: 'k' }, { fetchImpl: bad }), /HTTP 500/);
});
