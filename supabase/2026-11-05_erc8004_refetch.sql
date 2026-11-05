-- 2026-11-05: ERC-8004 등록 파일 다시 가져오기 규칙 + 같은 내용 원문 중복 저장 없애기 (2026-11-05_erc8004.sql 뒤에 실행, 여러 번 실행해도 안전)
--
-- 전: 7일 지나면 모두 다시 가져오고, 내용이 같아도 원문을 매번 저장 → 따라잡은 뒤에도 매일 상한(5000)까지 다시 가져오며 중복이 쌓인다.
-- 후:
--   처음·URI 바뀜 → 바로 (그대로)
--   ipfs:// · data: → 주소가 곧 내용이라 바뀔 수 없다 → 성공 뒤에는 다시 가져오지 않는다(URI 가 바뀌면 다시)
--   https, MCP·A2A 를 선언함(Lowdown 점검 대상) → 7일마다
--   https, 그 밖 → 30일마다
--   일시 실패(http_error·timeout·network) → 1·2·4·8·16·30일 간격으로 늘림
--   고정 실패(empty_uri·unsupported_scheme·private_host·uri_truncated·too_large·invalid_json·not_object) → URI 가 바뀔 때만
--     (too_large·invalid_json·not_object 는 https 면 30일 뒤 한 번 더: 서버 쪽 파일이 고쳐질 수 있다)
--   원문(body): 해시가 직전 성공과 같으면 저장하지 않는다(unchanged = true). 가져온 기록(시각·결과·해시·서비스)은 그대로 남는다.

set statement_timeout = '5min';

alter table public.erc8004_agents add column if not exists last_ok_sha text;
alter table public.erc8004_agents add column if not exists fail_count int not null default 0;
alter table public.erc8004_agents add column if not exists declares_probe boolean not null default false;
alter table public.erc8004_files  add column if not exists unchanged boolean not null default false;

create or replace view public.erc8004_fetch_due as
with a as (
  select chain_id, agent_id, agent_uri, uri_truncated, registered_block, last_fetch_at, last_fetch_uri, last_fetch_outcome,
         last_ok_sha, fail_count, declares_probe,
         agent_uri ~* '^(ipfs://|data:)' as immutable_uri
  from erc8004_agents
  where agent_uri is not null
)
select chain_id, agent_id, agent_uri, uri_truncated,
       case when last_fetch_at is null then 0
            when last_fetch_uri is distinct from agent_uri then 1
            when last_fetch_outcome = 'ok' and declares_probe then 2
            else 3 end as due_rank,
       registered_block,
       last_ok_sha   -- 기존 뷰 열 뒤에 붙인다(create or replace view 는 열 순서를 바꿀 수 없다)
from a
where last_fetch_at is null
   or last_fetch_uri is distinct from agent_uri
   or (last_fetch_outcome = 'ok' and not immutable_uri and declares_probe and last_fetch_at < now() - interval '7 days')
   or (last_fetch_outcome = 'ok' and not immutable_uri and not declares_probe and last_fetch_at < now() - interval '30 days')
   or (last_fetch_outcome in ('http_error', 'timeout', 'network')
       and last_fetch_at < now() - make_interval(days => least(30, power(2, greatest(fail_count - 1, 0))::int)))
   or (last_fetch_outcome in ('too_large', 'invalid_json', 'not_object') and not immutable_uri
       and last_fetch_at < now() - interval '30 days');
revoke all on public.erc8004_fetch_due from anon, authenticated;

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
-- select due_rank, count(*) from erc8004_fetch_due group by 1 order by 1;
-- select last_fetch_outcome, fail_count, declares_probe, count(*) from erc8004_agents group by 1, 2, 3 order by 4 desc;
-- select unchanged, count(*), pg_size_pretty(sum(pg_column_size(body))) from erc8004_files group by 1;
