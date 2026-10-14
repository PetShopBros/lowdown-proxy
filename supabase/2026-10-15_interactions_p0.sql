-- P0 (2026-10-15): interactions 기록 정확성
-- 1) 컬럼 추가 (전부 nullable — 기존 행·기존 클라이언트에 영향 없음)
-- 2) failure_type 값 제약
-- 3) reputation_summary 재정의: 컬럼 이름·순서 유지, 새 컬럼은 뒤에 추가
--
-- 성공률 기준 (rated):
--   source = 'organic'
--   AND error_layer 가 'request'(잘못된 요청: -32700/-32600/-32601/-32602) 가 아님
--   AND request_kind 가 tool_call / reported
--       (request_kind 가 없는 0.1.16 이하 기록은 initialize·tools/list 같은 비도구 요청만 빼고 포함)
-- interactions 컬럼은 전체 행 수 그대로. 성공률 분모는 rated_interactions.

alter table public.interactions add column if not exists request_kind     text;
alter table public.interactions add column if not exists error_layer      text;
alter table public.interactions add column if not exists server_version   text;
alter table public.interactions add column if not exists schema_hash      text;
alter table public.interactions add column if not exists recorder_version text;

alter table public.interactions drop constraint if exists interactions_request_kind_check;
alter table public.interactions add constraint interactions_request_kind_check
  check (request_kind is null or request_kind in ('tool_call', 'protocol', 'reported'));

alter table public.interactions drop constraint if exists interactions_error_layer_check;
alter table public.interactions add constraint interactions_error_layer_check
  check (error_layer is null or error_layer in ('request', 'server', 'tool'));

alter table public.interactions drop constraint if exists interactions_failure_type_check;
alter table public.interactions add constraint interactions_failure_type_check
  check (failure_type is null or failure_type in
    ('invalid_arguments', 'protocol_error', 'timeout', 'server_error', 'tool_error', 'unknown'));

create index if not exists idx_interactions_node_created on public.interactions (node_id, created_at);
create index if not exists idx_interactions_actor_created on public.interactions (actor, created_at);

create or replace view public.reputation_summary as
with i as (
  select x.*,
         coalesce(
           x.request_kind = 'protocol'
           or (x.request_kind is null and x.task_type in
               ('initialize', 'tools/list', 'prompts/list', 'resources/list', 'resources/templates/list', 'ping')),
           false) as is_protocol
  from public.interactions x
), r as (
  select i.*,
         (i.source = 'organic' and not i.is_protocol and coalesce(i.error_layer, '') <> 'request') as is_rated
  from i
)
select
  r.target,
  r.target_type,
  count(*) as interactions,
  count(*) filter (where r.is_rated and r.outcome = 'success') as successes,
  round(
    (count(*) filter (where r.is_rated and r.outcome = 'success'))::numeric
    / nullif(count(*) filter (where r.is_rated), 0)::numeric, 3) as success_rate,
  count(rv.id) as reviews,
  round(avg(rv.rating), 2) as avg_rating,
  round(count(rv.id)::numeric / nullif(count(distinct r.id), 0)::numeric, 3) as review_conversion_rate,
  count(*) filter (where r.is_rated) as rated_interactions,
  count(*) filter (where r.is_protocol) as protocol_requests,
  count(*) filter (where r.error_layer = 'request') as rejected_requests,
  count(*) filter (where r.source = 'organic') as organic_count,
  count(*) filter (where r.source = 'seeded') as seeded_count,
  count(*) filter (where r.source = 'synthetic') as synthetic_count
from r
left join public.reviews rv on rv.interaction_id = r.id
group by r.target, r.target_type;
