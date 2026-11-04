-- 2026-11-02: 봇 구분에 'prober'(MCP 디렉터리·모니터·평판 서비스의 점검·색인 요청)를 더한다
-- Supabase SQL Editor 에서 실행, 여러 번 실행해도 안전
--
-- 배경: edge_hits 3일치(10/30~11/02)를 보니
--   - 'other' 의 약 95% 가 Reflectionbot 한 곳(8,257건) — 이름 없이 묻혀 있었다.
--   - mcpbeat·EveryMCP-Probe·protogrid-probe·AgentRankProbe·mcptry·Moonglade·GolemreachTrustBot·ado-p5-health 는
--     UA 에 bot/crawler/spider 가 없거나 'other' 로만 잡혀 개별 추세가 보이지 않았다.
--   이들은 학습·검색 크롤러(crawler)도, 사람이 시킨 AI 조회(ai_user)도 아니다 → Lowdown 이 다른 시장판에 올라 점검받는 신호라 따로 센다.
-- 원칙: 원본(user_agent·path 등)은 바꾸지 않는다. 분류 열(bot_kind·bot_name)만 다시 채운다.
--   이름만 확인되고 성격을 단정할 수 없는 것은 bot_name 만 붙이고 bot_kind 는 null 로 둔다 (관측과 해석 분리).
-- 바꾼 것 (2026-10-30_openai_mcp_ua.sql 대비):
--   1) reputation_lookups.bot_kind 체크 제약에 'prober' 추가 (edge_hits 는 제약 없음)
--   2) classify_user_agent() 목록에 Reflectionbot(crawler), prober 8개, coda-agent-runtime(이름만) 추가
--   3) edge_hits·reputation_lookups 다시 분류

-- 1) 제약
alter table public.reputation_lookups drop constraint if exists reputation_lookups_bot_kind_check;
alter table public.reputation_lookups add constraint reputation_lookups_bot_kind_check
  check (bot_kind is null or bot_kind in ('crawler', 'ai_user', 'prober'));

-- 2) 분류 함수 — 목록 순서(ord)대로 먼저 맞는 것: ai_user → crawler → prober → 이름만 → 일반 bot 표시(other)
create or replace function public.classify_user_agent(ua text, out kind text, out name text)
language sql immutable as $$
  select k, n from (
    select ord, n, k from (values
      (1,  'Claude-User',        'ai_user'),
      (2,  'ChatGPT-User',       'ai_user'),
      (3,  'Perplexity-User',    'ai_user'),
      (4,  'MistralAI-User',     'ai_user'),
      (5,  'openai-mcp',         'ai_user'),
      (10, 'ClaudeBot',          'crawler'),
      (11, 'Claude-SearchBot',   'crawler'),
      (12, 'GPTBot',             'crawler'),
      (13, 'OAI-SearchBot',      'crawler'),
      (14, 'PerplexityBot',      'crawler'),
      (15, 'Googlebot',          'crawler'),
      (16, 'bingbot',            'crawler'),
      (17, 'Applebot',           'crawler'),
      (18, 'CCBot',              'crawler'),
      (19, 'Bytespider',         'crawler'),
      (20, 'Amazonbot',          'crawler'),
      (21, 'meta-externalagent', 'crawler'),
      (22, 'DuckDuckBot',        'crawler'),
      (23, 'YandexBot',          'crawler'),
      (24, 'Reflectionbot',      'crawler'),
      (30, 'mcpbeat',            'prober'),
      (31, 'EveryMCP-Probe',     'prober'),
      (32, 'protogrid-probe',    'prober'),
      (33, 'AgentRankProbe',     'prober'),
      (34, 'mcptry',             'prober'),
      (35, 'Moonglade',          'prober'),
      (36, 'GolemreachTrustBot', 'prober'),
      (37, 'ado-p5-health',      'prober'),
      (50, 'coda-agent-runtime', null)
    ) as t(ord, n, k)
    where ua ilike '%' || n || '%'
    union all
    select 99, 'other', 'crawler' where ua ~* '(bot|crawler|spider)'
  ) m
  order by ord
  limit 1
$$;

-- 3) 다시 분류 (분류 열만 채움, 바뀌는 줄만)
update public.edge_hits e
set bot_kind = c.kind, bot_name = c.name
from (select id, (public.classify_user_agent(user_agent)).* from public.edge_hits where user_agent is not null) c
where e.id = c.id
  and (e.bot_kind is distinct from c.kind or e.bot_name is distinct from c.name);

update public.reputation_lookups r
set bot_kind = c.kind, bot_name = c.name
from (select id, (public.classify_user_agent(user_agent)).* from public.reputation_lookups where user_agent is not null) c
where r.id = c.id
  and (r.bot_kind is distinct from c.kind or r.bot_name is distinct from c.name);

-- ── 확인 ─────────────────────────────────────────────────
-- 구분별 3일 합계:
-- select coalesce(bot_kind, '(none)') as bot_kind, coalesce(bot_name, '(미분류)') as bot_name, count(*)
-- from edge_hits where created_at >= now() - interval '3 days'
-- group by 1, 2 order by 3 desc limit 30;
--
-- 날짜별 구분 추이:
-- select date_trunc('day', created_at at time zone 'Asia/Seoul')::date as kst_day,
--        count(*) filter (where bot_kind = 'ai_user') as ai_user,
--        count(*) filter (where bot_kind = 'crawler') as crawler,
--        count(*) filter (where bot_kind = 'prober')  as prober,
--        count(*) filter (where bot_kind is null)     as unmarked
-- from edge_hits group by 1 order by 1 desc;
