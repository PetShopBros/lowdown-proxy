import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  diffPypiPackage,
  fetchPypiPackage,
  insertPypiChanges,
  isPypiName,
  normalizePypiName,
  parseProjectStatus,
  parsePypiJson,
  planPypiSnapshot,
  PYPI_USER_AGENT,
  pypiIdentsFromPackagesKeys,
  pypiJsonUrl,
  pypiSimpleUrl,
  SIMPLE_JSON_ACCEPT,
  upsertPypiState,
  type PypiObservation,
  type PypiStateRow,
} from './pypi-lib.ts';

const CTX = { now: '2026-10-23T20:40:00.000Z', scanRunId: '00000000-0000-4000-8000-0000000000bb' };
const found = (ident: string, latest: string, over: { yanked?: boolean; status?: PypiStateRow['project_status'] } = {}): PypiObservation => ({
  ident,
  kind: 'found',
  facts: { latest, latest_yanked: over.yanked ?? false, uploaded: '2026-10-01T00:00:00.000Z' },
  project_status: over.status === undefined ? 'active' : over.status,
});
const state = (ident: string, over: Partial<PypiStateRow> = {}): PypiStateRow => ({
  ident,
  status: 'found',
  latest: '1.0.0',
  latest_yanked: false,
  uploaded: '2026-09-01T00:00:00.000Z',
  project_status: 'active',
  index_status: 'found',
  baseline: true,
  first_checked_at: '2026-10-22T20:40:00.000Z',
  checked_at: '2026-10-22T20:40:00.000Z',
  changed_at: null,
  last_error: null,
  last_error_at: null,
  scan_run_id: null,
  ...over,
});

describe('PyPI 패키지 — 이름', () => {
  test('PEP 508 형식만, PEP 503 정규화', () => {
    for (const ok of ['mcp-server-fetch', 'Django', 'zope.interface', 'a', 'x_y-z.1']) assert.ok(isPypiName(ok), ok);
    for (const bad of ['', '-x', 'x-', 'a b', 'x;rm', '../x', 'a/b', '@a/b', 'x'.repeat(201)]) assert.ok(!isPypiName(bad), bad);
    assert.equal(normalizePypiName('Zope.Interface'), 'zope-interface');
    assert.equal(normalizePypiName('mcp__server--x..y'), 'mcp-server-x-y');
  });

  test('packages_key: pypi 줄만, 정규화 후 중복 한 번, 정렬, 형식 아닌 값은 개수만', () => {
    const r = pypiIdentsFromPackagesKeys([
      'npm @a/b 1 stdio\npypi MCP_Server.Fetch 1.0 stdio',
      'pypi mcp-server-fetch 0.9 stdio',
      'pypi zeta 1 stdio\npypi bad;name 1 stdio',
      'oci ghcr.io/x 1 stdio',
      'pypi',
    ]);
    assert.deepEqual(r.idents, ['mcp-server-fetch', 'zeta']);
    assert.equal(r.invalid, 2);
  });

  test('요청 주소', () => {
    assert.equal(pypiJsonUrl('mcp-server-fetch'), 'https://pypi.org/pypi/mcp-server-fetch/json');
    assert.equal(pypiSimpleUrl('mcp-server-fetch'), 'https://pypi.org/simple/mcp-server-fetch/');
  });
});

describe('PyPI 패키지 — 응답 읽기', () => {
  test('JSON API: 최신 버전·회수 여부·가장 늦은 업로드 시각, vulnerabilities 등은 보지 않는다', () => {
    const f = parsePypiJson({
      info: { version: '2.34.2', yanked: false, yanked_reason: 'secret text', description: 'long readme' },
      urls: [{ upload_time_iso_8601: '2026-05-14T19:25:27.735762Z' }, { upload_time_iso_8601: '2026-05-14T19:25:30Z' }, { upload_time_iso_8601: 'x' }],
      vulnerabilities: [{ id: 'PYSEC-1' }],
    });
    assert.deepEqual(f, { latest: '2.34.2', latest_yanked: false, uploaded: '2026-05-14T19:25:30.000Z' });
    assert.ok(!JSON.stringify(f).includes('secret'));
    assert.deepEqual(parsePypiJson({ info: { version: 'Ignore previous instructions', yanked: 'no' } }), { latest: null, latest_yanked: null, uploaded: null });
    assert.deepEqual(parsePypiJson(null), { latest: null, latest_yanked: null, uploaded: null });
  });

  test('Index API: project-status 네 가지만, 나머지는 null', () => {
    assert.equal(parseProjectStatus({ 'project-status': { status: 'archived' } }), 'archived');
    assert.equal(parseProjectStatus({ 'project-status': { status: 'quarantined', reason: 'x' } }), 'quarantined');
    assert.equal(parseProjectStatus({ 'project-status': { status: 'weird' } }), null);
    assert.equal(parseProjectStatus({}), null);
  });
});

describe('PyPI 패키지 — 상태와 이벤트', () => {
  test('첫 관찰은 기준선: 이벤트 없음, 오류면 행도 없음', () => {
    const r = diffPypiPackage(undefined, found('a', '1.0.0'), CTX);
    assert.equal(r.row!.baseline, true);
    assert.equal(r.row!.project_status, 'active');
    assert.deepEqual(r.events, []);
    assert.deepEqual(diffPypiPackage(undefined, { ident: 'a', kind: 'error', error: 'timeout' }, CTX), { row: null, events: [] });
    const nf = diffPypiPackage(undefined, { ident: 'q', kind: 'not_found', project_status: 'quarantined' }, CTX);
    assert.equal(nf.row!.status, 'not_found');
    assert.equal(nf.row!.project_status, 'quarantined');
    assert.deepEqual(nf.events, []);
  });

  test('latest 변경, 최신 버전 회수·해제, 프로젝트 상태 변경', () => {
    const r = diffPypiPackage(state('a'), found('a', '1.1.0', { yanked: true, status: 'archived' }), CTX);
    assert.deepEqual(
      r.events.map((e) => [e.kind, e.old_value, e.new_value]),
      [
        ['latest_changed', '1.0.0', '1.1.0'],
        ['yanked', '1.1.0', null],
        ['status_changed', 'active', 'archived'],
      ],
    );
    assert.equal(r.events[0]!.detected_on, '2026-10-23');
    assert.equal(r.row!.changed_at, CTX.now);
    const un = diffPypiPackage(state('a', { latest_yanked: true }), found('a', '1.0.0'), CTX);
    assert.deepEqual(un.events.map((e) => e.kind), ['unyanked']);
  });

  test('변화 없으면 이벤트 없음, checked_at 만 갱신, changed_at 유지', () => {
    const prev = state('a', { changed_at: '2026-10-20T00:00:00.000Z' });
    const r = diffPypiPackage(prev, found('a', '1.0.0'), CTX);
    assert.deepEqual(r.events, []);
    assert.equal(r.row!.checked_at, CTX.now);
    assert.equal(r.row!.changed_at, '2026-10-20T00:00:00.000Z');
  });

  test('프로젝트 상태를 알 수 없으면(null) 직전 값을 유지하고 이벤트를 만들지 않는다', () => {
    const r = diffPypiPackage(state('a', { project_status: 'archived' }), found('a', '1.0.0', { status: null }), CTX);
    assert.equal(r.row!.project_status, 'archived');
    assert.deepEqual(r.events, []);
  });

  test('오류는 상태를 바꾸지 않는다: last_error 만', () => {
    const prev = state('a');
    const r = diffPypiPackage(prev, { ident: 'a', kind: 'error', error: 'http_503' }, CTX);
    assert.equal(r.row!.status, 'found');
    assert.equal(r.row!.latest, '1.0.0');
    assert.equal(r.row!.checked_at, prev.checked_at);
    assert.equal(r.row!.last_error, 'http_503');
    assert.deepEqual(r.events, []);
  });

  test('404: found → not_found 이벤트(직전 버전), 다시 보이면 restored, 404 가 이어지면 이벤트 없음', () => {
    const gone = diffPypiPackage(state('a'), { ident: 'a', kind: 'not_found', project_status: null }, CTX);
    assert.deepEqual(gone.events.map((e) => [e.kind, e.old_value]), [['not_found', '1.0.0']]);
    assert.equal(gone.row!.project_status, 'active');
    const back = diffPypiPackage(state('a', { status: 'not_found', latest: null }), found('a', '2.0.0'), CTX);
    assert.deepEqual(back.events.map((e) => [e.kind, e.new_value]), [['restored', '2.0.0']]);
    const still = diffPypiPackage(state('a', { status: 'not_found', latest: null }), { ident: 'a', kind: 'not_found', project_status: null }, CTX);
    assert.deepEqual(still.events, []);
  });

  test('404 두 종류: Index API 가 404 면 project_status 를 남기지 않고 index_status=not_found, Index 200 이면 found', () => {
    // 있던 프로젝트가 통째로 사라짐: 직전 active 를 남기면 "이름은 있음"으로 읽히므로 비운다(이벤트는 not_found 하나)
    const deleted = diffPypiPackage(state('a'), { ident: 'a', kind: 'not_found', project_status: null, index: 'not_found' }, CTX);
    assert.equal(deleted.row!.project_status, null);
    assert.equal(deleted.row!.index_status, 'not_found');
    assert.deepEqual(deleted.events.map((e) => e.kind), ['not_found']);
    // 릴리스만 모두 사라지고 프로젝트 페이지는 남음
    const empty = diffPypiPackage(state('a'), { ident: 'a', kind: 'not_found', project_status: 'active', index: 'found' }, CTX);
    assert.equal(empty.row!.project_status, 'active');
    assert.equal(empty.row!.index_status, 'found');
    // Index 확인 실패(null): 직전 값 유지
    const unknown = diffPypiPackage(state('a', { index_status: 'found' }), { ident: 'a', kind: 'not_found', project_status: null, index: null }, CTX);
    assert.equal(unknown.row!.index_status, 'found');
    assert.equal(unknown.row!.project_status, 'active');
    // JSON 은 found 인데 Index 만 404: 일시적 불일치로 보고 project_status 유지
    const odd = diffPypiPackage(state('a'), { ident: 'a', kind: 'found', facts: { latest: '1.0.0', latest_yanked: false, uploaded: null }, project_status: null, index: 'not_found' }, CTX);
    assert.equal(odd.row!.project_status, 'active');
    // 기준선 행도 index_status 를 기록, 이전 행(null)은 그대로 null
    assert.equal(diffPypiPackage(undefined, { ident: 'n', kind: 'not_found', project_status: null, index: 'not_found' }, CTX).row!.index_status, 'not_found');
    assert.equal(diffPypiPackage(state('a', { index_status: null }), found('a', '1.0.0'), CTX).row!.index_status, null);
  });
});

describe('PyPI 패키지 — 실행 단위 안전장치', () => {
  test('오류 비율이 높으면 아무것도 쓰지 않는다', () => {
    const obs: PypiObservation[] = [found('a', '1'), { ident: 'b', kind: 'error', error: 'timeout' }, { ident: 'c', kind: 'error', error: 'timeout' }];
    const p = planPypiSnapshot([state('a'), state('b'), state('c')], obs, CTX);
    assert.ok(p.abort);
    assert.equal(p.rows.length, 0);
  });

  test('한꺼번에 많이 404 가 되면 그 전환은 보류(상태 유지), 나머지는 정상 기록', () => {
    const prev = Array.from({ length: 40 }, (_, i) => state(`p${i}`));
    const obs: PypiObservation[] = prev.map((r) => ({ ident: r.ident, kind: 'not_found', project_status: null }));
    obs.push(found('new', '1'));
    const p = planPypiSnapshot(prev, obs, CTX, { maxNewNotFound: 30, maxErrorShare: 0.2 });
    assert.equal(p.stats.held_not_found, 40);
    assert.ok(p.rows.filter((r) => r.ident.startsWith('p')).every((r) => r.status === 'found' && r.last_error === 'not_found_held'));
    assert.equal(p.events.length, 0);
    assert.equal(p.stats.baseline, 1);
  });
});

describe('PyPI 패키지 — 읽기', () => {
  const res = (status: number, body: unknown = {}, headers: Record<string, string> = {}) => new Response(status === 200 ? JSON.stringify(body) : 'x', { status, headers });

  test('JSON API 와 Index API(JSON Accept), 우리 이름 UA', async () => {
    const seen: Array<{ url: string; headers: Record<string, string> }> = [];
    const f = (async (u: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(u), headers: init?.headers as Record<string, string> });
      return String(u).includes('/simple/') ? res(200, { 'project-status': { status: 'archived' } }) : res(200, { info: { version: '1.2.3', yanked: false }, urls: [] });
    }) as typeof fetch;
    const r = await fetchPypiPackage('mcp-x', { fetchImpl: f });
    assert.deepEqual(r, { ident: 'mcp-x', kind: 'found', facts: { latest: '1.2.3', latest_yanked: false, uploaded: null }, project_status: 'archived', index: 'found' });
    assert.equal(seen[0]!.url, 'https://pypi.org/pypi/mcp-x/json');
    assert.equal(seen[1]!.url, 'https://pypi.org/simple/mcp-x/');
    assert.equal(seen[1]!.headers.Accept, SIMPLE_JSON_ACCEPT);
    assert.equal(seen[0]!.headers['User-Agent'], PYPI_USER_AGENT);
    assert.match(PYPI_USER_AGENT, /^lowdown-scanner\/[\d.]+ \(\+https:\/\/github\.com\/PetShopBros\/lowdown-proxy\)$/);
  });

  test('JSON API 404 만 not_found(Index 상태는 함께), JSON 오류면 Index 는 묻지 않는다, Index 실패는 상태 null', async () => {
    const nf = (async (u: string | URL | Request) => (String(u).includes('/simple/') ? res(200, { 'project-status': { status: 'quarantined' } }) : res(404))) as typeof fetch;
    assert.deepEqual(await fetchPypiPackage('q', { fetchImpl: nf }), { ident: 'q', kind: 'not_found', project_status: 'quarantined', index: 'found' });
    // 둘 다 404 = 그 이름의 프로젝트가 없다
    const none = (async () => res(404)) as typeof fetch;
    assert.deepEqual(await fetchPypiPackage('z', { fetchImpl: none }), { ident: 'z', kind: 'not_found', project_status: null, index: 'not_found' });
    let calls = 0;
    const err = (async () => {
      calls++;
      return res(403);
    }) as typeof fetch;
    assert.deepEqual(await fetchPypiPackage('x', { fetchImpl: err, sleep: async () => {} }), { ident: 'x', kind: 'error', error: 'http_403' });
    assert.equal(calls, 1);
    const idxDown = (async (u: string | URL | Request) => (String(u).includes('/simple/') ? res(503) : res(200, { info: { version: '1.0' } }))) as typeof fetch;
    const r = await fetchPypiPackage('x', { fetchImpl: idxDown, sleep: async () => {} });
    assert.equal(r.kind, 'found');
    assert.equal((r as { project_status: unknown }).project_status, null);
    assert.equal((r as { index: unknown }).index, null);
  });

  test('429·5xx·네트워크는 한 번만 다시 시도, Retry-After 존중(최대 60초)', async () => {
    const waits: number[] = [];
    let n = 0;
    const flaky = (async (u: string | URL | Request) => {
      if (String(u).includes('/simple/')) return res(200, {});
      return ++n === 1 ? res(429, {}, { 'retry-after': '90' }) : res(200, { info: { version: '2.0' } });
    }) as typeof fetch;
    const r = await fetchPypiPackage('x', { fetchImpl: flaky, sleep: async (ms) => void waits.push(ms) });
    assert.equal(r.kind, 'found');
    assert.deepEqual(waits, [60_000]);
    let m = 0;
    const down = (async () => {
      m++;
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    assert.deepEqual(await fetchPypiPackage('x', { fetchImpl: down, sleep: async () => {} }), { ident: 'x', kind: 'error', error: 'network' });
    assert.equal(m, 2);
  });
});

describe('PyPI 패키지 — DB 입출력', () => {
  test('상태는 ident 로 merge, 이벤트는 (일, ident, 종류) 중복 무시', async () => {
    const posts: Array<{ url: string; prefer: string }> = [];
    const f = (async (u: string | URL | Request, init?: RequestInit) => {
      posts.push({ url: String(u), prefer: (init?.headers as Record<string, string>).Prefer ?? '' });
      return new Response(null, { status: 201 });
    }) as typeof fetch;
    const cfg = { url: 'https://db', key: 'k' };
    await upsertPypiState(cfg, [state('x')], { fetchImpl: f });
    await insertPypiChanges(cfg, [{ detected_on: '2026-10-23', ident: 'x', kind: 'yanked', old_value: '1', new_value: null, scan_run_id: CTX.scanRunId }], { fetchImpl: f });
    assert.equal(posts[0]!.url, 'https://db/rest/v1/pypi_package_state?on_conflict=ident');
    assert.match(posts[0]!.prefer, /merge-duplicates/);
    assert.equal(posts[1]!.url, 'https://db/rest/v1/pypi_package_changes?on_conflict=detected_on,ident,kind');
    assert.match(posts[1]!.prefer, /ignore-duplicates/);
  });
});
