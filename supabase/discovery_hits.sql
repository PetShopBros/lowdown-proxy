-- 발견용 파일(/llms.txt, /openapi.json) 방문 기록 (Supabase SQL Editor에서 실행, 여러 번 실행해도 안전)
-- api/discovery.ts 가 쓴다. IP 는 저장하지 않는다. 공개하지 않는다(policy 없음).
create table if not exists discovery_hits (
  id          bigint generated always as identity primary key,
  path        text        not null,
  method      text,
  user_agent  text,
  referer     text,
  created_at  timestamptz not null default now()
);

create index if not exists discovery_hits_created_idx on discovery_hits (created_at desc);

alter table discovery_hits enable row level security;

-- 확인용:
-- select date_trunc('day', created_at)::date as day, path, left(user_agent, 80) as ua, count(*)
-- from discovery_hits group by 1, 2, 3 order by 1 desc, 4 desc;

-- API(Vercel)의 LOWDOWN_SUPABASE_KEY 가 anon 키라서 RLS 가 켜진 테이블에 쓰려면 insert 허용 규칙이 필요하다.
-- 쓰기만 허용하고 읽기(select)는 허용하지 않는다 → 외부에서 방문 기록을 조회할 수 없다.
drop policy if exists discovery_hits_insert on discovery_hits;
create policy discovery_hits_insert on discovery_hits for insert to anon, authenticated with check (true);
