-- 2026-11-05: 공통 대상 열쇠 — 이름표(subject_ids) + 연결선(subject_links) (Supabase SQL Editor 에서 실행, 여러 번 실행해도 안전)
--
-- 왜: 같은 대상을 테이블마다 다른 이름으로 부른다(Registry 이름, 원격 주소, npm/pypi 패키지, 도메인, UA 이름, 자기 선언 ID).
--   기능마다 데이터가 갇히지 않고 서로 가져다 쓰려면, 이름끼리 이어 주는 층이 필요하다.
-- 방식: 하나로 합치지 않는다. 이름은 각자 이름표로 두고, 둘을 잇는 선에 근거(basis)를 붙인다.
--   "같은 대상"은 저장하지 않고 조회할 때 선을 따라가 계산한다(lowdown_subject_walk). 어떤 근거의 선까지 따라갈지는 쓰는 쪽이 고른다.
--   basis: declared = 누군가 선언함(Registry, ERC-8004 등록 파일, User-Agent …) / verified = 확인 절차 통과
--          derived = 규칙으로 계산(URL → 도메인) / operator = Lowdown 운영자가 직접 넣음(Lowdown 자신)
-- 지키는 것: 기존 테이블은 바꾸지 않는다. 선은 지우지 않는다(선언이 사라지면 last_seen_at 이 멈춘다). 공개하지 않는다(RLS, 정책 없음).
-- Scanner 확장 대비: 엔드포인트는 선언한 곳이 어디든 정규화한 주소 1개 = 이름표 1개.
--   lowdown_probe_targets 뷰가 엔드포인트당 1줄(점검 가능 여부, 선언한 곳들, 전송 방식)을 내므로,
--   Scanner 대상을 Registry cohort 밖으로 넓힐 때 이 뷰를 읽으면 된다. 여러 곳이 같은 주소를 선언해도 점검은 1번.
-- 매일 채우기: lowdown_subjects_refresh() — pg_cron 매일 UTC 02:47(11:47 KST, Scanner·Registry 비교 뒤).

set statement_timeout = '5min';

-- ── 표 ─────────────────────────────────────────────────
create table if not exists public.subject_ids (
  id             bigint generated always as identity primary key,
  scheme         text        not null check (scheme in (
                   'registry',    -- MCP Registry 이름 (io.github.x/y)
                   'endpoint',    -- 정규화한 원격 주소 (lowdown_norm_endpoint)
                   'domain',      -- 호스트 이름 (lowdown_norm_domain)
                   'npm', 'pypi', -- 패키지 이름
                   'package',     -- 그 밖의 패키지 (registryType:identifier)
                   'erc8004',     -- eip155:{chainId}:{identityRegistry}#{agentId} (소문자 주소)
                   'ua_name',     -- User-Agent 선언에서 뽑은 이름 (소문자)
                   'client_name', -- MCP initialize clientInfo.name
                   'a2a_card',    -- A2A agent card 주소
                   'lowdown')),   -- Lowdown 자신
  value          text        not null,
  attrs          jsonb       not null default '{}'::jsonb,  -- 이름표 성질(엔드포인트: templated, https, private_host, had_query)
  first_seen_at  timestamptz not null default now(),
  first_source   text        not null,
  unique (scheme, value)
);
alter table public.subject_ids enable row level security;
revoke all on public.subject_ids from anon, authenticated;

create table if not exists public.subject_links (
  id             bigint generated always as identity primary key,
  from_id        bigint      not null references public.subject_ids (id),
  to_id          bigint      not null references public.subject_ids (id),
  link_type      text        not null check (link_type in (
                   'declares_remote',   -- Registry 이름 → 엔드포인트 (Registry remotes)
                   'declares_package',  -- Registry 이름 → 패키지 (Registry packages)
                   'declares_service',  -- ERC-8004 에이전트 → 엔드포인트·A2A 카드 (등록 파일 services)
                   'hosted_on',         -- 엔드포인트·카드 → 도메인 (주소에서 계산)
                   'controls_domain',   -- 에이전트 → 도메인 (.well-known/agent-registration.json 확인)
                   'names_url_in_ua',   -- UA 이름 → 도메인 (User-Agent 문자열에 적힌 주소)
                   'is_lowdown')),      -- 이름 → Lowdown 자신
  basis          text        not null check (basis in ('declared', 'verified', 'derived', 'operator')),
  declared_by    text        not null,   -- mcp_registry, erc8004_registration, user_agent, rule, lowdown_operator …
  evidence       jsonb       not null default '{}'::jsonb, -- 예: {"transport":"streamable-http"}
  first_seen_at  timestamptz not null default now(),
  last_seen_at   timestamptz not null default now(),
  check (from_id <> to_id),
  unique (from_id, to_id, link_type, declared_by)
);
alter table public.subject_links enable row level security;
revoke all on public.subject_links from anon, authenticated;
create index if not exists subject_links_to_idx on public.subject_links (to_id);

-- ── 정규화 ─────────────────────────────────────────────
-- 도메인: 소문자, 끝 점·포트 제거. 형식이 아니면 null
create or replace function public.lowdown_norm_domain(h text)
returns text language sql immutable as $$
  select case when d ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$' or d ~ '^\[[0-9a-f:.]+\]$' then d end
  from (select regexp_replace(regexp_replace(lower(btrim(coalesce(h, ''))), ':[0-9]+$', ''), '\.$', '') as d) x
$$;

-- 엔드포인트: http(s) 만. 스킴·호스트 소문자, 기본 포트·쿼리·조각·끝 슬래시 제거(경로 대소문자는 그대로).
--   쿼리는 버린다: 키·토큰이 들어 있을 수 있어 저장하지 않는다(attrs.had_query 로 있었다는 사실만).
--   {변수} 가 든 템플릿 주소도 이름표로 두되 점검 대상은 아니다(attrs.templated).
create or replace function public.lowdown_norm_endpoint(u text)
returns text language sql immutable as $$
  with p as (
    select regexp_match(btrim(coalesce(u, '')), '^([A-Za-z][A-Za-z0-9+.-]*)://([^/?#]+)([^?#]*)') as m
  ), q as (
    select lower(m[1]) as sch, lower(m[2]) as auth, m[3] as path from p where m is not null
  ), r as (
    select sch,
           case when sch = 'https' then regexp_replace(auth, ':443$', '')
                when sch = 'http'  then regexp_replace(auth, ':80$', '') else auth end as auth,
           regexp_replace(path, '/+$', '') as path
    from q where sch in ('http', 'https') and auth !~ '@'
  )
  select sch || '://' || auth || path from r where auth <> ''
$$;

-- 주소의 호스트(포트 제외)
create or replace function public.lowdown_url_host(u text)
returns text language sql immutable as $$
  select public.lowdown_norm_domain((regexp_match(coalesce(u, ''), '^[A-Za-z][A-Za-z0-9+.-]*://([^/?#@]+)'))[1])
$$;

-- 사설·로컬 호스트(점검하지 않는다)
create or replace function public.lowdown_is_private_host(h text)
returns boolean language sql immutable as $$
  select coalesce(h, '') = '' or h in ('localhost', '[::1]', '0.0.0.0')
      or h ~ '(\.localhost|\.local|\.internal|\.lan|\.home\.arpa)$'
      or h ~ '^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2[0-9]|3[01])\.)'
      or h ~ '^\[(f[cd]|fe80)'
$$;

-- 엔드포인트 이름표 성질
create or replace function public.lowdown_endpoint_attrs(raw text)
returns jsonb language sql immutable as $$
  select jsonb_build_object(
    'https', public.lowdown_norm_endpoint(raw) like 'https://%',
    'templated', coalesce(raw, '') ~ '\{[^}]*\}',
    'had_query', coalesce(raw, '') ~ '\?',
    'private_host', case when public.lowdown_url_host(raw) is null then null  -- 템플릿 등으로 호스트를 못 읽음
                         else public.lowdown_is_private_host(public.lowdown_url_host(raw)) end)
$$;

-- ── 이름표·선 넣기 (다른 수집기도 이 두 함수만 부르면 된다) ──
create or replace function public.lowdown_subject(p_scheme text, p_value text, p_source text, p_attrs jsonb default '{}'::jsonb)
returns bigint language plpgsql
set search_path = public, pg_temp
as $$
declare v_id bigint;
begin
  if p_value is null or p_value = '' then return null; end if;
  insert into subject_ids (scheme, value, attrs, first_source)
  values (p_scheme, p_value, coalesce(p_attrs, '{}'::jsonb), p_source)
  on conflict (scheme, value) do update set attrs = subject_ids.attrs || excluded.attrs
    where subject_ids.attrs is distinct from subject_ids.attrs || excluded.attrs
  returning id into v_id;
  if v_id is null then select id into v_id from subject_ids where scheme = p_scheme and value = p_value; end if;
  return v_id;
end $$;

create or replace function public.lowdown_link(p_from bigint, p_to bigint, p_type text, p_basis text, p_by text, p_evidence jsonb default '{}'::jsonb)
returns void language sql
set search_path = public, pg_temp
as $$
  insert into subject_links (from_id, to_id, link_type, basis, declared_by, evidence)
  select p_from, p_to, p_type, p_basis, p_by, coalesce(p_evidence, '{}'::jsonb)
  where p_from is not null and p_to is not null and p_from <> p_to
  on conflict (from_id, to_id, link_type, declared_by)
  do update set last_seen_at = now(), basis = excluded.basis, evidence = subject_links.evidence || excluded.evidence
$$;

-- ── 매일 채우기 ────────────────────────────────────────
-- 1) MCP Registry(registry_state, 목록에 남아 있는 이름): 이름 → 원격 주소, 이름 → 패키지, 주소 → 도메인
--    remotes_key 한 줄 = "type url", packages_key 한 줄 = "registryType identifier version transport" (scanner/registry-diff.ts)
-- 2) Agent Observatory 최신 스냅샷: UA 이름 → UA 에 적힌 주소의 도메인
-- 3) Lowdown 자신(운영자 입력)
-- 집합 단위로 넣는다(행마다 함수 호출 안 함). 결과: 이번에 확인한 선 수.
create or replace function public.lowdown_subjects_refresh()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_now  timestamptz := now();
  v_out  jsonb;
  v_lid  bigint;
  rr     record;
begin
  perform set_config('statement_timeout', '240s', true);
  perform pg_advisory_xact_lock(hashtext('lowdown_subjects_refresh'));

  drop table if exists _rem; drop table if exists _pkg; drop table if exists _ua;
  create temp table _rem on commit drop as
    select s.name, split_part(l, ' ', 1) as transport, substr(l, length(split_part(l, ' ', 1)) + 2) as raw_url
    from registry_state s, unnest(string_to_array(s.remotes_key, E'\n')) as l
    where s.removed_at is null and s.remotes_key <> '' and l like '% %';
  delete from _rem where lowdown_norm_endpoint(raw_url) is null;

  create temp table _pkg on commit drop as
    select s.name, lower(split_part(l, ' ', 1)) as rtype, split_part(l, ' ', 2) as ident
    from registry_state s, unnest(string_to_array(s.packages_key, E'\n')) as l
    where s.removed_at is null and s.packages_key <> '' and split_part(l, ' ', 2) <> '';

  create temp table _ua on commit drop as
    select distinct lower(e->>'name_key') as ua, lowdown_url_host(u #>> '{}') as host
    from (select data from agent_snapshots order by hour_bucket desc limit 1) s,
         jsonb_array_elements(coalesce(s.data->'agents', '[]'::jsonb)) e,
         jsonb_array_elements(coalesce(e->'declared_urls', '[]'::jsonb)) u
    where coalesce(e->>'name_key', '') <> '';
  delete from _ua where host is null;

  -- 이름표
  insert into subject_ids (scheme, value, first_source)
    select distinct 'registry', name, 'mcp_registry' from registry_state where removed_at is null
  on conflict (scheme, value) do nothing;
  insert into subject_ids (scheme, value, attrs, first_source)
    select distinct on (n) 'endpoint', n, lowdown_endpoint_attrs(raw_url), 'mcp_registry'
    from (select lowdown_norm_endpoint(raw_url) as n, raw_url from _rem) x order by n, raw_url
  on conflict (scheme, value) do update set attrs = subject_ids.attrs || excluded.attrs  -- 성질 규칙이 바뀌면 다음 채우기에 반영
    where subject_ids.attrs is distinct from subject_ids.attrs || excluded.attrs;
  insert into subject_ids (scheme, value, first_source)
    select distinct 'domain', h, 'rule'
    from (select lowdown_url_host(raw_url) as h from _rem union select host from _ua) x where h is not null
  on conflict (scheme, value) do nothing;
  insert into subject_ids (scheme, value, first_source)
    select distinct case when rtype in ('npm', 'pypi') then rtype else 'package' end,
                    case when rtype in ('npm', 'pypi') then ident else rtype || ':' || ident end, 'mcp_registry'
    from _pkg
  on conflict (scheme, value) do nothing;
  insert into subject_ids (scheme, value, first_source)
    select distinct 'ua_name', ua, 'user_agent' from _ua
  on conflict (scheme, value) do nothing;

  -- 선 (이번에 다시 확인한 선은 last_seen_at 갱신)
  insert into subject_links (from_id, to_id, link_type, basis, declared_by, evidence)
    select distinct on (a.id, b.id) a.id, b.id, 'declares_remote', 'declared', 'mcp_registry', jsonb_build_object('transport', r.transport)
    from _rem r
    join subject_ids a on a.scheme = 'registry' and a.value = r.name
    join subject_ids b on b.scheme = 'endpoint' and b.value = lowdown_norm_endpoint(r.raw_url)
    order by a.id, b.id, r.transport
  on conflict (from_id, to_id, link_type, declared_by) do update
    set last_seen_at = v_now, evidence = subject_links.evidence || excluded.evidence;

  insert into subject_links (from_id, to_id, link_type, basis, declared_by)
    select distinct b.id, d.id, 'hosted_on', 'derived', 'rule'
    from _rem r
    join subject_ids b on b.scheme = 'endpoint' and b.value = lowdown_norm_endpoint(r.raw_url)
    join subject_ids d on d.scheme = 'domain' and d.value = lowdown_url_host(r.raw_url)
  on conflict (from_id, to_id, link_type, declared_by) do update set last_seen_at = v_now;

  insert into subject_links (from_id, to_id, link_type, basis, declared_by)
    select distinct a.id, b.id, 'declares_package', 'declared', 'mcp_registry'
    from _pkg p
    join subject_ids a on a.scheme = 'registry' and a.value = p.name
    join subject_ids b on b.scheme = case when p.rtype in ('npm', 'pypi') then p.rtype else 'package' end
                      and b.value = case when p.rtype in ('npm', 'pypi') then p.ident else p.rtype || ':' || p.ident end
  on conflict (from_id, to_id, link_type, declared_by) do update set last_seen_at = v_now;

  insert into subject_links (from_id, to_id, link_type, basis, declared_by)
    select distinct a.id, d.id, 'names_url_in_ua', 'declared', 'user_agent'
    from _ua u
    join subject_ids a on a.scheme = 'ua_name' and a.value = u.ua
    join subject_ids d on d.scheme = 'domain' and d.value = u.host
  on conflict (from_id, to_id, link_type, declared_by) do update set last_seen_at = v_now;

  -- Lowdown 자신 (운영자 입력; lowdown_is_self_* 함수와 같은 목록)
  v_lid := lowdown_subject('lowdown', 'lowdown', 'lowdown_operator');
  for rr in select * from (values ('ua_name', 'lowdown-scanner'), ('ua_name', 'lowdown-test'),
                                 ('registry', 'io.github.PetShopBros/lowdown-proxy'),
                                 ('endpoint', 'https://lowdown-proxy.vercel.app/mcp'),
                                 ('domain', 'lowdown-proxy.vercel.app')) as x(sch, val)
  loop
    perform lowdown_link(lowdown_subject(rr.sch, rr.val, 'lowdown_operator'), v_lid, 'is_lowdown', 'operator', 'lowdown_operator');
  end loop;

  select jsonb_build_object(
    'at', v_now,
    'subjects', (select count(*) from subject_ids),
    'links', (select count(*) from subject_links),
    'links_seen_now', (select count(*) from subject_links where last_seen_at >= v_now),
    'registry_remotes', (select count(*) from _rem),
    'registry_packages', (select count(*) from _pkg),
    'ua_urls', (select count(*) from _ua)) into v_out;
  return v_out;
end
$fn$;
revoke all on function public.lowdown_subjects_refresh() from public, anon, authenticated;

-- ── 선 따라가기 ─────────────────────────────────────────
-- 한 이름에서 출발해 선을 양방향으로 따라간다. 근거(p_bases)를 고르고, 기본은 도메인을 지나가지 않는다:
--   큰 호스팅 도메인(예: 여러 서버가 같은 도메인을 씀)을 지나면 서로 무관한 대상이 한 덩어리가 되기 때문.
create or replace function public.lowdown_subject_walk(
  p_scheme text, p_value text,
  p_bases text[] default array['declared', 'verified', 'derived', 'operator'],
  p_max_depth int default 2,
  p_through_domains boolean default false)
returns table (scheme text, value text, depth int, via_link text, via_basis text)
language sql stable
set search_path = public, pg_temp
as $$
  with recursive w(id, depth, via_link, via_basis, path) as (
    select s.id, 0, null::text, null::text, array[s.id] from subject_ids s where s.scheme = p_scheme and s.value = p_value
    union all
    select n.other, w.depth + 1, n.link_type, n.basis, w.path || n.other
    from w
    join subject_ids cur on cur.id = w.id
    join lateral (
      select l.to_id as other, l.link_type, l.basis from subject_links l where l.from_id = w.id and l.basis = any (p_bases)
      union all
      select l.from_id, l.link_type, l.basis from subject_links l where l.to_id = w.id and l.basis = any (p_bases)
    ) n on true
    where w.depth < p_max_depth
      and not n.other = any (w.path)
      and (p_through_domains or w.depth = 0 or cur.scheme <> 'domain')
  )
  select distinct on (s.id) s.scheme, s.value, w.depth, w.via_link, w.via_basis
  from w join subject_ids s on s.id = w.id
  order by s.id, w.depth
$$;

-- ── Scanner 확장용: 엔드포인트당 1줄 ───────────────────
-- probeable = https, 템플릿 아님, 사설 호스트 아님. sources = 이 주소를 선언한 곳들, declared_by_names = 선언한 이름표.
-- last_declared_at 이 오래되면 선언이 사라진 주소다(선은 지우지 않으므로 여기서 걸러 쓴다).
create or replace view public.lowdown_probe_targets as
select e.id as subject_id,
       e.value as url,
       lowdown_url_host(e.value) as host,
       coalesce((e.attrs->>'https')::boolean, false)
         and not coalesce((e.attrs->>'templated')::boolean, false)
         and not coalesce((e.attrs->>'private_host')::boolean, true) as probeable,
       e.attrs,
       array_agg(distinct l.declared_by order by l.declared_by) as sources,
       array_agg(distinct f.scheme || ':' || f.value order by f.scheme || ':' || f.value) as declared_by_names,
       array_remove(array_agg(distinct l.evidence->>'transport'), null) as transports,
       min(l.first_seen_at) as first_declared_at,
       max(l.last_seen_at) as last_declared_at
from subject_ids e
join subject_links l on l.to_id = e.id and l.link_type in ('declares_remote', 'declares_service')
join subject_ids f on f.id = l.from_id
where e.scheme = 'endpoint'
group by e.id, e.value, e.attrs;
revoke all on public.lowdown_probe_targets from anon, authenticated;

-- ── 매일 UTC 02:47 (11:47 KST) ─────────────────────────
create extension if not exists pg_cron with schema pg_catalog;
do $$
begin
  if exists (select 1 from cron.job where jobname = 'lowdown-subjects-refresh') then
    perform cron.unschedule('lowdown-subjects-refresh');
  end if;
end $$;
select cron.schedule('lowdown-subjects-refresh', '47 2 * * *', 'select public.lowdown_subjects_refresh()');

-- 첫 채우기
select public.lowdown_subjects_refresh();

-- ── 확인용 ─────────────────────────────────────────────
-- select scheme, count(*) from subject_ids group by 1 order by 2 desc;
-- select link_type, basis, count(*) from subject_links group by 1, 2 order by 3 desc;
-- select * from lowdown_subject_walk('registry', 'io.github.PetShopBros/lowdown-proxy');
-- select probeable, count(*) from lowdown_probe_targets group by 1;
-- select url, sources, declared_by_names from lowdown_probe_targets where cardinality(declared_by_names) > 1 limit 20;  -- 여러 이름이 같은 주소를 선언
