-- 2026-10-30: 캐시 앞 전체 요청 기록 (Supabase SQL Editor 에서 실행, 여러 번 실행해도 안전)
-- middleware.ts 가 쓴다. 캐시 적중까지 포함한 전체 요청 수 → 10/30 이전 discovery_hits·reputation_lookups 건수 추이와 이어 본다.
-- discovery_hits·reputation_lookups 는 그대로(캐시가 빈 요청·실사용 봇만 기록). IP 는 저장하지 않는다. 공개하지 않는다(select policy 없음).
create table if not exists public.edge_hits (
  id          bigint generated always as identity primary key,
  path        text        not null,
  method      text,
  user_agent  text,
  referer     text,
  bot_kind    text,
  bot_name    text,
  created_at  timestamptz not null default now()
);
create index if not exists edge_hits_created_idx on public.edge_hits (created_at desc);
alter table public.edge_hits enable row level security;
drop policy if exists edge_hits_insert on public.edge_hits;
create policy edge_hits_insert on public.edge_hits for insert to anon, authenticated with check (true);

-- 봇 분류: reputation_lookups 와 같은 classify_user_agent() (2026-10-26_lookups_bot_kind.sql)
create or replace function public.edge_hits_set_bot()
returns trigger language plpgsql as $$
declare c record;
begin
  if new.user_agent is not null then
    select * into c from public.classify_user_agent(new.user_agent);
    new.bot_kind := c.kind;
    new.bot_name := c.name;
  end if;
  return new;
end $$;
drop trigger if exists edge_hits_set_bot on public.edge_hits;
create trigger edge_hits_set_bot before insert on public.edge_hits
  for each row execute function public.edge_hits_set_bot();

-- 확인용:
-- select date_trunc('day', created_at at time zone 'Asia/Seoul')::date as kst_day, bot_name, count(*)
-- from edge_hits group by 1, 2 order by 1 desc, 3 desc;
