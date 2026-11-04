// Lowdown 샌드박스 행동 관측 — 순수 함수 (2026-11-05, supabase/2026-11-05_sandbox_observe.sql)
// 실행 단계(initialize + tools/list)를 gVisor strace 가 켜진 런타임(runsc-observe)으로 한 번 더 돌리고,
// 그 로그에서 "시도한 사실"만 뽑는다: 실행(exec) · 접속(connect) · DNS 시도(dns_attempt) · 인증 정보 경로 열기(credential_open).
// 판정(위험·악성 등)은 하지 않는다. 결과는 비공개 테이블에만 쓴다.
//
// 지키는 것
//   - 환경변수는 읽지도 저장하지도 않는다(execve 의 envp 는 파싱하지 않는다).
//   - 실행 인자는 비밀값 모양을 가리고([masked]) 200자로 자른다.
//   - 하네스(entrypoint → timeout → bin → 인터프리터) 실행은 이름이 아니라 순서·pid 로 뺀다. 그 밖의 실행은 sh·node 여도 남긴다.
//   - glibc 주소 정렬용 가짜 connect(Port 0, AF_UNSPEC)는 뺀다. nscd 소켓 접속 같은 libc 동작은 남긴다(사실이므로).
//   - DNS 이름은 strace 에 나오지 않는다(sendto 내용이 찍히지 않음) → 지금은 53번 포트 접속 시도만 센다.

import { posix } from 'node:path';

/** 관측 방식의 주 버전. 파서 규칙이 바뀌어 같은 대상을 다시 관측해야 하면 올린다. */
export const OBSERVE_MAJOR = 1;
export const OBSERVE_DEFAULT_RUNTIME = 'runsc-observe';
export const OBSERVE_DEFAULT_LOG_DIR = '/var/log/lowdown-strace';
/** 로그는 이 크기까지만 읽는다(넘으면 log_truncated). 기준선은 30~70KB. */
export const OBSERVE_MAX_LOG_BYTES = 16 * 1024 * 1024;
/** 한 실행에서 남기는 서로 다른 사건 수 상한(넘는 것은 events_dropped 로 센다) */
export const OBSERVE_MAX_EVENTS = 200;
export const OBSERVE_DETAIL_MAX = 200;
const TARGET_MAX = 300;

export type ObserveKind = 'exec' | 'connect' | 'dns_attempt' | 'credential_open';

export interface ObserveEvent {
  kind: ObserveKind;
  target: string;
  detail: string | null;
  result: string;
  count: number;
}

export interface ObserveSummary {
  container_id: string | null;
  events: ObserveEvent[];
  events_dropped: number;
  opens_total: number;
  exec_total: number;
  harness_execs: number;
  connect_total: number;
  dns_attempts: number;
  credential_opens: number;
  unparsed_lines: number;
}

// ─────────────────────────────────────────────
// docker 인자
// ─────────────────────────────────────────────

/** `docker run ...` 인자에 --cidfile 을 넣는다(로그 파일을 컨테이너 ID 로 찾기 위해). 나머지 인자는 그대로. */
export function withCidfile(args: readonly string[], cidfile: string): string[] {
  const i = args.indexOf('run');
  if (i < 0) throw new Error('withCidfile: not a docker run');
  return [...args.slice(0, i + 1), '--cidfile', cidfile, ...args.slice(i + 1)];
}

/** 로그 앞부분의 `Args: [runsc-sandbox ... <64hex>]` 에서 컨테이너 ID */
export function logContainerId(head: string): string | null {
  const m = /Args: \[[^\n]*?\b([0-9a-f]{64})\]/.exec(head);
  return m ? m[1]! : null;
}

// ─────────────────────────────────────────────
// 결과 값
// ─────────────────────────────────────────────

const ERRNO: Record<number, string> = {
  1: 'denied', // EPERM
  2: 'not_found', // ENOENT
  13: 'denied', // EACCES
  97: 'unsupported', // EAFNOSUPPORT
  99: 'addr_unavailable',
  101: 'unreachable', // ENETUNREACH (--network none)
  110: 'timeout',
  111: 'refused',
  113: 'unreachable', // EHOSTUNREACH
  115: 'in_progress', // EINPROGRESS (비차단 소켓: 결과는 connect 줄만으로 모른다)
};

/** "-1 errno=2 (no such file or directory)" → errno 2, "17 (0x11)" → null */
export function errnoOf(result: string): number | null {
  const m = /^-1 errno=(\d+)/.exec(result.trim());
  return m ? Number(m[1]) : null;
}

export function resultLabel(result: string, okLabel: string): string {
  const e = errnoOf(result);
  if (e === null) return okLabel;
  return ERRNO[e] ?? `errno_${e}`;
}

// ─────────────────────────────────────────────
// 인증 정보 경로
// ─────────────────────────────────────────────

const CREDENTIAL_PATTERNS: readonly RegExp[] = [
  /\/\.ssh\//,
  /\/id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/,
  /\/\.aws\/(credentials|config)$/,
  /\/\.azure\//,
  /\/\.config\/gcloud\//,
  /\/\.kube\/config$/,
  /\/\.docker\/config\.json$/,
  /\/\.npmrc$/,
  /\/\.pypirc$/,
  /\/\.netrc$/,
  /\/\.git-credentials$/,
  /\/\.config\/gh\/hosts\.ya?ml$/,
  /\/\.cargo\/credentials(\.toml)?$/,
  /\/\.terraform\.d\/credentials\.tfrc\.json$/,
  /\/\.gnupg\//,
  /\/\.env(\.[\w.-]+)?$/,
  /^\/etc\/shadow$/,
  /^\/etc\/gshadow$/,
  /^\/proc\/(self|\d+)\/environ$/,
  /\/\.config\/(google-chrome|chromium|BraveSoftware)\//,
  /\/\.mozilla\/firefox\//,
  /\/\.(ethereum|bitcoin|electrum)\//,
  /\/\.config\/solana\/id\.json$/,
];

export function isCredentialPath(path: string): boolean {
  return CREDENTIAL_PATTERNS.some((re) => re.test(path));
}

// ─────────────────────────────────────────────
// 인자 가리기
// ─────────────────────────────────────────────

const SECRET_WORD = '(?:token|secret|passw(?:or)?d|pwd|api[_-]?key|apikey|access[_-]?key|private[_-]?key|auth|bearer|credential|session)';
const KV_SECRET = new RegExp(`\\b([A-Za-z0-9_-]*${SECRET_WORD}[A-Za-z0-9_-]*)([=:])(?!\\[masked\\])\\S+`, 'gi');
const FLAG_SECRET = new RegExp(`(--?[A-Za-z0-9_-]*${SECRET_WORD}[A-Za-z0-9_-]*)\\s+(?!-)(?!\\[masked\\])\\S+`, 'gi');

function cut(s: string, max: number): string {
  const cps = Array.from(s);
  return cps.length > max ? `${cps.slice(0, max).join('')}…` : s;
}

/** 실행 인자 → 저장용 문자열. 비밀값 모양을 가리고 200자로 자른다. */
export function maskArgs(args: readonly string[]): string {
  let s = args.join(' ');
  s = s.replace(/(\/\/)[^/\s:@]+:[^@\s/]+@/g, '$1[masked]@'); // URL 안 사용자:비밀번호
  s = s.replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]*)?/g, '[masked]'); // JWT
  s = s.replace(/\b(Bearer)\s+\S+/gi, '$1 [masked]');
  s = s.replace(KV_SECRET, '$1$2[masked]');
  s = s.replace(FLAG_SECRET, '$1 [masked]');
  // 긴 토큰 덩어리(문자·숫자가 4개 이상씩 섞인 24자 이상). 경로(/)·점(.)이 든 것은 대상 아님
  s = s.replace(/[A-Za-z0-9_+=-]{24,}/g, (m) => {
    const digits = (m.match(/\d/g) ?? []).length;
    const letters = (m.match(/[A-Za-z]/g) ?? []).length;
    return digits >= 4 && letters >= 4 ? '[masked]' : m;
  });
  return cut(s, OBSERVE_DETAIL_MAX);
}

// ─────────────────────────────────────────────
// strace 줄 파싱
// ─────────────────────────────────────────────

// I1104 18:59:44.422633  1 strace.go:607] [   1:   1] MainThread X connect(...) = -1 errno=101 (network is unreachable) (18.964µs)
const SYSCALL_HINT = / X (execve|execveat|connect|openat|open)\(/;
const LINE = /\] \[\s*(\d+):\s*(\d+)\] (.*?) X (execve|execveat|connect|openat|open)\((.*)\) = (.+?) \([\d.]+[^()]*\)$/;

interface Raw {
  pid: number;
  call: string;
  args: string;
  result: string;
}

export function parseLine(line: string): Raw | null {
  const m = LINE.exec(line);
  if (!m) return null;
  return { pid: Number(m[1]), call: m[4]!, args: m[5]!, result: m[6]! };
}

/** Go %q 로 찍힌 문자열 목록 `["a", "b\"c"]` 을 읽는다. 잘린 표시(...)는 건너뛴다. */
export function readQuotedList(s: string, start: number): string[] | null {
  if (s[start] !== '[') return null;
  const out: string[] = [];
  let i = start + 1;
  for (;;) {
    while (s[i] === ' ' || s[i] === ',') i++;
    if (s.startsWith('...', i)) {
      i += 3;
      continue;
    }
    if (s[i] === ']') return out;
    if (s[i] !== '"') return out.length > 0 ? out : null;
    i++;
    let cur = '';
    for (;;) {
      const c = s[i];
      if (c === undefined) return out.length > 0 ? out : null;
      if (c === '"') {
        i++;
        break;
      }
      if (c === '\\') {
        const n = s[i + 1];
        if (n === 'x' && /^[0-9a-fA-F]{2}$/.test(s.slice(i + 2, i + 4))) {
          cur += String.fromCharCode(parseInt(s.slice(i + 2, i + 4), 16));
          i += 4;
          continue;
        }
        if (n === 'u' && /^[0-9a-fA-F]{4}$/.test(s.slice(i + 2, i + 6))) {
          cur += String.fromCharCode(parseInt(s.slice(i + 2, i + 6), 16));
          i += 6;
          continue;
        }
        cur += n === 'n' ? '\n' : n === 't' ? '\t' : n === 'r' ? '\r' : (n ?? '');
        i += 2;
        continue;
      }
      cur += c;
      i++;
    }
    out.push(cur);
  }
}

interface ExecRec {
  pid: number;
  path: string;
  argv: string[] | null;
  result: string;
}

/** execve(0xADDR /path, 0xADDR [argv...], 0xADDR [envp...]) — envp 는 읽지 않는다 */
export function parseExec(call: string, args: string): { path: string; argv: string[] | null } | null {
  const body = call === 'execveat' ? args.replace(/^[^,]*, /, '') : args;
  const m = /^0x[0-9a-f]+ (.*?), 0x[0-9a-f]+ \[/.exec(body);
  if (!m) return null;
  const listStart = m[0].length - 1;
  return { path: m[1]!, argv: readQuotedList(body, listStart) };
}

/** connect(fd, 0xADDR {Family: AF_INET, Addr: 1.2.3.4, Port: 443}, len) */
export function parseConnect(args: string): { family: string; addr: string | null; port: number | null } | null {
  const m = /\{Family: (\w+)(?:, Addr: ("[^"]*"|[^,}]+))?(?:, Port: (\d+))?/.exec(args);
  if (!m) return null;
  let addr = m[2]?.trim() ?? null;
  if (addr && addr.startsWith('"')) addr = addr.slice(1, -1);
  return { family: m[1]!, addr, port: m[3] !== undefined ? Number(m[3]) : null };
}

/** openat(AT_FDCWD /cwd, 0xADDR path, flags, mode) · open(0xADDR path, flags, mode) → 절대 경로(알 수 있으면) */
export function parseOpenPath(call: string, args: string): string | null {
  if (call === 'openat') {
    const m = /^(?:AT_FDCWD|0x[0-9a-f]+)(?: (\S*))?, 0x[0-9a-f]+ (.*?), (?:O_|0x|0o)/.exec(args);
    if (!m || !m[2]) return null;
    const dir = m[1] ?? '';
    const p = m[2];
    return posix.normalize(p.startsWith('/') || !dir.startsWith('/') ? p : posix.join(dir, p));
  }
  const m = /^0x[0-9a-f]+ (.*?), (?:O_|0x|0o)/.exec(args);
  return m && m[1] ? posix.normalize(m[1]) : null;
}

// ─────────────────────────────────────────────
// 로그 전체 → 요약
// ─────────────────────────────────────────────

/**
 * @param binPath 하네스가 띄운 MCP 서버 실행 파일 경로(/work/node_modules/.bin/x, /work/site/bin/x)
 * @param pkgArgs 하네스가 bin 에 넘긴 인자(Registry 선언 인자)
 */
export function parseObserveLog(text: string, binPath: string, pkgArgs: readonly string[] = []): ObserveSummary {
  const s: ObserveSummary = {
    container_id: logContainerId(text.slice(0, 64 * 1024)),
    events: [],
    events_dropped: 0,
    opens_total: 0,
    exec_total: 0,
    harness_execs: 0,
    connect_total: 0,
    dns_attempts: 0,
    credential_opens: 0,
    unparsed_lines: 0,
  };
  const agg = new Map<string, ObserveEvent>();
  const add = (kind: ObserveKind, target: string, detail: string | null, result: string) => {
    const t = cut(target, TARGET_MAX);
    const key = `${kind}\u0000${t}\u0000${detail ?? ''}\u0000${result}`;
    const cur = agg.get(key);
    if (cur) {
      cur.count++;
      return;
    }
    if (agg.size >= OBSERVE_MAX_EVENTS) {
      s.events_dropped++;
      return;
    }
    agg.set(key, { kind, target: t, detail, result, count: 1 });
  };

  // 1) 줄 → 기록. exec 은 PATH 탐색(같은 pid, 같은 인자로 연달아)을 1건으로 합친다
  const execs: ExecRec[] = [];
  const lastExecOfPid = new Map<number, ExecRec>();
  const lastWasExec = new Map<number, boolean>();
  type Other = { kind: 'connect' | 'open'; raw: Raw };
  const ordered: Array<ExecRec | Other> = [];
  for (const line of text.split('\n')) {
    if (!SYSCALL_HINT.test(line)) continue;
    const raw = parseLine(line);
    if (!raw) {
      s.unparsed_lines++;
      continue;
    }
    if (raw.call === 'execve' || raw.call === 'execveat') {
      const e = parseExec(raw.call, raw.args);
      if (!e) {
        s.unparsed_lines++;
        continue;
      }
      const prev = lastExecOfPid.get(raw.pid);
      const same = prev && lastWasExec.get(raw.pid) && JSON.stringify(prev.argv) === JSON.stringify(e.argv);
      if (same && prev) {
        prev.path = e.path; // PATH 탐색의 마지막 경로
        prev.result = raw.result;
        continue;
      }
      const rec: ExecRec = { pid: raw.pid, path: e.path, argv: e.argv, result: raw.result };
      execs.push(rec);
      ordered.push(rec);
      lastExecOfPid.set(raw.pid, rec);
      lastWasExec.set(raw.pid, true);
      continue;
    }
    lastWasExec.set(raw.pid, false);
    ordered.push({ kind: raw.call === 'connect' ? 'connect' : 'open', raw });
  }

  // 2) 하네스 판정 (이름이 아니라 순서·인자로):
  //    pid 1(entrypoint → timeout) 전부
  //    + 처음으로 [bin, ...pkgArgs] 를 실행한 것(timeout 이 띄운 서버) — 한 번
  //    + 같은 pid 에서 처음으로 [인터프리터, bin, ...pkgArgs] 를 실행한 것(shebang 의 env → node/python) — 한 번
  //    그 밖은 같은 bin 을 다시 실행해도 패키지 동작으로 남긴다.
  const harness = new Set<ExecRec>();
  const eq = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((v, i) => v === b[i]);
  const isBinExec = (r: ExecRec) => r.argv !== null && eq(r.argv, [binPath, ...pkgArgs]);
  const isInterpExec = (r: ExecRec) => r.argv !== null && r.argv.length === pkgArgs.length + 2 && eq(r.argv.slice(1), [binPath, ...pkgArgs]);
  let harnessPid: number | null = null;
  let interpSeen = false;
  for (const r of execs) {
    if (r.pid === 1) {
      harness.add(r);
    } else if (harnessPid === null && isBinExec(r)) {
      harnessPid = r.pid;
      harness.add(r);
    } else if (r.pid === harnessPid && !interpSeen && isInterpExec(r)) {
      interpSeen = true;
      harness.add(r);
    }
  }

  // 3) 사건
  for (const item of ordered) {
    if ('path' in item) {
      if (harness.has(item)) {
        s.harness_execs++;
        continue;
      }
      s.exec_total++;
      add('exec', item.path, item.argv ? maskArgs(item.argv.slice(1)) : null, resultLabel(item.result, 'ok'));
      continue;
    }
    const raw = item.raw;
    if (item.kind === 'connect') {
      const c = parseConnect(raw.args);
      if (!c) {
        s.unparsed_lines++;
        continue;
      }
      if (c.family === 'AF_UNSPEC') continue; // glibc 주소 정렬: 연결 해제
      if ((c.family === 'AF_INET' || c.family === 'AF_INET6') && c.port === 0) continue; // 주소 정렬용 UDP connect
      const result = resultLabel(raw.result, 'ok');
      if (c.family === 'AF_UNIX') {
        s.connect_total++;
        add('connect', `unix:${c.addr ?? ''}`, null, result);
        continue;
      }
      const host = c.family === 'AF_INET6' ? `[${c.addr ?? ''}]` : (c.addr ?? '');
      if (c.port === 53) {
        s.dns_attempts++;
        add('dns_attempt', `${host}:53`, null, result);
        continue;
      }
      s.connect_total++;
      add('connect', `${host}:${c.port ?? ''}`, null, result);
      continue;
    }
    s.opens_total++;
    const p = parseOpenPath(raw.call, raw.args);
    if (p === null) continue;
    if (isCredentialPath(p)) {
      s.credential_opens++;
      add('credential_open', p, null, resultLabel(raw.result, 'opened'));
    }
  }
  s.events = [...agg.values()];
  return s;
}

// ─────────────────────────────────────────────
// 대상 선정
// ─────────────────────────────────────────────

export interface ObserveStateLite {
  target_key: string;
  registry_type: 'npm' | 'pypi';
  ident: string;
  version: string;
  last_outcome: string;
  last_run_at: string;
}

/** 기존 샌드박스에서 tools/list 까지 간(ok) 대상 중 아직 관측하지 않은 것, 최근 실행 순 */
export function planObserve(state: readonly ObserveStateLite[], observed: ReadonlySet<string>, limit: number, opts: { pypi: boolean }): ObserveStateLite[] {
  return state
    .filter((r) => r.last_outcome === 'ok' && !observed.has(r.target_key) && (opts.pypi || r.registry_type === 'npm'))
    .sort((a, b) => (a.last_run_at < b.last_run_at ? 1 : a.last_run_at > b.last_run_at ? -1 : a.target_key < b.target_key ? -1 : 1))
    .slice(0, Math.max(0, limit));
}

/** 기존 샌드박스 실행이 돌고 있는가: 가장 최근 묶음이 끝나지 않았고 6시간 안에 시작했다 */
export function mainRunActive(batch: { started_at: string; finished_at: string | null } | null, now = Date.now()): boolean {
  if (!batch || batch.finished_at) return false;
  const t = Date.parse(batch.started_at);
  return Number.isFinite(t) && now - t < 6 * 3_600_000;
}
