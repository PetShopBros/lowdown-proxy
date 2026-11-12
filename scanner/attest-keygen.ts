// 관측 서명 키 만들기 (한 번만) — 사용: node scanner/attest-keygen.ts <outDir>
// <outDir> 에 lowdown-attest-private.pem / lowdown-attest-public.pem 을 만든다. 레포 밖 폴더를 쓸 것.
// 개인키는 GitHub Secret LOWDOWN_ATTEST_KEY 로 등록하고, 사본은 오프라인에 보관한다. 출력에는 키 ID 만 나온다.

import { generateKeyPairSync } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { keyId } from './attest-lib.ts';

const outDir = process.argv[2];
if (!outDir) {
  console.error('사용법: node scanner/attest-keygen.ts <outDir>');
  process.exit(1);
}
const privPath = join(outDir, 'lowdown-attest-private.pem');
const pubPath = join(outDir, 'lowdown-attest-public.pem');
if (existsSync(privPath) || existsSync(pubPath)) {
  console.error(`이미 있습니다: ${privPath} 또는 ${pubPath} (덮어쓰지 않음)`);
  process.exit(1);
}
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
writeFileSync(privPath, privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), { mode: 0o600 });
writeFileSync(pubPath, publicKey.export({ type: 'spki', format: 'pem' }).toString());
console.log(`key id: ${keyId(publicKey)}`);
console.log(`private: ${privPath}`);
console.log(`public:  ${pubPath}`);
