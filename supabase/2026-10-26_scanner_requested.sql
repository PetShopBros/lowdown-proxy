-- 2026-10-26: 조회된 대상 관찰 (requested)
-- 누군가(에이전트·크롤러 포함) Registry 에 있지만 아직 관찰된 적 없는 서버를 조회하면, 다음 스캔부터 그 서버도 매일 관찰한다.
-- 고정 코호트(scanner_cohort)와 섞지 않는다:
--   - 대상 목록은 이 테이블에 따로 둔다 (API 의 in_sample 은 scanner_cohort 만 본다)
--   - 관찰 행은 source = 'scanner_requested' (고정 코호트는 'scanner'). 보고서·시장판·일일 기록은 source = 'scanner' 만 집계한다.
-- 추가만 한다: 한 번 들어온 대상은 지우지 않는다. 비공개(policy 없음, Scanner service key 로만 접근).

create table if not exists scanner_requested (
  target_id          text        primary key,           -- 'mcp:' + Registry 이름
  first_requested_at timestamptz not null default now(),
  first_bot_kind     text,                              -- 처음 조회한 쪽: null(분류 없음) / 'crawler' / 'ai_user'
  first_lookups      int         not null default 1     -- 선정 시점 최근 조회 수
);

alter table scanner_requested enable row level security;

-- 확인용
-- select count(*), min(first_requested_at), max(first_requested_at) from scanner_requested;
-- select source, count(*) from scanner_observations where observed_at > now() - interval '1 day' group by 1;
