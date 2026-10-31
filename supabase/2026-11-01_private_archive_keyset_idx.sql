-- 비공개 보관(backup) 하루치 읽기: (시각 열, 키) keyset 용 인덱스 (2026-11-01)
-- 계기: 2026-10-31 정시 backup 에서 scanner_tool_defs 하루치 읽기가 HTTP 500(시간 초과).
--   키(def_hash) 순서 LIMIT 페이지 → 기본키를 표 처음부터 훑으며 날짜를 거름(EXPLAIN: Index Scan using scanner_tool_defs_pkey + Filter).
--   scanner/private-archive-lib.ts 의 timeKeyset 데이터셋이 이 인덱스를 쓴다.
-- Supabase SQL 편집기는 문장을 트랜잭션으로 묶어 concurrently 를 쓸 수 없다 → 스캔이 없는 시간에 실행.
create index if not exists scanner_tool_defs_first_seen_hash_idx
  on scanner_tool_defs (first_seen_at, def_hash);
create index if not exists scanner_tool_set_versions_first_seen_hash_idx
  on scanner_tool_set_versions (first_seen_at, tool_set_hash);
