-- 2026-11-12 (5차): 명시 목록에 GoogleOther 추가 (crawler). Supabase SQL Editor 에서 실행(pack), 여러 번 실행해도 결과 같음
-- 근거: UA "… Nexus 5X … Mobile Safari/537.36 (compatible; GoogleOther)" — Google 의 범용 크롤러(공식 문서: 여러 제품 팀이
--   공개 콘텐츠를 가져올 때 쓰며 특정 제품에 영향 없음, Googlebot 과 같은 IP 대역). 이름에 bot·crawler·spider 가 없어
--   규칙 3)에 걸리지 않고 4)(브라우저 형식)로 떨어져 kind null 이었음. 11/11 11:39 KST 부터 조회 약 15,000건.
--   GoogleOther-Image·GoogleOther-Video 도 같은 줄에 걸려 이름 GoogleOther 로 묶인다.
-- 바뀐 곳: classify_user_agent() 의 명시 목록 1줄 + 해당 UA 행만 다시 분류(전체 재분류 안 함).
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
from (select id, (public.classify_user_agent(user_agent)).* from public.edge_hits where user_agent ilike '%GoogleOther%') c
where e.id = c.id and (e.bot_kind is distinct from c.kind or e.bot_name is distinct from c.name);

update public.reputation_lookups r
set bot_kind = c.kind, bot_name = c.name
from (select id, (public.classify_user_agent(user_agent)).* from public.reputation_lookups where user_agent ilike '%GoogleOther%') c
where r.id = c.id and (r.bot_kind is distinct from c.kind or r.bot_name is distinct from c.name);

update public.mcp_calls m
set bot_kind = c.kind, bot_name = c.name
from (select id, (public.classify_user_agent(user_agent)).* from public.mcp_calls where user_agent ilike '%GoogleOther%') c
where m.id = c.id and (m.bot_kind is distinct from c.kind or m.bot_name is distinct from c.name);

-- 확인:
-- select (classify_user_agent('Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.8010.52 Mobile Safari/537.36 (compatible; GoogleOther)')).*;   -- crawler / GoogleOther
-- select bot_kind, bot_name, count(*) from reputation_lookups where user_agent ilike '%GoogleOther%' group by 1, 2;
