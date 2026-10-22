-- npm 패키지 일별 상태 (scanner/npm-snapshot.ts)
-- 대상: 공식 MCP Registry 가 선언한 npm 패키지(registry_state.packages_key 의 "npm <ident> ..." 줄). 코드는 실행하지 않는다.
-- 원칙:
--   1) 상태(npm_package_state, 패키지당 1행)와 이력(npm_package_changes)을 나눈다.
--   2) 첫 관찰은 기준선(baseline). 이벤트를 만들지 않는다.
--   3) 404 만 not_found. 시간 초과·5xx·429·연결 오류는 상태를 바꾸지 않고 last_error 에만 남긴다.
--   4) npm 문서 원문(설명·README·deprecated 문구)은 저장하지 않는다. 버전·시각·여부만.
--   5) 비공개 테이블: RLS 켜고 정책 없음 + anon/authenticated 권한 회수. Scanner 는 secret key 로만 쓴다.

create table if not exists npm_package_state (
  ident            text        primary key,          -- npm 패키지 이름 (@scope/name 포함, 바꾸지 않고 그대로)
  status           text        not null check (status in ('found', 'not_found')),
  latest           text,                              -- dist-tags.latest (형식에 맞을 때만)
  modified         timestamptz,                       -- npm 이 보고한 패키지 문서 수정 시각
  deprecated       boolean,                           -- latest 버전에 deprecated 표시가 있는가 (문구는 저장 안 함)
  baseline         boolean     not null default false, -- 첫 관찰이 기준선인가
  first_checked_at timestamptz not null,
  checked_at       timestamptz not null,              -- 마지막으로 응답(200/404)을 받은 시각
  changed_at       timestamptz,                       -- 마지막으로 상태가 바뀐 시각
  last_error       text,                              -- 마지막 실패 종류 (timeout, http_503 ...)
  last_error_at    timestamptz,
  scan_run_id      uuid
);

create table if not exists npm_package_changes (
  id          bigint      generated always as identity primary key,
  detected_on date        not null,
  ident       text        not null,
  kind        text        not null check (kind in ('latest_changed', 'deprecated', 'undeprecated', 'not_found', 'restored')),
  old_value   text,
  new_value   text,
  scan_run_id uuid,
  created_at  timestamptz not null default now(),
  unique (detected_on, ident, kind)
);

create index if not exists npm_package_changes_ident_idx on npm_package_changes (ident, detected_on desc);

alter table npm_package_state enable row level security;
alter table npm_package_changes enable row level security;
revoke all on npm_package_state, npm_package_changes from anon, authenticated;
revoke all on sequence npm_package_changes_id_seq from anon, authenticated;

-- 확인
-- select t, has_table_privilege('anon', t, 'select') as anon_select, has_table_privilege('authenticated', t, 'select') as auth_select
-- from unnest(array['npm_package_state', 'npm_package_changes']) as t;
--
-- 실행 뒤:
-- select status, baseline, count(*) from npm_package_state group by 1, 2;
-- select detected_on, kind, count(*) from npm_package_changes group by 1, 2 order by 1 desc, 2;
-- select pg_size_pretty(pg_total_relation_size('npm_package_state')), pg_size_pretty(pg_total_relation_size('npm_package_changes'));
