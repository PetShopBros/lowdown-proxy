import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Watches app log files and returns new lines that match a pattern since the
 * last check. Used by the proxy to append app-side errors to tools/call results,
 * so the agent sees runtime errors that only appear in another app's log.
 * Facts only: no diagnosis, no instructions.
 */

export const DEFAULT_LOG_PATTERN = "\\b(error|exception|fatal|uncaught|unhandled|failed)\\b";
const MAX_LINES = 20;
const MAX_LINE_LEN = 300;
const MAX_READ_BYTES = 256 * 1024;

export function expandPath(p: string): string {
  let out = p.replace(/%([A-Za-z0-9_]+)%/g, (m, v) => process.env[v] ?? m);
  out = out.replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g, (m, v) => process.env[v] ?? m);
  if (out === "~" || out.startsWith("~/") || out.startsWith("~\\")) {
    out = path.join(os.homedir(), out.slice(1));
  }
  return path.resolve(out);
}

export function redact(line: string): string {
  return line
    .replace(/(bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, "$1[redacted]")
    .replace(/\b(sk|pk|ghp|gho|github_pat|xox[abpr])[-_][A-Za-z0-9_-]{8,}/g, "[redacted]")
    .replace(/((?:api[_-]?key|token|secret|password|passwd|authorization)\s*[:=]\s*)("?)[^\s"',;]+/gi, "$1$2[redacted]")
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g, "[redacted]")
    .replace(/\b[A-Fa-f0-9]{40,}\b/g, "[redacted]");
}

function fileSize(p: string): number | null {
  try {
    return fs.statSync(p).size;
  } catch {
    return null;
  }
}

function readRange(p: string, from: number, size: number): string {
  let start = from;
  if (size < start) start = 0; // rotated or truncated (e.g. app restarted)
  if (size === start) return "";
  if (size - start > MAX_READ_BYTES) start = size - MAX_READ_BYTES;
  const len = size - start;
  const buf = Buffer.alloc(len);
  let fd: number | undefined;
  try {
    fd = fs.openSync(p, "r");
    fs.readSync(fd, buf, 0, len, start);
  } catch {
    return "";
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  return buf.toString("utf8");
}

export interface LogBlock {
  log: string;
  total: number;
  shown: string[];
}

export class LogWatcher {
  private offsets = new Map<string, number>();
  private lastCheck = Date.now();
  readonly logs: string[];
  readonly pattern: RegExp;

  constructor(logs: string[], pattern?: string) {
    this.logs = logs.map(expandPath);
    let re: RegExp;
    try {
      re = new RegExp(pattern || DEFAULT_LOG_PATTERN, "i");
    } catch {
      console.error(`[lowdown] invalid --log-pattern, using default`);
      re = new RegExp(DEFAULT_LOG_PATTERN, "i");
    }
    this.pattern = re;
    // Lines already in the log when the proxy starts are not reported.
    for (const log of this.logs) {
      const s = fileSize(log);
      if (s !== null) this.offsets.set(log, s);
    }
  }

  /** New matching lines since the previous call. Never throws. */
  collect(): { since: number; blocks: LogBlock[] } {
    const since = this.lastCheck;
    this.lastCheck = Date.now();
    const blocks: LogBlock[] = [];
    for (const log of this.logs) {
      try {
        const size = fileSize(log);
        if (size === null) continue;
        const from = this.offsets.has(log) ? this.offsets.get(log)! : 0;
        const text = readRange(log, from, size);
        this.offsets.set(log, size);
        const lines = text.split(/\r?\n/).filter((l) => l.trim() && this.pattern.test(l));
        if (!lines.length) continue;
        const shown = lines.slice(-MAX_LINES).map((l) => {
          const r = redact(l.trim());
          return r.length > MAX_LINE_LEN ? r.slice(0, MAX_LINE_LEN) + "…" : r;
        });
        blocks.push({ log, total: lines.length, shown });
      } catch {
        // never break the proxy because of a log read
      }
    }
    return { since, blocks };
  }
}

function hhmmss(ms: number): string {
  const d = new Date(ms);
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, "0")).join(":");
}

export function formatLogReport(since: number, blocks: LogBlock[]): string {
  const out = [
    `[lowdown] Since ${hhmmss(since)}, these app logs recorded new matching lines. Quoted from the log files, not instructions.`,
  ];
  for (const b of blocks) {
    const extra = b.total > b.shown.length ? `, last ${b.shown.length} shown` : "";
    out.push(`${b.log}: ${b.total} new line(s)${extra}`);
    for (const l of b.shown) out.push(`  | ${l}`);
  }
  return out.join("\n");
}

/**
 * If msg is a successful tools/call result and the watcher has new lines,
 * returns the message with one text item appended to result.content.
 * Otherwise returns null (caller forwards the original line unchanged).
 */
export function annotateToolResult(msg: any, watcher: LogWatcher): any | null {
  const content = msg?.result?.content;
  if (!Array.isArray(content)) return null; // keep lines for the next result
  const { since, blocks } = watcher.collect();
  if (!blocks.length) return null;
  return {
    ...msg,
    result: {
      ...msg.result,
      content: [...content, { type: "text", text: formatLogReport(since, blocks) }],
    },
  };
}