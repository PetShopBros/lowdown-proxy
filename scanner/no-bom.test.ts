import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { test } from 'node:test';

// 레포 텍스트 파일에 UTF-8 BOM(EF BB BF)이 없어야 한다.
// 계기: 편집기 저장으로 vercel.json 맨 앞에 BOM 이 붙어 Vercel 배포가 Error(2026-10-31 of1r5qmbh, 2026-11-01 4grqxdosj).
// PowerShell 5 의 Set-Content -Encoding UTF8 / Out-File 도 BOM 을 붙인다 → [IO.File]::WriteAllText(..., UTF8Encoding $false) 사용.

const ROOT = join(import.meta.dirname, '..');
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', '.vercel']);
const TEXT = /\.(ts|js|mjs|cjs|json|md|txt|ya?ml|sql|sh|html|css|py|toml)$|^\.(editorconfig|gitignore|env\.example)$/;

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (st.isFile() && TEXT.test(name) && st.size < 5_000_000) out.push(p);
  }
}

test('레포 텍스트 파일에 UTF-8 BOM 이 없다', () => {
  const files: string[] = [];
  walk(ROOT, files);
  assert.ok(files.some((f) => f.endsWith('vercel.json')), 'vercel.json 을 검사 대상에 포함');
  const bom = files.filter((f) => {
    const b = readFileSync(f).subarray(0, 3);
    return b.length === 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf;
  }).map((f) => relative(ROOT, f));
  assert.deepEqual(bom, [], `BOM 이 있는 파일: ${bom.join(', ')} — BOM 없는 UTF-8 로 다시 저장`);
});
