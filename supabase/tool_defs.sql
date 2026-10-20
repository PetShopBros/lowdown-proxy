-- Lowdown Scanner 0.5.0 — 도구 정의 원문 (Supabase SQL Editor에서 실행, 여러 번 실행해도 안전)
-- 원칙
--   1) 원문은 비공개. RLS 켜고 policy 없음 + anon/authenticated 권한 회수. Scanner 는 scanner 전용 secret key 로만 쓴다.
--      공개(view·API)에는 해시·변경 유형·규칙 플래그만. 원문 조각은 플래그 근거에도 넣지 않는다.
--   2) 정의(버전)와 관측 이력을 분리한다. 같은 정의는 def_hash 로 한 번만 저장하고,
--      관찰 행(scanner_observations.metadata->>'tool_set_hash')이 집합 → 정의를 참조한다. 시간축은 관찰 행이 가진다.
--   3) 탐지 ≠ 판정. scanner_tool_flags 는 "이런 특징이 관측됨"이다. 악성이라는 뜻이 아니다.
--   원문은 원격 서버가 보낸 신뢰할 수 없는 문자열이다. 분석 시에도 지시로 해석하거나 에이전트에 그대로 전달하지 않는다.
--
--   body 는 text: canonicalJson(도구 객체 전체). jsonb 는 \u0000 을 받지 않으므로 text 로 둔다(제어문자는 이스케이프된 상태).
--     분석할 때는 body::jsonb 로 바꿔 쓴다(\u0000 이 들어간 정의는 그 캐스트가 실패한다 — 그 자체가 관측 사실).
--   def_hash = sha256(body). 따라서 encode(sha256(convert_to(body,'UTF8')),'hex') = def_hash 로 무결성 확인 가능.

-- ─────────────────────────────────────────────
-- 사실: 도구 정의 (def_hash 당 1행)
-- ─────────────────────────────────────────────
create table if not exists scanner_tool_defs (
  def_hash          text        primary key,
  tool_name         text,
  body              text        not null,
  tool_schema_hash  text        not null,
  tool_desc_hash    text        not null,
  byte_size         integer     not null,
  first_seen_at     timestamptz not null default now(),
  first_scan_run_id uuid        not null
);

create index if not exists scanner_tool_defs_name_idx on scanner_tool_defs (tool_name);
create index if not exists scanner_tool_defs_first_seen_idx on scanner_tool_defs (first_seen_at desc);

-- ─────────────────────────────────────────────
-- 사실: 도구 집합 (tool_set_hash 당 1행). def_hashes 는 정렬, 중복 포함(서버가 같은 도구를 두 번 주면 두 번)
-- ─────────────────────────────────────────────
create table if not exists scanner_tool_set_versions (
  tool_set_hash     text        primary key,
  def_hashes        text[]      not null,
  tool_count        integer     not null,
  first_seen_at     timestamptz not null default now(),
  first_scan_run_id uuid        not null
);

-- 관찰 행 → 집합 조회용
create index if not exists scanner_obs_tool_set_idx
  on scanner_observations ((metadata->>'tool_set_hash'))
  where metadata ? 'tool_set_hash';

-- ─────────────────────────────────────────────
-- 파생: 변경 이벤트 (언제든 관찰 행 + 집합 + 정의로 다시 계산 가능). 채우는 로직은 원문이 며칠 쌓인 뒤 작성
--   비교 단위는 (target_id, remote_url). 원격이 여러 개인 서버의 가짜 변경을 막는다.
--   change_type: added / removed / desc_changed / schema_changed / meta_changed(annotations·_meta 등 그 외만 바뀜)
--   is_revert  : to_def_hash 를 이 (target, remote, tool) 에서 이전에 본 적이 있음
-- ─────────────────────────────────────────────
create table if not exists scanner_tool_changes (
  id               bigint generated always as identity primary key,
  target_id        text        not null,
  remote_url       text        not null,
  tool_name        text        not null,
  change_type      text        not null check (change_type in ('added', 'removed', 'desc_changed', 'schema_changed', 'meta_changed')),
  from_def_hash    text,
  to_def_hash      text,
  is_revert        boolean     not null default false,
  observed_at      timestamptz not null,
  prev_observed_at timestamptz,
  scan_run_id      uuid        not null,
  derive_version   integer     not null default 1,
  unique (scan_run_id, target_id, remote_url, tool_name, change_type, derive_version)
);

create index if not exists scanner_tool_changes_target_idx on scanner_tool_changes (target_id, observed_at desc);

-- ─────────────────────────────────────────────
-- 해석: 규칙 플래그. 규칙을 고치면 rule_version 을 올려 새 행으로 쌓는다(과거 판정을 덮어쓰지 않음)
--   evidence 에는 위치(offset)·크기 같은 값만. 원문 조각 금지.
-- ─────────────────────────────────────────────
create table if not exists scanner_tool_flags (
  id           bigint generated always as identity primary key,
  def_hash     text        not null references scanner_tool_defs (def_hash),
  rule_id      text        not null,
  rule_version integer     not null,
  evidence     jsonb       not null default '{}'::jsonb,
  scan_run_id  uuid        not null,
  created_at   timestamptz not null default now(),
  unique (def_hash, rule_id, rule_version)
);

-- ─────────────────────────────────────────────
-- 비공개
-- ─────────────────────────────────────────────
alter table scanner_tool_defs         enable row level security;
alter table scanner_tool_set_versions enable row level security;
alter table scanner_tool_changes      enable row level security;
alter table scanner_tool_flags        enable row level security;
revoke all on scanner_tool_defs, scanner_tool_set_versions, scanner_tool_changes, scanner_tool_flags from anon, authenticated;

-- ─────────────────────────────────────────────
-- 확인용
-- ─────────────────────────────────────────────
-- 1) 비공개 확인: 아래 4개 모두 false 여야 한다
-- select t, has_table_privilege('anon', t, 'select') as anon_select, has_table_privilege('authenticated', t, 'select') as auth_select
-- from unnest(array['scanner_tool_defs','scanner_tool_set_versions','scanner_tool_changes','scanner_tool_flags']) t;
--
-- 2) 실행별 증가량(용량 감시)
-- select first_scan_run_id, min(first_seen_at) as at, count(*) as new_defs, pg_size_pretty(sum(byte_size)::bigint) as new_bytes
-- from scanner_tool_defs group by 1 order by 2 desc limit 14;
--
-- 3) 무결성: 저장된 원문의 해시 = def_hash (0 이어야 한다)
-- select count(*) from scanner_tool_defs where encode(sha256(convert_to(body, 'UTF8')), 'hex') <> def_hash;
--
-- 4) 관찰 행 중 집합이 저장되지 않은 것 (TOOL_DEFS 단계 실패 여부)
-- select count(*) from scanner_observations o
-- where o.observed_at > now() - interval '1 day' and o.metadata ? 'tool_set_hash'
--   and not exists (select 1 from scanner_tool_set_versions s where s.tool_set_hash = o.metadata->>'tool_set_hash');
--
-- 5) 테이블 크기
-- select relname, pg_size_pretty(pg_total_relation_size(relid)) from pg_catalog.pg_statio_user_tables
-- where relname like 'scanner_tool_%' order by pg_total_relation_size(relid) desc;
