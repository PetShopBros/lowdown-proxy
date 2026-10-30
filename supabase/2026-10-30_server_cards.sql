-- 2026-10-30: 서버 카드 (2단계 주방). 하루 1번 Actions(cards.yml, scanner/cards.ts)가 API 응답 전체를 미리 만들어 덮어쓴다.
-- API 는 카드가 있고 오늘(UTC) 만든 것이면 이 1행만 읽는다. 없거나 오래되면 기존 실시간 계산.
-- 원본 관측 데이터는 그대로. 카드는 파생물이라 매일 덮어쓴다(날짜별 사본 없음, 이반 결정 2026-10-30).
-- Supabase SQL Editor 에서 실행 (이반 실행 완료 2026-10-30). 여러 번 실행해도 안전.
create table if not exists public.server_cards (
  target_id                   text primary key,          -- 예: mcp:com.ahasignals/evidence
  name                        text not null,             -- Registry 이름
  body                        jsonb not null,            -- 메뉴 적용 전 API 전체 응답
  latest_state                text,                      -- answered / auth_required / no_response / ...
  latest_day                  date,
  last_definition_change_day  date,
  tool_count                  integer,
  package_flag                boolean,                   -- 선언 패키지 중 deprecated·yanked·quarantined·404 가 있음
  registry_status             text,                      -- active / deprecated / deleted
  observation_basis           text,                      -- fixed_cohort / on_request
  data_day                    date not null,             -- 어느 날(UTC) 데이터로 만들었나
  built_at                    timestamptz not null default now(),
  builder_version             text
);
create index if not exists server_cards_find_idx on public.server_cards (latest_state, last_definition_change_day);
alter table public.server_cards enable row level security;
-- API(anon 키)는 읽기만. 내용은 공개 API 응답과 같다. 쓰기는 Actions 의 LOWDOWN_SCANNER_KEY.
drop policy if exists server_cards_read on public.server_cards;
create policy server_cards_read on public.server_cards for select to anon, authenticated using (true);

-- 확인용:
-- select data_day, builder_version, count(*), pg_size_pretty(sum(pg_column_size(body))) from server_cards group by 1, 2;
-- select latest_state, count(*) from server_cards group by 1 order by 2 desc;
