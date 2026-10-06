-- Lowdown v0.4 — Scanner (Supabase SQL Editor에서 실행, 여러 번 실행해도 안전)
-- 원칙: scanner_observations 는 "우리가 관찰한 사실"만 담는다. interactions(실제 에이전트 사용)와 섞지 않는다.
--   reached_level: 0 = initialize 성공 못 함 / 1 = initialize 성공 / 2 = initialize + tools/list 성공
--   http_status  : 401/403 도 해석 없이 숫자 그대로 (해석은 조회 시점에)
--   target_id    : 'mcp:' + Registry 이름 (예: mcp:io.github.user/server)

create table if not exists scanner_observations (
  id            bigint generated always as identity primary key,
  scan_run_id   uuid        not null,
  node_id       text        not null,
  target_id     text        not null,
  target_type   text        not null default 'mcp_server',
  observed_at   timestamptz not null default now(),
  transport     text,
  http_status   smallint,
  reached_level smallint    not null default 0
                            check (reached_level between 0 and 2),
  latency_ms    integer,
  error_type    text,
  source        text        not null default 'scanner',
  metadata      jsonb       not null default '{}'::jsonb
);

create index if not exists scanner_obs_target_time_idx
  on scanner_observations (target_id, observed_at desc);

create index if not exists scanner_obs_run_idx
  on scanner_observations (scan_run_id);

-- insert 재시도(응답 유실) 시 중복 행 방지: 같은 run 안에서 (target, remote_url)은 1행
create unique index if not exists scanner_obs_run_target_remote_uq
  on scanner_observations (scan_run_id, target_id, ((metadata->>'remote_url')));

-- 원본 테이블은 공개하지 않는다 (policy 없음). Scanner 는 service key 로만 쓴다.
alter table scanner_observations enable row level security;

-- ─────────────────────────────────────────────
-- 공개 조회용 집계 view: GET /api/reputation/:target 의 `scanner` 블록이 읽는다.
-- - 최근 30일, Scanner 가 호출하지 않은 행(error_type = 'blocked_url')은 제외
-- - node_id / 원본 metadata / remote_url 은 노출하지 않는다
-- - server_version 은 안전한 문자만 허용 (원격 서버가 보낸 문자열이 에이전트에 그대로 전달되지 않도록)
-- - 원격이 여러 개인 서버는 하나로 합산된다 (latest = 가장 최근에 관찰된 행)
-- view 는 소유자 권한으로 실행되어 원본 테이블의 RLS 를 거치지 않는다.
-- ─────────────────────────────────────────────
create or replace view scanner_summary as
with recent as (
  select *
  from scanner_observations
  where observed_at > now() - interval '30 days'
    and error_type is distinct from 'blocked_url'
),
latest as (
  select distinct on (target_id)
    target_id,
    observed_at                          as last_observed_at,
    reached_level                        as latest_reached_level,
    http_status                          as latest_http_status,
    error_type                           as latest_error_type,
    latency_ms                           as latest_latency_ms,
    case when metadata->>'tool_count' ~ '^[0-9]{1,6}$'
         then (metadata->>'tool_count')::int end            as latest_tool_count,
    left(metadata->>'schema_hash', 16)                      as latest_schema_hash,
    case when metadata->>'server_version' ~ '^[0-9A-Za-z.+_-]{1,32}$'
         then metadata->>'server_version' end               as latest_server_version
  from recent
  order by target_id, observed_at desc
),
agg as (
  select
    target_id,
    count(*)                                  as observations_30d,
    count(distinct metadata->>'remote_url')   as remotes_observed,
    count(distinct metadata->>'schema_hash')  as schema_versions_30d
  from recent
  group by target_id
),
dist as (
  select target_id, jsonb_object_agg(k, n) as status_distribution_30d
  from (
    select target_id,
           coalesce(http_status::text, error_type, 'unknown') as k,
           count(*) as n
    from recent
    group by target_id, 2
  ) s
  group by target_id
)
select
  l.*,
  a.observations_30d,
  a.remotes_observed,
  a.schema_versions_30d,
  d.status_distribution_30d
from latest l
join agg  a using (target_id)
join dist d using (target_id);

grant select on scanner_summary to anon, authenticated;

-- ─────────────────────────────────────────────
-- 조회 유입 측정: GET /api/reputation/:target?ref=report
-- (API 는 ref 가 있을 때만 이 컬럼에 쓴다. 이 컬럼이 없어도 기존 조회 로깅은 영향 없음)
-- ─────────────────────────────────────────────
alter table reputation_lookups add column if not exists ref text;

-- ─────────────────────────────────────────────
-- 7일 PoC 통과 확인 (매일 행이 쌓였고, reached_level >= 1 이 존재하는가)
-- ─────────────────────────────────────────────
-- select (observed_at at time zone 'Asia/Seoul')::date as day,
--        count(distinct scan_run_id)                   as runs,
--        count(*)                                      as rows,
--        count(*) filter (where reached_level >= 1)    as l1_plus,
--        count(*) filter (where reached_level = 2)     as l2
-- from scanner_observations
-- where observed_at > now() - interval '8 days'
-- group by 1
-- order by 1;

-- 외부 조회 유입 (organic 만, 본인 확인용 조회는 x-lowdown-source: seeded 로 보낸다)
-- select ref, count(*) from reputation_lookups
-- where source = 'organic' and ref is not null and created_at > now() - interval '30 days'
-- group by 1 order by 2 desc;
