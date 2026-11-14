-- 2026-11-15: access_daily 에 outreach 분류를 더한다 (2026-11-15_access_subject.sql 다음). Supabase SQL Editor 에서 postgres 로 실행(pack). 여러 번 실행해도 결과 같음.
-- 이유: 이반이 직접 보내는 자료의 링크를 인용 링크(ref=cite)와 섞지 않고 따로 센다.
--   ref=operator  서버 운영자에게 보내는 관측 요약(scanner/operator-report.ts)
--   ref=weekly    주간 보고서(월간 첫 게시 뒤 시작, 아직 발행 안 함)
-- 규칙: 크롤러·점검기가 연 주소는 citation 과 같이 읽힘으로 둔다(따라간 링크이지 사람이 누른 것이 아님).
--   ref=cite·utm_source 가 함께 있으면 citation 이 먼저다(기존 규칙 그대로).
--   evidence 는 'ref_operator' / 'ref_weekly'. 서버 페이지면 target(→ subject)도 남긴다.
-- 지난 날짜(2026-10-30~어제)를 다시 계산한다(지금까지 이 꼬리표는 쓰인 적이 없어 결과는 같아야 함). 원본(edge_hits·mcp_calls)은 그대로.
-- 접근은 링크를 연 요청이 왔다는 사실이지, 받은 사람이 읽었거나 관심이 있다는 증거가 아니다.
set statement_timeout = '120s';

create or replace function public.lowdown_access_category(ua text, kind text, p text)
returns text language sql immutable as $$
  select case
    when public.lowdown_is_self_ua(ua) then 'self'
    when p ~ '[?&](ref=cite|utm_source=)' and coalesce(kind, '') not in ('crawler', 'prober') then 'citation'
    when p ~ '[?&]ref=(operator|weekly)(&|$)' and coalesce(kind, '') not in ('crawler', 'prober') then 'outreach'
    when kind = 'ai_user' and p ~ '^/mcp(\?|/|$)' then 'ai_mcp'
    when kind = 'ai_user' then 'ai_labeled'
    when kind = 'crawler' then 'read_crawler'
    when kind = 'prober' then 'read_prober'
    else 'read_other'
  end
$$;

create or replace function public.lowdown_access_evidence(cat text, p text)
returns text language sql immutable as $$
  select case
    when cat = 'outreach' then 'ref_' || substring(p from '[?&]ref=(operator|weekly)(?:&|$)')
    when cat <> 'citation' then 'self_declared_user_agent'
    when p ~ '[?&]utm_source=' then 'utm_source:' || coalesce(substring(p from '[?&]utm_source=([A-Za-z0-9._-]{1,64})'), 'other')
    else 'ref_cite'
  end
$$;

create or replace function public.lowdown_access_daily_refresh(p_day date)
returns integer language plpgsql as $$
declare
  v_from timestamptz := p_day::timestamp at time zone 'UTC';
  v_to   timestamptz := (p_day + 1)::timestamp at time zone 'UTC';
  v_n    integer;
begin
  perform set_config('statement_timeout', '120s', true);
  delete from public.access_daily where day = p_day;

  insert into public.access_daily (day, category, ua_name, path_kind, target, evidence, hits)
  select p_day, cat, coalesce(bot_name, '-'), pk,
         case when cat in ('ai_labeled', 'citation', 'outreach') then public.lowdown_access_target(path) else '' end,
         public.lowdown_access_evidence(cat, path),
         count(*)
  from (
    select path, bot_name,
           public.lowdown_access_category(user_agent, bot_kind, path) as cat,
           public.lowdown_access_path_kind(path) as pk
    from public.edge_hits
    where created_at >= v_from and created_at < v_to
  ) e
  group by 1, 2, 3, 4, 5, 6;

  insert into public.access_daily (day, category, ua_name, path_kind, target, evidence, hits)
  select p_day, 'execution', coalesce(bot_name, '-'),
         coalesce(tool_name, '-') || ':' || coalesce(outcome, '-'), '', 'tool_call_record', count(*)
  from public.mcp_calls
  where created_at >= v_from and created_at < v_to
    and rpc_method = 'tools/call'
    and not public.lowdown_is_self_call(user_agent, declared_agent_id, declared_client_name)
  group by 1, 2, 3, 4, 5, 6;

  select count(*) into v_n from public.access_daily where day = p_day;
  return v_n;
end $$;

do $$
declare d date;
begin
  for d in select generate_series('2026-10-30'::date, (now() at time zone 'UTC')::date - 1, interval '1 day')::date loop
    perform public.lowdown_access_daily_refresh(d);
  end loop;
end $$;

-- 확인 (분석 역할로: set role lowdown_analyst; set statement_timeout='15s';)
-- select category, sum(hits) from access_daily group by 1 order by 2 desc;   -- outreach 는 아직 없어야 함
-- select day, evidence, ua_name, subject, hits from access_daily where category = 'outreach' order by day desc;
