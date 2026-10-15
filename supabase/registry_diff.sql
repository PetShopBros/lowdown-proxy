-- Lowdown 시장판 1단계 — Registry 비교 기록 (Supabase SQL Editor에서 실행, 여러 번 실행해도 안전)
-- 원칙: Registry 가 공개한 선언의 "변화"만 기록한다. probe 결과와 섞지 않는다(scanner_observations 와 별개).
--   registry_state   : 이름당 1행, 마지막으로 본 선언 요약. 바뀐 행만 갱신(매일 전체를 다시 쓰지 않음).
--   registry_changes : 하루 단위 변경 이벤트. 첫 실행(baseline)은 이벤트를 만들지 않는다.
--   kind:
--     new          어제까지 없던 이름이 목록에 나타남
--     removed      어제까지 있던 이름이 목록(version=latest)에서 사라짐
--     restored     사라졌던 이름이 다시 나타남
--     version      최신 버전 문자열이 바뀜
--     status       공식 메타의 status 가 바뀜(active, deprecated 등)
--     remotes      원격 선언(type + url 목록)이 바뀜
--     packages     패키지 선언(registryType identifier version transport)이 바뀜
--     description  설명문이 바뀜 — 원문은 저장하지 않고 해시(앞 16자)만
--   Registry 목록을 받지 못한 날(fallback)은 비교를 건너뛴다 → 다음 비교에 이틀치가 함께 잡힌다.
--   비교 기록은 2026-10-16 이후 첫 실행부터이며, 그 이전은 소급하지 않는다.

create table if not exists registry_state (
  name          text        primary key,
  version       text        not null default '',
  status        text,
  remotes_key   text        not null default '',
  packages_key  text        not null default '',
  desc_hash     text        not null default '',
  hosts         text[]      not null default '{}',
  first_seen_at timestamptz not null default now(),
  baseline      boolean     not null default false, -- true = 첫 실행 때 이미 있던 항목(실제 등록일 아님)
  removed_at    timestamptz,
  updated_at    timestamptz not null default now()
);

create table if not exists registry_changes (
  id           bigint generated always as identity primary key,
  detected_on  date        not null,
  detected_at  timestamptz not null default now(),
  scan_run_id  uuid        not null,
  name         text        not null,
  kind         text        not null
                           check (kind in ('new', 'removed', 'restored', 'version', 'status', 'remotes', 'packages', 'description')),
  old_value    text,
  new_value    text,
  hosts        text[]      not null default '{}'
);

-- 같은 날 재실행(예비 실행·수동 실행) 시 같은 이벤트 중복 방지
create unique index if not exists registry_changes_day_name_kind_uq
  on registry_changes (detected_on, name, kind);

create index if not exists registry_changes_name_idx
  on registry_changes (name, detected_on desc);

-- 공개하지 않는다 (policy 없음). Scanner 는 scanner 전용 secret key 로만 쓴다.
-- 공개는 이후 일일 페이지·피드(정적 파일)로, 허용 문자만 내보낸다.
alter table registry_state   enable row level security;
alter table registry_changes enable row level security;
revoke all on registry_state, registry_changes from anon, authenticated;

-- ─────────────────────────────────────────────
-- 확인용
-- ─────────────────────────────────────────────
-- select count(*), count(*) filter (where baseline), count(*) filter (where removed_at is not null) from registry_state;
-- select detected_on, kind, count(*) from registry_changes group by 1, 2 order by 1 desc, 3 desc;
-- 호스트 단위 묶음(신규):
-- select detected_on, h as host, count(*) from registry_changes, unnest(hosts) h
-- where kind = 'new' group by 1, 2 order by 1 desc, 3 desc limit 20;
