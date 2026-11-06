-- 2026-11-06: 받아들인 알림(notifications/*, HTTP 202)의 결과를 no_response → ok 로 바로잡는다.
-- 알림은 응답 본문이 없는 것이 규격대로라 실패가 아니다. 사실(요청·상태 코드)은 그대로, 분류 규칙만 고친다.
-- api/mcp.ts judge() 도 같은 날 바뀌었다. 공개 집계(상황판·Agent Observatory)는 initialize·tools/list·tools/call 만 세므로 영향 없음.
-- Supabase SQL Editor 에서 실행, 여러 번 실행해도 안전.
set statement_timeout = '2min';

update public.mcp_calls
set outcome = 'ok'
where is_notification
  and outcome = 'no_response'
  and coalesce(http_status, 0) < 400;

-- 확인: select is_notification, outcome, count(*) from public.mcp_calls group by 1, 2 order by 1, 2;
