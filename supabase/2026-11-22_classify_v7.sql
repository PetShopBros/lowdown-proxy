-- 2026-11-22 (7차): 이름을 밝힌 점검기·디렉터리·연구용 클라이언트 18개를 prober로 추가. Supabase SQL Editor에서 실행(pack), 여러 번 실행해도 결과 같음
-- 근거: mcp_calls 최근 14일(11/8~11/22) bot_name 있음 + bot_kind null 목록 검토(11/22).
--   dollardollardollar-signals(620건/2일)·StorkMCPDirectory는 tools/call 포함 → kind null이면 월간 지표 M3(외부 도구 직접 사용)에 섞임.
--   heldfast는 v6 명시 목록에 null로 정해져 있어 그대로 둠. Talaria·coda-agent-runtime·FACTANKER(11/2 결정) 그대로.
--   범용 라이브러리 UA(node, python-httpx, okhttp, Go-http-client 등)는 넣지 않음.
-- 바뀐 것: (1) 명시 목록에 prober 18줄(ord 60~77) 추가
--          (2) 규칙 2)~5)의 순서 번호 60/70/80/90 → 100/110/120/130 (명시 목록 자리 확보, 순서 관계는 v6과 같음)
--          그 밖은 v6과 같음.
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
      (77, 'MglennP-RadialScout', 'prober')
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

-- 다시 분류: 새로 넣은 18개 UA 행만
update public.edge_hits e
set bot_kind = c.kind, bot_name = c.name
from (select id, (public.classify_user_agent(user_agent)).* from public.edge_hits
      where user_agent ilike any (array['%dollardollardollar-signals%','%MCPWatch%','%reliability-bureau-spike%','%mcp2-research%','%metano-radar%','%mcpcost%','%hultra-link%','%NestDaddy-MCP-Directory%','%agent2agent-hub%','%mcp-scraper%','%UND-Assay-Evidence%','%StorkMCPDirectory%','%free-remote-mcp-servers%','%MCPMeasurement%','%PopNx-MCP%','%402explorer%','%agentalog-sonda%','%MglennP-RadialScout%'])) c
where e.id = c.id and (e.bot_kind is distinct from c.kind or e.bot_name is distinct from c.name);

update public.reputation_lookups r
set bot_kind = c.kind, bot_name = c.name
from (select id, (public.classify_user_agent(user_agent)).* from public.reputation_lookups
      where user_agent ilike any (array['%dollardollardollar-signals%','%MCPWatch%','%reliability-bureau-spike%','%mcp2-research%','%metano-radar%','%mcpcost%','%hultra-link%','%NestDaddy-MCP-Directory%','%agent2agent-hub%','%mcp-scraper%','%UND-Assay-Evidence%','%StorkMCPDirectory%','%free-remote-mcp-servers%','%MCPMeasurement%','%PopNx-MCP%','%402explorer%','%agentalog-sonda%','%MglennP-RadialScout%'])) c
where r.id = c.id and (r.bot_kind is distinct from c.kind or r.bot_name is distinct from c.name);

update public.mcp_calls m
set bot_kind = c.kind, bot_name = c.name
from (select id, (public.classify_user_agent(user_agent)).* from public.mcp_calls
      where user_agent ilike any (array['%dollardollardollar-signals%','%MCPWatch%','%reliability-bureau-spike%','%mcp2-research%','%metano-radar%','%mcpcost%','%hultra-link%','%NestDaddy-MCP-Directory%','%agent2agent-hub%','%mcp-scraper%','%UND-Assay-Evidence%','%StorkMCPDirectory%','%free-remote-mcp-servers%','%MCPMeasurement%','%PopNx-MCP%','%402explorer%','%agentalog-sonda%','%MglennP-RadialScout%'])) c
where m.id = c.id and (m.bot_kind is distinct from c.kind or m.bot_name is distinct from c.name);

-- 확인:
-- select (classify_user_agent('dollardollardollar-signals/1.0 (+https://dollardollardollar.com; directory@allthingsn.com)')).*;  -- prober / dollardollardollar-signals
-- select (classify_user_agent('heldfast (+https://github.com/rufat325/heldfast)')).*;   -- null / heldfast (그대로)
-- select (classify_user_agent('ClaudeBot/1.0')).*;                                       -- crawler / ClaudeBot (기존 그대로)
-- select (classify_user_agent('Go-http-client/2.0')).*;                                  -- null / Go-http-client (기존 그대로)
-- select bot_kind, bot_name, count(*) from mcp_calls where created_at >= now() - interval '14 days' and bot_kind = 'prober' group by 1, 2 order by 3 desc;
