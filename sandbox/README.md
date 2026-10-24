# Lowdown stdio sandbox

Lowdown Scanner probes remote (`streamable-http`) servers. The sandbox covers the other half of the official MCP Registry: servers declared as **npm packages with `stdio` transport**. It installs each package in an isolated container, starts it, and sends `initialize` and `tools/list` only. It never calls a tool.

It runs on a separate, disposable server. It does not run on GitHub Actions.

## What is recorded

For each `npm:<package>@<version>`:

- how far the server answered: `outcome` and `reached_level` (0 = no `initialize` answer, 1 = `initialize`, 2 = `tools/list`)
- exit code or signal when the process ended early, timings
- the same fields the remote Scanner records: capabilities, protocol version, server version, tool count, `schema_hash`, `desc_hash`, `names_hash`, `tool_set_hash`
- full tool definitions go to the same private tables as the Scanner (`scanner_tool_defs`, `scanner_tool_set_versions`)

Packages are installed with `--ignore-scripts`, so `preinstall`/`install`/`postinstall` scripts never run. When a package declares one, `metadata.install_scripts` is `true`; a package that downloads its binary in such a script will not start here, and the record says why it may not have.

Not recorded: stderr or log text (byte count only), anything the package prints that is not JSON-RPC (line count only).

The server is started the way its Registry entry says to start it: the fixed values of its declared `packageArguments` (for example `mcp` or `--stdio`) are passed. Secret arguments, template values and required arguments without a fixed value are not passed; their count is recorded (`args_unsatisfied`). It gets **no environment variables, no credentials, and no network**; the number of declared required and secret environment variables is recorded. A server that needs an API key or a network connection at startup records that fact (`exited`, `init_error`, ...). These are observations of one start under these conditions, not judgments. Each run row keeps the exact arguments used (`args`) and the Registry entry they came from (`registry_name`).

### Which versions

For every Registry entry whose package line is `npm <package> <version> stdio`:

1. the declared version, when it is an exact version (`declared`)
2. npm's current `latest` (`npm_latest`), which is what `npx -y <package>` would run

Equal versions are merged. Each `package@version` runs once (transient failures are retried; see below). Newest changes first.

### Outcomes

| outcome | meaning | retried |
|---|---|---|
| `ok` | answered `initialize` and `tools/list` | no |
| `install_not_found` | npm E404 | no |
| `install_version_not_found` | npm ETARGET / ENOVERSIONS, also after one more try with `--prefer-online` in the same run | no |
| `install_failed` | other npm error (`install_error_code`) | no |
| `install_timeout` | install over 180 s | 2 tries |
| `install_network` | network or registry error | 3 tries |
| `no_bin` | the package declares no executable | no |
| `bin_ambiguous` | several executables, none named like the package (npx can't choose either) | no |
| `exited` | process ended before answering `initialize` | no |
| `init_timeout` | no `initialize` answer in 30 s | 2 tries |
| `init_error` / `init_invalid` | JSON-RPC error / not a result object | no |
| `exited_after_init` | ended before answering `tools/list` | no |
| `list_timeout` / `list_error` / `list_invalid` | `tools/list` not answered in 15 s / error / no tools array | no |
| `output_limit` | stdout over 4 MB | no |
| `runner_error` | our side (Docker) | 3 tries |

## Isolation

| | install container | run container |
|---|---|---|
| runtime | gVisor (`runsc`) | gVisor (`runsc`) |
| network | bridge, egress limited (below) | none |
| package code executed | no (`npm install --ignore-scripts`) | yes |
| filesystem | read-only root, `/work` (this package only), `/cache` (npm cache) | read-only root, `/work` read-only, 64 MB `/tmp` |
| user | uid 10001, all capabilities dropped, `no-new-privileges` | same |
| limits | 1 GB memory, 1 CPU, 256 pids, 180 s | 512 MB memory, 1 CPU, 128 pids, `timeout -s KILL` inside the container |
| environment | `HOME=/tmp` and npm settings | `HOME=/tmp` only |
| arguments | package spec only | fixed values of declared `packageArguments` |

Egress from containers (`egress.sh`): DNS to the host's resolver is allowed; cloud metadata (169.254.0.0/16), private ranges and the host itself are dropped. `--self-test` checks all of this before the first run.

The database key lives only in `/etc/lowdown/sandbox.env` (root, 600) and in the runner process. Containers receive no key. Use a dedicated Supabase secret key for this server so it can be deleted alone. Supabase secret keys are not scoped (each has full access), so the key is kept out of every container.

## Server

Ubuntu 24.04, 2 GB RAM, 2 vCPU. Nothing on the server is state worth keeping: results are written to Supabase as they come in. To rebuild, create a new server, clone this repo and run `setup.sh`.

```bash
sudo git clone https://github.com/PetShopBros/lowdown-proxy /opt/lowdown/lowdown-proxy
sudo bash /opt/lowdown/lowdown-proxy/sandbox/setup.sh
```

`setup.sh` prints the remaining steps: key, SQL (`supabase/sandbox.sql`), `--self-test`, `--plan`, a first run of 10, then the daily timer (06:47 KST).

Defaults: 2 targets at a time, up to 400 per day, 4 h budget. npm requests go through a shared cache with `--prefer-offline`. When an install answers ETARGET/ENOVERSIONS, the cached package information may predate the version, so the install is tried once more with `--prefer-online` and `metadata.install_retry` is `prefer_online`. Runs before runner 0.2.2 did not do this.

## Monitoring

- `sandbox_batches`: one row per run (start, end, outcome counts, note)
- `.github/workflows/sandbox-watchdog.yml`: opens an issue when no run started in 36 h
- AWS budget alert (USD 15/month)

Stop: `sudo systemctl disable --now lowdown-sandbox.timer`. Delete the server at any time; nothing is lost.

## On-time start of GitHub workflows

GitHub's scheduled runs (`schedule`) can start hours late or be dropped under load. This server also starts the daily `scanner`, `npm` and `pypi` workflows at their set times by calling GitHub's `workflow_dispatch` API with `daily=true`, the same as pressing **Run workflow**. The work still runs on GitHub Actions.

| timer | workflow | time |
|---|---|---|
| `lowdown-dispatch-scanner.timer` | `scanner.yml` | 01:17 UTC (10:17 KST) |
| `lowdown-dispatch-npm.timer` | `npm.yml` | 19:37 UTC (04:37 KST) |
| `lowdown-dispatch-pypi.timer` | `pypi.yml` | 20:37 UTC (05:37 KST) |

- The workflows keep their own schedules as a backup. A scheduled run does nothing when the day's work is already done (`scanner`: today's observations exist; `npm`/`pypi`: a `daily (dispatch)` run succeeded in the last 20 hours). If this server is down, the schedule runs as before.
- Token: a fine-grained token with access to this repository only and **Actions: Read and write**, in `/etc/lowdown/dispatch.env` (root, 600). It is read by systemd and used only by `dispatch.sh`, which runs as a temporary user; it never enters a container.
- Missed times are not caught up after a reboot (`Persistent=false`); the backup schedule covers that day.
- `sandbox-watchdog.yml` checks that each `daily (dispatch)` run was created within 5 minutes before to 60 minutes after its time, and opens an issue otherwise.

Install on an existing server: `sudo bash sandbox/dispatch-setup.sh` and follow its steps.

## Publication

Private for a 4-week pilot. Publication rules (API block, daily page section, radar rules) are decided after the pilot.
