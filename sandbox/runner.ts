// Lowdown stdio 샌드박스 실행기 — 샌드박스 서버(호스트)에서만 돈다. GitHub Actions 에서 돌리지 않는다.
// 사용:
//   node sandbox/runner.ts               대상 선정 → 설치 → 실행(initialize + tools/list) → 기록
//   node sandbox/runner.ts --plan        대상 선정만(docker 안 씀, DB 쓰기 없음)
//   node sandbox/runner.ts --self-test   격리 확인: 컨테이너가 MCP 로 응답하는지, 네트워크가 막혔는지 (DB 안 씀)
//   node sandbox/runner.ts --observe     행동 관측(비공개): 기존 실행에서 ok 였던 대상의 실행 단계를 strace 런타임(runsc-observe)으로
//                                        한 번 더 돌려 실행·접속·DNS 시도·인증 정보 경로 열기를 기록 (sandbox/observe-lib.ts)
//                                        --plan 과 함께 쓰면 대상만 보여준다. 기존 sandbox_runs/state/batches 에는 쓰지 않는다.
//   --limit=N                            이번 실행의 대상 수 상한
//   --only=pypi|npm                      한 종류만 돈다(새 종류의 첫 확인용). 예: --only=pypi --limit=10
// 환경변수(/etc/lowdown/sandbox.env, systemd 가 읽는다):
//   필수 LOWDOWN_SUPABASE_URL, LOWDOWN_SANDBOX_KEY (없으면 LOWDOWN_SCANNER_KEY)
//   선택 SANDBOX_IMAGE(lowdown-sandbox-node:1) SANDBOX_IMAGE_PY(lowdown-sandbox-python:1) SANDBOX_PYPI(0 이면 PyPI 제외)
//        SANDBOX_RUNTIME(runsc) SANDBOX_ROOT(/var/lib/lowdown)
//        SANDBOX_CONCURRENCY(2) SANDBOX_MAX_TARGETS(1500 — 실제 상한은 시간 예산) SANDBOX_TIME_BUDGET_MIN(240)
//        SANDBOX_MIN_FREE_GB(5) SANDBOX_CACHE_MAX_GB(20)
//        관측: SANDBOX_OBSERVE_RUNTIME(runsc-observe) SANDBOX_OBSERVE_LOG_DIR(/var/log/lowdown-strace)
//              SANDBOX_OBSERVE_LIMIT(200) SANDBOX_OBSERVE_BUDGET_MIN(120)
// 키는 이 프로세스만 쓴다. 컨테이너에는 어떤 환경변수도 넘기지 않는다(HOME=/tmp 만).

import { accessSync, chmodSync, closeSync, constants as fsConstants, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync, rmSync, statfsSync, statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SupabaseConfig } from '../scanner/lib.ts';
import { normalizePypiName } from '../scanner/pypi-lib.ts';
import { insertToolDefs, insertToolSetVersions, ToolDefCollector, toolDefRows, toolSetVersionRows } from '../scanner/tool-defs.ts';
import {
  chooseBin,
  choosePyScript,
  classifyInstallFailure,
  classifyPipFailure,
  findDistInfo,
  hasInstallScripts,
  installArgs,
  nextState,
  parseConsoleScripts,
  NODE_RUN,
  pickLaunch,
  pipInstallArgs,
  planTargets,
  PYTHON_RUN,
  runArgs,
  SANDBOX_RUN_MAJOR,
  SANDBOX_RUNNER_VERSION,
  type DockerCtx,
  type LaunchSpec,
  type Outcome,
  type SandboxStateRow,
  type Target,
} from './sandbox-lib.ts';
import {
  fetchLaunchSpecs,
  fetchNpmLite,
  fetchPypiLite,
  fetchRegistryLite,
  fetchSandboxState,
  insertSandboxRuns,
  runCmd,
  upsertSandboxBatch,
  upsertSandboxState,
  type SandboxBatchRow,
  type SandboxRunRow,
} from './sandbox-io.ts';
import { DEFAULT_PROBE_OPTS, probeStdio, type StdioProbeResult } from './stdio-probe.ts';
import { getKeyset } from '../scanner/npm-lib.ts';
import { postBatches } from '../scanner/registry-diff.ts';
import {
  logContainerId,
  mainRunActive,
  OBSERVE_DEFAULT_LOG_DIR,
  OBSERVE_DEFAULT_RUNTIME,
  OBSERVE_MAJOR,
  OBSERVE_MAX_LOG_BYTES,
  parseObserveLog,
  planObserve,
  withCidfile,
  type ObserveStateLite,
  type ObserveSummary,
} from './observe-lib.ts';

const HERE = dirname(fileURLToPath(import.meta.url));

function fail(message: string): never {
  console.error(`error: ${message}`);
  process.exit(1);
}

const intEnv = (name: string, dflt: number) => {
  const v = Number(process.env[name]);
  return Number.isInteger(v) && v > 0 ? v : dflt;
};

const INSTALL_TIMEOUT_MS = 180_000;
const FLUSH_EVERY = 20;

interface Env {
  image: string;
  imagePy: string;
  runtime: string;
  root: string;
  uid: number;
  concurrency: number;
  maxTargets: number;
  budgetMs: number;
  minFreeGb: number;
  cacheMaxGb: number;
}

function readEnv(): Env {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 10001;
  return {
    image: process.env.SANDBOX_IMAGE?.trim() || 'lowdown-sandbox-node:1',
    imagePy: process.env.SANDBOX_IMAGE_PY?.trim() || 'lowdown-sandbox-python:1',
    runtime: process.env.SANDBOX_RUNTIME?.trim() || 'runsc',
    root: process.env.SANDBOX_ROOT?.trim() || '/var/lib/lowdown',
    uid,
    concurrency: Math.min(4, intEnv('SANDBOX_CONCURRENCY', 2)),
    // 상한은 사실상 시간 예산(4시간)이다 — 못 한 대상은 다음 날로 넘어간다(최근 것부터 정렬)
    maxTargets: intEnv('SANDBOX_MAX_TARGETS', 1500),
    budgetMs: intEnv('SANDBOX_TIME_BUDGET_MIN', 240) * 60_000,
    minFreeGb: intEnv('SANDBOX_MIN_FREE_GB', 5),
    cacheMaxGb: intEnv('SANDBOX_CACHE_MAX_GB', 20),
  };
}

function freeGb(path: string): number {
  const s = statfsSync(path);
  return (s.bavail * s.bsize) / 1024 ** 3;
}

async function docker(args: string[], timeoutMs = 60_000) {
  return runCmd('docker', args, { timeoutMs });
}

/** 지난 실행이 남긴 컨테이너·작업 폴더 정리 */
async function cleanupLeftovers(env: Env): Promise<void> {
  const ps = await docker(['ps', '-aq', '--filter', 'label=lowdown.sandbox=1']);
  const ids = ps.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  if (ids.length > 0) await docker(['rm', '-f', ...ids]);
  const work = join(env.root, 'work');
  mkdirSync(work, { recursive: true, mode: 0o700 });
  for (const d of readdirSync(work)) rmSync(join(work, d), { recursive: true, force: true });
}

async function preflight(env: Env): Promise<string> {
  const info = await docker(['info', '--format', '{{json .Runtimes}}']);
  if (info.code !== 0) fail('docker 에 접근할 수 없습니다 (lowdown 사용자가 docker 그룹인지 확인).');
  if (!info.stdout.includes(`"${env.runtime}"`)) fail(`docker 런타임 ${env.runtime} 이 없습니다. setup.sh 를 확인하세요.`);
  const img = await docker(['image', 'inspect', '-f', '{{.Id}}', env.image]);
  const imageId = img.stdout.trim();
  if (img.code !== 0 || !imageId) fail(`이미지 ${env.image} 가 없습니다. setup.sh 로 빌드하세요.`);
  mkdirSync(join(env.root, 'npm-cache'), { recursive: true, mode: 0o700 });
  mkdirSync(join(env.root, 'pip-cache'), { recursive: true, mode: 0o700 });
  const free = freeGb(env.root);
  if (free < env.minFreeGb) fail(`디스크 여유 ${free.toFixed(1)}GB < ${env.minFreeGb}GB`);
  // npm 캐시가 커지면 비운다(무결성은 npm 이 검사하므로 캐시는 속도·요청 수 절약용일 뿐)
  for (const dir of ['npm-cache', 'pip-cache']) {
    const du = await runCmd('du', ['-sb', join(env.root, dir)], { timeoutMs: 120_000 });
    const bytes = Number(du.stdout.split('\t')[0]);
    if (Number.isFinite(bytes) && bytes > env.cacheMaxGb * 1024 ** 3) {
      console.log(`${dir} ${(bytes / 1024 ** 3).toFixed(1)}GB > ${env.cacheMaxGb}GB, clearing`);
      rmSync(join(env.root, dir), { recursive: true, force: true });
      mkdirSync(join(env.root, dir), { recursive: true, mode: 0o700 });
    }
  }
  return imageId;
}

interface TargetResult {
  install_ms: number | null;
  install_error_code: string | null;
  bin_count: number | null;
  probe: StdioProbeResult | null;
  install_scripts?: boolean;
  /** 첫 설치가 ETARGET/ENOVERSIONS 여서 --prefer-online 으로 다시 시도했다 */
  install_retry?: 'prefer_online';
  /** 실행 단계에서 띄운 서버 경로·인자(관측 로그의 하네스 판정용) */
  run_bin_path?: string;
  run_args?: string[];
  outcome: Outcome;
}

/** 관측 실행: 실행 단계만 다른 런타임으로, 컨테이너 ID 를 파일로 받는다. 설치 단계는 그대로. */
interface RunObserve {
  runtime: string;
  cidfile: string;
}

function runDockerArgs(ctx: DockerCtx, bin: string, hardLimit: number, pkgArgs: readonly string[], lang: typeof NODE_RUN, obs: RunObserve | undefined): string[] {
  const args = runArgs(obs ? { ...ctx, runtime: obs.runtime } : ctx, bin, hardLimit, pkgArgs, lang);
  return obs ? withCidfile(args, obs.cidfile) : args;
}

function readPackageJson(work: string, ident: string): unknown {
  const p = join(work, 'node_modules', ...ident.split('/'), 'package.json');
  try {
    if (statSync(p).size > 1 << 20) return null;
    return JSON.parse(readFileSync(p, 'utf8')) as unknown;
  } catch {
    return null;
  }
}

/** 일반 파일만 읽는다(심볼릭 링크는 따라가지 않는다 — 설치된 패키지가 호스트 파일을 가리키게 둘 수 없다). */
function readSmallFile(path: string, maxBytes: number): string | null {
  try {
    const st = lstatSync(path);
    if (!st.isFile() || st.size > maxBytes) return null;
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/** PyPI: wheel 만 설치(패키지 코드 실행 없음) → 자기 console_scripts 로 실행 파일 결정 → 같은 방식으로 initialize + tools/list */
async function runPypiTarget(env: Env, t: Target, launch: LaunchSpec | null, obs?: RunObserve): Promise<TargetResult> {
  const work = mkdtempSync(join(env.root, 'work', 'p-'));
  chmodSync(work, 0o700);
  const name = `lds-${randomUUID().slice(0, 12)}`;
  const ctx: DockerCtx = { image: env.imagePy, runtime: env.runtime, uid: env.uid, name, workHost: work };
  try {
    const inst = await docker(pipInstallArgs({ ...ctx, cacheHost: join(env.root, 'pip-cache') }, t.ident, t.version), INSTALL_TIMEOUT_MS);
    await docker(['rm', '-f', name]);
    if (inst.code !== 0) {
      if (inst.code === 125 && !inst.timedOut) return { install_ms: inst.ms, install_error_code: null, bin_count: null, probe: null, outcome: 'runner_error' };
      const c = classifyPipFailure(inst.stderr, inst.timedOut);
      return { install_ms: inst.ms, install_error_code: c.code, bin_count: null, probe: null, outcome: c.outcome };
    }
    const site = join(work, 'site');
    let scripts: string[] = [];
    try {
      const dist = findDistInfo(readdirSync(site), t.ident);
      const text = dist ? readSmallFile(join(site, dist, 'entry_points.txt'), 1 << 20) : null;
      if (text) scripts = parseConsoleScripts(text);
    } catch {
      // 설치 폴더를 읽지 못함 → 실행 파일 없음으로 기록
    }
    const pick = choosePyScript(scripts, t.ident);
    const binPath = pick.bin ? join(site, 'bin', pick.bin) : null;
    let isFile = false;
    try {
      isFile = binPath !== null && lstatSync(binPath).isFile();
    } catch {
      isFile = false;
    }
    if (pick.outcome !== 'ok' || !pick.bin || !isFile) {
      return { install_ms: inst.ms, install_error_code: null, bin_count: pick.count, probe: null, outcome: pick.outcome === 'bin_ambiguous' ? 'bin_ambiguous' : 'no_bin' };
    }
    const hardLimit = Math.ceil((DEFAULT_PROBE_OPTS.initTimeoutMs + DEFAULT_PROBE_OPTS.listTimeoutMs) / 1000) + 15;
    const pkgArgs = launch?.args ?? [];
    const probe = await probeStdio(['docker', ...runDockerArgs({ ...ctx, name: `${name}-r` }, pick.bin, hardLimit, pkgArgs, PYTHON_RUN, obs)]);
    await docker(['rm', '-f', `${name}-r`]);
    return { install_ms: inst.ms, install_error_code: null, bin_count: pick.count, probe, run_bin_path: `${PYTHON_RUN.binDir}/${pick.bin}`, run_args: [...pkgArgs], outcome: probe.outcome };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

async function runTarget(env: Env, t: Target, launch: LaunchSpec | null, obs?: RunObserve): Promise<TargetResult> {
  if (t.registry_type === 'pypi') return runPypiTarget(env, t, launch, obs);
  const work = mkdtempSync(join(env.root, 'work', 't-'));
  chmodSync(work, 0o700);
  const name = `lds-${randomUUID().slice(0, 12)}`;
  const ctx: DockerCtx = { image: env.image, runtime: env.runtime, uid: env.uid, name, workHost: work };
  try {
    // 1) 설치 (스크립트 실행 없음)
    const install = async (preferOnline: boolean) => {
      const r = await docker(installArgs({ ...ctx, cacheHost: join(env.root, 'npm-cache') }, t.ident, t.version, { preferOnline }), INSTALL_TIMEOUT_MS);
      await docker(['rm', '-f', name]);
      return r;
    };
    let inst = await install(false);
    let retry: TargetResult['install_retry'];
    // 캐시(--prefer-offline)의 패키지 정보가 새 버전을 모르면 ETARGET 이 난다 → npm 에 다시 확인하고 한 번만 더 시도
    if (inst.code !== 0 && inst.code !== 125 && classifyInstallFailure(inst.stderr, inst.timedOut).outcome === 'install_version_not_found') {
      const first = inst.ms;
      inst = await install(true);
      inst = { ...inst, ms: first + inst.ms };
      retry = 'prefer_online';
    }
    const extra = retry ? { install_retry: retry } : {};
    if (inst.code !== 0) {
      if (inst.code === 125 && !inst.timedOut) return { install_ms: inst.ms, install_error_code: null, bin_count: null, probe: null, ...extra, outcome: 'runner_error' };
      const c = classifyInstallFailure(inst.stderr, inst.timedOut);
      return { install_ms: inst.ms, install_error_code: c.code, bin_count: null, probe: null, ...extra, outcome: c.outcome };
    }

    // 2) 실행 파일 결정 (npx 와 같은 규칙)
    const pkgJson = readPackageJson(work, t.ident);
    const scripts = hasInstallScripts(pkgJson);
    const pick = chooseBin(pkgJson, t.ident);
    if (pick.outcome !== 'ok' || !pick.bin || !existsSync(join(work, 'node_modules', '.bin', pick.bin))) {
      return { install_ms: inst.ms, install_error_code: null, bin_count: pick.count, probe: null, install_scripts: scripts, ...extra, outcome: pick.outcome === 'bin_ambiguous' ? 'bin_ambiguous' : 'no_bin' };
    }

    // 3) 실행: initialize + tools/list
    const hardLimit = Math.ceil((DEFAULT_PROBE_OPTS.initTimeoutMs + DEFAULT_PROBE_OPTS.listTimeoutMs) / 1000) + 15;
    const pkgArgs = launch?.args ?? [];
    const probe = await probeStdio(['docker', ...runDockerArgs({ ...ctx, name: `${name}-r` }, pick.bin, hardLimit, pkgArgs, NODE_RUN, obs)]);
    await docker(['rm', '-f', `${name}-r`]);
    return {
      install_ms: inst.ms,
      install_error_code: null,
      bin_count: pick.count,
      probe,
      install_scripts: scripts,
      ...extra,
      run_bin_path: `${NODE_RUN.binDir}/${pick.bin}`,
      run_args: [...pkgArgs],
      outcome: probe.outcome,
    };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** 격리 확인: 우리 픽스처 서버를 같은 조건으로 띄운다. 네트워크가 열려 있으면 픽스처가 스스로 끝난다(exited). */
async function selfTest(env: Env): Promise<void> {
  await preflight(env);
  await cleanupLeftovers(env);
  const fixture = join(HERE, 'fixtures', 'fake-mcp.mjs');
  const checks: Array<[string, Outcome]> = [
    ['lowdown-selftest', 'ok'],
    ['lowdown-netcheck', 'ok'],
  ];
  let bad = 0;
  for (const [bin, want] of checks) {
    const work = mkdtempSync(join(env.root, 'work', 'self-'));
    chmodSync(work, 0o755);
    mkdirSync(join(work, 'node_modules', '.bin'), { recursive: true });
    copyFileSync(fixture, join(work, 'node_modules', '.bin', bin));
    chmodSync(join(work, 'node_modules', '.bin', bin), 0o755);
    const name = `lds-self-${randomUUID().slice(0, 8)}`;
    const probe = await probeStdio(['docker', ...runArgs({ image: env.image, runtime: env.runtime, uid: env.uid, name, workHost: work }, bin, 60)]);
    await docker(['rm', '-f', name]);
    rmSync(work, { recursive: true, force: true });
    const ok = probe.outcome === want;
    if (!ok) bad++;
    console.log(`${ok ? 'PASS' : 'FAIL'} ${bin}: outcome=${probe.outcome} exit=${probe.exit_code} tools=${String(probe.metadata.tool_count ?? '-')} init_ms=${probe.init_ms}`);
  }
  // 설치 컨테이너(bridge): 레지스트리는 닿고, 메타데이터·호스트는 막혀야 한다
  const probeJs =
    "const n=require('net');const t=(h,p)=>new Promise(r=>{const s=n.connect({host:h,port:p,timeout:4000});s.on('connect',()=>{s.destroy();r(true)});s.on('timeout',()=>{s.destroy();r(false)});s.on('error',()=>r(false))});" +
    "(async()=>{const dns=require('dns').promises;let reg=false;try{const a=await dns.lookup('registry.npmjs.org');reg=await t(a.address,443)}catch{}" +
    "console.log(JSON.stringify({registry:reg,metadata:await t('169.254.169.254',80),host_ssh:await t('172.17.0.1',22)}))})()";
  const eg = await docker(['run', '--rm', '--label', 'lowdown.sandbox=1', '--runtime', env.runtime, '--network', 'bridge', '--user', `${env.uid}:${env.uid}`, '--cap-drop', 'ALL', env.image, 'node', '-e', probeJs], 60_000);
  let egress: { registry?: boolean; metadata?: boolean; host_ssh?: boolean } = {};
  try {
    egress = JSON.parse(eg.stdout.trim()) as typeof egress;
  } catch {
    // 아래에서 FAIL
  }
  const egOk = egress.registry === true && egress.metadata === false && egress.host_ssh === false;
  if (!egOk) bad++;
  console.log(`${egOk ? 'PASS' : 'FAIL'} install egress: ${eg.stdout.trim() || eg.stderr.trim().slice(0, 200)} (want registry=true, metadata=false, host_ssh=false)`);
  // PyPI 이미지: 같은 격리 조건(gVisor, 네트워크 없음, 읽기 전용)에서 파이썬이 돌고 바깥으로 나가지 못해야 한다
  const pyImg = await docker(['image', 'inspect', '-f', '{{.Id}}', env.imagePy]);
  if (pyImg.code !== 0) {
    console.log(`SKIP python image ${env.imagePy} not found (PyPI 대상은 건너뛴다)`);
  } else {
    const pyJs = "import socket,json\ntry:\n    s=socket.create_connection(('1.1.1.1',443),timeout=3); s.close(); net=True\nexcept Exception:\n    net=False\nprint(json.dumps({'network':net}))";
    const py = await docker(['run', '--rm', '--label', 'lowdown.sandbox=1', '--runtime', env.runtime, '--network', 'none', '--user', `${env.uid}:${env.uid}`, '--cap-drop', 'ALL', '--read-only', env.imagePy, 'python', '-c', pyJs], 60_000);
    const pyOk = py.code === 0 && py.stdout.trim() === '{"network": false}';
    if (!pyOk) bad++;
    console.log(`${pyOk ? 'PASS' : 'FAIL'} python image (no network): ${py.stdout.trim() || py.stderr.trim().slice(0, 200)}`);
  }
  if (bad > 0) fail(`self-test 실패 ${bad}건 — 격리 조건을 확인하기 전에는 실행하지 마세요.`);
  console.log('self-test OK');
}

// ─────────────────────────────────────────────
// 행동 관측 (--observe) — 비공개 테이블 sandbox_observe_runs / sandbox_observe_events 에만 쓴다
// ─────────────────────────────────────────────

interface ObserveRunRow {
  id: string;
  batch_id: string;
  observed_at: string;
  target_key: string;
  registry_type: string;
  ident: string;
  version: string;
  observe_major: number;
  runner_version: string;
  runtime: string;
  outcome: string;
  reached_level: number;
  duration_ms: number | null;
  log_found: boolean;
  log_bytes: number | null;
  log_truncated: boolean;
  unparsed_lines: number | null;
  events_dropped: number | null;
  opens_total: number | null;
  exec_total: number | null;
  harness_execs: number | null;
  connect_total: number | null;
  dns_attempts: number | null;
  credential_opens: number | null;
  note: string | null;
}

interface ObserveEventRow {
  run_id: string;
  kind: string;
  target: string;
  detail: string | null;
  result: string;
  count: number;
}

/** 관측 로그 디렉터리의 파일을 모두 지운다(지난 실행이 남긴 것 포함). 원본 로그는 파싱 뒤 남기지 않는다. */
function clearObserveLogs(dir: string): number {
  let n = 0;
  for (const f of readdirSync(dir)) {
    rmSync(join(dir, f), { force: true, recursive: true });
    n++;
  }
  return n;
}

/** 컨테이너 ID 가 Args 줄에 있는 로그 파일 → 앞부분 OBSERVE_MAX_LOG_BYTES 만 읽고 즉시 지운다 */
function takeObserveLog(dir: string, cid: string): { text: string; bytes: number; truncated: boolean } | null {
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.txt')) continue;
    const path = join(dir, f);
    let fd: number | null = null;
    try {
      fd = openSync(path, 'r');
      const head = Buffer.alloc(16 * 1024);
      const n = readSync(fd, head, 0, head.length, 0);
      if (logContainerId(head.subarray(0, n).toString('utf8')) !== cid) continue;
      const bytes = statSync(path).size;
      const want = Math.min(bytes, OBSERVE_MAX_LOG_BYTES);
      const buf = Buffer.alloc(want);
      let off = 0;
      while (off < want) {
        const r = readSync(fd, buf, off, want - off, off);
        if (r <= 0) break;
        off += r;
      }
      closeSync(fd);
      fd = null;
      rmSync(path, { force: true });
      return { text: buf.subarray(0, off).toString('utf8'), bytes, truncated: bytes > OBSERVE_MAX_LOG_BYTES };
    } catch {
      // 다른 실행이 쓰는 중이거나 읽을 수 없는 파일 → 건너뜀
    } finally {
      if (fd !== null) closeSync(fd);
    }
  }
  return null;
}

async function latestSandboxBatch(cfg: SupabaseConfig): Promise<{ started_at: string; finished_at: string | null } | null> {
  const url = `${cfg.url.replace(/\/+$/, '')}/rest/v1/sandbox_batches?select=started_at,finished_at&order=started_at.desc&limit=1`;
  const res = await fetch(url, { headers: { apikey: cfg.key, Authorization: `Bearer ${cfg.key}`, Accept: 'application/json' }, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`sandbox_batches read failed: HTTP ${res.status}`);
  const rows = (await res.json()) as Array<{ started_at: string; finished_at: string | null }>;
  return rows[0] ?? null;
}

async function observeMain(env: Env, args: string[]): Promise<void> {
  const planOnly = args.includes('--plan');
  const limitArg = args.find((a) => a.startsWith('--limit='));
  const limit = limitArg ? Math.max(0, Number(limitArg.slice(8)) || 0) : intEnv('SANDBOX_OBSERVE_LIMIT', 200);
  const obsRuntime = process.env.SANDBOX_OBSERVE_RUNTIME?.trim() || OBSERVE_DEFAULT_RUNTIME;
  const logDir = process.env.SANDBOX_OBSERVE_LOG_DIR?.trim() || OBSERVE_DEFAULT_LOG_DIR;
  const budgetMs = intEnv('SANDBOX_OBSERVE_BUDGET_MIN', 120) * 60_000;
  const url = process.env.LOWDOWN_SUPABASE_URL?.trim();
  const key = (process.env.LOWDOWN_SANDBOX_KEY || process.env.LOWDOWN_SCANNER_KEY)?.trim();
  if (!url || !key) fail('LOWDOWN_SUPABASE_URL / LOWDOWN_SANDBOX_KEY 가 없습니다.');
  const cfg: SupabaseConfig = { url, key };
  const started = Date.now();

  // 기존 실행과 겹치지 않는다(기존 실행은 시작할 때 lowdown.sandbox 컨테이너를 모두 지운다)
  if (!planOnly && mainRunActive(await latestSandboxBatch(cfg))) {
    console.log('observe: sandbox run in progress, skipping');
    return;
  }

  let pyEnabled = process.env.SANDBOX_PYPI?.trim() !== '0';
  if (pyEnabled && !planOnly) {
    const img = await docker(['image', 'inspect', '-f', '{{.Id}}', env.imagePy]);
    pyEnabled = img.code === 0 && img.stdout.trim() !== '';
  }
  const [state, observedRows, launches] = await Promise.all([
    fetchSandboxState(cfg),
    getKeyset<{ id: string; target_key: string }>(cfg, 'sandbox_observe_runs', 'id,target_key', 'id', [['observe_major', `eq.${OBSERVE_MAJOR}`], ['outcome', 'neq.runner_error']], {}),
    fetchLaunchSpecs(),
  ]);
  const observed = new Set(observedRows.map((r) => r.target_key));
  const picked = planObserve(state as ObserveStateLite[], observed, limit, { pypi: pyEnabled });
  console.log(`observe plan: ${picked.length} targets (ok in sandbox_state ${state.filter((r) => r.last_outcome === 'ok').length}, already observed ${observed.size}, pypi ${pyEnabled ? 'on' : 'off'})`);
  const targets: Target[] = picked.map((r) => ({ key: r.target_key, registry_type: r.registry_type, ident: r.ident, version: r.version, sources: [], fresh_at: r.last_run_at }));
  const launchOf = (t: Target) => pickLaunch(t.registry_type === 'pypi' ? launches.pypiSpecs.get(normalizePypiName(t.ident)) : launches.specs.get(t.ident), t.version);
  if (planOnly) {
    for (const t of targets.slice(0, 20)) console.log(`  ${t.key} args=${JSON.stringify(launchOf(t)?.args ?? null)}`);
    return;
  }

  await preflight(env);
  const info = await docker(['info', '--format', '{{json .Runtimes}}']);
  if (!info.stdout.includes(`"${obsRuntime}"`)) fail(`docker 런타임 ${obsRuntime} 이 없습니다. setup.sh 를 확인하세요.`);
  try {
    accessSync(logDir, fsConstants.R_OK | fsConstants.W_OK | fsConstants.X_OK);
  } catch {
    fail(`관측 로그 폴더 ${logDir} 를 읽고 지울 수 없습니다 (root:lowdown 770 인지 확인).`);
  }
  await cleanupLeftovers(env);
  const stale = clearObserveLogs(logDir);
  if (stale > 0) console.log(`observe: removed ${stale} leftover log file(s)`);

  let stopping = false;
  process.on('SIGTERM', () => {
    stopping = true;
  });
  process.on('SIGINT', () => {
    stopping = true;
  });

  const batchId = randomUUID();
  let runs: ObserveRunRow[] = [];
  let events: ObserveEventRow[] = [];
  const flush = async () => {
    if (runs.length === 0) return;
    const r = runs;
    const e = events;
    runs = [];
    events = [];
    await postBatches(cfg, 'sandbox_observe_runs', r, 'return=minimal', { batchSize: 200 });
    if (e.length > 0) await postBatches(cfg, 'sandbox_observe_events', e, 'return=minimal', { batchSize: 500 });
  };

  const totals = { attempted: 0, observed: 0, no_log: 0, with_exec: 0, with_connect: 0, with_dns: 0, with_credential: 0 };
  const deadline = started + budgetMs;
  let next = 0;
  const worker = async () => {
    for (;;) {
      if (stopping || Date.now() > deadline) return;
      const t = targets[next++];
      if (!t) return;
      if (freeGb(env.root) < env.minFreeGb) {
        stopping = true;
        return;
      }
      const cidfile = join(env.root, 'work', `cid-${randomUUID()}`);
      let res: TargetResult;
      try {
        res = await runTarget(env, t, launchOf(t), { runtime: obsRuntime, cidfile });
      } catch {
        res = { install_ms: null, install_error_code: null, bin_count: null, probe: null, outcome: 'runner_error' };
      }
      let summary: ObserveSummary | null = null;
      let log: { bytes: number; truncated: boolean } | null = null;
      let note: string | null = null;
      if (res.probe) {
        const cid = existsSync(cidfile) ? readFileSync(cidfile, 'utf8').trim() : '';
        let got = cid ? takeObserveLog(logDir, cid) : null;
        if (cid && !got) {
          await new Promise((r) => setTimeout(r, 1000)); // runsc 가 로그를 닫기 전이면 한 번 더
          got = takeObserveLog(logDir, cid);
        }
        if (got) {
          log = { bytes: got.bytes, truncated: got.truncated };
          try {
            summary = parseObserveLog(got.text, res.run_bin_path ?? '', res.run_args ?? []);
          } catch {
            note = 'parse_failed';
          }
        } else note = cid ? 'log_not_found' : 'no_cidfile';
      }
      rmSync(cidfile, { force: true });
      const id = randomUUID();
      const p = res.probe;
      runs.push({
        id,
        batch_id: batchId,
        observed_at: new Date().toISOString(),
        target_key: t.key,
        registry_type: t.registry_type,
        ident: t.ident,
        version: t.version,
        observe_major: OBSERVE_MAJOR,
        runner_version: SANDBOX_RUNNER_VERSION,
        runtime: obsRuntime,
        outcome: res.outcome,
        reached_level: p?.reached_level ?? 0,
        duration_ms: p?.duration_ms ?? null,
        log_found: log !== null,
        log_bytes: log?.bytes ?? null,
        log_truncated: log?.truncated ?? false,
        unparsed_lines: summary?.unparsed_lines ?? null,
        events_dropped: summary?.events_dropped ?? null,
        opens_total: summary?.opens_total ?? null,
        exec_total: summary?.exec_total ?? null,
        harness_execs: summary?.harness_execs ?? null,
        connect_total: summary?.connect_total ?? null,
        dns_attempts: summary?.dns_attempts ?? null,
        credential_opens: summary?.credential_opens ?? null,
        note,
      });
      for (const e of summary?.events ?? []) events.push({ run_id: id, kind: e.kind, target: e.target, detail: e.detail, result: e.result, count: e.count });
      totals.attempted++;
      if (summary) {
        totals.observed++;
        if (summary.exec_total > 0) totals.with_exec++;
        if (summary.connect_total > 0) totals.with_connect++;
        if (summary.dns_attempts > 0) totals.with_dns++;
        if (summary.credential_opens > 0) totals.with_credential++;
      } else if (res.probe) totals.no_log++;
      if (runs.length >= FLUSH_EVERY) await flush();
    }
  };
  try {
    await Promise.all(Array.from({ length: env.concurrency }, worker));
    await flush();
  } finally {
    clearObserveLogs(logDir); // 못 가져간 로그도 남기지 않는다
  }
  console.log(`observe done: ${JSON.stringify(totals)}, sec ${Math.round((Date.now() - started) / 1000)}${stopping ? ', stopped early' : ''}`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const env = readEnv();
  if (args.includes('--self-test')) return selfTest(env);
  if (args.includes('--observe')) return observeMain(env, args);

  const planOnly = args.includes('--plan');
  const onlyArg = args.find((a) => a.startsWith('--only='))?.slice('--only='.length);
  if (onlyArg !== undefined && onlyArg !== 'pypi' && onlyArg !== 'npm') fail('--only 는 pypi 또는 npm 입니다.');
  const limitArg = args.find((a) => a.startsWith('--limit='));
  const limit = limitArg ? Math.max(0, Number(limitArg.slice(8)) || 0) : env.maxTargets;
  const url = process.env.LOWDOWN_SUPABASE_URL?.trim();
  const key = (process.env.LOWDOWN_SANDBOX_KEY || process.env.LOWDOWN_SCANNER_KEY)?.trim();
  if (!url || !key) fail('LOWDOWN_SUPABASE_URL / LOWDOWN_SANDBOX_KEY 가 없습니다.');
  const cfg: SupabaseConfig = { url, key };

  const started = Date.now();
  const runId = randomUUID();
  // PyPI 이미지가 아직 없는 서버(코드만 먼저 받은 경우)에서는 npm 만 돈다 — 매일 도는 npm 실행이 멈추지 않게
  let pyImageId: string | null = null;
  let pyNote: string | null = null;
  if (process.env.SANDBOX_PYPI?.trim() === '0') pyNote = 'pypi off (SANDBOX_PYPI=0)';
  else if (!planOnly) {
    const img = await docker(['image', 'inspect', '-f', '{{.Id}}', env.imagePy]);
    pyImageId = img.code === 0 ? img.stdout.trim() || null : null;
    if (!pyImageId) pyNote = `pypi skipped: image ${env.imagePy} not found`;
  }
  const pyEnabled = pyNote === null;
  if (pyNote) console.log(pyNote);
  const [registry, npm, state, launches, pypiState] = await Promise.all([
    fetchRegistryLite(cfg),
    fetchNpmLite(cfg),
    fetchSandboxState(cfg),
    fetchLaunchSpecs(),
    pyEnabled ? fetchPypiLite(cfg) : Promise.resolve(undefined),
  ]);
  if (onlyArg === 'pypi' && !pyEnabled) fail(`--only=pypi 인데 PyPI 를 쓸 수 없습니다: ${pyNote}`);
  const planned = planTargets(registry, npm, state, { limit: onlyArg ? 1_000_000 : limit, ...(pypiState ? { pypiState } : {}) });
  const targets = onlyArg ? planned.targets.filter((t) => t.registry_type === onlyArg).slice(0, limit) : planned.targets;
  const stats = { ...planned.stats, planned: targets.length };
  console.log(`plan: ${JSON.stringify(stats)}`);
  console.log(`registry launch specs: ${launches.specs.size} npm + ${launches.pypiSpecs.size} pypi stdio packages (${launches.entries} entries, ${launches.pages} pages)`);
  const launchOf = (t: Target) => pickLaunch(t.registry_type === 'pypi' ? launches.pypiSpecs.get(normalizePypiName(t.ident)) : launches.specs.get(t.ident), t.version);
  if (planOnly) {
    for (const t of targets.slice(0, 20)) {
      const l = launchOf(t);
      console.log(`  ${t.key} [${t.sources.join(',')}] args=${JSON.stringify(l?.args ?? null)} env_required=${l?.env_required ?? '-'}`);
    }
    return;
  }

  const imageId = await preflight(env);
  await cleanupLeftovers(env);
  const batch: SandboxBatchRow = {
    run_id: runId,
    started_at: new Date(started).toISOString(),
    finished_at: null,
    runner_version: SANDBOX_RUNNER_VERSION,
    image_id: imageId,
    runtime: env.runtime,
    planned: targets.length,
    attempted: 0,
    outcomes: {},
    plan_stats: { ...stats },
    note: null,
  };
  await upsertSandboxBatch(cfg, batch); // 시작 표시(watchdog 은 이 행을 본다)

  let stopping = false;
  process.on('SIGTERM', () => {
    stopping = true;
  });
  process.on('SIGINT', () => {
    stopping = true;
  });

  const prevState = new Map(state.map((s) => [s.target_key, s]));
  let runs: SandboxRunRow[] = [];
  let states: SandboxStateRow[] = [];
  let defs = new ToolDefCollector();
  const flush = async () => {
    if (runs.length === 0) return;
    const now = new Date().toISOString();
    const r = runs;
    const s = states;
    const d = defs;
    runs = [];
    states = [];
    defs = new ToolDefCollector();
    await insertToolDefs(cfg, toolDefRows(d, { now, scanRunId: runId }));
    await insertToolSetVersions(cfg, toolSetVersionRows(d, { now, scanRunId: runId }));
    await insertSandboxRuns(cfg, r);
    await upsertSandboxState(cfg, s);
  };

  const deadline = started + env.budgetMs;
  let next = 0;
  const worker = async () => {
    for (;;) {
      if (stopping || Date.now() > deadline) return;
      const i = next++;
      const t = targets[i];
      if (!t) return;
      if (freeGb(env.root) < env.minFreeGb) {
        batch.note = 'stopped: low disk';
        stopping = true;
        return;
      }
      const launch = launchOf(t);
      let res: TargetResult;
      try {
        res = await runTarget(env, t, launch);
      } catch {
        res = { install_ms: null, install_error_code: null, bin_count: null, probe: null, outcome: 'runner_error' };
      }
      const now = new Date().toISOString();
      const p = res.probe;
      runs.push({
        run_id: runId,
        observed_at: now,
        registry_type: t.registry_type,
        ident: t.ident,
        version: t.version,
        sources: t.sources,
        runner_version: SANDBOX_RUNNER_VERSION,
        run_major: SANDBOX_RUN_MAJOR,
        image_id: t.registry_type === 'pypi' ? (pyImageId ?? imageId) : imageId,
        runtime: env.runtime,
        install_ms: res.install_ms,
        install_error_code: res.install_error_code,
        bin_count: res.bin_count,
        registry_name: launch?.registry_name ?? null,
        args: launch?.args ?? [],
        outcome: res.outcome,
        reached_level: p?.reached_level ?? 0,
        exit_code: p?.exit_code ?? null,
        signal: p?.signal ?? null,
        init_ms: p?.init_ms ?? null,
        list_ms: p?.list_ms ?? null,
        duration_ms: p?.duration_ms ?? null,
        metadata: {
          ...(p?.metadata ?? {}),
          ...(res.install_scripts !== undefined ? { install_scripts: res.install_scripts } : {}),
          ...(res.install_retry ? { install_retry: res.install_retry } : {}),
          ...(launch ? { args_unsatisfied: launch.args_unsatisfied, env_required: launch.env_required, env_secret: launch.env_secret } : { launch_spec: 'not_in_registry' }),
        },
      });
      if (p?.tool_defs) defs.add(p.metadata.tool_set_hash, p.tool_defs);
      states.push(nextState(prevState.get(t.key), t, res.outcome, now));
      batch.attempted++;
      batch.outcomes[res.outcome] = (batch.outcomes[res.outcome] ?? 0) + 1;
      if (runs.length >= FLUSH_EVERY) await flush();
    }
  };
  await Promise.all(Array.from({ length: env.concurrency }, worker));
  await flush();

  if (!batch.note && Date.now() > deadline && batch.attempted < targets.length) batch.note = 'stopped: time budget';
  if (!batch.note && stopping) batch.note = 'stopped: signal';
  if (pyNote) batch.note = batch.note ? `${batch.note}; ${pyNote}` : pyNote;
  batch.finished_at = new Date().toISOString();
  await upsertSandboxBatch(cfg, batch);
  console.log(`done: attempted ${batch.attempted}/${targets.length}, outcomes ${JSON.stringify(batch.outcomes)}, sec ${Math.round((Date.now() - started) / 1000)}${batch.note ? `, ${batch.note}` : ''}`);
}

main().catch((e: unknown) => fail(e instanceof Error ? e.message : 'sandbox runner failed'));
