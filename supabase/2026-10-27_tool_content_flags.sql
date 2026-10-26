-- 2026-10-27: 도구 정의 내용 표지 — Supabase SQL Editor 에서 실행, 여러 번 실행해도 안전
--
-- 목적: "도구 정의가 바뀌었다"에 더해 "어떤 특징이 새로 나타났는가"를 사실로 말한다. 원문은 계속 비공개.
--   규칙은 이 파일 한 곳에만 있다. 새 정의가 저장될 때 트리거가 붙이고, 이미 저장된 정의는 아래에서 한 번 소급한다.
--   표지는 판정이 아니다(tool_defs.sql 원칙 3). evidence 에는 개수·필드 이름·형식 검사를 통과한 도메인만, 원문 조각은 넣지 않는다.
--
-- 규칙
--   hidden_characters v1: 정의 전체(이름·제목·설명·스키마)에 보이지 않는 문자가 있다.
--     U+200B–200F(제로폭·방향 표시), U+202A–202E(방향 제어), U+2060–2064(단어 결합 등), U+2066–2069(방향 격리),
--     U+FEFF(BOM), U+E0000–E007F(태그 문자).  evidence: {count, fields: name/title/description/other}
--   description_url v1: 도구 설명(description)에 http(s) URL 이 있다.
--     evidence: {url_count, domains(형식 검사 통과, 소문자, 정렬, 최대 5), domains_total}
--
-- 안전
--   - 트리거는 어떤 오류가 나도 정의 저장을 막지 않는다(경고만). 수집이 끊기지 않는 것이 먼저다.
--   - 함수는 security definer. anon/authenticated/public 은 실행할 수 없다(서비스 키만).

set statement_timeout = '15min';

-- ── 규칙 함수 ────────────────────────────────────────────
create or replace function public.lowdown_tool_def_flags(p_def_hash text, p_body text, p_run uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  hidden_re constant text := '[​-‏‪-‮⁠-⁤⁦-⁩﻿\U000E0000-\U000E007F]';
  host_re   constant text := '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$';
  j         jsonb;
  descr     text;
  hidden_n  integer;
  fields    text[] := '{}';
  url_n     integer;
  doms      text[];
begin
  begin
    j := p_body::jsonb;
  exception when others then
    j := null;  -- \u0000 등으로 jsonb 가 안 되는 정의: 필드 구분 없이 전체 문자열만 본다
  end;

  -- hidden_characters
  hidden_n := regexp_count(p_body, hidden_re);
  if hidden_n > 0 then
    if j is not null then
      if coalesce(j->>'name', '') ~ hidden_re then fields := array_append(fields, 'name'); end if;
      if coalesce(j->>'title', '') ~ hidden_re then fields := array_append(fields, 'title'); end if;
      if coalesce(j->>'description', '') ~ hidden_re then fields := array_append(fields, 'description'); end if;
      if (j - 'name' - 'title' - 'description')::text ~ hidden_re then fields := array_append(fields, 'other'); end if;
    end if;
    insert into scanner_tool_flags (def_hash, rule_id, rule_version, evidence, scan_run_id)
    values (p_def_hash, 'hidden_characters', 1, jsonb_build_object('count', hidden_n, 'fields', to_jsonb(fields)), p_run)
    on conflict (def_hash, rule_id, rule_version) do nothing;
  end if;

  -- description_url
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

-- ── 새 정의가 저장될 때 ─────────────────────────────────
create or replace function public.lowdown_tool_defs_after_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.lowdown_tool_def_flags(new.def_hash, new.body, new.first_scan_run_id);
  return null;
exception when others then
  raise warning 'lowdown_tool_defs_after_insert(%): %', new.def_hash, sqlerrm;
  return null;
end;
$$;

revoke all on function public.lowdown_tool_defs_after_insert() from public, anon, authenticated;

drop trigger if exists lowdown_tool_defs_flags on public.scanner_tool_defs;
create trigger lowdown_tool_defs_flags
  after insert on public.scanner_tool_defs
  for each row execute function public.lowdown_tool_defs_after_insert();

-- ── 집합별 표지 (API 가 변경 이벤트 앞뒤 집합을 비교할 때 RPC 로 부른다) ──
-- 한 번에 최대 20개 집합. 집합 안에서 규칙별로 표지가 붙은 정의 수와 도메인 합집합(최대 20)을 돌려준다.
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
    select distinct s.tool_set_hash, fl.rule_id, fl.def_hash, fl.evidence
    from s
    join scanner_tool_flags fl on fl.def_hash = s.def_hash
    where fl.rule_version = 1 and fl.rule_id in ('hidden_characters', 'description_url')
  )
  -- 저장된 집합마다 rule_id 가 null 인 행 하나: "이 집합은 확인했다"는 표시(표지가 없어도). 없는 집합은 행이 없다.
  select v.tool_set_hash, null::text, 0, '{}'::text[]
  from scanner_tool_set_versions v
  where v.tool_set_hash = any (p_sets[1:20])
  union all
  select
    f.tool_set_hash,
    f.rule_id,
    count(distinct f.def_hash)::int,
    coalesce((
      select (array_agg(distinct d order by d))[1:20]
      from f f2, jsonb_array_elements_text(coalesce(f2.evidence->'domains', '[]'::jsonb)) as d
      where f2.tool_set_hash = f.tool_set_hash and f2.rule_id = f.rule_id
    ), '{}')
  from f
  group by f.tool_set_hash, f.rule_id;
$$;

revoke all on function public.lowdown_tool_set_flags(text[]) from public, anon, authenticated;
grant execute on function public.lowdown_tool_set_flags(text[]) to service_role;

-- 표지 조회용 인덱스 (unique (def_hash, rule_id, rule_version) 가 def_hash 로 시작하므로 이미 있음)

-- ── 기존 정의 소급 (한 번, 다시 실행해도 중복 없음) ─────────
select count(*) as defs_checked
from (
  select public.lowdown_tool_def_flags(def_hash, body, first_scan_run_id)
  from public.scanner_tool_defs
) t;

notify pgrst, 'reload schema';

-- ── 확인 ─────────────────────────────────────────────────
-- 1) 규칙별 표지 수
-- select rule_id, rule_version, count(*) from scanner_tool_flags group by 1, 2 order by 1, 2;
-- 2) 실행 권한: 셋 다 false
-- select has_function_privilege('anon', 'public.lowdown_tool_set_flags(text[])', 'execute') as anon_rpc,
--        has_function_privilege('anon', 'public.lowdown_tool_def_flags(text,text,uuid)', 'execute') as anon_fn,
--        has_function_privilege('authenticated', 'public.lowdown_tool_set_flags(text[])', 'execute') as auth_rpc;
-- 3) 가장 많이 나온 도메인 (원문 없이)
-- select d, count(*) from scanner_tool_flags, jsonb_array_elements_text(evidence->'domains') d
-- where rule_id = 'description_url' group by 1 order by 2 desc limit 20;
--
-- 되돌리기 (필요할 때만):
-- drop trigger if exists lowdown_tool_defs_flags on public.scanner_tool_defs;
-- delete from scanner_tool_flags where rule_id in ('hidden_characters', 'description_url') and rule_version = 1;
