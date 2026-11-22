-- 2026-11-22: requested(조회된 대상) 일반 자리 닫음 — 크롤러가 처음 고른 행을 은퇴 처리. Supabase SQL Editor 에서 실행(pack), 여러 번 실행해도 결과 같음
-- 근거: 11/11 실측 scanner_requested 3,001행 중 first_bot_kind = crawler 2,999. "누가 조회한 서버를 매일 관찰"의 뜻이
--   "크롤러가 고른 서버를 매일 관찰"로 바뀌어 있었다. 바깥 고리(3일마다, 11/9~) 이후 점검 가능한 서버는 모두 관찰되므로
--   은퇴한 대상은 관찰이 끊기지 않고 고정 코호트(매일) 또는 바깥 고리(3일)로 돌아간다(scan.ts identOf 순서).
-- 행은 지우지 않는다(데이터 원칙). retired_at 이 있으면 scanner/requested-lib.ts fetchRequestedIds 가 읽지 않는다.
-- AI 사용자가 다시 조회해 다시 고르면 reactivateRequested 가 retired_at = null, reactivated_at = 그때. first_*·retired_reason 은 그대로.
-- 순서: 이 SQL 먼저 → 그다음 코드 push(코드가 retired_at 열을 읽으므로).
set local statement_timeout = '60s';

alter table public.scanner_requested
  add column if not exists retired_at timestamptz,
  add column if not exists retired_reason text,
  add column if not exists reactivated_at timestamptz;

update public.scanner_requested
set retired_at = now(),
    retired_reason = 'first lookup by crawler; general slots closed 2026-11-22'
where first_bot_kind = 'crawler'
  and retired_at is null
  and reactivated_at is null;

-- 확인:
-- select (retired_at is not null) as retired, first_bot_kind, count(*) from public.scanner_requested group by 1, 2 order by 1, 2;
-- 기대: retired=false 는 ai_user·null 몇 행만, retired=true 는 crawler 약 2,999.
