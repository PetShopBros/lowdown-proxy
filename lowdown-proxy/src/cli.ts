#!/usr/bin/env node
import { runProxy } from "./proxy.js";

// 사용법: npx lowdown-proxy [--actor <id>] [--target <label>] [--source organic|seeded|synthetic] -- <command> [args...]
function parseArgs(argv: string[]) {
  const dashIndex = argv.indexOf("--");
  if (dashIndex === -1) {
    console.error(
      "사용법: lowdown-proxy [--actor <id>] [--target <label>] [--source organic|seeded|synthetic] -- <command> [args...]\n" +
      "예시:   lowdown-proxy -- npx some-mcp-server"
    );
    process.exit(1);
  }

  const flags = argv.slice(0, dashIndex);
  const commandParts = argv.slice(dashIndex + 1);

  if (commandParts.length === 0) {
    console.error("[lowdown] '--' 뒤에 실행할 명령어가 없습니다.");
    process.exit(1);
  }

  const getFlag = (name: string, fallback: string) => {
    const i = flags.indexOf(name);
    return i !== -1 && flags[i + 1] ? flags[i + 1] : fallback;
  };

  return {
    actor: getFlag("--actor", "anonymous"),
    targetLabel: getFlag("--target", commandParts.join(" ")),
    source: getFlag("--source", "organic") as "organic" | "seeded" | "synthetic",
    command: commandParts[0],
    args: commandParts.slice(1),
  };
}

const opts = parseArgs(process.argv.slice(2));
runProxy(opts);
