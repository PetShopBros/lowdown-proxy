// ERC-8004 등록 수집 — 사용: node scanner/erc8004.ts [--dry-run] [--chains=base,ethereum] [--fetch-limit=N]
// 필수 환경변수: LOWDOWN_SUPABASE_URL, LOWDOWN_SCANNER_KEY (서버에서는 LOWDOWN_SANDBOX_KEY 도 받는다)
// 선택: ERC8004_RPC_BASE, ERC8004_RPC_ETHEREUM (기본 Blockscout 인스턴스), ERC8004_RPC_INTERVAL_MS(기본 400, 호출 간격), ERC8004_FETCH_LIMIT(기본 5000), ERC8004_TIME_BUDGET_MIN(기본 30),
//       ERC8004_LOG_BUDGET_MIN(기본 18, 이벤트 읽기에 쓰는 시간), ERC8004_MAX_LOG_CALLS(기본 4000), ERC8004_CONCURRENCY(기본 8)
// 순서: 체인마다 이벤트 읽기(이어서) → 에이전트 상태 계산 → 가져올 차례인 등록 파일 가져오기 → 이름표·연결선.
// 체인은 읽기만 한다. 본 관찰(scan.ts)과 따로 돈다.

import { appendFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { SupabaseConfig } from './lib.ts';
import { supabaseHeaders } from './lib.ts';
import { postBatches } from './registry-diff.ts';
import {
  CHAINS,
  IDENTITY_REGISTRY,
  type ChainConf,
  type EventRow,
  fetchRegistrationFile,
  findDeployBlock,
  makeRpc,
  parseLog,
  pool,
  readLogs,
} from './erc8004-lib.ts';


function fail(message: string): never {
  console.error(`::error::${message}`);
  process.exit(1);
}
const intEnv = (name: string, dflt: number) => {
  const v = Number(process.env[name]);
  return Number.isInteger(v) && v > 0 ? v : dflt;
};

async function dbGet<T>(cfg: SupabaseConfig, path: string): Promise<T[]> {
  const res = await fetch(`${cfg.url.replace(/\/+$/, '')}/rest/v1/${path}`, { headers: supabaseHeaders(cfg.key, { Accept: 'application/json' }), signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`${path.split('?')[0]} read failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  return (await res.json()) as T[];
}
async function dbRpc<T>(cfg: SupabaseConfig, fn: string, args: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${cfg.url.replace(/\/+$/, '')}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: supabaseHeaders(cfg.key, { 'Content-Type': 'application/json', Accept: 'application/json' }),
    body: JSON.stringify(args),
    signal: AbortSignal.timeout(300_000),
  });
  if (!res.ok) throw new Error(`rpc ${fn} failed: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
  return (await res.json()) as T;
}

type Cursor = { chain_id: number; registry: string; first_block: number | null; last_block: number };

async function readChain(cfg: SupabaseConfig, chain: ChainConf, dryRun: boolean, deadline: number, maxCalls: number) {
  const rpcUrl = process.env[`ERC8004_RPC_${chain.name.toUpperCase()}`]?.trim() || chain.rpc;
  const rpc = makeRpc(rpcUrl, fetch, 30_000, undefined, intEnv('ERC8004_RPC_INTERVAL_MS', 400));
  const head = BigInt((await rpc('eth_blockNumber', [])) as string);
  const safe = head - BigInt(chain.confirmations);
  const [cur] = await dbGet<Cursor>(cfg, `erc8004_cursor?chain_id=eq.${chain.chainId}&select=chain_id,registry,first_block,last_block`);
  let first: bigint | null = cur?.first_block != null ? BigInt(cur.first_block) : null;
  if (!cur) {
    // 처음: 레지스트리 코드가 생긴 블록을 찾는다(eth_getCode 약 25번). 안 되면 고정 시작 블록(빈 구간이 길 뿐).
    try {
      first = await findDeployBlock(rpc, IDENTITY_REGISTRY, safe);
    } catch (e) {
      console.log(`${chain.name}: deploy block search failed (${e instanceof Error ? e.message : e}); starting at ${chain.startBlock}`);
    }
  }
  const from = cur ? BigInt(cur.last_block) + 1n : (first ?? chain.startBlock);
  console.log(`${chain.name}: head ${head}, read ${from}..${safe}${first !== null && !cur ? ` (registry code from ${first})` : ''}`);
  if (from > safe) return { chain: chain.name, events: 0, calls: 0, complete: true, applied: 0 };

  let pending: EventRow[] = [];
  let applyFrom = from;
  let events = 0;
  let applied = 0;
  // 순서: 이벤트 저장 → 에이전트 상태 계산 → 커서 저장. 중간에 실패하면 커서가 그대로라 다음 실행이 다시 읽는다(이벤트는 중복 무시).
  const saveCursor = (upTo: bigint) =>
    postBatches(cfg, 'erc8004_cursor?on_conflict=chain_id', [{ chain_id: chain.chainId, registry: IDENTITY_REGISTRY, first_block: first === null ? null : Number(first), last_block: Number(upTo), updated_at: new Date().toISOString() }], 'resolution=merge-duplicates,return=minimal', {});
  const flush = async (upTo: bigint, force: boolean) => {
    if (pending.length === 0) {
      if (!dryRun) await saveCursor(upTo);
      applyFrom = upTo + 1n;
      return;
    }
    if (!force && pending.length < 5000) return; // 더 모은다(커서는 그대로)
    if (!dryRun) {
      await postBatches(cfg, 'erc8004_events?on_conflict=chain_id,tx_hash,log_index', pending, 'resolution=ignore-duplicates,return=minimal', { batchSize: 500 });
      applied += await dbRpc<number>(cfg, 'lowdown_erc8004_apply', { p_chain: chain.chainId, p_from_block: Number(applyFrom) });
      await saveCursor(upTo);
    }
    pending = [];
    applyFrom = upTo + 1n;
  };

  const r = await readLogs(rpc, IDENTITY_REGISTRY, from, safe, {
    maxRange: chain.maxRange,
    deadline,
    maxCalls,
    onChunk: async (logs, upTo) => {
      for (const l of logs) {
        const row = parseLog(chain.chainId, l);
        if (row) pending.push(row);
      }
      events += logs.length;
      await flush(upTo, false);
    },
  });
  if (r.readTo >= from) await flush(r.readTo, true);
  console.log(`${chain.name}: events ${events}, getLogs calls ${r.calls}, read to ${r.readTo}${r.complete ? '' : ' (stopped at budget, continues next run)'}, agents updated ${applied}`);
  return { chain: chain.name, events, calls: r.calls, complete: r.complete, applied };
}

type Due = { chain_id: number; agent_id: string; agent_uri: string | null; uri_truncated: boolean };

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const chainsArg = args.find((a) => a.startsWith('--chains='))?.slice(9).split(',').filter(Boolean);
  const fetchLimitArg = Number(args.find((a) => a.startsWith('--fetch-limit='))?.slice(14));
  const url = process.env.LOWDOWN_SUPABASE_URL?.trim();
  const key = (process.env.LOWDOWN_SCANNER_KEY || process.env.LOWDOWN_SANDBOX_KEY)?.trim();
  if (!url || !key) fail('LOWDOWN_SUPABASE_URL / LOWDOWN_SCANNER_KEY(또는 LOWDOWN_SANDBOX_KEY) 가 없습니다.');
  const cfg = { url, key };
  const started = Date.now();
  const total = started + intEnv('ERC8004_TIME_BUDGET_MIN', 30) * 60_000;
  const logDeadline = started + intEnv('ERC8004_LOG_BUDGET_MIN', 18) * 60_000;
  const chains = CHAINS.filter((c) => !chainsArg || chainsArg.includes(c.name));
  const runId = randomUUID();
  console.log(`erc8004 run ${runId}, chains ${chains.map((c) => c.name).join(',')}, dry_run=${dryRun}`);

  // 1) 이벤트 (체인 하나가 실패해도 다른 체인은 계속)
  let chainErrors = 0;
  for (const c of chains) {
    try {
      await readChain(cfg, c, dryRun, logDeadline, intEnv('ERC8004_MAX_LOG_CALLS', 4000));
    } catch (e) {
      chainErrors++;
      console.log(`::warning::${c.name}: ${e instanceof Error ? e.message : e}`);
    }
  }

  // 2) 등록 파일
  const limit = Number.isInteger(fetchLimitArg) && fetchLimitArg >= 0 ? fetchLimitArg : intEnv('ERC8004_FETCH_LIMIT', 5000);
  const chainIds = chains.map((c) => c.chainId).join(',');
  const due: Due[] = [];
  for (let off = 0; off < limit; off += 1000) {
    const page = await dbGet<Due>(cfg, `erc8004_fetch_due?select=chain_id,agent_id,agent_uri,uri_truncated&chain_id=in.(${chainIds})&order=due_rank.asc,registered_block.desc.nullslast,chain_id.asc,agent_id.asc&limit=${Math.min(1000, limit - off)}&offset=${off}`);
    due.push(...page);
    if (page.length < 1000) break;
  }
  const rows = await pool(due, intEnv('ERC8004_CONCURRENCY', 8), total - 60_000, async (d) => {
    const f = await fetchRegistrationFile(d.agent_uri, d.uri_truncated);
    return { chain_id: d.chain_id, agent_id: d.agent_id, agent_uri: d.agent_uri ?? '', fetched_at: new Date().toISOString(), run_id: runId, ...f };
  });
  const byOutcome = new Map<string, number>();
  for (const r of rows) byOutcome.set(r.outcome, (byOutcome.get(r.outcome) ?? 0) + 1);
  const mcp = rows.reduce((n, r) => n + (r.services ?? []).filter((s) => s.name.toLowerCase() === 'mcp').length, 0);
  console.log(`files: due ${due.length}, fetched ${rows.length}, ${[...byOutcome].map(([k, n]) => `${k} ${n}`).join(', ')}; MCP services declared ${mcp}`);

  let link: unknown = null;
  if (!dryRun && rows.length) {
    await postBatches(cfg, 'erc8004_files', rows, 'return=minimal', { batchSize: 200 });
    link = await dbRpc(cfg, 'lowdown_erc8004_link', { p_run: runId });
    console.log(`link: ${JSON.stringify(link)}`);
  }
  console.log(`erc8004 done in ${Math.round((Date.now() - started) / 1000)}s${dryRun ? ' (dry-run, nothing written)' : ''}`);
  const out = process.env.GITHUB_OUTPUT;
  if (out) appendFileSync(out, `erc8004_files=${rows.length}\nerc8004_mcp=${mcp}\n`);
  if (chainErrors === chains.length) fail('all chains failed');
}

main().catch((e: unknown) => fail(e instanceof Error ? e.message : 'erc8004 failed'));
