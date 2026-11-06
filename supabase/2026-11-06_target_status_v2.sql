-- 2026-11-06: 대상별 연결 상태 요약 v2 — 순환 관찰(바깥 고리, source = 'scanner_rotating')을 예정된 점검 기준으로 센다.
-- Supabase SQL Editor 에서 실행, 여러 번 실행해도 안전. 2026-10-27_target_status_summary.sql · 2026-11-06_card_discovery.sql 뒤에 실행.
-- 설계: 프로젝트 문서 claude/lowdown-rotating-ring-2026-11-06.md
--
-- v1 과 같은 것: 하루 = UTC 날짜, 원격별 하루 상태(answered/auth_required/list_failed/no_response/invalid_response),
--   대상의 하루 상태(같으면 그 상태, 다르면 mixed), 30일 창, blocked_url 제외, 관측 원본은 건드리지 않음.
-- v2 에서 바뀌는 것:
--   1) 점검 간격(check_interval_days): 그날 매일 관찰 줄(고정 코호트·조회 대상·선언 주소) 행이 있으면 1,
--      순환 줄 행만 있으면 metadata.rotation.days (예: 3).
--   2) 연속(streak): 가장 최근 관찰부터 거꾸로, 상태가 같고 "다음 관찰까지 간격 ≤ 그 관찰의 점검 간격"인 동안 이어 센다.
--      매일 대상은 v1 과 같다(하루라도 빠지면 끊김). 순환 대상은 예정일에 빠짐없으면 사흘 간격이어도 이어진다.
--      streak_days 는 "이어진 점검 수"(매일 대상은 날 수와 같다).
--   3) 끊긴 이유: 예정 간격보다 긴 공백 → not_observed, 공백 없이 상태가 바뀜 → state_change,
--      창 첫날부터 이어짐 → window_start, 창 안에 더 이른 관찰 없음 → no_earlier_observation.
--   4) scheduled_checks_30d: 창 안 첫 관찰부터 마지막 관찰까지 그 간격으로 예정된 점검 수 (매일 대상은 날 수).
--   5) latest_observation_basis: fixed_cohort > on_request(조회·선언) > rotating.
-- 열은 v1 순서를 그대로 두고 끝에 두 개를 덧붙인다(check_interval_days, scheduled_checks_30d).
-- 공개용 target_status_summary 는 열이 늘어 다시 만든다. 그것을 참조하는 card_targets 도 같이 다시 만든다(정의 동일).

set statement_timeout = '10min';

begin;

insert into public.analysis_definitions (definition_id, version, description) values (
  'target_status', 2,
  'v1 rules plus scheduled checks: check_interval_days = 1 when a daily line (fixed cohort, on request, declared) observed the target that day, '
  || 'else metadata.rotation.days of the rotating line; streak = consecutive observations with the same state where the gap to the next '
  || 'observation is at most that interval; streak_break not_observed when the gap is longer; scheduled_checks_30d = checks expected '
  || 'at that interval from the first observation in the 30-day window to the latest; basis fixed_cohort > on_request > rotating.'
) on conflict (definition_id, version) do nothing;

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
    case when o.source = 'scanner_rotating' and o.metadata->'rotation'->>'days' ~ '^[1-7]$'
         then (o.metadata->'rotation'->>'days')::int end   as rot_days,
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
    target_id, day, remote, source, rot_days, tool_count,
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
-- 같은 날·같은 원격이 여러 줄(예: 매일 줄과 순환 줄)에 있으면 위에서 한 줄만 남는다 → 줄 정보는 원본에서 따로 모은다
day_lines as (
  select target_id, day,
         bool_or(source = 'scanner')            as fixed,
         bool_or(source <> 'scanner_rotating')  as daily,
         max(rot_days)                          as rot_days
  from obs
  group by target_id, day
),
state_counts as (
  select
    target_id, day, state,
    count(*)                                          as n,
    max(tool_count) filter (where state = 'answered') as tool_count
  from remote_day
  group by target_id, day, state
),
target_day as (
  select
    sc.target_id, sc.day,
    case when count(*) = 1 then min(sc.state) else 'mixed' end as state,
    jsonb_object_agg(sc.state, sc.n)                           as remote_states,
    sum(sc.n)::int                                             as remotes,
    max(sc.tool_count)                                         as tool_count,
    bool_or(dl.fixed)                                          as fixed,
    bool_or(dl.daily)                                          as daily,
    case when bool_or(dl.daily) then 1 else greatest(coalesce(max(dl.rot_days), 1), 1) end as iv
  from state_counts sc
  join day_lines dl using (target_id, day)
  group by sc.target_id, sc.day
),
ordered as (
  select td.*,
         first_value(td.state) over w as latest_state,
         lag(td.day) over w           as later_day,
         lag(td.iv) over w            as later_iv
  from target_day td
  window w as (partition by td.target_id order by td.day desc)
),
marked as (
  select o.*,
         (o.state <> o.latest_state or (o.later_day is not null and o.later_day - o.day > o.later_iv)) as brk
  from ordered o
),
cum as (
  select m.*,
         sum(case when m.brk then 1 else 0 end) over (partition by m.target_id order by m.day desc
                                                      rows between unbounded preceding and current row) as nbrk
  from marked m
),
latest as (
  select distinct on (target_id)
    target_id, day, state, remote_states, remotes, tool_count, fixed, daily, iv
  from target_day
  order by target_id, day desc
),
streak as (
  select target_id,
         (count(*) filter (where nbrk = 0))::int as streak_days,
         min(day) filter (where nbrk = 0)        as streak_start_day
  from cum
  group by target_id
),
first_break as (
  select distinct on (target_id) target_id, day, later_day, later_iv
  from cum
  where brk
  order by target_id, day desc
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
  case when l.fixed then 'fixed_cohort' when l.daily then 'on_request' else 'rotating' end as latest_observation_basis,
  s.streak_days,
  s.streak_start_day,
  case
    when fb.target_id is not null and fb.later_day - fb.day > fb.later_iv then 'not_observed'
    when fb.target_id is not null then 'state_change'
    when s.streak_start_day - (p.today - (p.window_days - 1)) < l.iv then 'window_start'
    else 'no_earlier_observation'
  end                                                      as streak_break,
  c.observed_days_30d,
  c.answered_days_30d,
  c.auth_required_days_30d,
  c.no_response_days_30d,
  c.mixed_days_30d,
  c.first_day_30d,
  'target_status'::text                                    as definition_id,
  2                                                        as definition_version,
  now()                                                    as computed_at,
  l.iv                                                     as check_interval_days,
  ((l.day - c.first_day_30d) / l.iv + 1)::int              as scheduled_checks_30d
from latest l
join streak s using (target_id)
join counts c using (target_id)
left join first_break fb using (target_id)
cross join params p;

revoke all on public.target_status_live from anon, authenticated;

-- 공개용: 열이 늘었으니 다시 만든다(참조하는 card_targets 도 함께)
drop materialized view if exists public.card_targets;
drop materialized view if exists public.target_status_summary;

create materialized view public.target_status_summary as
  select * from public.target_status_live;
create unique index target_status_summary_target_uq on public.target_status_summary (target_id);
grant select on public.target_status_summary to anon, authenticated;

-- card_targets: 2026-11-06_card_discovery.sql 과 같은 정의
create materialized view public.card_targets as
select e.id as endpoint_id,
       e.value as endpoint,
       array_agg(distinct r.value order by r.value) as registry_names,
       coalesce(bool_and(s.latest_state = 'no_response' and s.streak_days >= 7), false) as quiet
from subject_links l
join subject_ids e on e.id = l.to_id and e.scheme = 'endpoint'
join subject_ids r on r.id = l.from_id and r.scheme = 'registry'
left join target_status_summary s on s.target_id = 'mcp:' || r.value
where l.link_type = 'declares_remote' and l.declared_by = 'mcp_registry'
  and coalesce((e.attrs->>'https')::boolean, false)
  and not coalesce((e.attrs->>'templated')::boolean, false)
  and not coalesce((e.attrs->>'private_host')::boolean, true)
group by e.id, e.value;
create unique index card_targets_endpoint_id_uq on public.card_targets (endpoint_id);
revoke all on public.card_targets from anon, authenticated;

commit;

notify pgrst, 'reload schema';

-- 예약 갱신(lowdown-refresh-target-status, lowdown-card-targets-refresh)은 이름으로 같은 문장을 부르므로 그대로 둔다.
-- ── 확인 ─────────────────────────────────────────────────
-- select definition_version, latest_observation_basis, check_interval_days, count(*) from public.target_status_summary group by 1, 2, 3 order by 2, 3;
-- select * from public.target_status_summary where target_id = 'mcp:ai.trendsmcp/google-trends';
