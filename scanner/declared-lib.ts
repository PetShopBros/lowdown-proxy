// Registry 밖에서 선언된 엔드포인트 관찰 (declared) — 순수 계산 + DB 읽기
//   대상: lowdown_probe_targets_declared (supabase/2026-11-06_declared_targets.sql) — ERC-8004 등록 파일 등, Registry 가 아닌 곳이
//   선언한 MCP 엔드포인트. 출처를 고정하지 않는다: 공통 이름표 층(subject_links)에 declares_service 선이 생기면 다음 스캔부터 대상이 된다.
//   고정 코호트·조회 대상과 섞지 않는다: 관찰 행은 source = 'scanner_declared', target_id = 'endpoint:<정규화된 주소>'.
//   주소 기준이라 여러 에이전트가 같은 주소를 선언해도 하루 1번만 관찰한다. 누가 선언했는지는 이름표 층에 있다.
//   순서: 먼저 선언된 주소부터(first_declared_at, url) — 매일 같은 순서라, 상한에 걸려도 같은 주소들의 시계열이 이어진다.
//   상한: 하루 dailyCap, 한 호스트 hostCap(한 회사 서버에 주소가 몰려도 그쪽에 부담을 주지 않게). 넘는 주소는 다음에(버리지 않음).

import { capHost, supabaseHeaders, type SupabaseConfig } from './lib.ts';

export const DECLARED_SOURCE = 'scanner_declared';
export const DECLARED_VERSION = 'declared';
export const DEFAULT_DECLARED_DAILY_CAP = 500;
export const DEFAULT_DECLARED_HOST_CAP = 20;

export interface DeclaredTarget {
  url: string;
  host: string | null;
  probeable: boolean;
  sources: string[];
  first_declared_at: string | null;
}

export interface DeclaredPick {
  target_id: string;
  url: string;
  sources: string[];
}

/** DB 의 lowdown_norm_endpoint 와 같은 규칙: http(s)만, 소문자 scheme·host, 기본 포트 제거, 사용자 정보 거부, 끝 '/' 제거, query·fragment 제거. */
export function normEndpoint(u: string): string | null {
  const m = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/?#]+)([^?#]*)/.exec(u.trim());
  if (!m) return null;
  const [, rawSch = '', rawAuth = '', path = ''] = m;
  const sch = rawSch.toLowerCase();
  let auth = rawAuth.toLowerCase();
  if ((sch !== 'http' && sch !== 'https') || auth.includes('@')) return null;
  auth = sch === 'https' ? auth.replace(/:443$/, '') : auth.replace(/:80$/, '');
  if (!auth) return null;
  return `${sch}://${auth}${path.replace(/\/+$/, '')}`;
}

export function endpointTargetId(url: string): string {
  return `endpoint:${url}`;
}

export interface DeclaredPickOptions {
  /** 이번 실행에서 이미 관찰하는 주소(정규화된 값) — 고정 코호트·조회 대상의 원격 주소 */
  excludeUrls: ReadonlySet<string>;
  dailyCap: number;
  hostCap: number;
}

export function pickDeclared(
  targets: readonly DeclaredTarget[],
  o: DeclaredPickOptions,
): { picks: DeclaredPick[]; eligible: number; skippedByHostCap: number; deferred: number; alreadyObserved: number } {
  const sorted = [...targets].sort(
    (a, b) => (a.first_declared_at ?? '9999').localeCompare(b.first_declared_at ?? '9999') || a.url.localeCompare(b.url),
  );
  const seen = new Set<string>();
  const perHost = new Map<string, number>();
  const picks: DeclaredPick[] = [];
  let eligible = 0;
  let skippedByHostCap = 0;
  let deferred = 0;
  let alreadyObserved = 0;
  for (const t of sorted) {
    if (!t.probeable) continue;
    const url = normEndpoint(t.url);
    if (!url || !url.startsWith('https://') || seen.has(url)) continue;
    seen.add(url);
    if (o.excludeUrls.has(url)) {
      alreadyObserved++;
      continue;
    }
    eligible++;
    const host = capHost(url) ?? url;
    const n = perHost.get(host) ?? 0;
    if (n >= o.hostCap) {
      skippedByHostCap++;
      continue;
    }
    if (picks.length >= o.dailyCap) {
      deferred++;
      continue;
    }
    perHost.set(host, n + 1);
    picks.push({ target_id: endpointTargetId(url), url, sources: [...t.sources].sort() });
  }
  return { picks, eligible, skippedByHostCap, deferred, alreadyObserved };
}

export interface DeclaredDeps {
  fetchImpl?: typeof fetch;
  pageSize?: number;
}

/** 관찰 가능한 선언 주소 전부(페이지 읽기). 읽기 실패는 throw — 호출한 쪽이 이 줄만 건너뛴다. */
export async function fetchDeclaredTargets(cfg: SupabaseConfig, deps: DeclaredDeps = {}): Promise<DeclaredTarget[]> {
  const f = deps.fetchImpl ?? fetch;
  const pageSize = deps.pageSize ?? 1000;
  const out: DeclaredTarget[] = [];
  for (let offset = 0; ; offset += pageSize) {
    const qs = new URLSearchParams({
      select: 'url,host,probeable,sources,first_declared_at',
      probeable: 'is.true',
      order: 'first_declared_at.asc,url.asc',
      limit: String(pageSize),
      offset: String(offset),
    });
    let res: Response;
    try {
      res = await f(`${cfg.url.replace(/\/+$/, '')}/rest/v1/lowdown_probe_targets_declared?${qs.toString()}`, {
        headers: supabaseHeaders(cfg.key, { Accept: 'application/json' }),
        signal: AbortSignal.timeout(60_000),
      });
    } catch {
      throw new Error('declared read failed: network');
    }
    if (!res.ok) throw new Error(`declared read failed: HTTP ${res.status}`);
    const rows = (await res.json()) as Array<Record<string, unknown>>;
    if (!Array.isArray(rows)) throw new Error('declared read failed: unexpected response');
    for (const r of rows) {
      if (typeof r.url !== 'string') continue;
      out.push({
        url: r.url,
        host: typeof r.host === 'string' ? r.host : null,
        probeable: r.probeable === true,
        sources: Array.isArray(r.sources) ? r.sources.filter((s): s is string => typeof s === 'string') : [],
        first_declared_at: typeof r.first_declared_at === 'string' ? r.first_declared_at : null,
      });
    }
    if (rows.length < pageSize) break;
  }
  return out;
}
