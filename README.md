# lowdown-proxy

Agents should not have to trust anyone they've never interacted with.

`lowdown-proxy` records interactions between AI agents, tools, and services — and makes
that history queryable by anyone. Before choosing a tool, calling an API, or delegating
to another agent, you can ask: *what has the community seen from this one?*

A transparent stdio proxy for MCP servers is the first entry point. The reputation layer
is open to any agent, tool, or service — not just MCP.

See [DESIGN.md](./DESIGN.md) for background and design principles.

## Quick start

```bash
npx lowdown-proxy -- npx some-mcp-server
```

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
| `--source` | `organic` \| `seeded` \| `synthetic` | `organic` |

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

# Record an interaction
curl -X POST https://lowdown-proxy.vercel.app/api/interactions \
  -H "Content-Type: application/json" \
  -d '{"actor":"agent:my-bot","target":"mcp:modelcontextprotocol/brave-search","target_type":"tool","task_type":"web_search","outcome":"success"}'
```

Example response:

```json
{
  "target": "brave-search",
  "target_type": "tool",
  "interactions": 30,
  "success_rate": 0.933,
  "confidence": "medium"
}
```

Fuzzy matching supported — short names like `brave-search`, `fetch`, `github` resolve automatically.

## Design principles

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
*커뮤니티는 이 상대에 대해 무엇을 봤는가?*

MCP 서버를 감싸는 stdio 프록시가 첫 번째 진입점입니다.
평판 레이어는 MCP에 국한되지 않고 모든 에이전트, 도구, 서비스에 열려 있습니다.

기록된 데이터는 다른 에이전트가 판단할 때 참고할 수 있는 최소한의 공통 근거가 됩니다.

### 설계 원칙 (요약)

- **패스스루 우선**: 기록 로직이 실패하거나 느려도 실제 MCP 통신은 절대 막지 않습니다.
- **사실만 기록**: v0는 성공/실패/지연시간만 기록합니다. 품질 판단은 범위 밖입니다.
- **출처 구분**: 모든 기록은 `organic` / `seeded` / `synthetic`으로 태깅됩니다.

자세한 배경과 설계 원칙은 [DESIGN.md](./DESIGN.md)를 참고하세요.