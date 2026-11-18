-- 2026-11-19 (6차): 명시 목록에 KINF-True-Identity-Stream 추가 (crawler). Supabase SQL Editor 에서 실행(pack), 여러 번 실행해도 결과 같음
-- 근거: 11/17 00:54 KST 첫 관측(lookup 213건) → 11/17 12:53 ~ 11/18 10:08 KST edge_hits 47,454건 / 서로 다른 경로 23,730개.
--   경로가 거의 겹치지 않는 순회 수집. 이름에 bot·crawler·spider 가 없고 규칙 2) 단어에도 걸리지 않아
--   규칙 5)로 떨어져 kind null(사람 조회와 같은 취급)이었음. 운영 주체·목적은 웹 검색으로 확인 안 됨.
-- 바뀐 것: classify_user_agent() 의 명시 목록 1줄 + 해당 UA 행만 다시 분류(전체 재분류 안 함). 나머지는 v5 와 같음.
set local statement_timeout = '120s';

create or replace function public.classify_user_agent(ua text, out kind text, out name text)
language sql immutable as $$
  select k, n from (
    -- 1) 명시 목록
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
      (25, 'GoogleOther',        'crawler'),
      (26, 'KINF-True-Identity-Stream', 'crawler'),
      (30, 'mcpbeat',            'prober'),
      (31, 'EveryMCP-Probe',     'prober'),
      (32, 'protogrid-probe',    'prober'),
      (33, 'AgentRankProbe',     'prober'),
      (34, 'mcptry',             'prober'),
      (35, 'Moonglade',          'prober'),
      (36, 'GolemreachTrustBot', 'prober'),
      (37, 'ado-p5-health',      'prober'),
      (38, 'ragmap-check',       'prober'),
      (39, 'LEGION-tlog',        'prober'),
      (40, 'agent-collector',    'prober'),
      (41, 'mcp-discovery-measurement', 'prober'),
      (50, 'coda-agent-runtime', null),
      (51, 'Talaria',            null),
      (52, 'FACTANKER',          null),
      (53, 'heldfast',           null)
    ) as t(ord, n, k)
    where ua ilike '%' || n || '%'
    union all
    -- 2) 점검·확인 도구 선언 → prober, 이름 = 첫 단어
    select 60, substring(ua from '^\s*([A-Za-z0-9._@+-]+)'), 'prober'
    where ua !~* '^\s*mozilla/'
      and ua ~* '(probe|check|health|scan|monitor|census|index|audit|liveness|uptime|tools/list|initialize|registry|inventory|observatory|verif|survey|catalog|snapshot|collector)'
      and substring(ua from '^\s*([A-Za-z0-9._@+-]+)') is not null
    union all
    -- 3) 크롤러 선언 → crawler, 이름 = bot·crawler·spider 가 든 토큰
    select 70, substring(ua from '(?i)([A-Za-z0-9._-]*(?:bot|crawler|spider)[A-Za-z0-9._-]*)'), 'crawler'
    where ua ~* '(bot|crawler|spider)'
    union all
    -- 4) 브라우저 형식 → 이름·성격 없음
    select 80, null, null
    where ua ~* '^\s*mozilla/'
    union all
    -- 5) 그 밖 → 성격 없음, 이름 = 첫 단어
    select 90, substring(ua from '^\s*([A-Za-z0-9._@+-]+)'), null
    where substring(ua from '^\s*([A-Za-z0-9._@+-]+)') is not null
  ) m
  order by ord
  limit 1
$$;

-- 다시 분류: 이 UA 행만
update public.edge_hits e
set bot_kind = c.kind, bot_name = c.name
from (select id, (public.classify_user_agent(user_agent)).* from public.edge_hits where user_agent ilike '%KINF-True-Identity-Stream%') c
where e.id = c.id and (e.bot_kind is distinct from c.kind or e.bot_name is distinct from c.name);

update public.reputation_lookups r
set bot_kind = c.kind, bot_name = c.name
from (select id, (public.classify_user_agent(user_agent)).* from public.reputation_lookups where user_agent ilike '%KINF-True-Identity-Stream%') c
where r.id = c.id and (r.bot_kind is distinct from c.kind or r.bot_name is distinct from c.name);

update public.mcp_calls m
set bot_kind = c.kind, bot_name = c.name
from (select id, (public.classify_user_agent(user_agent)).* from public.mcp_calls where user_agent ilike '%KINF-True-Identity-Stream%') c
where m.id = c.id and (m.bot_kind is distinct from c.kind or m.bot_name is distinct from c.name);

-- 확인:
-- select (classify_user_agent('KINF-True-Identity-Stream')).*;   -- crawler / KINF-True-Identity-Stream
-- select bot_kind, bot_name, count(*) from edge_hits where user_agent ilike '%KINF-True-Identity-Stream%' group by 1, 2;
-- select bot_kind, bot_name, count(*) from reputation_lookups where user_agent ilike '%KINF-True-Identity-Stream%' group by 1, 2;
