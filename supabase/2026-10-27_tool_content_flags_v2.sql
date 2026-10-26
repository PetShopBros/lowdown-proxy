-- 2026-10-27: hidden_characters v2 — 보이지 않는 문자를 종류별로 나눈다. Supabase SQL Editor 에서 실행, 여러 번 실행해도 안전
-- 먼저 2026-10-27_tool_content_flags.sql 이 실행돼 있어야 한다(표·트리거는 그 파일). 이 파일은 함수만 바꾸고 v2 를 소급한다.
--
-- 이유 (v1 첫 측정, 2026-10-27): 68,956개 정의 중 12개가 v1 에 걸렸고, 9개는 U+200C(ZWNJ) — 페르시아어 정상 표기,
--   3개는 U+200B(제로폭 공백) — 편집기 잔여물로 보임. 방향 제어 문자와 태그 문자는 0개.
--   v1 은 이들을 한 가지로 묶어 첫 문장에 "invisible characters" 로 써서, 정상 표기를 쓰는 언어권 서버를 경고처럼 보이게 했다.
--
-- v2 종류 (문자 범위는 v1 과 같다):
--   direction_controls  U+200E–200F, U+202A–202E, U+2066–2069   (텍스트 방향 제어)
--   tag_characters      U+E0000–E007F                           (태그 문자)
--   zero_width          U+200B, U+2060–2064, U+FEFF             (제로폭 공백·결합 방지 등)
--   joiners             U+200C–200D                             (ZWNJ/ZWJ: 페르시아어·아랍어·인도계 문자, 이모지에서 정상)
--   evidence: {count, fields, kinds: {종류: 개수, ...}}  (0 인 종류는 넣지 않는다)
--   API 는 direction_controls·tag_characters 만 첫 문장에 쓴다. zero_width·joiners 는 events 데이터에만.
-- v1 행은 지우지 않는다(과거 판정을 덮어쓰지 않음). 새 정의에는 v2 만 붙는다. API·RPC 는 hidden_characters v2 만 읽는다.

set statement_timeout = '10min';

create or replace function public.lowdown_tool_def_flags(p_def_hash text, p_body text, p_run uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  hidden_re  constant text := '[​-‏‪-‮⁠-⁤⁦-⁩﻿\U000E0000-\U000E007F]';
  dir_re     constant text := '[‎‏‪-‮⁦-⁩]';
  tag_re     constant text := '[\U000E0000-\U000E007F]';
  zw_re      constant text := '[​⁠-⁤﻿]';
  joiner_re  constant text := '[‌‍]';
  host_re    constant text := '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$';
  j          jsonb;
  descr      text;
  hidden_n   integer;
  fields     text[] := '{}';
  kinds      jsonb := '{}'::jsonb;
  n          integer;
  url_n      integer;
  doms       text[];
begin
  begin
    j := p_body::jsonb;
  exception when others then
    j := null;
  end;

  -- hidden_characters v2
  hidden_n := regexp_count(p_body, hidden_re);
  if hidden_n > 0 then
    if j is not null then
      if coalesce(j->>'name', '') ~ hidden_re then fields := array_append(fields, 'name'); end if;
      if coalesce(j->>'title', '') ~ hidden_re then fields := array_append(fields, 'title'); end if;
      if coalesce(j->>'description', '') ~ hidden_re then fields := array_append(fields, 'description'); end if;
      if (j - 'name' - 'title' - 'description')::text ~ hidden_re then fields := array_append(fields, 'other'); end if;
    end if;
    n := regexp_count(p_body, dir_re);    if n > 0 then kinds := kinds || jsonb_build_object('direction_controls', n); end if;
    n := regexp_count(p_body, tag_re);    if n > 0 then kinds := kinds || jsonb_build_object('tag_characters', n); end if;
    n := regexp_count(p_body, zw_re);     if n > 0 then kinds := kinds || jsonb_build_object('zero_width', n); end if;
    n := regexp_count(p_body, joiner_re); if n > 0 then kinds := kinds || jsonb_build_object('joiners', n); end if;
    insert into scanner_tool_flags (def_hash, rule_id, rule_version, evidence, scan_run_id)
    values (p_def_hash, 'hidden_characters', 2, jsonb_build_object('count', hidden_n, 'fields', to_jsonb(fields), 'kinds', kinds), p_run)
    on conflict (def_hash, rule_id, rule_version) do nothing;
  end if;

  -- description_url v1 (바뀌지 않음)
  if j is not null and jsonb_typeof(j->'description') = 'string' then
    descr := j->>'description';
    url_n := regexp_count(descr, 'https?://', 1, 'i');
    if url_n > 0 then
      select coalesce(array_agg(d order by d), '{}') into doms
      from (
        select distinct lower(rtrim(m[1], '.')) as d
        from regexp_matches(descr, 'https?://([A-Za-z0-9.-]{1,253})', 'gi') as m
      ) s
      where d ~ host_re and length(d) <= 253;
      insert into scanner_tool_flags (def_hash, rule_id, rule_version, evidence, scan_run_id)
      values (p_def_hash, 'description_url', 1,
              jsonb_build_object('url_count', url_n, 'domains', to_jsonb(doms[1:5]), 'domains_total', coalesce(array_length(doms, 1), 0)),
              p_run)
      on conflict (def_hash, rule_id, rule_version) do nothing;
    end if;
  end if;
exception when others then
  raise warning 'lowdown_tool_def_flags(%): %', p_def_hash, sqlerrm;
end;
$$;

revoke all on function public.lowdown_tool_def_flags(text, text, uuid) from public, anon, authenticated;

-- 집합별 표지: rule_id 자리에 표지 키를 돌려준다
--   description_url, hidden_direction_controls, hidden_tag_characters, hidden_zero_width, hidden_joiners
--   rule_id 가 null 인 행 = 저장된 집합(확인했다는 표시)
create or replace function public.lowdown_tool_set_flags(p_sets text[])
returns table (tool_set_hash text, rule_id text, defs integer, domains text[])
language sql
stable
security definer
set search_path = public
as $$
  with s as (
    select v.tool_set_hash, unnest(v.def_hashes) as def_hash
    from scanner_tool_set_versions v
    where v.tool_set_hash = any (p_sets[1:20])
  ),
  f as (
    select distinct s.tool_set_hash, fl.def_hash, fl.rule_id, fl.evidence
    from s
    join scanner_tool_flags fl on fl.def_hash = s.def_hash
    where (fl.rule_id = 'description_url' and fl.rule_version = 1)
       or (fl.rule_id = 'hidden_characters' and fl.rule_version = 2)
  ),
  k as (
    select f.tool_set_hash, f.def_hash, 'description_url'::text as rule_key, f.evidence
    from f where f.rule_id = 'description_url'
    union all
    select f.tool_set_hash, f.def_hash, 'hidden_' || kk.key, f.evidence
    from f, jsonb_each(coalesce(f.evidence->'kinds', '{}'::jsonb)) as kk
    where f.rule_id = 'hidden_characters'
      and kk.key in ('direction_controls', 'tag_characters', 'zero_width', 'joiners')
  )
  select v.tool_set_hash, null::text, 0, '{}'::text[]
  from scanner_tool_set_versions v
  where v.tool_set_hash = any (p_sets[1:20])
  union all
  select
    k.tool_set_hash,
    k.rule_key,
    count(distinct k.def_hash)::int,
    case when k.rule_key = 'description_url' then coalesce((
      select (array_agg(distinct d order by d))[1:20]
      from k k2, jsonb_array_elements_text(coalesce(k2.evidence->'domains', '[]'::jsonb)) as d
      where k2.tool_set_hash = k.tool_set_hash and k2.rule_key = 'description_url'
    ), '{}') else '{}'::text[] end
  from k
  group by k.tool_set_hash, k.rule_key;
$$;

revoke all on function public.lowdown_tool_set_flags(text[]) from public, anon, authenticated;
grant execute on function public.lowdown_tool_set_flags(text[]) to service_role;

-- 소급: 문자 범위가 v1 과 같으므로 v1 이 걸린 정의만 다시 보면 된다
select count(*) as defs_rechecked
from (
  select public.lowdown_tool_def_flags(d.def_hash, d.body, d.first_scan_run_id)
  from public.scanner_tool_defs d
  where exists (select 1 from public.scanner_tool_flags f
                where f.def_hash = d.def_hash and f.rule_id = 'hidden_characters' and f.rule_version = 1)
) t;

notify pgrst, 'reload schema';

-- ── 확인 ─────────────────────────────────────────────────
-- 1) v1 과 v2 개수가 같아야 한다
-- select rule_version, count(*) from scanner_tool_flags where rule_id = 'hidden_characters' group by 1;
-- 2) 종류별
-- select k, count(*) from scanner_tool_flags, jsonb_object_keys(evidence->'kinds') k
-- where rule_id = 'hidden_characters' and rule_version = 2 group by 1 order by 2 desc;
