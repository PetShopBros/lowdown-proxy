-- 2026-10-31: 날짜별 보관(backup.yml → scanner/archive.ts)이 하루치 관측을 빠르게 읽도록 (observed_at, id) 인덱스.
-- 원인(10/30 backup 실패, 57014 statement timeout): 하루치를 id 순서로 페이지 넘기던 조회에서 Postgres 가 기본키를 표 처음부터
--   훑으며 observed_at 을 거르는 계획을 골랐다. 관측 행은 지우지 않으므로 날마다 느려졌다.
-- scanner/lib.ts fetchMonthRows 는 이 인덱스 순서((observed_at, id) keyset)로 읽고, 결과는 예전과 같은 id 순서로 정렬해 쓴다.
-- Supabase SQL Editor 에서 실행. "cannot run inside a transaction block" 이면 concurrently 를 빼고 실행.
create index concurrently if not exists scanner_observations_observed_id_idx
  on public.scanner_observations (observed_at, id);

-- 확인 (Index Scan using scanner_observations_observed_id_idx):
-- explain select id from public.scanner_observations
-- where observed_at >= '2026-10-29' and observed_at < '2026-10-30'
-- order by observed_at, id limit 1000;
