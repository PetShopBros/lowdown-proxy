-- Lowdown Scanner 0.4.0 — 최초 관측 기록 (Supabase SQL Editor에서 실행, 여러 번 실행해도 안전)
-- "First observed by Lowdown": Lowdown 이 관찰한 범위에서 처음 본 값. 시장에 새로 나왔다는 뜻이 아니다.
--   scanner_tool_sets  : 대상별 도구 이름 목록. (target_id, names_hash) 가 처음 나타날 때만 1행.
--                        names_hash = 정렬한 이름 목록의 SHA-256 → 이름 집합이 같으면 스키마·설명이 바뀌어도 새 행 없음.
--                        partial = tools/list 가 다음 페이지를 알림(첫 페이지 이름만 있음). 설명문은 저장하지 않는다.
--   scanner_first_seen : (kind, value) 최초 관측. kind = capability | protocol_version | tool_name.
--                        첫 실행은 baseline=true(최초 관측으로 보지 않음). targets/hosts/namespaces 는 최근 관찰 기준 고유 수.
--                        공개 기준(노출 정책, 보안 필터 아님): tool_name 은 hosts >= 2 and namespaces >= 2 일 때만.

create table if not exists scanner_tool_sets (
  target_id     text        not null,
  names_hash    text        not null,
  names         text[]      not null default '{}',
  rejected      integer     not null default 0,
  partial       boolean     not null default false,
  schema_hash   text,
  first_seen_at timestamptz not null default now(),
  scan_run_id   uuid        not null,
  primary key (target_id, names_hash)
);

create table if not exists scanner_first_seen (
  id              bigint generated always as identity primary key,
  kind            text        not null check (kind in ('capability', 'protocol_version', 'tool_name')),
  value           text        not null,
  first_seen_on   date        not null,
  first_seen_at   timestamptz not null,
  first_target_id text        not null,
  baseline        boolean     not null default false,
  targets         integer     not null default 0,
  hosts           integer     not null default 0,
  namespaces      integer     not null default 0,
  scan_run_id     uuid        not null,
  updated_at      timestamptz not null default now(),
  unique (kind, value)
);

create index if not exists scanner_first_seen_day_idx on scanner_first_seen (first_seen_on desc, kind) where not baseline;

-- 공개하지 않는다 (policy 없음). Scanner 는 scanner 전용 secret key 로만 쓴다. 공개는 일일 페이지·피드(정적 파일)로.
alter table scanner_tool_sets  enable row level security;
alter table scanner_first_seen enable row level security;
revoke all on scanner_tool_sets, scanner_first_seen from anon, authenticated;

-- ─────────────────────────────────────────────
-- 확인용
-- ─────────────────────────────────────────────
-- select kind, count(*), count(*) filter (where baseline) from scanner_first_seen group by 1;
-- 오늘 처음 관측(공개 기준 적용):
-- select kind, value, targets, hosts, namespaces from scanner_first_seen
-- where not baseline and first_seen_on = current_date
--   and (kind <> 'tool_name' or (hosts >= 2 and namespaces >= 2)) order by kind, value;
