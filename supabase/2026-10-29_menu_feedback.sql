-- 2026-10-29: 메뉴(?menu=) 측정 + 피드백 창구 (POST /api/feedback). Supabase SQL Editor 에서 실행, 여러 번 실행해도 안전.
-- 코드 배포 전에 실행하는 것이 좋다. 먼저 배포해도 조회 기록은 빠지지 않는다(menu 열이 없으면 menu 없이 다시 쓴다).
-- 피드백은 이 테이블이 없으면 503 으로 답한다(저장되지 않음).

-- 1) 조회 기록에 메뉴 이름. 메뉴 없이 부른 조회(전체 응답)는 null.
--    menu 가 붙은 조회 = 메뉴판(menu.json, llms.txt, 서버 페이지)을 읽은 쪽에서만 나오는 신호.
alter table public.reputation_lookups add column if not exists menu text;

-- 2) 피드백: 정해진 선택지 + 짧은 자유 입력. note 는 외부 문자열 → 저장만, 공개·응답에 다시 내보내지 않는다. IP 없음.
create table if not exists public.lowdown_feedback (
  id         bigint      generated always as identity primary key,
  created_at timestamptz not null default now(),
  target     text,
  menu       text,
  useful     text        not null check (useful in ('yes', 'no', 'partly')),
  missing    text[]      not null default '{}',
  note       text        check (note is null or char_length(note) <= 200),
  user_agent text
);
create index if not exists lowdown_feedback_created_idx on public.lowdown_feedback (created_at desc);

alter table public.lowdown_feedback enable row level security;
revoke all on public.lowdown_feedback from anon, authenticated;
revoke all on sequence public.lowdown_feedback_id_seq from anon, authenticated;

-- ── 확인 ─────────────────────────────────────────────────
-- 메뉴별 조회 (크롤러 / 사람이 시킨 AI / 표시 없음):
-- select coalesce(menu, '(full)') as menu, coalesce(bot_kind, '(none)') as bot_kind, count(*)
-- from reputation_lookups where created_at >= now() - interval '7 days' group by 1, 2 order by 3 desc;
-- 다시 오는가 (같은 UA 가 다른 대상 또는 다른 메뉴로 이어서 조회):
-- select user_agent, count(distinct target) as targets, count(distinct menu) as menus, count(*) as lookups
-- from reputation_lookups where created_at >= now() - interval '7 days' and menu is not null
-- group by 1 having count(*) > 1 order by 4 desc limit 20;
-- 피드백:
-- select created_at, menu, useful, missing from lowdown_feedback order by created_at desc limit 20;
