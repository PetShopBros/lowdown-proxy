-- 2026-11-14: lowdown_status_compute — 방문 숫자를 측정 분류(claude/lowdown-measurement-plan-2026-11-14.md)에 맞춘다.
--   1) visitors 에 reads_24h/30d(크롤러·점검기·그 밖, AI 어시스턴트 표기 제외), ai_labeled_requests_24h/30d(AI 어시스턴트 표기 UA 가 /mcp 밖 —
--      서버 페이지·조회 등 — 을 연 요청), ai_mcp_requests_24h/30d(같은 UA 의 /mcp 요청)를 더한다.
--      기존 ai_user_requests_* 는 /mcp 연결 인사까지 세어 크게 보였다(7일 약 2,200건, 대부분 운영자 커넥터). 읽는 쪽이 있을 수 있어 한동안 그대로 두고 정의에 대체 키를 적는다.
--   2) 요약 문장에 읽힘·AI 표기 접근 한 줄. "사람이 물었다·답변에 쓰였다"는 뜻이 아님을 같은 문장에 적는다.
--   Lowdown 자신 제외는 lowdown_is_self_ua()(2026-11-14_access_metrics.sql 에서 lowdown-smoke 추가)를 그대로 쓴다.
-- 기준: 2026-11-08_status_operations.sql 의 정의(그 변경 포함). 그 파일 머리말:
--   2026-11-08: lowdown_status_compute — 성과 상황판 보완.
--     1) 요약 첫 줄·servers_observed 정의: 바깥 고리(순환 관찰) 반영("with daily checks" → "daily, or every few days in rotation").
--     2) operations(안정화 3-2): ops_daily 최신 날짜의 판정 개수·24시간 넘게 복구 안 된 수·주요 작업 마지막 성공 시각. 오류 내용 없음.
--        요약 문장(llms.txt·홈·status.json 공통)에 한 줄 추가.
--   기준: 2026-11-08_status_servers_interval.sql 의 정의(그 변경 포함).
--   적용: node scanner/migrations.ts pack supabase/2026-11-08_status_operations.sql --out $env:TEMP\pack.sql → Get-Content -Raw -Encoding UTF8 → SQL Editor.
-- 적용: node scanner/migrations.ts pack supabase/2026-11-14_status_access.sql --out $env:TEMP\pack.sql → Get-Content -Raw -Encoding UTF8 → SQL Editor.
set statement_timeout = '60s';

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
  v_al24 bigint; v_al30 bigint; v_am24 bigint; v_am30 bigint; v_r24 bigint; v_r30 bigint;
  v_mcp            jsonb;
  v_ok24           bigint;
  v_monitors       jsonb;
  v_dirs           jsonb;
  v_hl             jsonb;
  v_lines          jsonb;
  v_ops            jsonb;
  v_ops_day        date;
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

  -- 2026-11-08: 순환 관찰(바깥 고리) 대상은 점검 간격(check_interval_days)이 길다 → 간격 + 1일 안에 점검됐으면 "관측 중"으로 센다.
  --   매일 대상: 간격 1 → 2일 안(이전과 같음). 순환 3일: 4일 안(api/find.ts ROTATING_STALE_DAYS 와 같음).
  select count(*) into v_servers from target_status_summary where latest_day >= v_today - (coalesce(check_interval_days, 1) + 1);

  -- 방문자: 선언 이름 수 (edge_hits)
  select count(distinct bot_name) filter (where bot_kind = 'prober'  and created_at >= v_now - interval '1 day'),
         count(distinct bot_name) filter (where bot_kind = 'prober'),
         count(distinct bot_name) filter (where bot_kind = 'crawler' and created_at >= v_now - interval '1 day'),
         count(distinct bot_name) filter (where bot_kind = 'crawler'),
         count(*) filter (where bot_kind = 'ai_user' and created_at >= v_now - interval '1 day'),
         count(*) filter (where bot_kind = 'ai_user'),
         -- 2026-11-14: AI 어시스턴트 표기를 /mcp 밖(서버 페이지·조회 등)과 /mcp 로 나누고, 그 밖 요청은 읽힘으로
         count(*) filter (where bot_kind = 'ai_user' and path !~ '^/mcp(\?|/|$)' and created_at >= v_now - interval '1 day'),
         count(*) filter (where bot_kind = 'ai_user' and path !~ '^/mcp(\?|/|$)'),
         count(*) filter (where bot_kind = 'ai_user' and path ~ '^/mcp(\?|/|$)' and created_at >= v_now - interval '1 day'),
         count(*) filter (where bot_kind = 'ai_user' and path ~ '^/mcp(\?|/|$)'),
         count(*) filter (where bot_kind is distinct from 'ai_user' and created_at >= v_now - interval '1 day'),
         count(*) filter (where bot_kind is distinct from 'ai_user')
    into v_p24, v_p30, v_c24, v_c30, v_ai24, v_ai30, v_al24, v_al30, v_am24, v_am30, v_r24, v_r30
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

  -- 운영 상태(안정화 3단계, ops_daily: 하루 1회 12:37 KST 판정). 상태·시각·개수만 — 오류 내용은 넣지 않는다.
  select max(day) into v_ops_day from ops_daily;
  if v_ops_day is not null then
    select jsonb_build_object(
      'checked_on', v_ops_day,
      'computed_at', to_char(max(computed_at) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
      'checks', count(*),
      'ok', count(*) filter (where status = 'ok'),
      'needs_attention', count(*) filter (where status in ('failing', 'stale', 'error')),
      'unrecovered_over_24h', count(*) filter (where status in ('failing', 'stale') and failing_since is not null and computed_at - failing_since > interval '24 hours'),
      'last_success', jsonb_build_object(
        'daily_observation', to_char(max(last_success_at) filter (where check_id = 'scanner/scan') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
        'daily_report', to_char(max(last_success_at) filter (where check_id = 'scanner/report') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
        'backup', to_char(max(last_success_at) filter (where check_id = 'backup') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
        'latest_observation', to_char(max(last_at) filter (where check_id = 'db/scanner_observations') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')))
      into v_ops
    from ops_daily where day = v_ops_day;
  end if;

  -- 세 공개 위치가 같은 문장을 쓰도록 요약 문장도 여기서 만든다
  v_lines := jsonb_build_array(
    'Observing ' || to_char(v_servers, 'FM999,999,999') || ' MCP Registry servers (checked daily, or every few days in rotation); ' ||
      to_char(v_obs_total, 'FM999,999,999') || ' Scanner observations recorded since ' || to_char(v_started, 'YYYY-MM-DD') || '.',
    to_char(v_streak, 'FM999,999') || ' consecutive days with daily checks.',
    'Last 30 days: ' || v_p30 || case when v_p30 = 1 then ' name' else ' names' end || ' declaring an MCP check tool and ' || v_c30 ||
      case when v_c30 = 1 then ' name' else ' names' end || ' declaring a crawler requested Lowdown (User-Agent declarations, not verified identities).',
    'Last 30 days: ' || to_char(v_r30, 'FM999,999,999') || ' requests from crawlers, check tools and other clients; ' ||
      to_char(v_al30, 'FM999,999,999') || case when v_al30 = 1 then ' request' else ' requests' end ||
      ' to server pages or lookups from clients declaring an AI assistant (for example ChatGPT-User). A declaration, not proof that a person asked or that an answer used it.',
    jsonb_array_length(v_monitors) || case when jsonb_array_length(v_monitors) = 1 then ' check tool' else ' check tools' end ||
      ' visited on 3 or more different days in the last 30 days.',
    'Remote MCP, last 30 days: ' || coalesce(v_mcp #>> '{last_30d,initialize}', '0') || ' initialize, ' ||
      coalesce(v_mcp #>> '{last_30d,tools_list}', '0') || ' tools/list, ' ||
      coalesce(v_mcp #>> '{last_30d,tools_call_attempts}', '0') || ' tools/call (' ||
      coalesce(v_mcp #>> '{last_30d,tools_call_ok}', '0') || ' succeeded). Recorded per message since ' ||
      coalesce(left(v_mcp->>'recorded_since', 10), 'n/a') || '.'
  ) || case when v_ops is null then '[]'::jsonb else jsonb_build_array(
    'Operations, checked ' || (v_ops->>'checked_on') || ': ' || (v_ops->>'ok') || ' of ' || (v_ops->>'checks') ||
      ' daily jobs and data feeds OK; ' || (v_ops->>'unrecovered_over_24h') ||
      case when (v_ops->>'unrecovered_over_24h')::int = 1 then ' has' else ' have' end || ' been failing for more than 24 hours.') end;

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
      'ai_user_requests_24h', v_ai24, 'ai_user_requests_30d', v_ai30,
      'reads_24h', v_r24, 'reads_30d', v_r30,
      'ai_labeled_requests_24h', v_al24, 'ai_labeled_requests_30d', v_al30,
      'ai_mcp_requests_24h', v_am24, 'ai_mcp_requests_30d', v_am30),
    'regular_monitors', v_monitors,
    'excluded_lowdown_self', jsonb_build_object(
      'requests_30d', (select count(*) from edge_hits where created_at >= v_now - interval '30 days' and lowdown_is_self_ua(user_agent)),
      'mcp_messages_30d', (select count(*) from mcp_calls where created_at >= v_now - interval '30 days'
                           and lowdown_is_self_call(user_agent, declared_agent_id, declared_client_name))),
    'remote_mcp', v_mcp,
    'directories', v_dirs,
    'operations', v_ops,
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
      'servers_observed', 'MCP Registry servers checked within their check interval plus one day: servers checked daily within the last 2 days, servers checked in rotation (every check_interval_days days) within that interval plus one day.',
      'operations', 'Lowdown''s own daily jobs (checks, reports, backups, package snapshots) and data feeds, judged once a day: ok, failing (the latest run failed), stale (no success within the expected interval) or error (could not be checked). States, times and counts only; no error details. unrecovered_over_24h counts items failing or stale for more than 24 hours.',
      'observations_total', 'Rows in Lowdown Scanner observations (one row per probe of one remote).',
      'consecutive_observation_days', 'UTC days in a row, ending today or yesterday, with at least one Scanner observation.',
      'prober_names', 'Distinct names from User-Agent strings that declare a check, probe, scan, monitor, index or similar purpose. Names are taken from the declaration and are not verified identities; one operator may use several names and different operators may share one.',
      'crawler_names', 'Distinct names from User-Agent strings that declare bot, crawler or spider and do not declare a check purpose.',
      'ai_user_requests', 'Requests whose User-Agent belongs to an AI assistant acting for a person (for example Claude-User), including /mcp connection messages. Counted without names. Kept for existing readers; use ai_labeled_requests and ai_mcp_requests.',
      'reads', 'Requests from clients that do not declare an AI assistant: crawlers, check tools and unnamed clients. Shows that Lowdown is read, not that anyone needs it.',
      'ai_labeled_requests', 'Requests to pages other than /mcp (server pages, lookups, lists) whose User-Agent declares an AI assistant acting for a person (for example ChatGPT-User). The User-Agent is a declaration; this does not show that a person asked a question or that an answer used the page.',
      'ai_mcp_requests', 'Requests to /mcp whose User-Agent declares an AI assistant, including connection messages. Requests the operator makes through such an assistant are included and cannot be told apart.',
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
