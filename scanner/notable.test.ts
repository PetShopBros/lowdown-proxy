import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { buildNotable, declarationIndex, groupKeyOf, insertNotable, summarize, type NotableInput } from './notable-lib.ts';

const DAY = '2026-10-27';
const base = (over: Partial<NotableInput> = {}): NotableInput => ({
  day: DAY,
  npmChanges: [],
  pypiChanges: [],
  npmFirstChecked: [],
  pypiFirstChecked: [],
  npmInitialDay: '2026-10-22',
  pypiInitialDay: '2026-10-23',
  declarations: [],
  ...over,
});
const ch = (ident: string, kind: string, old_value: string | null = null, new_value: string | null = null, detected_on = DAY) => ({ detected_on, ident, kind, old_value, new_value });

describe('레이다 1단계 — 패키지 규칙', () => {
  test('P1·P2: npm deprecated / not_found 전환만, latest_changed·undeprecated·restored 는 올리지 않는다', () => {
    const { rows } = buildNotable(
      base({
        npmChanges: [ch('a-pkg', 'deprecated', '1.0.0'), ch('b-pkg', 'not_found', '2.0.4'), ch('c-pkg', 'latest_changed', '1', '2'), ch('d-pkg', 'undeprecated', '1'), ch('e-pkg', 'restored', null, '3')],
        declarations: [{ name: 'io.github.x/a', packages_key: 'npm a-pkg 1.0.0 stdio' }],
      }),
    );
    assert.deepEqual(rows.map((r) => `${r.rule_id} ${r.subject}`), ['P1_npm_deprecated a-pkg', 'P2_npm_not_found b-pkg']);
    assert.deepEqual(rows[0]!.evidence, { package: 'a-pkg', version: '1.0.0', registry_names: ['io.github.x/a'] });
    assert.deepEqual(rows[1]!.evidence, { package: 'b-pkg', last_seen_latest: '2.0.4', registry_names: [] });
    assert.ok(rows.every((r) => r.published === false && r.rule_version === 1 && r.day === DAY));
  });

  test('P4·P5·P6: PyPI archived/quarantined, yanked, not_found — 이름은 정규화, active·deprecated 전환은 올리지 않는다', () => {
    const { rows } = buildNotable(
      base({
        pypiChanges: [
          ch('My_Pkg', 'status_changed', 'active', 'archived'),
          ch('q-pkg', 'status_changed', 'active', 'quarantined'),
          ch('dep-pkg', 'status_changed', 'active', 'deprecated'),
          ch('back-pkg', 'status_changed', 'archived', 'active'),
          ch('y-pkg', 'yanked', '0.1.1'),
          ch('gone-pkg', 'not_found', '0.3.0'),
          ch('u-pkg', 'unyanked', '0.1.1'),
        ],
        declarations: [{ name: 'io.github.Acme/tool', packages_key: 'pypi my.pkg 1.0 stdio' }],
      }),
    );
    assert.deepEqual(rows.map((r) => `${r.rule_id} ${r.subject}`), [
      'P4_pypi_archived my-pkg',
      'P4_pypi_archived q-pkg',
      'P5_pypi_latest_yanked y-pkg',
      'P6_pypi_not_found gone-pkg',
    ]);
    const archived = rows[0]!;
    assert.deepEqual(archived.evidence, { package: 'my-pkg', old_status: 'active', new_status: 'archived', registry_names: ['io.github.Acme/tool'] });
    assert.equal(archived.group_key, 'ns:io.github.acme');
  });

  test('P3: npm 새 버전, 전날까지 기록된 수정 시각이 180일 이상 전이면 — 값이 없거나 짧으면 내지 않는다', () => {
    const lc = (ident: string, prev_modified: string | null | undefined) => ({ ...ch(ident, 'latest_changed', '1.0.0', '1.1.0'), prev_modified });
    const { rows } = buildNotable(
      base({
        npmChanges: [lc('woke-up', '2026-04-29T12:00:00Z'), lc('busy', '2026-10-20T00:00:00Z'), lc('unknown', null), lc('legacy', undefined), lc('edge', '2026-04-30T00:00:00Z')],
        declarations: [{ name: 'io.github.w/woke', packages_key: 'npm woke-up 1.1.0 stdio' }],
      }),
    );
    assert.deepEqual(rows.map((r) => `${r.rule_id} ${r.subject}`), ['P3_npm_release_after_dormancy edge', 'P3_npm_release_after_dormancy woke-up']);
    const woke = rows.find((r) => r.subject === 'woke-up')!;
    assert.deepEqual(woke.evidence, {
      package: 'woke-up',
      old_version: '1.0.0',
      new_version: '1.1.0',
      dormant_days_at_least: 180,
      previous_activity: '2026-04-29',
      registry_names: ['io.github.w/woke'],
    });
  });

  test('다른 날 이벤트는 넣지 않는다', () => {
    const { rows } = buildNotable(base({ npmChanges: [ch('a-pkg', 'deprecated', '1.0.0', null, '2026-10-26')] }));
    assert.equal(rows.length, 0);
  });

  test('P7: 지금 선언 중인 패키지의 그날 첫 확인이 404 일 때만 — 첫 전수 확인일·선언 없음·found·다른 날은 제외', () => {
    const decls = [
      { name: 'io.github.n/new', packages_key: 'npm new-missing 0.1.0 stdio\nnpm found-new 1.0.0 stdio' },
      { name: 'io.github.p/py', packages_key: 'pypi Py_Missing 0.1.0 stdio' },
    ];
    const npmFirstChecked = [
      { ident: 'new-missing', status: 'not_found', baseline: true, first_checked_at: `${DAY}T19:37:09Z` },
      { ident: 'found-new', status: 'found', baseline: true, first_checked_at: `${DAY}T19:37:09Z` },
      { ident: 'undeclared', status: 'not_found', baseline: true, first_checked_at: `${DAY}T19:37:09Z` },
      { ident: 'old-404', status: 'not_found', baseline: true, first_checked_at: '2026-10-26T19:37:09Z' },
    ];
    const pypiFirstChecked = [{ ident: 'py-missing', status: 'not_found', baseline: true, first_checked_at: `${DAY}T20:37:08Z` }];
    const { rows } = buildNotable(base({ declarations: decls, npmFirstChecked, pypiFirstChecked }));
    assert.deepEqual(rows.map((r) => `${r.rule_id} ${r.subject_kind}:${r.subject}`), ['P7_declared_missing_package npm:new-missing', 'P7_declared_missing_package pypi:py-missing']);
    assert.deepEqual(rows[0]!.evidence, { package: 'new-missing', registry_type: 'npm', first_checked_at: `${DAY}T19:37:09Z`, registry_names: ['io.github.n/new'] });

    // 첫 전수 확인일에는 기준선 전체가 404 일 수 있으므로 P7 을 만들지 않는다
    const initial = buildNotable(base({ day: '2026-10-22', npmInitialDay: '2026-10-22', declarations: decls, npmFirstChecked: [{ ...npmFirstChecked[0]!, first_checked_at: '2026-10-22T19:37:00Z' }] }));
    assert.equal(initial.rows.length, 0);
  });

  test('형식이 아닌 이름·버전은 쓰지 않는다', () => {
    const { rows, skipped } = buildNotable(base({ npmChanges: [ch('<script>', 'deprecated', '1.0.0'), ch('ok-pkg', 'deprecated', '1.0.0 <b>')] }));
    assert.equal(skipped, 1);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.evidence.version, null);
  });

  test('같은 (규칙, 대상) 은 한 번만, 정렬 고정 → 같은 입력이면 같은 결과', () => {
    const input = base({ npmChanges: [ch('z-pkg', 'deprecated', '1'), ch('a-pkg', 'deprecated', '1'), ch('a-pkg', 'deprecated', '1')] });
    const a = buildNotable(input).rows;
    const b = buildNotable(input).rows;
    assert.deepEqual(a.map((r) => r.subject), ['a-pkg', 'z-pkg']);
    assert.deepEqual(a, b);
  });
});

describe('묶음 키·요약', () => {
  test('npm scope → 첫 Registry 네임스페이스 → 패키지 자체', () => {
    assert.equal(groupKeyOf('npm', '@guardbee/x', ['io.github.other/y']), 'npm:@guardbee');
    assert.equal(groupKeyOf('pypi', 'eclipse-herald', ['io.github.CYAN-ECLIPSE-TECHNOLOGIES-LLC/herald']), 'ns:io.github.cyan-eclipse-technologies-llc');
    assert.equal(groupKeyOf('npm', 'lonely', []), 'npm:lonely');
  });

  test('같은 날 같은 묶음은 한 줄로 센다', () => {
    const decls = ['agent-ready', 'herald', 'muster'].map((n) => ({ name: `io.github.CYAN-ECLIPSE-TECHNOLOGIES-LLC/${n}`, packages_key: `pypi eclipse-${n} 0.1.0 stdio` }));
    const { rows } = buildNotable(base({ declarations: decls, pypiChanges: ['agent-ready', 'herald', 'muster'].map((n) => ch(`eclipse-${n}`, 'not_found', '0.1.0')).concat([ch('solo', 'not_found', '1')]) }));
    const s = summarize(rows);
    assert.deepEqual(s.byRule, { P6_pypi_not_found: 4 });
    assert.equal(s.groups, 1);
    assert.equal(s.lines, 2);
  });

  test('선언 색인: 형식이 아닌 줄은 버리고, PyPI 는 정규화 이름으로', () => {
    const idx = declarationIndex([
      { name: 'b/one', packages_key: 'pypi Foo.Bar 1 stdio\nnpm ok 1 stdio\nmcpb https://x 1 stdio\nbroken line' },
      { name: 'a/two', packages_key: 'pypi foo-bar 2 stdio' },
    ]);
    assert.deepEqual(idx.get('pypi foo-bar'), ['a/two', 'b/one']);
    assert.deepEqual(idx.get('npm ok'), ['b/one']);
    assert.equal(idx.size, 2);
  });
});

describe('쓰기', () => {
  test('scanner_notable 에 ignore-duplicates 로 쓴다 (다시 돌려도 중복 없음)', async () => {
    const calls: Array<{ url: string; prefer: string | null; body: unknown[] }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, prefer: new Headers(init.headers).get('Prefer'), body: JSON.parse(String(init.body)) });
      return new Response(null, { status: 201 });
    }) as unknown as typeof fetch;
    const { rows } = buildNotable(base({ npmChanges: [ch('a-pkg', 'deprecated', '1')] }));
    const n = await insertNotable({ url: 'https://db.example', key: 'sb_secret' }, rows, { fetchImpl });
    assert.equal(n, 1);
    assert.equal(calls[0]!.url, 'https://db.example/rest/v1/scanner_notable?on_conflict=day,rule_id,subject_kind,subject');
    assert.equal(calls[0]!.prefer, 'resolution=ignore-duplicates,return=minimal');
  });
});
