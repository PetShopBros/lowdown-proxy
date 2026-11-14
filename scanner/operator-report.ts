// 서버 운영자용 1쪽 관측 요약 — <outDir>/operator-<ns>__<name>-YYYY-MM-DD.md
// 사용: node scanner/operator-report.ts <mcp:ns/name | ns/name> [outDir]   (outDir 기본값 out)
// 공개 조회 API 만 읽는다(환경변수·키 필요 없음). 접두어 없는 이름으로 조회해 미리 만든 서버 카드가 아닌 실시간 계산을 받는다.
// User-Agent 는 lowdown-test/… → access_daily 에서 Lowdown 자신(self)으로 빠진다.
// 보내기 전에 이반이 내용을 읽고 직접 보낸다. 받는 사람 정보는 이 스크립트와 파일에 넣지 않는다.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SITE, registryName, renderOperatorReport } from './operator-report-lib.ts';

function fail(message: string): never {
  console.error(`::error::${message}`);
  process.exit(1);
}

async function main(): Promise<void> {
  const [input, outDir = 'out'] = process.argv.slice(2);
  if (!input) fail('사용법: node scanner/operator-report.ts <mcp:ns/name | ns/name> [outDir]');
  const name = registryName(input);
  if (!name) fail(`MCP Registry 이름 형식이 아닙니다: ${input}`);

  const url = `${SITE}/api/reputation/${name}?nc=1`;
  const res = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': 'lowdown-test/operator-report' }, signal: AbortSignal.timeout(60_000) });
  const text = await res.text();
  if (!res.ok) fail(`조회 실패: HTTP ${res.status} ${text.slice(0, 300)}`);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    fail('조회 응답이 JSON 이 아닙니다.');
  }
  if (res.headers.get('x-lowdown-card')) console.warn('::warning:: 미리 만든 서버 카드가 응답했습니다(since·history_30d 가 없을 수 있음).');

  const day = new Date().toISOString().slice(0, 10);
  const md = renderOperatorReport({ response: body, day });
  mkdirSync(outDir, { recursive: true });
  const file = join(outDir, `operator-${name.replace('/', '__')}-${day}.md`);
  writeFileSync(file, md);
  console.log(`${file} written (${md.split('\n').length} lines)`);
}

main().catch((e) => fail(e instanceof Error ? e.message : String(e)));
