-- stdio 샌드박스 기록 (sandbox/runner.ts) — Supabase SQL Editor 에서 실행, 여러 번 실행해도 안전
-- 대상: 공식 MCP Registry 가 stdio 로 선언한 npm 패키지(registry_state.packages_key 의 "npm <ident> <version> stdio" 줄).
-- 격리된 컨테이너(gVisor, 실행 시 네트워크 없음)에서 띄워 initialize + tools/list 만 보낸다. 도구는 호출하지 않는다.
-- 환경변수·인자·인증 없이 띄운다. 따라서 결과는 "설정 없이 오프라인으로 띄웠을 때"의 사실이다.
-- 원칙:
--   1) 이력(sandbox_runs)과 대상 상태(sandbox_state, 대상당 1행)를 나눈다. 실행 묶음(sandbox_batches)은 watchdog 이 본다.
--   2) 패키지가 낸 표준오류·로그 원문은 저장하지 않는다(바이트 수만). 도구 정의 원문은 Scanner 와 같은 비공개 테이블에만.
--   3) 파일럿 4주 동안 비공개: RLS 켜고 정책 없음 + anon/authenticated 권한 회수. 공개 여부는 파일럿 뒤 결정.
--   4) 점수·판정 없음. outcome 은 관측된 단계(어디까지 응답했는가)일 뿐이다.

create table if not exists sandbox_runs (
  id                 bigint      generated always as identity primary key,
  run_id             uuid        not null,               -- sandbox_batches.run_id
  observed_at        timestamptz not null,
  registry_type      text        not null check (registry_type in ('npm')),
  ident              text        not null,
  version            text        not null,
  sources            text[]      not null,               -- declared(Registry 선언 버전) / npm_latest(npm 최신)
  runner_version     text        not null,
  run_major          integer     not null,
  image_id           text        not null,               -- 실행 이미지(sha256:...)
  runtime            text        not null,               -- runsc(gVisor)
  install_ms         integer,
  install_error_code text,                               -- npm 이 붙인 오류 코드(E404 등)만
  bin_count          integer,
  outcome            text        not null check (outcome in (
                       'ok', 'install_not_found', 'install_version_not_found', 'install_failed', 'install_timeout', 'install_network',
                       'no_bin', 'bin_ambiguous', 'exited', 'init_timeout', 'init_error', 'init_invalid',
                       'list_timeout', 'list_error', 'list_invalid', 'exited_after_init', 'output_limit', 'runner_error')),
  reached_level      smallint    not null check (reached_level between 0 and 2),
  exit_code          integer,
  signal             text,
  init_ms            integer,
  list_ms            integer,
  duration_ms        integer,
  metadata           jsonb       not null default '{}'   -- capabilities, protocol_version, server_version, tool_count, *_hash, tool_set_hash,
                                                         -- rpc_error_code, nonjson_lines, stderr_bytes, server_requests, output_limited
);

create index if not exists sandbox_runs_ident_idx on sandbox_runs (ident, observed_at desc);
create index if not exists sandbox_runs_observed_idx on sandbox_runs (observed_at desc);
create index if not exists sandbox_runs_tool_set_idx on sandbox_runs ((metadata->>'tool_set_hash')) where metadata ? 'tool_set_hash';

create table if not exists sandbox_state (
  target_key    text        primary key,                 -- "npm:<ident>@<version>"
  registry_type text        not null,
  ident         text        not null,
  version       text        not null,
  attempts      integer     not null,
  done          boolean     not null,                    -- 더 돌리지 않음(사실 확정, 또는 일시 오류 재시도 한도 도달)
  last_outcome  text        not null,
  first_run_at  timestamptz not null,
  last_run_at   timestamptz not null,
  run_major     integer     not null                     -- 실행기 주 버전. 바뀌면 끝난 대상도 다시 돈다
);

create table if not exists sandbox_batches (
  run_id         uuid        primary key,
  started_at     timestamptz not null,
  finished_at    timestamptz,
  runner_version text        not null,
  image_id       text        not null,
  runtime        text        not null,
  planned        integer     not null,
  attempted      integer     not null,
  outcomes       jsonb       not null default '{}',
  plan_stats     jsonb       not null default '{}',
  note           text
);

create index if not exists sandbox_batches_started_idx on sandbox_batches (started_at desc);

alter table sandbox_runs enable row level security;
alter table sandbox_state enable row level security;
alter table sandbox_batches enable row level security;
revoke all on sandbox_runs, sandbox_state, sandbox_batches from anon, authenticated;
revoke all on sequence sandbox_runs_id_seq from anon, authenticated;

-- 확인 (모두 false 여야 한다)
-- select t, has_table_privilege('anon', t, 'select') as anon_select, has_table_privilege('authenticated', t, 'select') as auth_select
-- from unnest(array['sandbox_runs', 'sandbox_state', 'sandbox_batches']) as t;
--
-- 실행 뒤:
-- select started_at, finished_at, planned, attempted, outcomes, note from sandbox_batches order by started_at desc limit 5;
-- select outcome, count(*) from sandbox_runs group by 1 order by 2 desc;
-- select reached_level, count(*), round(avg((metadata->>'tool_count')::int), 1) as avg_tools from sandbox_runs group by 1 order by 1;

-- 0.2.0 (2026-10-24): Registry 선언 실행 인자(packageArguments)를 붙여 실행한다. 붙인 인자와 그 근거 항목을 기록한다.
--   metadata 에 args_unsatisfied(필수인데 넣지 못한 인자 수), env_required, env_secret(선언된 환경변수 수 — 값은 주지 않는다)
alter table sandbox_runs add column if not exists registry_name text;
alter table sandbox_runs add column if not exists args text[] not null default '{}';
