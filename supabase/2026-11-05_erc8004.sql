-- 2026-11-05: ERC-8004 등록 수집 (scanner/erc8004.ts) — Supabase SQL Editor 에서 실행, 여러 번 실행해도 안전
-- 먼저 2026-11-05_subjects.sql 이 실행돼 있어야 한다(lowdown_subject·lowdown_link·subject_ids).
--
-- 무엇: Base(8453)·Ethereum(1) 의 ERC-8004 Identity Registry(0x8004A169…a432) 이벤트를 읽어
--   에이전트별 agentURI·소유 주소를 두고, agentURI 가 가리키는 등록 파일을 가져와 원문과 결과를 남긴다.
--   등록 파일이 선언한 서비스(MCP 엔드포인트·A2A 카드·웹)는 이름표·연결선(declares_service, basis=declared)으로 잇는다
--   → lowdown_probe_targets 에 Registry 엔드포인트와 같은 줄로 들어온다.
-- 원칙: 지우지 않는다(이벤트·가져오기 결과 모두 누적). 판정하지 않는다(선언을 선언으로 기록). 비공개(RLS, 정책 없음).
--   등록 파일에 주소가 적혀 있다는 것은 그 주소를 소유했다는 증명이 아니다(도메인 확인은 별도 단계: controls_domain, verified).
--   등록 파일은 공개 데이터라 원문(256KB 이하, JSON)을 보관한다. 주소의 쿼리 문자열은 이름표에 넣지 않는다(subjects 규칙).

set statement_timeout = '5min';

-- 체인별 읽은 위치
create table if not exists public.erc8004_cursor (
  chain_id     int         primary key,
  registry     text        not null,          -- 소문자 주소
  first_block  bigint,                        -- 레지스트리 코드가 처음 있는 블록(찾은 값)
  last_block   bigint      not null,          -- 여기까지 읽음(포함)
  updated_at   timestamptz not null default now()
);

-- 체인 이벤트 원본 (Registered, URIUpdated, Transfer). 지우지 않는다.
create table if not exists public.erc8004_events (
  id           bigint generated always as identity primary key,
  chain_id     int         not null,
  registry     text        not null,
  block_number bigint      not null,
  tx_hash      text        not null,
  log_index    int         not null,
  kind         text        not null check (kind in ('registered', 'uri_updated', 'transfer')),
  agent_id     numeric(78) not null,
  uri          text,                          -- registered·uri_updated (64KB 넘으면 잘라서 uri_truncated)
  uri_truncated boolean    not null default false,
  actor        text,                          -- registered: owner, uri_updated: updatedBy, transfer: to
  from_address text,                          -- transfer: from
  observed_at  timestamptz not null default now(),
  unique (chain_id, tx_hash, log_index)
);
create index if not exists erc8004_events_agent_idx on public.erc8004_events (chain_id, agent_id, block_number);

-- 에이전트별 현재 상태(이벤트에서 계산해 덮어씀)
create table if not exists public.erc8004_agents (
  chain_id         int         not null,
  agent_id         numeric(78) not null,
  registry         text        not null,
  owner            text,
  agent_uri        text,
  uri_truncated    boolean     not null default false,
  registered_block bigint,
  uri_block        bigint,                    -- agent_uri 가 마지막으로 정해진 블록
  first_seen_at    timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  last_fetch_at    timestamptz,
  last_fetch_uri   text,                      -- 마지막으로 가져온 agent_uri (바뀌면 다시 가져온다)
  last_fetch_outcome text,
  primary key (chain_id, agent_id)
);

-- 등록 파일 가져오기 결과 (가져올 때마다 1줄, 지우지 않는다)
create table if not exists public.erc8004_files (
  id            bigint generated always as identity primary key,
  chain_id      int         not null,
  agent_id      numeric(78) not null,
  agent_uri     text        not null,
  fetched_at    timestamptz not null default now(),
  outcome       text        not null check (outcome in (
                  'ok', 'empty_uri', 'unsupported_scheme', 'private_host', 'http_error', 'timeout', 'network',
                  'too_large', 'invalid_json', 'not_object', 'uri_truncated')),
  http_status   int,
  bytes         int,
  sha256        text,
  body          jsonb,                        -- ok 일 때만
  services      jsonb,                        -- ok: [{name, endpoint, version}] (body.services, 옛 형식 body.endpoints)
  fetch_via     text,                         -- https | ipfs_gateway | data
  run_id        uuid
);
create index if not exists erc8004_files_agent_idx on public.erc8004_files (chain_id, agent_id, fetched_at desc);

alter table public.erc8004_cursor enable row level security;
alter table public.erc8004_events enable row level security;
alter table public.erc8004_agents enable row level security;
alter table public.erc8004_files  enable row level security;
revoke all on public.erc8004_cursor, public.erc8004_events, public.erc8004_agents, public.erc8004_files from anon, authenticated;

-- ── 이벤트 → 에이전트 상태 ─────────────────────────────
-- 수집기가 이벤트를 넣은 뒤 부른다. 이번에 이벤트가 생긴 에이전트만 다시 계산(블록·로그 순서의 마지막 값).
create or replace function public.lowdown_erc8004_apply(p_chain int, p_from_block bigint)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare v_n int;
begin
  perform set_config('statement_timeout', '120s', true);
  with touched as (
    select distinct agent_id from erc8004_events where chain_id = p_chain and block_number >= p_from_block
  ), reg as (
    select distinct on (e.agent_id) e.agent_id, e.registry, e.block_number, e.actor
    from erc8004_events e join touched t using (agent_id)
    where e.chain_id = p_chain and e.kind = 'registered'
    order by e.agent_id, e.block_number, e.log_index
  ), uri as (
    select distinct on (e.agent_id) e.agent_id, e.uri, e.uri_truncated, e.block_number
    from erc8004_events e join touched t using (agent_id)
    where e.chain_id = p_chain and e.kind in ('registered', 'uri_updated')
    order by e.agent_id, e.block_number desc, e.log_index desc
  ), own as (
    select distinct on (e.agent_id) e.agent_id, e.actor
    from erc8004_events e join touched t using (agent_id)
    where e.chain_id = p_chain and e.kind in ('registered', 'transfer')
    order by e.agent_id, e.block_number desc, e.log_index desc
  )
  insert into erc8004_agents as a (chain_id, agent_id, registry, owner, agent_uri, uri_truncated, registered_block, uri_block, updated_at)
  select p_chain, t.agent_id, coalesce(reg.registry, (select registry from erc8004_cursor where chain_id = p_chain)),
         own.actor, uri.uri, coalesce(uri.uri_truncated, false), reg.block_number, uri.block_number, now()
  from touched t left join reg using (agent_id) left join uri using (agent_id) left join own using (agent_id)
  on conflict (chain_id, agent_id) do update set
    owner = excluded.owner, agent_uri = excluded.agent_uri, uri_truncated = excluded.uri_truncated,
    registered_block = coalesce(a.registered_block, excluded.registered_block), uri_block = excluded.uri_block, updated_at = now();
  get diagnostics v_n = row_count;
  return v_n;
end
$fn$;
revoke all on function public.lowdown_erc8004_apply(int, bigint) from public, anon, authenticated;

-- 가져올 차례: 한 번도 안 가져왔거나, agent_uri 가 바뀌었거나, 마지막 가져오기가 7일 지난 것.
--   순서: 처음 가져오는 것 → URI 바뀐 것 → 오래된 것. 같은 묶음 안에서는 최근 등록부터.
create or replace view public.erc8004_fetch_due as
select chain_id, agent_id, agent_uri, uri_truncated,
       case when last_fetch_at is null then 0 when last_fetch_uri is distinct from agent_uri then 1 else 2 end as due_rank,
       registered_block
from erc8004_agents
where agent_uri is not null
  and (last_fetch_at is null or last_fetch_uri is distinct from agent_uri or last_fetch_at < now() - interval '7 days');
revoke all on public.erc8004_fetch_due from anon, authenticated;

-- ── 가져오기 결과 → 에이전트 표시 + 이름표·연결선 ────────
-- 수집기가 erc8004_files 를 넣은 뒤 부른다(이번 실행 run_id). 선언된 서비스를 선으로 잇는다.
--   erc8004 이름표 값: eip155:{chainId}:{registry 소문자}#{agentId}
--   서비스 name 이 mcp → endpoint 이름표(declares_service, evidence {service, version}) + 도메인(hosted_on, derived)
--   name 이 a2a → a2a_card 이름표 + 도메인 / name 이 web 이고 http(s) → 도메인만(declares_service)
--   그 밖(ENS, DID, email, OASF …)은 원문에만 남긴다.
create or replace function public.lowdown_erc8004_link(p_run uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_marked int; v_links int := 0; r record; v_agent bigint; v_t bigint; v_name text; v_ep text; v_ver text; v_n text;
begin
  perform set_config('statement_timeout', '240s', true);
  update erc8004_agents a set last_fetch_at = f.fetched_at, last_fetch_uri = f.agent_uri, last_fetch_outcome = f.outcome
  from (select distinct on (chain_id, agent_id) chain_id, agent_id, fetched_at, agent_uri, outcome
        from erc8004_files where run_id = p_run order by chain_id, agent_id, fetched_at desc) f
  where a.chain_id = f.chain_id and a.agent_id = f.agent_id;
  get diagnostics v_marked = row_count;

  for r in
    select distinct on (f.chain_id, f.agent_id) f.chain_id, f.agent_id, a.registry, f.services
    from erc8004_files f join erc8004_agents a using (chain_id, agent_id)
    where f.run_id = p_run and f.outcome = 'ok' and jsonb_typeof(f.services) = 'array'
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
  return jsonb_build_object('agents_marked', v_marked, 'service_links', v_links);
end
$fn$;
revoke all on function public.lowdown_erc8004_link(uuid) from public, anon, authenticated;

-- ── 확인용 ─────────────────────────────────────────────
-- select * from erc8004_cursor;
-- select chain_id, kind, count(*) from erc8004_events group by 1, 2 order by 1, 2;
-- select chain_id, count(*), count(agent_uri) from erc8004_agents group by 1;
-- select outcome, fetch_via, count(*) from erc8004_files group by 1, 2 order by 3 desc;
-- select count(*) from lowdown_probe_targets where 'erc8004_registration' = any (sources);
-- select url, declared_by_names from lowdown_probe_targets where 'erc8004_registration' = any (sources) and 'mcp_registry' = any (sources) limit 20;
