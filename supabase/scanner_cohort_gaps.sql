-- Lowdown v0.4 — Scanner 코호트 미관찰 사유 (Supabase SQL Editor에서 실행, 여러 번 실행해도 안전)
-- 원칙: 코호트 멤버 중 이번 run 에 observation 행이 생기지 않은 대상의 "사유"만 담는다.
--   scanner_observations 에는 넣지 않는다 — REPORT.md 의 분모(관찰 행 수)를 보호하기 위함.
--   reason:
--     no_remote             Registry 에 active·latest 로 있으나 최신 버전에 원격(streamable-http) 선언이 없음
--     remote_not_probeable  원격 선언은 있으나 streamable-http 아니거나 템플릿 URL이라 probe 불가
--     not_active            Registry 응답에는 있으나 active·latest 상태가 아님(deprecated 등)
--     not_in_registry       이름 자체가 이번 run 의 Registry 응답(version=latest)에 없음
-- 사유 분리는 2026-10-12 적용분부터 기록되며, 그 이전 기간은 소급하지 않는다.

create table if not exists scanner_cohort_gaps (
  id               bigint generated always as identity primary key,
  scan_run_id      uuid        not null,
  cohort_version   text        not null,
  target_id        text        not null,
  observed_at      timestamptz not null default now(),
  reason           text        not null
                               check (reason in ('no_remote', 'remote_not_probeable', 'not_active', 'not_in_registry')),
  registry_version text,
  registry_status  text
);

create index if not exists scanner_cohort_gaps_target_time_idx
  on scanner_cohort_gaps (target_id, observed_at desc);

create index if not exists scanner_cohort_gaps_run_idx
  on scanner_cohort_gaps (scan_run_id);

-- insert 재시도(응답 유실) 시 중복 행 방지: 같은 run 안에서 target 당 1행
create unique index if not exists scanner_cohort_gaps_run_target_uq
  on scanner_cohort_gaps (scan_run_id, target_id);

-- 원본과 마찬가지로 공개하지 않는다 (policy 없음). Scanner 는 service key 로만 쓴다.
alter table scanner_cohort_gaps enable row level security;