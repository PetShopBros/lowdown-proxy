import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  buildDay,
  dayWriteDecision,
  daySummaryText,
  FEED_DAYS,
  firstObservedSection,
  parseDay,
  registrySection,
  renderSite,
  serializeDay,
  toolDefinitionSection,
} from './market-lib.ts';
import type { MarketDay, ObservationSummary } from './market-lib.ts';

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

  test('about 은 First observed 와 미도달을 해석하지 않도록 정의한다', () => {
    const about = files.get('about.html')!;
    assert.ok(about.includes('does not mean the value is new to the market'));
    assert.ok(about.includes('not evidence that it is down, broken, or malicious'));
    assert.ok(about.includes('not evidence of malicious intent'));
  });

  test(`피드는 최근 ${FEED_DAYS}일만`, () => {
    const valid = Array.from({ length: FEED_DAYS + 5 }, (_, i) => day(new Date(Date.UTC(2026, 8, 1) + i * 86_400_000).toISOString().slice(0, 10)));
    const f = JSON.parse(renderSite(valid, SITE).get('feed.json')!) as { items: Array<{ id: string }> };
    assert.ok(f.items[0]!.id.endsWith(`${valid.at(-1)!.day}.html`));
    assert.equal(f.items.length, FEED_DAYS);
  });
});
