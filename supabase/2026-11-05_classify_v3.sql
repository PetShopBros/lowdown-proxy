-- 2026-11-05 (3차): 봇 분류를 "UA 에 적힌 선언"으로 일반화 — Supabase SQL Editor 에서 실행, 여러 번 실행해도 결과 같음
-- 배경: 목록에 없는 UA 중 bot·crawler·spider 가 든 것은 전부 bot_name='other' 로 뭉쳤다(24시간 5,656건).
--   histor 는 소개 주소의 '#crawler' 때문에 여기 걸려 crawler 로 잡혔다. 점검 도구를 밝힌 새 프로브는 목록에 손으로 넣기 전까지 이름이 없었다.
-- 원칙: UA 문자열의 선언만 근거로 한다. 행동(주기·경로)으로 성격을 추정하지 않는다. 원본(user_agent 등)은 바꾸지 않고 분류 열만 다시 채운다.
--   prober  = 스스로 점검·색인 도구임을 UA 에 밝힌 요청
--   crawler = 스스로 bot·crawler·spider 임을 UA 에 밝힌 요청
--   null    = 성격을 확정할 근거가 없는 요청 (이름만 붙이거나, 이름도 없음)
-- 규칙(위에서부터 먼저 맞는 것):
--   1) 명시 목록 (1·2차 그대로 + heldfast 이름만)
--   2) 점검 선언 단어가 있음 → prober, 이름 = UA 첫 단어        (Mozilla/ 로 시작하는 UA 는 첫 단어가 Mozilla 라 제외 → 4)
--   3) bot·crawler·spider 가 있음 → crawler, 이름 = 그 단어가 든 토큰
--   4) 브라우저 형식(Mozilla/...) → null / null
--   5) 그 밖(범용 HTTP 라이브러리 node·python-httpx 등, 이름만 밝힌 도구) → null / UA 첫 단어
-- 바꾼 곳: classify_user_agent() 교체 + edge_hits·reputation_lookups·mcp_calls 다시 분류(분류가 바뀌는 줄만).

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
      (50, 'coda-agent-runtime', null),
      (51, 'Talaria',            null),
      (52, 'FACTANKER',          null),
      (53, 'heldfast',           null)
    ) as t(ord, n, k)
    where ua ilike '%' || n || '%'
    union all
    -- 2) 점검·색인 도구 선언 → prober, 이름 = 첫 단어
    select 60, substring(ua from '^\s*([A-Za-z0-9._@+-]+)'), 'prober'
    where ua !~* '^\s*mozilla/'
      and ua ~* '(probe|check|health|scan|monitor|census|index|audit|liveness|uptime|tools/list|initialize|registry|inventory|observatory|verif|survey|catalog|snapshot|collector)'
      and substring(ua from '^\s*([A-Za-z0-9._@+-]+)') is not null
    union all
    -- 3) 크롤러 선언 → crawler, 이름 = bot·crawler·spider 가 든 토큰
    select 70, substring(ua from '(?i)([A-Za-z0-9._-]*(?:bot|crawler|spider)[A-Za-z0-9._-]*)'), 'crawler'
    where ua ~* '(bot|crawler|spider)'
    union all
    -- 4) 브라우저 형식 → 이름·성격 없음 (자리만 차지해 5 로 내려가지 않게)
    select 80, null, null
    where ua ~* '^\s*mozilla/'
    union all
    -- 5) 그 밖 → 성격 없음, 이름 = 첫 단어 (node, python-httpx, Go-http-client, 이름만 밝힌 도구)
    select 90, substring(ua from '^\s*([A-Za-z0-9._@+-]+)'), null
    where substring(ua from '^\s*([A-Za-z0-9._@+-]+)') is not null
  ) m
  order by ord
  limit 1
$$;

-- 다시 분류: 분류 열만, 바뀌는 줄만 (원본 열·줄 수는 그대로 → 여러 번 실행해도 같은 결과)
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

update public.mcp_calls m
set bot_kind = c.kind, bot_name = c.name
from (select id, (public.classify_user_agent(user_agent)).* from public.mcp_calls where user_agent is not null) c
where m.id = c.id
  and (m.bot_kind is distinct from c.kind or m.bot_name is distinct from c.name);

-- ── 확인용 ─────────────────────────────────────────────
-- 1) 예시 UA 판정:
-- select ua, (classify_user_agent(ua)).* from (values
--   ('histor/0.5.1 (+https://histor.modelmarket.dev/#crawler; read-only: discover + tools/list)'),
--   ('AgentReadyProbe/1.0 (+https://agentready.co/methodology; discovery and list requests only)'),
--   ('mcp.market uptime check (+https://mcp.market/docs/rubric)'),
--   ('heldfast (+https://github.com/rufat325/heldfast)'), ('node'), ('python-httpx/0.28.1'), ('Foobot/1.0'),
--   ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36')
-- ) v(ua);
--
-- 2) 24시간 성격·이름별 (예전 'other' 가 어떤 이름으로 나뉘었는지):
-- select coalesce(bot_kind, '(none)') as bot_kind, coalesce(bot_name, '(no name)') as bot_name, count(*)
-- from edge_hits where created_at >= now() - interval '24 hours'
-- group by 1, 2 order by 3 desc limit 60;
--
-- 3) 성격별 합계(24시간):
-- select coalesce(bot_kind, '(none)') as bot_kind, count(*), count(distinct bot_name) as names
-- from edge_hits where created_at >= now() - interval '24 hours' group by 1 order by 2 desc;
