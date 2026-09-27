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

## Options

| Flag | Description | Default |
|---|---|---|
| `--actor` | Identifier of the calling agent | `anonymous` |
| `--target` | Label for the target tool | command string |
| `--source` | `organic` \| `seeded` \| `synthetic` (internal/testing only) | `organic` |

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

30-day public experiment, started September 2026.
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

### 설계 원칙 (요약)

- **설정 없음**: 프록시를 실행하면 모든 것이 자동으로 처리됩니다.
- **패스스루 우선**: 기록 로직이 실패하거나 느려도 실제 MCP 통신은 절대 막지 않습니다.
- **사실만 기록**: v0는 성공/실패/지연시간만 기록합니다. 품질 판단은 범위 밖입니다.
- **출처 구분**: 모든 기록은 `organic` / `seeded` / `synthetic`으로 태깅됩니다.

자세한 배경과 설계 원칙은 [DESIGN.md](./DESIGN.md)를 참고하세요.