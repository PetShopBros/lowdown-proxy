import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  errnoOf,
  isCredentialPath,
  logContainerId,
  mainRunActive,
  maskArgs,
  parseConnect,
  parseExec,
  parseObserveLog,
  parseOpenPath,
  planObserve,
  readQuotedList,
  withCidfile,
  type ObserveStateLite,
} from './observe-lib.ts';

// 2026-11-05 Lightsail 샌드박스에서 받은 실제 로그 줄(runsc-observe, gVisor strace) 형식 그대로.
// env 에는 일부러 비밀값 모양을 넣었다 → 결과 어디에도 나오면 안 된다.
const CID = '6c56d5e2b6d8f03a3d5163676cf10aca7a1da51f348cf6cd60e3dfd5b4182ecf';
const ENV = '["NODE_VERSION=24.22.1", "HOSTNAME=6c56d5e2b6d8", "HOME=/", "LEAK_TOKEN=sk-live-0123456789abcdefSECRET", "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", "PWD=/"]';
const P = (pid: number, tid: number, comm: string) => `I1104 19:08:24.400000       1 strace.go:607] [${String(pid).padStart(4)}:${String(tid).padStart(4)}] ${comm}`;
const execLine = (pid: number, comm: string, path: string, argv: string[], ret = '0 (0x0)') =>
  `${P(pid, pid, comm)} X execve(0x55569ae3d980 ${path}, 0x55569ae3d918 ${JSON.stringify(argv).replace(/","/g, '", "')}, 0x55569ae3d958 ${ENV}) = ${ret} (8.879µs)`;
const execEntry = (pid: number, comm: string, path: string, argv: string[]) =>
  `I1104 19:08:24.399999       1 strace.go:569] [${String(pid).padStart(4)}:${String(pid).padStart(4)}] ${comm} E execve(0x55569ae3d980 ${path}, 0x55569ae3d918 ${JSON.stringify(argv)}, 0x55569ae3d958 ${ENV})`;
const HEAD = `I1104 18:59:43.840776       1 cli.go:278] Args: [runsc-sandbox --root=/var/run/docker/runtime-runc/moby --strace=true --strace-syscalls=execve,execveat,connect,socket,sendto,sendmsg,openat,open --strace-log-size=256 boot --bundle=/run/containerd/io.containerd.runtime.v2.task/moby/${CID} --stdio-fds=18 ${CID}]
I1104 18:59:43.841609       1 config.go:637] Debug: false. Strace: true, max size: 256, syscalls: execve,execveat,connect,socket,sendto,sendmsg,openat,open`;

const BIN = '/work/node_modules/.bin/lowdown-selftest';
const T = ['timeout', '-s', 'KILL', '60', BIN];
const HARNESS = [
  `I1104 19:08:24.300000       1 kernel.go:1429] EXEC: []string{"docker-entrypoint.sh", "timeout", "-s", "KILL", "60", "${BIN}"}`,
  execEntry(1, 'docker-entrypoi', '/usr/local/sbin/timeout', T),
  execLine(1, 'docker-entrypoi', '/usr/local/sbin/timeout', T),
  execLine(1, 'docker-entrypoi', '/usr/local/bin/timeout', T),
  execLine(1, 'docker-entrypoi', '/usr/sbin/timeout', T),
  execLine(1, 'docker-entrypoi', '/usr/bin/timeout', T),
  execLine(3, 'timeout', BIN, [BIN]),
  execLine(3, 'lowdown-selftes', '/usr/local/sbin/node', ['node', BIN]),
  execLine(3, 'lowdown-selftes', '/usr/local/bin/node', ['node', BIN]),
  `${P(3, 3, 'lowdown-selftes')} X openat(AT_FDCWD /tmp, 0x7ee0 /usr/local/lib/node_modules/x.js, O_RDONLY|O_CLOEXEC, 0o0) = 17 (0x11) (5.1µs)`,
  `${P(3, 3, 'lowdown-selftes')} X openat(AT_FDCWD /tmp, 0x7ee0 /etc/passwd, O_RDONLY|O_CLOEXEC, 0o0) = 18 (0x12) (5.1µs)`,
].join('\n');

describe('parseObserveLog — 기준선(아무 동작 없는 서버)', () => {
  const s = parseObserveLog(`${HEAD}\n${HARNESS}\n`, BIN);
  test('컨테이너 ID', () => assert.equal(s.container_id, CID));
  test('하네스 실행은 사건이 아니다', () => {
    assert.equal(s.exec_total, 0);
    assert.equal(s.harness_execs, 3); // timeout(PATH 탐색 합침) · bin · node(PATH 탐색 합침)
    assert.deepEqual(s.events, []);
  });
  test('파일 열기는 수만 센다(인증 정보 경로가 아니면 사건 아님)', () => {
    assert.equal(s.opens_total, 2);
    assert.equal(s.credential_opens, 0);
  });
});

describe('parseObserveLog — 패키지 동작', () => {
  const pkg = [
    // 파일: 인증 정보 경로(없음) · 상대 경로
    `${P(3, 9, 'libuv-worker')} X openat(AT_FDCWD /, 0x6d833b0 /tmp/.ssh/id_rsa, O_RDONLY|O_CLOEXEC, 0o0) = -1 errno=2 (no such file or directory) (11.088µs)`,
    `${P(3, 9, 'libuv-worker')} X openat(AT_FDCWD /app, 0x6d833b0 .env, O_RDONLY|O_CLOEXEC, 0o0) = 21 (0x15) (3µs)`,
    `${P(3, 9, 'libuv-worker')} X openat(AT_FDCWD /, 0x6d833b0 /proc/self/environ, O_RDONLY|O_CLOEXEC, 0o0) = -1 errno=13 (permission denied) (3µs)`,
    // libc 동작: nscd · DNS · 주소 정렬(빼야 함)
    `${P(3, 10, 'libuv-worker')} X connect(0x11 socket:[1], 0x7eaff4a7d1f0 {Family: AF_UNIX, Addr: "/var/run/nscd/socket"}, 0x6e) = -1 errno=2 (no such file or directory) (114.55µs)`,
    `${P(3, 10, 'libuv-worker')} X connect(0x11 socket:[2], 0x7eaff4a7d1f0 {Family: AF_UNIX, Addr: "/var/run/nscd/socket"}, 0x6e) = -1 errno=2 (no such file or directory) (8µs)`,
    `${P(3, 10, 'libuv-worker')} X connect(0x11 socket:[3], 0x7eaff4a7ed8c {Family: AF_INET, Addr: 172.26.0.2, Port: 53}, 0x10) = -1 errno=101 (network is unreachable) (14.94µs)`,
    `${P(3, 9, 'libuv-worker')} X connect(0x11 socket:[5], 0x7ee4a0001080 {Family: AF_INET6, Addr: 2606:4700::6810:122, Port: 0}, 0x1c) = -1 errno=101 (network is unreachable) (11.237µs)`,
    `${P(3, 9, 'libuv-worker')} X connect(0x11 socket:[5], 0x7ee4f123e6f0 {Family: AF_UNSPEC, family addr format unknown}, 0x10) = 0 (0x0) (1.26µs)`,
    `${P(3, 9, 'libuv-worker')} X connect(0x11 socket:[5], 0x7ee4a0001500 {Family: AF_INET, Addr: 104.16.4.34, Port: 0}, 0x10) = 0 (0x0) (34.323µs)`,
    // 실제 접속 시도
    `${P(3, 3, 'MainThread')} X connect(0x13 socket:[13], 0x7ed0a109bc40 {Family: AF_INET, Addr: 1.2.3.4, Port: 443}, 0x10) = -1 errno=101 (network is unreachable) (18.964µs)`,
    `${P(3, 3, 'MainThread')} X connect(0x13 socket:[14], 0x7ed0a109bc40 {Family: AF_INET6, Addr: 2001:db8::1, Port: 8443}, 0x1c) = -1 errno=101 (network is unreachable) (5µs)`,
    // 다른 프로그램 실행: sh, 그리고 node 자신을 다시 실행(이름이 같아도 패키지 동작)
    execLine(13, 'MainThread', '/bin/sh', ['/bin/sh', '-c', 'curl -H "Authorization: Bearer abc.def" https://user:pw@example.com --api-key 0123456789abcdefghij0123456789']),
    execLine(14, 'MainThread', '/usr/local/bin/node', ['node', '/work/node_modules/x/worker.js']),
    execLine(3, 'MainThread', '/usr/local/bin/node', ['node', BIN, '--child']),
    // E(진입) 줄과 파싱 못 하는 줄
    `${P(3, 3, 'MainThread')} E connect(0x13 socket:[13], 0x7ed0a109bc40 {Family: AF_INET, Addr: 9.9.9.9, Port: 443}, 0x10)`,
    `${P(3, 3, 'MainThread')} X connect(garbage`,
  ].join('\n');
  const s = parseObserveLog(`${HEAD}\n${HARNESS}\n${pkg}\n`, BIN);
  const ev = (kind: string) => s.events.filter((e) => e.kind === kind);

  test('인증 정보 경로: 결과를 구분한다', () => {
    assert.deepEqual(
      ev('credential_open').map((e) => [e.target, e.result]),
      [
        ['/tmp/.ssh/id_rsa', 'not_found'],
        ['/app/.env', 'opened'],
        ['/proc/self/environ', 'denied'],
      ],
    );
    assert.equal(s.opens_total, 5);
  });
  test('접속: 주소 정렬용 가짜 connect 는 빼고, nscd 는 남기고, 같은 것은 횟수로', () => {
    assert.deepEqual(
      ev('connect').map((e) => [e.target, e.result, e.count]),
      [
        ['unix:/var/run/nscd/socket', 'not_found', 2],
        ['1.2.3.4:443', 'unreachable', 1],
        ['[2001:db8::1]:8443', 'unreachable', 1],
      ],
    );
    assert.equal(s.connect_total, 4);
  });
  test('DNS: 53번 접속 시도만 센다', () => {
    assert.deepEqual(ev('dns_attempt').map((e) => [e.target, e.result]), [['172.26.0.2:53', 'unreachable']]);
    assert.equal(s.dns_attempts, 1);
  });
  test('실행: 하네스가 아닌 것은 sh·node 모두 남는다', () => {
    const ex = ev('exec');
    assert.deepEqual(ex.map((e) => e.target), ['/bin/sh', '/usr/local/bin/node', '/usr/local/bin/node']);
    assert.equal(ex[1]!.detail, '/work/node_modules/x/worker.js');
    assert.equal(ex[2]!.detail, `${BIN} --child`); // 하네스 pid 가 앞쪽 실행 뒤에 다시 실행 → 패키지 동작
    assert.equal(s.exec_total, 3);
    assert.equal(s.harness_execs, 3);
  });
  test('실행 인자의 비밀값 모양은 가려진다', () => {
    const d = ev('exec')[0]!.detail!;
    assert.match(d, /^-c curl /);
    assert.ok(!d.includes('abc.def'), d);
    assert.ok(!d.includes('user:pw'), d);
    assert.ok(!d.includes('0123456789abcdefghij0123456789'), d);
  });
  test('환경변수는 어디에도 남지 않는다', () => {
    const all = JSON.stringify(s);
    assert.ok(!all.includes('LEAK_TOKEN'), all);
    assert.ok(!all.includes('NODE_VERSION'), all);
    assert.ok(!all.includes('sk-live'), all);
  });
  test('E 줄은 세지 않고, 깨진 X 줄은 unparsed', () => {
    assert.ok(!s.events.some((e) => e.target.startsWith('9.9.9.9')));
    assert.equal(s.unparsed_lines, 1);
  });
});

describe('parseObserveLog — 상한', () => {
  test('서로 다른 사건 200개 넘으면 버리고 센다', () => {
    const lines = Array.from({ length: 250 }, (_, i) => `${P(3, 3, 'MainThread')} X connect(0x13 socket:[1], 0x7 {Family: AF_INET, Addr: 10.0.${Math.floor(i / 250)}.${i % 250}, Port: 443}, 0x10) = -1 errno=101 (network is unreachable) (5µs)`);
    const s = parseObserveLog(`${HEAD}\n${HARNESS}\n${lines.join('\n')}\n`, BIN);
    assert.equal(s.events.length, 200);
    assert.equal(s.events_dropped, 50);
    assert.equal(s.connect_total, 250);
  });
  test('긴 인자는 200자에서 자른다', () => {
    const s = parseObserveLog(`${HEAD}\n${HARNESS}\n${execLine(20, 'node', '/bin/sh', ['/bin/sh', '-c', 'echo '.repeat(100)])}\n`, BIN);
    const d = s.events[0]!.detail!;
    assert.equal(Array.from(d).length, 201);
    assert.ok(d.endsWith('…'));
  });
});

describe('부품', () => {
  test('withCidfile', () => {
    assert.deepEqual(withCidfile(['run', '-i', '--rm', 'img'], '/x/cid'), ['run', '--cidfile', '/x/cid', '-i', '--rm', 'img']);
    assert.throws(() => withCidfile(['rm', 'x'], '/x'));
  });
  test('logContainerId', () => {
    assert.equal(logContainerId(HEAD), CID);
    assert.equal(logContainerId('nothing'), null);
  });
  test('errnoOf', () => {
    assert.equal(errnoOf('-1 errno=101 (network is unreachable)'), 101);
    assert.equal(errnoOf('17 (0x11)'), null);
  });
  test('readQuotedList: 이스케이프·잘림 표시', () => {
    const s = '["a", "b\\"c", "\\x41\\n"...]';
    assert.deepEqual(readQuotedList(s, 0), ['a', 'b"c', 'A\n']);
    assert.equal(readQuotedList('x', 0), null);
  });
  test('parseExec: execveat 도 읽는다', () => {
    assert.deepEqual(parseExec('execveat', 'AT_FDCWD /, 0x1 /bin/ls, 0x2 ["ls", "-l"], 0x3 ["A=1"], 0x0'), { path: '/bin/ls', argv: ['ls', '-l'] });
  });
  test('parseConnect', () => {
    assert.deepEqual(parseConnect('0x11 socket:[1], 0x7 {Family: AF_UNIX, Addr: "/run/x"}, 0x6e'), { family: 'AF_UNIX', addr: '/run/x', port: null });
  });
  test('parseOpenPath: open · 상대 경로 · .. 정리', () => {
    assert.equal(parseOpenPath('open', '0x7 /root/.aws/credentials, O_RDONLY, 0o0'), '/root/.aws/credentials');
    assert.equal(parseOpenPath('openat', 'AT_FDCWD /home/u, 0x7 ../u/.npmrc, O_RDONLY, 0o0'), '/home/u/.npmrc');
  });
  test('isCredentialPath', () => {
    for (const p of ['/.ssh/id_ed25519', '/tmp/.aws/credentials', '/x/.npmrc', '/x/.env.local', '/etc/shadow', '/proc/1/environ', '/x/.docker/config.json', '/x/.kube/config']) assert.ok(isCredentialPath(p), p);
    for (const p of ['/etc/passwd', '/work/node_modules/dotenv/lib/main.js', '/x/.environment', '/etc/hosts', '/x/.envrc']) assert.ok(!isCredentialPath(p), p);
  });
  test('maskArgs: 일반 인자는 그대로', () => {
    assert.equal(maskArgs(['--port', '3000', '/work/node_modules/@scope/server-filesystem-extended/dist/index.js']), '--port 3000 /work/node_modules/@scope/server-filesystem-extended/dist/index.js');
    assert.equal(maskArgs(['--token', 'abc']), '--token [masked]');
    assert.equal(maskArgs(['API_KEY=xyz']), 'API_KEY=[masked]');
    assert.equal(maskArgs(['--auth', '--verbose']), '--auth --verbose');
  });
});

describe('planObserve · mainRunActive', () => {
  const row = (k: string, outcome: string, at: string, type: 'npm' | 'pypi' = 'npm'): ObserveStateLite => ({ target_key: `${type}:${k}@1.0.0`, registry_type: type, ident: k, version: '1.0.0', last_outcome: outcome, last_run_at: at });
  const state = [row('a', 'ok', '2026-11-01T00:00:00Z'), row('b', 'ok', '2026-11-03T00:00:00Z'), row('c', 'exited', '2026-11-04T00:00:00Z'), row('d', 'ok', '2026-11-02T00:00:00Z', 'pypi'), row('e', 'ok', '2026-11-04T00:00:00Z')];
  test('ok 만, 관측한 것 제외, 최근 순, 상한', () => {
    assert.deepEqual(planObserve(state, new Set(['npm:e@1.0.0']), 10, { pypi: true }).map((r) => r.ident), ['b', 'd', 'a']);
    assert.deepEqual(planObserve(state, new Set(), 2, { pypi: false }).map((r) => r.ident), ['e', 'b']);
  });
  test('기존 실행 중이면 겹치지 않는다', () => {
    const now = Date.parse('2026-11-05T03:00:00Z');
    assert.equal(mainRunActive({ started_at: '2026-11-04T21:50:00Z', finished_at: null }, now), true);
    assert.equal(mainRunActive({ started_at: '2026-11-04T21:50:00Z', finished_at: '2026-11-05T01:00:00Z' }, now), false);
    assert.equal(mainRunActive({ started_at: '2026-11-04T10:00:00Z', finished_at: null }, now), false); // 6시간 넘게 안 끝남 = 멈춘 실행
    assert.equal(mainRunActive(null, now), false);
  });
});
