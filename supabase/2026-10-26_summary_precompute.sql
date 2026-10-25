-- 2026-10-26: 조회가 몰려도 DB 가 포화되지 않게 — Supabase SQL Editor 에서 실행, 여러 번 실행해도 안전
--
-- 원인 (2026-10-25):
--   익명 조회가 Registry 전체를 GET /api/reputation/:target 으로 훑었다 (09~13시 KST 시간당 최대 1,000건 이상, 대상마다 1회).
--   scanner_summary 뷰는 recent CTE 를 세 번 참조해서 Postgres 가 이를 통째로 계산한다
--   → target_id=eq.X 단건 조회도 매번 최근 30일치 관측 전체를 집계했다.
--   초당 0.3건 수준에서도 DB 가 포화되어 57014 statement timeout 이 연쇄로 났고,
--   registry_state 단건 조회·reputation_lookups 기록 쓰기까지 504 가 났다.
--
-- 조치:
--   1) 계산 로직은 scanner_summary_live (비공개 뷰) 로 옮긴다. anon/authenticated 는 읽을 수 없다.
--   2) 공개 이름 scanner_summary 는 미리 계산한 materialized view 로 바꾼다. 컬럼·이름이 같아 API 는 그대로 읽는다.
--      target_id 유니크 인덱스로 단건 조회는 인덱스 1회.
--   3) 매시 07분 갱신 (pg_cron, concurrently — 갱신 중에도 읽기를 막지 않는다).
--      스캐너 실행(10:17 / 22:17 KST) 뒤 API 반영까지 최대 약 1시간.
--   4) 부분 일치(ilike '%...%') 검색에 트라이그램 인덱스.
--   관측 원본(scanner_observations)은 건드리지 않는다.

set statement_timeout = '10min';

-- ── 1) + 2) ─────────────────────────────────────────────
begin;

do $$
begin
  -- 아직 일반 뷰라면 계산용 이름으로 바꾼다 (두 번째 실행부터는 건너뜀)
  if exists (select 1 from pg_views where schemaname = 'public' and viewname = 'scanner_summary') then
    alter view public.scanner_summary rename to scanner_summary_live;
  end if;
end $$;

revoke all on public.scanner_summary_live from anon, authenticated;

create materialized view if not exists public.scanner_summary as
  select * from public.scanner_summary_live;

create unique index if not exists scanner_summary_target_uq on public.scanner_summary (target_id);

grant select on public.scanner_summary to anon, authenticated;

commit;

-- ── 4) 트라이그램 인덱스 ─────────────────────────────────
create extension if not exists pg_trgm with schema extensions;

create index if not exists scanner_summary_target_trgm   on public.scanner_summary using gin (target_id    gin_trgm_ops);
create index if not exists registry_state_name_trgm      on public.registry_state  using gin (name         gin_trgm_ops);
create index if not exists registry_state_packages_trgm  on public.registry_state  using gin (packages_key gin_trgm_ops);
create index if not exists interactions_target_trgm      on public.interactions    using gin (target       gin_trgm_ops);

-- ── 3) 매시 갱신 ─────────────────────────────────────────
-- pg_cron 이 없다는 오류가 나면: Dashboard → Database → Extensions 에서 pg_cron 을 켠 뒤 이 블록만 다시 실행
create extension if not exists pg_cron with schema pg_catalog;

select cron.schedule(
  'lowdown-refresh-scanner-summary',
  '7 * * * *',
  'refresh materialized view concurrently public.scanner_summary'
);

-- PostgREST 가 바뀐 객체를 바로 보게
notify pgrst, 'reload schema';

-- ── 확인 ─────────────────────────────────────────────────
-- 1) 종류: scanner_summary = m(materialized view), scanner_summary_live = v(view)
-- select relname, relkind from pg_class where relname in ('scanner_summary', 'scanner_summary_live');
-- 2) 공개 권한: live 는 false, summary 는 true 여야 한다
-- select has_table_privilege('anon', 'public.scanner_summary_live', 'select') as live_anon,
--        has_table_privilege('anon', 'public.scanner_summary', 'select')      as summary_anon;
-- 3) 단건 조회가 인덱스를 타는지 (Index Scan using scanner_summary_target_uq)
-- explain analyze select * from public.scanner_summary where target_id = 'mcp:io.github.PetShopBros/lowdown-proxy';
-- 4) 매시 갱신 결과
-- select start_time, status, return_message from cron.job_run_details
-- where jobid = (select jobid from cron.job where jobname = 'lowdown-refresh-scanner-summary')
-- order by start_time desc limit 5;
--
-- 되돌리기 (필요할 때만):
-- select cron.unschedule('lowdown-refresh-scanner-summary');
-- drop materialized view public.scanner_summary;
-- alter view public.scanner_summary_live rename to scanner_summary;
-- grant select on public.scanner_summary to anon, authenticated;
-- notify pgrst, 'reload schema';
