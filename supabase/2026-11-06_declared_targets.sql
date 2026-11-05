-- 2026-11-06: Registry 밖에서 선언된 엔드포인트 — Scanner 세 번째 줄(source = 'scanner_declared')의 관찰 대상
-- Supabase SQL Editor 에서 실행, 여러 번 실행해도 안전. 먼저 2026-11-05_subjects.sql 이 실행돼 있어야 한다.
--
-- lowdown_probe_targets 와 같은 열이지만, Registry(declared_by = 'mcp_registry')가 선언한 주소는 뺀다.
--   Registry 주소는 고정 코호트·조회 대상 줄이 이미 맡는다. 여기는 그 밖(ERC-8004 등록 파일, 앞으로 명함 인구조사 등)에서 온 주소만.
--   출처를 고정하지 않는다: 어떤 수집기든 subject_links 에 declares_service 선을 넣으면 다음 스캔부터 대상이 된다.
-- lowdown_probe_targets 전체(약 3.7만 행)를 집계하지 않고, Registry 밖 선이 있는 엔드포인트만 먼저 고른 뒤 집계한다(REST 시간 제한 회피).
-- 고르는 순서·상한(하루 500, 호스트당 20)은 Scanner(scanner/declared-lib.ts)가 정한다.

create or replace view public.lowdown_probe_targets_declared as
with c as (
  select distinct l.to_id
  from subject_links l
  where l.link_type = 'declares_service'
    and l.declared_by <> 'mcp_registry'
)
select e.id as subject_id,
       e.value as url,
       lowdown_url_host(e.value) as host,
       coalesce((e.attrs->>'https')::boolean, false)
         and not coalesce((e.attrs->>'templated')::boolean, false)
         and not coalesce((e.attrs->>'private_host')::boolean, true) as probeable,
       array_agg(distinct l.declared_by order by l.declared_by) as sources,
       count(distinct l.from_id) as declared_by_count,
       min(l.first_seen_at) as first_declared_at,
       max(l.last_seen_at) as last_declared_at
from c
join subject_ids e on e.id = c.to_id and e.scheme = 'endpoint'
join subject_links l on l.to_id = e.id and l.link_type in ('declares_remote', 'declares_service')
where not exists (
  select 1 from subject_links r
  where r.to_id = e.id and r.link_type = 'declares_remote' and r.declared_by = 'mcp_registry'
)
group by e.id, e.value, e.attrs;

revoke all on public.lowdown_probe_targets_declared from anon, authenticated;

-- 확인:
-- select count(*), count(*) filter (where probeable) from lowdown_probe_targets_declared;
-- select host, count(*) from lowdown_probe_targets_declared where probeable group by 1 order by 2 desc limit 10;
