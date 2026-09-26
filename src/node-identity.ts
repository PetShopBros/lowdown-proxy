import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

interface NodeIdentity {
  node_id: string;
  created_at: string;
}

export function getNodeId(): string {
  const dir = join(homedir(), ".lowdown");
  const file = join(dir, "node.json");

  if (existsSync(file)) {
    try {
      const data = JSON.parse(readFileSync(file, "utf-8")) as NodeIdentity;
      if (data.node_id) return data.node_id;
    } catch {
      // 파일 손상 시 새로 생성
    }
  }

  const identity: NodeIdentity = {
    node_id: "ld_" + randomUUID().replace(/-/g, "").slice(0, 12),
    created_at: new Date().toISOString(),
  };

  mkdirSync(dir, { recursive: true });
  writeFileSync(file, JSON.stringify(identity, null, 2), "utf-8");

  return identity.node_id;
}