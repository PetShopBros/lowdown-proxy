# Lowdown Scanner (v0.4)

Scanner는 제품이 아니라 Lowdown의 cold-start 데이터 생산기입니다.
공식 MCP Registry의 원격(streamable-http) 서버를 하루 1회 관찰해 `scanner_observations`에 사실만 기록하고,
그 결과는 `GET /api/reputation/:target` 응답의 `scanner` 블록으로 노출됩니다(`success_rate`에는 합산하지 않음).

`tools/call`은 하지 않고, tool 이름·설명문은 저장하지 않습니다(개수와 해시만).

```text
MCP Registry → scan.ts(GitHub Actions) → scanner_observations → scanner_summary(view)
                                                              → /api/reputation/:target → get_lowdown / compare_tools
                                       → export.ts(주 1회) → lowdown-data 레포 (CSV)
```

## 구성

```text
scanner/                         # lib.ts scan.ts export.ts + 테스트
supabase/scanner_observations.sql  # 테이블, 공개 집계 view, reputation_lookups.ref
api/reputation/[target].ts       # scanner 블록, ref 기록
.github/workflows/scanner.yml    # 매일 04:17 KST
.github/workflows/backup.yml     # 매주 월 04:43 KST → lowdown-data 레포
```

## 고정 코호트

Registry에는 40,120건이 있고 probe 가능한 target은 24,064개입니다(2026-10-07 dry run 실측). 무료 인프라에서 매일 전체를 관찰할 수 없어서, **확정한 코호트를 이후 계속 같은 대상으로 관찰**합니다. 2026-10-18까지는 2,000개(`2026-10-07-v1`), 2026-10-19부터는 5,000개(`2026-10-19-v2`)입니다.

- 새 코호트 버전의 첫 실제 실행(Day 0)이 probe 가능 target을 SHA-256 순으로 `COHORT_SIZE`개 골라 `scanner_cohort`에 저장합니다. 코드 기본값은 2000, 정기 실행(`scanner.yml`) 기본값은 5000입니다. `COHORT_BASE`를 주면 그 코호트 멤버를 전부 포함하고 나머지만 새로 고르며, `COHORT_HOST_CAP`(정기 실행 3)으로 추가분의 호스트당 개수를 제한합니다. 이후 실행은 저장된 대상만 관찰하고, remote URL만 그날의 Registry 값을 씁니다.
- 코호트는 `cohort_version`(코드 기본 `2026-10-07-v1`, 정기 실행 `2026-10-19-v2`, 환경변수 `COHORT_VERSION`)별로 구분됩니다. 확장은 새 버전(v2 …)으로 하며 과거 데이터와 섞이지 않습니다. 각 observation의 `metadata.cohort_version`에 버전이 남습니다.
- Registry에서 사라졌거나 probe 가능한 remote가 없어진 멤버는 관찰하지 않고 실행 요약의 `cohort_missing`으로만 셉니다. "서버가 죽었다"로 기록하지 않습니다.
- dry run은 코호트를 저장하지 않습니다(저장된 코호트가 있으면 읽어서 사용, 없으면 선택될 대상을 미리 보여줌). `limit`은 코호트 안에서 앞의 N개만 probe합니다(테스트용).
- 코호트를 새로 만들려면 `COHORT_VERSION`을 바꾸세요. 같은 버전의 행을 지우고 다시 만드는 것은 권장하지 않습니다.
- 코호트는 "Registry 항목"의 표본입니다. 운영자(업체) 수가 아닙니다. 공개 리포트에서는 "5,000 Registry entries 관찰"처럼 항목 수로 표기하세요.

## 설정 (1회)

1. Supabase SQL Editor에서 `supabase/scanner_observations.sql` 실행 (재실행 안전, `scanner_cohort` 포함)
2. 레포 Secrets 등록
   - `LOWDOWN_SUPABASE_URL`
   - `LOWDOWN_SCANNER_KEY` — scanner write 전용 service key (기존 `LOWDOWN_SUPABASE_KEY`와 분리)
   - `LOWDOWN_NODE_ID` — `~/.lowdown/node.json`의 `ld_...` 값 또는 scanner 전용 node
   - `LOWDOWN_DATA_TOKEN` — `lowdown-data` 한 곳에만 Contents 쓰기 권한을 준 fine-grained PAT
3. `lowdown-data` 레포 생성 (README로 초기화 필수 — 빈 레포는 checkout 실패)
4. Actions 탭 → `scanner` → Run workflow → `dry_run` 체크, `limit` 30 으로 첫 확인
5. 이상 없으면 `dry_run` 해제 후 한 번 실행 → Supabase에 행이 쌓이는지 확인

로컬 확인 (Windows/macOS/Linux 공통):

```bash
npm run scanner:dry
```

검증:

```bash
npm run scanner:typecheck
npm run scanner:test
```

## 필드 정의

| 필드 | 의미 |
|---|---|
| `target_id` | `mcp:` + Registry 이름 (예: `mcp:io.github.user/server`) |
| `reached_level` | 0 = initialize 성공 못 함 / 1 = initialize 성공 / 2 = initialize + tools/list 성공 |
| `http_status` | 마지막으로 응답을 받은 요청의 HTTP 상태. 응답이 없으면 NULL. 401/403은 해석 없이 숫자 그대로 |
| `error_type` | HTTP 응답이 없을 때(`timeout` `dns` `tls` `conn_refused` `conn_reset` `network_error`), 2xx인데 JSON-RPC 응답이 아닐 때(`invalid_response`), 또는 Scanner가 URL을 거부했을 때(`blocked_url`). 그 외 NULL |
| `latency_ms` | initialize 요청 소요 시간 |
| `metadata` | `remote_url`, `init_status`, `list_status`, `tool_count`, `schema_hash`, `desc_hash`, `server_version`, `www_authenticate`, `rpc_error_code` 등 사실 값 |

`schema_hash` = tool 이름 + inputSchema + outputSchema, `desc_hash` = 이름 + title + description. 둘 다 순서/키 순서와 무관합니다. 설명문 변경은 `desc_hash`로만 감지됩니다.

### 도구 정의 원문 (0.5.0~, 비공개)

- 관찰 행 `metadata.tool_set_hash` = 정렬한 도구 정의 해시 목록의 SHA-256. 관찰 행에는 이 해시만 들어갑니다.
- `TOOL_DEFS=1`이면 원문을 비공개 테이블에 저장합니다(`supabase/tool_defs.sql`).
  - `scanner_tool_defs`: `def_hash`(= sha256(body)) 당 1행. `body`는 도구 객체 전체의 canonical JSON(text). 같은 정의는 서버·날짜와 무관하게 한 번만 저장됩니다.
  - `scanner_tool_set_versions`: `tool_set_hash` → `def_hashes`. 바뀌지 않은 날은 새 행이 없고, 시간축은 관찰 행이 가집니다.
  - `scanner_tool_flags`: 규칙 결과(해석). 지금은 `oversize`(정의 하나 64KB 초과)만. 근거에 원문 조각을 넣지 않습니다.
  - `scanner_tool_changes`: 변경 이벤트(파생). 테이블만 있고 채우는 로직은 아직 없습니다.
- 원문은 원격 서버가 보낸 신뢰할 수 없는 문자열입니다. 공개 view·API·에이전트에 내보내지 않고, 분석할 때도 지시로 해석하지 않습니다.
- 저장된 원문으로 서버 단위 `schema_hash`/`desc_hash`를 다시 계산하면 관찰 행 값과 같아야 합니다(`serverHashesFromBodies`, 테스트로 고정).

## 조회 (`scanner` 블록)

```bash
curl "https://lowdown-proxy.vercel.app/api/reputation/mcp:io.github.user/server?ref=report"
```

- 정확히 일치 → 그 대상의 `scanner` 블록. 접두사 없는 Registry 이름도 `mcp:`를 붙여 찾습니다.
- 3자 이상 부분 일치가 1건 → 그 대상. 여러 건 → `scanner_candidates`(이름 최대 5개)만 반환.
- `task_type` 필터 요청에는 붙지 않습니다.
- `server_version`은 안전한 문자(`[0-9A-Za-z.+_-]`, 32자 이내)만 통과합니다. 원격 서버가 보낸 문자열이 에이전트에 그대로 전달되지 않게 하기 위함입니다.
- `?ref=report`는 `reputation_lookups.ref`에 기록됩니다. 본인 확인용 조회는 `x-lowdown-source: seeded` 헤더를 붙여 organic과 분리하세요.

## 분석할 때 주의

- `error_type = 'blocked_url'`은 "서버가 죽었다"가 아니라 "Scanner가 호출하지 않았다"는 뜻입니다. 공개 view는 이 행을 제외합니다.
- 401/403/에러 없는 level 0 을 `dead`로 묶지 마세요. `http_status` 분포 그대로 보여주고 분모를 명시합니다.
- `tools/list`는 첫 페이지만 읽습니다(`tools_has_more`가 true면 개수는 하한).
- 원격이 여러 개인 서버는 view에서 하나로 합산됩니다.
- 기존 interactions의 target 표기(`mcp:modelcontextprotocol/brave-search` 등)와 Registry 이름은 다릅니다. 둘이 겹치려면 같은 Registry 이름으로 기록해야 합니다.

## 7일 PoC 통과 기준

사람 개입 없이 7일 동안 매일 실행되고, 매일 `reached_level >= 1` 행이 존재할 것. 같은 코호트(`metadata.cohort_version`)의 같은 대상이 매일 관찰되어야 합니다. 확인 쿼리는 `supabase/scanner_observations.sql` 하단 주석.

## 알려진 한계

- 공개 레포에서 60일간 레포 활동이 없으면 스케줄 워크플로가 자동 비활성화됩니다(GitHub 정책).
- legacy `sse` transport와 `{변수}`가 들어간 URL은 probe하지 않습니다(실행 로그 통계에만 집계).
- scanner는 Node >= 22.18(TypeScript 직접 실행)이 필요합니다. Actions는 Node 24를 씁니다.

## 일일 기록 페이지 (시장판 3단계)

- `node scanner/market.ts <lowdown-data 경로>` → `docs/` (GitHub Pages: main 브랜치 `/docs`). `report.yml`에서 REPORT.md 커밋 뒤에 실행됩니다.
- 하루 JSON(`docs/days/YYYY-MM-DD.json`)이 유일한 원본입니다. HTML·RSS·JSON Feed·sitemap은 이 파일들에서만 만듭니다.
- 멱등: 같은 데이터로 다시 돌리면 같은 바이트(커밋 없음). 더 새로운 날짜가 있으면 과거 날짜 파일은 고치지 않습니다. 부분 실행이면 아무것도 쓰지 않고 실패합니다.
- 실린 것: Registry 선언 변화(이름·호스트·버전·상태), 관찰 결과(숫자만), 도구 정의 변화(서버 단위 숫자만, (대상, 원격) 비교), First observed by Lowdown(공개 기준 적용). 설명문·원격 URL·패키지 키·원문은 싣지 않습니다.
- 이름 링크는 `?ref=market` 조회로 연결되어 `reputation_lookups.ref`에 기록됩니다. GitHub Pages 자체에는 방문 기록이 없습니다.
