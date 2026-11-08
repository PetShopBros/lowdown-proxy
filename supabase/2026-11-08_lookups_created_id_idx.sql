-- 2026-11-08: 비공개 보관(private-archive) reputation_lookups 하루치 읽기를 (created_at, id) keyset 으로 바꿈.
--   이전: created_at 범위 + id 순 keyset → pkey 로 표 전체를 훑으며 하루치를 걸러 timeout(11/7 backup HTTP 500).
-- (created_at, id) 로 범위와 정렬을 한 인덱스에서 처리. 기존 idx_reputation_lookups_created(created_at) 는 그대로 둔다.
-- Supabase SQL Editor 에서 이 문장만 단독 실행(concurrently 는 트랜잭션 안에서 실패).
create index concurrently if not exists idx_reputation_lookups_created_id
  on public.reputation_lookups (created_at, id);
