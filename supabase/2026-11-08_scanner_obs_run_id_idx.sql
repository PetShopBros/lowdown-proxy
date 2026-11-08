-- 2026-11-08: market.ts getAll(scanner_observations, scan_run_id=eq, keyset id>, order id) 이
--   (scan_run_id, id) 인덱스가 없어 pkey 순차 탐색(20만 행 필터, 16.5s) → timeout → HTTP 500(report 실패 11/2~11/8).
-- (scan_run_id, id) 로 조건과 정렬을 한 인덱스에서 처리 → 0.14s.
-- Supabase SQL Editor 에서 이 문장만 단독 실행(concurrently 는 트랜잭션 안에서 실패). 2026-11-08 적용 완료.
create index concurrently if not exists scanner_obs_run_id_idx
  on public.scanner_observations (scan_run_id, id);
