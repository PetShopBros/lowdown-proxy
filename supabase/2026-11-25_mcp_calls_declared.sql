-- 2026-11-25: mcp_calls 삽입 트리거가 UA 분류 결과가 null일 때 선언 클라이언트 이름(clientInfo.name)으로 보조 분류. Supabase SQL Editor에서 실행(pack), 여러 번 실행해도 결과 같음
-- 근거: verifymcp-probe는 UA가 Go-http-client(범용 라이브러리라 v7이 분류하지 않음)이고 선언 이름으로만 점검기임이 드러남(11/19~11/24 매일 1건, tool unknown).
--   M3 필터에서는 이미 빠지지만 M5(점검기 이름 수)와 bot_kind 열이 깨끗해진다.
-- 규칙: 선언 이름은 자기 선언이므로 UA 분류가 이미 kind를 준 행은 건드리지 않는다. 명시 목록만 쓴다(단어 패턴 금지 — mcp-gateway 같은 일반 이름이 섞이면 실사용이 빠짐).
-- 바뀐 것: mcp_calls_set_bot() 트리거 함수에 선언 이름 보조 분류 추가(UA 분류는 그대로). 과거 mcp_calls 행은 한 번 다시 분류.
set local statement_timeout = '300s';

create or replace function public.mcp_calls_set_bot()
returns trigger language plpgsql as $$
declare c record;
begin
  if new.user_agent is not null then
    select * into c from public.classify_user_agent(new.user_agent);
    new.bot_kind := c.kind;
    new.bot_name := c.name;
  end if;
  -- 선언 이름 보조 분류(명시 목록, UA 분류가 kind를 주지 못한 행만)
  if new.bot_kind is null and new.declared_client_name is not null then
    if new.declared_client_name ilike 'verifymcp-probe%' then
      new.bot_kind := 'prober';
      new.bot_name := 'verifymcp-probe';
    end if;
  end if;
  return new;
end $$;

-- 트리거 자체는 2026-11-05_mcp_calls.sql 에서 만들어짐(같은 함수 이름이라 재생성 불필요)

-- 다시 분류: 선언 이름이 verifymcp-probe 이고 아직 kind 없는 mcp_calls 행
update public.mcp_calls
set bot_kind = 'prober', bot_name = 'verifymcp-probe'
where declared_client_name ilike 'verifymcp-probe%' and bot_kind is null;

-- 확인:
-- select declared_client_name, bot_kind, bot_name, count(*) from mcp_calls where declared_client_name ilike 'verifymcp-probe%' group by 1, 2, 3;   -- prober / verifymcp-probe
-- select bot_kind, bot_name, count(*) from mcp_calls where created_at >= now() - interval '30 days' and rpc_method = 'tools/call' group by 1, 2 order by 3 desc;
