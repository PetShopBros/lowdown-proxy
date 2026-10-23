# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Added
- `GET /api/reputation/{target}`: `scanner.definition_changes` shows when an observed server's tool definitions changed in the last 30 days and how often (`pattern`, `last_change`, `stable_days_before_last_change`, up to 5 recent `events`). Each daily observation is compared with the previous one from the same remote URL using hashes only; description text is never returned. The first sentence (`message`) now states the latest change.
- Lookup log records `result_kind` (`observed`, `candidates`, `registry_only`, `interactions_only`, `none`, `task_type`) to measure lookups that found no answer. Requires `supabase/2026-10-22_lookups_result_kind.sql`; without the column the lookup is still logged.
- Lookup responses carry `Link: <https://github.com/PetShopBros/lowdown-data>; rel="related"`, and `llms.txt` points bulk users to the daily dataset and to GitHub issues.
- Attribution travels with the data: every lookup response ends with a `source` block (dataset, license, retrieval time, citation line; the lookup URL only for a verified Registry name), and daily record JSON files from 2026-10-22 include `source` (page, dataset, license, citation with `data_as_of`). Daily record pages declare `rel="license"` and link their JSON file with `rel="alternate"`; the JSON Feed carries the license and dataset.

- `GET /api/reputation/{target}`: `packages` block for the packages a Registry entry declares. For npm packages it gives npm's latest version, `latest_deprecated` (the latest version only), `modified`, `declared_is_latest`, `checked_at`, and up to 5 changes in the last 30 days. `not_found` is recorded only for HTTP 404; `not_found_since` separates a package that was available and then answered 404 (the day) from one that has answered 404 since Lowdown's first check (`first_check`). A deprecated latest version or a 404 is stated in the first sentence; new versions are listed only in the history. Other package types are listed and marked as not checked.
- When no Registry entry declares the package in an `npm:<package>` lookup, the first sentence now says so by name and states that Lowdown records npm package status only for packages that Registry entries declare (previously: "No MCP Registry record found").
- `npm:<package>` lookups answer with the Registry entries that declare the package; when several do, all are returned as `registry_candidates` and none is picked. `result_kind` gains `package_only`.
- Leading and trailing whitespace in the target is removed before lookup (the log keeps the input as received). Other characters are not changed; a literal escape sequence such as `\n` is looked up as given and the message says so.
- Daily record: `days/latest.json` is a copy of the newest daily JSON at a fixed address. The About page carries schema.org `Dataset` markup (JSON-LD) for dataset search engines, with the license, the period covered and download locations.

- PyPI package snapshot (`scanner/pypi-snapshot.ts`, `supabase/pypi_packages.sql`, `.github/workflows/pypi.yml`): once a day, for each PyPI package declared in the MCP Registry, records the latest version, whether that version is yanked, its upload time, and the project status (PEP 792: active, archived, quarantined), from PyPI's public JSON and Index APIs. Same rules as the npm snapshot: state and changes kept apart, first observation is a baseline, only HTTP 404 counts as not found. No package code is run; descriptions, yank reasons and vulnerability data are not read or stored.

- stdio sandbox (`sandbox/`, `supabase/sandbox.sql`), private pilot: on a separate disposable server, installs npm packages that the MCP Registry declares with `stdio` transport (`npm install --ignore-scripts`) and starts them in a gVisor container with no network and no environment variables, passing only the fixed values of the arguments the Registry entry declares, sending `initialize` and `tools/list` only. Records how far each server answered, exit codes and the same hashes as the remote Scanner; full tool definitions go to the existing private tables. Never runs on GitHub Actions; `sandbox-watchdog.yml` only checks that the server is still running.

- npm package snapshot (`scanner/npm-snapshot.ts`, `supabase/npm_packages.sql`): once a day, for each npm package declared in the MCP Registry, records the latest version, the registry's modified time and whether the latest version is deprecated, from npm's public abbreviated metadata. State and change events are kept apart; the first observation is a baseline; only HTTP 404 counts as not found, and network or server errors never change the recorded state. No package code is run and no npm text is stored.

### Changed
- The lookup API reads optional single rows with `maybeSingle()`, so targets without reported interactions no longer produce HTTP 406 responses from the database (the API response was already correct; this removes misleading warnings in database logs).
- Scanner 0.5.0 records `metadata.tool_set_hash` on each observation and, with `TOOL_DEFS=1`, stores full tool definitions in private tables (`scanner_tool_defs`, `scanner_tool_set_versions`). Each definition is stored once by content hash; observations reference it, so the history keeps its time axis without storing unchanged definitions again. Definitions are never exposed through the public API or views.
- Rule flags table (`scanner_tool_flags`) and derived change table (`scanner_tool_changes`). The first rule, `oversize`, marks definitions over 64 KB. Flags describe what was observed; they are not a verdict.
- Daily record pages (market board, stage 3): one page per UTC day with Registry declaration changes, Lowdown observation counts, server-level tool definition change counts, and values first observed by Lowdown. RSS and JSON Feed (last 30 days), a JSON file per day, an archive, and an About page that defines each section. Published from `lowdown-data/docs` on GitHub Pages; pages and feeds are generated only from the daily JSON files. No scores or rankings.
- Private backup of raw tool definitions (`scanner/private-archive.ts`, run by the `backup` workflow). For each closed UTC day it writes `tool_defs`, `tool_set_versions` and `tool_flags` as JSONL.gz plus a `MANIFEST.csv` to a private repository. Files are written once and never rewritten. A day is skipped if its row count differs from the database, and each definition's `sha256(body)` is checked against its `def_hash` before writing. Workflow logs contain counts and hash prefixes only.

## [0.1.19] - 2026-10-23

### Changed
- `get_lowdown` (MCP) description says when the lookup helps (before installing or connecting to an MCP server), accepts `npm:<package>`, and lists the `packages` block. The tool itself still forwards the hosted API response unchanged.

## [0.1.18] - 2026-10-20

### Changed
- `GET /api/reputation/:target` returns what Lowdown has recorded in this order: `registry`, `scanner`, then reported interactions, with `resolved_target` and a factual `message` first. Existing fields keep their names and meaning.
- `get_lowdown` (MCP) description lists the new blocks and says when the lookup helps.
- Registry names can be written with a raw `/` (`/api/reputation/mcp:ns/name`); before, only `%2F` worked.
- README examples use a real observed server; the record example uses a placeholder target.

### Added
- `registry` block: what the official MCP Registry declares for the target (version, status, remote hosts, packages) as recorded by Lowdown since 2026-10-19, with changes in the last 30 days. It answers for any Registry entry, including those outside the Scanner sample. `registry_candidates` when a short name matches several names.
- `scanner` block: `in_sample`, `cohorts`, `first_observed_at`, `daily_30d` (one entry per day), `missing_days` (with the recorded reason), `tools` (tool names from the latest successful `tools/list`, from Scanner 0.4.0), `declared_vs_observed`, and `method`.
- Scanner 0.4.0 records observed tool names and capability keys, and the first time Lowdown observed each value.
- Daily public archive in `lowdown-data`: one gzip-compressed CSV per UTC day, monthly Parquet, Registry change files and monthly snapshots, and `MANIFEST.csv` with row counts and SHA-256.

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
