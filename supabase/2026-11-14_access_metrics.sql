-- 2026-11-14: 접근 측정 분류 (측정 체계 1단계, 프로젝트 문서 claude/lowdown-measurement-plan-2026-11-14.md)
-- Supabase SQL Editor 에서 postgres 로 실행(분석 역할 아님). 여러 번 실행해도 결과 같음.
--
-- 하는 일
--   1) Lowdown 자신 판정에 자체 점검(lowdown-smoke/…)을 더한다. 지금까지는 scanner·test 만 빠지고
--      smoke 는 외부 점검기(prober)로 세어졌다. status.json·Agent Observatory 는 이 함수를 쓰므로 다음 스냅샷부터 함께 바뀐다.
--   2) 일별 접근 집계표 access_daily: edge_hits(웹·API 요청)와 mcp_calls(원격 MCP 메시지)를
--      서로 섞지 않는 분류(category)로 나눠 하루 한 번 계산한다. 원본 표는 그대로 둔다(지우지 않음).
--   3) AI 표기 접근(ai_labeled)·인용 경로(citation)는 대상 서버(target)까지 남긴다 → 서버별 원천 기록. 공개하지 않는다.
--
-- 분류(서로 독립된 관측. 앞 단계가 뒤 단계로 이어진다는 뜻이 아님)
--   self          Lowdown 자신(lowdown-scanner/·lowdown-test/·lowdown-smoke/)
--   citation      ref=cite 링크로 들어온 요청 (링크 접근일 뿐, AI 가 인용했다는 증거 아님)
--   ai_mcp        AI 어시스턴트 표기 UA 의 /mcp 요청(연결 인사 포함)
--   ai_labeled    AI 어시스턴트 표기 UA(ChatGPT-User·Claude-User 등)가 /mcp 밖(서버 페이지·조회 등)을 연 요청
--                 → 사람의 질문·답변 사용을 증명하지 않는다. UA 는 자기 선언, IP 미저장이라 진위 확인 불가.
--   read_crawler / read_prober / read_other   그 밖의 읽힘(크롤러·점검기·이름 없는 요청). 수요 지표 아님
--   execution     원격 MCP tools/call (mcp_calls, Lowdown 자신·기존 시험 표시 제외). path_kind = 도구:결과
set statement_timeout = '120s';

-- 1) Lowdown 자신
create or replace function public.lowdown_is_self_ua(ua text)
returns boolean language sql immutable as $$
  select coalesce(ua, '') ~* '^lowdown-(scanner|test|smoke)/'
$$;

create or replace function public.lowdown_is_self_name(n text)
returns boolean language sql immutable as $$
  select lower(coalesce(n, '')) in ('lowdown-scanner', 'lowdown-test', 'lowdown-smoke')
$$;

-- 2) 경로 → 종류·대상
create or replace function public.lowdown_access_path_kind(p text)
returns text language sql immutable as $$
  select case
    when p ~ '^/servers/[^/?]+/[^/?]+' then 'server_page'
    when p ~ '^/servers(\?|$)' then 'server_index'
    when p like '/api/reputation/%' then 'lookup'
    when p like '/api/find%' then 'find'
    when p ~ '^/mcp(\?|$)' then 'mcp'
    when p like '/mcp/%' then 'mcp_card'
    when p like '/.well-known/%' then 'well_known'
    when p like '/sitemaps/%' then 'sitemap_part'
    when p like '/agents/%' then 'agent_page'
    when split_part(p, '?', 1) in ('/', '/llms.txt', '/openapi.json', '/menu.json', '/status.json', '/robots.txt',
                                   '/sitemap.xml', '/agents', '/agents.json', '/privacy', '/terms') then split_part(p, '?', 1)
    else 'other'
  end
$$;

create or replace function public.lowdown_access_target(p text)
returns text language sql immutable as $$
  select coalesce(left(case
    when p ~ '^/servers/[^/?]+/[^/?]+' then 'mcp:' || substring(p from '^/servers/([^/?]+/[^/?]+)')
    when p like '/api/reputation/%' then
      replace(replace(replace(replace(substring(split_part(p, '?', 1) from '^/api/reputation/(.+)$'),
        '%2F', '/'), '%2f', '/'), '%3A', ':'), '%3a', ':')
  end, 300), '')
$$;

create or replace function public.lowdown_access_category(ua text, kind text, p text)
returns text language sql immutable as $$
  select case
    when public.lowdown_is_self_ua(ua) then 'self'
    when p ~ '[?&]ref=cite(&|$)' then 'citation'
    when kind = 'ai_user' and p ~ '^/mcp(\?|/|$)' then 'ai_mcp'
    when kind = 'ai_user' then 'ai_labeled'
    when kind = 'crawler' then 'read_crawler'
    when kind = 'prober' then 'read_prober'
    else 'read_other'
  end
$$;

-- 3) 일별 집계표 (비공개: select policy 없음)
create table if not exists public.access_daily (
  day         date        not null,
  category    text        not null,
  ua_name     text        not null,  -- 자기 선언 이름(classify_user_agent), 없으면 '-'
  path_kind   text        not null,  -- execution 은 '도구:결과'
  target      text        not null default '',  -- ai_labeled·citation 만 채움
  evidence    text        not null,  -- 근거 수준
  hits        integer     not null,
  computed_at timestamptz not null default now(),
  primary key (day, category, ua_name, path_kind, target)
);
alter table public.access_daily enable row level security;

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
         case when cat = 'citation' then 'link_access' else 'self_declared_user_agent' end,
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

-- 매일 00:23 UTC 에 어제(UTC) 분을 계산
do $$
begin
  if exists (select 1 from cron.job where jobname = 'lowdown-access-daily') then
    perform cron.unschedule('lowdown-access-daily');
  end if;
end $$;
select cron.schedule('lowdown-access-daily', '23 0 * * *',
  $c$select public.lowdown_access_daily_refresh((now() at time zone 'UTC')::date - 1)$c$);

-- 지난 날짜 채우기: edge_hits 시작일(2026-10-30)부터 어제까지
do $$
declare d date;
begin
  for d in select generate_series('2026-10-30'::date, (now() at time zone 'UTC')::date - 1, interval '1 day')::date loop
    perform public.lowdown_access_daily_refresh(d);
  end loop;
end $$;

-- 확인 (분석 역할로):
-- select category, sum(hits) from access_daily where day >= current_date - 7 group by 1 order by 2 desc;
-- select day, ua_name, path_kind, target, hits from access_daily where category = 'ai_labeled' order by day desc;
