# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Added
- Server pages on the API host (`api/page.ts`, `vercel.json`): `/servers/{namespace}/{name}` is a human-readable page for each MCP Registry server, rendered from `GET /api/reputation/mcp:{name}` (the same first sentence and facts; nothing is recomputed). Sections: Does it respond? / Does it require authentication? / Did its tools change recently? (with content markers) / What tools does it list? / MCP Registry declaration, plus the method, limits and links to the JSON and the dataset. Every value is HTML-escaped. Servers without a recorded daily check get `noindex`; names with no Registry record and no check answer 404; a 503 from the API answers 503 with `Retry-After`. `/servers` lists every server in `target_status_summary`, and `/sitemap.xml` lists the same pages with the latest check date as `lastmod` (robots.txt has a `Sitemap:` line). Visits are logged in `discovery_hits` (path and User-Agent, no IP), so search and AI user agents reading the pages can be counted; pages are not cached at the CDN for that reason. The page calls the API with the visitor's User-Agent and `ref=page`, so `reputation_lookups` classifies the visitor the same way and page views can be separated.
- Content markers on tool definition changes (`supabase/2026-10-27_tool_content_flags.sql`): two rules now run on every stored tool definition, in the database only (a trigger on `scanner_tool_defs`; existing definitions were processed once): `hidden_characters` v1 (invisible Unicode characters anywhere in the definition: U+200B–200F, U+202A–202E, U+2060–2064, U+2066–2069, U+FEFF, U+E0000–E007F; evidence: count and fields) and `description_url` v1 (an http(s) URL in the tool description; evidence: URL count and up to 5 domains that pass a hostname check). Markers are stored in `scanner_tool_flags` with no text from the definition. The trigger never blocks storing a definition. In `GET /api/reputation/{target}`, each tool definition change in `scanner.definition_changes.events` has `new_flags`: markers that appeared compared with the previous tool set from the same remote (the number of definitions with the marker rose, or a domain is new), `[]` when checked and none appeared, `null` when not checked (either tool set not stored, or the lookup failed; `content_flags_checked` says which). A marker that appeared in the last 7 days is stated in the first sentence, e.g. "On 2026-10-26 a tool description with a URL appeared (new domain: example.org)." Tool set hashes and definition text are not returned. Markers are facts, not judgments.
- `hidden_characters` v2 (`supabase/2026-10-27_tool_content_flags_v2.sql`): the first measurement of v1 (12 of 68,956 stored definitions) found only U+200C (zero-width non-joiner, normal in Persian writing; 9) and U+200B (zero-width space; 3), and no text-direction controls or tag characters. v1 put all of them in one marker and would have stated normal Persian text as "invisible characters" in the first sentence. v2 has the same character range split by kind in `evidence.kinds` (`direction_controls`, `tag_characters`, `zero_width`, `joiners`), and the API reports them as `hidden_direction_controls`, `hidden_tag_characters`, `hidden_zero_width` and `hidden_joiners`. Only text-direction controls and tag characters are stated in the first sentence; zero-width and joiner characters are in `new_flags` only. v1 rows are kept; new definitions get v2 only; the API reads v2 only.
- Connectivity status in `GET /api/reputation/{target}` (`supabase/2026-10-27_target_status_summary.sql`): the first sentence of `message` now states the latest daily check, e.g. "Answered initialize and tools/list on all 21 daily checks recorded in the last 30 days (2026-10-06 to 2026-10-26); 5 tools listed." or "No successful response on the last 3 consecutive daily checks (...). Checked from one network location.", and a new `status` block (first in the response) carries the same facts as data. Rules (`target_status` version 1, recorded in `analysis_definitions`): one UTC day per check, per remote the best result of the day including the retry; a day is `answered`, `auth_required`, `list_failed`, `no_response` or `invalid_response` only when all observed remotes agree, else `mixed` with per-remote counts, so one answering remote does not make the server answered; consecutive days are counted on the calendar and a day without a check ends the run instead of counting as a failure (`consecutive_break`: `state_change`, `not_observed`, `no_earlier_observation`, `window_start`). "All N" is said only when every observed day in the 30-day window had the result. A latest check older than 2 days is reported as such and no current connectivity is stated. The summary is precomputed twice a day after the scan (`target_status_summary`, materialized view, UTC 03:37 and 14:37) and read as one row; a database error reading it answers 503 like the other core records. Targets without a check get no status sentence; the existing `scanner` block is unchanged.

### Fixed
- `GET /api/reputation/{target}` no longer answers 200 with an empty record when its own records cannot be read. If the interactions summary, the Registry records or `scanner_summary` return a database error, the answer is `503` with `Retry-After: 120`, `Cache-Control: no-store` and `{"error":"temporarily_unavailable"}`, and the lookup is logged with `result_kind = 'unavailable'`. Before, these errors were dropped and the answer looked like "no record" (`result_kind = 'none'`, `confidence: "none"`); during the 2026-10-25 overload a crawler received such answers for valid Registry entries and fetched them again one to two days later. An empty result without an error is still 200 (`scanner.observed: false`). Failures of the supplementary parts (npm and PyPI state, sandbox, day-by-day history, record page) still leave those parts out of a 200 answer.
- `GET /api/reputation/{target}` under bulk lookups (`supabase/2026-10-26_summary_precompute.sql`): on 2026-10-25 anonymous lookups walked the whole Registry (up to 1,000+ per hour, one per target) and the database stopped answering (`57014 statement timeout`, then 504 on every table). `scanner_summary` aggregated the last 30 days of all observations on every lookup, even for one `target_id`. The calculation moved to the private view `scanner_summary_live`; `scanner_summary` is now a materialized view of it with a unique index on `target_id`, refreshed hourly at :07 (`pg_cron`, concurrently). Scanner results reach the API up to about an hour later. Partial-match lookups have trigram indexes and run only for inputs of 3+ characters and only when the exact lookup returned no row without an error. Observations are unchanged.
- stdio sandbox (runner 0.2.2): an install that answers ETARGET/ENOVERSIONS is tried once more with `--prefer-online` before being recorded as `install_version_not_found`. With `--prefer-offline`, the shared npm cache could hold package information older than the version being installed; 57 of the 59 such results in the 2026-10-25 batch were packages installed before. Earlier rows are kept; retried runs record `metadata.install_retry`.

### Added
- stdio sandbox 0.3.0 (`sandbox/`, `supabase/2026-10-26_sandbox_pypi.sql`): PyPI packages that the Registry declares as `stdio` are installed with wheels only (`pip install --target ... --only-binary=:all:`, so no package or dependency build code runs at install), started with `initialize` and `tools/list` only, in the same isolation as npm (gVisor, no network at run time, read-only package folder). The executable is the package's own `console_scripts` entry (one: that one; several: the one named like the package; else `bin_ambiguous`). New outcome `install_no_matching_dist` (no wheel for this environment, or no such version). A separate image (`sandbox/Dockerfile.python`, no compiler); without it PyPI targets are skipped and npm runs as before. The daily limit is now the time budget (1,500 targets, 4 h) instead of a fixed 400; what is not reached carries over, newest first.
- stdio sandbox publication, built and switched off (`supabase/2026-10-26_sandbox_summary.sql`, `shapeSandbox` in `GET /api/reputation/{target}`): a materialized summary `sandbox_summary` (latest run per package version; outcome, reached level, tool count, install-scripts flag; no tool names, hashes, arguments or logs) is not readable by `anon` until it is granted and `SANDBOX_PUBLIC=1` is set. When on, the response has a `sandbox` block for declared npm packages and a `sandbox_note`. Criteria for switching on are in `sandbox/README.md`.
- Observation of looked-up targets (`scanner/requested-lib.ts`, `supabase/2026-10-26_scanner_requested.sql`): a Registry entry that someone looked up (including by crawlers) and that has no observation (`result_kind = registry_only`, last 2 days, exact `mcp:` name or bare Registry name only) is added to `scanner_requested` and observed in the next daily runs, after the fixed cohort, with the same probe. Limits: 1,000 new per day, 3,000 total (`REQUESTED_DAILY_CAP`, `REQUESTED_TOTAL_CAP`; `0` turns it off); lookups that are not from crawlers come first, the rest wait for the next day. These rows have `source = 'scanner_requested'` and `metadata.observation_basis = 'requested'`; they are not part of the fixed sample, so REPORT.md, the daily record, the fallback list and first-seen only read `source = 'scanner'`. The API reports `scanner.observation_basis` (`fixed_cohort` or `on_request`) and `in_sample` is unchanged (fixed cohorts only). Rows are in the public CSV export with their `source`. Skipped on `--limit` runs and registry-fallback days; a failure here does not affect the fixed cohort.
- Private archive (`scanner/private-archive.ts`, `lowdown-private`): records whose only copy was the database are now kept as one JSONL.gz per closed UTC day, like the tool definitions: `reputation_lookups` (`lookups/`, includes User-Agent, so private), `interactions`, `reviews` (from 2026-09-26) and `sandbox_runs` (from 2026-10-21, one extra day of waiting because sandbox runs cross UTC midnight). All columns are written in key-name order, so columns added later are kept too. Files are written only when the row count matches the database and are never rewritten. One dataset failing no longer stops the others; files already written are committed and the run still fails.
- `reputation_lookups.bot_kind` / `bot_name` (`supabase/2026-10-26_lookups_bot_kind.sql`): a trigger classifies the User-Agent of each lookup as `crawler` (indexing or training collection, e.g. ClaudeBot) or `ai_user` (a person asked an AI to look it up, e.g. Claude-User). `source` and `user_agent` are unchanged; earlier rows were classified into the new columns only.
- Daily record (`lowdown-data`, `scanner/market.ts`): section 5 "Declared packages (npm, PyPI)" and a `packages` block in the day JSON (`lowdown-market-day/2`; `/1` files are still read and not rewritten). For packages that current Registry entries declare, it lists by name the previous day's npm and PyPI status facts in the registries' own terms (npm: latest version deprecated or no longer deprecated, HTTP 404, available again; PyPI: latest release yanked or no longer yanked, project status change, HTTP 404, available again) with the Registry entries that declare them, and counts new latest versions only. Same-scope groups of 10 or more share one line and the page shows at most 50 lines; the JSON has all of them. A snapshot that did not run is shown as not compared, not as zero. A package's state at the first check is not an event. If the section cannot be built, the rest of the record is written without it.
- `GET /api/reputation/{target}`: `source.record_page` and `source.record_json` link Lowdown's record page for the resolved Registry entry when one exists (`https://petshopbros.github.io/lowdown-pages/`, entries whose declared package is deprecated, yanked, inactive or answers 404). The page list is read from `servers.json` and cached for 6 hours; if it cannot be read, the response is unchanged and has no page link.
- `GET /api/reputation/{target}`: `pypi.not_found_kind` separates a PyPI 404 for a project that PyPI lists but that has no release (`no_releases`) from a name with no PyPI project (`no_project`), and the first sentence says which. An archived PyPI project is now stated in the first sentence as well. The PyPI snapshot records the Index API's answer (`pypi_package_state.index_status`, `supabase/pypi_packages.sql`) and no longer keeps the previous project status when the Index API answers 404.
- `GET /api/reputation/{target}`: PyPI packages in `packages`. Each declared PyPI package carries a `pypi` block with the latest version, `latest_yanked` (that version only), `project_status` (PEP 792), `latest_uploaded`, `declared_is_latest`, `not_found_since` and up to 5 changes in the last 30 days, from the daily PyPI snapshot. A yanked latest version, a quarantined or deprecated project, or an HTTP 404 is stated in the first sentence; new versions are listed only in the history. `pypi:<package>` lookups work like `npm:<package>`: one declaring Registry entry answers directly, several are returned as `registry_candidates` and none is picked, none says so by name. PyPI names are compared after PEP 503 normalization. `packages_note` describes only the package types present. A failure reading PyPI state does not affect the npm part of the answer.
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
- Daily runs start on time: the sandbox server starts the `scanner`, `npm` and `pypi` workflows at their set times through GitHub's `workflow_dispatch` API (`daily=true`, shown as `<name> daily (dispatch)`), because GitHub's scheduled runs started 4–5.5 hours late. The workflows' own schedules stay as a backup and do nothing when the day's run is already done. `sandbox-watchdog.yml` also checks that each daily run started within an hour of its time. (`sandbox/dispatch.sh`, `sandbox/dispatch-setup.sh`, `sandbox/systemd/lowdown-dispatch*`)
- Daily record: on a day when the Registry list was not received in full (the Scanner fell back to the previous run's addresses), the Registry section is marked `"compared": false` with a reason instead of showing zero changes, and the next compared day carries `covers_since`. Past days stay locked except for listed corrections, which are written into the day's JSON (`corrections`) and shown on its page. 2026-10-23 is corrected this way. A scheduled Scanner run that falls back now opens an issue.
- Scanner workflow: the Registry list time limit is 1200 seconds (was 480); the list had grown to 491 pages.
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
