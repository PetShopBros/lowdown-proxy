// Lowdown stdio 샌드박스 실행기 — 샌드박스 서버(호스트)에서만 돈다. GitHub Actions 에서 돌리지 않는다.
// 사용:
//   node sandbox/runner.ts               대상 선정 → 설치 → 실행(initialize + tools/list) → 기록
//   node sandbox/runner.ts --plan        대상 선정만(docker 안 씀, DB 쓰기 없음)
//   node sandbox/runner.ts --self-test   격리 확인: 컨테이너가 MCP 로 응답하는지, 네트워크가 막혔는지 (DB 안 씀)
//   --limit=N                            이번 실행의 대상 수 상한
// 환경변수(/etc/lowdown/sandbox.env, systemd 가 읽는다):
//   필수 LOWDOWN_SUPABASE_URL, LOWDOWN_SANDBOX_KEY (없으면 LOWDOWN_SCANNER_KEY)
//   선택 SANDBOX_IMAGE(lowdown-sandbox-node:1) SANDBOX_RUNTIME(runsc) SANDBOX_ROOT(/var/lib/lowdown)
//        SANDBOX_CONCURRENCY(2) SANDBOX_MAX_TARGETS(400) SANDBOX_TIME_BUDGET_MIN(240)
//        SANDBOX_MIN_FREE_GB(5) SANDBOX_CACHE_MAX_GB(20)
// 키는 이 프로세스만 쓴다. 컨테이너에는 어떤 환경변수도 넘기지 않는다(HOME=/tmp 만).

import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statfsSync, statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SupabaseConfig } from '../scanner/lib.ts';
import { insertToolDefs, insertToolSetVersions, ToolDefCollector, toolDefRows, toolSetVersionRows } from '../scanner/tool-defs.ts';
import {
  chooseBin,
  classifyInstallFailure,
  hasInstallScripts,
  installArgs,
  nextState,
  pickLaunch,
  planTargets,
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
    runtime: process.env.SANDBOX_RUNTIME?.trim() || 'runsc',
    root: process.env.SANDBOX_ROOT?.trim() || '/var/lib/lowdown',
    uid,
    concurrency: Math.min(4, intEnv('SANDBOX_CONCURRENCY', 2)),
    maxTargets: intEnv('SANDBOX_MAX_TARGETS', 400),
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
  const free = freeGb(env.root);
  if (free < env.minFreeGb) fail(`디스크 여유 ${free.toFixed(1)}GB < ${env.minFreeGb}GB`);
  // npm 캐시가 커지면 비운다(무결성은 npm 이 검사하므로 캐시는 속도·요청 수 절약용일 뿐)
  const du = await runCmd('du', ['-sb', join(env.root, 'npm-cache')], { timeoutMs: 120_000 });
  const bytes = Number(du.stdout.split('\t')[0]);
  if (Number.isFinite(bytes) && bytes > env.cacheMaxGb * 1024 ** 3) {
    console.log(`npm cache ${(bytes / 1024 ** 3).toFixed(1)}GB > ${env.cacheMaxGb}GB, clearing`);
    rmSync(join(env.root, 'npm-cache'), { recursive: true, force: true });
    mkdirSync(join(env.root, 'npm-cache'), { recursive: true, mode: 0o700 });
  }
  return imageId;
}

interface TargetResult {
  install_ms: number | null;
  install_error_code: string | null;
  bin_count: number | null;
  probe: StdioProbeResult | null;
  install_scripts?: boolean;
  outcome: Outcome;
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

async function runTarget(env: Env, t: Target, launch: LaunchSpec | null): Promise<TargetResult> {
  const work = mkdtempSync(join(env.root, 'work', 't-'));
  chmodSync(work, 0o700);
  const name = `lds-${randomUUID().slice(0, 12)}`;
  const ctx: DockerCtx = { image: env.image, runtime: env.runtime, uid: env.uid, name, workHost: work };
  try {
    // 1) 설치 (스크립트 실행 없음)
    const inst = await docker(installArgs({ ...ctx, cacheHost: join(env.root, 'npm-cache') }, t.ident, t.version), INSTALL_TIMEOUT_MS);
    await docker(['rm', '-f', name]);
    if (inst.code !== 0) {
      if (inst.code === 125 && !inst.timedOut) return { install_ms: inst.ms, install_error_code: null, bin_count: null, probe: null, outcome: 'runner_error' };
      const c = classifyInstallFailure(inst.stderr, inst.timedOut);
      return { install_ms: inst.ms, install_error_code: c.code, bin_count: null, probe: null, outcome: c.outcome };
    }

    // 2) 실행 파일 결정 (npx 와 같은 규칙)
    const pkgJson = readPackageJson(work, t.ident);
    const scripts = hasInstallScripts(pkgJson);
    const pick = chooseBin(pkgJson, t.ident);
    if (pick.outcome !== 'ok' || !pick.bin || !existsSync(join(work, 'node_modules', '.bin', pick.bin))) {
      return { install_ms: inst.ms, install_error_code: null, bin_count: pick.count, probe: null, install_scripts: scripts, outcome: pick.outcome === 'bin_ambiguous' ? 'bin_ambiguous' : 'no_bin' };
    }

    // 3) 실행: initialize + tools/list
    const hardLimit = Math.ceil((DEFAULT_PROBE_OPTS.initTimeoutMs + DEFAULT_PROBE_OPTS.listTimeoutMs) / 1000) + 15;
    const probe = await probeStdio(['docker', ...runArgs({ ...ctx, name: `${name}-r` }, pick.bin, hardLimit, launch?.args ?? [])]);
    await docker(['rm', '-f', `${name}-r`]);
    return { install_ms: inst.ms, install_error_code: null, bin_count: pick.count, probe, install_scripts: scripts, outcome: probe.outcome };
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
  if (bad > 0) fail(`self-test 실패 ${bad}건 — 격리 조건을 확인하기 전에는 실행하지 마세요.`);
  console.log('self-test OK');
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const env = readEnv();
  if (args.includes('--self-test')) return selfTest(env);

  const planOnly = args.includes('--plan');
  const limitArg = args.find((a) => a.startsWith('--limit='));
  const limit = limitArg ? Math.max(0, Number(limitArg.slice(8)) || 0) : env.maxTargets;
  const url = process.env.LOWDOWN_SUPABASE_URL?.trim();
  const key = (process.env.LOWDOWN_SANDBOX_KEY || process.env.LOWDOWN_SCANNER_KEY)?.trim();
  if (!url || !key) fail('LOWDOWN_SUPABASE_URL / LOWDOWN_SANDBOX_KEY 가 없습니다.');
  const cfg: SupabaseConfig = { url, key };

  const started = Date.now();
  const runId = randomUUID();
  const [registry, npm, state, launches] = await Promise.all([fetchRegistryLite(cfg), fetchNpmLite(cfg), fetchSandboxState(cfg), fetchLaunchSpecs()]);
  const { targets, stats } = planTargets(registry, npm, state, { limit });
  console.log(`plan: ${JSON.stringify(stats)}`);
  console.log(`registry launch specs: ${launches.specs.size} npm stdio packages (${launches.entries} entries, ${launches.pages} pages)`);
  if (planOnly) {
    for (const t of targets.slice(0, 20)) {
      const l = pickLaunch(launches.specs.get(t.ident), t.version);
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
      const launch = pickLaunch(launches.specs.get(t.ident), t.version);
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
        registry_type: 'npm',
        ident: t.ident,
        version: t.version,
        sources: t.sources,
        runner_version: SANDBOX_RUNNER_VERSION,
        run_major: SANDBOX_RUN_MAJOR,
        image_id: imageId,
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
  batch.finished_at = new Date().toISOString();
  await upsertSandboxBatch(cfg, batch);
  console.log(`done: attempted ${batch.attempted}/${targets.length}, outcomes ${JSON.stringify(batch.outcomes)}, sec ${Math.round((Date.now() - started) / 1000)}${batch.note ? `, ${batch.note}` : ''}`);
}

main().catch((e: unknown) => fail(e instanceof Error ? e.message : 'sandbox runner failed'));
