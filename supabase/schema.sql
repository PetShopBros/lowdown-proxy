-- Lowdown v0 스키마
-- 기준: lowdown-brief.md 핵심 데이터 모델 (Interaction → Outcome → Opinion)
-- Read-first 원칙: reputation 조회는 인증 없이 무료 공개, 조회 자체도 로깅

create extension if not exists "pgcrypto";

-- 1. 상호작용 기록 (자동, 사실만)
create table if not exists interactions (
  id uuid primary key default gen_random_uuid(),
  actor text not null,                  -- 호출한 쪽 (agent id, 없으면 'anonymous')
  target text not null,                 -- 대상 (agent/tool/service 식별자)
  target_type text not null check (target_type in ('agent','tool','service','human')),
  task_type text not null,              -- 예: web_search, data_extraction, saju-interpretation
  outcome text not null check (outcome in ('success','partial','failure')),
  latency_ms integer,
  source text not null default 'organic' check (source in ('organic','seeded','synthetic')),
  created_at timestamptz not null default now(),
  node_id text,                         -- 기록한 프록시 노드 (ld_xxxxxxxxxxxx)
  failure_type text                     -- 값 제약은 2026-10-15_interactions_p0.sql
);
-- request_kind / error_layer / server_version / schema_hash / recorder_version 컬럼과
-- 현재 reputation_summary 정의는 supabase/2026-10-15_interactions_p0.sql 에 있다.
-- RLS: supabase/2026-10-15_interactions_rls.sql (anon 접근 없음, 서버 secret 키만).

create index if not exists idx_interactions_target on interactions(target);
create index if not exists idx_interactions_source on interactions(source);
create index if not exists idx_interactions_created_at on interactions(created_at);

-- 2. 평가 (선택적, interaction에 종속)
create table if not exists reviews (
  id uuid primary key default gen_random_uuid(),
  interaction_id uuid not null references interactions(id) on delete restrict, -- 관측 원칙: 지우지 않음 (2026-10-24_reviews_fk_restrict.sql)
  rating integer check (rating between 1 and 5),
  comment text,
  created_at timestamptz not null default now()
);

create index if not exists idx_reviews_interaction_id on reviews(interaction_id);

-- 3. 평판 조회 로그 (read-first 실험의 핵심 계측 지점)
create table if not exists reputation_lookups (
  id uuid primary key default gen_random_uuid(),
  requester text,                       -- API key/agent identity, 없으면 null(익명 조회 허용)
  target text not null,
  source text not null check (source in ('organic','seeded')),
  created_at timestamptz not null default now()
);

create index if not exists idx_reputation_lookups_target on reputation_lookups(target);
create index if not exists idx_reputation_lookups_source on reputation_lookups(source);

-- 집계 뷰(초기 정의 — 2026-10-15_interactions_p0.sql 이 대체함): GET /api/reputation/:target 응답 계산용
create or replace view reputation_summary as
select
  i.target,
  i.target_type,
  count(*) as interactions,
  count(*) filter (where i.outcome = 'success') as successes,
  round(count(*) filter (where i.outcome = 'success')::numeric / nullif(count(*), 0), 3) as success_rate,
  count(r.id) as reviews,
  round(avg(r.rating)::numeric, 2) as avg_rating,
  round(count(r.id)::numeric / nullif(count(distinct i.id), 0), 3) as review_conversion_rate
from interactions i
left join reviews r on r.interaction_id = i.id
group by i.target, i.target_type;
