-- 2026-11-05: ERC-8004 상태 계산·연결선을 수집기 호출(RPC)에서 DB 예약 작업(pg_cron, 10분마다)으로 옮긴다
-- (2026-11-05_erc8004.sql · _erc8004_refetch.sql 뒤에 실행, 여러 번 실행해도 안전)
--
-- 왜: 첫 실제 실행에서 lowdown_erc8004_apply 를 REST(RPC)로 부르자 57014 statement timeout.
--   REST 로 부른 함수는 역할(role)의 시간 제한을 받는다 — 함수 안의 set_config 로는 이미 시작된 문장의 제한을 늘릴 수 없다.
--   pg_cron 은 그 제한 밖에서 돈다(상황판·에이전트 집계와 같은 방식).
-- 바뀌는 것:
--   수집기: 이벤트·등록 파일을 저장만 한다(빠름). 상태 계산·연결선 호출 없음.
--   lowdown_erc8004_process(): 아직 반영 안 한 이벤트(id 기준)로 에이전트 상태를 계산하고, 아직 잇지 않은 등록 파일(linked=false)로 연결선.
--   한 번에 이벤트 20만 건·파일 2만 건까지, 남으면 다음 10분에 이어서.
-- 이전 함수(lowdown_erc8004_apply, lowdown_erc8004_link)는 지우지 않고 둔다(쓰지 않음).

set statement_timeout = '5min';

create table if not exists public.erc8004_process_state (
  chain_id          int         primary key,
  applied_event_id  bigint      not null default 0,  -- 여기까지(포함) 상태에 반영한 erc8004_events.id
  updated_at        timestamptz not null default now()
);
alter table public.erc8004_process_state enable row level security;
revoke all on public.erc8004_process_state from anon, authenticated;

alter table public.erc8004_files add column if not exists linked boolean not null default false;
create index if not exists erc8004_files_unlinked_idx on public.erc8004_files (id) where not linked;
create index if not exists erc8004_events_chain_id_idx on public.erc8004_events (chain_id, id);

create or replace function public.lowdown_erc8004_link_pending(p_limit int default 20000)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_marked int; v_links int := 0; r record; v_agent bigint; v_t bigint; v_name text; v_ep text; v_ver text; v_n text;
begin
  drop table if exists _f;
  create temp table _f on commit drop as
    select id, chain_id, agent_id, fetched_at, agent_uri, outcome, sha256, services
    from erc8004_files where not linked order by id limit p_limit;
  -- 가져온 결과 표시: 성공이면 해시·실패 횟수 0·점검 대상 선언 여부, 실패면 실패 횟수 +1(다시 시도 간격이 늘어난다)
  update erc8004_agents a set
    last_fetch_at = f.fetched_at, last_fetch_uri = f.agent_uri, last_fetch_outcome = f.outcome,
    last_ok_sha = case when f.outcome = 'ok' then f.sha256 else a.last_ok_sha end,
    fail_count = case when f.outcome = 'ok' then 0 else a.fail_count + 1 end,
    declares_probe = case when f.outcome = 'ok'
                          then coalesce((select bool_or(lower(btrim(coalesce(s->>'name', ''))) in ('mcp', 'a2a'))
                                         from jsonb_array_elements(case when jsonb_typeof(f.services) = 'array' then f.services else '[]'::jsonb end) s), false)
                          else a.declares_probe end
  from (select distinct on (chain_id, agent_id) chain_id, agent_id, fetched_at, agent_uri, outcome, sha256, services
        from _f order by chain_id, agent_id, fetched_at desc) f
  where a.chain_id = f.chain_id and a.agent_id = f.agent_id;
  get diagnostics v_marked = row_count;

  for r in
    select distinct on (f.chain_id, f.agent_id) f.chain_id, f.agent_id, a.registry, f.services
    from _f f join erc8004_agents a using (chain_id, agent_id)
    where f.outcome = 'ok' and jsonb_typeof(f.services) = 'array'
    order by f.chain_id, f.agent_id, f.fetched_at desc
  loop
    v_agent := lowdown_subject('erc8004', 'eip155:' || r.chain_id || ':' || lower(r.registry) || '#' || r.agent_id::text, 'erc8004_registration');
    for v_name, v_ep, v_ver in
      select lower(btrim(coalesce(s->>'name', ''))), btrim(coalesce(s->>'endpoint', '')), left(s->>'version', 40)
      from jsonb_array_elements(r.services) s limit 50
    loop
      v_n := lowdown_norm_endpoint(v_ep);
      continue when v_n is null;
      if v_name = 'mcp' then
        v_t := lowdown_subject('endpoint', v_n, 'erc8004_registration', lowdown_endpoint_attrs(v_ep));
      elsif v_name = 'a2a' then
        v_t := lowdown_subject('a2a_card', v_n, 'erc8004_registration');
      elsif v_name = 'web' then
        v_t := null;
      else
        continue;
      end if;
      if v_t is not null then
        perform lowdown_link(v_agent, v_t, 'declares_service', 'declared', 'erc8004_registration',
                             jsonb_strip_nulls(jsonb_build_object('service', v_name, 'version', v_ver)));  -- 전송 방식은 선언되지 않음
        v_links := v_links + 1;
        perform lowdown_link(v_t, lowdown_subject('domain', lowdown_url_host(v_ep), 'rule'), 'hosted_on', 'derived', 'rule');
      else
        perform lowdown_link(v_agent, lowdown_subject('domain', lowdown_url_host(v_ep), 'rule'), 'declares_service', 'declared', 'erc8004_registration',
                             jsonb_build_object('service', v_name));
        v_links := v_links + 1;
      end if;
    end loop;
  end loop;
  update erc8004_files x set linked = true from _f where x.id = _f.id;
  return jsonb_build_object('files', (select count(*) from _f), 'agents_marked', v_marked, 'service_links', v_links);
end
$fn$;

revoke all on function public.lowdown_erc8004_link_pending(int) from public, anon, authenticated;

create or replace function public.lowdown_erc8004_process()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  c int; v_from bigint; v_to bigint; v_n int; v_out jsonb := '{}'::jsonb; v_link jsonb;
begin
  perform pg_advisory_xact_lock(hashtext('lowdown_erc8004_process'));
  for c in select distinct chain_id from erc8004_cursor loop
    select applied_event_id into v_from from erc8004_process_state where chain_id = c;
    v_from := coalesce(v_from, 0);
    select max(id) into v_to from (select id from erc8004_events where chain_id = c and id > v_from order by id limit 200000) x;
    continue when v_to is null;
    -- 임시표로 나눠 통계를 잡는다: 한 문장 안의 CTE 조인은 계획이 중첩 반복으로 잡혀 3만 건에 100초가 걸렸다(로컬 확인).
    drop table if exists _t; drop table if exists _ev;
    create temp table _t on commit drop as
      select distinct agent_id from erc8004_events where chain_id = c and id > v_from and id <= v_to;
    analyze _t;
    create temp table _ev on commit drop as
      select e.agent_id, e.kind, e.registry, e.block_number, e.log_index, e.uri, e.uri_truncated, e.actor
      from erc8004_events e where e.chain_id = c and e.agent_id in (select agent_id from _t);
    analyze _ev;
    with reg as (
      select distinct on (agent_id) agent_id, registry, block_number from _ev
      where kind = 'registered' order by agent_id, block_number, log_index
    ), uri as (
      select distinct on (agent_id) agent_id, uri, uri_truncated, block_number, registry from _ev
      where kind in ('registered', 'uri_updated') order by agent_id, block_number desc, log_index desc
    ), own as (
      select distinct on (agent_id) agent_id, actor, registry from _ev
      where kind in ('registered', 'transfer') order by agent_id, block_number desc, log_index desc
    )
    insert into erc8004_agents as a (chain_id, agent_id, registry, owner, agent_uri, uri_truncated, registered_block, uri_block, updated_at)
    select c, t.agent_id, coalesce(reg.registry, uri.registry, own.registry, '0x8004a169fb4a3325136eb29fa0ceb6d2e539a432'),
           own.actor, uri.uri, coalesce(uri.uri_truncated, false), reg.block_number, uri.block_number, now()
    from _t t left join reg using (agent_id) left join uri using (agent_id) left join own using (agent_id)
    on conflict (chain_id, agent_id) do update set
      owner = coalesce(excluded.owner, a.owner), agent_uri = coalesce(excluded.agent_uri, a.agent_uri),
      uri_truncated = case when excluded.agent_uri is null then a.uri_truncated else excluded.uri_truncated end,
      registered_block = coalesce(a.registered_block, excluded.registered_block),
      uri_block = coalesce(excluded.uri_block, a.uri_block), updated_at = now();
    get diagnostics v_n = row_count;
    insert into erc8004_process_state (chain_id, applied_event_id, updated_at) values (c, v_to, now())
    on conflict (chain_id) do update set applied_event_id = excluded.applied_event_id, updated_at = now();
    v_out := v_out || jsonb_build_object('chain_' || c, jsonb_build_object('events_to', v_to, 'agents', v_n));
  end loop;
  v_link := lowdown_erc8004_link_pending(20000);
  return v_out || jsonb_build_object('link', v_link);
end
$fn$;
revoke all on function public.lowdown_erc8004_process() from public, anon, authenticated;

-- ── 10분마다 (pg_cron) ─────────────────────────────────
create extension if not exists pg_cron with schema pg_catalog;
do $$
begin
  if exists (select 1 from cron.job where jobname = 'lowdown-erc8004-process') then
    perform cron.unschedule('lowdown-erc8004-process');
  end if;
end $$;
select cron.schedule('lowdown-erc8004-process', '3-59/10 * * * *', 'select public.lowdown_erc8004_process()');

-- ── 확인용 ─────────────────────────────────────────────
-- select public.lowdown_erc8004_process();   -- 바로 한 번 (SQL Editor 는 시간 제한 밖)
-- select * from erc8004_process_state;
-- select start_time, status, left(return_message, 200) from cron.job_run_details
--   where jobid = (select jobid from cron.job where jobname = 'lowdown-erc8004-process') order by start_time desc limit 5;
