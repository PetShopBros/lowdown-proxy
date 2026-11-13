-- 2026-11-14: 인용 경로 집계 보강 (2026-11-14_access_metrics.sql 다음). Supabase SQL Editor 에서 실행(pack). 여러 번 실행해도 결과 같음.
-- 바뀐 점
--   1) citation 에 AI 서비스가 붙이는 유입 꼬리표(utm_source=…, 예: ChatGPT 답변의 링크를 누르면 chatgpt.com)를 더한다.
--   2) 크롤러·점검기가 연 ref=cite / utm_source 주소는 citation 이 아니라 읽힘으로 둔다(따라간 링크이지 사람이 누른 것이 아님).
--   3) citation 줄의 evidence 에 꼬리표 종류를 남긴다: 'ref_cite' 또는 'utm_source:<값>'(영숫자·.-_ 64자까지).
--   4) 지난 날짜(2026-10-30~어제)를 새 규칙으로 다시 계산한다. 원본(edge_hits·mcp_calls)은 그대로.
-- 인용 링크 접근은 AI 가 답변에 Lowdown 을 썼다는 증거가 아니다(링크를 누른 요청이 왔다는 사실).
set statement_timeout = '120s';

create or replace function public.lowdown_access_category(ua text, kind text, p text)
returns text language sql immutable as $$
  select case
    when public.lowdown_is_self_ua(ua) then 'self'
    when p ~ '[?&](ref=cite|utm_source=)' and coalesce(kind, '') not in ('crawler', 'prober') then 'citation'
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
         case when cat in ('ai_labeled', 'citation') then public.lowdown_access_target(path) else '' end,
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

-- 확인 (분석 역할로):
-- select day, evidence, ua_name, path_kind, target, hits from access_daily where category = 'citation' order by day desc;
