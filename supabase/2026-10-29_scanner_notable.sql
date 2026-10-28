-- 2026-10-29: 레이다 1단계 — 패키지 규칙(P1·P2·P4·P5·P6·P7)의 "눈여겨볼 사실"을 비공개로 쌓는다
-- Supabase SQL Editor 에서 실행. 여러 번 실행해도 안전.
--
-- 원칙
--   1) 사실만: npm·PyPI 원본이 직접 표시한 값의 "전환"만 기록한다. 점수·판정·형용사 없음.
--   2) 기준선(Lowdown 이 처음 확인했을 때 이미 그 상태)은 올리지 않는다. 예외 P7: 새로 선언된 패키지의 첫 확인이 404.
--   3) 원자료(npm_package_changes, pypi_package_changes, *_package_state, registry_state)는 읽기만 한다.
--   4) 비공개: published=false 로만 쌓는다. 시장판·API 노출은 다음 단계에서 따로 연다.
--   5) RLS 켜고 정책 없음 + anon/authenticated 권한 회수. Scanner 는 secret key 로만 쓴다.
--
-- 규칙 (rule_version 1). P3(휴면 뒤 새 버전)은 직전 수정 시각이 남지 않아 rule_version 2 로 미룬다.
--   P1_npm_deprecated            npm latest 버전에 deprecated 표시가 새로 생김
--   P2_npm_not_found             있던 npm 패키지가 404 가 됨
--   P4_pypi_archived             PyPI project-status 가 archived / quarantined 로 바뀜
--   P5_pypi_latest_yanked        PyPI 최신 버전이 회수됨
--   P6_pypi_not_found            있던 PyPI 패키지가 404 가 됨
--   P7_declared_missing_package  Registry 가 선언한 패키지를 Lowdown 이 처음 확인했을 때 이미 404 (첫 전수 확인일 제외)

create table if not exists public.scanner_notable (
  id           bigint      generated always as identity primary key,
  day          date        not null,                 -- 스냅샷의 detected_on (UTC 날짜)
  rule_id      text        not null check (rule_id in (
                 'P1_npm_deprecated', 'P2_npm_not_found', 'P4_pypi_archived',
                 'P5_pypi_latest_yanked', 'P6_pypi_not_found', 'P7_declared_missing_package')),
  rule_version int         not null,
  subject_kind text        not null check (subject_kind in ('npm', 'pypi')),
  subject      text        not null,                 -- 패키지 이름 (PyPI 는 PEP 503 정규화 이름)
  group_key    text        not null,                 -- 같은 날 묶음 키 (npm scope 또는 Registry 네임스페이스)
  evidence     jsonb       not null default '{}'::jsonb,
  published    boolean     not null default false,
  created_at   timestamptz not null default now()
);

create unique index if not exists scanner_notable_day_rule_subject_uq
  on public.scanner_notable (day, rule_id, subject_kind, subject);
create index if not exists scanner_notable_day_idx on public.scanner_notable (day);

alter table public.scanner_notable enable row level security;
revoke all on public.scanner_notable from anon, authenticated;
revoke all on sequence public.scanner_notable_id_seq from anon, authenticated;

-- ── 확인 ─────────────────────────────────────────────────
-- select day, rule_id, count(*) from scanner_notable group by 1, 2 order by 1 desc, 2;
-- select day, group_key, count(*) from scanner_notable group by 1, 2 having count(*) > 1 order by 1 desc;
