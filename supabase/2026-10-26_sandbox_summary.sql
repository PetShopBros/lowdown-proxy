-- 2026-10-26: stdio 샌드박스 결과 공개용 요약 (기본 비공개 — 아래 "공개하려면" 을 실행하기 전에는 anon 이 읽지 못한다)
-- 원본(sandbox_runs/sandbox_state/sandbox_batches)은 계속 비공개. 이 요약은 package@version 당 최근 실행 1행이고,
-- registry_type 이 'npm' 인 행만 API 가 읽는다(PyPI 는 파일럿 자료가 쌓인 뒤 따로 결정).
-- 도구 이름·정의·해시·표준오류·인자·환경변수 이름은 담지 않는다. 점수·판정 없음: outcome 은 "어디까지 응답했는가"일 뿐이다.

create materialized view if not exists sandbox_summary as
select distinct on (registry_type, ident, version)
  registry_type,
  ident,
  version,
  sources,
  outcome,
  reached_level,
  case when metadata->>'tool_count' ~ '^[0-9]{1,6}$' then (metadata->>'tool_count')::int end as tool_count,
  (metadata->>'install_scripts') = 'true' as install_scripts,
  runner_version,
  observed_at
from sandbox_runs
order by registry_type, ident, version, observed_at desc;

create unique index if not exists sandbox_summary_uq on sandbox_summary (registry_type, ident, version);
create index if not exists sandbox_summary_ident_idx on sandbox_summary (registry_type, ident, observed_at desc);

-- 새 객체는 기본으로 anon 이 읽을 수 있는 경우가 있다 → 명시적으로 회수
revoke all on sandbox_summary from anon, authenticated;

-- 매시 27분 갱신 (scanner_summary 는 7분)
do $$
begin
  perform cron.unschedule('lowdown-refresh-sandbox-summary');
exception when others then null;
end $$;
select cron.schedule('lowdown-refresh-sandbox-summary', '27 * * * *', 'refresh materialized view concurrently public.sandbox_summary');

-- 확인 (둘 다 false 여야 한다)
-- select has_table_privilege('anon', 'sandbox_summary', 'select') as anon_select, has_table_privilege('authenticated', 'sandbox_summary', 'select') as auth_select;
-- select count(*), count(*) filter (where reached_level = 2) as level2 from sandbox_summary;

-- ─────────────────────────────────────────────
-- 공개하려면 (두 가지를 모두 해야 한다 — 하나만으로는 노출되지 않는다)
--   1) 이 SQL:
--        grant select on sandbox_summary to anon, authenticated;
--        notify pgrst, 'reload schema';
--   2) Vercel 환경변수 SANDBOX_PUBLIC=1 (재배포)
-- 되돌리기: revoke select on sandbox_summary from anon, authenticated; + SANDBOX_PUBLIC 삭제. 데이터는 지워지지 않는다.
-- ─────────────────────────────────────────────
