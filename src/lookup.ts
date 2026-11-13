import { apiBaseUrl, RECORDER_VERSION } from "./record.js";
import { getNodeId } from "./node-identity.js";

/**
 * 연결 시점 확인 (0.1.22, 2026-11-14).
 *
 * 프록시가 감싼 서버를 Lowdown 기록에서 찾아(install-check), 그 서버의 initialize 응답에
 *  - result.instructions 끝에 한 줄(날짜가 붙은 관측 사실 + 기록 주소)
 *  - result._meta["io.github.petshopbros.lowdown/install-check"] 에 구조화된 값
 * 을 붙인다. 막지 않는다: 조회는 서버 시작과 동시에 시작하고, 정해진 시간(기본 0.8초) 안에 오지 않으면 그냥 지나간다.
 * 도구 설명·도구 결과는 바꾸지 않는다. LOWDOWN_LOOKUP=0 이면 조회하지 않는다.
 * 점수·판정은 넣지 않는다. 기록이 없으면 아무것도 붙이지 않는다(기록 없음은 문제 없음이 아니다).
 */

export const META_KEY = "io.github.petshopbros.lowdown/install-check";
export const LOOKUP_BUDGET_MS = 800;
const MAX_MESSAGE = 500;
const SITE = "https://lowdown-proxy.vercel.app/";

const NPM_NAME = /^(?:@[A-Za-z0-9~-][A-Za-z0-9._~-]*\/)?[A-Za-z0-9~-][A-Za-z0-9._~-]*$/;
const PYPI_NAME = /^([A-Za-z0-9]|[A-Za-z0-9][A-Za-z0-9._-]*[A-Za-z0-9])$/;
const MCP_TARGET = /^mcp:[A-Za-z0-9._~-]{1,200}\/[A-Za-z0-9._~-]{1,200}$/;
const EXPLICIT = /^(mcp|npm|pypi):\S{1,300}$/;

export function lookupEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.LOWDOWN_LOOKUP !== "0";
}

// 실행기별: 값을 받는 옵션(다음 토큰을 건너뜀)과 패키지를 지정하는 옵션
const NPM_RUNNERS = new Set(["npx", "npx.cmd", "bunx", "bunx.cmd", "pnpx", "pnpx.cmd"]);
const NPM_PKG_FLAGS = new Set(["-p", "--package"]);
const NPM_VALUE_FLAGS = new Set(["--registry", "--cache", "--userconfig", "-w", "--workspace", "--node-options", "--prefix"]);
const NPM_STOP_FLAGS = new Set(["-c", "--call"]);
const PYPI_PKG_FLAGS = new Set(["--from"]);
const PYPI_VALUE_FLAGS = new Set(["--with", "--with-editable", "--with-requirements", "--python", "-p", "--index", "--index-url", "--extra-index-url", "--default-index", "--constraints", "--overrides", "-c", "--directory", "--project", "--cache-dir", "--env-file"]);

function base(tok: string): string {
  return (tok.split(/[\\/]/).pop() ?? tok).toLowerCase();
}

function npmName(spec: string): string | null {
  if (/[\\:]/.test(spec) || spec.startsWith(".") || spec.startsWith("/")) return null;
  let name = spec;
  if (spec.startsWith("@")) {
    const at = spec.indexOf("@", 1);
    if (at > 0) name = spec.slice(0, at);
  } else {
    const at = spec.indexOf("@");
    if (at > 0) name = spec.slice(0, at);
  }
  return name.length <= 214 && NPM_NAME.test(name) ? name : null;
}

function pypiName(spec: string): string | null {
  if (/[\\/:]/.test(spec) || spec.startsWith(".")) return null;
  const name = spec.split(/==|>=|<=|~=|!=|@|\[|<|>/)[0]!.trim();
  return name.length <= 200 && PYPI_NAME.test(name) ? name : null;
}

/** 실행기 다음 토큰들에서 패키지 하나. 값을 받는 옵션은 건너뛴다. */
function packageAfter(tokens: string[], pkgFlags: Set<string>, valueFlags: Set<string>, stopFlags: Set<string>): string | null {
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t === "--") return tokens[i + 1] ?? null;
    if (stopFlags.has(t)) return null;
    const eq = t.indexOf("=");
    const flag = t.startsWith("-") && eq > 0 ? t.slice(0, eq) : t;
    if (pkgFlags.has(flag)) return eq > 0 && t.startsWith("-") ? t.slice(eq + 1) : tokens[i + 1] ?? null;
    if (valueFlags.has(flag)) {
      if (!(t.startsWith("-") && eq > 0)) i++;
      continue;
    }
    if (t.startsWith("-")) continue;
    return t;
  }
  return null;
}

/**
 * 감싼 명령에서 조회 대상. --target 이 mcp:/npm:/pypi: 형식이면 그것을, 아니면
 * npx·bunx·pnpx·npm exec·pnpm dlx·yarn dlx → npm:<패키지>, uvx·uv tool run·pipx run → pypi:<패키지>.
 * 그 밖(node 스크립트, python -m, docker …)은 null — 추측하지 않는다.
 */
export function inferLookupTarget(command: string, args: string[], explicitTarget?: string): string | null {
  if (explicitTarget && EXPLICIT.test(explicitTarget)) return explicitTarget;
  let tokens = [command, ...args];
  while (tokens.length && (["cmd", "cmd.exe"].includes(base(tokens[0]!)) || tokens[0]!.toLowerCase() === "/c")) tokens = tokens.slice(1);
  if (!tokens.length) return null;
  const head = base(tokens[0]!);
  const rest = tokens.slice(1);
  let eco: "npm" | "pypi" | null = null;
  let after: string[] = [];
  if (NPM_RUNNERS.has(head)) { eco = "npm"; after = rest; }
  else if ((head === "npm" || head === "npm.cmd") && rest[0] === "exec") { eco = "npm"; after = rest.slice(1); }
  else if ((head === "pnpm" || head === "pnpm.cmd" || head === "yarn" || head === "yarn.cmd") && rest[0] === "dlx") { eco = "npm"; after = rest.slice(1); }
  else if (head === "uvx" || head === "uvx.exe") { eco = "pypi"; after = rest; }
  else if ((head === "uv" || head === "uv.exe") && rest[0] === "tool" && rest[1] === "run") { eco = "pypi"; after = rest.slice(2); }
  else if ((head === "pipx" || head === "pipx.exe") && rest[0] === "run") { eco = "pypi"; after = rest.slice(1); }
  if (!eco) return null;
  if (eco === "npm") {
    const spec = packageAfter(after, NPM_PKG_FLAGS, NPM_VALUE_FLAGS, NPM_STOP_FLAGS);
    const name = spec ? npmName(spec) : null;
    return name ? `npm:${name}` : null;
  }
  const spec = packageAfter(after, PYPI_PKG_FLAGS, PYPI_VALUE_FLAGS, new Set());
  const name = spec ? pypiName(spec) : null;
  return name ? `pypi:${name}` : null;
}

export interface Bundle {
  line: string;
  meta: Record<string, unknown>;
}

type Body = Record<string, any>;

function oneLine(s: string, max: number): string {
  const t = s.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2064\ufeff]/g, " ").replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

function packageFacts(packages: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(packages)) return [];
  const out: Array<Record<string, unknown>> = [];
  for (const p of packages.slice(0, 10)) {
    if (!p || typeof p !== "object") continue;
    const reg = (p as Body).registry;
    const name = typeof (p as Body).name === "string" ? (p as Body).name.slice(0, 214) : null;
    if (reg === "npm") {
      const n = (p as Body).npm;
      out.push({ registry: "npm", name, status: n && typeof n.status === "string" ? n.status : "not_checked", latest_deprecated: n?.latest_deprecated ?? null });
    } else if (reg === "pypi") {
      const n = (p as Body).pypi;
      out.push({ registry: "pypi", name, status: n && typeof n.status === "string" ? n.status : "not_checked", latest_yanked: n?.latest_yanked ?? null, project_status: n?.project_status ?? null });
    }
  }
  return out;
}

/**
 * install-check 응답 → 붙일 한 줄과 _meta. 확인된 Registry 이름(resolved_target)이 없으면 null.
 * 값은 응답에 있는 그대로(없으면 null) — 모름(null)과 확인 안 함(not_checked)을 섞지 않는다.
 */
export function bundleFrom(target: string, body: unknown, now = Date.now()): Bundle | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const b = body as Body;
  if (b.error) return null;
  const resolved = typeof b.resolved_target === "string" && MCP_TARGET.test(b.resolved_target) ? b.resolved_target : null;
  if (!resolved) return null;
  const src = b.source && typeof b.source === "object" ? (b.source as Body) : {};
  const citeUrl = typeof src.cite_url === "string" && src.cite_url.startsWith(SITE) && src.cite_url.length <= 500 ? src.cite_url : null;
  const lookupUrl = `${SITE}api/reputation/${resolved}?menu=install-check`;
  const message = typeof b.message === "string" ? oneLine(b.message, MAX_MESSAGE) : "";
  const line = `Lowdown install-check for ${resolved} (dated observations, not a score): ${message ? `${message} ` : ""}Record: ${citeUrl ?? lookupUrl}`;
  const observed = b.payment?.observed;
  const meta: Record<string, unknown> = {
    schema_version: 1,
    target,
    resolved_target: resolved,
    retrieved_at: new Date(now).toISOString(),
    summary: b.summary && typeof b.summary === "object" ? b.summary : null,
    payment_required: observed && typeof observed.payment_required === "boolean" ? observed.payment_required : null,
    payment_latest_check: observed && typeof observed.latest_check === "string" ? observed.latest_check : null,
    packages: packageFacts(b.packages),
    evidence_levels: Array.isArray(b.evidence_levels?.present) ? b.evidence_levels.present.filter((x: unknown) => typeof x === "string").slice(0, 10) : [],
    record_url: citeUrl,
    lookup_url: lookupUrl,
    note: "Observed by Lowdown; not a score. null means not observed or not known. Lowdown does not block or change this server's tools.",
  };
  return { line, meta };
}

/** install-check 조회. 실패·시간 초과·기록 없음이면 null. 절대 throw 하지 않는다. */
export async function fetchBundle(
  target: string,
  opts: { fetchImpl?: typeof fetch; timeoutMs?: number; now?: () => number } = {},
): Promise<Bundle | null> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? LOOKUP_BUDGET_MS);
  try {
    const res = await fetchImpl(`${apiBaseUrl()}/api/reputation/${encodeURIComponent(target)}?menu=install-check`, {
      headers: {
        "user-agent": `lowdown-proxy/${RECORDER_VERSION} (connect-check)`,
        "x-lowdown-source": "organic",
        "x-lowdown-node-id": getNodeId(),
      },
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    return bundleFrom(target, await res.json(), (opts.now ?? Date.now)());
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** 서버 → 클라이언트 initialize 응답 한 줄에 붙인다. 형식이 맞지 않으면 원래 줄 그대로. */
export function addBundleToInitialize(line: string, bundle: Bundle | null): string {
  if (!bundle) return line;
  try {
    const m = JSON.parse(line);
    if (!m || typeof m !== "object" || !m.result || typeof m.result !== "object" || Array.isArray(m.result)) return line;
    const prev = typeof m.result.instructions === "string" && m.result.instructions.length > 0 ? `${m.result.instructions}\n\n` : "";
    m.result.instructions = `${prev}${bundle.line}`;
    const meta = m.result._meta && typeof m.result._meta === "object" && !Array.isArray(m.result._meta) ? m.result._meta : {};
    m.result._meta = { ...meta, [META_KEY]: bundle.meta };
    return JSON.stringify(m);
  } catch {
    return line;
  }
}
