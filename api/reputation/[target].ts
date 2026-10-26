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
  // 여러 서버의 기록이 필요하면 반복 조회 대신 일별 공개 데이터셋을 쓰도록 안내 (대량 조회 10/22 관찰)
  res.setHeader("Link", BULK_DATA_LINK);

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  // Registry 이름의 '/' 를 그대로 쓴 주소(/api/reputation/mcp:ns/name)는 vercel.json rewrite 가 _slash?t=ns/name 으로 넘긴다.
  const slashT = req.query.t;
  const rawTarget = (req.query.target === "_slash" && typeof slashT === "string" && slashT.length > 0 ? slashT : req.query.target) as string;
  // 앞뒤 공백·개행만 제거한다. 이름 안의 글자(역슬래시 등)는 고치지 않는다.
  const target = typeof rawTarget === "string" ? rawTarget.trim() : rawTarget;
  if (!target || target === "_slash") return res.status(400).json({ error: "target required" });
  const taskType = (req.query.task_type as string) ?? null;
  // 조회 유입 측정용 태그 (예: ?ref=report). 안전한 문자만 허용.
  const refRaw = req.query.ref;
  const ref = typeof refRaw === "string" && /^[A-Za-z0-9._:-]{1,64}$/.test(refRaw) ? refRaw : null;
  // 부분 일치 패턴: 3자 이상만, LIKE 특수문자(\ % _)는 글자 그대로 찾게 이스케이프
  const fuzzyPattern = typeof target === "string" && target.length >= 3 ? `%${target.replace(/[\\%_]/g, "\\$&")}%` : null;


  try {
    const supabase = getSupabase();

    // task_type 필터가 있으면 interactions 테이블에서 직접 집계
    let data: any = null;
    let error: any = null;

    if (taskType) {
      const { data: rows, error: rowsError } = await supabase
        .from("interactions")
        .select(TASK_COLUMNS)
        .eq("target", target)
        .eq("task_type", taskType);
      error = rowsError ?? null;

      // 퍼지 매칭: 정확 조회가 오류 없이 비었을 때만, 3자 이상만 (DB 가 느릴 때 부하를 더하지 않게)
      if (!rowsError && (!rows || rows.length === 0) && fuzzyPattern) {
        const { data: fuzzyTargets } = await supabase
          .from("reputation_summary")
          .select("target")
          .ilike("target", fuzzyPattern)
          .limit(1)
          .maybeSingle();

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
        .maybeSingle();
      data = result.data;
      error = result.error;

      // 퍼지 매칭: 정확 조회가 오류 없이 비었을 때만, 3자 이상만 (DB 가 느릴 때 부하를 더하지 않게)
      if (!error && !data && fuzzyPattern) {
        const { data: fuzzy } = await supabase
          .from("reputation_summary")
          .select("*")
          .ilike("target", fuzzyPattern)
          .order("interactions", { ascending: false })
          .limit(1)
          .maybeSingle();
        if (fuzzy) { data = fuzzy; error = null; }
      }
    }

    // Scanner 관찰 데이터: interactions/success_rate 와 합산하지 않고 별도 `scanner` 블록으로만 노출.
    // 실패해도 기존 응답에는 영향 없음. task_type 필터 요청에는 붙이지 않는다.
    // npm:<패키지> / pypi:<패키지> 입력: 그 패키지를 선언한 Registry 항목을 찾는다. 1건이면 그 항목으로 조회, 여러 건이면 고르지 않고 후보 전부.
    const pkgInput = !taskType ? packageInputOf(target) : null;
    const npmQuery = pkgInput ? await resolvePackageTarget(supabase, pkgInput.type, pkgInput.ident) : null;
    const effectiveTarget = npmQuery && npmQuery.names.length === 1 ? `mcp:${npmQuery.names[0]}` : target;
    const scannerLookup = taskType || (npmQuery && npmQuery.names.length !== 1) ? null : await findScanner(supabase, effectiveTarget);
    // Registry 선언 + Scanner 날짜별 기록 + 선언 패키지. 실패해도 기존 응답에는 영향 없음. task_type 필터 요청에는 붙이지 않는다.
    const evidence = taskType ? null : await buildEvidence(supabase, effectiveTarget, scannerLookup, npmQuery);
    const inputNote = escapeNote(target);

    // 조회 자체를 로깅 (organic vs seeded 구분)
    const source = req.headers["x-lowdown-source"] === "seeded" ? "seeded" : "organic";
    const requester = (req.headers["x-lowdown-actor"] as string) ?? null;

    const userAgent = (req.headers["user-agent"] as string) ?? null;

    const lookupRow = {
      requester,
      target: rawTarget,
      source,
      user_agent: userAgent,
      ...(ref ? { ref } : {}),
    };
    // 응답 종류(result_kind)를 함께 남겨 "답이 없어 낭비된 조회" 비율을 잰다.
    // 열이 아직 없는 DB 에서도 조회 기록이 빠지지 않도록, 실패하면 result_kind 없이 한 번 더 쓴다.
    // 핵심 조회(평판 집계·Registry·Scanner)가 DB 오류로 실패했는가. "조회했는데 없음"과 구분한다.
    const scannerQueried = !taskType && !(npmQuery && npmQuery.names.length !== 1);
    const unavailable = coreUnavailable({
      summaryError: Boolean(error),
      scannerFailed: scannerQueried && scannerLookup === null,
      registryFailed: evidence?.registryFailed === true,
      statusFailed: evidence?.statusFailed === true,
    });

    const logged = await supabase.from("reputation_lookups").insert({ ...lookupRow, result_kind: unavailable ? "unavailable" : resultKind(taskType, scannerLookup, evidence, data) } as never);
    if (logged.error) await supabase.from("reputation_lookups").insert(lookupRow as never);

    // 오류를 "데이터 없음"(200)으로 답하면 수집기·에이전트가 틀린 사실로 저장한다(2026-10-25 DB 포화 때 관찰).
    // 503 + Retry-After 로 답해 나중에 다시 오게 한다.
    if (unavailable) {
      res.setHeader("Retry-After", String(RETRY_AFTER_SECONDS));
      res.setHeader("Cache-Control", "no-store");
      return res.status(503).json(UNAVAILABLE_BODY);
    }

    if (error || !data) {
      return res.status(200).json({
        target,
        task_type: taskType ?? undefined,
        ...evidenceHead(evidence, scannerLookup, 0, inputNote),
        ...evidenceFields(evidence, scannerLookup),
        interactions: 0,
        success_rate: null,
        confidence: "none",
        source: lookupSource(evidence, Date.now()),
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
      ...evidenceHead(evidence, scannerLookup, interactions, inputNote),
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
      source: lookupSource(evidence, Date.now()),
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

/**
 * 재사용될 때 출처가 함께 이동하도록 모든 응답 끝에 싣는 출처 정보.
 * 입력 문자열은 넣지 않는다(검증된 Registry 이름만) — 인용 문구에 외부 문자열이 섞이지 않게.
 */
export function lookupSource(ev: Evidence | null, now: number): Record<string, unknown> {
  const day = new Date(now).toISOString().slice(0, 10);
  return {
    name: "Lowdown",
    ...(ev?.name && SAFE_NAME.test(ev.name) ? { lookup: `https://lowdown-proxy.vercel.app/api/reputation/mcp:${ev.name}` } : {}),
    ...(ev?.name && ev.recordPage ? { record_page: ev.recordPage.page, record_json: ev.recordPage.json } : {}),
    dataset: "https://github.com/PetShopBros/lowdown-data",
    license: "CC BY 4.0",
    license_url: "https://creativecommons.org/licenses/by/4.0/",
    license_applies_to: "registry and scanner blocks (MCP Registry records and Lowdown Scanner observations)",
    retrieved_at: new Date(now).toISOString(),
    cite: `Lowdown (https://github.com/PetShopBros/lowdown-data), retrieved ${day}, CC BY 4.0`,
  };
}

export const BULK_DATA_LINK = '<https://github.com/PetShopBros/lowdown-data>; rel="related"; title="Daily dataset for bulk use (CC BY 4.0)"';

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

// ── 일시 장애 응답 ───────────────────────────────────────────────
export const RETRY_AFTER_SECONDS = 120;
export const UNAVAILABLE_BODY = {
  error: "temporarily_unavailable",
  retry_after_seconds: RETRY_AFTER_SECONDS,
  note: "Lowdown could not read its records for this request. Nothing is implied about the target. Retry later.",
};

/**
 * 핵심 조회가 오류로 실패했으면 true. 이때는 200 으로 답하지 않는다(빈 답이 사실로 저장되지 않게).
 * 보조 조회(npm/PyPI 상태, 샌드박스, 날짜별 이력, 기록 페이지) 실패는 여기에 넣지 않는다.
 */
export function coreUnavailable(f: { summaryError: boolean; scannerFailed: boolean; registryFailed: boolean; statusFailed?: boolean }): boolean {
  return f.summaryError || f.scannerFailed || f.registryFailed || f.statusFailed === true;
}

/** 조회 기록용 응답 종류. 판정이 아니라 "무엇으로 답했나"만. */
export function resultKind(taskType: string | null, lookup: ScannerLookup | null, ev: Evidence | null, data: unknown): string {
  if (taskType) return "task_type";
  if (lookup?.summary) return "observed";
  if ((lookup?.candidates.length ?? 0) > 0 || (ev?.registryCandidates?.length ?? 0) > 0) return "candidates";
  const reg = ev?.registry as Record<string, unknown> | undefined;
  if (reg && (reg.listed === true || reg.removed_at)) return "registry_only";
  if (ev?.packages?.some((p) => [p.npm, p.pypi].some((s) => s && (s as Record<string, unknown>).status !== "not_checked"))) return "package_only";
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
   note: "No Lowdown Scanner observation exists for this target. The Scanner observes a fixed sample of MCP Registry entries daily (5,000 from 2026-10-19, 2,000 before), and since 2026-10-27 also begins observing entries that someone looked up here, from the next daily run (separate from the fixed sample). Absence of data says nothing about the target's status.",
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
  frequency: "Once per day, for a fixed sample of MCP Registry entries with a streamable-http remote, plus entries looked up through this API (observation_basis: on_request, observed from the day after the lookup).",
  limits: "Each row is a single probe at one moment. It is not a measure of availability or uptime, and not a score.",
  dataset: "https://github.com/PetShopBros/lowdown-data",
};

interface Evidence {
  name: string | null;
  registry?: Record<string, unknown>;
  registryCandidates?: string[];
  scannerExtra?: Record<string, unknown>;
  scannerSince?: string | null;
  packages?: Array<Record<string, unknown>>;
  packageFacts?: string[];
  /** 최근 7일 안에 새 내용 표지가 생긴 변경 (첫 문장용) */
  changeFacts?: string[];
  /** stdio 샌드박스 결과 (SANDBOX_PUBLIC=1 일 때만) */
  sandbox?: Array<Record<string, unknown>>;
  /** npm:/pypi: 입력인데 그 패키지를 선언한 Registry 항목이 없음(형식 검사 통과한 이름) */
  undeclared?: { type: PackageInputType; ident: string };
  /** 이 Registry 항목의 Lowdown 서버 기록 페이지(lowdown-pages 에 있을 때만) */
  recordPage?: RecordPage;
  /** Registry 기록 조회가 DB 오류로 실패함(없음과 구분) → 503 */
  registryFailed?: boolean;
  /** 연결 상태 요약(target_status_summary) — 응답의 status 블록과 첫 문장 */
  status?: Record<string, unknown>;
  statusLead?: string;
  /** 연결 상태 요약 조회가 DB 오류로 실패함 → 503 */
  statusFailed?: boolean;
}

// ── 서버 기록 페이지 (lowdown-pages, scanner/pages.ts 가 매일 만든다) ─────────
// 페이지 목록(servers.json)을 읽어 둔다. 실패하면 페이지 주소 없이 답한다(응답은 막지 않음).
export interface RecordPage {
  page: string;
  json: string;
}
const PAGE_INDEX_URL = () => process.env.LOWDOWN_PAGES_INDEX_URL?.trim() || "https://petshopbros.github.io/lowdown-pages/servers.json";
const PAGE_INDEX_TTL_MS = 6 * 3_600_000;
const PAGE_INDEX_FAIL_TTL_MS = 10 * 60_000;
const PAGE_INDEX_TIMEOUT_MS = 1_500;
let pageIndexCache: { at: number; ttl: number; map: Map<string, RecordPage> } | null = null;

/** servers.json → 이름별 페이지. 목록과 같은 곳(base)의 .html / .json 주소만 받는다. */
export function pageIndexFrom(body: unknown, base: string): Map<string, RecordPage> {
  const map = new Map<string, RecordPage>();
  const servers = (body as { servers?: unknown })?.servers;
  if (!Array.isArray(servers)) return map;
  for (const s of servers.slice(0, 100_000)) {
    const name = (s as any)?.name;
    const page = (s as any)?.page;
    const json = (s as any)?.json;
    if (typeof name !== "string" || !SAFE_NAME.test(name)) continue;
    if (typeof page !== "string" || !page.startsWith(base) || !page.endsWith(".html") || page.length > 500) continue;
    if (typeof json !== "string" || !json.startsWith(base) || !json.endsWith(".json") || json.length > 500) continue;
    map.set(name, { page, json });
  }
  return map;
}

export function resetPageIndexCache(): void {
  pageIndexCache = null;
}

async function recordPageFor(name: string, now: number): Promise<RecordPage | null> {
  if (!pageIndexCache || now - pageIndexCache.at > pageIndexCache.ttl) {
    const url = PAGE_INDEX_URL();
    const base = url.replace(/servers\.json$/, "");
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(PAGE_INDEX_TIMEOUT_MS) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      pageIndexCache = { at: now, ttl: PAGE_INDEX_TTL_MS, map: pageIndexFrom(await res.json(), base) };
    } catch {
      // 지난 목록이 있으면 그대로 쓰고, 없으면 빈 목록. 잠시 뒤 다시 시도한다.
      pageIndexCache = { at: now, ttl: PAGE_INDEX_FAIL_TTL_MS, map: pageIndexCache?.map ?? new Map() };
    }
  }
  return pageIndexCache.map.get(name) ?? null;
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
  tool_set_hash?: unknown;
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
  set: string | null;
}

/** 변경 이벤트 → 앞뒤 도구 집합 해시. 응답(JSON)에는 나가지 않는다. 내용 표지 비교(attachNewFlags)에만 쓴다. */
export const EVENT_SETS = new WeakMap<object, { from: string; to: string }>();
const SET_HASH_RE = /^[0-9a-f]{64}$/;

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
      set: typeof r.tool_set_hash === "string" && SET_HASH_RE.test(r.tool_set_hash) ? r.tool_set_hash : null,
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
          const ev: Record<string, unknown> = {
            day: cur.day,
            kinds,
            ...(cur.count !== null && prev.count !== null && cur.count !== prev.count ? { tool_count: { from: prev.count, to: cur.count } } : {}),
            ...(cur.version && prev.version && cur.version !== prev.version ? { server_version: { from: prev.version, to: cur.version } } : {}),
            returned_to_earlier_definition: definitionChanged && seen.has(key),
            compared_with: prev.day,
            ...(multiRemote ? { remote_host: hostOfUrl(remote) } : {}),
          };
          if (definitionChanged && cur.set && prev.set && cur.set !== prev.set) EVENT_SETS.set(ev, { from: prev.set, to: cur.set });
          events.push(ev);
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

// ── 변경 내용 표지 (supabase/2026-10-27_tool_content_flags.sql) ────────────────
// 변경 이벤트의 앞뒤 도구 집합을 비교해, 새로 나타난 표지만 이벤트에 붙인다(new_flags). 원문·해시는 내보내지 않는다.
// null = 확인하지 못함(앞뒤 집합 중 하나의 저장된 정의가 없거나 조회 실패). [] = 확인했고 새 표지 없음.
export const CONTENT_RULES = ["description_url", "hidden_characters"] as const;
const CONTENT_RULE_SET = new Set<string>(CONTENT_RULES);
const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;
const MAX_NEW_DOMAINS = 5;
/** 첫 문장에 쓰는 기간(일). 그보다 오래된 표지는 events 에만 */
export const CHANGE_FACT_DAYS = 7;
const CONTENT_FLAGS_BASIS =
  "new_flags lists content markers that appeared with a change, compared with the previous tool set from the same remote: " +
  "description_url (a tool description contains an http(s) URL; domains that were not in the previous set are listed) and " +
  "hidden_characters (a tool definition contains invisible Unicode characters: zero-width, text-direction controls or tag characters). " +
  "Computed from the tool definitions Lowdown stored; the text is not returned. null means not checked. A marker is a recorded fact, not a judgment.";

type FlagMap = Map<string, { defs: number; domains: string[] }>;

/**
 * RPC 행 → 집합별 표지. 저장된 집합만 들어간다(rule_id 가 null 인 행 = 그 집합을 확인했다는 표시).
 * 맵에 없는 집합은 확인하지 못한 것이다. 형식이 맞지 않는 행·값은 버린다.
 */
export function flagMapsFromRows(rows: unknown, sets: ReadonlySet<string>): Map<string, FlagMap> {
  const out = new Map<string, FlagMap>();
  const list = (Array.isArray(rows) ? rows : []) as Array<Record<string, unknown>>;
  for (const o of list) {
    if (o.rule_id === null && typeof o.tool_set_hash === "string" && sets.has(o.tool_set_hash)) out.set(o.tool_set_hash, new Map());
  }
  for (const o of list) {
    const set = typeof o.tool_set_hash === "string" && out.has(o.tool_set_hash) ? o.tool_set_hash : null;
    const rule = typeof o.rule_id === "string" && CONTENT_RULE_SET.has(o.rule_id) ? o.rule_id : null;
    const defs = Number.isInteger(o.defs) && (o.defs as number) > 0 && (o.defs as number) < 100_000 ? (o.defs as number) : null;
    if (!set || !rule || !defs) continue;
    const domains = (Array.isArray(o.domains) ? o.domains : []).filter((d): d is string => typeof d === "string" && d.length <= 100 && DOMAIN_RE.test(d)).slice(0, 20);
    out.get(set)!.set(rule, { defs, domains });
  }
  return out;
}

/** 앞 집합에 비해 새로 나타난 표지: 표지가 붙은 정의 수가 늘었거나, 새 도메인이 생겼다. */
export function newFlagsBetween(from: FlagMap, to: FlagMap): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const rule of CONTENT_RULES) {
    const a = from.get(rule);
    const b = to.get(rule);
    if (!b) continue;
    const before = a?.defs ?? 0;
    const newDomains = b.domains.filter((d) => !(a?.domains ?? []).includes(d)).slice(0, MAX_NEW_DOMAINS);
    if (b.defs > before || newDomains.length > 0) {
      out.push({ rule, definitions: { from: before, to: b.defs }, ...(rule === "description_url" ? { new_domains: newDomains } : {}) });
    }
  }
  return out;
}

const isDefinitionChange = (e: Record<string, unknown>) =>
  Array.isArray(e.kinds) && e.kinds.some((k) => k === "schema_changed" || k === "description_changed" || k === "tool_names_changed");

/** 변경 이벤트마다 new_flags 를 붙인다. 조회 실패는 응답을 막지 않는다(보조 정보) — 그때는 null 과 content_flags_checked: false. */
export async function attachNewFlags(supabase: any, dc: Record<string, unknown>): Promise<Record<string, unknown>> {
  const events = (Array.isArray(dc.events) ? dc.events : []) as Array<Record<string, unknown>>;
  const changeEvents = events.filter(isDefinitionChange);
  if (changeEvents.length === 0) return dc;
  for (const e of changeEvents) e.new_flags = null;
  const sets = new Set<string>();
  for (const e of changeEvents) {
    const p = EVENT_SETS.get(e);
    if (p) {
      sets.add(p.from);
      sets.add(p.to);
    }
  }
  let checked = false;
  if (sets.size > 0) {
    try {
      const r = await supabase.rpc("lowdown_tool_set_flags", { p_sets: [...sets].slice(0, 20) });
      if (!r.error) {
        const maps = flagMapsFromRows(r.data, sets);
        for (const e of changeEvents) {
          const p = EVENT_SETS.get(e);
          const from = p ? maps.get(p.from) : undefined;
          const to = p ? maps.get(p.to) : undefined;
          // 앞뒤 집합이 모두 저장돼 있을 때만 비교한다. 하나라도 없으면 null(확인하지 못함) — "새 표지 없음"으로 말하지 않는다.
          if (from && to) e.new_flags = newFlagsBetween(from, to);
        }
        checked = true;
      }
    } catch {
      // 보조 정보: 실패하면 null 그대로
    }
  }
  return { ...dc, content_flags_checked: checked, content_flags_basis: CONTENT_FLAGS_BASIS };
}

/** 첫 문장용: 최근 CHANGE_FACT_DAYS 일 안에 새 표지가 생긴 변경. 최신 순, 최대 2문장. */
export function changeFactsFrom(dc: unknown, now: number): string[] {
  const events = dc && typeof dc === "object" && Array.isArray((dc as any).events) ? ((dc as any).events as Array<Record<string, unknown>>) : [];
  const since = utcDay(now - CHANGE_FACT_DAYS * DAY_MS);
  const facts: string[] = [];
  for (const e of events) {
    const day = typeof e.day === "string" && ISO_DAY.test(e.day) ? e.day : null;
    if (!day || day < since || !Array.isArray(e.new_flags)) continue;
    for (const f of e.new_flags as Array<Record<string, unknown>>) {
      if (f.rule === "description_url") {
        const doms = (Array.isArray(f.new_domains) ? f.new_domains : []).filter((d): d is string => typeof d === "string" && DOMAIN_RE.test(d));
        facts.push(`On ${day} a tool description with a URL appeared${doms.length ? ` (new domain${doms.length === 1 ? "" : "s"}: ${doms.join(", ")})` : ""}.`);
      } else if (f.rule === "hidden_characters") {
        facts.push(`On ${day} a tool definition with invisible Unicode characters appeared.`);
      }
      if (facts.length >= 2) return facts;
    }
  }
  return facts;
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
      .select("observed_at,reached_level,http_status,error_type,tool_count:metadata->>tool_count,schema_hash:metadata->>schema_hash,desc_hash:metadata->>desc_hash,server_version:metadata->>server_version,names_hash:metadata->>names_hash,remote_url:metadata->>remote_url,retry_level:metadata->retry->>reached_level,tool_set_hash:metadata->>tool_set_hash")
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
      // 고정 코호트(fixed_cohort)는 매일 같은 대상을 본 표본. on_request 는 누군가 조회한 뒤부터 관찰하기 시작한 대상이라 표본이 아니다 — 추세를 표본 통계와 합쳐 읽지 말 것
      observation_basis: cohorts === null ? null : cohorts.length > 0 ? "fixed_cohort" : rows.length > 0 ? "on_request" : null,
      ...(cohorts ? { cohorts } : {}),
      first_observed_at: firstObservedAt,
      definition_changes: await attachNewFlags(supabase, definitionChanges(rows)),
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

async function buildEvidence(supabase: any, target: string, lookup: ScannerLookup | null, npmQuery: PackageQuery | null = null): Promise<Evidence | null> {
  const now = Date.now();
  const ev: Evidence = { name: null };
  let registryRow: any | null = null;
  // npm:/pypi: 입력이 Registry 항목 하나로 정해지지 않으면(0건·여러 건) 이름 조회 없이 패키지 사실과 후보만
  if (npmQuery && npmQuery.names.length !== 1) {
    const label = npmQuery.type === "pypi" ? "PyPI" : "npm";
    if (npmQuery.names.length > 1) ev.registryCandidates = npmQuery.names;
    else if (!npmQuery.failed) {
      if (npmQuery.ident) ev.undeclared = { type: npmQuery.type, ident: npmQuery.ident };
      ev.registry = {
        listed: false,
        note: npmQuery.ident
          ? `No MCP Registry entry in Lowdown's records (kept since ${REGISTRY_RECORDS_SINCE}) declares this ${label} package.`
          : `Not a valid ${label} package name.`,
      };
    } else {
      ev.registryFailed = true;
    }
    if (npmQuery.ident) await attachPackages(supabase, ev, [{ type: npmQuery.type, identifier: npmQuery.ident, version: null }], now, true);
    return ev;
  }
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
      const declared = declaredPackages(r.row.packages_key);
      const [, , page] = await Promise.all([
        declared.length > 0 ? attachPackages(supabase, ev, declared, now, false) : Promise.resolve(),
        declared.length > 0 ? attachSandbox(supabase, ev, declared) : Promise.resolve(),
        typeof r.name === "string" ? recordPageFor(r.name, now) : Promise.resolve(null),
        typeof r.name === "string" ? attachStatus(supabase, ev, `mcp:${r.name}`, now) : Promise.resolve(),
      ]);
      if (page) ev.recordPage = page;
    } else if (r.candidates.length > 1) {
      ev.registryCandidates = r.candidates;
    } else if (r.name === null && !(target.includes(":") && !target.startsWith("mcp:"))) {
      ev.registry = {
        listed: false,
        note: `No MCP Registry record matches this name in Lowdown's Registry records (kept since ${REGISTRY_RECORDS_SINCE}).`,
      };
    }
  } catch {
    // Registry 기록 조회 실패 → 핸들러가 503 으로 답한다
    ev.registryFailed = true;
  }
  const targetId = lookup?.summary?.target;
  if (typeof targetId === "string") {
    try {
      const h = await scannerHistory(supabase, targetId, registryRow, (lookup!.summary!.latest as any)?.server_version, now);
      ev.scannerExtra = h.extra;
      ev.scannerSince = h.since;
      ev.changeFacts = changeFactsFrom(h.extra.definition_changes, now);
    } catch {
      // 날짜별 기록 실패 → 기존 scanner 요약만
    }
  }
  return ev;
}

// ── 연결 상태 요약 (target_status_summary, supabase/2026-10-27_target_status_summary.sql) ─────
// 미리 계산된 1행만 읽는다. 행이 없으면 아무 말도 하지 않는다(관찰 없음은 상태가 아니다). 읽기 오류면 503.
const STATUS_COLUMNS =
  "target_id,latest_day,latest_state,latest_remote_states,latest_remotes,latest_tool_count,latest_observation_basis," +
  "streak_days,streak_start_day,streak_break,observed_days_30d,answered_days_30d,auth_required_days_30d," +
  "no_response_days_30d,mixed_days_30d,definition_id,definition_version,computed_at";
const REMOTE_STATES = ["answered", "auth_required", "list_failed", "no_response", "invalid_response"] as const;
const STATUS_STATES = new Set<string>([...REMOTE_STATES, "mixed"]);
const STATUS_BREAKS = new Set(["state_change", "not_observed", "no_earlier_observation", "window_start"]);
/** 마지막 점검이 이보다 오래되면 현재 상태를 말하지 않는다 */
export const STATUS_STALE_DAYS = 2;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const STATUS_BASIS =
  "One check per day from one network location: POST initialize, then tools/list; no tool calls and no credentials. " +
  "A day without a check is not counted as a failure and ends a consecutive run. When remotes differ on a day, the day is mixed. " +
  "Recorded facts, not a score or an availability measure.";
const REMOTE_PHRASE: Record<string, string> = {
  answered: "answered tools/list",
  auth_required: "required authentication",
  list_failed: "answered initialize but not tools/list",
  no_response: "did not respond",
  invalid_response: "did not answer as an MCP server",
};

const statusCount = (v: unknown): number | null => (Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 100_000 ? (v as number) : null);
const isoDay = (v: unknown): string | null => (typeof v === "string" && ISO_DAY.test(v.slice(0, 10)) ? v.slice(0, 10) : null);

async function attachStatus(supabase: any, ev: Evidence, targetId: string, now: number): Promise<void> {
  try {
    const r = await supabase.from("target_status_summary").select(STATUS_COLUMNS).eq("target_id", targetId).limit(1);
    if (r.error) {
      ev.statusFailed = true;
      return;
    }
    const row = (r.data ?? [])[0];
    if (!row) return;
    const shaped = shapeStatus(row, now);
    if (!shaped) return;
    ev.status = shaped.block;
    ev.statusLead = shaped.lead;
  } catch {
    ev.statusFailed = true;
  }
}

/** 요약 행 → status 블록과 첫 문장. 값이 하나라도 형식에 맞지 않으면 null (말하지 않는다). */
export function shapeStatus(row: Record<string, unknown>, now: number): { block: Record<string, unknown>; lead: string } | null {
  const state = typeof row.latest_state === "string" && STATUS_STATES.has(row.latest_state) ? row.latest_state : null;
  const latest = isoDay(row.latest_day);
  const since = isoDay(row.streak_start_day);
  const n = statusCount(row.streak_days);
  const observed = statusCount(row.observed_days_30d);
  if (!state || !latest || !since || !n || !observed || n > observed) return null;
  const brk = typeof row.streak_break === "string" && STATUS_BREAKS.has(row.streak_break) ? row.streak_break : null;
  const days = {
    observed,
    answered: statusCount(row.answered_days_30d),
    auth_required: statusCount(row.auth_required_days_30d),
    no_response: statusCount(row.no_response_days_30d),
    mixed: statusCount(row.mixed_days_30d),
  };
  const remoteStates: Record<string, number> = {};
  const rs = row.latest_remote_states;
  if (rs && typeof rs === "object" && !Array.isArray(rs)) {
    for (const k of REMOTE_STATES) {
      const v = statusCount((rs as Record<string, unknown>)[k]);
      if (v) remoteStates[k] = v;
    }
  }
  const tools = statusCount(row.latest_tool_count);
  const daysSince = Math.round((Date.parse(utcDay(now)) - Date.parse(latest)) / DAY_MS);
  const stale = daysSince > STATUS_STALE_DAYS;
  const version = statusCount(row.definition_version);
  const computedAt = typeof row.computed_at === "string" && !Number.isNaN(Date.parse(row.computed_at)) ? new Date(row.computed_at).toISOString() : null;

  const block: Record<string, unknown> = {
    state,
    latest_check: latest,
    days_since_latest_check: daysSince,
    stale,
    consecutive_days: n,
    consecutive_since: since,
    consecutive_break: brk,
    checks_30d: days,
    remote_states: remoteStates,
    tool_count: state === "answered" ? tools : null,
    observation_basis: row.latest_observation_basis === "fixed_cohort" ? "fixed_cohort" : "on_request",
    definition: { id: "target_status", version },
    computed_at: computedAt,
    basis: STATUS_BASIS,
  };

  let lead: string;
  if (stale) {
    lead = `No Lowdown daily check since ${latest} (${daysSince} days ago), so no current connectivity is stated.`;
  } else if (state === "mixed") {
    const parts = REMOTE_STATES.filter((k) => remoteStates[k]).map((k) => `${remoteStates[k]} ${REMOTE_PHRASE[k]}`);
    lead = `On the latest daily check (${latest}) its remotes differed: ${parts.join(", ")}.`;
  } else {
    const all = n === observed;
    const span =
      n === 1 && observed === 1 ? `on the only daily check recorded in the last 30 days (${latest})`
      : n === 1 ? `on the latest daily check (${latest})`
      : all ? `on all ${n} daily checks recorded in the last 30 days (${since} to ${latest})`
      : `on the last ${n} consecutive daily checks (${since} to ${latest})`;
    const verb: Record<string, string> = {
      answered: "Answered initialize and tools/list",
      auth_required: "Required authentication (HTTP 401/403)",
      list_failed: "Answered initialize but not tools/list",
      no_response: "No successful response",
      invalid_response: "Did not answer as an MCP server",
    };
    lead = `${verb[state]} ${span}`;
    if (state === "answered" && tools !== null) lead += `; ${tools} tool${tools === 1 ? "" : "s"} listed`;
    lead += ".";
    if (state === "auth_required") lead += " Lowdown checks without credentials, so no tools were listed.";
    if (state === "no_response") lead += " Checked from one network location.";
    const sameDays = state === "answered" ? days.answered : state === "auth_required" ? days.auth_required : state === "no_response" ? days.no_response : null;
    if (!all && sameDays !== null) lead += ` ${sameDays} of ${observed} observed days in the last 30 had this result.`;
    if (brk === "not_observed") lead += ` The day before ${since} has no check.`;
  }
  return { block, lead };
}

function evidenceFields(ev: Evidence | null, lookup: ScannerLookup | null): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (ev?.status) out.status = ev.status;
  if (ev?.registry) out.registry = ev.registry;
  if (ev?.registryCandidates) out.registry_candidates = ev.registryCandidates;
  if (ev?.packages && ev.packages.length > 0) {
    out.packages = ev.packages;
    out.packages_note = packagesNote(ev.packages);
  }
  if (ev?.sandbox && ev.sandbox.length > 0) {
    out.sandbox = ev.sandbox;
    out.sandbox_note = SANDBOX_NOTE;
  }
  const scanner = scannerFields(lookup);
  if (scanner.scanner && ev?.scannerExtra && lookup?.summary) {
    const { note, ...rest } = scanner.scanner as Record<string, unknown>;
    out.scanner = { ...rest, ...ev.scannerExtra, note };
  } else Object.assign(out, scanner);
  return out;
}

// npm:/pypi: 입력에 선언 항목이 없을 때: Lowdown 이 이 패키지를 다루지 않는다는 사실(문제가 없다는 뜻이 아님)
const scopeNote = (type: PackageInputType) =>
  `Lowdown records ${type === "pypi" ? "PyPI" : "npm"} package status only for packages that MCP Registry entries declare, so it has no package facts to report.`;

/** 첫머리: 확인된 Registry 이름과 사실 문장. 기록이 있는 쪽을 먼저 말한다. */
function evidenceHead(ev: Evidence | null, lookup: ScannerLookup | null, interactions: number, inputNote: string | null = null): Record<string, unknown> {
  if (!ev && !lookup) return interactions === 0 ? { message: `No interactions recorded yet.${inputNote ? ` ${inputNote}` : ""}` } : {};
  const parts: string[] = [];
  const reg = ev?.registry as Record<string, unknown> | undefined;
  if (reg?.listed === true) parts.push("MCP Registry declaration recorded");
  else if (reg && reg.removed_at) parts.push("MCP Registry entry recorded as removed");
  else if (ev?.registryCandidates) parts.push("several MCP Registry names match (see registry_candidates)");
  else if (ev?.undeclared) parts.push(`no MCP Registry entry declares the ${ev.undeclared.type === "pypi" ? "PyPI" : "npm"} package ${ev.undeclared.ident}`);
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
  // 첫 문장: 연결 상태(최근 일일 점검) → 설치 판단을 바꿀 수 있는 패키지 사실(deprecated·404). 새 버전 발행은 packages 이력에만.
  const lead = [ev?.statusLead, ...(ev?.changeFacts ?? []), ...(ev?.packageFacts ?? [])].filter((s): s is string => typeof s === "string" && s.length > 0).join(" ");
  return {
    ...(ev?.name ? { resolved_target: `mcp:${ev.name}` } : {}),
    message: `${lead ? `${lead} ` : ""}${text.charAt(0).toUpperCase()}${text.slice(1)}.${ev?.undeclared ? ` ${scopeNote(ev.undeclared.type)}` : ""}${inputNote ? ` ${inputNote}` : ""}`,
  };
}

// ── 선언 패키지 블록 (npm 일별 상태, scanner/npm-snapshot.ts 가 기록) ─────────
// npm 공개 메타데이터에서 Lowdown 이 기록한 값만: 최신 버전·수정 시각·최신 버전의 deprecated 여부·404.
// 404 만 not_found 로 기록되고, 네트워크 오류·429·5xx 는 상태를 바꾸지 않는다(기록 쪽 규칙). npm 원문은 없다.

const NPM_NAME = /^(?:@[A-Za-z0-9~-][A-Za-z0-9._~-]*\/)?[A-Za-z0-9~-][A-Za-z0-9._~-]*$/;
const PACKAGE_TYPES = new Set(["npm", "pypi", "oci", "nuget", "mcpb", "cargo"]);
const SAFE_PACKAGE_ID = /^[A-Za-z0-9@._~\/:+=-]{1,300}$/;
const NPM_EVENT_KINDS = new Set(["latest_changed", "deprecated", "undeprecated", "not_found", "restored"]);
const MAX_PACKAGES = 10;
const MAX_PACKAGE_EVENTS = 5;
export const MAX_NPM_CANDIDATES = 50;
const PYPI_NAME = /^([A-Za-z0-9]|[A-Za-z0-9][A-Za-z0-9._-]*[A-Za-z0-9])$/;
const PYPI_EVENT_KINDS = new Set(["latest_changed", "yanked", "unyanked", "status_changed", "not_found", "restored"]);
const PYPI_PROJECT_STATUSES = new Set(["active", "archived", "quarantined", "deprecated"]);
export type PackageInputType = "npm" | "pypi";
const NPM_NOTE =
  "npm values are recorded daily by Lowdown from npm's public registry metadata (registry.npmjs.org); package code is not run. latest_deprecated refers only to the version npm tags as latest, not to other versions. not_found means npm answered HTTP 404; network errors and 429/5xx responses do not change the recorded status.";
const PYPI_NOTE =
  "PyPI values are recorded daily by Lowdown from PyPI's public JSON and Index APIs (pypi.org); package code is not run. latest_yanked refers only to the version PyPI lists as latest. project_status is the PEP 792 project status. not_found means PyPI's JSON API answered HTTP 404; network errors and 429/5xx responses do not change the recorded status. not_found_kind separates a project PyPI lists but that has no release (no_releases) from a name with no PyPI project (no_project), using PyPI's Index API; null when not known.";
/** 응답에 실린 패키지 종류에 해당하는 설명만 붙인다. */
export function packagesNote(packages: ReadonlyArray<Record<string, unknown>>): string {
  const has = (t: string) => packages.some((p) => p.registry === t);
  const parts: string[] = [];
  if (has("npm")) parts.push(NPM_NOTE);
  if (has("pypi")) parts.push(PYPI_NOTE);
  parts.push("Other package types are not checked.");
  return parts.join(" ");
}

export const isNpmName = (s: string) => s.length > 0 && s.length <= 214 && NPM_NAME.test(s);
export const isPypiName = (s: string) => s.length > 0 && s.length <= 200 && PYPI_NAME.test(s);
/** PEP 503 정규화: 소문자, 연속된 - _ . 는 - 하나로 */
export const normalizePypiName = (s: string) => s.replace(/[-_.]+/g, "-").toLowerCase();

/** "npm:x" / "pypi:x" 입력 → 종류와 이름 */
export function packageInputOf(target: string): { type: PackageInputType; ident: string } | null {
  if (target.startsWith("npm:")) return { type: "npm", ident: target.slice(4) };
  if (target.startsWith("pypi:")) return { type: "pypi", ident: target.slice(5) };
  return null;
}

export interface DeclaredPackage {
  type: string;
  identifier: string | null;
  version: string | null;
}

interface PackageQuery {
  type: PackageInputType;
  /** 형식 검사를 통과한 이름(pypi 는 PEP 503 정규화). 형식이 아니면 null */
  ident: string | null;
  names: string[];
  failed?: boolean;
}

/** registry_state.packages_key(줄마다 "종류 식별자 버전 전송방식") → 선언 패키지. 형식이 아닌 값은 null. */
export function declaredPackages(key: unknown): DeclaredPackage[] {
  if (typeof key !== "string" || key.length === 0) return [];
  const out: DeclaredPackage[] = [];
  for (const line of key.split("\n")) {
    const [type = "", identifier = "", version = ""] = line.split(" ");
    if (!PACKAGE_TYPES.has(type)) continue;
    const okId = type === "npm" ? isNpmName(identifier) : type === "pypi" ? isPypiName(identifier) : SAFE_PACKAGE_ID.test(identifier);
    out.push({ type, identifier: okId ? identifier : null, version: safeVersion(version) });
    if (out.length >= MAX_PACKAGES) break;
  }
  return out;
}

/**
 * npm:<이름> / pypi:<이름> → 그 패키지를 선언한 (지금 목록에 있는) Registry 이름들. 고르지 않는다.
 * pypi 는 PEP 503 정규화 이름이 같으면 같은 패키지다(대소문자·구분자 차이 무시).
 */
async function resolvePackageTarget(supabase: any, type: PackageInputType, rawIdent: string): Promise<PackageQuery> {
  if (type === "npm" ? !isNpmName(rawIdent) : !isPypiName(rawIdent)) return { type, ident: null, names: [] };
  const ident = type === "pypi" ? normalizePypiName(rawIdent) : rawIdent;
  try {
    // pypi 는 선언 표기가 정규화 이름과 다를 수 있어(My_Pkg 등) 구분자 자리를 와일드카드로 두고, 정확한 비교는 아래에서 한다.
    const escaped = (type === "pypi" ? ident.split("-").map((p) => p.replace(/[\\%_]/g, "\\$&")).join("%") : ident.replace(/[\\%_]/g, "\\$&"));
    const pattern = `%${type} ${escaped} %`;
    const { data, error } = await supabase
      .from("registry_state")
      .select("name,packages_key")
      .ilike("packages_key", pattern)
      .is("removed_at", null)
      .order("name", { ascending: true })
      .limit(MAX_NPM_CANDIDATES);
    if (error) return { type, ident, names: [], failed: true };
    const same = (p: DeclaredPackage) => p.type === type && p.identifier !== null && (type === "pypi" ? normalizePypiName(p.identifier) === ident : p.identifier === ident);
    const names = ((data ?? []) as any[])
      .filter((r) => declaredPackages(r.packages_key).some(same))
      .map((r) => String(r.name))
      .filter((n) => SAFE_NAME.test(n));
    return { type, ident, names };
  } catch {
    return { type, ident, names: [], failed: true };
  }
}

const dayOf = (v: unknown) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null);
const isoOrNull = (v: unknown) => (typeof v === "string" && Number.isFinite(Date.parse(v)) ? new Date(Date.parse(v)).toISOString() : null);

/**
 * 선언 패키지 + npm 상태 + npm 이벤트 → packages 블록과 첫 문장용 사실.
 * not_found_since: 있다가 404 가 된 날(not_found 이벤트) 또는 "first_check"(Lowdown 의 첫 확인부터 404).
 * latest_deprecated 는 npm 이 latest 로 표시한 버전에 대한 값이다. 다른 버전의 상태는 뜻하지 않는다.
 */
export function shapePackages(
  declared: DeclaredPackage[],
  stateRows: any[],
  changeRows: any[],
  now: number,
  fromNpmInput: boolean,
  pypi: { stateRows: any[]; changeRows: any[] } = { stateRows: [], changeRows: [] },
): { packages: Array<Record<string, unknown>>; facts: string[] } {
  const state = new Map<string, any>();
  for (const s of stateRows) if (typeof s?.ident === "string") state.set(s.ident, s);
  const pypiState = new Map<string, any>();
  for (const s of pypi.stateRows) if (typeof s?.ident === "string") pypiState.set(s.ident, s);
  const windowStart = utcDay(now - WINDOW_DAYS * DAY_MS);
  const packages: Array<Record<string, unknown>> = [];
  const facts: string[] = [];
  for (const d of declared) {
    const base: Record<string, unknown> = { registry: d.type, name: d.identifier, ...(fromNpmInput ? {} : { declared_version: d.version }) };
    if (d.type === "pypi") {
      const shaped = shapePypiPackage(d, base, pypiState, pypi.changeRows, windowStart, fromNpmInput);
      packages.push(shaped.entry);
      facts.push(...shaped.facts);
      continue;
    }
    if (d.type !== "npm" || d.identifier === null) {
      packages.push({ ...base, npm: null, note: d.type === "npm" ? "Declared name is not a valid npm package name." : "Not checked by Lowdown (only npm and PyPI packages are checked)." });
      continue;
    }
    const s = state.get(d.identifier);
    if (!s || (s.status !== "found" && s.status !== "not_found")) {
      packages.push({ ...base, npm: { status: "not_checked" } });
      continue;
    }
    const events = changeRows.filter((c) => c?.ident === d.identifier && NPM_EVENT_KINDS.has(c.kind) && dayOf(c.detected_on));
    const lastNotFound = events.find((c) => c.kind === "not_found");
    const recent = events
      .filter((c) => (dayOf(c.detected_on) ?? "") >= windowStart)
      .slice(0, MAX_PACKAGE_EVENTS)
      .map((c) => ({
        on: dayOf(c.detected_on),
        kind: c.kind,
        ...(c.kind === "latest_changed" ? { old: safeVersion(c.old_value), new: safeVersion(c.new_value) } : {}),
        ...(c.kind === "not_found" ? { last_seen_latest: safeVersion(c.old_value) } : {}),
      }));
    const checkedDay = dayOf(s.checked_at);
    const npm: Record<string, unknown> = { status: s.status };
    if (s.status === "found") {
      const latest = safeVersion(s.latest);
      npm.latest = latest;
      npm.latest_deprecated = typeof s.deprecated === "boolean" ? s.deprecated : null;
      npm.modified = isoOrNull(s.modified);
      if (!fromNpmInput) npm.declared_is_latest = d.version && latest ? d.version === latest : null;
      if (s.deprecated === true) facts.push(`npm marks the latest version of ${d.identifier}${latest ? ` (${latest})` : ""} as deprecated (checked ${checkedDay}).`);
    } else {
      const since = lastNotFound ? dayOf(lastNotFound.detected_on) : "first_check";
      npm.not_found_since = since;
      facts.push(
        since === "first_check"
          ? `npm has returned 404 for ${d.identifier} at every Lowdown check since ${dayOf(s.first_checked_at)} (checked ${checkedDay}).`
          : `npm has returned 404 for ${d.identifier} since ${since}; it was available before (checked ${checkedDay}).`,
      );
    }
    npm.first_checked_at = isoOrNull(s.first_checked_at);
    npm.checked_at = isoOrNull(s.checked_at);
    npm.recent_events = recent;
    packages.push({ ...base, npm });
  }
  return { packages, facts: facts.slice(0, 3) };
}

/**
 * PyPI JSON API 404 의 두 종류. Index API(/simple/) 가 마지막으로 답한 값으로 가른다.
 *  - no_releases: Index API 200 — PyPI 에 프로젝트는 있으나 릴리스가 없음
 *  - no_project:  Index API 404 — 그 이름의 프로젝트가 없음
 *  - null:        모름(index_status 기록 전 행, Index 확인 실패). 단 첫 확인부터 404 이고 project_status 가 있는 기준선 행은
 *                 직전 값이 남을 수 없으므로(첫 관찰) Index API 가 200 이었다는 뜻 → no_releases.
 */
export function pypiNotFoundKind(indexStatus: unknown, projectStatus: string | null, since: string | null): "no_releases" | "no_project" | null {
  if (indexStatus === "found") return "no_releases";
  if (indexStatus === "not_found") return "no_project";
  if (since === "first_check" && projectStatus !== null) return "no_releases";
  return null;
}

/** PyPI 선언 패키지 하나 → packages 항목(`pypi` 블록)과 첫 문장용 사실. 상태는 PEP 503 정규화 이름으로 찾는다. */
function shapePypiPackage(
  d: DeclaredPackage,
  base: Record<string, unknown>,
  state: Map<string, any>,
  changeRows: any[],
  windowStart: string,
  fromInput: boolean,
): { entry: Record<string, unknown>; facts: string[] } {
  if (d.identifier === null) return { entry: { ...base, pypi: null, note: "Declared name is not a valid PyPI project name." }, facts: [] };
  const ident = normalizePypiName(d.identifier);
  const s = state.get(ident);
  if (!s || (s.status !== "found" && s.status !== "not_found")) return { entry: { ...base, pypi: { status: "not_checked" } }, facts: [] };
  const facts: string[] = [];
  const events = changeRows.filter((c) => c?.ident === ident && PYPI_EVENT_KINDS.has(c.kind) && dayOf(c.detected_on));
  const lastNotFound = events.find((c) => c.kind === "not_found");
  const recent = events
    .filter((c) => (dayOf(c.detected_on) ?? "") >= windowStart)
    .slice(0, MAX_PACKAGE_EVENTS)
    .map((c) => {
      const on = dayOf(c.detected_on);
      switch (c.kind) {
        case "latest_changed":
          return { on, kind: c.kind, old: safeVersion(c.old_value), new: safeVersion(c.new_value) };
        case "status_changed":
          return { on, kind: c.kind, old: PYPI_PROJECT_STATUSES.has(c.old_value) ? c.old_value : null, new: PYPI_PROJECT_STATUSES.has(c.new_value) ? c.new_value : null };
        case "not_found":
          return { on, kind: c.kind, last_seen_latest: safeVersion(c.old_value) };
        case "yanked":
        case "unyanked":
          return { on, kind: c.kind, version: safeVersion(c.old_value) };
        default:
          return { on, kind: c.kind, latest: safeVersion(c.new_value) };
      }
    });
  const checkedDay = dayOf(s.checked_at);
  const projectStatus = PYPI_PROJECT_STATUSES.has(s.project_status) ? (s.project_status as string) : null;
  const pypi: Record<string, unknown> = { status: s.status };
  if (s.status === "found") {
    const latest = safeVersion(s.latest);
    pypi.latest = latest;
    pypi.latest_yanked = typeof s.latest_yanked === "boolean" ? s.latest_yanked : null;
    pypi.latest_uploaded = isoOrNull(s.uploaded);
    if (!fromInput) pypi.declared_is_latest = d.version && latest ? d.version === latest : null;
    if (s.latest_yanked === true) facts.push(`PyPI marks the latest version of ${d.identifier}${latest ? ` (${latest})` : ""} as yanked (checked ${checkedDay}).`);
  } else {
    const since = lastNotFound ? dayOf(lastNotFound.detected_on) : "first_check";
    const kind = pypiNotFoundKind(s.index_status, projectStatus, since);
    const firstDay = dayOf(s.first_checked_at);
    pypi.not_found_since = since;
    pypi.not_found_kind = kind;
    facts.push(
      kind === "no_releases"
        ? since === "first_check"
          ? `PyPI lists the project ${d.identifier} but has had no release of it at every Lowdown check since ${firstDay} (checked ${checkedDay}).`
          : `PyPI has listed the project ${d.identifier} without any release since ${since}; it had releases before (checked ${checkedDay}).`
        : kind === "no_project"
          ? since === "first_check"
            ? `PyPI has had no project named ${d.identifier} at any Lowdown check since ${firstDay} (checked ${checkedDay}).`
            : `PyPI has had no project named ${d.identifier} since ${since}; it existed before (checked ${checkedDay}).`
          : since === "first_check"
            ? `PyPI has returned 404 for ${d.identifier} at every Lowdown check since ${firstDay} (checked ${checkedDay}).`
            : `PyPI has returned 404 for ${d.identifier} since ${since}; it was available before (checked ${checkedDay}).`,
    );
  }
  pypi.project_status = projectStatus;
  if (projectStatus === "archived" || projectStatus === "quarantined" || projectStatus === "deprecated") facts.push(`PyPI lists the project ${d.identifier} as ${projectStatus} (checked ${checkedDay}).`);
  pypi.first_checked_at = isoOrNull(s.first_checked_at);
  pypi.checked_at = isoOrNull(s.checked_at);
  pypi.recent_events = recent;
  return { entry: { ...base, pypi }, facts };
}

async function attachPackages(supabase: any, ev: Evidence, declared: DeclaredPackage[], now: number, fromNpmInput: boolean): Promise<void> {
  const idents = [...new Set(declared.filter((d) => d.type === "npm" && d.identifier).map((d) => d.identifier as string))];
  const pypiIdents = [...new Set(declared.filter((d) => d.type === "pypi" && d.identifier).map((d) => normalizePypiName(d.identifier as string)))];
  try {
    let stateRows: any[] = [];
    let changeRows: any[] = [];
    if (idents.length > 0) {
      const [st, ch] = await Promise.all([
        supabase.from("npm_package_state").select("ident,status,latest,modified,deprecated,baseline,first_checked_at,checked_at").in("ident", idents),
        supabase.from("npm_package_changes").select("ident,detected_on,kind,old_value,new_value").in("ident", idents).order("detected_on", { ascending: false }).limit(200),
      ]);
      if (st.error) throw new Error("npm_package_state");
      stateRows = st.data ?? [];
      changeRows = ch.error ? [] : (ch.data ?? []);
    }
    // PyPI 조회 실패는 npm 쪽 응답을 막지 않는다(그 항목만 상태 없이).
    let pypiRows = { stateRows: [] as any[], changeRows: [] as any[] };
    let pypiFailed = false;
    if (pypiIdents.length > 0) {
      try {
        const [st, ch] = await Promise.all([
          supabase.from("pypi_package_state").select("ident,status,latest,latest_yanked,uploaded,project_status,index_status,baseline,first_checked_at,checked_at").in("ident", pypiIdents),
          supabase.from("pypi_package_changes").select("ident,detected_on,kind,old_value,new_value").in("ident", pypiIdents).order("detected_on", { ascending: false }).limit(200),
        ]);
        if (st.error) throw new Error("pypi_package_state");
        pypiRows = { stateRows: st.data ?? [], changeRows: ch.error ? [] : (ch.data ?? []) };
      } catch {
        pypiFailed = true;
      }
    }
    const shaped = shapePackages(declared, stateRows, changeRows, now, fromNpmInput, pypiRows);
    if (pypiFailed) {
      // PyPI 상태를 읽지 못함 → 해당 항목은 선언만(상태 블록 없이)
      shaped.packages = shaped.packages.map((p) => (p.registry === "pypi" && p.name !== null ? { registry: "pypi", name: p.name, ...("declared_version" in p ? { declared_version: p.declared_version } : {}) } : p));
    }
    ev.packages = shaped.packages;
    ev.packageFacts = shaped.facts;
  } catch {
    // npm 상태 조회 실패 → 선언 목록만(상태 없이)
    ev.packages = declared.map((d) => ({ registry: d.type, name: d.identifier, ...(fromNpmInput ? {} : { declared_version: d.version }) }));
  }
}

// ── stdio 샌드박스 (runner: sandbox/, 요약: sandbox_summary) ─────────────────
// 기본 꺼짐: SANDBOX_PUBLIC=1 이고 DB 에서 sandbox_summary 읽기가 열려 있을 때만 응답에 붙는다(supabase/2026-10-26_sandbox_summary.sql).
// 값은 허용 목록으로 걸러 낸다. 도구 이름·정의·표준오류·인자는 요약에 없다.
export const SANDBOX_OUTCOMES = new Set([
  "ok", "install_not_found", "install_version_not_found", "install_failed", "install_timeout", "install_network",
  "no_bin", "bin_ambiguous", "exited", "init_timeout", "init_error", "init_invalid",
  "list_timeout", "list_error", "list_invalid", "exited_after_init", "output_limit", "runner_error",
]);
const SANDBOX_NOTE =
  "One start of the declared stdio package in an isolated container with no network, no credentials and no environment variables; only initialize and tools/list were sent, no tool was called. `outcome` and `reached_level` (0 = no initialize answer, 1 = initialize, 2 = tools/list) say how far it answered under those conditions. A server that needs configuration or network at startup records that, so this is not a judgment of the package. `install_scripts` true means the package declares install scripts, which were not run.";

/** 선언 패키지 × sandbox_summary 행 → 응답 블록. 선언 버전과 같거나 npm 최신으로 돌린 행만, 패키지당 최근 2개. */
export function shapeSandbox(declared: DeclaredPackage[], rows: ReadonlyArray<Record<string, any>>): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  const byIdent = new Map<string, DeclaredPackage[]>();
  for (const d of declared) if (d.type === "npm" && d.identifier) byIdent.set(d.identifier, [...(byIdent.get(d.identifier) ?? []), d]);
  for (const [ident, decls] of byIdent) {
    const mine = rows
      .filter((r) => r.ident === ident && typeof r.version === "string" && SAFE_VERSION_OUT.test(r.version) && SANDBOX_OUTCOMES.has(r.outcome) && [0, 1, 2].includes(r.reached_level))
      .filter((r) => decls.some((d) => d.version === r.version) || (Array.isArray(r.sources) && r.sources.includes("npm_latest")))
      .sort((a, b) => (String(a.observed_at) < String(b.observed_at) ? 1 : -1))
      .slice(0, 2);
    for (const r of mine) {
      out.push({
        registry: "npm",
        name: ident,
        version: r.version,
        tested_as: (Array.isArray(r.sources) ? r.sources : []).filter((x: unknown) => x === "declared" || x === "npm_latest"),
        outcome: r.outcome,
        reached_level: r.reached_level,
        tool_count: Number.isInteger(r.tool_count) ? r.tool_count : null,
        install_scripts: r.install_scripts === true,
        observed_at: r.observed_at,
        runner_version: typeof r.runner_version === "string" && SAFE_VERSION_OUT.test(r.runner_version) ? r.runner_version : null,
      });
    }
  }
  return out;
}
const SAFE_VERSION_OUT = /^[0-9A-Za-z.+-]{1,80}$/;

async function attachSandbox(supabase: any, ev: Evidence, declared: DeclaredPackage[]): Promise<void> {
  if (process.env.SANDBOX_PUBLIC !== "1") return;
  const idents = [...new Set(declared.filter((d) => d.type === "npm" && d.identifier).map((d) => d.identifier as string))];
  if (idents.length === 0) return;
  try {
    const r = await supabase.from("sandbox_summary").select("ident,version,sources,outcome,reached_level,tool_count,install_scripts,runner_version,observed_at").eq("registry_type", "npm").in("ident", idents).order("observed_at", { ascending: false }).limit(60);
    if (r.error) return;
    const shaped = shapeSandbox(declared, r.data ?? []);
    if (shaped.length > 0) ev.sandbox = shaped;
  } catch {
    // 샌드박스 요약 조회 실패 → 블록 없이 계속
  }
}

/** 입력에 글자 그대로의 이스케이프(\n, < 등)가 있으면 그 사실만 알린다. 입력은 고치지 않는다. */
export function escapeNote(target: string): string | null {
  const m = target.match(/\\(?:u[0-9A-Fa-f]{4}|[nrt"\\/])/);
  return m ? `The target contains a literal escape sequence (${m[0]}); it was looked up as given.` : null;
}
