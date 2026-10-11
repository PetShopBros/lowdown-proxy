-- Lowdown Scanner — 직후 재시도 결과를 기존 관찰 행에 덧붙인다 (Supabase SQL Editor에서 실행, 여러 번 실행해도 안전)
-- 원칙: 첫 시도 컬럼(reached_level, http_status, error_type, latency_ms)은 바꾸지 않는다.
--       재시도 결과는 같은 행의 metadata.retry 에만 추가하며, 이미 retry 가 있으면 덮어쓰지 않는다(하루 1회).
-- 행 식별: (scan_run_id, target_id, metadata->>'remote_url') — scanner_obs_run_target_remote_uq 로 1행 보장.

create or replace function scanner_attach_retry(p_run uuid, p_target text, p_remote_url text, p_retry jsonb)
returns boolean
language sql
security invoker
set search_path = public
as $$
  with u as (
    update scanner_observations
       set metadata = metadata || jsonb_build_object('retry', p_retry)
     where scan_run_id = p_run
       and target_id = p_target
       and metadata->>'remote_url' = p_remote_url
       and not (metadata ? 'retry')
    returning 1
  )
  select exists (select 1 from u);
$$;

-- Supabase 는 public 스키마 함수를 기본으로 anon/authenticated 에도 실행 허용한다 → 반드시 회수.
revoke execute on function scanner_attach_retry(uuid, text, text, jsonb) from public, anon, authenticated;
grant execute on function scanner_attach_retry(uuid, text, text, jsonb) to service_role;

-- API(PostgREST)가 새 함수를 바로 찾도록 스키마 캐시 갱신
notify pgrst, 'reload schema';
