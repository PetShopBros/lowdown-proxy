// 도구 정의 원문 저장 (Scanner 0.5.0~) — 비공개
//   scanner_tool_defs         : def_hash 당 1행. 원문(body)은 신뢰할 수 없는 데이터다. 공개 view·API·에이전트로 내보내지 않는다.
//   scanner_tool_set_versions : tool_set_hash 당 1행. 관찰 행 metadata.tool_set_hash → 이 행 → def_hashes → 원문
//   scanner_tool_flags        : 해석(규칙 결과). 근거는 위치·크기 같은 값만, 원문 조각은 넣지 않는다. 여기서는 oversize 만 붙인다.
//   같은 정의·같은 집합은 이미 있으면 무시(ignore-duplicates) — 처음 관측한 시각·실행이 남는다.
//   바뀌지 않은 날은 새 행이 없다. 시간축은 scanner_observations(관찰 행)가 가진다.

import type { SupabaseConfig, ToolDef } from './lib.ts';
import { OVERSIZE_DEF_BYTES } from './lib.ts';
import { postBatches } from './registry-diff.ts';
import type { DiffIoDeps } from './registry-diff.ts';

export interface ToolDefRow extends ToolDef {
  first_seen_at: string;
  first_scan_run_id: string;
}

export interface ToolSetVersionRow {
  tool_set_hash: string;
  def_hashes: string[];
  tool_count: number;
  first_seen_at: string;
  first_scan_run_id: string;
}

export interface ToolFlagRow {
  def_hash: string;
  rule_id: string;
  rule_version: number;
  evidence: Record<string, unknown>;
  scan_run_id: string;
  created_at: string;
}

/** 실행 중 메모리 수집기. 같은 정의·집합은 한 번만 보관한다(공통 도구를 쓰는 서버가 많아도 메모리가 늘지 않는다). */
export class ToolDefCollector {
  readonly defs = new Map<string, ToolDef>();
  readonly sets = new Map<string, string[]>();

  add(toolSetHash: unknown, defs: readonly ToolDef[] | undefined): void {
    if (typeof toolSetHash !== 'string' || !defs) return;
    for (const d of defs) if (!this.defs.has(d.def_hash)) this.defs.set(d.def_hash, d);
    if (!this.sets.has(toolSetHash)) this.sets.set(toolSetHash, defs.map((d) => d.def_hash).sort());
  }

  bytes(): number {
    let n = 0;
    for (const d of this.defs.values()) n += d.byte_size;
    return n;
  }
}

export function toolDefRows(c: ToolDefCollector, ctx: { now: string; scanRunId: string }): ToolDefRow[] {
  return [...c.defs.values()].map((d) => ({ ...d, first_seen_at: ctx.now, first_scan_run_id: ctx.scanRunId }));
}

export function toolSetVersionRows(c: ToolDefCollector, ctx: { now: string; scanRunId: string }): ToolSetVersionRow[] {
  return [...c.sets.entries()].map(([h, defHashes]) => ({
    tool_set_hash: h,
    def_hashes: defHashes,
    tool_count: defHashes.length,
    first_seen_at: ctx.now,
    first_scan_run_id: ctx.scanRunId,
  }));
}

export const OVERSIZE_RULE = { rule_id: 'oversize', rule_version: 1 } as const;

/** 규칙 oversize v1: 정의 하나가 OVERSIZE_DEF_BYTES 를 넘는다. 사실 표지일 뿐 위험 판정이 아니다. */
export function oversizeFlags(rows: readonly ToolDef[], ctx: { now: string; scanRunId: string }): ToolFlagRow[] {
  return rows
    .filter((d) => d.byte_size > OVERSIZE_DEF_BYTES)
    .map((d) => ({
      def_hash: d.def_hash,
      ...OVERSIZE_RULE,
      evidence: { byte_size: d.byte_size, threshold: OVERSIZE_DEF_BYTES },
      scan_run_id: ctx.scanRunId,
      created_at: ctx.now,
    }));
}

/** 요청 하나가 너무 커지지 않게 body 크기 기준으로 묶는다(행 수 기준 batchSize 만으로는 큰 정의가 몰릴 때 위험). */
export function chunkByBytes<T extends { byte_size?: number }>(rows: readonly T[], maxBytes = 2_000_000, maxRows = 500): T[][] {
  const out: T[][] = [];
  let cur: T[] = [];
  let bytes = 0;
  for (const r of rows) {
    const b = (r.byte_size ?? 0) + 512;
    if (cur.length > 0 && (bytes + b > maxBytes || cur.length >= maxRows)) {
      out.push(cur);
      cur = [];
      bytes = 0;
    }
    cur.push(r);
    bytes += b;
  }
  if (cur.length > 0) out.push(cur);
  return out;
}

// ─────────────────────────────────────────────
// DB 쓰기 (PostgREST). 이미 있는 키는 무시한다.
// ─────────────────────────────────────────────

export async function insertToolDefs(cfg: SupabaseConfig, rows: readonly ToolDefRow[], deps: DiffIoDeps = {}): Promise<number> {
  let n = 0;
  for (const chunk of chunkByBytes(rows)) {
    n += await postBatches(cfg, 'scanner_tool_defs?on_conflict=def_hash', chunk, 'resolution=ignore-duplicates,return=minimal', { ...deps, batchSize: chunk.length });
  }
  return n;
}

export function insertToolSetVersions(cfg: SupabaseConfig, rows: readonly ToolSetVersionRow[], deps: DiffIoDeps = {}): Promise<number> {
  return postBatches(cfg, 'scanner_tool_set_versions?on_conflict=tool_set_hash', rows, 'resolution=ignore-duplicates,return=minimal', { batchSize: 500, ...deps });
}

export function insertToolFlags(cfg: SupabaseConfig, rows: readonly ToolFlagRow[], deps: DiffIoDeps = {}): Promise<number> {
  return postBatches(cfg, 'scanner_tool_flags?on_conflict=def_hash,rule_id,rule_version', rows, 'resolution=ignore-duplicates,return=minimal', deps);
}
