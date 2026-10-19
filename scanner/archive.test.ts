import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { gunzipSync } from 'node:zlib';
import {
  closedDays,
  countRows,
  dayRange,
  fetchRegistryChangesDay,
  gzipFile,
  type ManifestEntry,
  parseManifest,
  pathFor,
  planDays,
  serializeManifest,
  snapshotDue,
  toCsv,
} from './archive-lib.ts';

const cfg = { url: 'https://x.supabase.co', key: 'sb_secret_test' };

const entry = (over: Partial<ManifestEntry>): ManifestEntry => ({
  dataset: 'observations',
  day: '2026-10-06',
  path: 'scanner_observations/daily/2026/10/2026-10-06.csv.gz',
  rows: 2007,
  bytes: 202103,
  sha256: 'a'.repeat(64),
  written_at: '2026-10-20T00:43:00.000Z',
  ...over,
});

describe('날짜별 보관 — 계획', () => {
  test('closedDays: 오늘(UTC)은 넣지 않는다, KST 아침도 UTC 기준', () => {
    assert.deepEqual(closedDays('2026-10-17', new Date('2026-10-20T00:43:00Z')), ['2026-10-17', '2026-10-18', '2026-10-19']);
    // KST 10/20 08:00 = UTC 10/19 23:00 → 10/19 는 아직 열려 있음
    assert.deepEqual(closedDays('2026-10-18', new Date('2026-10-19T23:00:00Z')), ['2026-10-18']);
    assert.deepEqual(closedDays('2026-10-20', new Date('2026-10-20T05:00:00Z')), []);
    assert.throws(() => closedDays('2026/10/01', new Date()));
  });

  test('closedDays: 월·연도 경계', () => {
    assert.deepEqual(closedDays('2026-12-30', new Date('2027-01-02T01:00:00Z')), ['2026-12-30', '2026-12-31', '2027-01-01']);
  });

  test('dayRange: UTC 하루', () => {
    assert.deepEqual(dayRange('2026-10-31'), { label: '2026-10-31', start: '2026-10-31T00:00:00.000Z', end: '2026-11-01T00:00:00.000Z' });
  });

  test('pathFor: 연/월 폴더', () => {
    assert.equal(pathFor('observations', '2026-10-19'), 'scanner_observations/daily/2026/10/2026-10-19.csv.gz');
    assert.equal(pathFor('registry_changes', '2026-11-01'), 'registry_changes/daily/2026/11/2026-11-01.csv.gz');
    assert.equal(pathFor('registry_state_snapshot', '2026-10-20'), 'registry_state/snapshots/2026-10-20.csv.gz');
    assert.equal(pathFor('observations_parquet', '2026-10'), 'scanner_observations/parquet/2026-10.parquet');
  });

  test('planDays: 보관된 날은 건너뛰고, 디스크·MANIFEST 가 어긋나면 덮어쓰지 않고 conflict', () => {
    const manifest = [entry({ day: '2026-10-06' }), entry({ day: '2026-10-07', path: pathFor('observations', '2026-10-07') })];
    const disk = new Set([pathFor('observations', '2026-10-06'), pathFor('observations', '2026-10-08')]);
    const plan = planDays('observations', ['2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09'], manifest, (p) => disk.has(p));
    assert.deepEqual(plan.todo, ['2026-10-09']);
    assert.equal(plan.conflicts.length, 2);
    assert.match(plan.conflicts[0]!, /2026-10-07.*in MANIFEST but file missing/);
    assert.match(plan.conflicts[1]!, /2026-10-08.*file exists but not in MANIFEST/);
  });

  test('planDays: 다른 dataset 의 MANIFEST 항목은 섞이지 않는다', () => {
    const manifest = [entry({ dataset: 'registry_changes', day: '2026-10-19', path: pathFor('registry_changes', '2026-10-19') })];
    const plan = planDays('observations', ['2026-10-19'], manifest, () => false);
    assert.deepEqual(plan.todo, ['2026-10-19']);
  });

  test('snapshotDue: 이번 달(UTC) 스냅샷이 없을 때만 오늘', () => {
    const now = new Date('2026-10-20T00:43:00Z');
    assert.equal(snapshotDue([], now), '2026-10-20');
    assert.equal(snapshotDue([entry({ dataset: 'registry_state_snapshot', day: '2026-10-20' })], now), null);
    assert.equal(snapshotDue([entry({ dataset: 'registry_state_snapshot', day: '2026-09-30' })], now), '2026-10-20');
  });
});

describe('날짜별 보관 — 파일과 MANIFEST', () => {
  test('toCsv: 열 순서 고정, 이스케이프, 객체는 JSON', () => {
    const csv = toCsv(['id', 'metadata', 'error_type'], [{ id: 1, metadata: { a: 'x,"y"' }, error_type: null }]);
    assert.equal(csv, 'id,metadata,error_type\n1,"{""a"":""x,\\""y\\""""}",\n');
  });

  test('toCsv: 0행이면 헤더만 ("확인했고 0건")', () => {
    assert.equal(toCsv(['id'], []), 'id\n');
  });

  test('gzipFile: 같은 입력은 같은 바이트·해시, 풀면 원문', () => {
    const a = gzipFile('id\n1\n');
    const b = gzipFile('id\n1\n');
    assert.equal(a.sha256, b.sha256);
    assert.equal(a.bytes, a.data.length);
    assert.match(a.sha256, /^[0-9a-f]{64}$/);
    assert.equal(gunzipSync(a.data).toString('utf8'), 'id\n1\n');
    assert.notEqual(gzipFile('id\n2\n').sha256, a.sha256);
  });

  test('MANIFEST: 직렬화 → 파싱 왕복, dataset·day 순 정렬', () => {
    const entries = [
      entry({ day: '2026-10-07', path: pathFor('observations', '2026-10-07') }),
      entry({ dataset: 'registry_changes', day: '2026-10-19', path: pathFor('registry_changes', '2026-10-19'), rows: 0, bytes: 60 }),
      entry({ day: '2026-10-06' }),
    ];
    const text = serializeManifest(entries);
    assert.ok(text.startsWith('dataset,day,path,rows,bytes,sha256,written_at\nobservations,2026-10-06,'));
    const back = parseManifest(text);
    assert.equal(back.length, 3);
    assert.deepEqual(back.map((e) => `${e.dataset}:${e.day}`), ['observations:2026-10-06', 'observations:2026-10-07', 'registry_changes:2026-10-19']);
    assert.equal(back[2]!.rows, 0);
    assert.equal(parseManifest(text.replace(/\n/g, '\r\n')).length, 3); // Windows 줄바꿈으로 받아도 읽힘
  });

  test('MANIFEST: 빈 파일은 빈 목록, 헤더·필드 수·dataset 이 다르면 실패', () => {
    assert.deepEqual(parseManifest(''), []);
    assert.throws(() => parseManifest('x,y\n'), /header/);
    assert.throws(() => parseManifest('dataset,day,path,rows,bytes,sha256,written_at\nobservations,2026-10-06\n'), /fields/);
    assert.throws(() => parseManifest('dataset,day,path,rows,bytes,sha256,written_at\nfoo,a,b,1,2,c,d\n'), /unknown dataset/);
  });
});

describe('날짜별 보관 — DB 입출력', () => {
  test('countRows: Content-Range 총계, 필터와 count=exact', async () => {
    let seenUrl = '';
    let prefer = '';
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      seenUrl = String(input);
      prefer = String((init?.headers as Record<string, string>).Prefer);
      return new Response('[]', { status: 200, headers: { 'content-range': '0-0/5030' } });
    }) as typeof fetch;
    const n = await countRows(cfg, 'scanner_observations', [['observed_at', 'gte.2026-10-19T00:00:00.000Z'], ['observed_at', 'lt.2026-10-20T00:00:00.000Z']], { fetchImpl });
    assert.equal(n, 5030);
    assert.match(prefer, /count=exact/);
    assert.match(seenUrl, /observed_at=gte\.2026-10-19.*observed_at=lt\.2026-10-20/);
  });

  test('countRows: 0행(*/0)은 0, 오류·총계 없음은 throw', async () => {
    const zero = (async () => new Response('[]', { status: 200, headers: { 'content-range': '*/0' } })) as unknown as typeof fetch;
    assert.equal(await countRows(cfg, 't', [], { fetchImpl: zero }), 0);
    const err = (async () => new Response('x', { status: 500 })) as unknown as typeof fetch;
    await assert.rejects(countRows(cfg, 't', [], { fetchImpl: err }), /HTTP 500/);
    const none = (async () => new Response('[]', { status: 200 })) as unknown as typeof fetch;
    await assert.rejects(countRows(cfg, 't', [], { fetchImpl: none }), /no content-range/);
  });

  test('fetchRegistryChangesDay: 하루 필터, name·kind 순 offset 페이지', async () => {
    const urls: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      const u = new URL(String(input));
      urls.push(u.search);
      const offset = Number(u.searchParams.get('offset'));
      const page = offset === 0 ? [{ name: 'a' }, { name: 'b' }] : [{ name: 'c' }];
      return new Response(JSON.stringify(page), { status: 200 });
    }) as typeof fetch;
    const rows = await fetchRegistryChangesDay(cfg, '2026-10-20', { fetchImpl, pageSize: 2 });
    assert.deepEqual(rows.map((r) => r.name), ['a', 'b', 'c']);
    assert.equal(urls.length, 2);
    assert.match(urls[0]!, /detected_on=eq\.2026-10-20/);
    assert.match(urls[0]!, /order=name\.asc%2Ckind\.asc/);
    assert.match(urls[1]!, /offset=2/);
  });

  test('fetchRegistryChangesDay: 읽기 오류는 throw', async () => {
    const err = (async () => new Response('x', { status: 401 })) as unknown as typeof fetch;
    await assert.rejects(fetchRegistryChangesDay(cfg, '2026-10-20', { fetchImpl: err }), /HTTP 401/);
  });
});
