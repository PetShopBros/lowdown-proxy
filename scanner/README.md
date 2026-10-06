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

## 설정 (1회)

1. Supabase SQL Editor에서 `supabase/scanner_observations.sql` 실행 (재실행 안전)
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

사람 개입 없이 7일 동안 매일 실행되고, 매일 `reached_level >= 1` 행이 존재할 것. 확인 쿼리는 `supabase/scanner_observations.sql` 하단 주석.

## 알려진 한계

- 공개 레포에서 60일간 레포 활동이 없으면 스케줄 워크플로가 자동 비활성화됩니다(GitHub 정책).
- legacy `sse` transport와 `{변수}`가 들어간 URL은 probe하지 않습니다(실행 로그 통계에만 집계).
- scanner는 Node >= 22.18(TypeScript 직접 실행)이 필요합니다. Actions는 Node 24를 씁니다.
