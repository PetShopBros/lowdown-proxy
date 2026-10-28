-- 2026-10-29: 레이다 2단계 — 도구 정의 규칙(R1·R2·R3)을 scanner_notable 에 함께 쌓는다
-- 먼저 2026-10-29_scanner_notable.sql 이 실행돼 있어야 한다. Supabase SQL Editor 에서 실행, 여러 번 실행해도 안전.
--
-- 규칙 (rule_version 1). 서버 단위(subject_kind='server', subject = Registry 이름). 해시·원격 주소·원문은 넣지 않는다.
--   R1_first_change_after_stable    직전 7번 이상의 비교에서 그대로이던 도구 정의가 바뀜 (서버 버전도 바뀌었거나 알 수 없음)
--   R2_changed_same_server_version  R1 과 같되 서버 버전은 그대로 (R1 과 겹치지 않는다)
--   R3_tool_removed                 도구 이름 집합이 바뀌고 도구 수가 줄어듦
--   셋 다 "다음 관찰에서도 바뀐 정의가 그대로"일 때만 기록 (2026-10-29 측정: 되돌림 0건, 다음 날 또 바뀐 경우 R1 40/200·R2 33/147 은 제외됨)
--   원자료(scanner_observations)는 읽기만 한다.

alter table public.scanner_notable drop constraint if exists scanner_notable_rule_id_check;
alter table public.scanner_notable add constraint scanner_notable_rule_id_check check (rule_id in (
  'P1_npm_deprecated', 'P2_npm_not_found', 'P4_pypi_archived',
  'P5_pypi_latest_yanked', 'P6_pypi_not_found', 'P7_declared_missing_package',
  'R1_first_change_after_stable', 'R2_changed_same_server_version', 'R3_tool_removed'));

alter table public.scanner_notable drop constraint if exists scanner_notable_subject_kind_check;
alter table public.scanner_notable add constraint scanner_notable_subject_kind_check check (subject_kind in ('npm', 'pypi', 'server'));

-- ── 확인 ─────────────────────────────────────────────────
-- select day, rule_id, count(*), count(distinct group_key) as lines from scanner_notable
-- where subject_kind = 'server' group by 1, 2 order by 1 desc, 2;
