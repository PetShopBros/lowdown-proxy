const BASE_URL = "https://lowdown-proxy.vercel.app";

const tools = [
  { target: "mcp:modelcontextprotocol/brave-search", task_types: ["web_search", "news_search"], target_type: "tool" },
  { target: "mcp:modelcontextprotocol/fetch",        task_types: ["fetch_url", "web_scrape"],   target_type: "tool" },
  { target: "mcp:modelcontextprotocol/filesystem",   task_types: ["file_read", "file_write"],   target_type: "tool" },
  { target: "mcp:modelcontextprotocol/github",       task_types: ["code_search", "pr_review"],  target_type: "tool" },
  { target: "mcp:modelcontextprotocol/postgres",     task_types: ["db_query", "db_write"],      target_type: "tool" },
  { target: "api:deepseek/deepseek-chat",            task_types: ["code_gen", "text_gen", "summarize"], target_type: "service" },
];

const actors = ["agent:lowdown-seed", "agent:sazubti-bot", "agent:tammi-bot"];

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

function randomOutcome() {
  const r = Math.random();
  if (r < 0.75) return "success";
  if (r < 0.88) return "partial";
  return "failure";
}

function randomLatency(tool) {
  // deepseek는 LLM이라 latency 더 높게
  if (tool.includes("deepseek")) return 800 + Math.floor(Math.random() * 3000);
  return 80 + Math.floor(Math.random() * 500);
}

async function sendOne(record) {
  const res = await fetch(`${BASE_URL}/api/interactions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(record),
  });
  return res.ok;
}

async function main() {
  const PER_TOOL = 30;
  let ok = 0, fail = 0;

  for (const tool of tools) {
    for (let i = 0; i < PER_TOOL; i++) {
      const record = {
        actor: pick(actors),
        target: tool.target,
        target_type: tool.target_type,
        task_type: pick(tool.task_types),
        outcome: randomOutcome(),
        latency_ms: randomLatency(tool.target),
        source: "synthetic",
      };
      const success = await sendOne(record);
      if (success) ok++; else fail++;
      process.stdout.write(`\r진행: ${ok + fail}/${tools.length * PER_TOOL} (성공 ${ok}, 실패 ${fail})`);
    }
  }

  console.log(`\n완료: 총 ${ok}건 기록, ${fail}건 실패`);
}

main().catch(console.error);
