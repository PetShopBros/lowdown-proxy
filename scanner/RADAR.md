# Lowdown radar

The radar marks notable facts in Lowdown's own daily records with fixed rules: a package that became deprecated or disappeared, or a tool definition that changed after a long stable period. Each record names the rule and the values that matched it. There are no scores, rankings or verdicts.

## Status

- Recorded daily since 2026-10-26 with rule_version 1. `P3` has been recorded since 2026-10-29.
- Package rules cover the npm and PyPI packages declared in the official MCP Registry (daily package snapshots). Tool-definition rules cover the fixed cohort of 10,000 remote servers observed every day.
- Results are recorded privately. They are not part of Lowdown's public dataset (CC BY 4.0), and the lookup API and the MCP tools do not return them. They will be offered separately later.
- To ask about access, [open an issue](https://github.com/PetShopBros/lowdown-proxy/issues).

This page is the specification: what each rule means, what it reads, and how a record is written.

## Package rules

Inputs: Lowdown's daily npm and PyPI package snapshots and the Registry declarations. Only a change shown by the package registry itself counts.

| Rule | Recorded when |
|---|---|
| `P1_npm_deprecated` | the npm `latest` version newly carries a deprecated mark |
| `P2_npm_not_found` | an npm package that existed now returns 404 |
| `P3_npm_release_after_dormancy` | a new npm `latest` appears and the package's previous modification time, as recorded the day before, is at least 180 days earlier |
| `P4_pypi_archived` | the PyPI project status changes to `archived` or `quarantined` |
| `P5_pypi_latest_yanked` | the latest PyPI release is yanked |
| `P6_pypi_not_found` | a PyPI project that existed now returns 404 |
| `P7_declared_missing_package` | a package newly declared in the Registry already returns 404 the first time Lowdown checks it (the first full check is excluded) |

A state that was already present when Lowdown first checked a package is not recorded, except for `P7`.

## Tool-definition rules

Inputs: Lowdown's daily `initialize` and `tools/list` observations of the fixed cohort (servers that answered `tools/list`).

- Comparison unit: the last observation of each day for the same server and remote address.
- A definition changed when the schema hash or the description hash differs, or when both days have a tool-name hash and it differs.
- A change on day D is recorded only when the next observation still shows the changed definition. This costs one day and removes values that flip back or change every day.

| Rule | Recorded when |
|---|---|
| `R1_first_change_after_stable` | the definition was unchanged in at least the previous 7 comparisons and then changed, and the declared server version also changed or is unknown |
| `R2_changed_same_server_version` | as `R1`, but the declared server version stayed the same (never recorded together with `R1`) |
| `R3_tool_removed` | the set of tool names changed and the tool count went down |

A server with several remote addresses gets one record per rule per day; the number of remotes that changed is part of the evidence.

## Records

| Field | Meaning |
|---|---|
| `day` | the UTC day the matched fact belongs to |
| `rule_id`, `rule_version` | which rule, in which version |
| `subject_kind` | `npm`, `pypi` or `server` |
| `subject` | package name (PyPI names normalized per PEP 503) or Registry server name |
| `group_key` | npm scope or Registry namespace, used to group same-day records of one publisher |
| `evidence` | the values that matched the rule, such as versions, day counts or tool counts. No hashes, remote addresses, descriptions or other raw text |

## Reading a record

- A record is a fact under the conditions above. It is not a judgment of the package, the server or its operator.
- A tool definition change can be a normal update. `R2` says only that the definition changed while the declared version did not.
- No record does not mean nothing happened: package rules see only what the registries show, and tool-definition rules see only the fixed cohort.
- The same inputs give the same records. When a rule changes, its `rule_version` goes up and earlier records stay as they were.

## Code

- Package rules: [`scanner/notable-lib.ts`](https://github.com/PetShopBros/lowdown-proxy/blob/main/scanner/notable-lib.ts), [`supabase/2026-10-29_scanner_notable.sql`](https://github.com/PetShopBros/lowdown-proxy/blob/main/supabase/2026-10-29_scanner_notable.sql)
- Tool-definition rules: [`scanner/notable-tools-lib.ts`](https://github.com/PetShopBros/lowdown-proxy/blob/main/scanner/notable-tools-lib.ts), [`supabase/2026-10-29_scanner_notable_tools.sql`](https://github.com/PetShopBros/lowdown-proxy/blob/main/supabase/2026-10-29_scanner_notable_tools.sql)
