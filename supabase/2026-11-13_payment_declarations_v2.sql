-- 2026-11-13: 결제 선언 요약 v2 — server_card 귀속 규칙 고침. 2026-11-13_payment_declarations.sql 뒤에 pack 으로 실행(postgres).
-- 여러 번 실행해도 안전. 표 구조·권한·cron 은 그대로, 갱신 함수만 바꾸고 다시 계산한다.
--
-- 왜: v1 첫 계산에서 server_card x402+mpp 가 915 대상. 원인은 mcp.apify.com 의 호스트 카드(이름 com.apify/apify-mcp-server,
--   Authorization 설명에 "x402, MPP, or Skyfire")가 같은 주소를 원격으로 둔 Apify actor 래퍼 Registry 항목 수백 개에 붙은 것.
--   주소 정규화로 쿼리가 떨어져 엔드포인트 1개에 이름 수백 개 → 호스트 shared(주소 5개 이상) 판정에 걸리지 않았다.
--   그 카드는 Apify 의 선언이지 각 래퍼의 선언이 아니다(카드 원칙: 공유 호스트 카드는 호스트의 선언).
-- 규칙(v2): 카드 1장을 대상에 붙이는 것은
--   (1) 카드가 스스로 적은 이름(claimed_name)이 그 Registry 이름과 같을 때(대소문자 무시), 또는
--   (2) 그 카드의 출처(엔드포인트 카드: 그 엔드포인트, 호스트 카드: 그 호스트)에 이어진 Registry 이름이 하나뿐일 때.
-- erc8004 쪽은 바꾸지 않는다.

set statement_timeout = '5min';

create or replace function public.lowdown_payment_declarations_refresh()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_card int := 0; v_erc int := 0;
  mpp_re constant text := '\m(mpp|machine[ -]payments?[ -]protocol)\M';
begin
  perform set_config('statement_timeout', '120s', true);

  delete from payment_declarations;

  -- 1) server_card: 엔드포인트 카드 + 공유 아닌 호스트의 /.well-known/mcp 카드
  -- 호스트 → 그 호스트의 Registry 이름들 (한 번에 묶는다. 호스트마다 다시 훑지 않는다 — QUERY_RULES 2)
  with host_names as (
    select e.origin, n.name
    from card_endpoint_checks e
    cross join lateral unnest(e.registry_names) as n(name)
    group by e.origin, n.name
  ),
  host_counts as (
    select origin, count(*) as n_names from host_names group by origin
  ),
  cards as (
    select n.name,
           c.result->>'url'          as url,
           c.result->>'sha256'       as sha256,
           c.result->>'claimed_name' as claimed,
           cardinality(c.registry_names) as n_names,
           (c.checked_at at time zone 'utc')::date as day
    from card_endpoint_checks c
    cross join lateral unnest(c.registry_names) as n(name)
    where c.result->>'outcome' = 'found' and c.result->>'sha256' is not null
    union all
    select n.name,
           h.results->'mcp_well_known'->>'url',
           h.results->'mcp_well_known'->>'sha256',
           h.results->'mcp_well_known'->>'claimed_name',
           hc.n_names,
           (h.checked_at at time zone 'utc')::date
    from card_host_checks h
    join host_names n on n.origin = h.origin
    join host_counts hc on hc.origin = h.origin
    where not h.shared
      and h.results->'mcp_well_known'->>'outcome' = 'found'
      and h.results->'mcp_well_known'->>'sha256' is not null
  ),
  -- v2: 카드를 그 대상의 선언으로 보는 경우만 — 카드가 적은 이름이 그 Registry 이름과 같거나,
  --     그 카드의 출처(엔드포인트·호스트)에 이어진 Registry 이름이 하나뿐일 때
  owned as (
    select * from cards
    where lower(coalesce(claimed, '')) = lower(name) or n_names = 1
  ),
  marked as (
    select k.name, k.url, k.day,
           array_remove(array[
             case when b.body ~* 'x402' then 'x402' end,
             case when b.body ~* mpp_re then 'mpp' end
           ], null) as protocols
    from owned k
    join card_bodies b on b.sha256 = k.sha256
    where k.url is not null and k.name is not null
  )
  insert into payment_declarations (target_id, source, ref, protocols, with_service, checked_on)
  select distinct on ('mcp:' || name, url) 'mcp:' || name, 'server_card', left(url, 2000), protocols, null, day
  from marked
  where cardinality(protocols) > 0
  order by 'mcp:' || name, url, day desc
  on conflict (target_id, source, ref) do nothing;
  get diagnostics v_card = row_count;

  -- 2) erc8004: 최신 ok 파일이 x402Support = true 이고 MCP 주소가 Registry 원격 주소와 같은 에이전트
  with latest as (
    select distinct on (f.chain_id, f.agent_id) f.chain_id, f.agent_id, f.body, f.fetched_at
    from erc8004_files f
    where f.outcome = 'ok'
    order by f.chain_id, f.agent_id, f.fetched_at desc
  ),
  x as (
    select l.chain_id, l.agent_id, (l.fetched_at at time zone 'utc')::date as day,
           'eip155:' || l.chain_id || ':' || lower(a.registry) || '#' || l.agent_id::text as subject_value
    from latest l
    join erc8004_agents a on a.chain_id = l.chain_id and a.agent_id = l.agent_id
    where l.body->>'x402Support' = 'true'
  )
  insert into payment_declarations (target_id, source, ref, protocols, with_service, checked_on)
  select distinct 'mcp:' || r.value, 'erc8004', 'eip155:' || x.chain_id || '#' || x.agent_id::text, array['x402'], 'mcp', x.day
  from x
  join subject_ids s   on s.scheme = 'erc8004' and s.value = x.subject_value
  join subject_links l on l.from_id = s.id and l.link_type = 'declares_service' and l.declared_by = 'erc8004_registration'
  join subject_ids e   on e.id = l.to_id and e.scheme = 'endpoint'
  join subject_links rl on rl.to_id = e.id and rl.link_type = 'declares_remote' and rl.declared_by = 'mcp_registry'
  join subject_ids r   on r.id = rl.from_id and r.scheme = 'registry'
  on conflict (target_id, source, ref) do nothing;
  get diagnostics v_erc = row_count;

  return jsonb_build_object('server_card', v_card, 'erc8004', v_erc);
end
$fn$;
revoke all on function public.lowdown_payment_declarations_refresh() from public, anon, authenticated;

select public.lowdown_payment_declarations_refresh();

notify pgrst, 'reload schema';

-- ── 확인 (각각 따로, 분석 역할로) ───────────────────────────
-- select source, protocols, count(*), count(distinct target_id) from public.payment_declarations group by 1, 2 order by 3 desc;
-- select target_id, ref, protocols from public.payment_declarations where 'mpp' = any(protocols) order by target_id limit 40;
-- select ref, count(*) from public.payment_declarations group by 1 having count(*) > 1 order by 2 desc limit 10;
