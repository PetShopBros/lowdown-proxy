-- 2026-11-13: 결제 선언 이력 — 매일 다시 계산한 결과를 어제 표와 비교해 바뀐 것만 남긴다.
-- 2026-11-13_payment_declarations_v2.sql 뒤에 postgres 로 pack 실행. 여러 번 실행해도 안전.
--
-- 바뀌는 것
--   1) payment_declarations 에 열 추가: first_seen_on(처음 본 날), baseline(이력 기록 시작 전부터 있던 선언),
--      check_kind·check_key(그 선언을 낸 카드 확인 행 — endpoint 카드: 엔드포인트 주소 / host 카드: origin).
--      check_key 는 이미 공개 표(card_endpoint_checks·card_host_checks)에 있는 값이다.
--   2) payment_declaration_events (비공개, 추가만): added / removed / changed(프로토콜 바뀜), 날짜.
--   3) lowdown_payment_declarations_refresh(): 통째로 지우고 채우던 방식 → 새 결과와 어제 표를 비교해 반영.
-- 원칙
--   - 기준선(헌장 원칙 3): 이 파일 적용 전에 이미 있던 선언은 baseline = true, first_seen_on = 처음 계산한 날(UTC).
--     기준선 행은 added 이벤트를 만들지 않는다.
--   - 일시 실패는 사라짐이 아니다: server_card 선언이 오늘 결과에 없을 때, 그 카드 확인이 found(카드는 있는데 결제 언급·귀속이 빠짐)
--     또는 not_found(카드 없음)이면 removed. 그 밖(timeout·network·http_error·auth_required·wrong_shape·invalid_json·
--     skipped_after_timeouts·확인 행 없음)이면 어제 행을 그대로 둔다(checked_on 은 마지막으로 확인한 날 그대로).
--   - erc8004 는 최신 ok 파일만 보므로(가져오기 실패는 ok 파일을 바꾸지 않음) 그대로 비교한다.
--   - 이벤트 표는 비공개(전체 이력은 유료 후보, 11/12 결정). 공개 표에는 first_seen_on 한 줄만.
--   - 이벤트는 지우지 않는다(헌장 원칙 1).

set statement_timeout = '5min';

-- ── 1) 공개 표 열 추가 + 기준선 채우기 ─────────────────────
alter table public.payment_declarations add column if not exists first_seen_on date;
alter table public.payment_declarations add column if not exists baseline boolean not null default false;
alter table public.payment_declarations add column if not exists check_kind text;
alter table public.payment_declarations add column if not exists check_key text;

update public.payment_declarations
set first_seen_on = (computed_at at time zone 'utc')::date, baseline = true
where first_seen_on is null;

alter table public.payment_declarations alter column first_seen_on set not null;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'payment_declarations_check_kind_check') then
    alter table public.payment_declarations add constraint payment_declarations_check_kind_check
      check (check_kind is null or check_kind in ('endpoint', 'host'));
  end if;
end $$;

-- ── 2) 이벤트 표 (비공개, 추가만) ───────────────────────────
create table if not exists public.payment_declaration_events (
  id              bigint generated always as identity primary key,
  target_id       text        not null,
  source          text        not null,
  ref             text        not null,
  kind            text        not null check (kind in ('added', 'removed', 'changed')),
  from_protocols  text[],
  to_protocols    text[],
  day             date        not null,                 -- 계산한 날 (UTC)
  computed_at     timestamptz not null default now()
);
create index if not exists payment_declaration_events_target_idx on public.payment_declaration_events (target_id, day desc);
create index if not exists payment_declaration_events_day_idx on public.payment_declaration_events (day, id);
alter table public.payment_declaration_events enable row level security;
revoke all on public.payment_declaration_events from anon, authenticated;
grant select on public.payment_declaration_events to lowdown_analyst;

-- ── 3) 갱신 함수: 비교 후 반영 ─────────────────────────────
create or replace function public.lowdown_payment_declarations_refresh()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_day date := (now() at time zone 'utc')::date;
  v_new int := 0; v_carried int := 0; v_added int := 0; v_removed int := 0; v_changed int := 0;
  mpp_re constant text := '\m(mpp|machine[ -]payments?[ -]protocol)\M';
begin
  perform set_config('statement_timeout', '120s', true);

  create temp table _new (
    target_id text, source text, ref text, protocols text[], with_service text, checked_on date,
    check_kind text, check_key text,
    primary key (target_id, source, ref)
  ) on commit drop;

  -- 3-1) server_card (v2 규칙 그대로: claimed_name = Registry 이름이거나, 출처에 이어진 Registry 이름이 하나뿐)
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
           (c.checked_at at time zone 'utc')::date as day,
           'endpoint'::text as check_kind,
           c.endpoint as check_key
    from card_endpoint_checks c
    cross join lateral unnest(c.registry_names) as n(name)
    where c.result->>'outcome' = 'found' and c.result->>'sha256' is not null
    union all
    select n.name,
           h.results->'mcp_well_known'->>'url',
           h.results->'mcp_well_known'->>'sha256',
           h.results->'mcp_well_known'->>'claimed_name',
           hc.n_names,
           (h.checked_at at time zone 'utc')::date,
           'host'::text,
           h.origin
    from card_host_checks h
    join host_names n on n.origin = h.origin
    join host_counts hc on hc.origin = h.origin
    where not h.shared
      and h.results->'mcp_well_known'->>'outcome' = 'found'
      and h.results->'mcp_well_known'->>'sha256' is not null
  ),
  owned as (
    select * from cards
    where lower(coalesce(claimed, '')) = lower(name) or n_names = 1
  ),
  marked as (
    select k.name, k.url, k.day, k.check_kind, k.check_key,
           array_remove(array[
             case when b.body ~* 'x402' then 'x402' end,
             case when b.body ~* mpp_re then 'mpp' end
           ], null) as protocols
    from owned k
    join card_bodies b on b.sha256 = k.sha256
    where k.url is not null and k.name is not null
  )
  insert into _new (target_id, source, ref, protocols, with_service, checked_on, check_kind, check_key)
  select distinct on ('mcp:' || name, url) 'mcp:' || name, 'server_card', left(url, 2000), protocols, null, day, check_kind, check_key
  from marked
  where cardinality(protocols) > 0
  order by 'mcp:' || name, url, day desc
  on conflict do nothing;

  -- 3-2) erc8004 (그대로)
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
  insert into _new (target_id, source, ref, protocols, with_service, checked_on, check_kind, check_key)
  select distinct 'mcp:' || r.value, 'erc8004', 'eip155:' || x.chain_id || '#' || x.agent_id::text, array['x402'], 'mcp', x.day, null, null
  from x
  join subject_ids s   on s.scheme = 'erc8004' and s.value = x.subject_value
  join subject_links l on l.from_id = s.id and l.link_type = 'declares_service' and l.declared_by = 'erc8004_registration'
  join subject_ids e   on e.id = l.to_id and e.scheme = 'endpoint'
  join subject_links rl on rl.to_id = e.id and rl.link_type = 'declares_remote' and rl.declared_by = 'mcp_registry'
  join subject_ids r   on r.id = rl.from_id and r.scheme = 'registry'
  on conflict do nothing;

  select count(*) into v_new from _new;

  -- 3-3) 일시 실패는 어제 행을 그대로 (확인 결과가 found·not_found 가 아닐 때만)
  insert into _new (target_id, source, ref, protocols, with_service, checked_on, check_kind, check_key)
  select o.target_id, o.source, o.ref, o.protocols, o.with_service, o.checked_on, o.check_kind, o.check_key
  from payment_declarations o
  where o.source = 'server_card'
    and o.check_key is not null
    and not exists (select 1 from _new n where n.target_id = o.target_id and n.source = o.source and n.ref = o.ref)
    and coalesce(
          case o.check_kind
            when 'endpoint' then (select c.result->>'outcome' from card_endpoint_checks c where c.endpoint = o.check_key)
            when 'host'     then (select h.results->'mcp_well_known'->>'outcome' from card_host_checks h where h.origin = o.check_key)
          end, 'missing') not in ('found', 'not_found')
  on conflict do nothing;
  get diagnostics v_carried = row_count;

  -- 3-4) 이벤트: added / removed / changed
  insert into payment_declaration_events (target_id, source, ref, kind, from_protocols, to_protocols, day)
  select n.target_id, n.source, n.ref, 'added', null, n.protocols, v_day
  from _new n
  where not exists (select 1 from payment_declarations o where o.target_id = n.target_id and o.source = n.source and o.ref = n.ref);
  get diagnostics v_added = row_count;

  insert into payment_declaration_events (target_id, source, ref, kind, from_protocols, to_protocols, day)
  select o.target_id, o.source, o.ref, 'removed', o.protocols, null, v_day
  from payment_declarations o
  where not exists (select 1 from _new n where n.target_id = o.target_id and n.source = o.source and n.ref = o.ref);
  get diagnostics v_removed = row_count;

  insert into payment_declaration_events (target_id, source, ref, kind, from_protocols, to_protocols, day)
  select o.target_id, o.source, o.ref, 'changed', o.protocols, n.protocols, v_day
  from payment_declarations o
  join _new n on n.target_id = o.target_id and n.source = o.source and n.ref = o.ref
  where (select array_agg(x order by x) from unnest(o.protocols) x) is distinct from (select array_agg(x order by x) from unnest(n.protocols) x);
  get diagnostics v_changed = row_count;

  -- 3-5) 공개 표에 반영 (first_seen_on·baseline 은 유지)
  delete from payment_declarations o
  where not exists (select 1 from _new n where n.target_id = o.target_id and n.source = o.source and n.ref = o.ref);

  insert into payment_declarations (target_id, source, ref, protocols, with_service, checked_on, computed_at, first_seen_on, baseline, check_kind, check_key)
  select n.target_id, n.source, n.ref, n.protocols, n.with_service, n.checked_on, now(), v_day, false, n.check_kind, n.check_key
  from _new n
  on conflict (target_id, source, ref) do update
    set protocols = excluded.protocols,
        with_service = excluded.with_service,
        checked_on = excluded.checked_on,
        computed_at = excluded.computed_at,
        check_kind = excluded.check_kind,
        check_key = excluded.check_key;

  return jsonb_build_object('current', v_new, 'carried', v_carried, 'added', v_added, 'removed', v_removed, 'changed', v_changed);
end
$fn$;
revoke all on function public.lowdown_payment_declarations_refresh() from public, anon, authenticated;

-- 첫 실행: 기존 행은 기준선이라 added 가 생기지 않는다. 이 실행에서 check_kind·check_key 가 채워진다.
select public.lowdown_payment_declarations_refresh();

notify pgrst, 'reload schema';

-- ── 확인 (각각 따로, 분석 역할로) ───────────────────────────
-- select baseline, first_seen_on, count(*) from public.payment_declarations group by 1, 2 order by 2;
-- select count(*) filter (where check_key is null) as no_key, count(*) from public.payment_declarations where source = 'server_card';
-- select day, kind, count(*) from public.payment_declaration_events group by 1, 2 order by 1, 2;
-- select has_table_privilege('anon', 'payment_declaration_events', 'select') as anon_select;  -- false 여야 한다
