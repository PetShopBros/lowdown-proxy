import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  applyCorrection,
  buildDay,
  DAY_CORRECTIONS,
  registryCoversSince,
  dayWriteDecision,
  daySummaryText,
  FEED_DAYS,
  firstObservedSection,
  declaredKey,
  packageSide,
  PACKAGE_HTML_MAX_LINES,
  parseDay,
  registrySection,
  renderSite,
  serializeDay,
  toolDefinitionSection,
} from './market-lib.ts';
import type { MarketDay, ObservationSummary, PackagesSection } from './market-lib.ts';

const SITE = { baseUrl: 'https://example.github.io/lowdown-data/', apiBase: 'https://api.example' };
const OBS: ObservationSummary = { cohort_version: 'v2', cohort_size: 5000, targets_observed: 4977, probe_attempts: 5010, reached_level: { '0': 1900, '1': 20, '2': 3090 } };

function day(d: string, over: Partial<Parameters<typeof buildDay>[0]> = {}): MarketDay {
  return buildDay({
    day: d,
    dataAsOf: `${d}T01:40:00.000Z`,
    scanRunId: '00000000-0000-4000-8000-000000000001',
    registryRows: [],
    observations: { current: OBS, previous: null },
    toolDefinitions: null,
    firstSeenRows: [],
    ...over,
  });
}

describe('시장판 — Registry 섹션', () => {
  test('종류별 건수, 이름순, 허용 형식 아닌 이름은 개수로만', () => {
    const r = registrySection([
      { name: 'io.github.b/two', kind: 'new', old_value: null, new_value: null, hosts: ['b.example.com'] },
      { name: 'io.github.a/one', kind: 'new', old_value: null, new_value: null, hosts: ['a.example.com', 'a.example.com'] },
      { name: '<script>alert(1)</script>', kind: 'new', old_value: null, new_value: null, hosts: [] },
      { name: 'io.github.c/three', kind: 'version', old_value: '1.0.0', new_value: '1.1.0<img>', hosts: [] },
      { name: 'io.github.d/four', kind: 'description', old_value: 'abcd1234', new_value: 'ef567890', hosts: [] },
      { name: 'io.github.e/five', kind: 'remotes', old_value: 'streamable-http https://secret.example/mcp?key=x', new_value: '', hosts: ['secret.example'] },
      { name: 'io.github.f/six', kind: 'bogus', old_value: null, new_value: null, hosts: [] },
    ]);
    assert.equal(r.counts.new, 3);
    assert.equal(r.unlisted, 1);
    assert.deepEqual(r.items.new.map((i) => i.name), ['io.github.a/one', 'io.github.b/two']);
    assert.deepEqual(r.items.new[0]!.hosts, ['a.example.com']);
    assert.deepEqual([r.items.version[0]!.old, r.items.version[0]!.new], ['1.0.0', null]);
    // 설명 해시·원격 URL 은 싣지 않는다
    const json = JSON.stringify(r);
    assert.ok(!json.includes('abcd1234'));
    assert.ok(!json.includes('key=x'));
    assert.ok(!json.includes('bogus'));
  });
});

describe('시장판 — First observed', () => {
  test('tool_name 은 호스트 2 + 네임스페이스 2 이상만, 형식 아닌 값 제외', () => {
    const f = firstObservedSection([
      { kind: 'tool_name', value: 'search', hosts: 2, namespaces: 2 },
      { kind: 'tool_name', value: 'solo', hosts: 1, namespaces: 3 },
      { kind: 'capability', value: 'tools', hosts: 1, namespaces: 1 },
      { kind: 'tool_name', value: 'bad name <x>', hosts: 9, namespaces: 9 },
      { kind: 'other', value: 'x', hosts: 9, namespaces: 9 },
    ]);
    assert.deepEqual(f, [
      { kind: 'capability', value: 'tools' },
      { kind: 'tool_name', value: 'search' },
    ]);
  });
});

describe('시장판 — 도구 정의 변화', () => {
  test('(대상, 원격) 단위 비교, 양쪽 L2 만 분모, 네임스페이스 수', () => {
    const prev = [
      { target_id: 'mcp:io.github.p/a', remote_url: 'https://a/1', reached_level: 2, desc_hash: 'd1', schema_hash: 's1' },
      { target_id: 'mcp:io.github.p/a', remote_url: 'https://a/2', reached_level: 2, desc_hash: 'dX', schema_hash: 's1' },
      { target_id: 'mcp:io.github.p/b', remote_url: 'https://b', reached_level: 2, desc_hash: 'd2', schema_hash: 's2' },
      { target_id: 'mcp:com.q/c', remote_url: 'https://c', reached_level: 2, desc_hash: 'd3', schema_hash: 's3' },
      { target_id: 'mcp:com.q/down', remote_url: 'https://down', reached_level: 2, desc_hash: 'd4', schema_hash: 's4' },
    ];
    const cur = [
      { target_id: 'mcp:io.github.p/a', remote_url: 'https://a/1', reached_level: 2, desc_hash: 'd1', schema_hash: 's1' },
      { target_id: 'mcp:io.github.p/a', remote_url: 'https://a/2', reached_level: 2, desc_hash: 'dX', schema_hash: 's1' },
      { target_id: 'mcp:io.github.p/b', remote_url: 'https://b', reached_level: 2, desc_hash: 'd2b', schema_hash: 's2b' },
      { target_id: 'mcp:com.q/c', remote_url: 'https://c', reached_level: 2, desc_hash: 'd3', schema_hash: 's3b' },
      { target_id: 'mcp:com.q/down', remote_url: 'https://down', reached_level: 0, desc_hash: null, schema_hash: null },
    ];
    const t = toolDefinitionSection(cur, prev, '2026-10-20T01:40:00Z');
    // 원격 두 개가 서로 다른 desc 를 내도 같은 원격끼리 비교하므로 가짜 변경이 없다
    assert.deepEqual({ ...t }, { compared: 4, description_changed: 1, schema_changed: 2, namespaces_with_changes: 2, previous_data_as_of: '2026-10-20T01:40:00Z' });
  });
});

describe('시장판 — 멱등·잠금', () => {
  test('같은 입력은 같은 바이트, 생성 시각 없음, 왕복 파싱', () => {
    const a = serializeDay(day('2026-10-21'));
    const b = serializeDay(day('2026-10-21'));
    assert.equal(a, b);
    assert.ok(!a.includes('generated'));
    assert.deepEqual(parseDay(a), day('2026-10-21'));
  });
  test('바이트가 같으면 unchanged, 더 새로운 날이 있으면 과거 날은 잠금, 최신·새 날은 write', () => {
    const t = serializeDay(day('2026-10-21'));
    assert.equal(dayWriteDecision('2026-10-21', ['2026-10-21'], t, t), 'unchanged');
    assert.equal(dayWriteDecision('2026-10-20', ['2026-10-20', '2026-10-21'], 'old', t), 'past_day_locked');
    assert.equal(dayWriteDecision('2026-10-21', ['2026-10-20', '2026-10-21'], 'old', t), 'write');
    assert.equal(dayWriteDecision('2026-10-22', ['2026-10-21'], null, t), 'write');
  });
  test('출처(source): siteBaseUrl 을 주면 싣고, 생성 시각 없이 결정적, 이전 파일(출처 없음)도 읽는다', () => {
    const withSrc = day('2026-10-22', { siteBaseUrl: SITE.baseUrl });
    assert.deepEqual(withSrc.source, {
      name: 'Lowdown',
      page: `${SITE.baseUrl}days/2026-10-22.html`,
      dataset: 'https://github.com/PetShopBros/lowdown-data',
      license: 'CC BY 4.0',
      license_url: 'https://creativecommons.org/licenses/by/4.0/',
      cite: `Lowdown, MCP daily record 2026-10-22 (data as of 2026-10-22T01:40:00.000Z), ${SITE.baseUrl}days/2026-10-22.html, CC BY 4.0`,
    });
    assert.equal(serializeDay(withSrc), serializeDay(day('2026-10-22', { siteBaseUrl: SITE.baseUrl })));
    assert.ok(!('source' in day('2026-10-21')));
    assert.equal(parseDay(serializeDay(day('2026-10-21'))).source, undefined);
  });
  test('잘못된 날짜·다른 스키마는 거부', () => {
    assert.throws(() => day('2026/10/21'));
    assert.throws(() => parseDay('{"schema":"x","day":"2026-10-21"}'));
  });
});

describe('시장판 — 사이트 렌더링', () => {
  const days = [
    day('2026-10-20'),
    day('2026-10-21', {
      registryRows: [{ name: 'io.github.a/one', kind: 'new', old_value: null, new_value: null, hosts: ['a.example.com'] }],
      observations: { current: OBS, previous: { ...OBS, targets_observed: 4970 } },
      toolDefinitions: { compared: 2900, description_changed: 140, schema_changed: 60, namespaces_with_changes: 30, previous_data_as_of: '2026-10-20T01:40:00.000Z' },
      firstSeenRows: [{ kind: 'capability', value: 'tasks', hosts: 1, namespaces: 1 }],
    }),
  ];
  const files = renderSite(days, SITE);

  test('필요한 파일 전부, 같은 입력은 같은 출력', () => {
    for (const f of ['index.html', 'days/2026-10-20.html', 'days/2026-10-21.html', 'days/index.html', 'about.html', 'feed.xml', 'feed.json', 'sitemap.xml', 'robots.txt', '.nojekyll']) assert.ok(files.has(f), f);
    assert.deepEqual([...renderSite(days, SITE)], [...files]);
  });

  test('HTML·RSS·JSON Feed 는 같은 하루 JSON 에서 같은 요약 문장', () => {
    const summary = daySummaryText(days[1]!);
    const feed = JSON.parse(files.get('feed.json')!) as { items: Array<{ id: string; content_text: string; date_published: string }> };
    assert.equal(feed.items[0]!.content_text, summary);
    assert.equal(feed.items[0]!.date_published, days[1]!.data_as_of);
    assert.equal(feed.items[0]!.id, `${SITE.baseUrl}days/2026-10-21.html`);
    assert.ok(files.get('feed.xml')!.includes(summary.replace(/&/g, '&amp;')));
    assert.ok(files.get('days/2026-10-21.html')!.includes(summary.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')));
    assert.equal(feed.items.length, 2);
  });

  test('최신 페이지 = 마지막 날, 이름 링크는 ref=market 조회, 순위·점수 단어 없음', () => {
    const idx = files.get('index.html')!;
    assert.ok(idx.includes('MCP daily record — 2026-10-21'));
    assert.ok(idx.includes('https://api.example/api/reputation/mcp:io.github.a/one?ref=market'));
    assert.ok(idx.includes('4,977 (+7)'));
    const body = idx.toLowerCase().replace('no scores or rankings', '');
    for (const w of ['rank', 'score', 'malicious', 'unsafe']) assert.ok(!body.includes(w), w);
  });

  test('기계용 경로·라이선스: 하루 페이지 head 에 하루 JSON alternate, 모든 페이지에 license, 피드에 출처', () => {
    const d21 = files.get('days/2026-10-21.html')!;
    assert.ok(d21.includes(`<link rel="alternate" type="application/json" title="Lowdown daily record 2026-10-21 (JSON, CC BY 4.0)" href="${SITE.baseUrl}days/2026-10-21.json">`));
    assert.ok(files.get('index.html')!.includes(`href="${SITE.baseUrl}days/2026-10-21.json">`));
    for (const f of ['index.html', 'days/2026-10-20.html', 'days/index.html', 'about.html']) assert.ok(files.get(f)!.includes('<link rel="license" href="https://creativecommons.org/licenses/by/4.0/">'), f);
    assert.ok(!files.get('about.html')!.includes('type="application/json"'));
    const feed = JSON.parse(files.get('feed.json')!) as { _lowdown: { license: string; dataset: string } };
    assert.equal(feed._lowdown.license, 'CC BY 4.0');
    assert.equal(feed._lowdown.dataset, 'https://github.com/PetShopBros/lowdown-data');
    const apiLinks = d21.match(/<a href="https:\/\/api\.example[^"]*"[^>]*>/g) ?? [];
    assert.ok(apiLinks.length > 0 && apiLinks.every((a) => a.includes('rel="nofollow"')));
  });

  test('about 은 First observed 와 미도달을 해석하지 않도록 정의한다', () => {
    const about = files.get('about.html')!;
    assert.ok(about.includes('does not mean the value is new to the market'));
    assert.ok(about.includes('not evidence that it is down, broken, or malicious'));
    assert.ok(about.includes('not evidence of malicious intent'));
  });

  test('days/latest.json = 가장 최근 하루 JSON 과 같은 바이트, 디스크에서 읽은 하루 JSON 으로도 같다', () => {
    const latest = files.get('days/latest.json')!;
    assert.equal(latest, serializeDay(days[1]!));
    const fromDisk = days.map((d) => parseDay(serializeDay(d)));
    assert.equal(renderSite(fromDisk, SITE).get('days/latest.json'), latest);
    assert.equal(parseDay(latest).day, '2026-10-21');
    assert.ok(!renderSite([], SITE).has('days/latest.json'));
    assert.ok(files.get('about.html')!.includes(`href="${SITE.baseUrl}days/latest.json"`));
  });

  test('about 에만 schema.org Dataset JSON-LD: 필수 name·description(50~5000자), 버전 있는 라이선스, 내려받기 경로', () => {
    const about = files.get('about.html')!;
    const m = about.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
    assert.ok(m);
    const ld = JSON.parse(m[1]!) as { '@type': string; name: string; description: string; license: string; url: string; temporalCoverage: string; distribution: Array<{ contentUrl: string; encodingFormat: string }> };
    assert.equal(ld['@type'], 'Dataset');
    assert.ok(ld.name.length > 0);
    assert.ok(ld.description.length >= 50 && ld.description.length <= 5000);
    assert.equal(ld.license, 'https://creativecommons.org/licenses/by/4.0/');
    assert.equal(ld.url, `${SITE.baseUrl}about.html`);
    assert.equal(ld.temporalCoverage, '2026-10-06/..');
    assert.ok(ld.distribution.some((x) => x.contentUrl === `${SITE.baseUrl}days/latest.json` && x.encodingFormat === 'application/json'));
    assert.ok(!m[1]!.includes('<'));
    for (const f of ['index.html', 'days/2026-10-21.html', 'days/index.html']) assert.ok(!files.get(f)!.includes('application/ld+json'), f);
    const body = about.toLowerCase().replace(/no scores, rankings or verdicts/g, '').replace(/nothing here is a score, a ranking, or a verdict/g, '').replace('no scores or rankings', '');
    for (const w of ['rank', 'score']) assert.ok(!body.includes(w), w);
  });

  test(`피드는 최근 ${FEED_DAYS}일만`, () => {
    const valid = Array.from({ length: FEED_DAYS + 5 }, (_, i) => day(new Date(Date.UTC(2026, 8, 1) + i * 86_400_000).toISOString().slice(0, 10)));
    const f = JSON.parse(renderSite(valid, SITE).get('feed.json')!) as { items: Array<{ id: string }> };
    assert.ok(f.items[0]!.id.endsWith(`${valid.at(-1)!.day}.html`));
    assert.equal(f.items.length, FEED_DAYS);
  });
});

describe('시장판 — Registry 를 비교하지 못한 날', () => {
  const rows = [{ name: 'io.github.a/one', kind: 'new', old_value: null, new_value: null, hosts: [] }];
  test('비교 안 한 날: compared=false, 이유, 0 을 변경 없음으로 쓰지 않는다', () => {
    const d = day('2026-10-30', { registryCompared: false });
    assert.equal(d.registry.compared, false);
    assert.match(d.registry.not_compared_reason ?? '', /not compared/);
    assert.match(daySummaryText(d), /^Registry: not compared on this day/);
    const html = renderSite([d], SITE).get('days/2026-10-30.html')!;
    assert.match(html, /Not compared on this day\./);
    assert.ok(!html.includes('New names'));
    assert.match(renderSite([d], SITE).get('days/index.html')!, /<td>not compared<\/td>/);
  });
  test('비교한 날은 필드가 없다(기존 파일과 같은 바이트)', () => {
    const d = day('2026-10-30', { registryRows: rows as never });
    assert.ok(!('compared' in d.registry));
    assert.ok(!('covers_since' in d.registry));
    assert.ok(!('corrections' in d));
  });
  test('직전 날들을 비교 못 했으면 그 첫 날짜부터 쌓인 변경', () => {
    const prev = [day('2026-10-27'), day('2026-10-28', { registryCompared: false }), day('2026-10-29', { registryCompared: false })];
    assert.equal(registryCoversSince(prev, '2026-10-30'), '2026-10-28');
    assert.equal(registryCoversSince([day('2026-10-29')], '2026-10-30'), null);
    const d = day('2026-10-30', { registryRows: rows as never, registryCoversSince: '2026-10-28' });
    assert.equal(d.registry.covers_since, '2026-10-28');
    assert.match(daySummaryText(d), /^Registry \(changes since 2026-10-28\)/);
  });
  test('정정: 목록에 있는 날만, 정정 기록과 함께, 두 번 적용해도 같다', () => {
    const c = DAY_CORRECTIONS[0]!;
    const fixed = applyCorrection(day(c.day));
    assert.equal(fixed.registry.compared, false);
    assert.deepEqual(fixed.corrections, [{ on: c.on, note: c.reason }]);
    assert.equal(serializeDay(applyCorrection(parseDay(serializeDay(fixed)))), serializeDay(fixed));
    assert.equal(applyCorrection(day('2026-10-22')).corrections, undefined);
    const html = renderSite([fixed], SITE).get(`days/${c.day}.html`)!;
    assert.match(html, /Correction \(2026-10-24\):/);
  });
});

describe('시장판 — 선언 패키지 섹션', () => {
  const declaredBy = new Map<string, string[]>([
    [declaredKey('npm', 'old-pkg'), ['io.github.a/one']],
    [declaredKey('npm', 'gone-pkg'), ['io.github.b/two', 'io.github.c/three']],
    [declaredKey('npm', 'busy-pkg'), ['io.github.d/four']],
    [declaredKey('pypi', 'My_Pkg'), ['io.github.e/five']],
    [declaredKey('npm', 'weird'), ['<script>']],
  ]);
  test('선언된 패키지만, 드문 사실은 이름까지, 새 버전은 개수만, 값은 허용 형식만', () => {
    const npm = packageSide(
      'npm',
      [
        { ident: 'old-pkg', kind: 'deprecated', old_value: '2.0.0', new_value: null },
        { ident: 'gone-pkg', kind: 'not_found', old_value: '1.0.0', new_value: null },
        { ident: 'busy-pkg', kind: 'latest_changed', old_value: '1.0.0', new_value: '1.0.1' },
        { ident: 'undeclared', kind: 'deprecated', old_value: '1.0.0', new_value: null },
        { ident: 'undeclared', kind: 'latest_changed', old_value: '1', new_value: '2' },
        { ident: 'old-pkg', kind: 'deprecated', old_value: '2.0.0', new_value: null },
        { ident: 'weird', kind: 'deprecated', old_value: '1', new_value: null },
        { ident: 'old-pkg', kind: 'bogus', old_value: null, new_value: null },
      ],
      declaredBy,
      true,
    );
    assert.equal(npm.latest_changed, 1);
    assert.deepEqual(
      npm.events.map((e) => [e.kind, e.package, e.old, e.declared_by]),
      [
        ['deprecated', 'old-pkg', '2.0.0', ['io.github.a/one']],
        ['not_found', 'gone-pkg', '1.0.0', ['io.github.b/two', 'io.github.c/three']],
      ],
    );
    const pypi = packageSide('pypi', [{ ident: 'my-pkg', kind: 'status_changed', old_value: 'active', new_value: 'archived' }], declaredBy, true);
    assert.deepEqual([pypi.events[0]!.old, pypi.events[0]!.new, pypi.events[0]!.declared_by], ['active', 'archived', ['io.github.e/five']]);
  });
  test('스냅샷이 안 돈 날: compared=false, 0 을 변화 없음으로 쓰지 않는다', () => {
    const s = packageSide('npm', [], declaredBy, false);
    assert.deepEqual(s, { compared: false, latest_changed: 0, events: [] });
    const p: PackagesSection = { snapshot_day: '2026-10-24', npm: s, pypi: packageSide('pypi', [], declaredBy, true) };
    const d = day('2026-10-25', { packages: p });
    const html = renderSite([d], SITE).get('days/2026-10-25.html')!;
    assert.match(html, /5\. Declared packages/);
    assert.match(html, /The npm snapshot did not run on 2026-10-24/);
    assert.match(daySummaryText(d), /Declared packages \(snapshot 2026-10-24\): npm not compared; PyPI 0 status facts, 0 new latest versions\./);
  });
  test('HTML: 같은 scope 10개 이상은 한 줄, 최대 줄 수 넘으면 JSON 안내, 판정 단어 없음', () => {
    const many = new Map<string, string[]>();
    const rows = [];
    for (let i = 0; i < 12; i++) {
      many.set(declaredKey('npm', `@acme/p${i}`), ['io.github.acme/x']);
      rows.push({ ident: `@acme/p${i}`, kind: 'deprecated', old_value: '1.0.0', new_value: null });
    }
    for (let i = 0; i < PACKAGE_HTML_MAX_LINES + 5; i++) {
      many.set(declaredKey('npm', `solo${i}`), ['io.github.s/y']);
      rows.push({ ident: `solo${i}`, kind: 'not_found', old_value: '1.0.0', new_value: null });
    }
    const npm = packageSide('npm', rows, many, true);
    assert.equal(npm.events.length, 12 + PACKAGE_HTML_MAX_LINES + 5);
    const d = day('2026-10-25', { packages: { snapshot_day: '2026-10-24', npm, pypi: packageSide('pypi', [], many, true) } });
    const html = renderSite([d], SITE).get('days/2026-10-25.html')!;
    assert.match(html, /12 packages in <code>@acme<\/code>/);
    assert.ok(!html.includes('@acme/p3'));
    assert.match(html, /6 more status facts are in/);
    assert.match(html, /<code>404<\/code> <code>solo0<\/code> — npm answered HTTP 404 \(last seen 1\.0\.0\)/);
    assert.ok(!/\b(risk|risky|unsafe|dangerous|abandoned)\b/i.test(html.split('5. Declared packages')[1]!));
    // JSON 에는 전부
    assert.equal(parseDay(serializeDay(d)).packages!.npm.events.length, npm.events.length);
  });
  test('스키마: 새 파일은 /2, /1 파일도 읽는다, packages 없는 날은 섹션 없음', () => {
    const d = day('2026-10-25');
    assert.equal(d.schema, 'lowdown-market-day/2');
    const old = serializeDay({ ...day('2026-10-21'), schema: 'lowdown-market-day/1' });
    assert.equal(parseDay(old).schema, 'lowdown-market-day/1');
    assert.ok(!renderSite([d], SITE).get('days/2026-10-25.html')!.includes('Declared packages'));
  });
});
