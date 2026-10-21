import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";

function getSupabase() {
  const url = process.env.LOWDOWN_SUPABASE_URL;
  const key = process.env.LOWDOWN_SUPABASE_KEY;
  if (!url || !key) throw new Error("Supabase env missing");
  return createClient(url, key, { auth: { persistSession: false } });
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // CORS — 어떤 에이전트/클라이언트도 조회 가능하게
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  // Registry 이름의 '/' 를 그대로 쓴 주소(/api/reputation/mcp:ns/name)는 vercel.json rewrite 가 _slash?t=ns/name 으로 넘긴다.
  const slashT = req.query.t;
  const target = (req.query.target === "_slash" && typeof slashT === "string" && slashT.length > 0 ? slashT : req.query.target) as string;
  if (!target || target === "_slash") return res.status(400).json({ error: "target required" });
  const taskType = (req.query.task_type as string) ?? null;
  // 조회 유입 측정용 태그 (예: ?ref=report). 안전한 문자만 허용.
  const refRaw = req.query.ref;
  const ref = typeof refRaw === "string" && /^[A-Za-z0-9._:-]{1,64}$/.test(refRaw) ? refRaw : null;


  try {
    const supabase = getSupabase();

    // task_type 필터가 있으면 interactions 테이블에서 직접 집계
    let data: any = null;
    let error: any = null;

    if (taskType) {
      const { data: rows } = await supabase
        .from("interactions")
        .select(TASK_COLUMNS)
        .eq("target", target)
        .eq("task_type", taskType);

      if (!rows || rows.length === 0) {
        // 퍼지 매칭
        const { data: fuzzyTargets } = await supabase
          .from("reputation_summary")
          .select("target")
          .ilike("target", `%${target}%`)
          .limit(1)
          .single();

        if (fuzzyTargets) {
          const { data: fuzzyRows } = await supabase
            .from("interactions")
            .select(TASK_COLUMNS)
            .eq("target", (fuzzyTargets as any).target)
            .eq("task_type", taskType);

          if (fuzzyRows && fuzzyRows.length > 0) {
            data = summarizeRows((fuzzyTargets as any).target, fuzzyRows);
          }
        }
      } else {
        data = summarizeRows(target, rows);
      }
    } else {
      // 기존 reputation_summary 뷰 조회
      const result = await supabase
        .from("reputation_summary")
        .select("*")
        .eq("target", target)
        .single();
      data = result.data;
      error = result.error;

      if (error || !data) {
        const { data: fuzzy } = await supabase
          .from("reputation_summary")
          .select("*")
          .ilike("target", `%${target}%`)
          .order("interactions", { ascending: false })
          .limit(1)
          .single();
        if (fuzzy) { data = fuzzy; error = null; }
      }
    }

    // Scanner 관찰 데이터: interactions/success_rate 와 합산하지 않고 별도 `scanner` 블록으로만 노출.
    // 실패해도 기존 응답에는 영향 없음. task_type 필터 요청에는 붙이지 않는다.
    const scannerLookup = taskType ? null : await findScanner(supabase, target);
    // Registry 선언 + Scanner 날짜별 기록. 실패해도 기존 응답에는 영향 없음. task_type 필터 요청에는 붙이지 않는다.
    const evidence = taskType ? null : await buildEvidence(supabase, target, scannerLookup);

    // 조회 자체를 로깅 (organic vs seeded 구분)
    const source = req.headers["x-lowdown-source"] === "seeded" ? "seeded" : "organic";
    const requester = (req.headers["x-lowdown-actor"] as string) ?? null;

    const userAgent = (req.headers["user-agent"] as string) ?? null;

    const lookupRow = {
      requester,
      target,
      source,
      user_agent: userAgent,
      ...(ref ? { ref } : {}),
    };
    // 응답 종류(result_kind)를 함께 남겨 "답이 없어 낭비된 조회" 비율을 잰다.
    // 열이 아직 없는 DB 에서도 조회 기록이 빠지지 않도록, 실패하면 result_kind 없이 한 번 더 쓴다.
    const logged = await supabase.from("reputation_lookups").insert({ ...lookupRow, result_kind: resultKind(taskType, scannerLookup, evidence, data) } as never);
    if (logged.error) await supabase.from("reputation_lookups").insert(lookupRow as never);

    if (error || !data) {
      return res.status(200).json({
        target,
        task_type: taskType ?? undefined,
        ...evidenceHead(evidence, scannerLookup, 0),
        ...evidenceFields(evidence, scannerLookup),
        interactions: 0,
        success_rate: null,
        confidence: "none",
      });
    }

    // confidence 계산 (성공률 분모 = rated_interactions 기반. 0.1.17 이전 뷰에는 없어서 interactions 로 대체)
    const interactions = Number(data.interactions ?? 0);
    const rated = Number(data.rated_interactions ?? interactions);
    const confidence =
      rated === 0 ? "none" :
      rated >= 100 ? "high" :
      rated >= 10  ? "medium" : "low";

    const nodeId = (req.headers["x-lowdown-node-id"] as string) ?? null;

    // 기본 응답
    const baseResponse = {
      target,
      task_type: taskType ?? undefined,
      ...evidenceHead(evidence, scannerLookup, interactions),
      ...evidenceFields(evidence, scannerLookup),
      target_type: data.target_type,
      interactions,
      rated_interactions: rated,
      success_rate: rated === 0 ? null : data.success_rate,
      ...(data.rated_interactions !== undefined ? {
        protocol_requests: Number(data.protocol_requests ?? 0),
        rejected_requests: Number(data.rejected_requests ?? 0),
        by_source: {
          organic: Number(data.organic_count ?? 0),
          seeded: Number(data.seeded_count ?? 0),
          synthetic: Number(data.synthetic_count ?? 0),
        },
        success_rate_basis: SUCCESS_RATE_BASIS,
      } : {}),
      avg_latency_ms: data.avg_latency_ms ?? undefined,
      ...(data.failure_breakdown ? { failure_breakdown: data.failure_breakdown } : {}),
      ...(taskType ? {} : {
        reviews: Number(data.reviews ?? 0),
        avg_rating: data.avg_rating,
        review_conversion_rate: data.review_conversion_rate,
      }),
      confidence,
    };

    // node_id 없으면 기본 응답
    if (!nodeId) {
      return res.status(200).json(baseResponse);
    }

    // node_id 있으면 상세 데이터 추가
    const { data: breakdown } = await supabase
      .from("interactions")
      .select("task_type, outcome, latency_ms, failure_type, created_at")
      .eq("target", target)
      .order("created_at", { ascending: false })
      .limit(50);

    const taskBreakdown: Record<string, { success: number; failure: number; failure_types?: Record<string, number> }> = {};
    const recentTrends: { date: string; count: number }[] = [];
    const dateCounts: Record<string, number> = {};

    for (const row of breakdown ?? []) {
      // task_breakdown
      const t = row.task_type ?? "unknown";
      if (!taskBreakdown[t]) taskBreakdown[t] = { success: 0, failure: 0 };
      if (row.outcome === "success") {
        taskBreakdown[t].success++;
      } else {
        taskBreakdown[t].failure++;
        if (row.failure_type) {
          taskBreakdown[t].failure_types = taskBreakdown[t].failure_types ?? {};
          taskBreakdown[t].failure_types[row.failure_type] = (taskBreakdown[t].failure_types[row.failure_type] ?? 0) + 1;
        }
      }

      // recent_trends (날짜별 카운트)
      const date = row.created_at?.slice(0, 10);
      if (date) dateCounts[date] = (dateCounts[date] ?? 0) + 1;
    }

    for (const [date, count] of Object.entries(dateCounts).sort()) {
      recentTrends.push({ date, count });
    }

    return res.status(200).json({
      ...baseResponse,
      task_breakdown: taskBreakdown,
      recent_trends: recentTrends,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Internal server error" });
  }
}

// ── 성공률 기준 (supabase/2026-10-15_interactions_p0.sql 의 reputation_summary 와 같은 규칙) ──
const TASK_COLUMNS = "outcome, latency_ms, failure_type, source, request_kind, error_layer, task_type";
const LEGACY_PROTOCOL_TASKS = new Set(["initialize", "tools/list", "prompts/list", "resources/list", "resources/templates/list", "ping"]);
const SUCCESS_RATE_BASIS =
  "success_rate counts organic tool calls and agent reports only. Protocol requests (initialize, tools/list, ...), " +
  "rejected requests (invalid arguments, unknown method), and seeded or synthetic records are excluded and counted separately.";

function isProtocolRow(r: any): boolean {
  return r.request_kind === "protocol" || (r.request_kind == null && LEGACY_PROTOCOL_TASKS.has(r.task_type));
}

export function isRatedRow(r: any): boolean {
  return (r.source ?? "organic") === "organic" && !isProtocolRow(r) && r.error_layer !== "request";
}

export function summarizeRows(target: string, rows: any[]) {
  const ratedRows = rows.filter(isRatedRow);
  const success = ratedRows.filter((r) => r.outcome === "success").length;
  const latencies = ratedRows.map((r) => r.latency_ms).filter(Boolean);
  const count = (pred: (r: any) => boolean) => rows.filter(pred).length;
  return {
    target,
    interactions: rows.length,
    rated_interactions: ratedRows.length,
    success_rate: ratedRows.length ? Math.round((success / ratedRows.length) * 1000) / 1000 : null,
    avg_latency_ms: latencies.length
      ? Math.round(latencies.reduce((a: number, b: number) => a + b, 0) / latencies.length)
      : null,
    failure_breakdown: buildFailureBreakdown(ratedRows),
    protocol_requests: count(isProtocolRow),
    rejected_requests: count((r) => r.error_layer === "request"),
    organic_count: count((r) => (r.source ?? "organic") === "organic"),
    seeded_count: count((r) => r.source === "seeded"),
    synthetic_count: count((r) => r.source === "synthetic"),
  };
}

function buildFailureBreakdown(rows: any[]): Record<string, number> | null {
  const failed = rows.filter((r) => r.outcome !== "success");
  if (failed.length === 0) return null;
  const breakdown: Record<string, number> = {};
  for (const r of failed) {
    const key = r.failure_type ?? "unknown";
    breakdown[key] = (breakdown[key] ?? 0) + 1;
  }
  return breakdown;
}

/** 조회 기록용 응답 종류. 판정이 아니라 "무엇으로 답했나"만. */
export function resultKind(taskType: string | null, lookup: ScannerLookup | null, ev: Evidence | null, data: unknown): string {
  if (taskType) return "task_type";
  if (lookup?.summary) return "observed";
  if ((lookup?.candidates.length ?? 0) > 0 || (ev?.registryCandidates?.length ?? 0) > 0) return "candidates";
  const reg = ev?.registry as Record<string, unknown> | undefined;
  if (reg && (reg.listed === true || reg.removed_at)) return "registry_only";
  if (data) return "interactions_only";
  return "none";
}

// ── Scanner 관찰 블록 ────────────────────────────────────────────
interface ScannerLookup {
  summary: Record<string, unknown> | null;
  candidates: string[];
  // 조회는 정상 수행했고 일치하는 관찰이 없음(조회 오류와 구분)
  unobserved?: boolean;
}

const SCANNER_UNOBSERVED = {
  observed: false,
   note: "No Lowdown Scanner observation exists for this target. The Scanner observes a fixed sample of MCP Registry entries daily (5,000 from 2026-10-19, 2,000 before); absence of data says nothing about the target's status.",
};

function scannerFields(lookup: ScannerLookup | null): Record<string, unknown> {
  if (!lookup) return {};
  if (lookup.summary) return { scanner: lookup.summary };
  if (lookup.candidates.length > 0) return { scanner_candidates: lookup.candidates };
  if (lookup.unobserved) return { scanner: SCANNER_UNOBSERVED };
  return {};
}

/**
 * scanner_summary(공개 집계 view)에서 target 을 찾는다.
 * 1) 정확히 일치 (입력 그대로, 없으면 `mcp:` 접두사 붙여서)
 * 2) 3자 이상이면 부분 일치: 1건이면 그 대상, 여러 건이면 후보 이름(최대 5개)만 반환
 * 어떤 오류가 나도 null — 기존 reputation 응답을 막지 않는다.
 */
async function findScanner(supabase: any, target: string): Promise<ScannerLookup | null> {
  try {
    const ids = target.startsWith("mcp:") ? [target] : [target, `mcp:${target}`];
    for (const id of ids) {
      const exact = await supabase.from("scanner_summary").select("*").eq("target_id", id).limit(1);
      if (exact.error) return null;
      const row = (exact.data ?? [])[0];
      if (row) return { summary: shapeScanner(row), candidates: [] };
    }

    if (target.length < 3) return { summary: null, candidates: [], unobserved: true };
    const pattern = `%${target.replace(/[\\%_]/g, "\\$&")}%`;
    const fuzzy = await supabase
      .from("scanner_summary")
      .select("*")
      .ilike("target_id", pattern)
      .order("observations_30d", { ascending: false })
      .limit(6);
    if (fuzzy.error) return null;
    const rows = (fuzzy.data ?? []) as any[];
    if (rows.length === 1) return { summary: shapeScanner(rows[0]), candidates: [] };
    if (rows.length > 1) return { summary: null, candidates: rows.slice(0, 5).map((r) => String(r.target_id)) };
    return { summary: null, candidates: [], unobserved: true };
  } catch {
    return null;
  }
}

function shapeScanner(r: any): Record<string, unknown> {
  const version = typeof r.latest_server_version === "string" && /^[0-9A-Za-z.+_-]{1,32}$/.test(r.latest_server_version)
    ? r.latest_server_version
    : null;
  return {
    target: r.target_id,
    last_observed_at: r.last_observed_at,
    observations_30d: Number(r.observations_30d ?? 0),
    remotes_observed: Number(r.remotes_observed ?? 0),
    latest: {
      reached_level: r.latest_reached_level,
      http_status: r.latest_http_status,
      error_type: r.latest_error_type,
      latency_ms: r.latest_latency_ms,
      tool_count: r.latest_tool_count,
      schema_hash: r.latest_schema_hash,
      server_version: version,
    },
    schema_versions_30d: Number(r.schema_versions_30d ?? 0),
    status_distribution_30d: r.status_distribution_30d ?? {},
    note: "Observed by Lowdown Scanner (initialize + tools/list only; no tool calls). Not included in success_rate.",
  };
}

// ── 증거 블록: Registry 선언 + Scanner 날짜별 기록 ───────────────────
// 판정·점수·순위는 내지 않는다. 사실과 그 출처, 관찰 방법과 한계만.
// 각 조회는 독립적으로 실패할 수 있고, 실패한 부분은 빠질 뿐 응답 전체를 막지 않는다.

const SAFE_NAME = /^[A-Za-z0-9._\-/]{1,200}$/;
const SAFE_VERSION = /^[0-9A-Za-z.+_-]{1,32}$/;
const SAFE_TOOL = /^[A-Za-z0-9_.\-/]{1,64}$/;
const SAFE_HOST = /^[a-z0-9.-]{1,253}$/;
const SAFE_COHORT = /^[0-9A-Za-z.-]{1,40}$/;
const REGISTRY_STATUSES = new Set(["active", "deprecated", "deleted"]);
const GAP_REASONS = new Set(["no_remote", "remote_not_probeable", "not_active", "not_in_registry"]);
const WINDOW_DAYS = 30;
const DAY_MS = 86_400_000;
const REGISTRY_RECORDS_SINCE = "2026-10-19";

const METHOD = {
  requests: "POST initialize, then tools/list. No tool calls and no authentication.",
  vantage: "One network location (GitHub Actions). A timeout or refusal means not reachable from there, not necessarily from everywhere.",
  frequency: "Once per day, for a fixed sample of MCP Registry entries with a streamable-http remote.",
  limits: "Each row is a single probe at one moment. It is not a measure of availability or uptime, and not a score.",
  dataset: "https://github.com/PetShopBros/lowdown-data",
};

interface Evidence {
  name: string | null;
  registry?: Record<string, unknown>;
  registryCandidates?: string[];
  scannerExtra?: Record<string, unknown>;
  scannerSince?: string | null;
}

const safeVersion = (v: unknown) => (typeof v === "string" && SAFE_VERSION.test(v) ? v : null);
const safeHosts = (v: unknown) => (Array.isArray(v) ? v.filter((h) => typeof h === "string" && SAFE_HOST.test(h)).slice(0, 20) : []);
const utcDay = (t: number) => new Date(t).toISOString().slice(0, 10);
const intOrNull = (v: unknown) => {
  const n = typeof v === "number" ? v : typeof v === "string" && /^-?\d{1,9}$/.test(v) ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};

function hostOfUrl(u: unknown): string | null {
  if (typeof u !== "string") return null;
  try {
    const h = new URL(u).hostname.toLowerCase();
    return SAFE_HOST.test(h) ? h : null;
  } catch {
    return null;
  }
}

/** 입력 → Registry 이름. scanner 에서 이미 찾았으면 그 이름, 아니면 Registry 기록에서 정확히 → 부분 일치. */
async function resolveRegistryName(supabase: any, target: string, lookup: ScannerLookup | null): Promise<{ name: string | null; candidates: string[]; row: any | null }> {
  const fromScanner = lookup?.summary?.target;
  if (typeof fromScanner === "string" && fromScanner.startsWith("mcp:")) {
    const name = fromScanner.slice(4);
    const { data, error } = await supabase.from("registry_state").select("*").eq("name", name).limit(1);
    if (error) throw new Error("registry_state");
    return { name, candidates: [], row: (data ?? [])[0] ?? null };
  }
  const raw = target.startsWith("mcp:") ? target.slice(4) : target;
  if (!SAFE_NAME.test(raw) || (target.includes(":") && !target.startsWith("mcp:"))) return { name: null, candidates: [], row: null };
  const exact = await supabase.from("registry_state").select("*").eq("name", raw).limit(1);
  if (exact.error) throw new Error("registry_state");
  const row = (exact.data ?? [])[0];
  if (row) return { name: raw, candidates: [], row };
  if (raw.length < 3) return { name: null, candidates: [], row: null };
  const pattern = `%${raw.replace(/[\\%_]/g, "\\$&")}%`;
  const fuzzy = await supabase.from("registry_state").select("*").ilike("name", pattern).order("name", { ascending: true }).limit(6);
  if (fuzzy.error) throw new Error("registry_state");
  const rows = (fuzzy.data ?? []) as any[];
  if (rows.length === 1) return { name: String(rows[0].name), candidates: [], row: rows[0] };
  return { name: null, candidates: rows.slice(0, 5).map((r) => String(r.name)).filter((n) => SAFE_NAME.test(n)), row: null };
}

export function shapeRegistry(row: any, changes: any[]): Record<string, unknown> {
  const removed = row.removed_at ?? null;
  return {
    listed: removed === null,
    name: row.name,
    declared_version: safeVersion(row.version),
    status: REGISTRY_STATUSES.has(row.status) ? row.status : null,
    removed_at: removed,
    remote_hosts: safeHosts(row.hosts),
    declares_packages: Boolean(row.packages_key),
    first_recorded_at: row.first_seen_at ?? null,
    recorded_since_baseline: row.baseline === true,
    changes_30d: changes.slice(0, 20).map((c) => ({
      on: c.detected_on,
      kind: c.kind,
      ...(c.kind === "version" ? { old: safeVersion(c.old_value), new: safeVersion(c.new_value) } : {}),
      ...(c.kind === "status" ? { old: REGISTRY_STATUSES.has(c.old_value) ? c.old_value : null, new: REGISTRY_STATUSES.has(c.new_value) ? c.new_value : null } : {}),
    })),
    note:
      row.baseline === true
        ? `Recorded from Lowdown's first Registry snapshot (${REGISTRY_RECORDS_SINCE}); first_recorded_at is not when the entry first appeared in the Registry.`
        : "Declared facts from the official MCP Registry as recorded by Lowdown.",
  };
}

interface ObsRow {
  observed_at: string;
  reached_level: number | null;
  http_status: number | null;
  error_type: string | null;
  tool_count?: unknown;
  schema_hash?: unknown;
  names_hash?: unknown;
  remote_url?: unknown;
  retry_level?: unknown;
  desc_hash?: unknown;
  server_version?: unknown;
}

// ── 도구 정의 변경 이력 ───────────────────────────────────────────
// 같은 원격 주소의 L2 관찰을 직전 L2 관찰과 비교한다(해시만, 원문 없음).
// 사실만: 점수·위험 등급·판정 없음. 자주 바뀌는 서버는 그 사실을 함께 적어 한 번의 변경을 과대 해석하지 않게 한다.
const HASH_RE = /^[0-9a-f]{16,64}$/;
export const FREQUENT_SHARE = 0.5; // 비교한 날 중 이 비율 이상 바뀌면 changes_on_most_days
export const FREQUENT_MIN_DAYS = 4; // 이 수 이상 비교했을 때만 changes_on_most_days 로 본다
const MAX_EVENTS = 5;

interface DefPoint {
  at: string;
  day: string;
  sh: string;
  dh: string;
  nh: string | null;
  count: number | null;
  version: string | null;
}

const dayDiff = (a: string, b: string) => Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / DAY_MS);

export function definitionChanges(rows: ObsRow[]): Record<string, unknown> {
  const byRemote = new Map<string, DefPoint[]>();
  for (const r of rows) {
    if (r.reached_level !== 2) continue;
    const sh = typeof r.schema_hash === "string" && HASH_RE.test(r.schema_hash) ? r.schema_hash : null;
    const dh = typeof r.desc_hash === "string" && HASH_RE.test(r.desc_hash) ? r.desc_hash : null;
    if (!sh || !dh) continue;
    const remote = typeof r.remote_url === "string" ? r.remote_url : "";
    const at = String(r.observed_at);
    const point: DefPoint = {
      at,
      day: at.slice(0, 10),
      sh,
      dh,
      nh: typeof r.names_hash === "string" && /^[0-9a-f]{64}$/.test(r.names_hash) ? r.names_hash : null,
      count: intOrNull(r.tool_count),
      version: safeVersion(r.server_version),
    };
    if (!byRemote.has(remote)) byRemote.set(remote, []);
    byRemote.get(remote)!.push(point);
  }

  const multiRemote = byRemote.size > 1;
  const observedDays = new Set<string>();
  const comparedDays = new Set<string>();
  const changeDays = new Set<string>();
  const events: Array<Record<string, unknown>> = [];

  for (const [remote, list] of byRemote) {
    // 하루 1점(그날 마지막 관찰)
    const perDay = new Map<string, DefPoint>();
    for (const p of [...list].sort((a, b) => a.at.localeCompare(b.at))) perDay.set(p.day, p);
    const points = [...perDay.values()];
    const seen = new Set<string>();
    points.forEach((p) => observedDays.add(p.day));
    for (let i = 0; i < points.length; i++) {
      const cur = points[i]!;
      const key = `${cur.sh}:${cur.dh}`;
      if (i > 0) {
        const prev = points[i - 1]!;
        comparedDays.add(cur.day);
        const kinds: string[] = [];
        if (cur.sh !== prev.sh) kinds.push("schema_changed");
        if (cur.dh !== prev.dh) kinds.push("description_changed");
        if (cur.nh && prev.nh && cur.nh !== prev.nh) kinds.push("tool_names_changed");
        const definitionChanged = kinds.length > 0;
        if (cur.version && prev.version && cur.version !== prev.version) kinds.push("server_version_changed");
        if (definitionChanged) changeDays.add(cur.day);
        if (kinds.length > 0) {
          events.push({
            day: cur.day,
            kinds,
            ...(cur.count !== null && prev.count !== null && cur.count !== prev.count ? { tool_count: { from: prev.count, to: cur.count } } : {}),
            ...(cur.version && prev.version && cur.version !== prev.version ? { server_version: { from: prev.version, to: cur.version } } : {}),
            returned_to_earlier_definition: definitionChanged && seen.has(key),
            compared_with: prev.day,
            ...(multiRemote ? { remote_host: hostOfUrl(remote) } : {}),
          });
        }
      }
      seen.add(key);
    }
  }

  const days = [...observedDays].sort();
  const changes = [...changeDays].sort();
  const compared = comparedDays.size;
  const lastObserved = days[days.length - 1] ?? null;
  const lastChange = changes[changes.length - 1] ?? null;
  const prevChange = changes.length > 1 ? changes[changes.length - 2]! : null;
  const pattern =
    compared === 0 ? "not_enough_observations" :
    changes.length === 0 ? "no_change_observed" :
    compared >= FREQUENT_MIN_DAYS && changes.length / compared >= FREQUENT_SHARE ? "changes_on_most_days" :
    "changed";

  const notes: Record<string, string> = {
    not_enough_observations: "Fewer than two days with a complete tools/list observation from the same remote, so nothing was compared.",
    no_change_observed: `No change in tool schemas, descriptions or names across ${compared} compared days.`,
    changes_on_most_days: `Tool definitions changed on ${changes.length} of ${compared} compared days. Changes are routine for this server, so a single change says little on its own.`,
    changed: `Tool definitions changed on ${changes.length} of ${compared} compared days.`,
  };

  return {
    pattern,
    observed_days: days.length,
    compared_days: compared,
    change_days: changes.length,
    first_compared_day: days[0] ?? null,
    last_change: lastChange,
    days_since_last_change: lastChange && lastObserved ? dayDiff(lastObserved, lastChange) : null,
    stable_days_before_last_change: lastChange ? dayDiff(lastChange, prevChange ?? days[0]!) : null,
    events: events.sort((a, b) => String(b.day).localeCompare(String(a.day))).slice(0, MAX_EVENTS),
    note: notes[pattern],
    basis:
      "Each daily observation is compared with the previous one from the same remote URL, using hashes of tool schemas, descriptions and names. " +
      "Description text is not returned. A change is a recorded fact, not a judgment about the server.",
  };
}

/** 하루 1행: 원격 주소가 여러 개면 가장 멀리 간 결과와 주소 수. tools_changed 는 직전 관찰일과 schema_hash 비교. */
export function dailyFromRows(rows: ObsRow[]): Array<Record<string, unknown>> {
  const byDay = new Map<string, ObsRow[]>();
  for (const r of rows) {
    const d = String(r.observed_at).slice(0, 10);
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d)!.push(r);
  }
  const out: Array<Record<string, unknown>> = [];
  let prevSchema: string | null = null;
  for (const day of [...byDay.keys()].sort()) {
    const list = byDay.get(day)!;
    const best = list.reduce((a, b) => ((b.reached_level ?? -1) > (a.reached_level ?? -1) ? b : a));
    const schema = typeof best.schema_hash === "string" && /^[0-9a-f]{16,64}$/.test(best.schema_hash) ? best.schema_hash : null;
    out.push({
      day,
      reached_level: best.reached_level,
      http_status: best.http_status,
      error_type: best.error_type,
      tool_count: intOrNull(best.tool_count),
      tools_changed: schema && prevSchema ? schema !== prevSchema : null,
      retry_reached_level: intOrNull(best.retry_level),
      remotes: list.length,
    });
    if (schema) prevSchema = schema;
  }
  return out;
}

/** 관찰을 시작한 뒤 행이 없는 날. 그날 코호트 공백 기록이 있으면 그 사유, 없으면 no_observation. 오늘(UTC)은 넣지 않는다. */
export function missingDays(observedDays: Set<string>, startDay: string, now: number, gaps: Map<string, string>): Array<{ day: string; reason: string }> {
  const out: Array<{ day: string; reason: string }> = [];
  const today = utcDay(now);
  for (let t = Date.parse(`${startDay}T00:00:00Z`); ; t += DAY_MS) {
    const d = utcDay(t);
    if (d >= today) break;
    if (!observedDays.has(d)) out.push({ day: d, reason: gaps.get(d) ?? "no_observation" });
  }
  return out.slice(-WINDOW_DAYS);
}

async function scannerHistory(supabase: any, targetId: string, registryRow: any | null, latestVersion: unknown, now: number): Promise<{ extra: Record<string, unknown>; since: string | null }> {
  const sinceIso = new Date(now - WINDOW_DAYS * DAY_MS).toISOString();
  const [obs, first, cohort, gaps] = await Promise.all([
    supabase
      .from("scanner_observations")
      .select("observed_at,reached_level,http_status,error_type,tool_count:metadata->>tool_count,schema_hash:metadata->>schema_hash,desc_hash:metadata->>desc_hash,server_version:metadata->>server_version,names_hash:metadata->>names_hash,remote_url:metadata->>remote_url,retry_level:metadata->retry->>reached_level")
      .eq("target_id", targetId)
      .gte("observed_at", sinceIso)
      .order("observed_at", { ascending: true })
      .limit(400),
    supabase.from("scanner_observations").select("observed_at").eq("target_id", targetId).order("observed_at", { ascending: true }).limit(1),
    supabase.from("scanner_cohort").select("cohort_version,selected_at").eq("target_id", targetId),
    supabase.from("scanner_cohort_gaps").select("observed_at,reason").eq("target_id", targetId).gte("observed_at", sinceIso).order("observed_at", { ascending: true }).limit(60),
  ]);
  if (obs.error) throw new Error("scanner_observations");
  const rows = (obs.data ?? []) as ObsRow[];
  const daily = dailyFromRows(rows);
  const firstObservedAt = first.error ? null : ((first.data ?? [])[0]?.observed_at ?? null);
  const cohorts = cohort.error ? null : ((cohort.data ?? []) as any[]).map((c) => String(c.cohort_version)).filter((c) => SAFE_COHORT.test(c)).sort();
  const gapByDay = new Map<string, string>();
  if (!gaps.error) for (const g of (gaps.data ?? []) as any[]) if (GAP_REASONS.has(g.reason)) gapByDay.set(String(g.observed_at).slice(0, 10), g.reason);

  const firstDay = typeof firstObservedAt === "string" ? firstObservedAt.slice(0, 10) : null;
  const windowStart = utcDay(now - WINDOW_DAYS * DAY_MS);
  const missing = firstDay ? missingDays(new Set(daily.map((d) => String(d.day))), firstDay > windowStart ? firstDay : windowStart, now, gapByDay) : [];

  // 최신 관찰의 도구 이름 목록 (0.4.0 부터). 최신 L2 행의 names_hash 로 찾는다.
  let tools: Record<string, unknown> | null = null;
  const lastL2 = [...rows].reverse().find((r) => r.reached_level === 2 && typeof r.names_hash === "string" && /^[0-9a-f]{64}$/.test(r.names_hash));
  if (lastL2) {
    const ts = await supabase.from("scanner_tool_sets").select("names,partial,first_seen_at").eq("target_id", targetId).eq("names_hash", lastL2.names_hash).limit(1);
    const t = ts.error ? null : (ts.data ?? [])[0];
    if (t) {
      const names = (Array.isArray(t.names) ? t.names : []).filter((n: unknown) => typeof n === "string" && SAFE_TOOL.test(n)).slice(0, 200);
      tools = { names, count: names.length, partial: t.partial === true, set_first_observed_at: t.first_seen_at ?? null, observed_at: lastL2.observed_at };
    }
  }

  const lastDay = daily.length ? String(daily[daily.length - 1]!.day) : null;
  const observedHosts = lastDay ? [...new Set(rows.filter((r) => String(r.observed_at).startsWith(lastDay)).map((r) => hostOfUrl(r.remote_url)).filter((h): h is string => h !== null))].sort() : [];

  return {
    since: firstObservedAt,
    extra: {
      in_sample: cohorts === null ? null : cohorts.length > 0,
      ...(cohorts ? { cohorts } : {}),
      first_observed_at: firstObservedAt,
      definition_changes: definitionChanges(rows),
      daily_30d: daily,
      missing_days: missing,
      tools,
      ...(registryRow
        ? {
            declared_vs_observed: {
              declared_version: safeVersion(registryRow.version),
              observed_server_version: safeVersion(latestVersion),
              declared_hosts: safeHosts(registryRow.hosts),
              observed_hosts: observedHosts,
            },
          }
        : {}),
      method: METHOD,
    },
  };
}

async function buildEvidence(supabase: any, target: string, lookup: ScannerLookup | null): Promise<Evidence | null> {
  const now = Date.now();
  const ev: Evidence = { name: null };
  let registryRow: any | null = null;
  try {
    const r = await resolveRegistryName(supabase, target, lookup);
    ev.name = r.name;
    registryRow = r.row;
    if (r.row) {
      const since = utcDay(now - WINDOW_DAYS * DAY_MS);
      const ch = await supabase
        .from("registry_changes")
        .select("detected_on,kind,old_value,new_value")
        .eq("name", r.row.name)
        .gte("detected_on", since)
        .order("detected_on", { ascending: false })
        .limit(20);
      ev.registry = shapeRegistry(r.row, ch.error ? [] : (ch.data ?? []));
    } else if (r.candidates.length > 1) {
      ev.registryCandidates = r.candidates;
    } else if (r.name === null && !(target.includes(":") && !target.startsWith("mcp:"))) {
      ev.registry = {
        listed: false,
        note: `No MCP Registry record matches this name in Lowdown's Registry records (kept since ${REGISTRY_RECORDS_SINCE}).`,
      };
    }
  } catch {
    // Registry 기록 조회 실패 → registry 블록 없이 계속
  }
  const targetId = lookup?.summary?.target;
  if (typeof targetId === "string") {
    try {
      const h = await scannerHistory(supabase, targetId, registryRow, (lookup!.summary!.latest as any)?.server_version, now);
      ev.scannerExtra = h.extra;
      ev.scannerSince = h.since;
    } catch {
      // 날짜별 기록 실패 → 기존 scanner 요약만
    }
  }
  return ev;
}

function evidenceFields(ev: Evidence | null, lookup: ScannerLookup | null): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (ev?.registry) out.registry = ev.registry;
  if (ev?.registryCandidates) out.registry_candidates = ev.registryCandidates;
  const scanner = scannerFields(lookup);
  if (scanner.scanner && ev?.scannerExtra && lookup?.summary) {
    const { note, ...rest } = scanner.scanner as Record<string, unknown>;
    out.scanner = { ...rest, ...ev.scannerExtra, note };
  } else Object.assign(out, scanner);
  return out;
}

/** 첫머리: 확인된 Registry 이름과 사실 문장. 기록이 있는 쪽을 먼저 말한다. */
function evidenceHead(ev: Evidence | null, lookup: ScannerLookup | null, interactions: number): Record<string, unknown> {
  if (!ev && !lookup) return interactions === 0 ? { message: "No interactions recorded yet." } : {};
  const parts: string[] = [];
  const reg = ev?.registry as Record<string, unknown> | undefined;
  if (reg?.listed === true) parts.push("MCP Registry declaration recorded");
  else if (reg && reg.removed_at) parts.push("MCP Registry entry recorded as removed");
  else if (ev?.registryCandidates) parts.push("several MCP Registry names match (see registry_candidates)");
  else if (reg) parts.push("no MCP Registry record found");
  if (lookup?.summary) {
    parts.push(ev?.scannerSince ? `observed daily by Lowdown Scanner since ${String(ev.scannerSince).slice(0, 10)}` : "observed by Lowdown Scanner");
    const dc = ev?.scannerExtra?.definition_changes as Record<string, unknown> | undefined;
    if (dc?.pattern === "changed") parts.push(`tool definitions last changed on ${dc.last_change} after ${dc.stable_days_before_last_change} days without change`);
    else if (dc?.pattern === "changes_on_most_days") parts.push(`tool definitions change on most observed days (${dc.change_days} of ${dc.compared_days})`);
    else if (dc?.pattern === "no_change_observed") parts.push(`no tool definition change in ${dc.compared_days} compared days`);
  }
  else if (lookup && lookup.candidates.length > 0) parts.push("several observed names match (see scanner_candidates)");
  else if (lookup?.unobserved) parts.push("not in the Lowdown Scanner sample");
  parts.push(interactions > 0 ? `${interactions} agent-reported interactions` : "no agent-reported interactions");
  const text = parts.join("; ");
  return {
    ...(ev?.name ? { resolved_target: `mcp:${ev.name}` } : {}),
    message: `${text.charAt(0).toUpperCase()}${text.slice(1)}.`,
  };
}
