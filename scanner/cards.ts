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
//   CARD_FULL=1    이어 만들기 판단 없이 전체를 다시 만든다(수동 점검용)
//   CARD_TIME_BUDGET_MIN  이 분이 지나면 새 대상을 집지 않고 만든 것만 저장한 뒤 정상 종료(비우면 상한 없음).
//                  남은 대상은 다음 실행이 이어 간다 — 매시 짧게 나눠 돌리기(2026-11-12, cards.yml·cards-am 타이머)
//
// 이어 만들기 (2026-11-12): 대상 39,304개(순환 관찰 뒤)가 150분 안에 끝나지 않아 취소 → 다음 실행이 처음부터 다시 돌며
// DB 를 몇 시간씩 누름(57014). 이제 오늘 쓸 수 있는 카드(cardUsable)가 있고 요약 값이 그대로면 건너뛴다(needsBuild).
// → 취소돼도 다음 실행이 멈춘 곳부터 이어 가고, 오후 실행은 오전 뒤 요약이 바뀐 대상만 만든다.

import { fetchRetry } from "./rest-retry.ts";
import { needsBuild, type CardRow, type SummaryRow } from "./cards-resume.ts";

process.env.LOWDOWN_CARD_BUILD = "1";
const BASE = process.env.LOWDOWN_SUPABASE_URL ?? "";
const KEY = process.env.LOWDOWN_SCANNER_KEY ?? "";
// 핸들러는 LOWDOWN_SUPABASE_KEY 로 읽는다 → 같은 키를 넘긴다(읽기만)
process.env.LOWDOWN_SUPABASE_KEY = process.env.LOWDOWN_SUPABASE_KEY || KEY;
const LIMIT = Number(process.env.CARD_LIMIT || 0) || 0;
const CONCURRENCY = Math.max(1, Math.min(16, Number(process.env.CARD_CONCURRENCY || 6) || 6));
const DRY = process.env.DRY_RUN === "1";
const SKIP_IF_DONE = process.env.SKIP_IF_DONE === "1";
const FULL = process.env.CARD_FULL === "1";
/** upsert 한 번에 쓰는 카드 수. search_text GIN trgm 인덱스 때문에 200개 묶음이 57014(2026-11-11) → 50 */
export const UPSERT_BATCH = 50;
const BUDGET_MIN = Math.max(0, Number(process.env.CARD_TIME_BUDGET_MIN || 0) || 0);

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
export const BUILDER_VERSION = "cards-3";
const NAME_RE = /^[A-Za-z0-9._~-]{1,200}\/[A-Za-z0-9._~-]{1,200}$/;

if (!BASE || !KEY) {
  console.error("LOWDOWN_SUPABASE_URL / LOWDOWN_SCANNER_KEY 가 없습니다");
  process.exit(1);
}

const headers = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };

/** target_id 순 keyset 으로 전부 읽는다(둘 다 target_id 고유 인덱스). 5xx 는 fetchRetry 로 재시도. */
async function readAllByTarget<T extends { target_id: string }>(table: string, select: string): Promise<T[]> {
  const out: T[] = [];
  let after: string | null = null;
  for (;;) {
    const gt = after === null ? "" : `&target_id=gt.${encodeURIComponent(after)}`;
    const url = `${BASE}/rest/v1/${table}?select=${select}&order=target_id.asc&limit=1000${gt}`;
    const r = await fetchRetry(url, () => ({ headers }), `${table} read`);
    const rows = (await r.json()) as T[];
    out.push(...rows);
    if (rows.length < 1000) break;
    after = rows[rows.length - 1]!.target_id;
  }
  return out;
}

async function listTargets(): Promise<SummaryRow[]> {
  const rows = await readAllByTarget<SummaryRow>(
    "target_status_summary",
    "target_id,latest_day,latest_state,observed_days_30d,answered_days_30d,streak_days",
  );
  return rows.filter((x) => typeof x.target_id === "string" && x.target_id.startsWith("mcp:") && NAME_RE.test(x.target_id.slice(4)));
}

async function listCards(): Promise<Map<string, CardRow>> {
  const rows = await readAllByTarget<CardRow>(
    "server_cards",
    "target_id,built_at,builder_version,latest_day,latest_state,observed_days_30d,answered_days_30d,consecutive_days",
  );
  return new Map(rows.map((r) => [r.target_id, r]));
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
  const toolNames = toolNamesOf(scanner);
  return {
    latest_state: typeof status?.state === "string" ? status.state : null,
    latest_day: isoDay(status?.latest_check),
    last_definition_change_day: defDays.length ? defDays[defDays.length - 1] : null,
    tool_count: int(status?.tool_count) ?? int(scanner?.tools?.count),
    package_flag: packageFlag,
    registry_status: typeof body.registry?.status === "string" ? body.registry.status : null,
    observation_basis: basis === "fixed_cohort" || basis === "on_request" || basis === "rotating" ? basis : null,
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
    // find does= (하는 일로 찾기)용 (cards-3, 2026-11-02): 공개된 값만 — Registry 이름 + 마지막 관측 도구 이름. 도구 설명 원문은 넣지 않는다.
    tool_names: toolNames,
    search_text: searchText(typeof body.resolved_target === "string" ? body.resolved_target : typeof body.target === "string" ? body.target : "", toolNames),
  };
}

/** 마지막 관측 도구 이름 (최대 TOOL_NAMES_MAX개, 형식 밖 값은 버림) */
export const TOOL_NAMES_MAX = 500;
export function toolNamesOf(scanner: any): string[] | null {
  const names: unknown[] = Array.isArray(scanner?.tools?.names) ? scanner.tools.names : [];
  const out = names.filter((n): n is string => typeof n === "string" && n.length > 0 && n.length <= 128).slice(0, TOOL_NAMES_MAX);
  return out.length ? out : null;
}

/** 검색 문자열: 소문자 이름 + 도구 이름 (공백 구분). 길이 상한 20,000자. */
export function searchText(target: string, toolNames: string[] | null): string | null {
  const name = target.replace(/^mcp:/, "");
  const parts = [name, ...(toolNames ?? [])].filter((x) => x.length > 0);
  return parts.length ? parts.join(" ").toLowerCase().slice(0, 20_000) : null;
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
  let summary = await listTargets();
  if (LIMIT) summary = summary.slice(0, LIMIT);
  if (SKIP_IF_DONE) {
    const since = slotStart(Date.now());
    const done = await builtSince(since);
    if (done !== null && done >= summary.length * 0.9) {
      console.log(`skip: ${done}/${summary.length} cards already built since ${new Date(since).toISOString()}`);
      return;
    }
  }
  const cards = FULL ? new Map<string, CardRow>() : await listCards();
  const now0 = Date.now();
  const targets = summary.filter((s) => FULL || needsBuild(s, cards.get(s.target_id), now0, BUILDER_VERSION)).map((s) => s.target_id);
  const dataDay = new Date().toISOString().slice(0, 10);
  console.log(`targets ${targets.length} to build / ${summary.length} total (fresh ${summary.length - targets.length}), concurrency ${CONCURRENCY}, data_day ${dataDay}${FULL ? ", full" : ""}${DRY ? ", dry run" : ""}`);

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
  const deadline = BUDGET_MIN ? t0 + BUDGET_MIN * 60_000 : Infinity;
  let budgetHit = false;
  const worker = async () => {
    while (next < targets.length) {
      if (Date.now() >= deadline) { budgetHit = true; break; }
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
        if (batch.length >= UPSERT_BATCH) await flush();
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
  const remaining = targets.length - next;
  if (budgetHit) console.log(`time budget ${BUDGET_MIN} min reached: ${remaining} target(s) left for the next run`);
  console.log(JSON.stringify({ ...stats, remaining, skipped_by: skippedCodes, avg_bytes: stats.built ? Math.round(stats.bytes / stats.built) : 0, seconds: sec }));
  // 이번 실행에서 다룬 대상의 절반 넘게 실패하면 실패로 끝낸다(이슈 알림). 시간 상한으로 남긴 대상은 실패가 아니다.
  const handled = stats.built + stats.skipped + stats.failed;
  if (handled > 0 && stats.failed > handled / 2) process.exit(1);
}

await main();
