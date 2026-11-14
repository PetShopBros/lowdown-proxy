import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { buildToolNotable, fetchObservations, STABLE_MIN, type ObsIn } from './notable-tools-lib.ts';

const h = (c: string) => c.repeat(64).slice(0, 64);
const A = h('a');
const B = h('b');
const C = h('c');
const N1 = h('1');
const N2 = h('2');

/** 날짜 목록과 (schema, desc, names, version, count) 로 하루 1관찰 */
function series(target: string, days: Array<[string, string, string, string | null, string | null, number | null]>, remote = 'https://x.example/mcp'): ObsIn[] {
  return days.map(([day, sh, dh, nh, ver, cnt]) => ({
    target_id: target,
    observed_at: `${day}T01:20:00Z`,
    remote_url: remote,
    schema_hash: sh,
    desc_hash: dh,
    names_hash: nh,
    server_version: ver,
    tool_count: cnt === null ? null : String(cnt),
  }));
}
const day = (n: number) => `2026-10-${String(n).padStart(2, '0')}`;
/** 1..k일은 같은 정의(stable), 그 뒤 rest 를 잇는다 */
const stableThen = (k: number, base: [string, string, string | null, string | null, number | null], rest: Array<[string, string, string | null, string | null, number | null]>) =>
  [...Array.from({ length: k }, (_, i) => [day(i + 1), ...base] as [string, string, string, string | null, string | null, number | null]),
   ...rest.map((r, i) => [day(k + 1 + i), ...r] as [string, string, string, string | null, string | null, number | null])];

describe('레이다 2단계 — 도구 정의 규칙', () => {
  test('R2: 7번 이상 그대로이던 정의가 버전 변경 없이 바뀌고, 다음 관찰에서도 유지되면 기록', () => {
    const obs = series('mcp:io.github.Acme/tool', stableThen(STABLE_MIN + 1, [A, A, N1, '1.0.0', 5], [[B, A, N1, '1.0.0', 5], [B, A, N1, '1.0.0', 5]]));
    const { rows } = buildToolNotable(obs);
    assert.equal(rows.length, 1);
    const r = rows[0]!;
    assert.equal(r.rule_id, 'R2_changed_same_server_version');
    assert.equal(r.subject_kind, 'server');
    assert.equal(r.subject, 'io.github.Acme/tool');
    assert.equal(r.group_key, 'ns:io.github.acme');
    assert.equal(r.day, day(9));
    assert.deepEqual(r.evidence, {
      server: 'io.github.Acme/tool',
      kinds: ['schema'],
      tool_count: { from: 5, to: 5 },
      server_version: '1.0.0',
      unchanged_comparisons_before: 7,
      compared_with: day(8),
      confirmed_on: day(10),
      remotes_changed: 1,
    });
    assert.equal(JSON.stringify(r).includes(A), false, '해시는 내보내지 않는다');
    assert.equal(JSON.stringify(r).includes('x.example'), false, '원격 주소는 내보내지 않는다');
  });

  test('R1: 버전이 바뀌었거나 모르면 R1 (R2 와 겹치지 않는다)', () => {
    const changedVer = buildToolNotable(series('mcp:a.b/one', stableThen(8, [A, A, N1, '1.0.0', 3], [[A, B, N1, '1.1.0', 3], [A, B, N1, '1.1.0', 3]]))).rows;
    assert.deepEqual(changedVer.map((r) => r.rule_id), ['R1_first_change_after_stable']);
    assert.deepEqual(changedVer[0]!.evidence.server_version, { from: '1.0.0', to: '1.1.0' });
    const unknown = buildToolNotable(series('mcp:a.b/two', stableThen(8, [A, A, N1, null, 3], [[A, B, N1, null, 3], [A, B, N1, null, 3]]))).rows;
    assert.deepEqual(unknown.map((r) => r.rule_id), ['R1_first_change_after_stable']);
  });

  test('확인 조건: 다음 관찰이 없거나, 되돌아가거나, 또 바뀌면 기록하지 않는다', () => {
    const noNext = series('mcp:a.b/c', stableThen(8, [A, A, null, '1', 2], [[B, A, null, '1', 2]]));
    const reverted = series('mcp:a.b/c', stableThen(8, [A, A, null, '1', 2], [[B, A, null, '1', 2], [A, A, null, '1', 2]]));
    const again = series('mcp:a.b/c', stableThen(8, [A, A, null, '1', 2], [[B, A, null, '1', 2], [C, A, null, '1', 2]]));
    for (const obs of [noNext, reverted, again]) assert.equal(buildToolNotable(obs).rows.length, 0);
  });

  test('안정 조건: 7번 미만 그대로였으면 R1·R2 를 내지 않는다 (번갈아 바뀌는 서버)', () => {
    const flapping = series('mcp:a.b/c', [
      [day(1), A, A, null, '1', 2], [day(2), B, A, null, '1', 2], [day(3), A, A, null, '1', 2], [day(4), B, A, null, '1', 2], [day(5), B, A, null, '1', 2],
    ]);
    assert.equal(buildToolNotable(flapping).rows.length, 0);
    const short = series('mcp:a.b/c', stableThen(STABLE_MIN, [A, A, null, '1', 2], [[B, A, null, '1', 2], [B, A, null, '1', 2]]));
    assert.equal(buildToolNotable(short).rows.length, 0, '비교 6번 그대로 → 아직 아님');
  });

  test('R3: 이름이 바뀌고 도구 수가 줄면, 안정 조건 없이(확인 조건은 같게) 기록. 안정했으면 R1/R2 와 함께', () => {
    const quick = series('mcp:a.b/r3', [[day(1), A, A, N1, '1', 10], [day(2), B, B, N2, '1', 8], [day(3), B, B, N2, '1', 8]]);
    assert.deepEqual(buildToolNotable(quick).rows.map((r) => r.rule_id), ['R3_tool_removed']);
    const stable = series('mcp:a.b/r3', stableThen(8, [A, A, N1, '1', 10], [[B, B, N2, '1', 8], [B, B, N2, '1', 8]]));
    const rows = buildToolNotable(stable).rows;
    assert.deepEqual(rows.map((r) => r.rule_id), ['R2_changed_same_server_version', 'R3_tool_removed']);
    assert.deepEqual(rows[1]!.evidence.kinds, ['schema', 'desc', 'names']);
    assert.deepEqual(rows[1]!.evidence.tool_count, { from: 10, to: 8 });
    // 이름이 바뀌었어도 늘었으면 R3 아님
    const added = series('mcp:a.b/r3', [[day(1), A, A, N1, '1', 8], [day(2), B, B, N2, '1', 10], [day(3), B, B, N2, '1', 10]]);
    assert.equal(buildToolNotable(added).rows.length, 0);
  });

  test('원격이 여럿이면 서버 기준 한 행, 바뀐 원격 수만', () => {
    const rest: Array<[string, string, string | null, string | null, number | null]> = [[B, A, N1, '1.4.0', 3], [B, A, N1, '1.4.0', 3]];
    const obs = [
      ...series('mcp:io.optionwhales/options-flow', stableThen(8, [A, A, N1, '1.4.0', 3], rest), 'https://one.example/mcp'),
      ...series('mcp:io.optionwhales/options-flow', stableThen(8, [A, A, N1, '1.4.0', 3], rest), 'https://two.example/mcp'),
    ];
    const { rows } = buildToolNotable(obs);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.evidence.remotes_changed, 2);
  });

  test('하루 여러 관찰은 그날 마지막 것, 해시 형식이 아니면 버린다, 이름 형식이 아니면 건너뛴다', () => {
    const obs = series('mcp:a.b/c', stableThen(8, [A, A, null, '1', 2], [[B, A, null, '1', 2], [B, A, null, '1', 2]]));
    obs.push({ ...obs[8]!, observed_at: `${day(9)}T00:10:00Z`, schema_hash: C }); // 같은 날 더 이른 관찰 → 무시
    obs.push({ ...obs[0]!, schema_hash: 'not-a-hash', observed_at: `${day(1)}T05:00:00Z` }); // 형식 아님 → 무시
    obs.push({ ...obs[0]!, target_id: '<b>bad</b>' });
    const { rows, skipped } = buildToolNotable(obs);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.evidence.compared_with, day(8));
    assert.equal(skipped, 1);
  });

  test('같은 입력이면 같은 결과(정렬 고정)', () => {
    const obs = [
      ...series('mcp:z.z/z', stableThen(8, [A, A, null, '1', 2], [[B, A, null, '1', 2], [B, A, null, '1', 2]])),
      ...series('mcp:a.a/a', stableThen(8, [A, A, null, '1', 2], [[B, A, null, '1', 2], [B, A, null, '1', 2]])),
    ];
    const a = buildToolNotable(obs).rows;
    const b = buildToolNotable([...obs].reverse()).rows;
    assert.deepEqual(a, b);
    assert.deepEqual(a.map((r) => r.subject), ['a.a/a', 'z.z/z']);
  });
});

describe('관찰 읽기', () => {
  test('고정 표본·L2·기간만, (observed_at, id) keyset 으로 끝까지, id 순서로 돌려줌', async () => {
    const urls: string[] = [];
    let call = 0;
    const fetchImpl = (async (url: string) => {
      urls.push(url);
      call++;
      // 관찰 시각 순서와 id 순서가 다른 경우: 시각 순으로 받아도 결과는 id 오름차순
      const page =
        call === 1
          ? [{ id: 2, target_id: 'mcp:a.b/c', observed_at: '2026-10-09T00:00:00Z' }, { id: 1, target_id: 'mcp:a.b/c', observed_at: '2026-10-09T00:00:01Z' }]
          : [{ id: 3, target_id: 'mcp:a.b/c', observed_at: '2026-10-09T00:00:02Z' }];
      return new Response(JSON.stringify(page), { status: 200 });
    }) as unknown as typeof fetch;
    const rows = await fetchObservations({ url: 'https://db.example', key: 'sb_secret' }, '2026-10-08T00:00:00.000Z', { fetchImpl, pageSize: 2 });
    assert.deepEqual(rows.map((r) => r.id), [1, 2, 3]);
    const u0 = new URL(urls[0]!);
    assert.equal(u0.searchParams.get('order'), 'observed_at.asc,id.asc');
    assert.equal(u0.searchParams.get('or'), null);
    assert.equal(u0.searchParams.get('observed_at'), 'gte.2026-10-08T00:00:00.000Z');
    const u = new URL(urls[1]!);
    assert.equal(u.searchParams.get('id'), null);
    assert.equal(u.searchParams.get('or'), '(observed_at.gt."2026-10-09T00:00:01Z",and(observed_at.eq."2026-10-09T00:00:01Z",id.gt.1))');
    assert.equal(u.searchParams.get('source'), 'eq.scanner');
    assert.equal(u.searchParams.get('reached_level'), 'eq.2');
    // 둘째 페이지부터 하한을 마지막 행 시각으로 올린다(인덱스 범위를 좁힘, or 조건과 함께 같은 결과)
    assert.equal(u.searchParams.get('observed_at'), 'gte.2026-10-09T00:00:01Z');
  });
});
