-- 2026-11-25: mcp_calls 선언 이름 보조 분류의 bot_name을 기존 이름 io.verifymcp 로 통일. Supabase SQL Editor에서 실행(pack), 여러 번 실행해도 결과 같음
-- 근거: 2026-11-25_mcp_calls_declared.sql 적용 뒤 같은 점검기가 두 이름으로 갈림(io.verifymcp 44건 = UA 규칙 2, verifymcp-probe 50건 = 선언 이름 보조 분류).
--   선언 이름은 둘 다 verifymcp-probe 라 같은 점검기 → M5(점검기 이름 수)가 1개를 2개로 셈. 이미 적용한 파일은 고치지 않고(checksum) 새 파일로 맞춘다.
-- 바뀐 것: (1) mcp_calls_set_bot() 의 보조 분류 이름을 'io.verifymcp' 로 (2) 이미 verifymcp-probe 로 붙은 mcp_calls 행의 bot_name 을 io.verifymcp 로.
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
  -- 선언 이름 보조 분류(명시 목록, UA 분류가 kind를 주지 못한 행만). 이름은 UA 규칙이 붙이는 기존 이름과 같게 한다.
  if new.bot_kind is null and new.declared_client_name is not null then
    if new.declared_client_name ilike 'verifymcp-probe%' then
      new.bot_kind := 'prober';
      new.bot_name := 'io.verifymcp';
    end if;
  end if;
  return new;
end $$;

update public.mcp_calls
set bot_name = 'io.verifymcp'
where declared_client_name ilike 'verifymcp-probe%' and bot_kind = 'prober' and bot_name = 'verifymcp-probe';

-- 확인:
-- select declared_client_name, bot_kind, bot_name, count(*) from mcp_calls where declared_client_name ilike 'verifymcp-probe%' group by 1, 2, 3;   -- prober / io.verifymcp / 94
