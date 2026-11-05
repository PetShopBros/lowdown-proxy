-- 2026-11-05: Lowdown 자신의 요청을 공개 집계에서 뺀다 (Supabase SQL Editor 에서 실행, 여러 번 실행해도 안전)
--
-- 배경: 매일 UTC 01:17 Scanner 가 MCP Registry 에 올라 있는 Lowdown 자신(/mcp)에도 initialize·tools/list 를 보낸다(하루 3건).
--   이 요청(lowdown-scanner/0.5.0)과 시험 요청(lowdown-test/1102)이 /agents·/agents.json·/status.json 에 외부 방문자처럼 나왔다.
-- 바꾸는 것: 판별 함수 3개를 만들고, lowdown_agents_compute()·lowdown_status_compute() 를 그것을 쓰도록 다시 만든다.
--   두 함수의 나머지 내용은 2026-11-05_agents.sql·2026-11-05_status.sql 과 같다(이 파일이 그 두 함수의 최신 정의).
-- 지키는 것: edge_hits·mcp_calls 원본은 그대로 둔다(지우지 않는다). 공개 집계에는 Lowdown 자신의 합계만 따로 적는다
--   (agents: aggregates.lowdown_self, status: excluded_lowdown_self).
-- 권한·cron·테이블은 건드리지 않는다. 다음 매시 집계(52분 status, 54분 agents)부터 반영된다. 지난 스냅샷은 그대로 둔다.
-- 공통 대상 열쇠의 첫 사례: "Lowdown 자신" 판별을 이 함수 하나로 모은다. 다른 집계도 이 함수를 쓴다.

set statement_timeout = '5min';

-- User-Agent 가 Lowdown 자신(Scanner·시험)인가
create or replace function public.lowdown_is_self_ua(ua text)
returns boolean language sql immutable as $$
  select coalesce(ua, '') ~* '^lowdown-(scanner|test)/'
$$;

-- 이름(bot_name, 강조 기록의 detail.name)이 Lowdown 자신인가
create or replace function public.lowdown_is_self_name(n text)
returns boolean language sql immutable as $$
  select lower(coalesce(n, '')) in ('lowdown-scanner', 'lowdown-test')
$$;

-- mcp_calls 한 줄이 Lowdown 자신의 요청인가: Scanner·시험 UA, 또는 기존 시험 표시(x-agent-id lowdown-self-test, clientInfo ivan-check)
create or replace function public.lowdown_is_self_call(ua text, agent_id text, client_name text)
returns boolean language sql immutable as $$
  select public.lowdown_is_self_ua(ua)
      or coalesce(agent_id, '') = 'lowdown-self-test'
      or coalesce(client_name, '') = 'ivan-check'
$$;

-- ── Agent Observatory 집계 (2026-11-05_agents.sql 의 같은 함수 + Lowdown 자신 제외) ──
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
      and not lowdown_is_http_library(bot_name)
      and not lowdown_is_self_ua(user_agent);

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
      and not lowdown_is_self_call(user_agent, declared_agent_id, declared_client_name)
    group by 1, 2
  ), cn as (
    select lower(bot_name) as name_key, case when bot_kind in ('prober', 'crawler') then bot_kind else 'other' end as kind,
           jsonb_agg(c order by c) as client_names
    from (select distinct bot_name, bot_kind, left(declared_client_name, 100) as c from mcp_calls
          where rpc_method = 'initialize' and declared_client_name is not null and bot_name is not null
            and created_at >= v_from and created_at < v_now
            and not lowdown_is_self_call(user_agent, declared_agent_id, declared_client_name)) z
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
    'lowdown_self', jsonb_build_object(
      'requests', (select count(*) from edge_hits where created_at >= v_from and created_at < v_now and lowdown_is_self_ua(user_agent)),
      'mcp_messages', (select count(*) from mcp_calls where created_at >= v_from and created_at < v_now
                       and lowdown_is_self_call(user_agent, declared_agent_id, declared_client_name)),
      'note', 'Requests made by Lowdown itself (its daily Scanner, which also checks Lowdown''s own MCP Registry entry, and Lowdown''s tests). Kept in the records; not listed and not counted as visitors.'),
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
      'Lowdown''s own requests (Scanner and tests) are counted only in aggregates.lowdown_self.',
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

-- ── 상황판 집계 (2026-11-05_status.sql 의 같은 함수 + Lowdown 자신 제외) ──
create or replace function public.lowdown_status_compute()
returns bigint
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_now            timestamptz := now();
  v_bucket         timestamptz := date_trunc('hour', now());
  v_today          date := (now() at time zone 'UTC')::date;
  v_kst_day        text := to_char(now() at time zone 'Asia/Seoul', 'YYYY-MM-DD');
  v_id             bigint;
  v_prev_id        bigint;
  v_prev_at        timestamptz;
  v_prev           jsonb;
  v_prev_total     bigint;
  v_prev_last_id   bigint;
  v_baseline       boolean;
  v_first_snap     timestamptz;
  v_mcp_first      timestamptz;
  v_warm_snap      boolean;
  v_warm_mcp       boolean;
  v_started        date;
  v_d              date;
  v_streak         int := 0;
  v_obs_total      bigint;
  v_obs_last_id    bigint;
  v_obs_new        bigint;
  v_servers        int;
  v_p24 int; v_p30 int; v_c24 int; v_c30 int; v_ai24 bigint; v_ai30 bigint;
  v_mcp            jsonb;
  v_ok24           bigint;
  v_monitors       jsonb;
  v_dirs           jsonb;
  v_hl             jsonb;
  v_lines          jsonb;
  v_data           jsonb;
  v_t              numeric;
  v_max            numeric;
  r                record;
begin
  perform set_config('statement_timeout', '60s', true);
  perform pg_advisory_xact_lock(hashtext('lowdown_status_compute'));

  -- 같은 시간대는 처음 것 유지
  select id into v_id from status_snapshots where hour_bucket = v_bucket;
  if v_id is not null then return v_id; end if;

  select id, generated_at, data, obs_total, obs_last_id
    into v_prev_id, v_prev_at, v_prev, v_prev_total, v_prev_last_id
    from status_snapshots order by hour_bucket desc limit 1;
  v_baseline := v_prev_id is null;
  v_prev := coalesce(v_prev, '{}'::jsonb);
  select min(generated_at) into v_first_snap from status_snapshots;
  select min(created_at) into v_mcp_first from mcp_calls;
  v_warm_snap := v_first_snap is not null and v_first_snap <= v_now - interval '7 days';
  v_warm_mcp  := v_warm_snap and v_mcp_first is not null and v_mcp_first <= v_now - interval '7 days';

  -- 운영: 시작일, 연속 관측 일수(UTC 날짜), 관측 중인 서버, 누적 관측(증분)
  v_started := coalesce((v_prev #>> '{operation,started_on}')::date, (select min(observed_at) from scanner_observations)::date, v_today);
  v_d := v_today;
  if not exists (select 1 from scanner_observations where observed_at >= (v_d::timestamp at time zone 'UTC') and observed_at < ((v_d + 1)::timestamp at time zone 'UTC')) then
    v_d := v_d - 1; -- 오늘 실행 전이면 어제부터 센다
  end if;
  while v_d >= v_started and exists (
    select 1 from scanner_observations where observed_at >= (v_d::timestamp at time zone 'UTC') and observed_at < ((v_d + 1)::timestamp at time zone 'UTC')
  ) loop
    v_streak := v_streak + 1;
    v_d := v_d - 1;
  end loop;

  if v_prev_last_id is null or v_prev_total is null then
    select count(*), coalesce(max(id), 0) into v_obs_total, v_obs_last_id from scanner_observations;
  else
    select count(*), coalesce(max(id), v_prev_last_id) into v_obs_new, v_obs_last_id from scanner_observations where id > v_prev_last_id;
    v_obs_total := v_prev_total + v_obs_new;
  end if;

  select count(*) into v_servers from target_status_summary where latest_day >= v_today - 2;

  -- 방문자: 선언 이름 수 (edge_hits)
  select count(distinct bot_name) filter (where bot_kind = 'prober'  and created_at >= v_now - interval '1 day'),
         count(distinct bot_name) filter (where bot_kind = 'prober'),
         count(distinct bot_name) filter (where bot_kind = 'crawler' and created_at >= v_now - interval '1 day'),
         count(distinct bot_name) filter (where bot_kind = 'crawler'),
         count(*) filter (where bot_kind = 'ai_user' and created_at >= v_now - interval '1 day'),
         count(*) filter (where bot_kind = 'ai_user')
    into v_p24, v_p30, v_c24, v_c30, v_ai24, v_ai30
    from edge_hits where created_at >= v_now - interval '30 days' and not lowdown_is_self_ua(user_agent);

  -- 원격 MCP 단계 (mcp_calls, 테스트 제외)
  with m as (
    select * from mcp_calls
    where created_at >= v_now - interval '30 days'
      and not lowdown_is_self_call(user_agent, declared_agent_id, declared_client_name)
  ), w as (
    select '24h' as win, * from m where created_at >= v_now - interval '1 day'
    union all select '30d', * from m
  ), c as (
    select win,
           count(*) filter (where rpc_method = 'initialize') as initialize,
           count(*) filter (where rpc_method = 'tools/list') as tools_list,
           count(*) filter (where rpc_method = 'tools/call') as tools_call_attempts,
           count(*) filter (where rpc_method = 'tools/call' and outcome = 'ok') as tools_call_ok,
           count(*) filter (where rpc_method = 'tools/call' and outcome = 'tool_error') as tools_call_tool_error,
           count(*) filter (where rpc_method = 'tools/call' and outcome in ('rpc_error', 'http_error', 'unknown')) as tools_call_other_error,
           count(*) filter (where rpc_method = 'tools/call' and outcome = 'ok' and tool_name = 'get_lowdown') as ok_get_lowdown,
           count(*) filter (where rpc_method = 'tools/call' and outcome = 'ok' and tool_name = 'find_servers') as ok_find_servers
    from w group by win
  ), u as (
    select count(distinct user_agent) filter (where rpc_method = 'initialize') as initialize,
           count(distinct user_agent) filter (where rpc_method = 'tools/list') as tools_list,
           count(distinct user_agent) filter (where rpc_method = 'tools/call' and outcome = 'ok') as tools_call_ok
    from m where user_agent is not null
  )
  select jsonb_build_object(
    'recorded_since', (select to_char(min(created_at) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') from mcp_calls),
    'last_24h', coalesce((select to_jsonb(c) - 'win' from c where win = '24h'), '{}'::jsonb),
    'last_30d', coalesce((select to_jsonb(c) - 'win' from c where win = '30d'), '{}'::jsonb),
    'user_agents_30d', (select to_jsonb(u) from u)
  ) into v_mcp;
  v_ok24 := coalesce((v_mcp #>> '{last_24h,tools_call_ok}')::bigint, 0);

  -- 정기 모니터: prober 선언 이름, 30일, 5분 미만 간격 요청은 한 방문, 서로 다른 UTC 날짜 3일 이상 + 방문 간격 2개 이상
  with p as (
    select bot_name, created_at, user_agent from edge_hits
    where created_at >= v_now - interval '30 days' and bot_kind = 'prober' and bot_name is not null
      and not lowdown_is_self_ua(user_agent)
  ), g as (
    select bot_name, created_at,
           (lag(created_at) over (partition by bot_name order by created_at)) as prev_at
    from p
  ), v as (
    select bot_name, created_at as visit_start from g
    where prev_at is null or created_at - prev_at >= interval '5 minutes'
  ), gaps as (
    select bot_name, extract(epoch from visit_start - lag(visit_start) over (partition by bot_name order by visit_start)) / 60.0 as gap_min from v
  ), gs as (
    select bot_name, count(gap_min) as gap_count,
           percentile_cont(0.5) within group (order by gap_min) as median_gap
    from gaps group by bot_name
  ), days as (
    select bot_name, (created_at at time zone 'UTC')::date as d from p group by 1, 2
  ), third as (
    select bot_name, d as qualified_on from (
      select bot_name, d, row_number() over (partition by bot_name order by d) as rn from days) x
    where rn = 3
  ), agg as (
    select p.bot_name, min(created_at) as first_seen, max(created_at) as last_seen,
           count(distinct (created_at at time zone 'UTC')::date) as days_seen,
           (select count(*) from v where v.bot_name = p.bot_name) as visits
    from p group by p.bot_name
  ), ua as (
    select distinct on (bot_name) bot_name, left(user_agent, 200) as declared_user_agent from p order by bot_name, created_at desc
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'name', a.bot_name,
           'declared_user_agent', ua.declared_user_agent,
           'first_seen', to_char(a.first_seen at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
           'last_seen',  to_char(a.last_seen  at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
           'days_seen', a.days_seen,
           'visits', a.visits,
           'median_interval_minutes', case when gs.gap_count >= 2 then round(gs.median_gap::numeric, 1) end,
           'interval', case when gs.gap_count >= 2 then 'measured' else 'unknown' end,
           'qualified_on', t.qualified_on
         ) order by a.days_seen desc, a.visits desc, a.bot_name), '[]'::jsonb)
    into v_monitors
  from agg a
  join gs on gs.bot_name = a.bot_name
  join ua on ua.bot_name = a.bot_name
  left join third t on t.bot_name = a.bot_name
  where a.days_seen >= 3 and gs.gap_count >= 2;

  select coalesce(jsonb_agg(jsonb_build_object('name', name, 'url', url, 'status', status, 'confirmed_on', confirmed_on, 'note', note) order by confirmed_on, name), '[]'::jsonb)
    into v_dirs from status_directories;

  -- ── 성과·이정표 (기준선 스냅샷에서는 만들지 않음) ──
  if not v_baseline then
    -- 이정표: 이전 스냅샷 값 < 기준 <= 현재 값
    for r in
      select * from (values
        ('prober_names_30d', (v_prev #>> '{visitors,prober_names_30d}')::numeric, v_p30::numeric, array[50, 100, 200, 500, 1000]::numeric[],
         'names declaring an MCP check tool visited Lowdown in the last 30 days'),
        ('consecutive_observation_days', (v_prev #>> '{operation,consecutive_observation_days}')::numeric, v_streak::numeric, array[30, 60, 100, 200, 365]::numeric[],
         'consecutive days with daily checks'),
        ('observations_total', (v_prev #>> '{operation,observations_total}')::numeric, v_obs_total::numeric, array[1000000, 5000000, 10000000, 50000000]::numeric[],
         'recorded Scanner observations in total')
      ) as x(metric, prev_v, cur_v, thresholds, label)
    loop
      if r.prev_v is not null then
        foreach v_t in array r.thresholds loop
          if r.prev_v < v_t and r.cur_v >= v_t then
            insert into status_events (event_key, kind, occurred_at, text, detail)
            values ('milestone:' || r.metric || ':' || v_t, 'milestone', v_now,
                    v_kst_day || ': ' || to_char(v_t, 'FM999,999,999') || ' ' || r.label || '.',
                    jsonb_build_object('metric', r.metric, 'threshold', v_t, 'value', r.cur_v))
            on conflict (event_key) do nothing;
          end if;
        end loop;
      end if;
    end loop;

    -- 새 정기 모니터: 이전 스냅샷 목록에 없던 이름. 발생일 = 세 번째 서로 다른 날짜
    for r in
      select e->>'name' as name, (e->>'qualified_on')::date as qualified_on from jsonb_array_elements(v_monitors) e
      where not exists (select 1 from jsonb_array_elements(coalesce(v_prev->'regular_monitors', '[]'::jsonb)) pe where pe->>'name' = e->>'name')
    loop
      insert into status_events (event_key, kind, occurred_at, text, detail)
      values ('new_monitor:' || r.name, 'new_monitor', coalesce(r.qualified_on::timestamp at time zone 'UTC', v_now),
              coalesce(to_char(r.qualified_on, 'YYYY-MM-DD'), v_kst_day) || ': ' || r.name || ' became a regular visitor (seen on 3 different days).',
              jsonb_build_object('name', r.name))
      on conflict (event_key) do nothing;
    end loop;

    -- 새 디렉터리 등재
    for r in
      select e->>'name' as name, (e->>'confirmed_on')::date as confirmed_on from jsonb_array_elements(v_dirs) e
      where not exists (select 1 from jsonb_array_elements(coalesce(v_prev->'directories', '[]'::jsonb)) pe where pe->>'name' = e->>'name')
    loop
      insert into status_events (event_key, kind, occurred_at, text, detail)
      values ('new_directory:' || r.name, 'new_directory', r.confirmed_on::timestamp at time zone 'UTC',
              to_char(r.confirmed_on, 'YYYY-MM-DD') || ': Lowdown listed in ' || r.name || '.',
              jsonb_build_object('name', r.name))
      on conflict (event_key) do nothing;
    end loop;

    -- 최고 기록: 과거 전체 스냅샷과 비교. 같은 날(KST)은 한 줄, 더 높아지면 갱신
    if v_warm_snap then
      select max((data #>> '{visitors,prober_names_24h}')::numeric) into v_max from status_snapshots;
      if v_max is not null and v_p24 > v_max then
        insert into status_events (event_key, kind, occurred_at, text, detail)
        values ('record:prober_names_24h:' || v_kst_day, 'record', v_now,
                v_kst_day || ': ' || v_p24 || ' names declaring an MCP check tool visited Lowdown in 24 hours (highest recorded).',
                jsonb_build_object('metric', 'prober_names_24h', 'value', v_p24, 'previous_best', v_max))
        on conflict (event_key) do update set occurred_at = excluded.occurred_at, text = excluded.text, detail = excluded.detail
          where (status_events.detail->>'value')::numeric < (excluded.detail->>'value')::numeric;
      end if;
    end if;
    if v_warm_mcp then
      select max((data #>> '{remote_mcp,last_24h,tools_call_ok}')::numeric) into v_max from status_snapshots;
      if v_max is not null and v_ok24 > v_max then
        insert into status_events (event_key, kind, occurred_at, text, detail)
        values ('record:tools_call_ok_24h:' || v_kst_day, 'record', v_now,
                v_kst_day || ': ' || v_ok24 || ' successful tool calls on the remote MCP server in 24 hours (highest recorded).',
                jsonb_build_object('metric', 'tools_call_ok_24h', 'value', v_ok24, 'previous_best', v_max))
        on conflict (event_key) do update set occurred_at = excluded.occurred_at, text = excluded.text, detail = excluded.detail
          where (status_events.detail->>'value')::numeric < (excluded.detail->>'value')::numeric;
      end if;

      -- 첫 성공 호출: 선언 이름별로, mcp_calls 전체에서 가장 이른 성공 tools/call 이 직전 스냅샷 이후
      for r in
        select bot_name, min(created_at) as first_ok
        from mcp_calls
        where rpc_method = 'tools/call' and outcome = 'ok' and bot_name is not null
          and not lowdown_is_self_call(user_agent, declared_agent_id, declared_client_name)
        group by bot_name
        having min(created_at) > v_prev_at
      loop
        insert into status_events (event_key, kind, occurred_at, text, detail)
        values ('first_tool_call:' || r.bot_name, 'first_tool_call', r.first_ok,
                to_char(r.first_ok at time zone 'Asia/Seoul', 'YYYY-MM-DD') || ': first successful tool call from ' || r.bot_name || ' (User-Agent name).',
                jsonb_build_object('name', r.bot_name))
        on conflict (event_key) do nothing;
      end loop;
    end if;
  end if;

  -- 공개 강조: 최근 7일 발생분만 (기록 자체는 유지)
  select coalesce(jsonb_agg(jsonb_build_object('kind', kind, 'occurred_at', to_char(occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), 'text', text) order by occurred_at desc), '[]'::jsonb)
    into v_hl
  from (select * from status_events where occurred_at >= v_now - interval '7 days'
          and not lowdown_is_self_name(detail->>'name') order by occurred_at desc limit 10) e;

  -- 세 공개 위치가 같은 문장을 쓰도록 요약 문장도 여기서 만든다
  v_lines := jsonb_build_array(
    'Observing ' || to_char(v_servers, 'FM999,999,999') || ' MCP Registry servers with daily checks; ' ||
      to_char(v_obs_total, 'FM999,999,999') || ' Scanner observations recorded since ' || to_char(v_started, 'YYYY-MM-DD') || '.',
    to_char(v_streak, 'FM999,999') || ' consecutive days with daily checks.',
    'Last 30 days: ' || v_p30 || case when v_p30 = 1 then ' name' else ' names' end || ' declaring an MCP check tool and ' || v_c30 ||
      case when v_c30 = 1 then ' name' else ' names' end || ' declaring a crawler requested Lowdown (User-Agent declarations, not verified identities).',
    jsonb_array_length(v_monitors) || case when jsonb_array_length(v_monitors) = 1 then ' check tool' else ' check tools' end ||
      ' visited on 3 or more different days in the last 30 days.',
    'Remote MCP, last 30 days: ' || coalesce(v_mcp #>> '{last_30d,initialize}', '0') || ' initialize, ' ||
      coalesce(v_mcp #>> '{last_30d,tools_list}', '0') || ' tools/list, ' ||
      coalesce(v_mcp #>> '{last_30d,tools_call_attempts}', '0') || ' tools/call (' ||
      coalesce(v_mcp #>> '{last_30d,tools_call_ok}', '0') || ' succeeded). Recorded per message since ' ||
      coalesce(left(v_mcp->>'recorded_since', 10), 'n/a') || '.'
  );

  v_data := jsonb_build_object(
    'schema_version', 1,
    'snapshot_id', null,
    'generated_at', to_char(v_now at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'update_interval', 'hourly',
    'baseline', v_baseline,
    'windows', jsonb_build_object(
      'last_24h', jsonb_build_object('from', to_char((v_now - interval '1 day') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), 'to', to_char(v_now at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')),
      'last_30d', jsonb_build_object('from', to_char((v_now - interval '30 days') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), 'to', to_char(v_now at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))),
    'operation', jsonb_build_object(
      'started_on', v_started,
      'consecutive_observation_days', v_streak,
      'servers_observed', v_servers,
      'observations_total', v_obs_total),
    'visitors', jsonb_build_object(
      'prober_names_24h', v_p24, 'prober_names_30d', v_p30,
      'crawler_names_24h', v_c24, 'crawler_names_30d', v_c30,
      'ai_user_requests_24h', v_ai24, 'ai_user_requests_30d', v_ai30),
    'regular_monitors', v_monitors,
    'excluded_lowdown_self', jsonb_build_object(
      'requests_30d', (select count(*) from edge_hits where created_at >= v_now - interval '30 days' and lowdown_is_self_ua(user_agent)),
      'mcp_messages_30d', (select count(*) from mcp_calls where created_at >= v_now - interval '30 days'
                           and lowdown_is_self_call(user_agent, declared_agent_id, declared_client_name))),
    'remote_mcp', v_mcp,
    'directories', v_dirs,
    'highlights', v_hl,
    'highlight_rules', jsonb_build_object(
      'baseline', 'The first snapshot only sets a baseline and creates no highlights.',
      'milestone', 'A value crossed a fixed threshold since the previous snapshot.',
      'record', 'A 24-hour value is higher than in every earlier snapshot. Starts after 7 days of snapshots (tool calls: after 7 days of per-message records).',
      'first_tool_call', 'The earliest successful tools/call ever recorded for a User-Agent name. Starts after 7 days of per-message records.',
      'new_monitor', 'A name newly meets the regular monitor rule; dated by the third different day it was seen.',
      'visible_for', 'Highlights are listed for 7 days after they occur. Records are kept.',
      'records_active', v_warm_snap,
      'tool_call_highlights_active', v_warm_mcp),
    'summary_lines', v_lines,
    'definitions', jsonb_build_object(
      'servers_observed', 'MCP Registry servers whose latest daily check is at most 2 days old.',
      'observations_total', 'Rows in Lowdown Scanner observations (one row per probe of one remote).',
      'consecutive_observation_days', 'UTC days in a row, ending today or yesterday, with at least one Scanner observation.',
      'prober_names', 'Distinct names from User-Agent strings that declare a check, probe, scan, monitor, index or similar purpose. Names are taken from the declaration and are not verified identities; one operator may use several names and different operators may share one.',
      'crawler_names', 'Distinct names from User-Agent strings that declare bot, crawler or spider and do not declare a check purpose.',
      'ai_user_requests', 'Requests whose User-Agent belongs to an AI assistant acting for a person (for example Claude-User). Counted without names.',
      'regular_monitors', 'Check-tool names seen on at least 3 different UTC days in the last 30 days with at least 2 measured intervals. Requests less than 5 minutes apart count as one visit; the interval is the median time between visit starts, from actual request times. Otherwise the interval is unknown.',
      'declared_user_agent', 'The most recent User-Agent string sent under that name, as declared by the visitor. Lowdown adds no interpretation.',
      'remote_mcp', 'JSON-RPC messages received at /mcp. tools_call_attempts counts every tools/call; tools_call_ok counts only calls that returned a result without isError. User-agent counts are per User-Agent string, not per verified client, and do not form a single client''s path.',
      'excluded_test_traffic', 'Per-message records with x-agent-id lowdown-self-test or clientInfo name ivan-check are excluded from all counts.',
      'excluded_lowdown_self', 'Requests made by Lowdown itself: its daily Scanner (User-Agent lowdown-scanner/…, which also checks Lowdown''s own MCP Registry entry) and its tests (lowdown-test/…). They stay in the records and are left out of every visitor, monitor, remote MCP and highlight count; these are their totals.'),
    'limitations', jsonb_build_array(
      'All visitor names and kinds come from User-Agent declarations, which any client can change.',
      'Requests the operator makes through an AI assistant (for example Claude with the Lowdown connector) cannot be told apart from other users of that assistant.',
      'Scanner observations come from one network location and are not uptime measurements.')
  );

  insert into status_snapshots (hour_bucket, generated_at, schema_version, obs_total, obs_last_id, data)
  values (v_bucket, v_now, 1, v_obs_total, v_obs_last_id, v_data)
  on conflict (hour_bucket) do nothing
  returning id into v_id;
  if v_id is null then
    select id into v_id from status_snapshots where hour_bucket = v_bucket;
  else
    update status_snapshots set data = jsonb_set(data, '{snapshot_id}', to_jsonb(v_id)) where id = v_id;
  end if;
  return v_id;
end
$fn$;

revoke all on function public.lowdown_status_compute() from public, anon, authenticated;

-- 지금 바로 집계하지 않는다: 이번 시간대 스냅샷이 52·54분 전에 생기면 그 시각 cron 이 건너뛰어 갱신 시각이 어긋난다.

-- ── 확인 (52·54분 집계 뒤) ──
-- select data->'aggregates'->'lowdown_self' from agent_snapshots order by hour_bucket desc limit 1;
-- select data->'excluded_lowdown_self' from status_snapshots order by hour_bucket desc limit 1;
-- select e->>'name' from agent_snapshots s, jsonb_array_elements(s.data->'agents') e
--   where s.id = (select max(id) from agent_snapshots) and public.lowdown_is_self_name(e->>'name');   -- 0줄이면 정상
