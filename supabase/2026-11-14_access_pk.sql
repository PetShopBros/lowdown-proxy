-- 2026-11-14: access_daily 주키에 evidence 를 넣는다 (2026-11-14_citation.sql 다음). Supabase SQL Editor 에서 postgres 로 실행(pack).
-- 이유: citation 줄은 evidence(ref_cite / utm_source:<값>)까지 나눠 넣는데 주키에 evidence 가 없어서,
--   같은 날·같은 대상·같은 UA 이름·같은 경로 종류에 두 꼬리표가 함께 오면 주키 충돌 → 그날 refresh 전체가 실패한다
--   (delete 뒤 insert 실패 → 함수 전체가 되돌려져 그날 행은 이전 상태로 남거나, 처음 계산이면 비어 있음).
-- 원본(edge_hits·mcp_calls)은 그대로. 여러 번 실행해도 결과 같음.
set statement_timeout = '120s';

alter table public.access_daily drop constraint if exists access_daily_pkey;
alter table public.access_daily add primary key (day, category, ua_name, path_kind, target, evidence);

-- 인용 링크가 생긴 날(2026-11-13)부터 어제(UTC)까지 다시 계산
do $$
declare d date;
begin
  for d in select generate_series('2026-11-13'::date, (now() at time zone 'UTC')::date - 1, interval '1 day')::date loop
    perform public.lowdown_access_daily_refresh(d);
  end loop;
end $$;

-- 확인 (분석 역할로):
-- select day, count(*) as rows, sum(hits) as hits from access_daily where day >= '2026-10-30' group by 1 order by 1;
-- select day, evidence, path_kind, hits from access_daily where category = 'citation' order by day desc;
