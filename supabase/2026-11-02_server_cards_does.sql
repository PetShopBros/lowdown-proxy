-- 2026-11-02: find does= (하는 일로 찾기)용 열. 값은 cards.ts(cards-3)가 카드 body 에서 뽑아 넣는다.
-- search_text = 소문자 Registry 이름 + 마지막 관측 도구 이름(공백 구분). 둘 다 이미 공개된 값(tool-list 메뉴).
-- 도구 설명 원문은 넣지 않는다(비공개). Registry 설명은 registry_state 에 원문이 없어 아직 넣지 않는다(desc_hash 만 있음).
-- Supabase SQL Editor 에서 실행. 여러 번 실행해도 안전. 기존 카드(cards-2)는 다음 조리(00:07·13:07 KST) 때까지 이 열이 null.
create extension if not exists pg_trgm;

alter table public.server_cards
  add column if not exists tool_names  text[],
  add column if not exists search_text text;

-- ilike '%단어%' 를 인덱스로 (기존 registry_state_name_trgm 과 같은 방식)
create index if not exists server_cards_search_trgm on public.server_cards using gin (search_text gin_trgm_ops);

-- 확인용 (다음 카드 실행 뒤):
-- select builder_version, count(*), count(search_text) as with_text, count(tool_names) as with_tools from server_cards group by 1;
-- explain select name from server_cards where search_text ilike '%postgres%';
