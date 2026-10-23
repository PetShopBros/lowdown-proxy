// stdio 샌드박스 — DB 입출력과 명령 실행
//   읽기: registry_state(선언), npm_package_state(최신 버전), sandbox_state(끝난 대상)
//   쓰기: sandbox_runs(실행 이력), sandbox_state(대상당 1행), sandbox_batches(실행 묶음 1행 — watchdog 이 본다),
//         도구 정의 원문은 Scanner 와 같은 비공개 테이블(scanner_tool_defs / scanner_tool_set_versions)

import { spawn } from 'node:child_process';
import { supabaseHeaders, type SupabaseConfig } from '../scanner/lib.ts';
import { getKeyset } from '../scanner/npm-lib.ts';
import { postBatches, type DiffIoDeps } from '../scanner/registry-diff.ts';
import type { NpmStateLite, RegistryRowLite, SandboxStateRow } from './sandbox-lib.ts';

export interface SandboxRunRow {
  run_id: string;
  observed_at: string;
  registry_type: 'npm';
  ident: string;
  version: string;
  sources: string[];
  runner_version: string;
  run_major: number;
  image_id: string;
  runtime: string;
  install_ms: number | null;
  install_error_code: string | null;
  bin_count: number | null;
  outcome: string;
  reached_level: number;
  exit_code: number | null;
  signal: string | null;
  init_ms: number | null;
  list_ms: number | null;
  duration_ms: number | null;
  metadata: Record<string, unknown>;
}

export interface SandboxBatchRow {
  run_id: string;
  started_at: string;
  finished_at: string | null;
  runner_version: string;
  image_id: string;
  runtime: string;
  planned: number;
  attempted: number;
  outcomes: Record<string, number>;
  plan_stats: Record<string, number>;
  note: string | null;
}

export async function fetchRegistryLite(cfg: SupabaseConfig, deps: DiffIoDeps = {}): Promise<RegistryRowLite[]> {
  return getKeyset<RegistryRowLite & Record<string, unknown>>(
    cfg,
    'registry_state',
    'name,packages_key,updated_at',
    'name',
    [['removed_at', 'is.null'], ['packages_key', 'like.*stdio*']],
    deps,
  );
}

export function fetchNpmLite(cfg: SupabaseConfig, deps: DiffIoDeps = {}): Promise<NpmStateLite[]> {
  return getKeyset<NpmStateLite & Record<string, unknown>>(cfg, 'npm_package_state', 'ident,status,latest,modified', 'ident', [], deps);
}

const STATE_COLUMNS = 'target_key,registry_type,ident,version,attempts,done,last_outcome,first_run_at,last_run_at,run_major';

export function fetchSandboxState(cfg: SupabaseConfig, deps: DiffIoDeps = {}): Promise<SandboxStateRow[]> {
  return getKeyset<SandboxStateRow & Record<string, unknown>>(cfg, 'sandbox_state', STATE_COLUMNS, 'target_key', [], deps);
}

export function upsertSandboxState(cfg: SupabaseConfig, rows: readonly SandboxStateRow[], deps: DiffIoDeps = {}): Promise<number> {
  return postBatches(cfg, 'sandbox_state?on_conflict=target_key', rows, 'resolution=merge-duplicates,return=minimal', { batchSize: 200, ...deps });
}

export function insertSandboxRuns(cfg: SupabaseConfig, rows: readonly SandboxRunRow[], deps: DiffIoDeps = {}): Promise<number> {
  return postBatches(cfg, 'sandbox_runs', rows, 'return=minimal', { batchSize: 200, ...deps });
}

export function upsertSandboxBatch(cfg: SupabaseConfig, row: SandboxBatchRow, deps: DiffIoDeps = {}): Promise<number> {
  return postBatches(cfg, 'sandbox_batches?on_conflict=run_id', [row], 'resolution=merge-duplicates,return=minimal', deps);
}

/** 가장 최근 실행 묶음의 시작 시각 (watchdog) */
export async function latestBatchStartedAt(cfg: SupabaseConfig, fetchImpl: typeof fetch = fetch): Promise<string | null> {
  const url = `${cfg.url.replace(/\/+$/, '')}/rest/v1/sandbox_batches?select=started_at&order=started_at.desc&limit=1`;
  const res = await fetchImpl(url, { headers: supabaseHeaders(cfg.key, { Accept: 'application/json' }), signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`sandbox_batches read failed: HTTP ${res.status}`);
  const rows = (await res.json()) as Array<{ started_at?: unknown }>;
  const v = Array.isArray(rows) ? rows[0]?.started_at : undefined;
  return typeof v === 'string' ? v : null;
}

// ─────────────────────────────────────────────
// 명령 실행 (docker CLI)
// ─────────────────────────────────────────────

export interface CmdResult {
  code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  ms: number;
}

/** 출력은 앞부분 maxBytes 까지만 메모리에 둔다(분류용). 시간 초과면 SIGKILL. */
export function runCmd(file: string, args: readonly string[], opts: { timeoutMs: number; maxBytes?: number }): Promise<CmdResult> {
  const max = opts.maxBytes ?? 64 * 1024;
  const started = Date.now();
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const child = spawn(file, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, opts.timeoutMs);
    child.stdout.on('data', (c: Buffer) => {
      if (stdout.length < max) stdout += c.toString('utf8').slice(0, max - stdout.length);
    });
    child.stderr.on('data', (c: Buffer) => {
      if (stderr.length < max) stderr += c.toString('utf8').slice(0, max - stderr.length);
    });
    const done = (code: number | null, signal: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr, timedOut, ms: Date.now() - started });
    };
    child.on('error', () => done(null, null));
    child.on('close', (code, signal) => done(code, signal));
  });
}
