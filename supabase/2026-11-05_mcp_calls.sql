-- 2026-11-05: 원격 MCP(/mcp) JSON-RPC 메시지별 기록 (Supabase SQL Editor 에서 실행, 여러 번 실행해도 안전)
-- api/mcp.ts 가 쓴다. edge_hits 는 /mcp 요청 1건 = 1줄(본문 모름), 이 표는 JSON-RPC 메시지 1개 = 1줄.
--   → initialize(발견) · tools/list(목록 조회) · tools/call(실제 사용)을 구분해 센다.
-- 저장하지 않는 것: IP, 세션, 도구 인자 값(get_lowdown 의 target 은 reputation_lookups 에 이미 남음), find_servers 검색어.
-- 공개하지 않는다(select policy 없음).
--
-- 자기 선언 값: declared_client_name·declared_client_version(initialize 의 clientInfo), declared_agent_id(x-agent-id 헤더).
--   검증된 신원이 아니다. bot_kind·bot_name 도 User-Agent 문자열로 붙인 분류일 뿐이다.
-- 연결 범위: 세션 없는 서버라 clientInfo 는 initialize 줄에만 있다. 같은 request_id(같은 HTTP 요청) 또는
--   같은 declared_agent_id 일 때만 같은 출처로 묶는다. User-Agent·시간 근접으로 같은 클라이언트라고 추정하지 않는다.
--
-- outcome:
--   ok          응답의 result 를 받음
--   tool_error  tools/call 이 result.isError = true (도구는 돌았고 조회가 실패를 알림, 예: 503·형식 오류)
--   rpc_error   JSON-RPC error 응답 (error_code = JSON-RPC 코드, 예: -32700 깨진 JSON, -32602 잘못된 인자)
--   http_error  JSON-RPC 응답 없이 HTTP 오류 (error_code = HTTP 상태, 예: GET 405)
--   no_response 알림(notification, id 없음) — 규약상 응답이 없다
--   unknown     응답을 읽지 못함(너무 큼·형식 밖)

create table if not exists public.mcp_calls (
  id                       bigint generated always as identity primary key,
  created_at               timestamptz not null default now(),
  request_id               uuid        not null,          -- 같은 HTTP 요청의 메시지끼리 같은 값
  http_method              text        not null,          -- POST · GET · DELETE 등
  http_status              int,
  batch_size               int         not null default 0, -- 이 HTTP 요청의 메시지 수(배치가 아니면 1, 본문 없음 0)
  msg_index                int,                            -- 배치 안 순서(0부터). 메시지 없는 요청은 null
  rpc_method               text,                           -- initialize · notifications/initialized · tools/list · tools/call · ping ...
  is_notification          boolean     not null default false,
  tool_name                text,                           -- tools/call: get_lowdown · find_servers · 그 밖은 'unknown'
  menu                     text,                           -- get_lowdown 의 menu (정해진 목록 값만)
  declared_client_name     text,                           -- initialize 의 clientInfo.name (자기 선언)
  declared_client_version  text,
  protocol_version         text,                           -- initialize 의 protocolVersion 또는 mcp-protocol-version 헤더
  declared_agent_id        text,                           -- x-agent-id 헤더 (자기 선언, 예: ERC-8004 ID)
  outcome                  text        not null,
  error_code               int,
  duration_ms              int,
  user_agent               text,
  bot_kind                 text,
  bot_name                 text,
  constraint mcp_calls_outcome_check
    check (outcome in ('ok', 'tool_error', 'rpc_error', 'http_error', 'no_response', 'unknown'))
);
create index if not exists mcp_calls_created_idx on public.mcp_calls (created_at desc);
create index if not exists mcp_calls_method_idx  on public.mcp_calls (rpc_method, created_at desc);
create index if not exists mcp_calls_request_idx on public.mcp_calls (request_id);

alter table public.mcp_calls enable row level security;
drop policy if exists mcp_calls_insert on public.mcp_calls;
create policy mcp_calls_insert on public.mcp_calls for insert to anon, authenticated with check (true);

-- 봇 분류: edge_hits·reputation_lookups 와 같은 classify_user_agent()
create or replace function public.mcp_calls_set_bot()
returns trigger language plpgsql as $$
declare c record;
begin
  if new.user_agent is not null then
    select * into c from public.classify_user_agent(new.user_agent);
    new.bot_kind := c.kind;
    new.bot_name := c.name;
  end if;
  return new;
end $$;
drop trigger if exists mcp_calls_set_bot on public.mcp_calls;
create trigger mcp_calls_set_bot before insert on public.mcp_calls
  for each row execute function public.mcp_calls_set_bot();

-- ── 확인용 ─────────────────────────────────────────────
-- 1) 메서드별 건수(24시간):
-- select coalesce(rpc_method, '(' || http_method || ')') as method, outcome, count(*)
-- from mcp_calls where created_at >= now() - interval '24 hours'
-- group by 1, 2 order by 3 desc;
--
-- 2) 단계별 출처 수 — User-Agent 문자열별 "집계". 같은 방문자의 행동 경로가 아니다(UA 가 같은 다른 클라이언트가 합쳐진다):
-- select coalesce(bot_name, user_agent) as visitor,
--        count(*) filter (where rpc_method = 'initialize') as initialize,
--        count(*) filter (where rpc_method = 'tools/list') as tools_list,
--        count(*) filter (where rpc_method = 'tools/call') as tools_call,
--        count(*) filter (where rpc_method = 'tools/call' and outcome = 'ok') as tools_call_ok,
--        min(created_at at time zone 'Asia/Seoul') as first_kst, max(created_at at time zone 'Asia/Seoul') as last_kst
-- from mcp_calls where created_at >= now() - interval '7 days'
-- group by 1 order by tools_call desc, initialize desc;
--
-- 3) 전환(단계별 UA 수): initialize 를 보낸 UA 중 tools/list·tools/call 까지 보낸 UA 수. UA 단위 집계일 뿐이다.
-- with s as (
--   select user_agent,
--          bool_or(rpc_method = 'initialize') as did_init,
--          bool_or(rpc_method = 'tools/list') as did_list,
--          bool_or(rpc_method = 'tools/call') as did_call
--   from mcp_calls where created_at >= now() - interval '7 days' and user_agent is not null group by 1)
-- select count(*) filter (where did_init) as init_uas,
--        count(*) filter (where did_init and did_list) as init_list_uas,
--        count(*) filter (where did_init and did_list and did_call) as init_list_call_uas
-- from s;
--
-- 4) 스스로 밝힌 클라이언트(initialize 의 clientInfo):
-- select declared_client_name, declared_client_version, coalesce(bot_name, user_agent) as visitor, count(*)
-- from mcp_calls where rpc_method = 'initialize' and created_at >= now() - interval '7 days'
-- group by 1, 2, 3 order by 4 desc;
--
-- 5) 재방문·간격: UA 별 HTTP 요청 시각 간격(분)의 중앙값
-- with r as (select distinct request_id, user_agent, min(created_at) over (partition by request_id) as t
--            from mcp_calls where created_at >= now() - interval '3 days' and user_agent is not null),
--      g as (select user_agent, extract(epoch from t - lag(t) over (partition by user_agent order by t)) / 60 as gap_min from r)
-- select user_agent, count(*) + 1 as requests, round(percentile_cont(0.5) within group (order by gap_min)::numeric, 1) as median_gap_min
-- from g where gap_min is not null group by 1 having count(*) >= 3 order by 2 desc limit 30;
--
-- 6) 같은 요청 안에서 확정 연결되는 경로(배치):
-- select request_id, string_agg(rpc_method, ' → ' order by msg_index) as path, max(declared_client_name) as client
-- from mcp_calls where batch_size > 1 group by 1 order by min(created_at) desc limit 20;
