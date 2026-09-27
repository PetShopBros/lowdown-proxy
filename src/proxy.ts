import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { recordInteraction, type InteractionRecord } from "./supabase.js";
import { getNodeId } from "./node-identity.js";

interface PendingCall {
  method: string;
  toolName?: string;
  startedAt: number;
}

interface ProxyOptions {
  command: string;
  args: string[];
  actor: string;      // 이 프록시를 호출하는 클라이언트를 식별할 라벨
  targetLabel: string; // 이 프록시가 감싸는 MCP 서버를 식별할 라벨 (target)
  source: "organic" | "seeded" | "synthetic";
}

/**
 * lowdown-proxy 핵심 로직.
 *
 * 설계 원칙 (lowdown-brief.md 참고):
 * - 패스스루가 최우선. 기록 로직이 통신을 막거나 지연시켜선 안 된다.
 * - "무슨 일이 일어났는가"만 기록한다(Interaction 레이어). 품질 판단(Opinion)은 v0 범위 밖.
 * - tool_execution 성공(JSON-RPC 에러 없음)과 실제 결과 품질은 다른 문제 — v0는 전자만 다룬다.
 */
export function runProxy(opts: ProxyOptions): void {
  const nodeId = getNodeId();
  const child = spawn(opts.command, opts.args, {
    stdio: ["pipe", "pipe", "inherit"], // stderr는 그대로 상위로 흘려보냄(디버깅용)
    shell: process.platform === "win32",
  });

  const pending = new Map<string | number, PendingCall>();

  // ── Client(부모 프로세스의 stdin) → Server(child.stdin) ──
  // 요청을 가로채서 tools/call이면 pending에 기록해두고, 그대로 통과시킴
  const clientReader = createInterface({ input: process.stdin });
  clientReader.on("line", (line) => {
    // 항상 먼저 그대로 전달 — 파싱 실패해도 패스스루는 깨지면 안 됨
    child.stdin.write(line + "\n");

    try {
      const msg = JSON.parse(line);
      if (msg?.id !== undefined && msg?.method) {
        pending.set(msg.id, {
          method: msg.method,
          toolName: msg.method === "tools/call" ? msg.params?.name : undefined,
          startedAt: Date.now(),
        });
      }
    } catch {
      // JSON이 아니거나 파싱 실패 — 무시하고 패스스루만 유지
    }
  });

  // ── Server(child.stdout) → Client(부모 프로세스의 stdout) ──
  // 응답을 가로채서 pending과 매칭되면 interaction 기록, 그대로 통과시킴
  const serverReader = createInterface({ input: child.stdout });
  serverReader.on("line", (line) => {
    process.stdout.write(line + "\n");

    try {
      const msg = JSON.parse(line);
      if (msg?.id !== undefined && pending.has(msg.id)) {
        const call = pending.get(msg.id)!;
        pending.delete(msg.id);

        const latency_ms = Date.now() - call.startedAt;
        const outcome: InteractionRecord["outcome"] = msg.error
          ? "failure"
          : "success";

        let failure_type: InteractionRecord["failure_type"] | undefined;
        if (msg.error) {
          const code = msg.error?.code;
          const message: string = msg.error?.message ?? "";
          if (code === -32602) failure_type = "invalid_arguments";
          else if (message.toLowerCase().includes("timeout")) failure_type = "timeout";
          else if (code === -32603) failure_type = "server_error";
          else if (code === -32000) failure_type = "tool_error";
          else failure_type = "unknown";
        }

        const record: InteractionRecord = {
          actor: opts.actor,
          target: opts.targetLabel,
          target_type: "tool",
          task_type: call.toolName ?? call.method,
          outcome,
          failure_type,
          latency_ms,
          source: opts.source,
          node_id: nodeId,
        };

        // fire-and-forget — 응답 전달을 기다리게 하지 않음
        void recordInteraction(record);
      }
    } catch {
      // 무시, 패스스루 유지
    }
  });

  child.on("exit", (code) => {
    process.exit(code ?? 0);
  });

  process.on("SIGINT", () => child.kill("SIGINT"));
  process.on("SIGTERM", () => child.kill("SIGTERM"));
}
