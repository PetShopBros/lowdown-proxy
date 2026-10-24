import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { NpmChangeRow, NpmStateRow } from './npm-lib.ts';
import {
  confirmedSinceEntered,
  lastFactOn,
  parseDeclared,
  planSite,
  renderIndexJson,
  serverPath,
  summaryText,
  type RegistryChangeRow,
  type RegistryEntryRow,
} from './pages-lib.ts';
import type { PypiChangeRow, PypiStateRow } from './pypi-lib.ts';

const CFG = { baseUrl: 'https://example.test/lowdown-pages/', apiBase: 'https://api.example.test', marketUrl: 'https://example.test/lowdown-data/' };

const entry = (name: string, packagesKey: string, over: Partial<RegistryEntryRow> = {}): RegistryEntryRow => ({
  name,
  version: '1.0.0',
  status: 'active',
  packages_key: packagesKey,
  first_seen_at: '2026-10-16T01:00:00.000Z',
  baseline: true,
  removed_at: null,
  ...over,
});

const npm = (ident: string, over: Partial<NpmStateRow> = {}): NpmStateRow => ({
  ident,
  status: 'found',
  latest: '1.0.0',
  modified: '2026-09-01T00:00:00.000Z',
  deprecated: false,
  baseline: true,
  first_checked_at: '2026-10-22T03:00:00.000Z',
  checked_at: '2026-10-24T03:00:00.000Z',
  changed_at: null,
  last_error: null,
  last_error_at: null,
  scan_run_id: null,
  ...over,
});

const pypi = (ident: string, over: Partial<PypiStateRow> = {}): PypiStateRow => ({
  ident,
  status: 'found',
  latest: '1.0.0',
  latest_yanked: false,
  uploaded: '2026-09-01T00:00:00.000Z',
  project_status: 'active',
  index_status: 'found',
  baseline: true,
  first_checked_at: '2026-10-22T05:00:00.000Z',
  checked_at: '2026-10-24T05:00:00.000Z',
  changed_at: null,
  last_error: null,
  last_error_at: null,
  scan_run_id: null,
  ...over,
});

const npmEv = (ident: string, detected_on: string, kind: NpmChangeRow['kind'], old_value: string | null = null, new_value: string | null = null): NpmChangeRow => ({
  detected_on,
  ident,
  kind,
  old_value,
  new_value,
  scan_run_id: '00000000-0000-4000-8000-000000000001',
});

function plan(over: Partial<Parameters<typeof planSite>[0]> = {}) {
  return planSite({
    entries: [],
    npmState: [],
    pypiState: [],
    npmChanges: [],
    pypiChanges: [] as PypiChangeRow[],
    registryChanges: [] as RegistryChangeRow[],
    published: new Set(),
    cfg: CFG,
    ...over,
  });
}

describe('선언 파싱·주소', () => {
  test('npm·pypi 줄만, 형식이 아닌 이름은 버림, 같은 패키지는 한 번', () => {
    const d = parseDeclared('npm @acme/x 1.2.0 stdio\noci ghcr.io/a/b 1 stdio\npypi Foo_Bar 0.1 stdio\npypi foo-bar 0.2 stdio\nnpm bad name 1 stdio\nnpm <script> 1 stdio');
    assert.deepEqual(
      d.map((p) => [p.registry_type, p.identifier, p.declared_version, p.transport]),
      [
        ['npm', '@acme/x', '1.2.0', 'stdio'],
        ['pypi', 'Foo_Bar', '0.1', 'stdio'],
      ],
    );
  });

  test('버전·transport 가 빈 줄도 읽는다(줄 끝 공백)', () => {
    const d = parseDeclared('npm no-transport 1.0.0 \nnpm no-version  stdio');
    assert.deepEqual(
      d.map((p) => [p.identifier, p.declared_version, p.transport]),
      [
        ['no-transport', '1.0.0', null],
        ['no-version', null, 'stdio'],
      ],
    );
  });

  test('주소: 소문자, 슬래시 하나만, 위험한 조각 거부', () => {
    assert.equal(serverPath('io.github.Acme/Weather'), 'servers/io.github.acme/weather');
    assert.equal(serverPath('a/b/c'), null);
    assert.equal(serverPath('noslash'), null);
    assert.equal(serverPath('io.github.x/..'), null);
    assert.equal(serverPath('io.github.x/a b'), null);
  });
});

describe('사실 계산', () => {
  test('404 는 다음 확인에서도 404 일 때만 사실', () => {
    assert.equal(confirmedSinceEntered({ first_checked_at: '2026-10-22T03:00:00Z', checked_at: '2026-10-22T03:00:00Z', changed_at: null }), false);
    assert.equal(confirmedSinceEntered({ first_checked_at: '2026-10-22T03:00:00Z', checked_at: '2026-10-23T03:00:00Z', changed_at: null }), true);
    assert.equal(confirmedSinceEntered({ first_checked_at: '2026-10-20T03:00:00Z', checked_at: '2026-10-23T03:00:00Z', changed_at: '2026-10-23T03:00:00Z' }), false);

    const p = plan({
      entries: [entry('io.github.a/one', 'npm one-pkg 1.0.0 stdio'), entry('io.github.a/two', 'npm two-pkg 1.0.0 stdio')],
      npmState: [
        npm('one-pkg', { status: 'not_found', latest: null, deprecated: null, changed_at: '2026-10-24T03:00:00.000Z' }), // 방금 404 → 아직 사실 아님
        npm('two-pkg', { status: 'not_found', latest: null, deprecated: null, changed_at: '2026-10-23T03:00:00.000Z' }), // 다음 날도 404
      ],
      npmChanges: [npmEv('one-pkg', '2026-10-24', 'not_found', '1.0.0'), npmEv('two-pkg', '2026-10-23', 'not_found', '1.0.0')],
    });
    assert.deepEqual(
      p.records.map((r) => r.name),
      ['io.github.a/two'],
    );
    const f = p.records[0]!.facts[0]!;
    assert.equal(f.code, 'declared_package_not_found');
    assert.deepEqual(f.since, { on: '2026-10-23', basis: 'change' });
  });

  test('기준선 deprecated 는 "첫 확인 때 이미", 이벤트가 있으면 그 날짜', () => {
    const p = plan({
      entries: [entry('io.github.a/base', 'npm base-pkg 1.0.0 stdio'), entry('io.github.a/ev', 'npm ev-pkg 2.0.0 stdio')],
      npmState: [npm('base-pkg', { deprecated: true }), npm('ev-pkg', { latest: '2.0.0', deprecated: true, changed_at: '2026-10-23T03:00:00.000Z' })],
      npmChanges: [npmEv('ev-pkg', '2026-10-23', 'deprecated', '2.0.0')],
    });
    const byName = new Map(p.records.map((r) => [r.name, r]));
    assert.deepEqual(byName.get('io.github.a/base')!.facts[0]!.since, { on: '2026-10-22', basis: 'first_check' });
    assert.deepEqual(byName.get('io.github.a/ev')!.facts[0]!.since, { on: '2026-10-23', basis: 'change' });
    assert.match(summaryText(byName.get('io.github.a/base')!), /npm marks the latest version of base-pkg \(1\.0\.0\) as deprecated/);
  });

  test('PyPI: 이름 정규화로 연결, 404 종류, yanked, 비활성 상태', () => {
    const p = plan({
      entries: [entry('io.github.p/a', 'pypi Gone_Pkg 1 stdio'), entry('io.github.p/b', 'pypi yank.pkg 1 stdio'), entry('io.github.p/c', 'pypi arch-pkg 1 stdio')],
      pypiState: [
        pypi('gone-pkg', { status: 'not_found', latest: null, latest_yanked: null, project_status: null, index_status: 'not_found' }),
        pypi('yank-pkg', { latest_yanked: true }),
        pypi('arch-pkg', { project_status: 'archived' }),
      ],
    });
    const byName = new Map(p.records.map((r) => [r.name, r]));
    const a = byName.get('io.github.p/a')!.facts[0]!;
    assert.equal(a.code, 'declared_package_not_found');
    assert.equal(a.not_found_kind, 'no_project');
    assert.match(summaryText(byName.get('io.github.p/a')!), /PyPI has no project named Gone_Pkg/);
    assert.equal(byName.get('io.github.p/b')!.facts[0]!.code, 'declared_package_yanked');
    assert.equal(byName.get('io.github.p/c')!.facts[0]!.code, 'declared_package_project_status');
    assert.equal(byName.get('io.github.p/c')!.facts[0]!.project_status, 'archived');
  });

  test('정상 패키지만 있거나 Registry 에서 빠진 항목은 새 페이지를 만들지 않음', () => {
    const p = plan({
      entries: [entry('io.github.a/ok', 'npm ok-pkg 1.0.0 stdio'), entry('io.github.a/gone', 'npm dep-pkg 1.0.0 stdio', { removed_at: '2026-10-20T00:00:00.000Z' })],
      npmState: [npm('ok-pkg'), npm('dep-pkg', { deprecated: true })],
    });
    assert.equal(p.records.length, 0);
  });
});

describe('사이트', () => {
  test('이미 있는 페이지는 사실이 없어져도 남긴다', () => {
    const p = plan({
      entries: [entry('io.github.a/fixed', 'npm fixed-pkg 1.1.0 stdio')],
      npmState: [npm('fixed-pkg', { latest: '1.1.0', deprecated: false, changed_at: '2026-10-24T03:00:00.000Z' })],
      npmChanges: [npmEv('fixed-pkg', '2026-10-24', 'undeprecated', '1.1.0')],
      published: new Set(['io.github.a/fixed']),
    });
    assert.equal(p.records.length, 1);
    assert.equal(p.keptFromBefore, 1);
    assert.match(summaryText(p.records[0]!), /currently records no package status flags/);
    assert.match(p.files.get('servers/io.github.a/fixed.html')!, /no longer marked deprecated/);
  });

  test('이미 있는 페이지의 항목이 Registry 상태에서 사라지면 실패(조용히 지우지 않음)', () => {
    assert.throws(() => plan({ published: new Set(['io.github.a/missing']) }), /missing from Registry state/);
  });

  test('소문자 주소가 겹치면 실패', () => {
    assert.throws(
      () =>
        plan({
          entries: [entry('io.github.A/x', 'npm d1 1 stdio'), entry('io.github.a/X', 'npm d2 1 stdio')],
          npmState: [npm('d1', { deprecated: true }), npm('d2', { deprecated: true })],
        }),
      /path collision/,
    );
  });

  test('같은 입력이면 같은 바이트, 페이지에는 마지막 확인 시각이 없음', () => {
    const input = {
      entries: [entry('io.github.a/dep', 'npm dep-pkg 1.0.0 stdio')],
      npmState: [npm('dep-pkg', { deprecated: true })],
    };
    const a = plan(input);
    const b = plan({ ...input, npmState: [npm('dep-pkg', { deprecated: true, checked_at: '2026-10-30T03:00:00.000Z' })] });
    assert.deepEqual([...a.files.entries()], [...b.files.entries()]);
    for (const t of a.files.values()) assert.doesNotMatch(t, /2026-10-24T03:00/);
  });

  test('HTML 이스케이프·제목·JSON 링크, 해석 단어 없음', () => {
    const p = plan({ entries: [entry('io.github.a/dep', 'npm dep-pkg 1.0.0 stdio')], npmState: [npm('dep-pkg', { deprecated: true })] });
    const html = p.files.get('servers/io.github.a/dep.html')!;
    assert.match(html, /<title>io\.github\.a\/dep — MCP Registry entry and declared package status \(Lowdown record\)<\/title>/);
    assert.match(html, /rel="alternate" type="application\/json"/);
    assert.match(html, /already the case when Lowdown first checked/);
    assert.doesNotMatch(html, /\b(unsafe|dangerous|abandoned|malicious|risky)\b/i);
    const json = JSON.parse(p.files.get('servers/io.github.a/dep.json')!);
    assert.equal(json.schema, 'lowdown-server-page/1');
    assert.equal(json.facts[0].code, 'declared_package_deprecated');
    assert.equal(json.api_url, 'https://api.example.test/api/reputation/mcp:io.github.a/dep');
  });

  test('sitemap lastmod = 사실이 바뀐 날, servers.json 에만 확인 날짜', () => {
    const p = plan({
      entries: [entry('io.github.a/ev', 'npm ev-pkg 2.0.0 stdio')],
      npmState: [npm('ev-pkg', { latest: '2.0.0', deprecated: true, changed_at: '2026-10-23T03:00:00.000Z' })],
      npmChanges: [npmEv('ev-pkg', '2026-10-23', 'deprecated', '2.0.0')],
    });
    assert.equal(lastFactOn(p.records[0]!), '2026-10-23');
    assert.match(p.files.get('sitemap.xml')!, /<lastmod>2026-10-23<\/lastmod>/);
    const idx = JSON.parse(renderIndexJson(p.records, new Map([['io.github.a/ev', '2026-10-24']]), '2026-10-24T03:00:00.000Z'));
    assert.equal(idx.with_facts, 1);
    assert.equal(idx.servers[0].last_checked_on, '2026-10-24');
  });
});
