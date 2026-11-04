-- 2026-11-05: Lowdown Public Status v1 — 매시간 상황판 스냅샷 (Supabase SQL Editor 에서 실행, 여러 번 실행해도 안전)
--
-- 구조:
--   lowdown_status_compute()  매시 52분(pg_cron) 한 번 집계 → status_snapshots 에 1줄(JSON) 누적. 지우지 않는다.
--   /status.json · /llms.txt · 홈 은 모두 가장 최근 스냅샷 1줄만 읽는다 → 방문이 많아도 집계는 시간당 1회.
--   status_events            성과·이정표 기록(실제 발생 시각). 지우지 않는다. 공개 강조 목록에는 최근 7일만 나온다.
--   status_directories       확인된 디렉터리 등재(사람이 넣는다).
--
-- 원칙:
--   - 이름 수는 User-Agent 선언에서 뽑은 이름의 수다. 운영 주체가 서로 다르다는 인증이 아니다.
--   - 테스트 제외: mcp_calls 에서 declared_agent_id = 'lowdown-self-test' 이거나 declared_client_name = 'ivan-check' 인 줄은 모든 집계에서 뺀다.
--     edge_hits 는 헤더를 저장하지 않아 이 제외가 없다(테스트 요청은 브라우저 형식 UA 라 이름 집계에 들어가지 않는다).
--   - 같은 시간대(hour_bucket)에 두 번 실행되면 새 줄을 만들지 않고 처음 것을 둔다. 실패하면 줄이 생기지 않아 직전 스냅샷이 계속 공개된다.
--   - 첫 스냅샷은 기준선(baseline): 강조를 만들지 않는다. 최고 기록·첫 성공 호출 강조는 스냅샷·mcp_calls 이력이 7일 쌓인 뒤부터.

set statement_timeout = '5min';

-- 연속 관측 일수 계산용 (관측 시각 범위 조회)
create index if not exists scanner_obs_observed_idx on public.scanner_observations (observed_at);

-- ── 표 ─────────────────────────────────────────────────
create table if not exists public.status_snapshots (
  id              bigint generated always as identity primary key,
  hour_bucket     timestamptz not null unique,   -- 같은 시간대 1줄(멱등)
  generated_at    timestamptz not null default now(),
  schema_version  int         not null,
  obs_total       bigint,                         -- 누적 관측 건수(증분 계산용)
  obs_last_id     bigint,                         -- 마지막으로 센 scanner_observations.id
  data            jsonb       not null
);
alter table public.status_snapshots enable row level security;
drop policy if exists status_snapshots_read on public.status_snapshots;
create policy status_snapshots_read on public.status_snapshots for select to anon, authenticated using (true);
revoke insert, update, delete on public.status_snapshots from anon, authenticated;
grant select on public.status_snapshots to anon, authenticated;

create table if not exists public.status_events (
  id           bigint generated always as identity primary key,
  event_key    text        not null unique,       -- 같은 일을 두 번 기록하지 않는다
  kind         text        not null check (kind in ('milestone', 'record', 'first_tool_call', 'new_monitor', 'new_directory')),
  occurred_at  timestamptz not null,              -- 실제로 일어난 시각(날)
  detected_at  timestamptz not null default now(),
  text         text        not null,
  detail       jsonb       not null default '{}'::jsonb
);
alter table public.status_events enable row level security;
revoke all on public.status_events from anon, authenticated;

create table if not exists public.status_directories (
  name          text primary key,
  url           text,
  status        text not null default 'listed',
  confirmed_on  date not null,
  note          text
);
alter table public.status_directories enable row level security;
revoke all on public.status_directories from anon, authenticated;
insert into public.status_directories (name, url, status, confirmed_on, note)
values ('Claude connector directory', null, 'listed', '2026-11-02', 'Submission portal status: published')
on conflict (name) do nothing;

-- ── 집계 함수 ───────────────────────────────────────────
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
    from edge_hits where created_at >= v_now - interval '30 days';

  -- 원격 MCP 단계 (mcp_calls, 테스트 제외)
  with m as (
    select * from mcp_calls
    where created_at >= v_now - interval '30 days'
      and coalesce(declared_agent_id, '') <> 'lowdown-self-test'
      and coalesce(declared_client_name, '') <> 'ivan-check'
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
          and coalesce(declared_agent_id, '') <> 'lowdown-self-test'
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
  from (select * from status_events where occurred_at >= v_now - interval '7 days' order by occurred_at desc limit 10) e;

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
      'excluded_test_traffic', 'Per-message records with x-agent-id lowdown-self-test or clientInfo name ivan-check are excluded from all counts.'),
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

-- ── 매시 52분 실행 (pg_cron) ────────────────────────────
-- 기존 갱신(:07 scanner_summary, :27 sandbox_summary, :37 target_status)과 겹치지 않게 52분.
create extension if not exists pg_cron with schema pg_catalog;
do $$
begin
  if exists (select 1 from cron.job where jobname = 'lowdown-status-snapshot') then
    perform cron.unschedule('lowdown-status-snapshot');
  end if;
end $$;
select cron.schedule('lowdown-status-snapshot', '52 * * * *', 'select public.lowdown_status_compute()');

-- 첫 스냅샷(기준선)을 바로 만든다
select public.lowdown_status_compute();

-- ── 확인용 ─────────────────────────────────────────────
-- select id, hour_bucket, generated_at, data->'summary_lines' from status_snapshots order by hour_bucket desc limit 3;
-- select jsonb_pretty(data) from status_snapshots order by hour_bucket desc limit 1;
-- select kind, occurred_at, text from status_events order by occurred_at desc limit 20;
-- select start_time, status, return_message from cron.job_run_details
--   where jobid = (select jobid from cron.job where jobname = 'lowdown-status-snapshot') order by start_time desc limit 5;
-- 디렉터리 추가: insert into status_directories (name, url, confirmed_on, note) values ('...', 'https://...', '2026-11-xx', '...');
