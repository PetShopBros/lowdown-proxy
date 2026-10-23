// 도구 정의 원문 크기 표본 측정 (로컬 확인용). DB 쓰기 없음, 원문 출력 없음(수치만).
//   Registry 를 몇 페이지만 읽어 streamable-http 원격 N개를 probe 하고 정의 수·바이트를 출력한다.
//   사용: node scanner/sample-defs.ts [N=30]

import { DEFAULT_REGISTRY_URL, OVERSIZE_DEF_BYTES, probeRemote, USER_AGENT } from './lib.ts';
import type { RegistryRemote, ToolDef } from './lib.ts';
import { ToolDefCollector } from './tool-defs.ts';

const N = Math.max(1, Number.parseInt(process.argv[2] ?? '30', 10) || 30);
const OFFICIAL_META = 'io.modelcontextprotocol.registry/official';

async function pickRemotes(n: number): Promise<Array<{ name: string; remote: RegistryRemote }>> {
  const out: Array<{ name: string; remote: RegistryRemote }> = [];
  let cursor: string | undefined;
  for (let page = 0; page < 10 && out.length < n; page++) {
    const qs = new URLSearchParams({ limit: '100', version: 'latest' });
    if (cursor) qs.set('cursor', cursor);
    const res = await fetch(`${DEFAULT_REGISTRY_URL}/v0.1/servers?${qs}`, { headers: { Accept: 'application/json', 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`registry HTTP ${res.status}`);
    const data = (await res.json()) as { servers?: Array<{ server?: Record<string, unknown>; _meta?: Record<string, unknown> }>; metadata?: { nextCursor?: string } };
    for (const e of data.servers ?? []) {
      const s = e.server;
      const meta = e._meta?.[OFFICIAL_META] as { status?: unknown } | undefined;
      if (!s || typeof s.name !== 'string' || meta?.status !== 'active') continue;
      const r = (Array.isArray(s.remotes) ? s.remotes : []).find(
        (x: unknown) => typeof x === 'object' && x !== null && (x as RegistryRemote).type === 'streamable-http' && typeof (x as RegistryRemote).url === 'string' && !(x as RegistryRemote).url.includes('{'),
      ) as RegistryRemote | undefined;
      if (r) out.push({ name: s.name, remote: { type: r.type, url: r.url } });
      if (out.length >= n) break;
    }
    cursor = data.metadata?.nextCursor;
    if (!cursor) break;
  }
  return out;
}

const t0 = Date.now();
const targets = await pickRemotes(N);
console.log(`registry: ${targets.length} remotes picked (${Math.round((Date.now() - t0) / 1000)}s)`);

const c = new ToolDefCollector();
let l2 = 0;
let tools = 0;
const perServer: Array<{ name: string; tools: number; bytes: number }> = [];
await Promise.all(
  targets.map(async ({ name, remote }, i) => {
    try {
      const r = await probeRemote(remote, { registryVersion: '', index: i });
      if (r.reached_level === 2 && r.tool_defs) {
        l2++;
        tools += r.tool_defs.length;
        c.add(r.metadata.tool_set_hash, r.tool_defs);
        perServer.push({ name, tools: r.tool_defs.length, bytes: r.tool_defs.reduce((n, d: ToolDef) => n + d.byte_size, 0) });
      }
    } catch {
      // 무시
    }
  }),
);

const sizes = [...c.defs.values()].map((d) => d.byte_size).sort((a, b) => a - b);
const q = (p: number) => sizes[Math.min(sizes.length - 1, Math.floor(p * sizes.length))] ?? 0;
const total = c.bytes();
console.log(JSON.stringify({
  probed: targets.length,
  l2_servers: l2,
  tools_seen: tools,
  unique_defs: c.defs.size,
  unique_sets: c.sets.size,
  bytes_total: total,
  bytes_avg_per_def: c.defs.size ? Math.round(total / c.defs.size) : 0,
  bytes_median: q(0.5),
  bytes_p90: q(0.9),
  bytes_max: sizes.at(-1) ?? 0,
  oversize_over_64kb: sizes.filter((s) => s > OVERSIZE_DEF_BYTES).length,
  elapsed_sec: Math.round((Date.now() - t0) / 1000),
}, null, 2));
console.log('largest servers (tool count, bytes):');
for (const s of perServer.sort((a, b) => b.bytes - a.bytes).slice(0, 5)) console.log(`  ${s.name}  ${s.tools} tools  ${s.bytes} B`);
