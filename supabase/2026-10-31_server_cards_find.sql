-- 2026-10-31: find(조건 검색)용 열. 값은 카드 body 에 이미 있는 것을 cards.ts(cards-2)가 뽑아 넣는다.
-- 여러 번 실행해도 안전. 기존 카드(cards-1)는 다음 조리 때까지 이 열이 null.
alter table public.server_cards
  add column if not exists answered_days_30d        integer,
  add column if not exists observed_days_30d        integer,
  add column if not exists consecutive_days         integer,
  add column if not exists consecutive_since        date,
  add column if not exists tool_set_since           date,     -- 지금 도구 목록이 처음 관측된 날
  add column if not exists registry_first_day       date,
  add column if not exists registry_baseline        boolean,  -- true = 첫 기록일이 실제 등록일 아님
  add column if not exists registry_last_change_day date,     -- Registry 30일 변경 중 마지막
  add column if not exists package_updated_day      date;     -- npm modified / PyPI latest_uploaded 중 마지막

-- 확인용 (다음 카드 실행 뒤):
-- select builder_version, count(*), count(answered_days_30d) as answered, count(tool_set_since) as tool_set, count(registry_first_day) as reg_first, count(package_updated_day) as pkg from server_cards group by 1;