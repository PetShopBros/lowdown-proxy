---
name: lowdown-mcp-lookup
description: Look up Lowdown's daily observations of an MCP Registry server (reachability, HTTP status, tool count, tool-schema changes) through a public read-only API.
tools:
  - http
---

## Lowdown MCP lookup

Lowdown is a time-series record of the gap between what the official MCP Registry declares and what is actually observed. Once a day it connects to a fixed sample of 2,000 Registry servers, sends `initialize` and `tools/list` only (it never calls a tool or authenticates), and records what it sees. It does not score, grade, or rank servers.

This skill reads that record. It uses one public GET endpoint, needs no API key, and sends nothing but the server name.

### When it helps

- A task involves an MCP server from the official MCP Registry and recent observed facts about it would help: whether it has been answering, whether it requires auth, how many tools it lists, whether its tool schemas changed.

### Query

```
GET https://lowdown-proxy.vercel.app/api/reputation/{target}?ref=clawhub
```

- `target` is the Registry name with the `mcp:` prefix, URL-encoded, e.g. `mcp%3Aio.github.example%2Fserver`. A short name such as `brave-search` also works when it matches one server.

### Reading the response

The `scanner` block holds the observations (last 30 days):

- `last_observed_at`: time of the latest daily probe
- `latest.reached_level`: `2` = initialize and tools/list completed, `1` = initialize only, `0` = initialize did not complete
- `latest.http_status`: HTTP status as observed. `401` means auth is required; it is not a failure.
- `latest.error_type`: set only when no valid response arrived (`timeout`, `dns`, `tls`, ...)
- `latest.tool_count`, `schema_versions_30d`: number of tools and how many distinct tool-schema versions were seen in 30 days
- `status_distribution_30d`: counts of each observed status

Other cases:

- `scanner.observed: false`: the server is outside the observed sample. This says nothing about its status.
- `scanner_candidates`: a short name matched several servers; repeat with one of the listed names.

These are single daily probes from one location, not uptime. Report them as dated observations, not as a rating.

### Example

User: "Has the example MCP server been responding lately?"

1. `GET https://lowdown-proxy.vercel.app/api/reputation/mcp%3Aio.github.example%2Fserver?ref=clawhub`
2. Summarize: last observed date, reach level, HTTP status, tool count, and whether tool schemas changed in the last 30 days.

### More

- Daily report and raw data (CC BY 4.0): https://github.com/PetShopBros/lowdown-data
- API schema: https://lowdown-proxy.vercel.app/openapi.json
- Source (MIT): https://github.com/PetShopBros/lowdown-proxy
