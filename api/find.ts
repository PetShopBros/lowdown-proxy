import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";

// find: 조건 검색 (2026-10-31). 미리 만든 서버 카드(server_cards, supabase/2026-10-31_server_cards_find.sql)를 한 번 읽는다.
// 점수·순위 없음: 고른 조건으로 거르고, 고른 키로 정렬한다. 결과마다 정렬 기준값과 근거값을 같이 낸다.
// 조회 수(demand) 정렬은 넣지 않는다. 응답에 지시문을 넣지 않는다.
// 다른 API 함수 파일을 import 하지 않는다(배포 빌드·node --test 확장자 규칙 차이) → 필요한 상수는 여기 따로 둔다.

const BASE_URL = "https://lowdown-proxy.vercel.app";
const BULK_DATA_LINK = '<https://github.com/PetShopBros/lowdown-data>; rel="related"; title="Daily dataset for bulk use (CC BY 4.0)"';
const DAY_MS = 86_400_000;
/** 마지막 점검이 이보다 오래되면 상태 조건에 넣지 않는다 (조회 API 의 STATUS_STALE_DAYS 와 같은 값) */
export const STALE_DAYS = 2;
export const MAX_LIMIT = 50;
export const MAX_OFFSET = 2000;

export const STATES = ["answered", "auth_required", "list_failed", "no_response", "invalid_response", "mixed"] as const;
export const REGISTRY_STATUSES = ["active", "deprecated"] as const;
export const PACKAGE_FILTERS = ["ok", "flagged", "none"] as const;

// 정렬 키 → 열, 기본 방향
export const SORTS: Record<string, { column: string; dir: "asc" | "desc"; meaning: string }> = {
  name: { column: "name", dir: "asc", meaning: "Registry name" },
  newest: { column: "registry_first_day", dir: "desc", meaning: "day Lowdown first recorded the Registry entry (baseline entries carry the baseline day, not a listing date)" },
  updated: { column: "registry_last_change_day", dir: "desc", meaning: "latest Registry change in the last 30 days" },
  tools: { column: "tool_count", dir: "desc", meaning: "tool count on the latest answered check" },
  stable: { column: "tool_set_since", dir: "asc", meaning: "day the current tool list was first observed (earlier = unchanged for longer)" },
  answering: { column: "answered_days_30d", dir: "desc", meaning: "daily checks in the last 30 days that answered tools/list" },
  changed: { column: "last_definition_change_day", dir: "desc", meaning: "latest observed change in tool schemas, descriptions or names" },
  release: { column: "package_updated_day", dir: "desc", meaning: "latest npm modified / PyPI upload day among declared packages" },
};

const COLUMNS =
  "name,latest_state,latest_day,tool_count,answered_days_30d,observed_days_30d,consecutive_days,consecutive_since," +
  "tool_set_since,last_definition_change_day,registry_status,registry_first_day,registry_baseline,registry_last_change_day," +
  "package_flag,package_updated_day,observation_basis,built_at";

const Q_RE = /^[A-Za-z0-9._~\-/]{2,100}$/;

export type FindQuery = {
  q: string | null;
  state: (typeof STATES)[number] | null;
  answered_days: number | null;
  stable_days: number | null;
  tools_min: number | null;
  tools_max: number | null;
  registry: (typeof REGISTRY_STATUSES)[number] | null;
  package: (typeof PACKAGE_FILTERS)[number] | null;
  sort: string;
  order: "asc" | "desc";
  limit: number;
  offset: number;
};

type Parsed = { ok: true; query: FindQuery } | { ok: false; body: Record<string, unknown> };

const one = (v: unknown): string | undefined => (Array.isArray(v) ? (typeof v[0] === "string" ? v[0] : undefined) : typeof v === "string" ? v : undefined);

/** 쿼리 문자열 → 검색 조건. 모르는 값은 400 + 허용 값. */
export function parseFind(raw: Record<string, unknown>): Parsed {
  const bad = (param: string, allowed: string) => ({ ok: false as const, body: { error: "invalid_parameter", parameter: param, allowed, parameters: PARAMETERS } });
  const intIn = (name: string, min: number, max: number): number | null | "bad" => {
    const s = one(raw[name]);
    if (s === undefined || s === "") return null;
    if (!/^\d{1,5}$/.test(s)) return "bad";
    const n = Number(s);
    return n >= min && n <= max ? n : "bad";
  };

  const qRaw = one(raw.q)?.trim();
  if (qRaw && !Q_RE.test(qRaw)) return bad("q", "2-100 characters: letters, digits, . _ ~ - /");
  const q = qRaw ? qRaw : null;

  let state = one(raw.state) ?? null;
  if (state && !(STATES as readonly string[]).includes(state)) return bad("state", STATES.join(", "));
  const noAuth = one(raw.no_auth);
  if (noAuth !== undefined && noAuth !== "" && noAuth !== "1" && noAuth !== "true") return bad("no_auth", "1");
  if (noAuth === "1" || noAuth === "true") {
    if (state && state !== "answered") return bad("no_auth", "no_auth=1 means state=answered; do not combine with another state");
    state = "answered";
  }

  const answered = intIn("answered_days", 1, 30);
  if (answered === "bad") return bad("answered_days", "1-30");
  const stable = intIn("stable_days", 1, 3650);
  if (stable === "bad") return bad("stable_days", "1-3650");
  const tmin = intIn("tools_min", 0, 10000);
  if (tmin === "bad") return bad("tools_min", "0-10000");
  const tmax = intIn("tools_max", 0, 10000);
  if (tmax === "bad") return bad("tools_max", "0-10000");

  const registry = one(raw.registry) ?? null;
  if (registry && !(REGISTRY_STATUSES as readonly string[]).includes(registry)) return bad("registry", REGISTRY_STATUSES.join(", "));
  const pkg = one(raw.package) ?? null;
  if (pkg && !(PACKAGE_FILTERS as readonly string[]).includes(pkg)) return bad("package", PACKAGE_FILTERS.join(", "));

  const sort = one(raw.sort) || "name";
  if (!SORTS[sort]) return bad("sort", Object.keys(SORTS).join(", "));
  const orderRaw = one(raw.order);
  if (orderRaw && orderRaw !== "asc" && orderRaw !== "desc") return bad("order", "asc, desc");
  const order = (orderRaw as "asc" | "desc" | undefined) ?? SORTS[sort]!.dir;

  const limit = intIn("limit", 1, MAX_LIMIT);
  if (limit === "bad") return bad("limit", `1-${MAX_LIMIT}`);
  const offset = intIn("offset", 0, MAX_OFFSET);
  if (offset === "bad") return bad("offset", `0-${MAX_OFFSET}`);

  return {
    ok: true,
    query: {
      q,
      state: state as FindQuery["state"],
      answered_days: answered,
      stable_days: stable,
      tools_min: tmin,
      tools_max: tmax,
      registry: registry as FindQuery["registry"],
      package: pkg as FindQuery["package"],
      sort,
      order,
      limit: limit ?? 20,
      offset: offset ?? 0,
    },
  };
}

/** 기록·캐시용 정규화 문자열 (같은 조건 = 같은 문자열). 기본값은 넣지 않는다. */
export function canonical(f: FindQuery): string {
  const p = new URLSearchParams();
  if (f.q) p.set("q", f.q);
  if (f.state) p.set("state", f.state);
  if (f.answered_days !== null) p.set("answered_days", String(f.answered_days));
  if (f.stable_days !== null) p.set("stable_days", String(f.stable_days));
  if (f.tools_min !== null) p.set("tools_min", String(f.tools_min));
  if (f.tools_max !== null) p.set("tools_max", String(f.tools_max));
  if (f.registry) p.set("registry", f.registry);
  if (f.package) p.set("package", f.package);
  if (f.sort !== "name") p.set("sort", f.sort);
  if (f.order !== SORTS[f.sort]!.dir) p.set("order", f.order);
  if (f.limit !== 20) p.set("limit", String(f.limit));
  if (f.offset) p.set("offset", String(f.offset));
  return p.toString();
}

const utcDay = (t: number): string => new Date(t).toISOString().slice(0, 10);
const daysBefore = (now: number, n: number): string => utcDay(Date.parse(utcDay(now)) - n * DAY_MS);

const PARAMETERS = {
  q: "part of the Registry name (2-100 characters)",
  state: `latest daily check result: ${STATES.join(", ")} (only servers checked in the last ${STALE_DAYS} days)`,
  no_auth: "1 = same as state=answered (answered tools/list with no credentials)",
  answered_days: "minimum daily checks in the last 30 days that answered tools/list (1-30)",
  stable_days: "current tool list first observed at least this many days ago (1-3650); tool lists are recorded from 2026-10-20, so a longer period returns nothing yet",
  tools_min: "minimum tool count", tools_max: "maximum tool count",
  registry: `Registry status: ${REGISTRY_STATUSES.join(", ")}`,
  package: "ok = declared packages with no deprecated/yanked/quarantined/404 latest; flagged = at least one; none = no declared packages",
  sort: Object.keys(SORTS).join(", "),
  order: "asc, desc (default depends on sort)",
  limit: `1-${MAX_LIMIT} (default 20)`, offset: `0-${MAX_OFFSET}`,
};

const BASIS =
  "Filters and sorts Lowdown's prepared per-server cards, built twice a day from MCP Registry records, one daily check per server " +
  "(POST initialize, then tools/list; no tool calls, no credentials) and npm/PyPI metadata. No score or ranking: order is only the chosen sort key. " +
  "Null values sort last. Each result's lookup URL returns the full record.";

function getSupabase() {
  const url = process.env.LOWDOWN_SUPABASE_URL;
  const key = process.env.LOWDOWN_SUPABASE_KEY;
  if (!url || !key) throw new Error("Supabase env missing");
  return createClient(url, key, { auth: { persistSession: false } });
}

/** 카드 행 → 결과 1건 */
export function shapeResult(r: Record<string, any>, sortKey: string, now: number): Record<string, unknown> {
  const name = String(r.name);
  const [ns, ...rest] = name.split("/");
  const latest = typeof r.latest_day === "string" ? r.latest_day.slice(0, 10) : null;
  const stale = latest ? Date.parse(utcDay(now)) - Date.parse(latest) > STALE_DAYS * DAY_MS : null;
  return {
    name,
    sort_value: r[SORTS[sortKey]!.column] ?? null,
    state: stale === false ? r.latest_state ?? null : null,
    latest_check: latest,
    stale,
    tool_count: r.latest_state === "answered" ? r.tool_count ?? null : null,
    checks_30d: { observed: r.observed_days_30d ?? null, answered: r.answered_days_30d ?? null },
    consecutive_days: r.consecutive_days ?? null,
    consecutive_since: r.consecutive_since ?? null,
    tool_set_since: r.tool_set_since ?? null,
    last_definition_change: r.last_definition_change_day ?? null,
    registry: {
      status: r.registry_status ?? null,
      first_recorded: r.registry_first_day ?? null,
      recorded_since_baseline: r.registry_baseline ?? null,
      last_change_30d: r.registry_last_change_day ?? null,
    },
    packages: { flagged: r.package_flag ?? null, updated: r.package_updated_day ?? null },
    observation_basis: r.observation_basis ?? null,
    lookup: `${BASE_URL}/api/reputation/mcp:${name}`,
    page: `${BASE_URL}/servers/${ns}/${rest.join("/")}`,
  };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Link", BULK_DATA_LINK);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  // 캐시 규칙은 조회 API 와 같다: 실사용·검색 봇은 rewrite 가 nc=1 → no-store, 나머지는 6시간.
  res.setHeader("Cache-Control", req.query.nc === "1" ? "no-store" : "public, max-age=0, s-maxage=21600, stale-while-revalidate=86400");

  const parsed = parseFind(req.query as Record<string, unknown>);
  if (!parsed.ok) return res.status(400).json(parsed.body);
  const f = parsed.query;
  const now = Date.now();
  const refRaw = req.query.ref;
  const ref = typeof refRaw === "string" && /^[A-Za-z0-9._:-]{1,64}$/.test(refRaw) ? refRaw : null;
  const canon = canonical(f);

  try {
    const supabase = getSupabase();
    let qb: any = supabase.from("server_cards").select(COLUMNS, { count: "exact" });
    if (f.q) qb = qb.ilike("name", `%${f.q.replace(/[\\%_]/g, "\\$&")}%`);
    if (f.state) qb = qb.eq("latest_state", f.state).gte("latest_day", daysBefore(now, STALE_DAYS));
    if (f.answered_days !== null) qb = qb.gte("answered_days_30d", f.answered_days);
    if (f.stable_days !== null) qb = qb.lte("tool_set_since", daysBefore(now, f.stable_days));
    if (f.tools_min !== null) qb = qb.gte("tool_count", f.tools_min);
    if (f.tools_max !== null) qb = qb.lte("tool_count", f.tools_max);
    if (f.registry) qb = qb.eq("registry_status", f.registry);
    if (f.package === "ok") qb = qb.eq("package_flag", false);
    if (f.package === "flagged") qb = qb.eq("package_flag", true);
    if (f.package === "none") qb = qb.is("package_flag", null);
    const col = SORTS[f.sort]!.column;
    qb = qb.order(col, { ascending: f.order === "asc", nullsFirst: false });
    if (col !== "name") qb = qb.order("name", { ascending: true });
    qb = qb.range(f.offset, f.offset + f.limit - 1);

    const { data, error, count } = await qb;
    if (error) throw new Error("server_cards");
    const rows = (data ?? []) as Record<string, any>[];
    const built = rows.map((r) => String(r.built_at)).filter((s) => !Number.isNaN(Date.parse(s))).sort();

    // 조회 기록: target 은 정규화된 조건 문자열, menu='find'. 실패해도 응답은 그대로.
    await supabase.from("reputation_lookups").insert({
      requester: (req.headers["x-lowdown-actor"] as string) ?? null,
      target: `find?${canon}`.slice(0, 300),
      source: req.headers["x-lowdown-source"] === "seeded" ? "seeded" : "organic",
      user_agent: (req.headers["user-agent"] as string) ?? null,
      menu: "find",
      result_kind: rows.length ? "find_results" : "find_empty",
      ...(ref ? { ref } : {}),
    } as never);

    return res.status(200).json({
      query: canon || "(all)",
      sort: { key: f.sort, order: f.order, meaning: SORTS[f.sort]!.meaning },
      total: count ?? null,
      count: rows.length,
      offset: f.offset,
      ...(count !== null && f.offset + rows.length < count ? { next_offset: f.offset + rows.length } : {}),
      results: rows.map((r) => shapeResult(r, f.sort, now)),
      basis: BASIS,
      parameters: PARAMETERS,
      source: {
        cards_built: built.length ? { oldest: built[0], newest: built[built.length - 1] } : null,
        retrieved_at: new Date(now).toISOString(),
        license: "CC BY 4.0",
        license_url: "https://creativecommons.org/licenses/by/4.0/",
        cite: `Lowdown (https://github.com/PetShopBros/lowdown-data), retrieved ${utcDay(now)}, CC BY 4.0`,
      },
    });
  } catch {
    res.setHeader("Cache-Control", "no-store");
    return res.status(503).json({ error: "temporarily_unavailable", retry_after_seconds: 60 });
  }
}