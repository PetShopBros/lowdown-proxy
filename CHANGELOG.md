# Changelog

All notable changes to this project will be documented in this file.

## [0.1.17] - 2026-10-15

### Changed
- The proxy records through the public API (`POST /api/interactions`) instead of writing to the database directly. No database key is needed; `LOWDOWN_SUPABASE_URL` / `LOWDOWN_SUPABASE_KEY` are ignored (a one-time notice is printed if the key is still set). `LOWDOWN_RECORD=0` disables recording.
- Response classification follows the MCP spec (*Tools → Error Handling*): a `tools/call` result with `isError: true` is now a failure (`tool_error`). Earlier versions recorded it as success.
- Malformed requests, unknown tools and invalid arguments (-32700/-32600/-32601/-32602) are recorded with `error_layer: request` and kept out of `success_rate`; other JSON-RPC errors are `error_layer: server`.
- Requests other than `tools/call` (`initialize`, `tools/list`, `ping`, ...) are recorded as `request_kind: protocol` and kept out of `success_rate`.
- Without `--target`, the label is the package or file name from the command, not the full command line (arguments may contain keys or paths).
- `GET /api/reputation/:target`: `success_rate` now counts organic tool calls and agent reports only. New fields `rated_interactions` (its denominator; `confidence` is based on it), `protocol_requests`, `rejected_requests`, `by_source`, `success_rate_basis`. `interactions` is still the total record count. Values for existing targets can change.
- `compare_tools` ranks and gates suggestions by `rated_interactions`.

### Added
- Each record carries `server_version` (from `initialize`), `schema_hash` (from `tools/list`, same hash as the Scanner), and `recorder_version`.
- `--test`: records the session as `synthetic`, for intentional failure tests.
- `POST /api/interactions` accepts `node_id`, `request_kind`, `error_layer`, `server_version`, `schema_hash`, `recorder_version`; validates lengths and formats; at most 120 records per minute per `node_id` (or `actor`).
- `supabase/2026-10-15_interactions_p0.sql` (columns, checks, `reputation_summary` rules) and `supabase/2026-10-15_interactions_rls.sql` (`interactions` becomes server-only).

### Security
- Server-side keys moved to secret keys; tables written only by the server have RLS on with no public access.

## [0.1.16] - 2026-10-13

### Added
- `--watch-log <file>` (repeatable) and `--log-pattern <regex>`: after each `tools/call`, new matching lines from the app logs are appended to the result as one text item. Lines written before the proxy started are not reported; each line is reported once. Last 20 lines per log, 300 characters each, common secret formats masked. Log content stays local and is never recorded.

## [Unreleased] - v0.4 Scanner

### Added
- `scanner/` — daily observation of remote (streamable-http) MCP servers listed in the official MCP Registry.
- `scanner/report.ts` — generates a public `REPORT.md` (counts only; no server names, scores, or labels) into the `lowdown-data` repository. `report.yml` runs it manually first; daily automation follows after verification. Records `initialize` / `tools/list` reachability as plain facts (HTTP status, latency, tool count, schema hash). Never calls a tool; never stores tool names or descriptions.
- `scanner` block on `GET /api/reputation/:target` — observation data from the Scanner, kept separate from interaction data and never counted in `success_rate`. Short names resolve when unambiguous; otherwise `scanner_candidates` lists up to 5 matches.
- `scanner: { observed: false, note }` on `GET /api/reputation/:target` when the lookup found no Scanner observation (target outside the fixed 2,000-entry cohort). States that absence of data says nothing about the target's status. Lookup errors still omit the block.
- Optional `?ref=<tag>` on `GET /api/reputation/:target`, recorded in `reputation_lookups.ref` to measure where lookups come from.
- `supabase/scanner_observations.sql` — `scanner_observations` table (RLS on, no public policy), `scanner_summary` public aggregate view, `reputation_lookups.ref` column.
- Fixed cohort: Day 0 selects 2,000 probeable Registry entries by SHA-256 order and stores them in `scanner_cohort` (`cohort_version`, e.g. `2026-10-07-v1`); every later run observes the same entries with their current remote URLs. Entries that disappear from the Registry are counted as `cohort_missing`, not recorded as failures. Observations carry `metadata.cohort_version`.
- Registry requests use `version=latest` (the Registry otherwise returns every version of every server).
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
