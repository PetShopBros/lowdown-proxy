-- 2026-10-26: stdio 샌드박스 — PyPI 패키지 추가 (runner 0.3.0)
-- sandbox_runs 의 registry_type / outcome 제한을 넓힌다. 이미 쌓인 npm 행은 그대로. 여러 번 실행해도 안전.
-- 이 SQL 을 먼저 실행한 뒤에 서버에서 새 코드·PyPI 이미지를 올린다(순서가 반대면 PyPI 행 저장이 거절된다).

alter table sandbox_runs drop constraint if exists sandbox_runs_registry_type_check;
alter table sandbox_runs add constraint sandbox_runs_registry_type_check check (registry_type in ('npm', 'pypi'));

alter table sandbox_runs drop constraint if exists sandbox_runs_outcome_check;
alter table sandbox_runs add constraint sandbox_runs_outcome_check check (outcome in (
  'ok', 'install_not_found', 'install_version_not_found', 'install_failed', 'install_timeout', 'install_network', 'install_no_matching_dist',
  'no_bin', 'bin_ambiguous', 'exited', 'init_timeout', 'init_error', 'init_invalid',
  'list_timeout', 'list_error', 'list_invalid', 'exited_after_init', 'output_limit', 'runner_error'));

-- 확인
-- select conname, pg_get_constraintdef(oid) from pg_constraint where conrelid = 'sandbox_runs'::regclass and contype = 'c';
-- select registry_type, count(*) from sandbox_runs group by 1;
-- select outcome, count(*) from sandbox_runs where registry_type = 'pypi' group by 1 order by 2 desc;
