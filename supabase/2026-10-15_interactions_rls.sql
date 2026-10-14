-- P0 마지막 단계 (2026-10-15): interactions 를 서버(secret 키) 전용으로.
-- 실행 조건: lowdown-proxy 0.1.17 이상으로 전환 완료(기록이 공개 API 경유), relay 는 secret 키.
-- 이후 anon 키로는 interactions 를 읽거나 쓸 수 없다. 공개 조회는 API(/api/reputation, /api/interactions)로만.

alter table public.interactions enable row level security;
revoke all on public.interactions from anon, authenticated;

-- 되돌리기(문제가 생겼을 때만):
-- alter table public.interactions disable row level security;
-- grant select, insert on public.interactions to anon, authenticated;
