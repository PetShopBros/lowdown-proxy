-- PyPI 패키지 일별 상태 (scanner/pypi-snapshot.ts)
-- 대상: 공식 MCP Registry 가 선언한 PyPI 패키지(registry_state.packages_key 의 "pypi <ident> ..." 줄). 코드는 실행하지 않는다.
-- ident 는 PEP 503 정규화 이름(소문자, - _ . 연속은 - 하나).
-- 원칙 (npm_package_state 와 같다):
--   1) 상태(pypi_package_state, 패키지당 1행)와 이력(pypi_package_changes)을 나눈다.
--   2) 첫 관찰은 기준선(baseline). 이벤트를 만들지 않는다.
--   3) JSON API 404 만 not_found. 시간 초과·5xx·429·연결 오류는 상태를 바꾸지 않고 last_error 에만 남긴다.
--   4) PyPI 원문(설명·README·회수 사유)과 vulnerabilities(보안 데이터)는 저장하지 않는다. 버전·시각·여부·프로젝트 상태만.
--   5) 비공개 테이블: RLS 켜고 정책 없음 + anon/authenticated 권한 회수. Scanner 는 secret key 로만 쓴다.

create table if not exists pypi_package_state (
  ident            text        primary key,
  status           text        not null check (status in ('found', 'not_found')),
  latest           text,                              -- JSON API info.version
  latest_yanked    boolean,                           -- 그 버전이 회수(yanked)됐는가 (사유 문구는 저장 안 함)
  uploaded         timestamptz,                       -- 그 버전 파일의 가장 늦은 업로드 시각
  project_status   text check (project_status in ('active', 'archived', 'quarantined', 'deprecated')), -- PEP 792, Index API
  baseline         boolean     not null default false,
  first_checked_at timestamptz not null,
  checked_at       timestamptz not null,              -- 마지막으로 응답(200/404)을 받은 시각
  changed_at       timestamptz,
  last_error       text,
  last_error_at    timestamptz,
  scan_run_id      uuid
);

create table if not exists pypi_package_changes (
  id          bigint      generated always as identity primary key,
  detected_on date        not null,
  ident       text        not null,
  kind        text        not null check (kind in ('latest_changed', 'yanked', 'unyanked', 'status_changed', 'not_found', 'restored')),
  old_value   text,
  new_value   text,
  scan_run_id uuid,
  created_at  timestamptz not null default now(),
  unique (detected_on, ident, kind)
);

create index if not exists pypi_package_changes_ident_idx on pypi_package_changes (ident, detected_on desc);

alter table pypi_package_state enable row level security;
alter table pypi_package_changes enable row level security;
revoke all on pypi_package_state, pypi_package_changes from anon, authenticated;
revoke all on sequence pypi_package_changes_id_seq from anon, authenticated;

-- 확인
-- select t, has_table_privilege('anon', t, 'select') as anon_select, has_table_privilege('authenticated', t, 'select') as auth_select
-- from unnest(array['pypi_package_state', 'pypi_package_changes']) as t;
--
-- 실행 뒤:
-- select status, project_status, baseline, count(*) from pypi_package_state group by 1, 2, 3 order by 4 desc;
-- select detected_on, kind, count(*) from pypi_package_changes group by 1, 2 order by 1 desc, 2;
