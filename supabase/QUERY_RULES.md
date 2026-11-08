# 측정·분석 쿼리 원칙 (2026-11-08)

운영 DB 하나를 관찰 저장·조회 API·분석이 같이 쓴다. 분석 쿼리 하나가 DB를 붙잡으면 Lowdown 조회가 멈춘다(2026-11-06 08:00~08:13 KST, 503).

## 1. 손으로 돌리는 쿼리는 항상 분석 역할 + 시간 상한
SQL Editor 는 **실행할 때마다 새 세션**이다. 아래 줄을 **분석 쿼리와 같은 실행 창에 함께 붙여 한 번에** 실행한다(따로 실행하면 다음 실행은 postgres 로 돈다):

```sql
set role lowdown_analyst;
set statement_timeout = '15s'; set lock_timeout = '3s'; set idle_in_transaction_session_timeout = '60s';
```

읽기 전용 확인(2026-11-08): 같은 실행에서 `create table` → `42501 permission denied for schema public`. 역할 정의: `2026-11-08_analyst_role.sql`(읽기 전용).
마이그레이션(create/alter)은 이 역할로 돌리지 않는다 — postgres 로, 파일 맨 위에 자체 `set statement_timeout` 을 둔다.

## 2. 전수 비교 금지
- 행마다 전체를 다시 조회하는 구조(`join lateral` 로 매 행 전체 재조회, 상관 서브쿼리 전수) 금지.
- 먼저 `explain`(analyze 없이)으로 계획을 보고, `Seq Scan` 이 큰 표(scanner_observations 등)에 걸리면 돌리지 않는다.

## 3. 무거운 집계는 코드에서
- 큰 표의 기간 집계는 SQL 한 방이 아니라 코드에서 페이지로 읽어 합친다.
- 미리 계산해 둘 수 있는 것은 하루 1회 요약 표로(예: target_status_summary).

## 4. 페이지 나눠 읽기(keyset) 규칙
- 순서 열과 같은 인덱스가 있어야 한다. 필터 + `order by id` 면 `(필터 열, id)` 인덱스.
  - 예: scan_run_id 로 거르고 id 순으로 읽기 → `scanner_obs_run_id_idx (scan_run_id, id)` (2026-11-08).
- `(observed_at, id)` keyset 의 `or(observed_at.gt.X, and(observed_at.eq.X, id.gt.N))` 만으로는 인덱스 범위가 줄지 않는다.
  **다음 페이지부터 하한을 마지막 시각으로 좁힌다**: `observed_at=gte.${after ? after.at : since}`.
  (2026-11-08 report-lib.ts fetchReportRows, notable-tools-lib.ts fetchObservations, lib.ts fetchMonthRows 수정)
- 정렬 없는 `limit` 에 기대지 않는다.

## 5. 실패 메시지에 원인을 남긴다
- REST 읽기 실패는 PostgREST 본문(code·message) 앞 300자를 붙인다(`scanner/rest-retry.ts` readErrorBody).
- `57014` = statement timeout → 쿼리 계획 문제. 재시도로 덮지 말고 인덱스·쿼리를 고친다.
