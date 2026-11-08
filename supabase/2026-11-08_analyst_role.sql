-- 2026-11-08: 수동 분석용 읽기 전용 역할 lowdown_analyst (안정화 1단계 1-1).
-- 배경: 2026-11-06 08:00~08:13 KST, 시간 상한 없는 측정 SQL(join lateral 전수 비교)이 DB를 붙잡아 Lowdown 조회 503.
-- 원칙: 운영 역할(postgres, service_role, authenticator, anon, authenticated)은 건드리지 않는다.
--       손으로 돌리는 측정·분석 쿼리만 이 역할로, 시간 상한 안에서.
-- Supabase SQL Editor 에서 실행, 여러 번 실행해도 안전.
--
-- 사용법(SQL Editor 는 실행마다 새 세션·postgres 접속 → 아래 줄을 분석 쿼리와 같은 실행 안에 함께 — supabase/QUERY_RULES.md):
--   set role lowdown_analyst;
--   set statement_timeout = '15s'; set lock_timeout = '3s'; set idle_in_transaction_session_timeout = '60s';
-- 끝나면: reset role;
-- 주의: SET ROLE 로 들어가면 아래 alter role ... set 값은 적용되지 않는다(로그인할 때만 적용). 그래서 위 set 3줄이 필요하다.
--       alter role ... set 은 나중에 psql 등으로 이 역할로 직접 로그인할 때를 위한 것.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'lowdown_analyst') then
    create role lowdown_analyst nologin;
  end if;
end $$;

-- 로그인 시 기본 상한(직접 로그인용)
alter role lowdown_analyst set statement_timeout = '15s';
alter role lowdown_analyst set lock_timeout = '3s';
alter role lowdown_analyst set idle_in_transaction_session_timeout = '60s';

-- 읽기 전용: public 스키마 조회만. 쓰기 권한은 주지 않는다.
grant usage on schema public to lowdown_analyst;
grant select on all tables in schema public to lowdown_analyst;
alter default privileges in schema public grant select on tables to lowdown_analyst;

-- RLS 가 켜진 표도 분석할 수 있게(읽기만). 이 줄에서 권한 오류가 나면 지우고 다시 실행.
alter role lowdown_analyst bypassrls;

-- postgres 가 SQL Editor 에서 set role lowdown_analyst 할 수 있게
grant lowdown_analyst to postgres;

-- 확인
select rolname, rolcanlogin, rolbypassrls, rolconfig from pg_roles where rolname = 'lowdown_analyst';
