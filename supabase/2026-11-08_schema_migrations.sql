-- 2026-11-08: SQL 적용 기록(안정화 2단계 2-1). 도구: node scanner/migrations.ts (baseline | pack | check).
-- postgres 로 실행. 여러 번 실행해도 안전.
--   version     = 파일 이름(.sql 뺀 것)
--   checksum    = sha256(BOM 제거·CRLF→LF 한 본문)
--   baseline    = 이 표를 만들기 전에 적용된 파일: 파일이 만드는 객체가 실제 DB 에 모두 있을 때만 등록(파일만 있다고 등록하지 않음)
--   execution_ms= pack 으로 적용했을 때 걸린 시간(baseline 은 null)
create table if not exists public.schema_migrations (
  version      text primary key,
  filename     text not null unique,
  checksum     text not null,
  applied_at   timestamptz not null default now(),
  execution_ms integer,
  baseline     boolean not null default false,
  note         text
);

-- 공개 API(anon·authenticated)에서는 보이지 않게. service key(검사)와 postgres 는 RLS 를 우회한다.
alter table public.schema_migrations enable row level security;
revoke all on public.schema_migrations from anon, authenticated;
grant select on public.schema_migrations to lowdown_analyst;
