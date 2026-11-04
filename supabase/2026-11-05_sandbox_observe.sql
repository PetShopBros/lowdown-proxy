-- Lowdown 샌드박스 행동 관측 (2026-11-05) — sandbox/observe-lib.ts, sandbox/runner.ts --observe
-- 기존 샌드박스에서 tools/list 까지 간(ok) 대상의 실행 단계를 gVisor strace 런타임(runsc-observe)으로 한 번 더 돌려
-- "시도한 사실"만 남긴다: 실행(exec) · 접속(connect) · DNS 시도(dns_attempt, 53번 접속 — 이름은 아직 없음) · 인증 정보 경로 열기(credential_open).
-- 판정(위험·악성)은 없다. 비공개: RLS 켜고 정책 없음, anon/authenticated 권한 없음. 공개 여부는 따로 검토한 뒤 정한다.
-- 원본 strace 로그는 서버에서 파싱 직후 지운다. 환경변수는 저장하지 않고, 실행 인자는 비밀값 모양을 가리고 200자로 자른다.
-- 다시 실행해도 안전하다.

create table if not exists sandbox_observe_runs (
  id               uuid        primary key,               -- runner 가 만든다(사건 행이 참조)
  batch_id         uuid        not null,                  -- 같은 --observe 실행 묶음
  observed_at      timestamptz not null,
  target_key       text        not null,                  -- sandbox_state.target_key ("npm:<ident>@<version>")
  registry_type    text        not null check (registry_type in ('npm', 'pypi')),
  ident            text        not null,
  version          text        not null,
  observe_major    integer     not null,                  -- 관측 규칙 주 버전(바뀌면 다시 관측)
  runner_version   text        not null,
  runtime          text        not null,                  -- runsc-observe
  outcome          text        not null,                  -- 이번 관측 실행의 결과(sandbox_runs.outcome 과 같은 값들)
  reached_level    smallint    not null,
  duration_ms      integer,
  log_found        boolean     not null,
  log_bytes        integer,
  log_truncated    boolean     not null default false,    -- 16MB 넘어 앞부분만 읽음
  unparsed_lines   integer,
  events_dropped   integer,                               -- 서로 다른 사건 200개 상한을 넘어 버린 수
  opens_total      integer,                               -- 파일 열기 전체 횟수(경로는 인증 정보 경로만 사건으로 남김)
  exec_total       integer,                               -- 하네스를 뺀 실행 횟수
  harness_execs    integer,
  connect_total    integer,                               -- 53번 제외
  dns_attempts     integer,
  credential_opens integer,
  note             text                                   -- log_not_found / no_cidfile / parse_failed
);

create index if not exists sandbox_observe_runs_target_idx on sandbox_observe_runs (target_key, observe_major);
create index if not exists sandbox_observe_runs_observed_idx on sandbox_observe_runs (observed_at desc);

create table if not exists sandbox_observe_events (
  id      bigint generated always as identity primary key,
  run_id  uuid   not null references sandbox_observe_runs (id) on delete cascade,
  kind    text   not null check (kind in ('exec', 'connect', 'dns_attempt', 'credential_open')),
  target  text   not null,                                -- 실행 파일 경로 / 주소:포트(unix:경로) / DNS 서버:53 / 파일 경로
  detail  text,                                           -- exec: 가린 인자(200자)
  result  text   not null,                                -- ok / opened / not_found / denied / unreachable / refused / in_progress / errno_N ...
  count   integer not null check (count > 0)
);

create index if not exists sandbox_observe_events_run_idx on sandbox_observe_events (run_id);
create index if not exists sandbox_observe_events_kind_idx on sandbox_observe_events (kind, target);

alter table sandbox_observe_runs enable row level security;
alter table sandbox_observe_events enable row level security;
revoke all on sandbox_observe_runs, sandbox_observe_events from anon, authenticated;
revoke all on sequence sandbox_observe_events_id_seq from anon, authenticated;

-- 확인
select 'sandbox_observe_runs' as t, count(*) from sandbox_observe_runs
union all select 'sandbox_observe_events', count(*) from sandbox_observe_events;
