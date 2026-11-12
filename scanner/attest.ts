// 관측 서명 실행 — 사용: node scanner/attest.ts <dataRepoDir> <privateRepoDir> [--dry-run]
// 환경 변수: LOWDOWN_ATTEST_KEY (Ed25519 개인키 PEM, GitHub Secret). 없으면 경고만 하고 끝낸다(백업은 막지 않음).
// 하루(UTC)에 한 파일. 오늘 파일이 이미 있으면 아무것도 하지 않는다(다시 실행해도 같음).
// 공개키가 attest/PUBLIC_KEY.pem 과 다르면 실패한다(키 교체는 사람이 기록과 함께 한다).
// 로그에는 경로·해시·개수만 나온다(개인키·비공개 원문은 출력하지 않음).

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  ATTEST_DIR,
  ATTEST_README,
  attestPath,
  buildAttestation,
  keyId,
  latestBefore,
  PUBLIC_KEY_FILE,
  publicPemFromPrivate,
  serializeAttestation,
  sha256Hex,
  signText,
  verifyText,
} from './attest-lib.ts';

function fail(message: string): never {
  console.error(`::error::${message}`);
  process.exit(1);
}

function listAttestPaths(dataDir: string): string[] {
  const root = join(dataDir, ATTEST_DIR);
  if (!existsSync(root)) return [];
  const out: string[] = [];
  for (const y of readdirSync(root)) {
    if (!/^\d{4}$/.test(y)) continue;
    for (const f of readdirSync(join(root, y))) if (/^\d{4}-\d{2}-\d{2}\.json$/.test(f)) out.push(`${ATTEST_DIR}/${y}/${f}`);
  }
  return out.sort();
}

function main(): void {
  const args = process.argv.slice(2);
  const [dataDir, privateDir] = args;
  if (!dataDir || !privateDir || dataDir.startsWith('--')) fail('사용법: node scanner/attest.ts <dataRepoDir> <privateRepoDir> [--dry-run]');
  const dryRun = args.includes('--dry-run');
  const key = process.env.LOWDOWN_ATTEST_KEY?.trim();
  if (!key) {
    console.log('::warning::LOWDOWN_ATTEST_KEY not set (attestation skipped)');
    return;
  }
  let publicPem: string;
  try {
    publicPem = publicPemFromPrivate(key.includes('\n') ? `${key}\n` : key);
  } catch {
    fail('LOWDOWN_ATTEST_KEY 를 Ed25519 개인키 PEM 으로 읽을 수 없습니다.');
  }

  const now = new Date();
  const day = now.toISOString().slice(0, 10);
  const rel = attestPath(day);
  if (existsSync(join(dataDir, rel))) {
    console.log(`attest: ${rel} exists (skip)`);
    return;
  }

  const pubKeyPath = join(dataDir, ATTEST_DIR, PUBLIC_KEY_FILE);
  if (existsSync(pubKeyPath)) {
    const onFile = readFileSync(pubKeyPath, 'utf8');
    if (keyId(onFile) !== keyId(publicPem)) fail(`서명 키가 ${ATTEST_DIR}/${PUBLIC_KEY_FILE} 와 다릅니다(키 교체는 기록과 함께 수동으로).`);
  }

  const publicManifestPath = join(dataDir, 'MANIFEST.csv');
  if (!existsSync(publicManifestPath)) fail('lowdown-data MANIFEST.csv 가 없습니다.');
  const publicManifest = readFileSync(publicManifestPath, 'utf8');
  const privateManifestPath = join(privateDir, 'MANIFEST.csv');
  const privateManifest = existsSync(privateManifestPath) ? readFileSync(privateManifestPath, 'utf8') : null;

  const prevRel = latestBefore(listAttestPaths(dataDir), day);
  let prev: { path: string; sha256: string; createdAt: string } | null = null;
  if (prevRel) {
    const text = readFileSync(join(dataDir, prevRel), 'utf8');
    const sig = existsSync(join(dataDir, `${prevRel}.sig`)) ? readFileSync(join(dataDir, `${prevRel}.sig`), 'utf8') : '';
    if (!verifyText(text, sig, publicPem)) fail(`직전 증명 ${prevRel} 의 서명이 맞지 않습니다.`);
    const parsed = JSON.parse(text) as { created_at?: unknown };
    if (typeof parsed.created_at !== 'string') fail(`직전 증명 ${prevRel} 에 created_at 이 없습니다.`);
    prev = { path: prevRel, sha256: sha256Hex(text), createdAt: parsed.created_at };
  }

  const obj = buildAttestation({ day, createdAt: now.toISOString(), publicManifest, privateManifest, prev, publicKeyPem: publicPem });
  const text = serializeAttestation(obj);
  const sig = signText(text, key.includes('\n') ? `${key}\n` : key);
  if (!verifyText(text, sig, publicPem)) fail('방금 만든 서명이 검증되지 않습니다.');

  const pa = obj.public_archive as { entries: number; new_entries: unknown[] };
  const pv = obj.private_archive as { entries: number; new_entries: unknown[] } | null;
  console.log(
    `attest: ${rel} sha256=${sha256Hex(text)} key=${keyId(publicPem)} prev=${prev?.path ?? 'none (baseline)'} ` +
      `public=${pa.entries} (+${pa.new_entries.length}) private=${pv ? `${pv.entries} (+${pv.new_entries.length})` : 'none'}`,
  );
  if (dryRun) return;

  mkdirSync(dirname(join(dataDir, rel)), { recursive: true });
  writeFileSync(join(dataDir, rel), text);
  writeFileSync(join(dataDir, `${rel}.sig`), sig);
  if (!existsSync(pubKeyPath)) writeFileSync(pubKeyPath, publicPem);
  const readme = join(dataDir, ATTEST_DIR, 'README.md');
  if (!existsSync(readme)) writeFileSync(readme, ATTEST_README);
  const out = process.env.GITHUB_OUTPUT;
  if (out) writeFileSync(out, `attest_file=${rel}\n`, { flag: 'a' });
}

main();
