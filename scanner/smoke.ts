// 실제 서비스 점검 — 사용: node scanner/smoke.ts [--db]
// 공개 주소 몇 개를 실제로 불러 본다. 하나라도 실패하면 종료 코드 1(워크플로가 이슈를 만든다).
//   1) /status.json: 200, stale 아님
//   2) 조회 API: 200, summary 블록, 상태 블록이 오래되지 않음 (x-lowdown-source: seeded → 자기 점검으로 집계에서 빠진다)
//   3) 원격 MCP: initialize·tools/list 응답, get_lowdown·find_servers 가 목록에 있음
//   4) (--db) 오늘(UTC) 고정 코호트 관찰 행이 최소치 이상 — 본 관찰이 끝난 뒤에만 의미가 있다
// 환경변수: LOWDOWN_BASE_URL(기본 https://lowdown-proxy.vercel.app), --db 일 때 LOWDOWN_SUPABASE_URL·LOWDOWN_SCANNER_KEY,
//           SMOKE_MIN_ROWS(기본 5000 = 고정 코호트 1만의 절반)
// 출력은 사실만(무엇을 불렀고 무엇이 왔나). 오류 원문·비밀값은 남기지 않는다.

import { appendFileSync } from 'node:fs';
import { supabaseHeaders } from './lib.ts';

export const SMOKE_UA = 'lowdown-smoke/1 (self-check; +https://github.com/PetShopBros/lowdown-proxy)';
export const SMOKE_TARGET = 'mcp:io.github.github/github-mcp-server';

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

type F = typeof fetch;
const T = 20_000;

async function getJson(f: F, url: string, headers: Record<string, string> = {}): Promise<{ status: number; body: any }> {
  const res = await f(url, { headers: { 'user-agent': SMOKE_UA, accept: 'application/json', ...headers }, signal: AbortSignal.timeout(T) });
  let body: any = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

async function guard(name: string, fn: () => Promise<Check>): Promise<Check> {
  try {
    return await fn();
  } catch (e) {
    const kind = e instanceof Error && /timeout|abort/i.test(e.name + e.message) ? 'timeout' : 'network error';
    return { name, ok: false, detail: kind };
  }
}

export function checkStatus(f: F, base: string): Promise<Check> {
  return guard('status.json', async () => {
    const r = await getJson(f, `${base}/status.json`);
    if (r.status !== 200) return { name: 'status.json', ok: false, detail: `HTTP ${r.status}` };
    if (!r.body || typeof r.body !== 'object') return { name: 'status.json', ok: false, detail: 'not JSON' };
    if (r.body.stale !== false) return { name: 'status.json', ok: false, detail: 'stale snapshot' };
    return { name: 'status.json', ok: true, detail: 'HTTP 200, fresh' };
  });
}

export function checkLookup(f: F, base: string): Promise<Check> {
  return guard('lookup', async () => {
    const r = await getJson(f, `${base}/api/reputation/${encodeURIComponent(SMOKE_TARGET)}?menu=status&nc=1`, { 'x-lowdown-source': 'seeded' });
    if (r.status !== 200) return { name: 'lookup', ok: false, detail: `HTTP ${r.status}${r.body?.error ? ` ${String(r.body.error).slice(0, 40)}` : ''}` };
    if (!r.body?.summary || typeof r.body.summary.auth !== 'string') return { name: 'lookup', ok: false, detail: 'summary missing' };
    const days = r.body?.status?.days_since_latest_check;
    if (typeof days !== 'number') return { name: 'lookup', ok: false, detail: 'status block missing' };
    if (r.body.status.stale === true) return { name: 'lookup', ok: false, detail: `latest check ${days} days ago (stale)` };
    return { name: 'lookup', ok: true, detail: `HTTP 200, latest check ${days} day(s) ago` };
  });
}

export function checkMcp(f: F, base: string): Promise<Check> {
  return guard('mcp', async () => {
    const post = async (body: object) => {
      const res = await f(`${base}/mcp`, {
        method: 'POST',
        headers: { 'user-agent': SMOKE_UA, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(T),
      });
      const text = await res.text();
      // JSON 응답(enableJsonResponse) 또는 SSE(data: 줄) 둘 다 읽는다
      const json = text.trim().startsWith('{') ? text : text.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('');
      let msg: any = null;
      try {
        msg = JSON.parse(json);
      } catch {
        msg = null;
      }
      return { status: res.status, msg };
    };
    const init = await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'lowdown-smoke', version: '1' } } });
    if (init.status !== 200 || !init.msg?.result) return { name: 'mcp', ok: false, detail: `initialize HTTP ${init.status}` };
    const list = await post({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const tools: string[] = Array.isArray(list.msg?.result?.tools) ? list.msg.result.tools.map((t: any) => String(t?.name)) : [];
    const missing = ['get_lowdown', 'find_servers'].filter((n) => !tools.includes(n));
    if (list.status !== 200 || missing.length) return { name: 'mcp', ok: false, detail: `tools/list HTTP ${list.status}${missing.length ? `, missing ${missing.join(',')}` : ''}` };
    return { name: 'mcp', ok: true, detail: `initialize and tools/list answered, ${tools.length} tools` };
  });
}

/** 오늘(UTC) 고정 코호트 행이 minRows 이상인가: minRows 번째 행 하나만 읽는다(전체를 세지 않음) */
export function checkTodayRows(f: F, cfg: { url: string; key: string }, now: number, minRows: number): Promise<Check> {
  return guard('observations', async () => {
    const day = new Date(now).toISOString().slice(0, 10);
    const qs = new URLSearchParams({ select: 'id', source: 'eq.scanner', observed_at: `gte.${day}T00:00:00Z`, order: 'observed_at.asc', offset: String(minRows - 1), limit: '1' });
    const res = await f(`${cfg.url.replace(/\/+$/, '')}/rest/v1/scanner_observations?${qs}`, { headers: supabaseHeaders(cfg.key, { Accept: 'application/json' }), signal: AbortSignal.timeout(60_000) });
    if (!res.ok) return { name: 'observations', ok: false, detail: `DB read HTTP ${res.status}` };
    const rows = (await res.json()) as unknown[];
    return rows.length > 0
      ? { name: 'observations', ok: true, detail: `at least ${minRows} fixed-cohort rows on ${day}` }
      : { name: 'observations', ok: false, detail: `fewer than ${minRows} fixed-cohort rows on ${day}` };
  });
}

async function main(): Promise<void> {
  const base = (process.env.LOWDOWN_BASE_URL?.trim() || 'https://lowdown-proxy.vercel.app').replace(/\/+$/, '');
  const db = process.argv.includes('--db');
  const checks: Check[] = await Promise.all([checkStatus(fetch, base), checkLookup(fetch, base), checkMcp(fetch, base)]);
  if (db) {
    const url = process.env.LOWDOWN_SUPABASE_URL?.trim();
    const key = process.env.LOWDOWN_SCANNER_KEY?.trim();
    if (!url || !key) checks.push({ name: 'observations', ok: false, detail: 'DB settings missing' });
    else checks.push(await checkTodayRows(fetch, { url, key }, Date.now(), Number(process.env.SMOKE_MIN_ROWS) || 5000));
  }
  for (const c of checks) console.log(`${c.ok ? 'ok  ' : 'FAIL'} ${c.name}: ${c.detail}`);
  const failed = checks.filter((c) => !c.ok);
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary) appendFileSync(summary, ['| check | result |', '|---|---|', ...checks.map((c) => `| ${c.name} | ${c.ok ? 'ok' : 'FAIL'}: ${c.detail} |`)].join('\n') + '\n');
  if (failed.length) {
    console.error(`::error::${failed.length} check(s) failed: ${failed.map((c) => c.name).join(', ')}`);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('smoke.ts')) await main();
