-- 2026-11-05: Agent Observatory 공개 — 2026-11-05_agents.sql 실행 + 원본 대조(불일치 0줄) 확인 뒤에 실행 (여러 번 실행해도 안전)
-- /agents.json · /agents · /agents/{kind}/{slug} 가 anon 키로 최신 스냅샷 1줄을 읽게 한다.
-- 되돌리기: revoke select on public.agent_snapshots from anon, authenticated;  (페이지는 503 이 되고, 기록은 그대로)
drop policy if exists agent_snapshots_read on public.agent_snapshots;
create policy agent_snapshots_read on public.agent_snapshots for select to anon, authenticated using (true);
grant select on public.agent_snapshots to anon, authenticated;
