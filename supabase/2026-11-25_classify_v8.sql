-- 2026-11-25 (8차): 이름을 밝힌 학술 측정 클라이언트 mcp-ad-measurement 1개를 prober로 추가. Supabase SQL Editor에서 실행(pack), 여러 번 실행해도 결과 같음
-- 근거: mcp_calls 최근 30일 tools/call 중 bot_kind null 42건 검토(11/25).
--   24건은 도구 이름 unknown(없는 도구로 규약 점검)이라 M3 필터(get_lowdown·find_servers)에서 이미 빠짐.
--   남은 18건 중 UA 이름으로 성격이 분명한 것은 'mcp-ad-measurement/1.0 (academic research)' 1건뿐(11/13).
--   이 UA는 규칙 2)의 단어(probe·check·scan 등)에 걸리지 않아 명시 목록에 직접 넣는다.
--   grid-station(11/21·11/24)은 이름만 붙은 채 null 유지(Talaria·heldfast와 같은 처리). okhttp·curl·브라우저 UA·WindowsPowerShell은 분류하지 않음(위장 가능, 사람 직접 호출 포함).
--   AgentValCon-collector(규칙 2 'collector')·BrickBlueBot(규칙 3 'bot')은 v7 규칙이 이미 처리.
-- 바뀐 것: 명시 목록에 prober 1줄(ord 78) 추가. 그 밖은 v7과 같음.
set local statement_timeout = '300s';

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
      (53, 'heldfast',           null),
      (60, 'dollardollardollar-signals', 'prober'),
      (61, 'MCPWatch',           'prober'),
      (62, 'reliability-bureau-spike', 'prober'),
      (63, 'mcp2-research',      'prober'),
      (64, 'metano-radar',       'prober'),
      (65, 'mcpcost',            'prober'),
      (66, 'hultra-link',        'prober'),
      (67, 'NestDaddy-MCP-Directory', 'prober'),
      (68, 'agent2agent-hub',    'prober'),
      (69, 'mcp-scraper',        'prober'),
      (70, 'UND-Assay-Evidence', 'prober'),
      (71, 'StorkMCPDirectory',  'prober'),
      (72, 'free-remote-mcp-servers', 'prober'),
      (73, 'MCPMeasurement',     'prober'),
      (74, 'PopNx-MCP',          'prober'),
      (75, '402explorer',        'prober'),
      (76, 'agentalog-sonda',    'prober'),
      (77, 'MglennP-RadialScout', 'prober'),
      (78, 'mcp-ad-measurement', 'prober')
    ) as t(ord, n, k)
    where ua ilike '%' || n || '%'
    union all
    -- 2) 점검·확인 도구 선언 → prober, 이름 = 첫 단어
    select 100, substring(ua from '^\s*([A-Za-z0-9._@+-]+)'), 'prober'
    where ua !~* '^\s*mozilla/'
      and ua ~* '(probe|check|health|scan|monitor|census|index|audit|liveness|uptime|tools/list|initialize|registry|inventory|observatory|verif|survey|catalog|snapshot|collector)'
      and substring(ua from '^\s*([A-Za-z0-9._@+-]+)') is not null
    union all
    -- 3) 크롤러 선언 → crawler, 이름 = bot·crawler·spider 가 든 토큰
    select 110, substring(ua from '(?i)([A-Za-z0-9._-]*(?:bot|crawler|spider)[A-Za-z0-9._-]*)'), 'crawler'
    where ua ~* '(bot|crawler|spider)'
    union all
    -- 4) 브라우저 형식 → 이름·성격 없음
    select 120, null, null
    where ua ~* '^\s*mozilla/'
    union all
    -- 5) 그 밖 → 성격 없음, 이름 = 첫 단어
    select 130, substring(ua from '^\s*([A-Za-z0-9._@+-]+)'), null
    where substring(ua from '^\s*([A-Za-z0-9._@+-]+)') is not null
  ) m
  order by ord
  limit 1
$$;

-- 다시 분류: mcp-ad-measurement UA 행만
update public.edge_hits e
set bot_kind = c.kind, bot_name = c.name
from (select id, (public.classify_user_agent(user_agent)).* from public.edge_hits
      where user_agent ilike '%mcp-ad-measurement%') c
where e.id = c.id and (e.bot_kind is distinct from c.kind or e.bot_name is distinct from c.name);

update public.reputation_lookups r
set bot_kind = c.kind, bot_name = c.name
from (select id, (public.classify_user_agent(user_agent)).* from public.reputation_lookups
      where user_agent ilike '%mcp-ad-measurement%') c
where r.id = c.id and (r.bot_kind is distinct from c.kind or r.bot_name is distinct from c.name);

update public.mcp_calls m
set bot_kind = c.kind, bot_name = c.name
from (select id, (public.classify_user_agent(user_agent)).* from public.mcp_calls
      where user_agent ilike '%mcp-ad-measurement%') c
where m.id = c.id and (m.bot_kind is distinct from c.kind or m.bot_name is distinct from c.name);

-- 확인:
-- select (classify_user_agent('mcp-ad-measurement/1.0 (academic research)')).*;   -- prober / mcp-ad-measurement
-- select (classify_user_agent('grid-station')).*;                                  -- null / grid-station (그대로)
-- select (classify_user_agent('AgentValCon-collector/1.0')).*;                     -- prober / AgentValCon-collector (v7 규칙 2, 그대로)
-- select (classify_user_agent('BrickBlueBot/1.0')).*;                              -- crawler / BrickBlueBot (v7 규칙 3, 그대로)
-- select (classify_user_agent('Go-http-client/2.0')).*;                            -- null / Go-http-client (그대로)
-- select bot_kind, bot_name, count(*) from mcp_calls where user_agent ilike '%mcp-ad-measurement%' group by 1, 2;
