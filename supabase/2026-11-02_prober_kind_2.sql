-- 2026-11-02 (2차): /mcp 요청에서 새로 보인 점검 봇을 분류에 더한다 — Supabase SQL Editor 에서 실행, 여러 번 실행해도 안전
-- 근거: edge_hits /mcp 3일치 (11:23 KST 확인)
--   prober (UA 에 probe·check·health check 를 밝힘): ragmap-check 30, LEGION-tlog 27, agent-collector 26
--   이름만 (성격 단정 불가 → bot_kind null): Talaria 35, FACTANKER(Enerlio GmbH) 36
-- 바꾼 것: 2026-11-02_prober_kind.sql 의 classify_user_agent() 목록에 5줄 추가 + edge_hits·reputation_lookups 다시 분류. 원본 열은 그대로.

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
      (38, 'ragmap-check',       'prober'),
      (39, 'LEGION-tlog',        'prober'),
      (40, 'agent-collector',    'prober'),
      (50, 'coda-agent-runtime', null),
      (51, 'Talaria',            null),
      (52, 'FACTANKER',          null)
    ) as t(ord, n, k)
    where ua ilike '%' || n || '%'
    union all
    select 99, 'other', 'crawler' where ua ~* '(bot|crawler|spider)'
  ) m
  order by ord
  limit 1
$$;

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
