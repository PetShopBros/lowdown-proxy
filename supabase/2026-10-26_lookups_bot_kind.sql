-- 2026-10-26: 조회 기록(reputation_lookups)에 봇 구분을 붙인다 — Supabase SQL Editor 에서 실행, 여러 번 실행해도 안전
--
-- 배경: 2026-10-25 ClaudeBot(학습 데이터 수집 크롤러)이 Registry 전체를 조회해 이틀간 조회의 약 98%가 됐다.
--   모두 source = 'organic' 으로 기록돼 "에이전트가 실제로 조회했는가" 지표가 봇으로 채워졌다.
-- 원칙: 기존 값은 바꾸거나 지우지 않는다. source·user_agent 는 그대로 두고, 분류 결과를 새 열에 더한다.
--   bot_kind: 'crawler' (색인·학습용 수집) / 'ai_user' (사람이 AI 에게 시킨 실시간 조회: Claude-User 등) / null (봇 표시 없음)
--   bot_name: 일치한 이름 (예: ClaudeBot). 일반 bot/crawler/spider 표시만 있으면 'other'
-- 판정은 DB 트리거가 한다 → API 코드 변경·재배포 없이 새 조회부터 적용된다.
-- 목록에 없는 봇이 생기면 classify_user_agent() 만 고치고 아래 "다시 분류" 를 실행하면 된다.

alter table public.reputation_lookups add column if not exists bot_kind text;
alter table public.reputation_lookups add column if not exists bot_name text;

alter table public.reputation_lookups drop constraint if exists reputation_lookups_bot_kind_check;
alter table public.reputation_lookups add constraint reputation_lookups_bot_kind_check
  check (bot_kind is null or bot_kind in ('crawler', 'ai_user'));

-- User-Agent → (kind, name). 목록 순서(ord)대로 먼저 맞는 것. 사람이 시킨 AI 조회(ai_user)를 크롤러보다 먼저 본다.
create or replace function public.classify_user_agent(ua text, out kind text, out name text)
language sql immutable as $$
  select k, n from (
    select ord, n, k from (values
      (1,  'Claude-User',        'ai_user'),
      (2,  'ChatGPT-User',       'ai_user'),
      (3,  'Perplexity-User',    'ai_user'),
      (4,  'MistralAI-User',     'ai_user'),
      (10, 'ClaudeBot',          'crawler'),
      (11, 'Claude-SearchBot',   'crawler'),
      (12, 'GPTBot',             'crawler'),
      (13, 'OAI-SearchBot',      'crawler'),
      (14, 'PerplexityBot',      'crawler'),
      (15, 'Googlebot',          'crawler'),
      (16, 'bingbot',            'crawler'),
      (17, 'Applebot',           'crawler'),
      (18, 'CCBot',              'crawler'),
      (19, 'Bytespider',         'crawler'),
      (20, 'Amazonbot',          'crawler'),
      (21, 'meta-externalagent', 'crawler'),
      (22, 'DuckDuckBot',        'crawler'),
      (23, 'YandexBot',          'crawler')
    ) as t(ord, n, k)
    where ua ilike '%' || n || '%'
    union all
    select 99, 'other', 'crawler' where ua ~* '(bot|crawler|spider)'
  ) m
  order by ord
  limit 1
$$;

-- 새 조회: 기록될 때 분류 (API 가 bot_kind 를 직접 넣으면 그 값을 존중)
create or replace function public.reputation_lookups_set_bot()
returns trigger language plpgsql as $$
declare c record;
begin
  if new.bot_kind is null and new.user_agent is not null then
    select * into c from public.classify_user_agent(new.user_agent);
    new.bot_kind := c.kind;
    new.bot_name := c.name;
  end if;
  return new;
end $$;

drop trigger if exists reputation_lookups_set_bot on public.reputation_lookups;
create trigger reputation_lookups_set_bot
  before insert on public.reputation_lookups
  for each row execute function public.reputation_lookups_set_bot();

-- 기존 조회: 다시 분류 (새 열만 채운다. source·user_agent 는 그대로)
update public.reputation_lookups r
set bot_kind = c.kind, bot_name = c.name
from (select id, (public.classify_user_agent(user_agent)).* from public.reputation_lookups where user_agent is not null) c
where r.id = c.id
  and (r.bot_kind is distinct from c.kind or r.bot_name is distinct from c.name);

create index if not exists idx_reputation_lookups_created on public.reputation_lookups (created_at);

-- ── 확인 ─────────────────────────────────────────────────
-- select bot_kind, bot_name, count(*) from reputation_lookups group by 1, 2 order by 3 desc;
--
-- 앞으로 "에이전트 조회" 지표는 봇 수집을 빼고 본다:
-- select date_trunc('day', created_at at time zone 'Asia/Seoul') as kst_day,
--        count(*) filter (where bot_kind is null)        as unmarked,
--        count(*) filter (where bot_kind = 'ai_user')    as ai_user,
--        count(*) filter (where bot_kind = 'crawler')    as crawler
-- from reputation_lookups where source = 'organic'
-- group by 1 order by 1 desc limit 14;
