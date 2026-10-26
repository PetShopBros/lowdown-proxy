-- 2026-10-27: 대상별 연결 상태 요약 — Supabase SQL Editor 에서 실행, 여러 번 실행해도 안전
--
-- 목적: GET /api/reputation/:target 의 첫 문장이 "지금 연결하면 응답하는가"를 관찰 사실로 말하게 한다.
--   API 는 요청 때 계산하지 않고, 미리 계산된 target_status_summary 에서 1행만 읽는다.
--
-- 규칙 (target_status v1):
--   1) 하루 = UTC 날짜. 같은 날 같은 원격(remote_url)의 행이 여러 개면 가장 높은 단계(재시도 포함)를 쓴다.
--   2) 원격별 하루 상태:
--        answered         initialize + tools/list 응답 (재시도 결과 포함)
--        auth_required    HTTP 401/403 (인증 없이 관찰했으므로 응답 내용은 모름)
--        list_failed      initialize 는 응답, tools/list 는 실패
--        no_response      timeout·dns·tls·연결 거부/끊김·network_error, HTTP 404·5xx
--        invalid_response 그 밖 (MCP 형식이 아닌 응답 등)
--      blocked_url(Scanner 가 호출하지 않은 행)은 관찰로 세지 않는다.
--   3) 대상의 하루 상태: 관찰된 원격의 상태가 모두 같으면 그 상태, 다르면 mixed (원격별 개수는 remote_states 에).
--      한 원격의 answered 로 서버 전체를 answered 로 말하지 않는다.
--   4) 연속(streak): 가장 최근 관찰일부터 거꾸로, 달력상 하루도 빠짐없이 같은 상태인 날 수.
--      관찰이 없는 날에서 끊는다(실패로 세지 않는다). 끊긴 이유는 streak_break:
--        state_change            전날 관찰이 있고 상태가 달랐다
--        not_observed            전날 관찰이 없다 (Scanner 미실행, 코호트 제외 등)
--        no_earlier_observation  창(30일) 안에 그보다 이른 관찰이 없다
--        window_start            창(30일)의 첫날까지 이어진다 (그 이전은 이 요약이 보지 않는다)
--   5) 관찰이 없다는 것은 아무 상태도 아니다. 최근 관찰이 오래됐는지는 API 가 latest_day 와 현재 날짜로 판단한다.
--   6) 고정 표본(source = 'scanner')과 조회 기반 관찰(source = 'scanner_requested')을 모두 쓴다.
--      그날 고정 표본 행이 있으면 latest_observation_basis = fixed_cohort, 아니면 on_request.
--   관측 원본(scanner_observations)은 건드리지 않는다.

set statement_timeout = '10min';

begin;

-- ── 분석 정의 기록 ───────────────────────────────────────
-- 응답에 definition_id / definition_version 을 싣는다. 규칙을 바꾸면 version 을 올리고 행을 추가한다(기존 행은 고치지 않는다).
create table if not exists public.analysis_definitions (
  definition_id text        not null,
  version       integer     not null,
  description   text        not null,
  created_at    timestamptz not null default now(),
  primary key (definition_id, version)
);

alter table public.analysis_definitions enable row level security;
revoke all on public.analysis_definitions from anon, authenticated;

insert into public.analysis_definitions (definition_id, version, description) values (
  'target_status', 1,
  'UTC day; per remote the best level of the day incl. retry; states answered/auth_required/list_failed/no_response/invalid_response; '
  || 'target day = common state of observed remotes, else mixed; streak = consecutive calendar days with the same state, '
  || 'broken by a day without observation (streak_break: state_change/not_observed/no_earlier_observation/window_start); '
  || '30-day window; blocked_url rows excluded.'
) on conflict (definition_id, version) do nothing;

-- ── 계산용 뷰 (비공개) ───────────────────────────────────
create or replace view public.target_status_live as
with params as (
  select (now() at time zone 'utc')::date as today, 30 as window_days
),
obs as (
  select
    o.target_id,
    (o.observed_at at time zone 'utc')::date               as day,
    coalesce(o.metadata->>'remote_url', '')                as remote,
    o.source,
    greatest(
      o.reached_level,
      case when o.metadata->'retry'->>'reached_level' ~ '^[0-2]$'
           then (o.metadata->'retry'->>'reached_level')::int else 0 end
    )                                                      as lvl,
    o.http_status,
    o.error_type,
    case when o.metadata->>'tool_count' ~ '^[0-9]{1,6}$'
         then (o.metadata->>'tool_count')::int end         as tool_count,
    o.observed_at
  from public.scanner_observations o
  cross join params p
  where o.observed_at >= ((p.today - (p.window_days - 1))::timestamp at time zone 'utc')
    and o.error_type is distinct from 'blocked_url'
),
remote_day as (
  select distinct on (target_id, day, remote)
    target_id, day, remote, source, tool_count,
    case
      when lvl = 2 then 'answered'
      when http_status in (401, 403) then 'auth_required'
      when lvl = 1 then 'list_failed'
      when error_type in ('timeout', 'dns', 'tls', 'conn_refused', 'conn_reset', 'network_error')
        or http_status = 404 or http_status >= 500 then 'no_response'
      else 'invalid_response'
    end as state
  from obs
  order by target_id, day, remote, lvl desc, observed_at desc
),
state_counts as (
  select
    target_id, day, state,
    count(*)                                          as n,
    max(tool_count) filter (where state = 'answered') as tool_count,
    bool_or(source = 'scanner')                       as fixed
  from remote_day
  group by target_id, day, state
),
target_day as (
  select
    target_id, day,
    case when count(*) = 1 then min(state) else 'mixed' end as state,
    jsonb_object_agg(state, n)                              as remote_states,
    sum(n)::int                                             as remotes,
    max(tool_count)                                         as tool_count,
    bool_or(fixed)                                          as fixed
  from state_counts
  group by target_id, day
),
numbered as (
  -- 달력상 연속이고 상태가 같은 날들은 같은 grp 를 갖는다 (날짜가 하루 줄 때 순번이 하나 는다)
  select td.*,
         td.day + (row_number() over (partition by td.target_id, td.state order by td.day desc))::int as grp
  from target_day td
),
latest as (
  select distinct on (target_id)
    target_id, day, state, remote_states, remotes, tool_count, fixed, grp
  from numbered
  order by target_id, day desc
),
streak as (
  select l.target_id, count(*)::int as streak_days, min(n.day) as streak_start_day
  from latest l
  join numbered n on n.target_id = l.target_id and n.state = l.state and n.grp = l.grp
  group by l.target_id
),
counts as (
  select
    target_id,
    count(*)::int                                            as observed_days_30d,
    count(*) filter (where state = 'answered')::int         as answered_days_30d,
    count(*) filter (where state = 'auth_required')::int    as auth_required_days_30d,
    count(*) filter (where state = 'no_response')::int      as no_response_days_30d,
    count(*) filter (where state = 'mixed')::int            as mixed_days_30d,
    min(day)                                                 as first_day_30d
  from target_day
  group by target_id
)
select
  l.target_id,
  l.day                                                    as latest_day,
  l.state                                                  as latest_state,
  l.remote_states                                          as latest_remote_states,
  l.remotes                                                as latest_remotes,
  l.tool_count                                             as latest_tool_count,
  case when l.fixed then 'fixed_cohort' else 'on_request' end as latest_observation_basis,
  s.streak_days,
  s.streak_start_day,
  case
    when s.streak_start_day = p.today - (p.window_days - 1) then 'window_start'
    when s.streak_start_day = c.first_day_30d then 'no_earlier_observation'
    when exists (select 1 from target_day t
                 where t.target_id = l.target_id and t.day = s.streak_start_day - 1) then 'state_change'
    else 'not_observed'
  end                                                      as streak_break,
  c.observed_days_30d,
  c.answered_days_30d,
  c.auth_required_days_30d,
  c.no_response_days_30d,
  c.mixed_days_30d,
  c.first_day_30d,
  'target_status'::text                                    as definition_id,
  1                                                        as definition_version,
  now()                                                    as computed_at
from latest l
join streak s using (target_id)
join counts c using (target_id)
cross join params p;

revoke all on public.target_status_live from anon, authenticated;

-- ── 공개용 미리 계산된 결과 ──────────────────────────────
create materialized view if not exists public.target_status_summary as
  select * from public.target_status_live;

create unique index if not exists target_status_summary_target_uq on public.target_status_summary (target_id);

grant select on public.target_status_summary to anon, authenticated;

commit;

-- ── 갱신: 스캔이 끝난 뒤 하루 2번 (UTC 03:37, 14:37 = KST 12:37, 23:37) ─────
-- 본 스캔 UTC 01:17(최대 45분), 예비 스캔 UTC 13:17. 요청 때는 계산하지 않는다.
create extension if not exists pg_cron with schema pg_catalog;

do $$
begin
  if exists (select 1 from cron.job where jobname = 'lowdown-refresh-target-status') then
    perform cron.unschedule('lowdown-refresh-target-status');
  end if;
end $$;

select cron.schedule(
  'lowdown-refresh-target-status',
  '37 3,14 * * *',
  'refresh materialized view concurrently public.target_status_summary'
);

notify pgrst, 'reload schema';

-- ── 확인 ─────────────────────────────────────────────────
-- 1) 공개 권한: live 는 false, summary 는 true
-- select has_table_privilege('anon', 'public.target_status_live', 'select')    as live_anon,
--        has_table_privilege('anon', 'public.target_status_summary', 'select') as summary_anon;
-- 2) 상태 분포 (고정 표본만)
-- select latest_state, count(*) from public.target_status_summary
-- where latest_observation_basis = 'fixed_cohort' group by 1 order by 2 desc;
-- 3) 한 대상
-- select * from public.target_status_summary where target_id = 'mcp:ai.trendsmcp/google-trends';
--
-- 되돌리기 (필요할 때만):
-- select cron.unschedule('lowdown-refresh-target-status');
-- drop materialized view public.target_status_summary;
-- drop view public.target_status_live;
