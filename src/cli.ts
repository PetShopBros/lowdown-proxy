#!/usr/bin/env node
import { runProxy } from "./proxy.js";
import { LogWatcher } from "./log-watch.js";
import { defaultTargetLabel } from "./classify.js";

// 사용법:
//   npx lowdown-proxy                      → 인자 없음: Lowdown 조회용 MCP 서버(stdio) 시작 (Registry 설치 경로)
//   npx lowdown-proxy [--actor <id>] [--target <label>] [--source organic|seeded|synthetic] [--test] -- <command> [args...]
//                                          → MCP 서버를 감싸는 기록 프록시
//   --test : 이 세션의 기록을 synthetic 으로 남긴다(일부러 실패시키는 테스트가 서버 실패로 집계되지 않게).
//   --target 이 없으면 명령줄 전체가 아니라 패키지/파일 이름 하나만 라벨로 쓴다(인자의 키·경로가 공개 기록에 남지 않게).
function parseArgs(argv: string[]) {
  const dashIndex = argv.indexOf("--");
  if (dashIndex === -1) {
    console.error(
      "사용법: lowdown-proxy [--actor <id>] [--target <label>] [--source organic|seeded|synthetic] [--test] -- <command> [args...]\n" +
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

  const sourceFlag = getFlag("--source", "organic");
  if (!["organic", "seeded", "synthetic"].includes(sourceFlag)) {
    console.error(`[lowdown] --source 는 organic|seeded|synthetic 중 하나여야 합니다: ${sourceFlag}`);
    process.exit(1);
  }
  const source = (flags.includes("--test") ? "synthetic" : sourceFlag) as "organic" | "seeded" | "synthetic";

  return {
    actor: getFlag("--actor", "anonymous"),
    targetLabel: getFlag("--target", defaultTargetLabel(commandParts[0], commandParts.slice(1))),
    source,
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
