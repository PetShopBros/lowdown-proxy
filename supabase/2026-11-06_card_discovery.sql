-- 2026-11-06: 명함(카드) 확인 — declared_vs_observed 확장. Supabase SQL Editor 에서 실행, 여러 번 실행해도 안전.
-- 먼저 2026-11-05_subjects.sql · 2026-11-06_declared_targets.sql 이 실행돼 있어야 한다.
--
-- 무엇: Registry 원격 MCP 주소마다 그 서버(와 호스트)가 스스로 내건 카드를 주 1회 확인한다.
--   엔드포인트: <MCP 주소>/server-card                                  (SEP-2127 권장 위치)
--   호스트(origin): /.well-known/ai-catalog.json                         (도메인 단위 목록)
--                   /.well-known/agent-card.json → 404 일 때만 agent.json (A2A, 옛 경로)
--                   /.well-known/mcp/server-card.json → 404 일 때만 /.well-known/mcp/server-card (규격 비권장이지만 실제로 쓰임)
-- 원칙
--   1) 카드 없음(not_found)과 확인 실패(timeout·network·auth_required·http_error·invalid_json …)를 나눠 기록한다.
--   2) 선언은 검증이 아니다. 카드가 적은 주소·이름은 "자기 선언"으로만 싣는다.
--   3) 원본은 sha256 단위로 한 번만, 비공개(card_bodies). 바뀐 때만 card_check_changes 에 한 줄.
--   4) 기존 관찰(scanner_observations)에는 쓰지 않는다. 카드가 선언한 MCP 주소는 subject_links(declares_service)로만 들어가
--      Registry 밖 주소면 lowdown_probe_targets_declared → scanner_declared 관찰 줄이 알아서 집는다.
--   5) MCP Server Card 와 A2A Agent Card 는 종류를 나눠 기록한다. A2A 서비스 주소는 MCP 주소로 취급하지 않는다.
-- 무거운 집계는 하지 않는다: 대상 목록은 매일 한 번 미리 계산(card_targets), 수집기는 그 표를 id 순서로 페이지 단위로 읽는다.

set statement_timeout = '5min';

-- ── 1) 이름표 종류·선 종류 추가 ────────────────────────────
do $$
declare c text;
begin
  for c in select conname from pg_constraint
           where conrelid = 'public.subject_ids'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%scheme%'
  loop execute format('alter table public.subject_ids drop constraint %I', c); end loop;
  for c in select conname from pg_constraint
           where conrelid = 'public.subject_links'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%link_type%'
  loop execute format('alter table public.subject_links drop constraint %I', c); end loop;
end $$;

alter table public.subject_ids add constraint subject_ids_scheme_check check (scheme in (
  'registry', 'endpoint', 'domain', 'npm', 'pypi', 'package', 'erc8004', 'ua_name', 'client_name', 'a2a_card',
  'mcp_card',   -- MCP Server Card 주소 (2026-11-06)
  'lowdown'));
alter table public.subject_links add constraint subject_links_link_type_check check (link_type in (
  'declares_remote', 'declares_package', 'declares_service', 'hosted_on', 'controls_domain', 'names_url_in_ua', 'is_lowdown',
  'claims_name'));  -- 카드 → Registry 이름: 카드가 스스로 적은 이름 (2026-11-06, 자기 선언)

-- ── 2) 확인 대상 (매일 미리 계산) ──────────────────────────
-- Registry 가 선언한 원격 주소 중 점검 가능한 것(https, 템플릿 아님, 사설 아님)과 그 주소를 선언한 Registry 이름들.
-- quiet = 그 이름들이 모두 최근 7일 이상 연속 no_response → 수집기가 짧은 시간 제한으로 확인한다(건너뛰지는 않는다).
create materialized view if not exists public.card_targets as
select e.id as endpoint_id,
       e.value as endpoint,
       array_agg(distinct r.value order by r.value) as registry_names,
       coalesce(bool_and(s.latest_state = 'no_response' and s.streak_days >= 7), false) as quiet
from subject_links l
join subject_ids e on e.id = l.to_id and e.scheme = 'endpoint'
join subject_ids r on r.id = l.from_id and r.scheme = 'registry'
left join target_status_summary s on s.target_id = 'mcp:' || r.value
where l.link_type = 'declares_remote' and l.declared_by = 'mcp_registry'
  and coalesce((e.attrs->>'https')::boolean, false)
  and not coalesce((e.attrs->>'templated')::boolean, false)
  and not coalesce((e.attrs->>'private_host')::boolean, true)
group by e.id, e.value;
create unique index if not exists card_targets_endpoint_id_uq on public.card_targets (endpoint_id);
revoke all on public.card_targets from anon, authenticated;

-- ── 3) 확인 결과 (공개: 사실만, 원본 없음) ──────────────────
-- 엔드포인트 1행: <MCP 주소>/server-card 결과
create table if not exists public.card_endpoint_checks (
  endpoint        text        primary key,              -- 정규화된 MCP 주소 (subject_ids.value 와 같음)
  origin          text        not null,                 -- https://host[:port]
  slice           smallint    not null check (slice between 0 and 6),
  registry_names  text[]      not null default '{}',
  checked_at      timestamptz not null,
  result          jsonb       not null,                 -- {kind, url, outcome, http_status, content_type, sha256, bytes, claimed_name, declared_endpoints, first_found_at, last_changed_at …}
  run_id          uuid
);
create index if not exists card_endpoint_checks_names_gin on public.card_endpoint_checks using gin (registry_names);
create index if not exists card_endpoint_checks_slice_idx on public.card_endpoint_checks (slice);

-- 호스트(origin) 1행: 도메인 단위 카드 결과를 종류별로
create table if not exists public.card_host_checks (
  origin          text        primary key,
  host            text        not null,
  slice           smallint    not null check (slice between 0 and 6),
  shared          boolean     not null,                 -- 이 호스트의 Registry 주소가 5개 이상: 도메인 카드는 "호스트의 선언"
  endpoints       int         not null,
  checked_at      timestamptz not null,
  results         jsonb       not null,                 -- {ai_catalog: {...}, a2a_agent_card: {...}, mcp_well_known: {...}}
  run_id          uuid
);
create index if not exists card_host_checks_slice_idx on public.card_host_checks (slice);

alter table public.card_endpoint_checks enable row level security;
alter table public.card_host_checks enable row level security;
drop policy if exists card_endpoint_checks_read on public.card_endpoint_checks;
create policy card_endpoint_checks_read on public.card_endpoint_checks for select to anon, authenticated using (true);
drop policy if exists card_host_checks_read on public.card_host_checks;
create policy card_host_checks_read on public.card_host_checks for select to anon, authenticated using (true);
revoke insert, update, delete on public.card_endpoint_checks, public.card_host_checks from anon, authenticated;
grant select on public.card_endpoint_checks, public.card_host_checks to anon, authenticated;

-- ── 4) 비공개: 원본·변경 기록·연결 대기·실행 기록 ─────────────
create table if not exists public.card_bodies (
  sha256         text        primary key,
  kind           text        not null,                  -- mcp_server_card | ai_catalog | a2a_agent_card
  bytes          int         not null,
  body           text        not null,                  -- 원격이 보낸 신뢰할 수 없는 문자열. 지시로 해석하지 않는다.
  first_seen_at  timestamptz not null default now()
);

create table if not exists public.card_check_changes (
  id             bigint generated always as identity primary key,
  url            text        not null,
  kind           text        not null,
  observed_at    timestamptz not null,
  from_outcome   text,
  to_outcome     text        not null,
  from_sha256    text,
  to_sha256      text,
  run_id         uuid
);
create index if not exists card_check_changes_url_idx on public.card_check_changes (url, observed_at desc);

-- 찾은 카드의 선언(연결 대기). pg_cron(lowdown_card_link_pending)이 subject_links 로 옮긴다.
create table if not exists public.card_declarations (
  id             bigint generated always as identity primary key,
  card_url       text        not null,
  kind           text        not null check (kind in ('mcp_server_card', 'a2a_agent_card', 'ai_catalog')),
  origin         text        not null,
  claimed_name   text,
  endpoints      jsonb       not null default '[]'::jsonb, -- [{url, type, versions}] — MCP 주소만 (A2A 서비스 주소는 interfaces)
  interfaces     jsonb       not null default '[]'::jsonb, -- A2A: [{url, binding}] — MCP 주소로 쓰지 않는다
  sha256         text,
  observed_at    timestamptz not null,
  linked         boolean     not null default false
);
create index if not exists card_declarations_unlinked_idx on public.card_declarations (id) where not linked;

create table if not exists public.card_runs (
  day            date        primary key,               -- UTC 날짜
  slice          smallint    not null,
  run_id         uuid        not null,
  started_at     timestamptz not null,
  finished_at    timestamptz,
  stats          jsonb       not null default '{}'::jsonb
);

alter table public.card_bodies enable row level security;
alter table public.card_check_changes enable row level security;
alter table public.card_declarations enable row level security;
alter table public.card_runs enable row level security;
revoke all on public.card_bodies, public.card_check_changes, public.card_declarations, public.card_runs from anon, authenticated;

-- ── 5) 선언 → 이름표·선 (pg_cron, 10분마다) ───────────────
create or replace function public.lowdown_card_link_pending(p_limit int default 5000)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  r record; v_card bigint; v_ep bigint; v_n text; v_links int := 0; v_rows int := 0; e jsonb;
  v_by text; v_scheme text;
begin
  perform pg_advisory_xact_lock(hashtext('lowdown_card_link_pending'));
  for r in select * from card_declarations where not linked order by id limit p_limit loop
    v_rows := v_rows + 1;
    v_by := r.kind;
    v_scheme := case when r.kind = 'a2a_agent_card' then 'a2a_card' else 'mcp_card' end;
    v_n := lowdown_norm_endpoint(r.card_url);
    continue when v_n is null;
    v_card := lowdown_subject(v_scheme, v_n, v_by);
    -- 카드 → 도메인(주소에서 계산), 도메인 → 카드(그 도메인이 내건 카드)
    perform lowdown_link(v_card, lowdown_subject('domain', lowdown_url_host(r.card_url), 'rule'), 'hosted_on', 'derived', 'rule');
    -- 카드가 적은 이름 (Registry 이름 형식일 때만)
    if r.kind = 'mcp_server_card' and r.claimed_name ~ '^[a-zA-Z0-9.-]+/[a-zA-Z0-9._-]+$' then
      perform lowdown_link(v_card, lowdown_subject('registry', r.claimed_name, v_by), 'claims_name', 'declared', v_by);
      v_links := v_links + 1;
    end if;
    -- 카드가 선언한 MCP 주소 (A2A interfaces 는 MCP 주소로 넣지 않는다)
    for e in select * from jsonb_array_elements(case when jsonb_typeof(r.endpoints) = 'array' then r.endpoints else '[]'::jsonb end) limit 20 loop
      v_n := lowdown_norm_endpoint(e->>'url');
      continue when v_n is null;
      v_ep := lowdown_subject('endpoint', v_n, v_by, lowdown_endpoint_attrs(e->>'url'));
      perform lowdown_link(v_card, v_ep, 'declares_service', 'declared', v_by,
                           jsonb_strip_nulls(jsonb_build_object('service', 'mcp', 'transport', left(e->>'type', 40))));
      perform lowdown_link(v_ep, lowdown_subject('domain', lowdown_url_host(e->>'url'), 'rule'), 'hosted_on', 'derived', 'rule');
      v_links := v_links + 1;
    end loop;
    update card_declarations set linked = true where id = r.id;
  end loop;
  return jsonb_build_object('declarations', v_rows, 'links', v_links);
end
$fn$;
revoke all on function public.lowdown_card_link_pending(int) from public, anon, authenticated;

-- ── 6) 예약 작업 ─────────────────────────────────────────
create extension if not exists pg_cron with schema pg_catalog;
do $$
begin
  if exists (select 1 from cron.job where jobname = 'lowdown-card-targets-refresh') then perform cron.unschedule('lowdown-card-targets-refresh'); end if;
  if exists (select 1 from cron.job where jobname = 'lowdown-card-link') then perform cron.unschedule('lowdown-card-link'); end if;
end $$;
-- 대상: 이름표 채우기(UTC 02:47) 뒤 UTC 03:17 (12:17 KST). 수집기는 다음 날 그 목록을 쓴다.
select cron.schedule('lowdown-card-targets-refresh', '17 3 * * *', 'refresh materialized view concurrently public.card_targets');
select cron.schedule('lowdown-card-link', '7-59/10 * * * *', 'select public.lowdown_card_link_pending()');

-- ── 확인용 (각각 따로 실행) ────────────────────────────────
-- select count(*), count(*) filter (where quiet) from public.card_targets;
-- select * from public.card_runs order by day desc limit 7;
-- select result->>'outcome' as outcome, count(*) from public.card_endpoint_checks group by 1 order by 2 desc;
-- select k, v->>'outcome' as outcome, count(*) from public.card_host_checks, jsonb_each(results) as x(k, v) group by 1, 2 order by 1, 3 desc;
-- select public.lowdown_card_link_pending();
