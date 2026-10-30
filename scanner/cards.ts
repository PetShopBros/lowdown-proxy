// 서버 카드 조리 (2026-10-30, 2단계 주방). supabase/2026-10-30_server_cards.sql
// 하루 2번(cards.yml, 연결 상태 요약 갱신 UTC 03:37·14:37 뒤) 관찰 중인 서버마다 조회 API 응답 전체를 미리 만들어 server_cards 에 덮어쓴다.
// 판정 로직을 새로 만들지 않는다: api/reputation/[target].ts 의 핸들러를 그대로 불러 같은 응답을 만든다(테스트와 같은 방식).
// 이 실행의 조회는 reputation_lookups 에 남기지 않는다(LOWDOWN_CARD_BUILD=1, 핸들러가 확인).
// 원본 관측 데이터는 건드리지 않는다. 카드는 파생물이라 매일 덮어쓴다.
//
// 환경 변수:
//   LOWDOWN_SUPABASE_URL, LOWDOWN_SCANNER_KEY(쓰기, service_role)
//   CARD_LIMIT     앞에서 N개만 (비우면 전체)
//   CARD_CONCURRENCY 동시 조리 수 (기본 6)
//   DRY_RUN=1      DB 에 쓰지 않고 요약만 출력
//   SKIP_IF_DONE=1 이번 시간대(UTC 04:00~ / 15:00~)에 만든 카드가 대상의 90% 이상이면 건너뛴다
//                  (서버 dispatch 로 정시에 이미 돈 날, 늦게 도는 GitHub 예약 실행이 같은 일을 반복하지 않게 — cards.yml 이 schedule 일 때 켠다)

process.env.LOWDOWN_CARD_BUILD = "1";
const BASE = process.env.LOWDOWN_SUPABASE_URL ?? "";
const KEY = process.env.LOWDOWN_SCANNER_KEY ?? "";
// 핸들러는 LOWDOWN_SUPABASE_KEY 로 읽는다 → 같은 키를 넘긴다(읽기만)
process.env.LOWDOWN_SUPABASE_KEY = process.env.LOWDOWN_SUPABASE_KEY || KEY;
const LIMIT = Number(process.env.CARD_LIMIT || 0) || 0;
const CONCURRENCY = Math.max(1, Math.min(16, Number(process.env.CARD_CONCURRENCY || 6) || 6));
const DRY = process.env.DRY_RUN === "1";
const SKIP_IF_DONE = process.env.SKIP_IF_DONE === "1";

/** 지금이 속한 조리 시간대의 시작(UTC 04:00 또는 15:00, 그 전이면 전날 15:00). */
export function slotStart(now: number): number {
  const d = new Date(now);
  const day = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const am = day + 4 * 3_600_000;
  const pm = day + 15 * 3_600_000;
  if (now >= pm) return pm;
  if (now >= am) return am;
  return pm - 86_400_000;
}

async function builtSince(since: number): Promise<number | null> {
  const r = await fetch(`${BASE}/rest/v1/server_cards?select=target_id&built_at=gte.${encodeURIComponent(new Date(since).toISOString())}`, {
    headers: { ...headers, Prefer: "count=exact", Range: "0-0", "Range-Unit": "items" },
  });
  if (!r.ok) return null;
  const m = /\/(\d+)$/.exec(r.headers.get("content-range") ?? "");
  return m ? Number(m[1]) : null;
}
export const BUILDER_VERSION = "cards-2";
const NAME_RE = /^[A-Za-z0-9._~-]{1,200}\/[A-Za-z0-9._~-]{1,200}$/;

if (!BASE || !KEY) {
  console.error("LOWDOWN_SUPABASE_URL / LOWDOWN_SCANNER_KEY 가 없습니다");
  process.exit(1);
}

const headers = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };

async function listTargets(): Promise<string[]> {
  const out: string[] = [];
  for (let from = 0; ; from += 1000) {
    const r = await fetch(`${BASE}/rest/v1/target_status_summary?select=target_id&order=target_id.asc`, {
      headers: { ...headers, Range: `${from}-${from + 999}`, "Range-Unit": "items" },
    });
    if (!r.ok) throw new Error(`target_status_summary ${r.status}`);
    const rows = (await r.json()) as Array<{ target_id: string }>;
    for (const x of rows) if (typeof x.target_id === "string" && x.target_id.startsWith("mcp:") && NAME_RE.test(x.target_id.slice(4))) out.push(x.target_id);
    if (rows.length < 1000) break;
  }
  return out;
}

const isoDay = (v: unknown): string | null => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null);
const int = (v: unknown): number | null => (Number.isInteger(v) && (v as number) >= 0 ? (v as number) : null);
const DEF_KINDS = new Set(["schema_changed", "description_changed", "tool_names_changed"]);
const PYPI_BAD = new Set(["quarantined", "archived", "deprecated"]);

/** 응답 → 검색용 열 (find 가 쓴다). 값이 형식에 맞지 않으면 null. */
export function cardColumns(body: Record<string, any>) {
  const status = body.status && typeof body.status === "object" ? body.status : null;
  const scanner = body.scanner && typeof body.scanner === "object" ? body.scanner : null;
  const events: any[] = Array.isArray(scanner?.definition_changes?.events) ? scanner.definition_changes.events : [];
  const defDays = events.filter((e) => Array.isArray(e?.kinds) && e.kinds.some((k: unknown) => DEF_KINDS.has(String(k)))).map((e) => isoDay(e.day)).filter((d): d is string => d !== null).sort();
  const pkgs: any[] = Array.isArray(body.packages) ? body.packages : [];
  const packageFlag = pkgs.length === 0 ? null : pkgs.some((p) =>
    p?.npm?.status === "not_found" || p?.npm?.latest_deprecated === true ||
    p?.pypi?.status === "not_found" || p?.pypi?.latest_yanked === true || PYPI_BAD.has(String(p?.pypi?.project_status)));
  const basis = status?.observation_basis ?? scanner?.observation_basis;
  const registry = body.registry && typeof body.registry === "object" ? body.registry : null;
  const checks = status?.checks_30d && typeof status.checks_30d === "object" ? status.checks_30d : null;
  const lastDay = (xs: Array<string | null>): string | null => {
    const ds = xs.filter((d): d is string => d !== null).sort();
    return ds.length ? ds[ds.length - 1]! : null;
  };
  const regChanges: any[] = Array.isArray(registry?.changes_30d) ? registry.changes_30d : [];
  return {
    latest_state: typeof status?.state === "string" ? status.state : null,
    latest_day: isoDay(status?.latest_check),
    last_definition_change_day: defDays.length ? defDays[defDays.length - 1] : null,
    tool_count: int(status?.tool_count) ?? int(scanner?.tools?.count),
    package_flag: packageFlag,
    registry_status: typeof body.registry?.status === "string" ? body.registry.status : null,
    observation_basis: basis === "fixed_cohort" || basis === "on_request" ? basis : null,
    // find 조건·정렬용 (cards-2, 2026-10-31)
    answered_days_30d: int(checks?.answered),
    observed_days_30d: int(checks?.observed),
    consecutive_days: int(status?.consecutive_days),
    consecutive_since: isoDay(status?.consecutive_since),
    tool_set_since: isoDay(scanner?.tools?.set_first_observed_at),
    registry_first_day: isoDay(registry?.first_recorded_at),
    registry_baseline: typeof registry?.recorded_since_baseline === "boolean" ? registry.recorded_since_baseline : null,
    registry_last_change_day: lastDay(regChanges.map((c) => isoDay(c?.on))),
    package_updated_day: lastDay(pkgs.map((p) => isoDay(p?.npm?.modified) ?? isoDay(p?.pypi?.latest_uploaded))),
  };
}

function fakeRes() {
  const r = {
    code: 0,
    body: undefined as unknown,
    headers: {} as Record<string, string>,
    setHeader(k: string, v: unknown) { r.headers[k.toLowerCase()] = String(v); return r; },
    status(c: number) { r.code = c; return r; },
    json(b: unknown) { r.body = b; return r; },
    send(b: unknown) { r.body = b; return r; },
    end() { return r; },
  };
  return r;
}

async function main() {
  const t0 = Date.now();
  const { default: handler } = (await import("../api/reputation/[target].ts" as string)) as { default: (req: unknown, res: unknown) => Promise<unknown> };
  let targets = await listTargets();
  if (LIMIT) targets = targets.slice(0, LIMIT);
  if (SKIP_IF_DONE) {
    const since = slotStart(Date.now());
    const done = await builtSince(since);
    if (done !== null && done >= targets.length * 0.9) {
      console.log(`skip: ${done}/${targets.length} cards already built since ${new Date(since).toISOString()}`);
      return;
    }
  }
  const dataDay = new Date().toISOString().slice(0, 10);
  console.log(`targets ${targets.length}, concurrency ${CONCURRENCY}, data_day ${dataDay}${DRY ? ", dry run" : ""}`);

  const stats = { built: 0, skipped: 0, failed: 0, bytes: 0, written: 0 };
  const skippedCodes: Record<string, number> = {};
  let batch: Array<Record<string, unknown>> = [];

  const flush = async () => {
    if (batch.length === 0) return;
    const rows = batch;
    batch = [];
    if (DRY) { stats.written += rows.length; return; }
    for (let attempt = 1; ; attempt++) {
      const r = await fetch(`${BASE}/rest/v1/server_cards?on_conflict=target_id`, {
        method: "POST",
        headers: { ...headers, Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify(rows),
      });
      if (r.ok) { stats.written += rows.length; return; }
      const text = (await r.text()).slice(0, 300);
      if (attempt >= 3) throw new Error(`server_cards upsert ${r.status}: ${text}`);
      await new Promise((ok) => setTimeout(ok, 2000 * attempt));
    }
  };

  let next = 0;
  const worker = async () => {
    while (next < targets.length) {
      const targetId = targets[next++]!;
      try {
        const res = fakeRes();
        await handler({ method: "GET", query: { target: targetId }, headers: { "user-agent": `lowdown-card-builder/${BUILDER_VERSION}` } }, res);
        const body = res.body as Record<string, any> | undefined;
        // 200 이고 Registry 이름이 확인된 응답만 카드로. 503(읽기 실패)·그 밖은 건너뛴다 → 그 서버는 API 가 실시간 계산.
        if (res.code !== 200 || !body || typeof body !== "object" || body.registry?.listed !== true) {
          stats.skipped++;
          const k = res.code !== 200 ? String(res.code) : "not_listed";
          skippedCodes[k] = (skippedCodes[k] ?? 0) + 1;
          continue;
        }
        const json = JSON.stringify(body);
        stats.bytes += json.length;
        stats.built++;
        batch.push({
          target_id: targetId,
          name: targetId.slice(4),
          body,
          ...cardColumns(body),
          data_day: dataDay,
          built_at: new Date().toISOString(),
          builder_version: BUILDER_VERSION,
          // 핸들러가 계산한 응답 종류(조회 기록의 result_kind 와 같은 값)
          result_kind: res.headers["x-lowdown-result-kind"] ?? null,
        });
        if (batch.length >= 200) await flush();
      } catch (err) {
        stats.failed++;
        if (stats.failed <= 5) console.error("card failed", targetId, err);
      }
      if ((stats.built + stats.skipped + stats.failed) % 200 === 0) console.log(`progress ${stats.built + stats.skipped + stats.failed}/${targets.length}`);
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  await flush();

  const sec = Math.round((Date.now() - t0) / 1000);
  console.log(JSON.stringify({ ...stats, skipped_by: skippedCodes, avg_bytes: stats.built ? Math.round(stats.bytes / stats.built) : 0, seconds: sec }));
  // 절반 넘게 실패하면 실패로 끝낸다(이슈 알림)
  if (targets.length > 0 && stats.failed > targets.length / 2) process.exit(1);
}

await main();
