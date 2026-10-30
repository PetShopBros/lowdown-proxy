-- 2026-10-30: ChatGPT 원격 MCP 조회 UA(openai-mcp/1.0.0)를 ai_user 로 분류 (이반 실행 완료 2026-10-30 13:59 KST)
-- 배경: ChatGPT 개발 모드 플러그인으로 /mcp 의 get_lowdown 을 부르면 조회 API 에 UA "openai-mcp/1.0.0" 로 들어온다(13:57:49 KST 첫 확인, 이반 테스트).
--   기존 classify_user_agent() 목록에 없어 표시 없음(null)으로 분류됐다. Claude 원격 MCP 는 "Claude-User"(이미 ai_user).
-- 바꾼 것: 목록에 (5, 'openai-mcp', 'ai_user') 한 줄 추가. 나머지는 2026-10-26_lookups_bot_kind.sql 과 같다.
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
      (23, 'YandexBot',          'crawler')
    ) as t(ord, n, k)
    where ua ilike '%' || n || '%'
    union all
    select 99, 'other', 'crawler' where ua ~* '(bot|crawler|spider)'
  ) m
  order by ord
  limit 1
$$;

-- 이미 들어온 openai-mcp 줄 다시 분류 (새 열만 채움, user_agent 등 원래 값은 그대로)
update public.reputation_lookups set bot_kind = 'ai_user', bot_name = 'openai-mcp'
where user_agent ilike '%openai-mcp%' and bot_name is distinct from 'openai-mcp';
update public.edge_hits set bot_kind = 'ai_user', bot_name = 'openai-mcp'
where user_agent ilike '%openai-mcp%' and bot_name is distinct from 'openai-mcp';

-- 원격 MCP 실사용 확인 (테스트 제외: 12:27:50 lowdown-test/1030, 12:35:06·12:55:57 Claude-User, 13:57:49 openai-mcp — 모두 KST 10/30, 이반·Claude 세션 테스트)
-- select created_at at time zone 'Asia/Seoul' as kst, target, user_agent, bot_name, menu from reputation_lookups where ref = 'mcp' order by created_at desc;
