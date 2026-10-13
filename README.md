# lowdown-proxy

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
| `get_lowdown` | Interactions reported for a target and, for MCP Registry servers, the Scanner observations (see [Scanner observations](#scanner-observations)) |
| `compare_tools` | 2 to 5 targets side by side, ordered by reported success rate; Scanner data is not used for the ordering |
| `record_interaction` | Records the outcome of using a tool or service |
| `get_node_stats` | Contribution stats of your node |

The same data is available over HTTP without installing anything: see [Public API](#public-api), the [OpenAPI document](https://lowdown-proxy.vercel.app/openapi.json), and [`llms.txt`](https://lowdown-proxy.vercel.app/llms.txt). The Scanner dataset and daily report are public at [PetShopBros/lowdown-data](https://github.com/PetShopBros/lowdown-data) (CC BY 4.0).

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
| `--target` | Label for the target tool | command string |
| `--source` | `organic` \| `seeded` \| `synthetic` (internal/testing only) | `organic` |
| `--watch-log` | App log file to watch; repeat for several files (see [App logs in tool results](#app-logs-in-tool-results)) | none |
| `--log-pattern` | Regular expression for log lines to report | error, exception, fatal, uncaught, unhandled, failed |

## Environment variables

Required for recording. The proxy works as a pure pass-through without them.

```bash
export LOWDOWN_SUPABASE_URL="https://xxxx.supabase.co"
export LOWDOWN_SUPABASE_KEY="..."
```

## Public API

No auth required.

```bash
# Get reputation of a tool
curl https://lowdown-proxy.vercel.app/api/reputation/brave-search

# With node identity — returns richer data
curl https://lowdown-proxy.vercel.app/api/reputation/brave-search \
  -H "x-lowdown-node-id: ld_your_node_id"

# Check your node's contribution
curl https://lowdown-proxy.vercel.app/api/node/ld_your_node_id

# Record an interaction
curl -X POST https://lowdown-proxy.vercel.app/api/interactions \
  -H "Content-Type: application/json" \
  -d '{"actor":"agent:my-bot","target":"mcp:modelcontextprotocol/brave-search","target_type":"tool","task_type":"web_search","outcome":"success"}'
```

Basic response (no node):

```json
{
  "target": "brave-search",
  "interactions": 30,
  "success_rate": 0.933,
  "confidence": "medium"
}
```

Contributor response (with node):

```json
{
  "target": "brave-search",
  "interactions": 30,
  "success_rate": 0.933,
  "confidence": "medium",
  "task_breakdown": { ... },
  "recent_trends": [ ... ]
}
```

Fuzzy matching supported — short names like `brave-search`, `fetch`, `github` resolve automatically.

### Scanner observations

For MCP servers listed in the official MCP Registry, the response also carries a separate `scanner` block: what Lowdown's Scanner observed when it connected to the server (`initialize` and `tools/list` only — it never calls a tool). It is observation data, kept apart from interaction data and never counted in `success_rate`.

```bash
curl https://lowdown-proxy.vercel.app/api/reputation/mcp:io.github.user/server
```

```json
{
  "target": "mcp:io.github.user/server",
  "interactions": 0,
  "success_rate": null,
  "scanner": {
    "target": "mcp:io.github.user/server",
    "last_observed_at": "2026-10-07T19:17:00+00:00",
    "observations_30d": 28,
    "latest": { "reached_level": 2, "http_status": 200, "latency_ms": 312, "tool_count": 7 },
    "schema_versions_30d": 1,
    "status_distribution_30d": { "200": 28 }
  }
}
```

HTTP statuses are reported as observed — a `401` is a `401`, not "dead".

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

Running continuously since September 2026. Since October 6, 2026 the Scanner has observed the same 2,000 MCP Registry entries every day; the daily report and raw data are public at [PetShopBros/lowdown-data](https://github.com/PetShopBros/lowdown-data).
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

공식 MCP Registry에 등록된 원격 MCP 서버는 응답에 `scanner` 블록이 함께 옵니다. Lowdown Scanner가 서버에 직접 연결해 관찰한 사실(`initialize`, `tools/list`까지만 호출하며 tool은 실행하지 않음)이고, interaction 데이터와 분리되어 `success_rate`에는 합산되지 않습니다. HTTP 상태는 해석 없이 관찰된 값 그대로 보여줍니다.

### 앱 로그를 도구 결과에 붙이기

도구 호출은 성공했는데 그 뒤의 앱(씬, 게임, 개발 서버)이 실패하는 경우가 있습니다. 진짜 에러는 앱의 로그 파일에만 찍혀서 에이전트는 모릅니다. `--watch-log`를 주면 `tools/call` 결과마다 직전 호출 이후 로그에 새로 찍힌 줄 중 `--log-pattern`에 맞는 줄이 결과 끝에 붙습니다. 에이전트가 따로 호출할 것은 없습니다. 로그 내용은 로컬에만 머물고 Lowdown에 기록되지 않습니다.

### 설계 원칙 (요약)

- **설정 없음**: 프록시를 실행하면 모든 것이 자동으로 처리됩니다.
- **패스스루 우선**: 기록 로직이 실패하거나 느려도 실제 MCP 통신은 절대 막지 않습니다.
- **사실만 기록**: v0는 성공/실패/지연시간만 기록합니다. 품질 판단은 범위 밖입니다.
- **출처 구분**: 모든 기록은 `organic` / `seeded` / `synthetic`으로 태깅됩니다.

자세한 배경과 설계 원칙은 [DESIGN.md](./DESIGN.md)를 참고하세요.