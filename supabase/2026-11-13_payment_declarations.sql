-- 2026-11-13: 결제 선언 요약 (Payment Facts 의 declared) — 공개 조회용 1일 1회 계산 표.
-- Supabase SQL Editor 에서 postgres 로 pack 실행(node scanner/migrations.ts pack supabase/2026-11-13_payment_declarations.sql --out pack.sql).
-- 여러 번 실행해도 안전. 먼저 2026-11-05_subjects.sql · 2026-11-05_erc8004.sql · 2026-11-06_card_discovery.sql 이 실행돼 있어야 한다.
--
-- 왜 따로 표인가: 선언의 원천(card_bodies, erc8004_files, subject_links)은 비공개라 조회 API(anon)가 직접 읽지 못한다.
--   여기에는 "이 Registry 항목에 대해 이런 결제 지원 선언이 있다 + 확인일"만 둔다. 원문·설명문·수취 주소는 넣지 않는다.
-- 선언은 검증이 아니다: 카드나 등록 파일이 결제를 말했다는 사실만. 관측(payment.observed, scanner_observations)과 섞지 않는다.
--
-- 채우는 규칙
--   server_card: Registry 원격 주소의 카드(<주소>/server-card, card_endpoint_checks) 또는 공유가 아닌 호스트의
--                /.well-known/mcp 카드(card_host_checks.mcp_well_known)가 found 이고, 그 원문(card_bodies)에
--                x402 언급(`x402`) 또는 MPP 언급(`mpp`, `machine payment(s) protocol`, 단어 단위)이 있으면 1행.
--                공유 호스트(Registry 주소 5개 이상)의 도메인 카드는 그 서버가 아니라 호스트의 선언이라 뺀다.
--   erc8004:     에이전트별 최신 ok 등록 파일이 x402Support = true 이고, 그 파일이 MCP 서비스로 선언한 주소가
--                Registry 항목이 선언한 원격 주소와 같을 때(subject_links: erc8004 → endpoint ← registry) 1행.
--                services 가 비었거나 MCP 주소가 Registry 와 겹치지 않는 선언(2026-11-13 조사: Ethereum 템플릿 대량 등록)은 들어오지 않는다.
-- 계산: lowdown_payment_declarations_refresh() 가 표 전체를 다시 쓴다(한 트랜잭션). pg_cron 매일 UTC 03:47
--   (연결 상태 요약 03:37 뒤, 카드 조리 04:00 전 → 같은 날 카드에 반영).

set statement_timeout = '5min';

create table if not exists public.payment_declarations (
  target_id     text        not null,                 -- mcp:<Registry 이름>
  source        text        not null check (source in ('server_card', 'erc8004')),
  ref           text        not null,                 -- server_card: 카드 URL(공개 확인 표의 값) / erc8004: eip155:{chainId}#{agentId}
  protocols     text[]      not null,                 -- {x402} / {mpp} / {x402,mpp}
  with_service  text,                                 -- erc8004: 함께 선언한 서비스(mcp). server_card: null
  checked_on    date        not null,                 -- 카드 확인일 / 등록 파일을 읽은 날 (UTC)
  computed_at   timestamptz not null default now(),
  primary key (target_id, source, ref)
);

alter table public.payment_declarations enable row level security;
drop policy if exists payment_declarations_read on public.payment_declarations;
create policy payment_declarations_read on public.payment_declarations for select to anon, authenticated using (true);
revoke insert, update, delete, truncate on public.payment_declarations from anon, authenticated;
grant select on public.payment_declarations to anon, authenticated;

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
  cards as (
    select unnest(c.registry_names) as name,
           c.result->>'url'         as url,
           c.result->>'sha256'      as sha256,
           (c.checked_at at time zone 'utc')::date as day
    from card_endpoint_checks c
    where c.result->>'outcome' = 'found' and c.result->>'sha256' is not null
    union all
    select n.name,
           h.results->'mcp_well_known'->>'url',
           h.results->'mcp_well_known'->>'sha256',
           (h.checked_at at time zone 'utc')::date
    from card_host_checks h
    join host_names n on n.origin = h.origin
    where not h.shared
      and h.results->'mcp_well_known'->>'outcome' = 'found'
      and h.results->'mcp_well_known'->>'sha256' is not null
  ),
  marked as (
    select k.name, k.url, k.day,
           array_remove(array[
             case when b.body ~* 'x402' then 'x402' end,
             case when b.body ~* mpp_re then 'mpp' end
           ], null) as protocols
    from cards k
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

select cron.unschedule('lowdown-payment-declarations') where exists (select 1 from cron.job where jobname = 'lowdown-payment-declarations');
select cron.schedule('lowdown-payment-declarations', '47 3 * * *', 'select public.lowdown_payment_declarations_refresh()');

-- 첫 계산
select public.lowdown_payment_declarations_refresh();

notify pgrst, 'reload schema';

-- ── 확인 (각각 따로, 분석 역할로) ───────────────────────────
-- select source, protocols, count(*), count(distinct target_id) from public.payment_declarations group by 1, 2 order by 3 desc;
-- MPP 언급 오탐 훑어보기: select target_id, ref from public.payment_declarations where 'mpp' = any(protocols) limit 30;
-- select has_table_privilege('anon', 'payment_declarations', 'select') as anon_select, has_table_privilege('anon', 'payment_declarations', 'insert') as anon_insert;
