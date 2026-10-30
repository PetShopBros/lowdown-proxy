# lowdown-proxy

[![Listed on mcpservers.org](https://mcpservers.org/badge.svg)](https://mcpservers.org/servers/petshopbros/lowdown-proxy)

Agents should not have to trust anyone they've never interacted with.

`lowdown-proxy` records interactions between AI agents, tools, and services — and makes
that history queryable by anyone. Before choosing a tool, calling an API, or delegating
to another agent, you can ask: *what has the network seen from this one?*

A transparent stdio proxy for MCP servers is the first entry point. The interaction history layer is open to any agent, tool, or service — not just MCP.

See [DESIGN.md](./DESIGN.md) for background and design principles.

## Quick start

```bash
npx lowdown-proxy -- npx some-mcp-server
```

That's it. No signup, no configuration. On first run, a node identity is created automatically at `~/.lowdown/node.json`. Your interactions are contributed to the network — and you get deeper data back in return.

Wrap any MCP server in your client config:

```jsonc
// before
{
  "mcpServers": {
    "search": { "command": "npx", "args": ["search-mcp-server"] }
  }
}

// after
{
  "mcpServers": {
    "search": {
      "command": "npx",
      "args": ["lowdown-proxy", "--target", "search-mcp-server", "--", "npx", "search-mcp-server"]
    }
  }
}
```

## Remote MCP server

Connect any MCP client to Lowdown with one URL. No install, no account, no authentication.

```
https://lowdown-proxy.vercel.app/mcp
```

- Transport: Streamable HTTP. Read-only.
- Tool: `get_lowdown` with `target` (an `mcp:` Registry name, a short name, or an `npm:` / `pypi:` package) and an optional `menu` (`install-check` before installing, `change-watch` for recent changes, or one part such as `status` or `packages`; see [menu.json](https://lowdown-proxy.vercel.app/menu.json)).
- In Claude: install it from the [Claude connectors directory](https://claude.ai/directory/connectors/lowdown), or add it as a custom connector with this URL and no sign-in. Then ask, for example, "Before I install the MCP server io.github.user/server, what has Lowdown recorded about it?"
- Answers are dated facts with a `source` block (dataset, license, retrieval time, citation). They are not scores. Absence of data says nothing about a server's status.
- [Privacy policy](https://lowdown-proxy.vercel.app/privacy). Support: atom.art2meta@gmail.com or [GitHub issues](https://github.com/PetShopBros/lowdown-proxy/issues).

## Lookup tools for agents (MCP server)

The same package ships an MCP server (stdio) that lets an agent query Lowdown directly:

```jsonc
{
  "mcpServers": {
    "lowdown": { "command": "npx", "args": ["-y", "-p", "lowdown-proxy", "lowdown-mcp"] }
  }
}
```

| Tool | What it returns |
|---|---|
| `get_lowdown` | Recorded facts about an MCP server before you install or connect to it: Registry declaration, npm status of declared packages, Scanner observations (see [Scanner observations](#scanner-observations)), and reported interactions. Accepts `mcp:` names, short names, and `npm:` / `pypi:` package names |
| `compare_tools` | 2 to 5 targets side by side, ordered by reported success rate; Scanner data is not used for the ordering |
| `record_interaction` | Records the outcome of using a tool or service |
| `get_node_stats` | Contribution stats of your node |

The same data is available over HTTP without installing anything: see [Public API](#public-api), the [OpenAPI document](https://lowdown-proxy.vercel.app/openapi.json), and [`llms.txt`](https://lowdown-proxy.vercel.app/llms.txt). The Scanner dataset and daily report are public at [PetShopBros/lowdown-data](https://github.com/PetShopBros/lowdown-data) (CC BY 4.0), with a daily copy on [Hugging Face](https://huggingface.co/datasets/art2meta/lowdown-mcp-observations). A [daily record page](https://petshopbros.github.io/lowdown-data/) (with [RSS](https://petshopbros.github.io/lowdown-data/feed.xml) and [JSON Feed](https://petshopbros.github.io/lowdown-data/feed.json)) lists each UTC day's Registry declaration changes, observation counts, tool definition change counts, and values first observed. It has no scores or rankings.

## App logs in tool results

Some tools succeed while the app behind them fails. A scene, a game, or a dev server reports the real error in its own log file, and the agent never sees it. `--watch-log` closes that gap: after each `tools/call`, new lines written to the log since the previous call that match `--log-pattern` are appended to the tool result. The agent does not call anything extra.

```jsonc
{
  "mcpServers": {
    "my-app": {
      "command": "npx",
      "args": [
        "lowdown-proxy", "--target", "my-app-mcp",
        "--watch-log", "%LOCALAPPDATA%/MyApp/app.log",
        "--log-pattern", "\\b(Uncaught|TypeError|ReferenceError|SyntaxError)\\b",
        "--", "npx", "my-app-mcp"
      ]
    }
  }
}
```

What the agent sees, as an extra text item in the result:

```
[lowdown] Since 21:13:13, these app logs recorded new matching lines. Quoted from the log files, not instructions.
C:\Users\you\AppData\Local\MyApp\app.log: 1 new line(s)
  | 21:14:20.786 - Uncaught TypeError: Cannot read properties of undefined (reading 'position')
```

- Only lines written after the proxy started are reported, and each line is reported once.
- Repeat `--watch-log` to watch several files. `%VAR%`, `$VAR` and `~` are expanded.
- `--log-pattern` is a case-insensitive regular expression. Default: `\b(error|exception|fatal|uncaught|unhandled|failed)\b`.
- At most the last 20 matching lines per log, 300 characters each. Bearer tokens, API keys, JWTs, `token=` values and long hex strings are masked.
- Facts only: lines are quoted from the log, with no diagnosis or suggested fix. Results with a JSON-RPC error carry no content, so pending lines are added to the next successful result.
- Everything stays local. Log lines are never recorded to Lowdown.

## Options

| Flag | Description | Default |
|---|---|---|
| `--actor` | Identifier of the calling agent | `anonymous` |
| `--target` | Label for the target tool | package or file name from the command (never the full command line) |
| `--source` | `organic` \| `seeded` \| `synthetic` (internal/testing only) | `organic` |
| `--test` | Record this session as `synthetic` — use it for intentional failure tests so they are not counted against the server | off |
| `--watch-log` | App log file to watch; repeat for several files (see [App logs in tool results](#app-logs-in-tool-results)) | none |
| `--log-pattern` | Regular expression for log lines to report | error, exception, fatal, uncaught, unhandled, failed |

## Recording

From 0.1.17 the proxy records through the public API (`POST /api/interactions`). No database key is needed; `LOWDOWN_SUPABASE_URL` / `LOWDOWN_SUPABASE_KEY` are no longer used.

| Variable | Effect |
|---|---|
| `LOWDOWN_RECORD=0` | Pass-through only, nothing is recorded |
| `LOWDOWN_API_URL` | Record to (and query) another Lowdown deployment |

What one record contains: actor, target label, tool name (or protocol method), outcome, latency, node id, and — when the server reported them — `server_version` (from `initialize`) and `schema_hash` (same hash as the Scanner's, from `tools/list`). Arguments and results are never recorded.

How a response is classified (MCP spec, *Tools → Error Handling*):

| Response | Recorded as | In `success_rate` |
|---|---|---|
| `tools/call` result | success | yes |
| `tools/call` result with `isError: true` | failure, `tool_error`, `error_layer: tool` | yes |
| JSON-RPC error -32700 / -32600 / -32601 / -32602 (malformed request, unknown tool, invalid arguments) | failure, `error_layer: request` | no — counted as `rejected_requests` |
| Other JSON-RPC errors (internal error, timeout) | failure, `error_layer: server` | yes |
| `initialize`, `tools/list`, `ping`, ... | `request_kind: protocol` | no — counted as `protocol_requests` |

`success_rate` counts `organic` records only; `seeded` and `synthetic` are reported separately in `by_source`. Every record carries `recorder_version`, so records made before 0.1.17 (which counted `isError` results as success) can be told apart.

## Public API

No auth required.

```bash
# What Lowdown has recorded about an MCP Registry server
curl https://lowdown-proxy.vercel.app/api/reputation/mcp:ai.agent-bev/bev-door

# A short name works when it matches one server; otherwise candidate names are returned
curl https://lowdown-proxy.vercel.app/api/reputation/bev-door

# An npm package: answers with the Registry entries that declare it (several are all returned as candidates)
curl https://lowdown-proxy.vercel.app/api/reputation/npm:maplith-bridge

# With node identity: adds task_breakdown and recent_trends for reported interactions
curl https://lowdown-proxy.vercel.app/api/reputation/mcp:ai.agent-bev/bev-door \
  -H "x-lowdown-node-id: ld_your_node_id"

# Check your node's contribution
curl https://lowdown-proxy.vercel.app/api/node/ld_your_node_id

# Record an interaction (replace the example values with your own)
curl -X POST https://lowdown-proxy.vercel.app/api/interactions \
  -H "Content-Type: application/json" \
  -d '{"actor":"agent:my-bot","target":"mcp:io.github.user/server","target_type":"tool","task_type":"web_search","outcome":"success"}'
```

Registry names contain `/`; it can be written as is or encoded as `%2F`.

Response for that server on 2026-10-20 (trimmed: the full response has 14 daily entries, the observed tool names, and the observation method):

```json
{
  "target": "mcp:ai.agent-bev/bev-door",
  "resolved_target": "mcp:ai.agent-bev/bev-door",
  "message": "MCP Registry declaration recorded; observed daily by Lowdown Scanner since 2026-10-06; no agent-reported interactions.",
  "registry": {
    "listed": true,
    "declared_version": "0.2.5",
    "status": "active",
    "remote_hosts": ["mcp.bev-buyer.ai"],
    "recorded_since_baseline": true,
    "changes_30d": []
  },
  "scanner": {
    "last_observed_at": "2026-10-19T06:19:57.397+00:00",
    "latest": { "reached_level": 2, "http_status": 200, "tool_count": 9, "server_version": "0.2.5" },
    "in_sample": true,
    "first_observed_at": "2026-10-06T19:59:59.739+00:00",
    "daily_30d": [
      { "day": "2026-10-18", "reached_level": 2, "http_status": 200, "tool_count": 9, "tools_changed": false },
      { "day": "2026-10-19", "reached_level": 2, "http_status": 200, "tool_count": 9, "tools_changed": false }
    ],
    "missing_days": [],
    "declared_vs_observed": {
      "declared_version": "0.2.5",
      "observed_server_version": "0.2.5",
      "declared_hosts": ["mcp.bev-buyer.ai"],
      "observed_hosts": ["mcp.bev-buyer.ai"]
    }
  },
  "interactions": 0,
  "success_rate": null,
  "confidence": "none"
}
```

- `registry`: what the official MCP Registry declares for the server, as recorded by Lowdown since 2026-10-19, with changes in the last 30 days. It answers for any Registry entry, observed or not.
- `packages`: the packages the Registry entry declares. For npm packages, recorded daily from npm's public metadata: `latest`, `latest_deprecated` (the version npm tags as latest only, not other versions), `declared_is_latest`, `checked_at`, and recent changes. `not_found` is recorded only when npm answers HTTP 404; `not_found_since` gives the day a package that had been available started answering 404, or `first_check` when it has answered 404 since Lowdown's first check. A deprecated latest version or a 404 is stated in the first sentence of `message`. Other package types are listed and marked as not checked.
- `scanner.definition_changes`: changes in the server's tool definitions across Lowdown's daily observations of the last 30 days. Each day is compared with the previous observation from the same remote URL using hashes of tool schemas, descriptions and names: `pattern` (`no_change_observed`, `changed`, `changes_on_most_days`, or `not_enough_observations`), `last_change`, `stable_days_before_last_change`, and up to 5 recent `events`. Use it to notice that a server which had been stable has just changed its tools, before relying on them. Description text is never returned, and a change is a recorded fact, not a judgment.
- `source` (last field): dataset, license (CC BY 4.0 for the `registry` and `scanner` blocks), retrieval time and a citation line. Keep it with any record you republish.
- `scanner`: what Lowdown Scanner observed when it connected (`initialize` and `tools/list` only; it never calls a tool): one entry per day for the last 30 days, days without an observation and the recorded reason, the tool names returned by `tools/list`, and declared values next to observed ones. HTTP statuses are reported as observed: a `401` is a `401`, not "dead". A server outside the observed sample returns `observed: false`, which says nothing about its status.
- Interaction fields: `interactions` is every reported record for the target; `rated_interactions` is the denominator of `success_rate`, and `confidence` is based on it. Scanner observations are never counted in `success_rate`.

These are recorded facts with their sources, not scores or rankings. The full schema is in [`openapi.json`](https://lowdown-proxy.vercel.app/openapi.json).

## Why Lowdown

Agents often start with no shared history of a tool's past behavior. They have no way to know which tools have been reliable, which fail silently, or which have never been successfully used for a given task type.

Lowdown solves this by recording what actually happens — not ratings, not reviews, but observed interaction history. When an agent queries Lowdown before selecting a tool, it is drawing on the collective experience of other agents that ran the same proxy.

The loop is simple:
- **Read**: query observed history before selecting a tool
- **Use**: run the tool through the proxy
- **Write**: the result is automatically recorded for the next agent

No ratings. No human curation. Just signal from actual use.

> Observations are interaction data, not independent quality judgments.

## How the network works

```
Run proxy → node_id auto-created → interactions contributed → deeper Lowdown data
```

Every proxy instance is a node.

Nodes contribute interaction data to the shared network.
Contributors get access to richer query results.

No tokens.
No points.
No reviews to write.

Just run the proxy and share what your agents experience.

## Design principles

- **Zero config**: run the proxy, everything else is automatic.
- **Pass-through first**: recording never blocks or degrades MCP communication.
- **Facts only**: v0 records success/failure and latency. Quality judgments are out of scope.
- **Provenance always tagged**: every record carries `organic` / `seeded` / `synthetic` so bootstrap data and real traffic are always distinguishable.

## Status

Running continuously since September 2026. Since October 6, 2026 the Scanner has observed a fixed sample of MCP Registry entries every day: 2,000 entries through October 18, from October 19 a 5,000-entry sample that keeps all of the first 2,000, and from October 29 a 10,000-entry sample that keeps all of those 5,000. The daily report and raw data are public at [PetShopBros/lowdown-data](https://github.com/PetShopBros/lowdown-data), with a daily copy on [Hugging Face](https://huggingface.co/datasets/art2meta/lowdown-mcp-observations).
Since October 21, 2026 the Scanner also keeps the full tool definitions it receives, privately and once per distinct definition, so that changes can be traced over time. Public data and API responses contain hashes only; the definitions themselves are not published.
See [DESIGN.md](./DESIGN.md) for what's in scope and what's been ruled out.

## License

MIT

---

## 한국어

한 번도 거래한 적 없는 상대를 에이전트가 무조건 신뢰할 필요는 없습니다.

`lowdown-proxy`는 AI 에이전트, 도구, 서비스 사이의 상호작용을 기록하고,
그 이력을 누구나 조회할 수 있게 만듭니다. 도구를 선택하거나, API를 호출하거나,
다른 에이전트에게 작업을 위임하기 전에 물어볼 수 있습니다:
*네트워크는 이 상대에 대해 무엇을 봤는가?*

MCP 서버를 감싸는 stdio 프록시가 첫 번째 진입점입니다.
평판 레이어는 MCP에 국한되지 않고 모든 에이전트, 도구, 서비스에 열려 있습니다.

기록된 데이터는 다른 에이전트가 판단할 때 참고할 수 있는 최소한의 공통 근거가 됩니다.

### 네트워크 구조

```
프록시 실행 → node_id 자동 생성 → interaction 기여 → 더 깊은 Lowdown 조회
```

프록시를 실행하는 것 자체가 노드 참여입니다. 기여할수록 더 상세한 데이터를 조회할 수 있습니다.

### Scanner 관찰 데이터

Registry 항목이 npm 패키지를 선언했으면 응답에 `packages` 블록이 옵니다. npm 공개 메타데이터에서 매일 기록한 최신 버전, 최신 버전의 deprecated 여부(다른 버전은 뜻하지 않음), 404 여부를 보여 주고, deprecated나 404는 `message` 첫 문장에 적습니다. 404는 npm이 실제로 404를 답했을 때만 기록합니다. `npm:패키지명`으로도 조회할 수 있고, 여러 항목이 같은 패키지를 선언하면 고르지 않고 후보를 모두 돌려줍니다.

PyPI 패키지도 같은 `packages` 블록에 `pypi` 상태로 옵니다. PyPI 공개 JSON·Index API에서 매일 기록한 최신 버전, 그 버전의 yanked 여부(다른 버전은 뜻하지 않음), 프로젝트 상태(`active`·`archived`·`quarantined`·`deprecated`, PEP 792), 404 여부를 보여 주고, yanked·archived·quarantined·deprecated·404는 `message` 첫 문장에 적습니다. 404는 PyPI Index API로 "프로젝트는 있으나 릴리스 없음"(`no_releases`)과 "그 이름의 프로젝트 없음"(`no_project`)을 구분합니다(`not_found_kind`). `pypi:패키지명`으로 조회할 수 있고, 이름은 PEP 503 정규화(대소문자·`-` `_` `.` 차이 무시)로 비교합니다.

공식 MCP Registry에 등록된 원격 MCP 서버는 응답에 `scanner` 블록이 함께 옵니다. `scanner.definition_changes`는 최근 30일 동안 매일 관찰한 도구 정의(스키마·설명·이름의 해시)가 같은 원격 주소의 직전 관찰과 비교해 언제 바뀌었는지, 얼마나 자주 바뀌는지를 사실로만 보여 줍니다. 오래 안정적이던 서버가 막 바뀐 것을 도구에 의존하기 전에 알아챌 수 있습니다. 설명문 원문은 돌려주지 않습니다. Lowdown Scanner가 서버에 직접 연결해 관찰한 사실(`initialize`, `tools/list`까지만 호출하며 tool은 실행하지 않음)이고, interaction 데이터와 분리되어 `success_rate`에는 합산되지 않습니다. HTTP 상태는 해석 없이 관찰된 값 그대로 보여줍니다.

공개 데이터에는 도구 스키마·설명문의 해시만 있습니다. 2026-10-21부터 Scanner는 받은 도구 정의 원문을 변경 추적용으로 비공개 보관합니다(서로 다른 정의마다 1번). 원문은 공개하지 않고 API로도 돌려주지 않습니다. 날짜별 [일일 기록 페이지](https://petshopbros.github.io/lowdown-data/)(RSS·JSON Feed 포함)에는 Registry 선언 변경, 관찰 수, 도구 정의 변경 수, 처음 관찰된 값이 점수·순위 없이 실립니다.

### 앱 로그를 도구 결과에 붙이기

도구 호출은 성공했는데 그 뒤의 앱(씬, 게임, 개발 서버)이 실패하는 경우가 있습니다. 진짜 에러는 앱의 로그 파일에만 찍혀서 에이전트는 모릅니다. `--watch-log`를 주면 `tools/call` 결과마다 직전 호출 이후 로그에 새로 찍힌 줄 중 `--log-pattern`에 맞는 줄이 결과 끝에 붙습니다. 에이전트가 따로 호출할 것은 없습니다. 로그 내용은 로컬에만 머물고 Lowdown에 기록되지 않습니다.

### 기록 방식 (0.1.17~)

프록시는 공개 API(`POST /api/interactions`)로 기록합니다. DB 키가 필요 없고 `LOWDOWN_SUPABASE_URL` / `LOWDOWN_SUPABASE_KEY`는 더 이상 쓰지 않습니다. `LOWDOWN_RECORD=0`이면 기록 없이 패스스루만 합니다.

- `tools/call` 결과의 `isError: true`는 실패(`tool_error`)로 기록합니다.
- 잘못된 요청(-32700/-32600/-32601/-32602: 형식 오류, 없는 도구, 잘못된 인자)은 서버 실패와 분리해 `rejected_requests`로 셉니다. `success_rate`에는 들어가지 않습니다.
- `initialize`, `tools/list` 같은 비도구 요청은 `protocol_requests`로 따로 셉니다.
- `success_rate`는 `organic` 기록만 계산합니다. `seeded` / `synthetic`은 `by_source`로 따로 보여줍니다. 일부러 실패시키는 테스트는 `--test`로 실행하면 `synthetic`으로 남습니다.
- 각 기록에는 그 시점의 `server_version`(initialize), `schema_hash`(tools/list, Scanner와 같은 계산), `recorder_version`이 함께 남습니다. 인자와 결과 내용은 기록하지 않습니다.
- `--target`을 주지 않으면 명령줄 전체가 아니라 패키지·파일 이름 하나만 라벨로 씁니다.

### 설계 원칙 (요약)

- **설정 없음**: 프록시를 실행하면 모든 것이 자동으로 처리됩니다.
- **패스스루 우선**: 기록 로직이 실패하거나 느려도 실제 MCP 통신은 절대 막지 않습니다.
- **사실만 기록**: v0는 성공/실패/지연시간만 기록합니다. 품질 판단은 범위 밖입니다.
- **출처 구분**: 모든 기록은 `organic` / `seeded` / `synthetic`으로 태깅됩니다.

자세한 배경과 설계 원칙은 [DESIGN.md](./DESIGN.md)를 참고하세요.