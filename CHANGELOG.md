# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased] - v0.4 Scanner

### Added
- `scanner/` — daily observation of remote (streamable-http) MCP servers listed in the official MCP Registry. Records `initialize` / `tools/list` reachability as plain facts (HTTP status, latency, tool count, schema hash). Never calls a tool; never stores tool names or descriptions.
- `scanner` block on `GET /api/reputation/:target` — observation data from the Scanner, kept separate from interaction data and never counted in `success_rate`. Short names resolve when unambiguous; otherwise `scanner_candidates` lists up to 5 matches.
- Optional `?ref=<tag>` on `GET /api/reputation/:target`, recorded in `reputation_lookups.ref` to measure where lookups come from.
- `supabase/scanner_observations.sql` — `scanner_observations` table (RLS on, no public policy), `scanner_summary` public aggregate view, `reputation_lookups.ref` column.
- GitHub Actions: `scanner.yml` (daily) and `backup.yml` (weekly CSV export to a separate `lowdown-data` repository).

### Notes
- Hosted API change only — no npm release is needed for installed clients to see the `scanner` block through `get_lowdown`.
- Run `supabase/scanner_observations.sql` before expecting `scanner` data; until then the API behaves exactly as before.

## [0.1.3] - 2026-09-26

### Added
- Fuzzy matching on `GET /api/reputation/:target` — short names like `brave-search` now resolve to `mcp:modelcontextprotocol/brave-search` automatically
- MCP Registry registration at `io.github.PetShopBros/lowdown-proxy` via `mcp-publisher`
- Synthetic seed data: 180 interaction records across 6 targets (5 MCP tools + `api:deepseek/deepseek-chat`), source tagged `synthetic`

### Changed
- `mcpName` in `package.json` corrected to `io.github.PetShopBros/lowdown-proxy`
- `server.json` updated with correct namespace and transport field format

## [0.1.1] - 2026-09-26

### Added
- MCP server (`lowdown-mcp`) with three tools:
  - `get_lowdown(target)` — query reputation of any agent, tool, or service
  - `record_interaction(...)` — record an interaction after using a tool
  - `compare_tools([...])` — rank candidates by success rate (rule-based, no LLM judge)
- Public REST API deployed on Vercel:
  - `GET /api/reputation/:target` — open read, no auth required
  - `POST /api/interactions` — record an interaction via HTTP
- `x-lowdown-source` header support for provenance tagging (`organic` / `seeded` / `synthetic`)
- `confidence` field in reputation response (`low` / `medium` / `high` based on interaction count thresholds: <10 / <100 / 100+)
- CORS headers on all API routes (`Access-Control-Allow-Origin: *`)
- Reputation lookup logging to `reputation_lookups` table for organic discovery tracking

### Infrastructure
- Supabase project on ap-northeast-2 (Seoul)
- Tables: `interactions`, `reviews`, `reputation_lookups`
- View: `reputation_summary` — aggregated success rate, review count, avg rating, review conversion rate

## [0.1.0] - 2026-09-26

### Added
- `lowdown-proxy` — transparent stdio proxy that wraps any MCP server process
- Automatic interaction recording on every `tools/call` response (actor, target, target_type, task_type, outcome, latency_ms, source)
- Supabase integration with fire-and-forget pattern — proxy never blocks or fails due to a write error
- CLI entry point: `npx lowdown-proxy [--actor <id>] [--target <label>] [--source organic|seeded|synthetic] -- <command> [args...]`
- `.env.example` and `supabase/schema.sql` included in repository

### Design Decisions
- **Read-first**: `GET /reputation` is public and requires no authentication — agents can look things up without signing in
- **Provenance always tagged**: every record carries `source` (synthetic / seeded / organic) so bootstrap data and real traffic are always distinguishable
- **`target_type` is open**: `agent` / `tool` / `service` / `human` — not locked to MCP
- **Minimum unit of reputation is the interaction record**: no star rating required; opinions (reviews) are additive
- **Pass-through is the primary function**: recording is a side effect and must never degrade proxy reliability

---

*Lowdown is a 30-day public experiment in shared AI agent reputation. See the project brief for full context.*
