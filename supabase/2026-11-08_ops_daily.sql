-- 2026-11-08: 운영 요약(안정화 3단계) — 워크플로·작업·DB 신선도의 하루 판정. 비공개.
-- 쓰기: scanner/ops-summary.ts (매일 12:37 KST, .github/workflows/ops-summary.yml). 같은 날 다시 돌리면 갱신(day, check_id).
-- 적용: node scanner/migrations.ts pack supabase/2026-11-08_ops_daily.sql --out $env:TEMP\pack.sql → Get-Content -Raw -Encoding UTF8 $env:TEMP\pack.sql | Set-Clipboard → SQL Editor.
create table if not exists public.ops_daily (
  day              date        not null,
  check_id         text        not null,
  kind             text        not null check (kind in ('workflow', 'job', 'db')),
  status           text        not null check (status in ('ok', 'failing', 'stale', 'not_seen', 'error')),
  last_at          timestamptz,
  last_conclusion  text,
  last_success_at  timestamptz,
  failing_since    timestamptz,
  runs_24h         integer,
  failures_24h     integer,
  details          jsonb       not null default '{}'::jsonb,
  computed_at      timestamptz not null default now(),
  primary key (day, check_id)
);

alter table public.ops_daily enable row level security;
revoke all on public.ops_daily from anon, authenticated;
grant select on public.ops_daily to lowdown_analyst;
