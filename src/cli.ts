#!/usr/bin/env node
import { runProxy } from "./proxy.js";
import { LogWatcher } from "./log-watch.js";

// 사용법:
//   npx lowdown-proxy                      → 인자 없음: Lowdown 조회용 MCP 서버(stdio) 시작 (Registry 설치 경로)
//   npx lowdown-proxy [--actor <id>] [--target <label>] [--source organic|seeded|synthetic] -- <command> [args...]
//                                          → MCP 서버를 감싸는 기록 프록시
function parseArgs(argv: string[]) {
  const dashIndex = argv.indexOf("--");
  if (dashIndex === -1) {
    console.error(
      "사용법: lowdown-proxy [--actor <id>] [--target <label>] [--source organic|seeded|synthetic] -- <command> [args...]\n" +
      "예시:   lowdown-proxy -- npx some-mcp-server\n" +
      "인자 없이 실행하면 Lowdown 조회용 MCP 서버가 시작됩니다."
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
  const getAll = (name: string) =>
    flags.flatMap((f, i) => (f === name && flags[i + 1] ? [flags[i + 1]] : []));
  const watchLogs = getAll("--watch-log");

  return {
    actor: getFlag("--actor", "anonymous"),
    targetLabel: getFlag("--target", commandParts.join(" ")),
    source: getFlag("--source", "organic") as "organic" | "seeded" | "synthetic",
    command: commandParts[0],
    args: commandParts.slice(1),
    logWatcher: watchLogs.length ? new LogWatcher(watchLogs, getFlag("--log-pattern", "")) : undefined,
  };
}

const argv = process.argv.slice(2);
if (argv.length === 0) {
  // MCP Registry 는 이 패키지를 인자 없이 실행한다 → 조회 도구(get_lowdown 등)를 제공하는 MCP 서버로 동작
  await import("./mcp-server.js");
} else {
  runProxy(parseArgs(argv));
}
