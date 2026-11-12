-- 2026-11-13: 대상별 연결 상태 요약 v4 — 호스팅 차단 402 는 payment_required 가 아니라 no_response.
-- Supabase SQL Editor 에서 pack 으로 실행(concurrently 가 있어 pack 이 트랜잭션으로 감싸지 않음). 여러 번 실행해도 결과 같음.
-- 2026-11-12_target_status_v3.sql 뒤에 실행.
--
-- 바뀐 것은 원격별 하루 상태 규칙 한 줄: http_status = 402 이고 metadata.payment.cause = 'platform_limit' → 'no_response'
--   (payment_required 줄 바로 앞).
--   2026-11-13 조사: payment_required 402 중 76건이 결제 조건 없음(parse none). curl 로 보니 Vercel `X-Vercel-Error: DEPLOYMENT_DISABLED`,
--   Alpic `alpic/reason: request-limit-exceeded` 처럼 운영자의 호스팅 요금·한도 문제였다 — 에이전트에게 결제를 받는 서버가 아님.
-- cause 는 스캐너 0.6.2 부터 기록된다 → 0.6.2 이전 관측은 v3 와 같게 payment_required 로 남는다(원본을 다시 해석하지 않음).
-- 새 상태 값은 없다 → 코드 배포 순서 제약 없음. 열 이름·순서·형은 v3 와 같다(definition_version 값만 4).
-- 원본 관측(scanner_observations)은 건드리지 않는다.

set statement_timeout = '10min';

begin;

insert into public.analysis_definitions (definition_id, version, description) values (
  'target_status', 4,
  'v3 rules; an HTTP 402 that the scanner (0.6.2+) identified as a hosting-platform block (metadata.payment.cause = platform_limit, '
  || 'e.g. Vercel DEPLOYMENT_DISABLED, Alpic request limit) counts as no_response instead of payment_required.'
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
    o.metadata->'payment'->>'cause'                         as pay_cause,
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
      when http_status = 402 and pay_cause = 'platform_limit' then 'no_response'
      when http_status = 402 then 'payment_required'
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
  4                                                        as definition_version,
  now()                                                    as computed_at,
  l.iv                                                     as check_interval_days,
  ((l.day - c.first_day_30d) / l.iv + 1)::int              as scheduled_checks_30d
from latest l
join streak s using (target_id)
join counts c using (target_id)
left join first_break fb using (target_id)
cross join params p;

revoke all on public.target_status_live from anon, authenticated;

commit;

-- 공개용 요약 다시 계산(읽기를 막지 않게 concurrently). card_targets 는 열이 같아 그대로 둔다.
refresh materialized view concurrently public.target_status_summary;

notify pgrst, 'reload schema';

-- ── 확인 ─────────────────────────────────────────────────
-- select definition_version, latest_state, count(*) from public.target_status_summary group by 1, 2 order by 1, 3 desc;
-- select target_id, latest_day, latest_state, streak_days from public.target_status_summary where latest_state = 'payment_required' order by streak_days desc limit 20;
