-- 2026-11-15: access_daily 에 subject(Registry 이름 형식으로 맞춘 대상)를 더한다 (측정 계획 6번, 시간 연결 기록 — 연구용).
-- Supabase SQL Editor 에서 postgres 로 실행(pack). 여러 번 실행해도 결과 같음.
-- 이유: target 은 들어온 모양 그대로다. 서버 페이지는 'mcp:ns/name', 조회 주소는 주소에 적힌 대로('ns/name', 'mcp:ns/name', 'npm:…', URL).
--   그래서 같은 서버가 키 둘로 갈라져 Registry 변경(registry_changes.name)·도구 정의 변경(scanner_tool_changes.target_id)과 잇기 어렵다.
-- subject 규칙: 앞의 'mcp:' 를 떼고, 남은 값이 'ns/name' 형식(슬래시 하나, 영숫자·._-)이면 그 값, 아니면 null.
--   npm·PyPI·URL 로 들어온 대상은 null 로 둔다(이름 해석은 조회 API 쪽 일이고, 여기서 흉내 내지 않음).
--   형식만 맞춘 값이다. Registry 에 실제로 있는 이름인지는 조회할 때 registry_state 와 이어서 확인한다.
-- target 에서 바로 계산하는 생성 열이라 refresh 함수·cron·지난 날짜 다시 계산이 필요 없다. 원본(edge_hits·mcp_calls)은 그대로.
-- 주의: 아래 함수를 나중에 바꾸면 이미 저장된 subject 는 다시 계산되지 않는다 → 열을 지우고 다시 더할 것.
-- 공개하지 않는다(access_daily 는 select policy 없음). 접근과 변경을 나란히 놓을 뿐 인과를 주장하지 않는다.
set statement_timeout = '120s';

create or replace function public.lowdown_access_subject(t text)
returns text language sql immutable as $$
  select case when s ~ '^[A-Za-z0-9._-]{1,200}/[A-Za-z0-9._-]{1,200}$' then s end
  from (select case when t like 'mcp:%' then substr(t, 5) else t end as s) x
$$;

alter table public.access_daily
  add column if not exists subject text generated always as (public.lowdown_access_subject(target)) stored;

create index if not exists access_daily_subject_idx
  on public.access_daily (subject, day) where subject is not null;

-- 확인 (분석 역할로: set role lowdown_analyst; set statement_timeout='15s';)
-- 1) 맞추지 못한 대상 (npm·URL·형식 밖):
-- select target, sum(hits) from access_daily where target <> '' and subject is null group by 1 order by 2 desc limit 20;
-- 2) 같은 서버가 키 둘로 들어온 예 (subject 하나에 target 여럿):
-- select subject, array_agg(distinct target) from access_daily where subject is not null group by 1 having count(distinct target) > 1 limit 20;
-- 3) 시간 연결 (연구용, 공개 안 함): 서버별 AI 표기 접근·인용 링크 접근이 있던 날과, 앞뒤 7일 안의 Registry·도구 정의 변경
-- with a as (
--   select subject, day, category, sum(hits) as hits
--   from access_daily where subject is not null and category in ('ai_labeled', 'citation')
--   group by 1, 2, 3
-- )
-- select a.subject, a.day, a.category, a.hits,
--        (select string_agg(distinct rc.kind || '@' || rc.detected_on, ', ')
--           from registry_changes rc
--          where rc.name = a.subject and rc.detected_on between a.day - 7 and a.day + 7) as registry_changes_7d,
--        (select string_agg(distinct tc.change_type || '@' || (tc.observed_at at time zone 'UTC')::date, ', ')
--           from scanner_tool_changes tc
--          where tc.target_id = 'mcp:' || a.subject
--            and tc.observed_at >= (a.day - 7)::timestamp at time zone 'UTC'
--            and tc.observed_at <  (a.day + 8)::timestamp at time zone 'UTC') as tool_changes_7d,
--        exists (select 1 from registry_state rs where rs.name = a.subject) as in_registry
-- from a order by a.day desc, a.hits desc limit 50;
