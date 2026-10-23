import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  chooseBin,
  classifyInstallFailure,
  installArgs,
  LineSplitter,
  nextState,
  planTargets,
  retryLimit,
  runArgs,
  targetKey,
  type SandboxStateRow,
} from './sandbox-lib.ts';
import { probeStdio } from './stdio-probe.ts';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-mcp.mjs');
const fast = { initTimeoutMs: 3_000, listTimeoutMs: 2_000, maxStdoutBytes: 4 << 20 };

describe('planTargets', () => {
  const registry = [
    { name: 'io.github.a/one', packages_key: 'npm @a/one 1.0.0 stdio', updated_at: '2026-10-20T00:00:00Z' },
    { name: 'io.github.b/two', packages_key: 'npm two 2.0.0 stdio\npypi two 2.0.0 stdio', updated_at: '2026-10-22T00:00:00Z' },
    { name: 'io.github.c/http', packages_key: 'npm three 1.0.0 streamable-http', updated_at: '2026-10-22T00:00:00Z' },
    { name: 'io.github.d/range', packages_key: 'npm four ^1.0.0 stdio', updated_at: '2026-10-21T00:00:00Z' },
    { name: 'io.github.e/gone', packages_key: 'npm gone 1.0.0 stdio', updated_at: '2026-10-21T00:00:00Z' },
    { name: 'io.github.f/bad', packages_key: 'npm Bad<Name> 1.0.0 stdio', updated_at: '2026-10-21T00:00:00Z' },
  ];
  const npm = [
    { ident: '@a/one', status: 'found', latest: '1.1.0', modified: '2026-10-23T00:00:00Z' },
    { ident: 'two', status: 'found', latest: '2.0.0', modified: '2026-10-01T00:00:00Z' },
    { ident: 'four', status: 'found', latest: '1.4.2', modified: '2026-10-10T00:00:00Z' },
    { ident: 'gone', status: 'not_found', latest: null, modified: null },
  ];

  test('stdio 선언만, 선언 버전 + npm 최신, 같은 버전은 하나로, 최근 것부터', () => {
    const { targets, stats } = planTargets(registry, npm, [], { limit: 100 });
    assert.deepEqual(
      targets.map((t) => [t.key, t.sources.join(',')]),
      [
        ['npm:@a/one@1.1.0', 'npm_latest'],
        ['npm:two@2.0.0', 'declared,npm_latest'],
        ['npm:@a/one@1.0.0', 'declared'],
        ['npm:four@1.4.2', 'npm_latest'],
      ],
    );
    assert.equal(stats.non_stdio, 1);
    assert.equal(stats.inexact_version, 1);
    assert.equal(stats.npm_not_found, 1);
    assert.equal(stats.invalid, 1);
  });

  test('끝난 대상은 빼고, 주 버전이 바뀌면 다시 돈다. limit', () => {
    const base = { registry_type: 'npm' as const, ident: 'two', version: '2.0.0', first_run_at: 'x', last_run_at: 'x' };
    const done = [{ ...base, target_key: targetKey('two', '2.0.0'), attempts: 1, done: true, last_outcome: 'ok', run_major: 1 }];
    assert.ok(!planTargets(registry, npm, done, { limit: 100 }).targets.some((t) => t.ident === 'two'));
    assert.ok(planTargets(registry, npm, done, { limit: 100, runMajor: 2 }).targets.some((t) => t.ident === 'two'));
    const notDone = [{ ...done[0]!, done: false, last_outcome: 'install_network' }];
    assert.ok(planTargets(registry, npm, notDone, { limit: 100 }).targets.some((t) => t.ident === 'two'));
    assert.equal(planTargets(registry, npm, [], { limit: 2 }).targets.length, 2);
  });
});

describe('상태 전이', () => {
  const t = { key: 'npm:x@1.0.0', registry_type: 'npm' as const, ident: 'x', version: '1.0.0', sources: ['declared' as const], fresh_at: '' };
  test('사실(ok, exited 등)은 한 번에 끝, 일시 오류는 3번, 시간 초과는 2번', () => {
    assert.equal(nextState(undefined, t, 'ok', 'n').done, true);
    assert.equal(nextState(undefined, t, 'exited', 'n').done, true);
    const a = nextState(undefined, t, 'install_network', 'n1');
    assert.equal(a.done, false);
    const b = nextState(a, t, 'install_network', 'n2');
    const c = nextState(b, t, 'install_network', 'n3');
    assert.deepEqual([b.done, c.done, c.attempts, c.first_run_at], [false, true, 3, 'n1']);
    assert.equal(nextState(nextState(undefined, t, 'init_timeout', 'n'), t, 'init_timeout', 'n').done, true);
    assert.equal(retryLimit('ok'), 1);
  });
  test('주 버전이 바뀌면 시도 횟수는 새로 센다', () => {
    const old: SandboxStateRow = { ...nextState(undefined, t, 'install_network', 'n'), attempts: 3, run_major: 0 };
    assert.equal(nextState(old, t, 'install_network', 'n').attempts, 1);
  });
});

describe('npm 설치 실패 분류', () => {
  test('코드별', () => {
    assert.deepEqual(classifyInstallFailure('npm error code E404\nnpm error 404 Not Found', false), { outcome: 'install_not_found', code: 'E404' });
    assert.deepEqual(classifyInstallFailure('npm ERR! code ETARGET', false), { outcome: 'install_version_not_found', code: 'ETARGET' });
    assert.deepEqual(classifyInstallFailure('npm error code ECONNRESET', false), { outcome: 'install_network', code: 'ECONNRESET' });
    assert.deepEqual(classifyInstallFailure('npm error code EBADENGINE', false), { outcome: 'install_failed', code: 'EBADENGINE' });
    assert.deepEqual(classifyInstallFailure('weird', true), { outcome: 'install_timeout', code: null });
    assert.deepEqual(classifyInstallFailure('npm error code <script>', false), { outcome: 'install_failed', code: null });
  });
});

describe('chooseBin (npx 규칙)', () => {
  test('문자열 bin, 하나, 여럿 중 이름 일치, 모호, 없음, 이상한 이름', () => {
    assert.deepEqual(chooseBin({ bin: 'dist/index.js' }, '@scope/srv'), { bin: 'srv', outcome: 'ok', count: 1 });
    assert.deepEqual(chooseBin({ bin: { 'my-mcp': 'a.js' } }, 'pkg'), { bin: 'my-mcp', outcome: 'ok', count: 1 });
    assert.deepEqual(chooseBin({ bin: { cli: 'a.js', pkg: 'b.js' } }, 'pkg'), { bin: 'pkg', outcome: 'ok', count: 2 });
    assert.deepEqual(chooseBin({ bin: { cli: 'a.js', srv: 'b.js' } }, 'pkg'), { bin: null, outcome: 'bin_ambiguous', count: 2 });
    assert.equal(chooseBin({}, 'pkg').outcome, 'no_bin');
    assert.equal(chooseBin(null, 'pkg').outcome, 'no_bin');
    assert.equal(chooseBin({ bin: { '../evil': 'a.js' } }, 'pkg').outcome, 'no_bin');
  });
});

describe('docker 인자', () => {
  const c = { image: 'img:1', runtime: 'runsc', uid: 10001, name: 'lds-x', workHost: '/var/lib/lowdown/work/t-1' };
  test('설치: 스크립트 안 돌림, 네트워크 bridge, 권한 없음', () => {
    const a = installArgs({ ...c, cacheHost: '/var/lib/lowdown/npm-cache' }, '@a/b', '1.0.0');
    for (const must of ['--ignore-scripts', '--read-only', 'no-new-privileges', 'ALL', 'runsc', '10001:10001', '@a/b@1.0.0']) assert.ok(a.includes(must), must);
    assert.equal(a[a.indexOf('--network') + 1], 'bridge');
  });
  test('실행: 네트워크 없음, 작업 폴더 읽기 전용, 환경변수는 HOME 만, 컨테이너 안 timeout', () => {
    const a = runArgs(c, 'srv', 60);
    assert.equal(a[a.indexOf('--network') + 1], 'none');
    assert.ok(a.includes('/var/lib/lowdown/work/t-1:/work:ro'));
    const envs = a.flatMap((v, i) => (v === '-e' ? [a[i + 1]] : []));
    assert.deepEqual(envs, ['HOME=/tmp']);
    assert.deepEqual(a.slice(-5), ['timeout', '-s', 'KILL', '60', '/work/node_modules/.bin/srv']);
    assert.ok(a.includes('-i'));
  });
});

describe('LineSplitter', () => {
  test('조각난 줄을 잇고, 빈 줄·CR 은 버리고, 상한을 넘으면 멈춘다', () => {
    const s = new LineSplitter(30);
    assert.deepEqual(s.push('{"a":'), []);
    assert.deepEqual(s.push('1}\r\n\n{"b"'), ['{"a":1}']);
    assert.deepEqual(s.push(':2}\n'), ['{"b":2}']);
    assert.deepEqual(s.push('x'.repeat(40)), []);
    assert.equal(s.overflow, true);
  });
});

describe('probeStdio (가짜 서버)', () => {
  const run = (mode: string, opts = fast) => probeStdio([process.execPath, FIXTURE, mode], opts);

  test('ok: initialize + tools/list, 원격 Scanner 와 같은 해시 필드', async () => {
    const r = await run('ok');
    assert.equal(r.outcome, 'ok');
    assert.equal(r.reached_level, 2);
    assert.equal(r.metadata.tool_count, 2);
    assert.deepEqual(r.metadata.capabilities, ['logging', 'tools']);
    assert.equal(r.metadata.server_version, '1.2.3');
    assert.equal(r.metadata.protocol_version, '2025-06-18');
    for (const k of ['schema_hash', 'desc_hash', 'names_hash', 'tool_set_hash']) assert.match(String(r.metadata[k]), /^[0-9a-f]{64}$/, k);
    assert.deepEqual(r.tool_names, ['add', 'echo']);
    assert.equal(r.tool_defs?.length, 2);
  });

  test('initialize 전에 끝남 → exited + 종료 코드, stderr 는 바이트 수만', async () => {
    const r = await run('exit');
    assert.equal(r.outcome, 'exited');
    assert.equal(r.exit_code, 3);
    assert.ok((r.metadata.stderr_bytes as number) > 0);
    assert.equal(JSON.stringify(r).includes('API key'), false);
  });

  test('응답 없음 → init_timeout', async () => {
    const r = await run('silent', { ...fast, initTimeoutMs: 500 });
    assert.equal(r.outcome, 'init_timeout');
  });

  test('initialize 오류 → init_error + 코드', async () => {
    const r = await run('init-error');
    assert.equal(r.outcome, 'init_error');
    assert.equal(r.metadata.rpc_error_code, -32000);
  });

  test('JSON 아닌 줄은 세고 넘어간다', async () => {
    const r = await run('junk');
    assert.equal(r.outcome, 'ok');
    assert.equal(r.metadata.nonjson_lines, 2);
  });

  test('서버의 요청에는 method not found 로 답하고 계속', async () => {
    const r = await run('request');
    assert.equal(r.outcome, 'ok');
    assert.equal(r.metadata.server_requests, 1);
  });

  test('initialize 뒤 끝남 → exited_after_init', async () => {
    const r = await run('crash-after-init');
    assert.equal(r.outcome, 'exited_after_init');
    assert.equal(r.reached_level, 1);
  });

  test('tools/list 오류 → list_error', async () => {
    const r = await run('list-error');
    assert.equal(r.outcome, 'list_error');
    assert.equal(r.metadata.rpc_error_code, -32601);
  });

  test('출력 폭주 → output_limit', async () => {
    const r = await run('flood', { ...fast, maxStdoutBytes: 1 << 20 });
    assert.equal(r.outcome, 'output_limit');
    assert.equal(r.metadata.output_limited, true);
  });

  test('실행 파일 없음 → runner_error', async () => {
    const r = await probeStdio(['/nonexistent/binary-xyz'], fast);
    assert.equal(r.outcome, 'runner_error');
  });
});
