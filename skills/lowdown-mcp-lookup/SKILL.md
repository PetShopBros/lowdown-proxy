---
name: lowdown-mcp-lookup
description: Before choosing or connecting to an MCP server, look up what Lowdown has recorded about it - the official MCP Registry declaration and its recent changes, plus daily observed reachability, HTTP status, tool names, and tool-schema changes - through a public read-only API with no key.
tools:
  - http
---

## Lowdown MCP lookup

Lowdown is a time-series record of the gap between what the official MCP Registry declares and what is actually observed. It keeps a daily record of every Registry declaration, and once a day it connects to a fixed sample of 5,000 Registry servers, sends `initialize` and `tools/list` only (it never calls a tool or authenticates), and records what it sees. It does not score, grade, or rank servers.

This skill reads that record. It uses one public GET endpoint, needs no API key, and sends nothing but the server name.

### When it helps

- A task involves choosing, connecting to, or troubleshooting an MCP server from the official MCP Registry, and recent recorded facts about it would help: what it declares, whether that changed recently, whether it has been answering, whether it requires auth, which tools it lists, and whether its tool schemas changed.

### Query

```
GET https://lowdown-proxy.vercel.app/api/reputation/{target}?ref=clawhub
```

- `target` is the Registry name with the `mcp:` prefix, e.g. `mcp:io.github.example/server`. The `/` can be sent as is or encoded as `%2F`. A short name also works when it matches one server; otherwise candidate names are returned.

### Reading the response

Fields come in this order:

- `message`: one factual sentence saying which records exist.
- `registry`: what the official MCP Registry declares, as recorded by Lowdown since 2026-10-19.
  - `listed`, `declared_version`, `status`, `remote_hosts`, `removed_at`
  - `changes_30d`: Registry changes in the last 30 days (`new`, `version`, `status`, `remotes`, `packages`, `description`, `removed`, `restored`)
  - `recorded_since_baseline: true` means the entry was already present on 2026-10-19; `first_recorded_at` is then not when it first appeared in the Registry.
- `scanner`: daily observations (only for servers in the observed sample).
  - `latest.reached_level`: `2` = initialize and tools/list completed, `1` = initialize only, `0` = initialize did not complete
  - `latest.http_status`: HTTP status as observed. `401` means auth is required; it is not a failure.
  - `daily_30d`: one entry per day for the last 30 days (`reached_level`, `http_status`, `error_type`, `tool_count`, `tools_changed`)
  - `missing_days`: days without an observation and the recorded reason
  - `tools.names`: tool names returned by `tools/list` in the latest successful observation
  - `declared_vs_observed`: declared version and hosts next to the observed ones
  - `method`: how the observations were made and what they do not show
- `interactions`, `success_rate`: outcomes reported by agents, kept separate from Scanner observations.

Other cases:

- `scanner.observed: false`: the server is outside the observed sample. This says nothing about its status; the `registry` block still answers.
- `registry_candidates` or `scanner_candidates`: a short name matched several servers; repeat with one of the listed names.

These are single daily probes from one location, not uptime. Report them as dated observations, not as a rating.

### Example

User: "Has the example MCP server been responding lately, and did its tools change?"

1. `GET https://lowdown-proxy.vercel.app/api/reputation/mcp:io.github.example/server?ref=clawhub`
2. Summarize with dates: declared version and any Registry changes, the last observed date, reach level and HTTP status over the last days, any missing days and their reasons, the tool names, and whether tools changed.

### More

- Daily data files and report (CC BY 4.0): https://github.com/PetShopBros/lowdown-data
- API schema: https://lowdown-proxy.vercel.app/openapi.json
- Source (MIT): https://github.com/PetShopBros/lowdown-proxy
