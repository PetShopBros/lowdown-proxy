#!/usr/bin/env node
// 테스트·self-test 용 가짜 stdio MCP 서버 (의존성 없음)
// 동작은 첫 인자 또는 실행 파일 이름으로 정한다:
//   ok | exit | silent | init-error | junk | request | crash-after-init | flood | list-error
//   lowdown-selftest → ok
//   lowdown-netcheck → 바깥(1.1.1.1:443)에 연결되면 즉시 종료(42). 막혀 있으면 ok 처럼 응답(도구 이름 net_blocked)
import { connect } from 'node:net';
import { basename } from 'node:path';

const bin = basename(process.argv[1] ?? '');
const mode = process.argv[2] ?? (bin === 'lowdown-netcheck' ? 'netcheck' : 'ok');

const send = (m) => process.stdout.write(`${JSON.stringify(m)}\n`);
const tools = [
  { name: 'echo', description: 'Echo text', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } },
  { name: mode === 'netcheck' ? 'net_blocked' : 'add', description: 'Add numbers', inputSchema: { type: 'object' } },
];

let serving = false;
function serve() {
  if (serving) return;
  serving = true;
  let buf = '';
  let initialized = false;
  process.stdin.on('data', (c) => {
    buf += c.toString('utf8');
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      const m = JSON.parse(line);
      if (m.method === 'initialize') {
        if (mode === 'silent') continue;
        if (mode === 'init-error') {
          send({ jsonrpc: '2.0', id: m.id, error: { code: -32000, message: 'missing API_KEY' } });
          continue;
        }
        if (mode === 'junk') process.stdout.write('Server starting on stdio...\nnot json {\n');
        if (mode === 'request') send({ jsonrpc: '2.0', id: 'srv-1', method: 'roots/list' });
        if (mode === 'flood') {
          const big = 'x'.repeat(1 << 20);
          for (let i = 0; i < 8; i++) process.stdout.write(`${big}\n`);
        }
        send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {}, logging: {} }, serverInfo: { name: 'fake', version: '1.2.3' } } });
      } else if (m.method === 'notifications/initialized') {
        initialized = true;
      } else if (m.method === 'tools/list') {
        if (mode === 'crash-after-init') process.exit(7);
        if (mode === 'list-error') send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'no tools' } });
        else send({ jsonrpc: '2.0', id: m.id, result: { tools } });
      } else if (m.id === 'srv-1') {
        // 클라이언트가 우리 요청에 답했다(오류여야 정상)
      }
    }
  });
  process.stdin.on('end', () => process.exit(0));
  void initialized;
}

if (mode === 'exit') {
  process.stderr.write('Error: API key required\n');
  process.exit(3);
} else if (mode === 'netcheck') {
  const sock = connect({ host: '1.1.1.1', port: 443, timeout: 3000 });
  sock.on('connect', () => process.exit(42));
  sock.on('timeout', () => {
    sock.destroy();
    serve();
  });
  sock.on('error', () => serve());
} else {
  serve();
}
