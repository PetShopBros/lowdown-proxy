-- 2026-11-05: Agent Observatory — 방문 시스템 관측 스냅샷 (Supabase SQL Editor 에서 실행, 여러 번 실행해도 안전)
-- 이후 변경: lowdown_agents_compute() 의 최신 정의는 2026-11-05_self.sql (Lowdown 자신의 요청 제외). 이 파일을 다시 실행하면 그 이전 정의로 돌아가므로 self.sql 도 이어서 실행한다.
--
-- lowdown_agents_compute()  매시 54분(pg_cron) 한 번 집계 → agent_snapshots 에 1줄(JSON) 누적. 지우지 않는다.
-- 공개 전 검증 단계: 이 SQL 은 아직 공개 권한을 주지 않는다(anon select 없음). 대조 쿼리로 숫자를 맞춘 뒤 공개 SQL 을 따로 실행한다.
--
-- 묶음: (소문자 이름, 선언 성격 prober|crawler|other). 이름은 User-Agent 선언에서 뽑은 것(classify_user_agent)이며
--   독립된 운영 주체나 검증된 에이전트의 수가 아니다. 같은 묶음 안의 서로 다른 UA 원문 수를 user_agent_variants 로 함께 낸다.
-- 개별 목록에 넣지 않는 것(합계만): ai_user(사람이 실행한 AI 요청), 범용 HTTP 라이브러리 이름, 이름 없는 요청, 제외 요청된 이름.
-- 저장·공개하지 않는 것: 조회 대상, 검색어, IP, 원본 요청 시각 목록. 경로는 종류별 건수만.
-- 정의:
--   requests  이 묶음으로 분류된 요청 수
--   visits    같은 묶음의 요청을 5분 미만 간격이면 한 방문으로 묶은 수
--   days_seen 요청이 있었던 서로 다른 UTC 날짜 수
--   median_interval_minutes  방문 시작 시각 사이 간격의 중앙값(간격 2개 이상일 때만, 아니면 unknown)
--   mcp       mcp_calls 의 단계별 시도·성공. 성공 = Lowdown 이 JSON-RPC 결과를 돌려줌(isError 아님). 상대 작업의 성공이 아니다.
-- 테스트 제외: mcp_calls 에서 declared_agent_id 'lowdown-self-test' 또는 declared_client_name 'ivan-check'.

set statement_timeout = '5min';

create table if not exists public.agent_snapshots (
  id              bigint generated always as identity primary key,
  hour_bucket     timestamptz not null unique,
  generated_at    timestamptz not null default now(),
  schema_version  int         not null,
  data            jsonb       not null
);
alter table public.agent_snapshots enable row level security;
revoke all on public.agent_snapshots from anon, authenticated;   -- 공개는 검증 뒤 별도 SQL

create table if not exists public.agent_optouts (
  name_key       text not null,                  -- 소문자 이름
  declared_kind  text not null check (declared_kind in ('prober', 'crawler', 'other')),
  requested_on   date not null default current_date,
  note           text,
  primary key (name_key, declared_kind)
);
alter table public.agent_optouts enable row level security;
revoke all on public.agent_optouts from anon, authenticated;

-- 범용 HTTP 라이브러리 이름(에이전트 이름이 아님) → 합계로만
create or replace function public.lowdown_is_http_library(n text)
returns boolean language sql immutable as $$
  select lower(coalesce(n, '')) = any (array[
    'node', 'undici', 'bun', 'deno', 'python-requests', 'python-httpx', 'python-httpx2', 'python-urllib', 'aiohttp',
    'go-http-client', 'axios', 'node-fetch', 'got', 'curl', 'wget', 'okhttp', 'java', 'apache-httpclient', 'libwww-perl', 'ruby', 'php'])
$$;

-- 경로 → 종류 (query 는 버린다)
create or replace function public.lowdown_path_kind(p text)
returns text language sql immutable as $$
  select case
    when b = '/mcp' then 'mcp'
    when b like '/api/reputation/%' then 'lookup_api'
    when b like '/api/find%' then 'find_api'
    when b = '/servers' or b like '/servers/%' then 'server_pages'
    when b in ('/llms.txt', '/robots.txt', '/openapi.json', '/menu.json', '/status.json', '/sitemap.xml', '/agents.json') or b like '/sitemaps/%' then 'discovery_files'
    when b like '/.well-known/%' then 'well_known'
    when b = '/' then 'home'
    else 'other'
  end
  from (select split_part(coalesce(p, ''), '?', 1) as b) x
$$;

create or replace function public.lowdown_agents_compute()
returns bigint
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_now        timestamptz := now();
  v_bucket     timestamptz := date_trunc('hour', now());
  v_from       timestamptz := now() - interval '30 days';
  v_id         bigint;
  v_prev       jsonb;
  v_mcp_since  timestamptz;
  v_agents     jsonb;
  v_excluded   int;
  v_agg        jsonb;
  v_data       jsonb;
begin
  perform set_config('statement_timeout', '120s', true);
  perform pg_advisory_xact_lock(hashtext('lowdown_agents_compute'));
  select id into v_id from agent_snapshots where hour_bucket = v_bucket;
  if v_id is not null then return v_id; end if;

  select data into v_prev from agent_snapshots order by hour_bucket desc limit 1;
  select min(created_at) into v_mcp_since from mcp_calls;

  drop table if exists _h;
  drop table if exists _g;
  create temp table _h on commit drop as
    select created_at, user_agent,
           bot_name,
           lower(bot_name) as name_key,
           case when bot_kind in ('prober', 'crawler') then bot_kind else 'other' end as kind,
           lowdown_path_kind(path) as path_kind
    from edge_hits
    where created_at >= v_from and created_at < v_now
      and bot_name is not null and bot_name <> 'other'
      and bot_kind is distinct from 'ai_user'
      and not lowdown_is_http_library(bot_name);

  create temp table _g on commit drop as
  with v as (
    select name_key, kind, created_at,
           lag(created_at) over (partition by name_key, kind order by created_at) as prev_at
    from _h
  ), starts as (
    select name_key, kind, created_at as visit_start from v
    where prev_at is null or created_at - prev_at >= interval '5 minutes'
  ), gaps as (
    select name_key, kind,
           extract(epoch from visit_start - lag(visit_start) over (partition by name_key, kind order by visit_start)) / 60.0 as gap_min
    from starts
  ), gs as (
    select name_key, kind, count(gap_min) as gap_count, percentile_cont(0.5) within group (order by gap_min) as median_gap
    from gaps group by 1, 2
  ), vs as (
    select name_key, kind, count(*) as visits from starts group by 1, 2
  ), base as (
    select name_key, kind,
           count(*) as requests,
           count(distinct (created_at at time zone 'UTC')::date) as days_seen,
           min(created_at) as first_in_window, max(created_at) as last_seen,
           count(distinct user_agent) as ua_variants
    from _h group by 1, 2
  ), latest as (
    select distinct on (name_key, kind) name_key, kind, bot_name as display_name, left(user_agent, 200) as ua
    from _h order by name_key, kind, created_at desc
  ), pm as (
    select name_key, kind, jsonb_object_agg(path_kind, n) as path_mix
    from (select name_key, kind, path_kind, count(*) as n from _h group by 1, 2, 3) x group by 1, 2
  ), dy as (
    select name_key, kind, jsonb_agg(jsonb_build_object('day', d, 'requests', n) order by d) as daily
    from (select name_key, kind, (created_at at time zone 'UTC')::date as d, count(*) as n from _h group by 1, 2, 3) x group by 1, 2
  ), urls as (
    select name_key, kind, jsonb_agg(u order by u) as declared_urls
    from (
      select distinct name_key, kind, regexp_replace(regexp_replace(m[1], '[?#].*$', ''), '[.,;:)\]]+$', '') as u
      from (select distinct name_key, kind, user_agent from _h) a,
           lateral regexp_matches(a.user_agent, '(https?://[A-Za-z0-9._~:/%@!$&''*+=-]+(?:[?#][^\s;)]*)?)', 'g') as m
    ) y
    where length(u) between 10 and 200
    group by 1, 2
  ), mc as (
    select lower(bot_name) as name_key, case when bot_kind in ('prober', 'crawler') then bot_kind else 'other' end as kind,
           count(*) filter (where rpc_method = 'initialize') as init_attempts,
           count(*) filter (where rpc_method = 'initialize' and outcome = 'ok') as init_ok,
           count(*) filter (where rpc_method = 'tools/list') as list_attempts,
           count(*) filter (where rpc_method = 'tools/list' and outcome = 'ok') as list_ok,
           count(*) filter (where rpc_method = 'tools/call') as call_attempts,
           count(*) filter (where rpc_method = 'tools/call' and outcome = 'ok') as call_ok
    from mcp_calls
    where created_at >= v_from and created_at < v_now and bot_name is not null
      and coalesce(declared_agent_id, '') <> 'lowdown-self-test' and coalesce(declared_client_name, '') <> 'ivan-check'
    group by 1, 2
  ), cn as (
    select lower(bot_name) as name_key, case when bot_kind in ('prober', 'crawler') then bot_kind else 'other' end as kind,
           jsonb_agg(c order by c) as client_names
    from (select distinct bot_name, bot_kind, left(declared_client_name, 100) as c from mcp_calls
          where rpc_method = 'initialize' and declared_client_name is not null and bot_name is not null
            and created_at >= v_from and created_at < v_now and declared_client_name <> 'ivan-check') z
    group by 1, 2
  )
  select b.name_key, b.kind,
         l.display_name, l.ua,
         b.requests, b.days_seen, b.first_in_window, b.last_seen, b.ua_variants,
         vs.visits, gs.gap_count, gs.median_gap,
         coalesce(pm.path_mix, '{}'::jsonb) as path_mix,
         coalesce(dy.daily, '[]'::jsonb) as daily,
         coalesce((select jsonb_agg(e) from (select e from jsonb_array_elements(urls.declared_urls) e limit 3) q), '[]'::jsonb) as declared_urls,
         mc.init_attempts, mc.init_ok, mc.list_attempts, mc.list_ok, mc.call_attempts, mc.call_ok,
         coalesce((select jsonb_agg(e) from (select e from jsonb_array_elements(cn.client_names) e limit 5) q), '[]'::jsonb) as client_names,
         left(regexp_replace(b.name_key, '[^a-z0-9._-]', '-', 'g'), 100) as slug,
         exists (select 1 from agent_optouts o where o.name_key = b.name_key and o.declared_kind = b.kind) as opted_out
  from base b
  join latest l using (name_key, kind)
  join vs using (name_key, kind)
  join gs using (name_key, kind)
  left join pm using (name_key, kind)
  left join dy using (name_key, kind)
  left join urls using (name_key, kind)
  left join mc using (name_key, kind)
  left join cn using (name_key, kind);

  select count(*) into v_excluded from _g where opted_out;

  select coalesce(jsonb_agg(jsonb_build_object(
           'name', g.display_name,
           'name_key', g.name_key,
           'declared_kind', g.kind,
           'slug', g.slug,
           'path', '/agents/' || g.kind || '/' || g.slug,
           'declared_user_agent', g.ua,
           'user_agent_variants', g.ua_variants,
           'declared_urls', g.declared_urls,
           'first_seen', to_char(least(g.first_in_window,
                              coalesce((select (e->>'first_seen')::timestamptz from jsonb_array_elements(coalesce(v_prev->'agents', '[]'::jsonb)) e
                                        where e->>'name_key' = g.name_key and e->>'declared_kind' = g.kind limit 1), g.first_in_window))
                              at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
           'last_seen', to_char(g.last_seen at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
           'days_seen', g.days_seen,
           'visits', g.visits,
           'requests', g.requests,
           'median_interval_minutes', case when g.gap_count >= 2 then round(g.median_gap::numeric, 1) end,
           'interval', case when g.gap_count >= 2 then 'measured' else 'unknown' end,
           'regular', g.days_seen >= 3 and g.gap_count >= 2,
           'path_mix', g.path_mix,
           'mcp', jsonb_build_object(
             'initialize', jsonb_build_object('attempts', coalesce(g.init_attempts, 0), 'ok', coalesce(g.init_ok, 0)),
             'tools_list', jsonb_build_object('attempts', coalesce(g.list_attempts, 0), 'ok', coalesce(g.list_ok, 0)),
             'tools_call', jsonb_build_object('attempts', coalesce(g.call_attempts, 0), 'ok', coalesce(g.call_ok, 0))),
           'declared_client_names', g.client_names,
           'daily', g.daily
         ) order by g.days_seen desc, g.requests desc, g.display_name), '[]'::jsonb)
    into v_agents
  from _g g where not g.opted_out;

  -- 합계만 두는 묶음
  select jsonb_build_object(
    'ai_user', jsonb_build_object(
      'requests', (select count(*) from edge_hits where created_at >= v_from and created_at < v_now and bot_kind = 'ai_user'),
      'daily', coalesce((select jsonb_agg(jsonb_build_object('day', d, 'requests', n) order by d) from (
                 select (created_at at time zone 'UTC')::date as d, count(*) as n from edge_hits
                 where created_at >= v_from and created_at < v_now and bot_kind = 'ai_user' group by 1) x), '[]'::jsonb),
      'note', 'Requests by AI assistants acting for a person (for example Claude-User). Not listed by name.'),
    'http_libraries', jsonb_build_object(
      'requests', (select count(*) from edge_hits where created_at >= v_from and created_at < v_now and bot_name is not null
                   and bot_kind is distinct from 'ai_user' and lowdown_is_http_library(bot_name)),
      'note', 'Requests whose User-Agent names only a generic HTTP library (for example node or python-httpx). A library name does not identify an agent.'),
    'unnamed', jsonb_build_object(
      'requests', (select count(*) from edge_hits where created_at >= v_from and created_at < v_now
                   and (bot_name is null or bot_name = 'other') and bot_kind is distinct from 'ai_user'),
      'note', 'Requests with no name in the User-Agent, including browser-style strings.'),
    'opted_out', jsonb_build_object(
      'names', v_excluded,
      'requests', coalesce((select sum(requests) from _g where opted_out), 0),
      'note', 'Names removed from the list on request. Counted in totals only.')
  ) into v_agg;

  v_data := jsonb_build_object(
    'schema_version', 1,
    'snapshot_id', null,
    'generated_at', to_char(v_now at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'update_interval', 'hourly',
    'window', jsonb_build_object('from', to_char(v_from at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), 'to', to_char(v_now at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')),
    'totals', jsonb_build_object(
      'names', jsonb_array_length(v_agents),
      'regular_names', (select count(*) from jsonb_array_elements(v_agents) e where (e->>'regular')::boolean),
      'by_kind', (select coalesce(jsonb_object_agg(k, n), '{}'::jsonb) from (select e->>'declared_kind' as k, count(*) as n from jsonb_array_elements(v_agents) e group by 1) x),
      'tools_call_ok', (select coalesce(sum((e #>> '{mcp,tools_call,ok}')::int), 0) from jsonb_array_elements(v_agents) e)),
    'mcp_recorded_since', to_char(v_mcp_since at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'agents', v_agents,
    'aggregates', v_agg,
    'definitions', jsonb_build_object(
      'name', 'A name taken from the User-Agent declaration. Groups are (lower-cased name, declared kind). A name is not a verified identity and not a count of independent operators: one operator may use several names and different operators may share one.',
      'declared_kind', 'prober = the User-Agent declares a check, probe, scan, monitor, index or similar purpose; crawler = it declares bot, crawler or spider; other = a name without either declaration.',
      'declared_user_agent', 'The most recent User-Agent string under the name, up to 200 characters, as sent by the visitor.',
      'user_agent_variants', 'Distinct User-Agent strings seen under the name in the window.',
      'declared_urls', 'http(s) addresses written in the User-Agent, without query or fragment. Self-description, not proof of identity. Lowdown does not open them.',
      'requests', 'Requests classified under the name in the window.',
      'visits', 'Requests under the name grouped into one visit when less than 5 minutes apart.',
      'days_seen', 'Distinct UTC days with at least one request.',
      'median_interval_minutes', 'Median time between visit starts, from actual request times; only with at least 2 intervals, otherwise interval is unknown.',
      'regular', 'Seen on at least 3 different UTC days with at least 2 measured intervals.',
      'path_mix', 'Requests by kind of path: mcp, lookup_api, find_api, server_pages, discovery_files, well_known, home, other. Which servers were looked up is not recorded here.',
      'mcp', 'JSON-RPC messages at /mcp by stage: attempts, and ok = Lowdown returned a result without an error. ok does not mean the visitor achieved its goal. Recorded only since mcp_recorded_since; earlier periods have no record, not zero calls.',
      'declared_client_names', 'clientInfo names sent in initialize messages that carried this User-Agent name.',
      'daily', 'Requests per UTC day in the window.'),
    'limitations', jsonb_build_array(
      'Every name and kind comes from User-Agent declarations, which any client can change.',
      'Requests made through an AI assistant for a person are counted only in aggregates.',
      'Names removed on request are counted only in aggregates; the names are not published.',
      'No score, rank or verdict is given. Order is days seen, then requests, then name.'),
    'opt_out', 'Operators can ask to remove a name from the list: https://github.com/PetShopBros/lowdown-proxy/issues or atom.art2meta@gmail.com. Removed names stay in totals.'
  );

  insert into agent_snapshots (hour_bucket, generated_at, schema_version, data)
  values (v_bucket, v_now, 1, v_data)
  on conflict (hour_bucket) do nothing
  returning id into v_id;
  if v_id is null then
    select id into v_id from agent_snapshots where hour_bucket = v_bucket;
  else
    update agent_snapshots set data = jsonb_set(data, '{snapshot_id}', to_jsonb(v_id)) where id = v_id;
  end if;
  return v_id;
end
$fn$;

revoke all on function public.lowdown_agents_compute() from public, anon, authenticated;

-- ── 매시 54분 실행 (pg_cron) ────────────────────────────
create extension if not exists pg_cron with schema pg_catalog;
do $$
begin
  if exists (select 1 from cron.job where jobname = 'lowdown-agents-snapshot') then
    perform cron.unschedule('lowdown-agents-snapshot');
  end if;
end $$;
select cron.schedule('lowdown-agents-snapshot', '54 * * * *', 'select public.lowdown_agents_compute()');

-- 첫 스냅샷
select public.lowdown_agents_compute();

-- ── 검증(공개 전): 스냅샷 값과 원본 직접 계산이 같은지. 같은 창(window from~to)으로 다시 센다. 결과 0줄이면 일치 ──
-- with s as (select data from agent_snapshots order by hour_bucket desc limit 1),
-- w as (select (data #>> '{window,from}')::timestamptz as f, (data #>> '{window,to}')::timestamptz as t from s),
-- a as (select e->>'name_key' as name_key, e->>'declared_kind' as kind, (e->>'requests')::int as requests, (e->>'visits')::int as visits,
--              (e->>'days_seen')::int as days_seen,
--              (e #>> '{mcp,tools_call,attempts}')::int as call_attempts
--       from s, jsonb_array_elements(s.data->'agents') e),
-- h as (select lower(bot_name) as name_key, case when bot_kind in ('prober','crawler') then bot_kind else 'other' end as kind, created_at
--       from edge_hits, w where created_at >= w.f and created_at < w.t and bot_name is not null and bot_name <> 'other'
--         and bot_kind is distinct from 'ai_user' and not lowdown_is_http_library(bot_name)),
-- d as (select name_key, kind, count(*) as requests, count(distinct (created_at at time zone 'UTC')::date) as days_seen,
--              count(*) filter (where prev is null or created_at - prev >= interval '5 minutes') as visits
--       from (select *, lag(created_at) over (partition by name_key, kind order by created_at) as prev from h) x group by 1, 2),
-- m as (select lower(bot_name) as name_key, case when bot_kind in ('prober','crawler') then bot_kind else 'other' end as kind,
--              count(*) filter (where rpc_method = 'tools/call') as call_attempts
--       from mcp_calls, w where created_at >= w.f and created_at < w.t and bot_name is not null
--         and coalesce(declared_agent_id,'') <> 'lowdown-self-test' and coalesce(declared_client_name,'') <> 'ivan-check' group by 1, 2)
-- select coalesce(a.name_key, d.name_key) as name_key, coalesce(a.kind, d.kind) as kind,
--        a.requests as snap_requests, d.requests as raw_requests, a.visits as snap_visits, d.visits as raw_visits,
--        a.days_seen as snap_days, d.days_seen as raw_days, a.call_attempts as snap_calls, coalesce(m.call_attempts, 0) as raw_calls
-- from a full join d on a.name_key = d.name_key and a.kind = d.kind
-- left join m on m.name_key = coalesce(a.name_key, d.name_key) and m.kind = coalesce(a.kind, d.kind)
-- where (a.requests is distinct from d.requests or a.visits is distinct from d.visits or a.days_seen is distinct from d.days_seen
--        or a.call_attempts is distinct from coalesce(m.call_attempts, 0))
--   and not exists (select 1 from agent_optouts o where o.name_key = coalesce(a.name_key, d.name_key) and o.declared_kind = coalesce(a.kind, d.kind));
