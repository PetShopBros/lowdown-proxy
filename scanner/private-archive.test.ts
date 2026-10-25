import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { describe, test } from 'node:test';
import { gzipFile } from './archive-lib.ts';
import {
  fetchPrivateDay,
  integrityFailures,
  parsePrivateManifest,
  planPrivateDays,
  privatePathFor,
  serializePrivateManifest,
  SPECS,
  toJsonl,
} from './private-archive-lib.ts';
import { toolDefOf } from './lib.ts';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

describe('원문 비공개 보관', () => {
  test('경로: 데이터셋/daily/연/월/날.jsonl.gz', () => {
    assert.equal(privatePathFor('tool_defs', '2026-10-21'), 'tool_defs/daily/2026/10/2026-10-21.jsonl.gz');
  });

  test('JSONL: 열 순서 고정, 같은 행은 같은 바이트, 풀면 원문 그대로(NUL 이스케이프 포함)', () => {
    const d = toolDefOf({ name: 'x', description: 'nul\u0000 zero​width 한글' });
    const row = { ...d, first_seen_at: '2026-10-21T06:23:00Z', first_scan_run_id: 'r' };
    const a = gzipFile(toJsonl(SPECS.tool_defs.columns, [row]));
    const b = gzipFile(toJsonl(SPECS.tool_defs.columns, [{ first_scan_run_id: 'r', first_seen_at: '2026-10-21T06:23:00Z', ...d }]));
    assert.equal(a.sha256, b.sha256);
    const back = JSON.parse(gunzipSync(a.data).toString('utf8').trim()) as { body: string; def_hash: string };
    assert.equal(back.body, d.body);
    assert.equal(sha(back.body), back.def_hash);
    assert.deepEqual(Object.keys(back), [...(SPECS.tool_defs.columns ?? [])]);
    assert.equal(toJsonl(SPECS.tool_defs.columns, []), '');
  });

  test('무결성: 해시가 맞지 않는 행은 앞 16자만 돌려준다(원문 없음)', () => {
    const ok: Record<string, unknown> = { ...toolDefOf({ name: 'ok' }) };
    const bad = { ...toolDefOf({ name: 'secret-text' }), body: '{"name":"tampered secret"}' };
    const out = integrityFailures([ok, bad]);
    assert.deepEqual(out, [bad.def_hash.slice(0, 16)]);
    assert.ok(!out.join().includes('secret'));
  });

  test('MANIFEST 왕복, 다른 dataset 거부, 계획은 어긋나면 conflict', () => {
    const e = { dataset: 'tool_defs' as const, day: '2026-10-21', path: privatePathFor('tool_defs', '2026-10-21'), rows: 3, bytes: 10, sha256: 'ab', written_at: 't' };
    assert.deepEqual(parsePrivateManifest(serializePrivateManifest([e])), [e]);
    assert.throws(() => parsePrivateManifest('dataset,day,path,rows,bytes,sha256,written_at\nobservations,d,p,1,1,s,t\n'));
    const days = ['2026-10-21', '2026-10-22', '2026-10-23'];
    const onDisk = new Set([e.path, privatePathFor('tool_defs', '2026-10-22')]);
    const p = planPrivateDays('tool_defs', days, [e], (x) => onDisk.has(x));
    assert.deepEqual(p.todo, ['2026-10-23']);
    assert.equal(p.conflicts.length, 1);
  });

  test('DB 읽기: 하루 필터, 유일 키 keyset, 오류 문구에 응답 본문 없음', async () => {
    const urls: string[] = [];
    let call = 0;
    const fetchImpl = (async (input: string | URL | Request) => {
      urls.push(String(input));
      call++;
      const page = call === 1 ? [{ def_hash: 'a' }, { def_hash: 'b' }] : [{ def_hash: 'c' }];
      return new Response(JSON.stringify(page), { status: 200 });
    }) as typeof fetch;
    const rows = await fetchPrivateDay({ url: 'https://db', key: 'sb_x' }, { ...SPECS.tool_defs, pageSize: 2 }, { start: '2026-10-21T00:00:00.000Z', end: '2026-10-22T00:00:00.000Z' }, fetchImpl);
    assert.equal(rows.length, 3);
    const u = new URL(urls[1]!);
    assert.deepEqual(u.searchParams.getAll('first_seen_at'), ['gte.2026-10-21T00:00:00.000Z', 'lt.2026-10-22T00:00:00.000Z']);
    assert.equal(u.searchParams.get('def_hash'), 'gt.b');
    assert.equal(u.searchParams.get('order'), 'def_hash.asc');
    const bad = (async () => new Response('{"body":"secret description"}', { status: 500 })) as typeof fetch;
    await assert.rejects(fetchPrivateDay({ url: 'https://db', key: 'k' }, SPECS.tool_defs, { start: 'a', end: 'b' }, bad), (e: Error) => !e.message.includes('secret'));
  });

  test('DB 가 유일한 사본이던 기록: 모든 열(select=*), 키 이름순, 같은 행은 같은 바이트', async () => {
    for (const d of ['lookups', 'interactions', 'reviews', 'sandbox_runs'] as const) {
      assert.equal(SPECS[d].columns, null);
      assert.match(SPECS[d].from, /^\d{4}-\d{2}-\d{2}$/);
    }
    assert.equal(SPECS.lookups.table, 'reputation_lookups');
    assert.equal(SPECS.sandbox_runs.timeColumn, 'observed_at');
    assert.equal(SPECS.sandbox_runs.settleDays, 1);
    const a = toJsonl(null, [{ target: 't', id: 'x', user_agent: null, bot_kind: 'crawler' }]);
    const b = toJsonl(null, [{ bot_kind: 'crawler', user_agent: null, id: 'x', target: 't' }]);
    assert.equal(a, b);
    assert.deepEqual(Object.keys(JSON.parse(a)), ['bot_kind', 'id', 'target', 'user_agent']);
    const urls: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      urls.push(String(input));
      return new Response('[]', { status: 200 });
    }) as typeof fetch;
    await fetchPrivateDay({ url: 'https://db', key: 'k' }, SPECS.lookups, { start: 's', end: 'e' }, fetchImpl);
    const u = new URL(urls[0]!);
    assert.equal(u.searchParams.get('select'), '*');
    assert.deepEqual(u.searchParams.getAll('created_at'), ['gte.s', 'lt.e']);
    assert.equal(u.searchParams.get('order'), 'id.asc');
    const e = { dataset: 'lookups' as const, day: '2026-09-26', path: privatePathFor('lookups', '2026-09-26'), rows: 0, bytes: 20, sha256: 'ab', written_at: 't' };
    assert.deepEqual(parsePrivateManifest(serializePrivateManifest([e])), [e]);
  });
});
