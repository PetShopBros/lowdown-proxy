-- 조회 기록에 응답 종류를 남긴다: 답이 없어 낭비된 조회 비율 측정용.
-- 값: observed / candidates / registry_only / interactions_only / none / task_type (판정 아님, "무엇으로 답했나")
-- API 는 이 열이 없어도 조회 기록을 남긴다(열 없이 다시 쓴다). 배포 전에 실행하면 첫 조회부터 기록된다.

alter table reputation_lookups add column if not exists result_kind text;

-- 확인
-- select result_kind, count(*) from reputation_lookups where created_at > now() - interval '1 day' group by 1 order by 2 desc;
