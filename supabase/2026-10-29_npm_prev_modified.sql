-- 2026-10-29: P3(휴면 뒤 새 버전) 준비 — npm latest_changed 이벤트에 "전날까지 기록된 수정 시각"을 함께 남긴다
-- Supabase SQL Editor 에서 실행. 여러 번 실행해도 안전. **코드(npm-snapshot) 배포 전에 먼저 실행**해야 한다
--   (일괄 쓰기에 prev_modified 키가 들어가므로, 열이 없으면 다음 npm 스냅샷의 이벤트 쓰기가 실패한다).
--
-- prev_modified: npm 축약 정보의 패키지 문서 수정 시각(modified) 중 전날 상태 값. 직전 발행 시각보다 같거나 늦다
--   (발행 외 수정에도 갱신되므로). 따라서 "prev_modified 가 180일 이상 전"이면 직전 발행도 확실히 180일 이상 전 → 보수적 기준.
--   latest_changed 에만 값이 있고, 다른 이벤트·이 열 추가 전의 행은 null. 기존 행은 바꾸지 않는다.

alter table public.npm_package_changes add column if not exists prev_modified timestamptz;

-- 레이다 규칙 목록에 P3 추가 (rule_version 1, 새 규칙 — 기존 규칙 행은 그대로)
alter table public.scanner_notable drop constraint if exists scanner_notable_rule_id_check;
alter table public.scanner_notable add constraint scanner_notable_rule_id_check check (rule_id in (
  'P1_npm_deprecated', 'P2_npm_not_found', 'P3_npm_release_after_dormancy', 'P4_pypi_archived',
  'P5_pypi_latest_yanked', 'P6_pypi_not_found', 'P7_declared_missing_package',
  'R1_first_change_after_stable', 'R2_changed_same_server_version', 'R3_tool_removed'));

-- ── 확인 (다음 npm 스냅샷 뒤) ─────────────────────────────
-- select detected_on, count(*) as latest_changed, count(prev_modified) as with_prev,
--        count(*) filter (where prev_modified < detected_on - interval '180 days') as dormant_180
-- from npm_package_changes where kind = 'latest_changed' and detected_on >= '2026-10-29' group by 1 order by 1 desc;
