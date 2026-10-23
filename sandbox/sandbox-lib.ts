// Lowdown stdio 샌드박스 — 순수 함수 (대상 선정, bin 결정, npm 오류 분류, 상태 전이, docker 인자)
// 원칙: Registry 가 선언한 stdio 패키지를 격리된 컨테이너에서 띄워 initialize + tools/list 만 기록한다.
//       도구는 호출하지 않는다. 인증·환경변수·인자는 주지 않는다("설정 없이 오프라인으로 띄웠을 때"의 사실).
//       점수·판정 없음. 패키지가 보낸 문자열은 신뢰하지 않는다(이름·버전은 형식 검사 통과분만, 원문은 비공개 테이블만).

import { isNpmName } from '../scanner/npm-lib.ts';

// 기록의 의미가 바뀌는 수정(판정·저장 필드·실행 조건)마다 올린다. 주 버전이 바뀌면 끝난 대상도 다시 돈다.
//   0.1.0 — 2026-10-24 최초(인자 없이 실행) / 0.2.0 — Registry 선언 실행 인자(packageArguments)를 붙여 실행
export const SANDBOX_RUNNER_VERSION = '0.2.0';
export const SANDBOX_RUN_MAJOR = 2;

/** 정확한 버전 문자열만(범위·태그 제외). npm 이 받는 semver 형식의 부분집합. */
export const EXACT_VERSION = /^\d{1,9}\.\d{1,9}\.\d{1,9}(?:-[0-9A-Za-z.-]{1,64})?(?:\+[0-9A-Za-z.-]{1,64})?$/;

export type TargetSource = 'declared' | 'npm_latest';

export interface Target {
  /** "npm:<ident>@<version>" — 상태 테이블 기본 키 */
  key: string;
  registry_type: 'npm';
  ident: string;
  version: string;
  sources: TargetSource[];
  /** 정렬용: 이 대상이 새로 생긴(또는 바뀐) 것으로 보이는 시각. 최근 것부터 돈다. */
  fresh_at: string;
}

export interface RegistryRowLite {
  name: string;
  packages_key: string | null;
  updated_at: string | null;
}

export interface NpmStateLite {
  ident: string;
  status: string;
  latest: string | null;
  modified: string | null;
}

export interface SandboxStateRow {
  target_key: string;
  registry_type: 'npm';
  ident: string;
  version: string;
  attempts: number;
  done: boolean;
  last_outcome: string;
  first_run_at: string;
  last_run_at: string;
  run_major: number;
}

export const targetKey = (ident: string, version: string) => `npm:${ident}@${version}`;

export interface PlanStats {
  declared_lines: number;
  non_stdio: number;
  invalid: number;
  inexact_version: number;
  npm_not_found: number;
  candidates: number;
  already_done: number;
  gave_up: number;
  planned: number;
}

/**
 * 대상 = Registry 가 stdio 로 선언한 npm 패키지의
 *   (1) 선언 버전(정확한 버전일 때) — Registry 가 주장하는 것
 *   (2) npm 최신 버전 — 버전 없이 `npx -y <pkg>` 로 띄우면 받게 되는 것
 * 같으면 하나로 합친다. 끝난 대상(done, 같은 run_major)은 뺀다. 최근에 바뀐 것부터.
 */
export function planTargets(
  registry: readonly RegistryRowLite[],
  npmState: readonly NpmStateLite[],
  state: readonly Pick<SandboxStateRow, 'target_key' | 'done' | 'attempts' | 'run_major' | 'last_outcome'>[],
  opts: { limit: number; runMajor?: number },
): { targets: Target[]; stats: PlanStats } {
  const runMajor = opts.runMajor ?? SANDBOX_RUN_MAJOR;
  const stats: PlanStats = { declared_lines: 0, non_stdio: 0, invalid: 0, inexact_version: 0, npm_not_found: 0, candidates: 0, already_done: 0, gave_up: 0, planned: 0 };
  const npm = new Map(npmState.map((r) => [r.ident, r]));
  const byKey = new Map<string, Target>();
  const add = (ident: string, version: string, source: TargetSource, at: string) => {
    const key = targetKey(ident, version);
    const t = byKey.get(key);
    if (!t) {
      byKey.set(key, { key, registry_type: 'npm', ident, version, sources: [source], fresh_at: at });
      return;
    }
    if (!t.sources.includes(source)) t.sources.push(source);
    t.sources.sort();
    if (at > t.fresh_at) t.fresh_at = at;
  };

  const seenIdents = new Set<string>();
  for (const row of registry) {
    for (const line of (row.packages_key ?? '').split('\n')) {
      const [type, ident, version, transport] = line.trim().split(' ');
      if (type !== 'npm') continue;
      stats.declared_lines++;
      if (transport !== 'stdio') {
        stats.non_stdio++;
        continue;
      }
      if (!ident || !isNpmName(ident)) {
        stats.invalid++;
        continue;
      }
      const n = npm.get(ident);
      if (n && n.status === 'not_found') {
        stats.npm_not_found++;
        continue;
      }
      const at = row.updated_at ?? '';
      if (version && EXACT_VERSION.test(version)) add(ident, version, 'declared', at);
      else stats.inexact_version++;
      if (!seenIdents.has(ident) && n && n.status === 'found' && n.latest && EXACT_VERSION.test(n.latest)) {
        add(ident, n.latest, 'npm_latest', n.modified ?? at);
      }
      seenIdents.add(ident);
    }
  }
  stats.candidates = byKey.size;

  const st = new Map(state.map((s) => [s.target_key, s]));
  const todo: Target[] = [];
  for (const t of byKey.values()) {
    const s = st.get(t.key);
    if (s && s.run_major === runMajor && s.done) {
      if (retryLimit(s.last_outcome) > 1 && s.attempts >= retryLimit(s.last_outcome)) stats.gave_up++;
      else stats.already_done++;
      continue;
    }
    todo.push(t);
  }
  todo.sort((a, b) => (a.fresh_at < b.fresh_at ? 1 : a.fresh_at > b.fresh_at ? -1 : a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const targets = todo.slice(0, Math.max(0, opts.limit));
  stats.planned = targets.length;
  return { targets, stats };
}

// ─────────────────────────────────────────────
// 결과 분류
// ─────────────────────────────────────────────

export const OUTCOMES = [
  'ok', // initialize + tools/list 응답
  'install_not_found', // npm E404
  'install_version_not_found', // npm ETARGET / ENOVERSIONS (그 버전이 없음)
  'install_failed', // 그 밖의 npm 설치 실패(오류 코드는 install_error_code)
  'install_timeout',
  'install_network', // 네트워크·레지스트리 일시 오류 → 다시 시도
  'no_bin', // 패키지에 실행 파일(bin) 선언이 없음
  'bin_ambiguous', // bin 이 여러 개이고 패키지 이름과 같은 것이 없음(npx 도 고르지 못함)
  'exited', // initialize 응답 전에 프로세스가 끝남
  'init_timeout',
  'init_error', // initialize 에 JSON-RPC 오류
  'init_invalid', // initialize 응답이 결과 객체가 아님
  'list_timeout',
  'list_error',
  'list_invalid',
  'exited_after_init', // initialize 뒤 tools/list 응답 전에 끝남
  'output_limit', // 표준출력이 상한을 넘음
  'runner_error', // 우리 쪽(docker 등) 문제 → 다시 시도
] as const;
export type Outcome = (typeof OUTCOMES)[number];

/** 같은 대상을 몇 번까지 시도하는가. 일시 오류만 여러 번. 나머지는 한 번이 사실이다. */
export function retryLimit(outcome: string): number {
  if (outcome === 'install_network' || outcome === 'runner_error') return 3;
  if (outcome === 'install_timeout' || outcome === 'init_timeout') return 2;
  return 1;
}

export function nextState(prev: SandboxStateRow | undefined, t: Target, outcome: Outcome, now: string, runMajor = SANDBOX_RUN_MAJOR): SandboxStateRow {
  const sameMajor = prev && prev.run_major === runMajor;
  const attempts = (sameMajor ? prev.attempts : 0) + 1;
  return {
    target_key: t.key,
    registry_type: 'npm',
    ident: t.ident,
    version: t.version,
    attempts,
    done: attempts >= retryLimit(outcome),
    last_outcome: outcome,
    first_run_at: prev?.first_run_at ?? now,
    last_run_at: now,
    run_major: runMajor,
  };
}

/** npm 설치 실패 → 결과 분류 + npm 이 붙인 오류 코드(형식 통과분만). stderr 원문은 저장하지 않는다. */
export function classifyInstallFailure(stderr: string, timedOut: boolean): { outcome: Outcome; code: string | null } {
  if (timedOut) return { outcome: 'install_timeout', code: null };
  const m = /npm (?:ERR!|error) code (E[A-Z0-9_]{1,40})/.exec(stderr);
  const code = m?.[1] ?? null;
  if (code === 'E404') return { outcome: 'install_not_found', code };
  if (code === 'ETARGET' || code === 'ENOVERSIONS') return { outcome: 'install_version_not_found', code };
  const network = new Set(['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND', 'ECONNREFUSED', 'E500', 'E502', 'E503', 'E504', 'E429', 'EPIPE', 'ESOCKETTIMEDOUT']);
  if (code && network.has(code)) return { outcome: 'install_network', code };
  if (!code && /(ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up)/.test(stderr)) return { outcome: 'install_network', code: null };
  return { outcome: 'install_failed', code };
}

// ─────────────────────────────────────────────
// bin 결정 (npx 와 같은 규칙)
// ─────────────────────────────────────────────

const BIN_NAME = /^[A-Za-z0-9@._-]{1,100}$/;

/**
 * package.json 의 bin → 실행할 bin 이름.
 *   문자열: 패키지 이름(범위 제외)이 bin 이름
 *   객체: 하나면 그것, 여럿이면 패키지 이름(범위 제외)과 같은 것. 없으면 ambiguous(npx 도 실패한다)
 * bin 이름은 node_modules/.bin/<이름> 경로로만 쓰므로 형식 검사를 통과한 것만 받는다.
 */
export function chooseBin(pkgJson: unknown, ident: string): { bin: string | null; outcome: 'ok' | 'no_bin' | 'bin_ambiguous'; count: number } {
  const unscoped = ident.startsWith('@') ? ident.slice(ident.indexOf('/') + 1) : ident;
  const p = (pkgJson && typeof pkgJson === 'object' ? pkgJson : {}) as Record<string, unknown>;
  const bin = p.bin;
  if (typeof bin === 'string' && bin.length > 0) {
    return BIN_NAME.test(unscoped) ? { bin: unscoped, outcome: 'ok', count: 1 } : { bin: null, outcome: 'no_bin', count: 1 };
  }
  if (bin && typeof bin === 'object' && !Array.isArray(bin)) {
    const names = Object.keys(bin).filter((k) => typeof (bin as Record<string, unknown>)[k] === 'string' && BIN_NAME.test(k) && !k.includes('/'));
    if (names.length === 0) return { bin: null, outcome: 'no_bin', count: 0 };
    if (names.length === 1) return { bin: names[0]!, outcome: 'ok', count: 1 };
    if (names.includes(unscoped)) return { bin: unscoped, outcome: 'ok', count: names.length };
    return { bin: null, outcome: 'bin_ambiguous', count: names.length };
  }
  return { bin: null, outcome: 'no_bin', count: 0 };
}

// ─────────────────────────────────────────────
// docker 인자 (격리 조건은 여기 한 곳에서만 정한다)
// ─────────────────────────────────────────────

export interface DockerCtx {
  image: string;
  runtime: string; // 'runsc'(gVisor) 기본
  uid: number;
  name: string;
  workHost: string;
}

const COMMON_ISOLATION = (c: DockerCtx) => [
  '--rm',
  '--name', c.name,
  '--label', 'lowdown.sandbox=1',
  '--runtime', c.runtime,
  '--user', `${c.uid}:${c.uid}`,
  '--cap-drop', 'ALL',
  '--security-opt', 'no-new-privileges',
  '--read-only',
  '--log-driver', 'none',
  '-e', 'HOME=/tmp',
];

/** 설치: 네트워크 있음(레지스트리), 스크립트 실행 안 함(--ignore-scripts), 패키지 코드는 실행되지 않는다. */
export function installArgs(c: DockerCtx & { cacheHost: string }, ident: string, version: string): string[] {
  return [
    'run',
    ...COMMON_ISOLATION(c),
    '--network', 'bridge',
    '--pids-limit', '256',
    '--memory', '1g', '--memory-swap', '1g',
    '--cpus', '1',
    '--tmpfs', '/tmp:rw,size=256m',
    '-v', `${c.workHost}:/work`,
    '-v', `${c.cacheHost}:/cache`,
    '-e', 'npm_config_cache=/cache',
    '-e', 'npm_config_update_notifier=false',
    '-e', 'npm_config_fund=false',
    '-e', 'npm_config_audit=false',
    c.image,
    'npm', 'install', '--prefix', '/work', '--ignore-scripts', '--omit=dev', '--prefer-offline', '--no-package-lock', '--loglevel=error',
    `${ident}@${version}`,
  ];
}

/** 실행: 네트워크 없음, 작업 폴더 읽기 전용, 환경변수·인자 없음. 컨테이너 안에서도 timeout 으로 스스로 끝난다. */
export function runArgs(c: DockerCtx, bin: string, hardLimitSec: number, pkgArgs: readonly string[] = []): string[] {
  return [
    'run', '-i',
    ...COMMON_ISOLATION(c),
    '--network', 'none',
    '--pids-limit', '128',
    '--memory', '512m', '--memory-swap', '512m',
    '--cpus', '1',
    '--tmpfs', '/tmp:rw,size=64m',
    '-v', `${c.workHost}:/work:ro`,
    '-w', '/tmp',
    c.image,
    'timeout', '-s', 'KILL', String(hardLimitSec),
    `/work/node_modules/.bin/${bin}`,
    ...pkgArgs,
  ];
}

// ─────────────────────────────────────────────
// Registry 선언 실행 인자 (packageArguments)
//   Registry 가 "이렇게 띄우라"고 적은 고정값만 붙인다. 비밀값·템플릿({...})·값 없는 필수 인자는 넣지 않는다.
//   runtimeArguments(npx -y 같은 실행기 옵션)는 bin 을 직접 실행하므로 쓰지 않는다. 환경변수는 계속 주지 않는다(개수만 기록).
// ─────────────────────────────────────────────

export interface LaunchSpec {
  registry_name: string;
  declared_version: string;
  args: string[];
  /** 필수인데 고정값이 없거나 비밀값이라 넣지 못한 인자 수 */
  args_unsatisfied: number;
  env_required: number;
  env_secret: number;
}

const MAX_ARGS = 20;
const ARG_VALUE = /^[^\u0000-\u001f\u007f{}]{1,200}$/;
const ARG_NAME = /^-{1,2}[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Registry packages[] 원소 하나 → 붙일 인자 */
export function launchArgsOf(pkg: Record<string, unknown>): Pick<LaunchSpec, 'args' | 'args_unsatisfied' | 'env_required' | 'env_secret'> {
  const args: string[] = [];
  let unsatisfied = 0;
  const list = Array.isArray(pkg.packageArguments) ? (pkg.packageArguments as unknown[]) : [];
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue;
    const a = raw as Record<string, unknown>;
    const fixed = typeof a.value === 'string' ? a.value : typeof a.default === 'string' ? a.default : null;
    const usable = fixed !== null && a.isSecret !== true && ARG_VALUE.test(fixed);
    if (a.type === 'positional') {
      if (usable) args.push(fixed);
      else if (a.isRequired === true || fixed !== null) unsatisfied++;
    } else if (a.type === 'named') {
      const name = typeof a.name === 'string' && ARG_NAME.test(a.name) ? a.name : null;
      if (!name) {
        unsatisfied++;
        continue;
      }
      if (fixed === null && a.isSecret !== true && a.valueHint === undefined && a.format === undefined) {
        args.push(name); // 값 없는 플래그(예: --stdio)
      } else if (usable) {
        args.push(name, fixed);
      } else if (a.isRequired === true) {
        unsatisfied++;
      }
    }
  }
  const envs = Array.isArray(pkg.environmentVariables) ? (pkg.environmentVariables as unknown[]) : [];
  let envRequired = 0;
  let envSecret = 0;
  for (const e of envs) {
    if (!e || typeof e !== 'object') continue;
    if ((e as Record<string, unknown>).isRequired === true) envRequired++;
    if ((e as Record<string, unknown>).isSecret === true) envSecret++;
  }
  if (args.length > MAX_ARGS) {
    unsatisfied += args.length - MAX_ARGS;
    args.length = MAX_ARGS;
  }
  return { args, args_unsatisfied: unsatisfied, env_required: envRequired, env_secret: envSecret };
}

/** 패키지 → 실행 방법. 같은 버전을 선언한 항목을 우선, 없으면 이름순 첫 항목. */
export function pickLaunch(specs: readonly LaunchSpec[] | undefined, version: string): LaunchSpec | null {
  if (!specs || specs.length === 0) return null;
  const sorted = [...specs].sort((a, b) => (a.registry_name < b.registry_name ? -1 : a.registry_name > b.registry_name ? 1 : 0));
  return sorted.find((s) => s.declared_version === version) ?? sorted[0]!;
}

// ─────────────────────────────────────────────
// 표준출력 줄 나누기 (MCP stdio = 줄바꿈으로 구분한 JSON-RPC)
// ─────────────────────────────────────────────

export class LineSplitter {
  private buf = '';
  bytes = 0;
  overflow = false;
  private readonly maxBytes: number;
  constructor(maxBytes: number) {
    this.maxBytes = maxBytes;
  }

  /** 새로 완성된 줄들. 상한을 넘으면 overflow 를 켜고 더 받지 않는다. */
  push(chunk: Buffer | string): string[] {
    if (this.overflow) return [];
    const s = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    this.bytes += Buffer.byteLength(s, 'utf8');
    if (this.bytes > this.maxBytes) {
      this.overflow = true;
      this.buf = '';
      return [];
    }
    this.buf += s;
    const parts = this.buf.split('\n');
    this.buf = parts.pop() ?? '';
    return parts.map((l) => l.replace(/\r$/, '')).filter((l) => l.trim().length > 0);
  }
}
