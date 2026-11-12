// 관측 서명 (2026-11-13) — 날마다 보관 상태(공개·비공개 MANIFEST)를 한 파일로 묶어 Ed25519 로 서명한다.
// 시간 증명은 OpenTimestamps(.ots)가 맡는다(backup.yml). 이 파일은 순수 함수만: 파일 쓰기·네트워크 없음.
//
// 무엇을 증명하나
//   - 누가: Lowdown 서명 키(공개키는 lowdown-data/attest/PUBLIC_KEY.pem)로 서명했다.
//   - 무엇을: 공개 보관(lowdown-data/MANIFEST.csv)과 비공개 보관(lowdown-private/MANIFEST.csv)의 SHA-256.
//     MANIFEST 에는 파일마다 경로·행 수·바이트·SHA-256 이 있으므로, MANIFEST 해시가 모든 보관 파일을 묶는다.
//     비공개 보관은 해시와 개수만 싣는다(내용·MANIFEST 원문은 공개하지 않음). 나중에 비공개 파일을 보여 줄 때 이 해시로 대조한다.
//   - 순서: 직전 증명 파일의 SHA-256(prev)을 넣어 사슬로 잇는다. 중간 파일을 빼거나 바꾸면 사슬이 끊긴다.
// 증명하지 않는 것: 관측 내용이 맞다는 것, 서버의 상태, 점수. 그날 그 파일들이 그 모습으로 있었다는 사실만.

import { createHash, createPrivateKey, createPublicKey, sign, verify, type KeyObject } from 'node:crypto';

export const ATTEST_FORMAT = 'lowdown-attestation/1';
export const ATTEST_DIR = 'attest';
export const PUBLIC_KEY_FILE = 'PUBLIC_KEY.pem';
export const ATTEST_STATEMENT =
  'Lowdown held the archive files listed in these manifests, with these SHA-256 digests, when this attestation was created. ' +
  'It says nothing about whether the observations are correct, and it is not a score.';
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const HEX64 = /^[0-9a-f]{64}$/;

export interface ManifestRow {
  dataset: string;
  day: string;
  path: string;
  rows: number;
  bytes: number;
  sha256: string;
  written_at: string;
}

/** MANIFEST.csv(공개·비공개 같은 열) → 행. 헤더가 다르면 예외 */
export function parseManifestRows(text: string): ManifestRow[] {
  const lines = text.split('\n').filter((l) => l.length > 0);
  if (lines.length === 0) return [];
  if (lines[0] !== 'dataset,day,path,rows,bytes,sha256,written_at') throw new Error('MANIFEST.csv: unexpected header');
  return lines.slice(1).map((l, i) => {
    const f = l.split(',');
    if (f.length !== 7) throw new Error(`MANIFEST.csv line ${i + 2}: expected 7 fields`);
    const [dataset, day, path, rows, bytes, sha256, written_at] = f as [string, string, string, string, string, string, string];
    if (!HEX64.test(sha256)) throw new Error(`MANIFEST.csv line ${i + 2}: bad sha256`);
    return { dataset, day, path, rows: Number(rows), bytes: Number(bytes), sha256, written_at };
  });
}

export const sha256Hex = (data: string | Uint8Array): string => createHash('sha256').update(data).digest('hex');

/** 공개키 PEM → 키 ID (DER(SPKI) SHA-256 앞 16자) */
export function keyId(publicKey: KeyObject | string): string {
  const k = typeof publicKey === 'string' ? createPublicKey(publicKey) : publicKey;
  return sha256Hex(k.export({ type: 'spki', format: 'der' })).slice(0, 16);
}

export function publicPemFromPrivate(privatePem: string): string {
  return createPublicKey(createPrivateKey(privatePem)).export({ type: 'spki', format: 'pem' }).toString();
}

export interface AttestInput {
  day: string; // 만든 날 (UTC)
  createdAt: string; // ISO
  publicManifest: string; // lowdown-data/MANIFEST.csv 원문
  privateManifest: string | null; // lowdown-private/MANIFEST.csv 원문 (없으면 null)
  prev: { path: string; sha256: string; createdAt: string } | null;
  publicKeyPem: string;
}

const entryOut = (e: ManifestRow, withPath: boolean) => ({
  dataset: e.dataset,
  day: e.day,
  ...(withPath ? { path: e.path } : {}),
  rows: e.rows,
  bytes: e.bytes,
  sha256: e.sha256,
});

/**
 * 증명 객체. 키 순서가 고정된 리터럴로 만든다(직렬화 결과가 늘 같게).
 * new_entries: 직전 증명 이후 written_at 인 행(첫 증명은 전부 — 기준선). 비공개 쪽은 경로를 싣지 않는다.
 */
export function buildAttestation(a: AttestInput): Record<string, unknown> {
  if (!DAY_RE.test(a.day)) throw new Error('day must be YYYY-MM-DD');
  const pub = parseManifestRows(a.publicManifest);
  const priv = a.privateManifest === null ? null : parseManifestRows(a.privateManifest);
  const since = a.prev?.createdAt ?? null;
  const isNew = (e: ManifestRow) => since === null || e.written_at > since;
  return {
    format: ATTEST_FORMAT,
    day: a.day,
    created_at: a.createdAt,
    statement: ATTEST_STATEMENT,
    signing_key_id: keyId(a.publicKeyPem),
    prev: a.prev ? { path: a.prev.path, sha256: a.prev.sha256 } : null,
    baseline: a.prev === null,
    public_archive: {
      repository: 'https://github.com/PetShopBros/lowdown-data',
      manifest_sha256: sha256Hex(a.publicManifest),
      entries: pub.length,
      new_entries: pub.filter(isNew).map((e) => entryOut(e, true)),
    },
    private_archive:
      priv === null || a.privateManifest === null
        ? null
        : {
            note: 'Not published. Digests only; files can be shown later and checked against these values.',
            manifest_sha256: sha256Hex(a.privateManifest),
            entries: priv.length,
            new_entries: priv.filter(isNew).map((e) => entryOut(e, false)),
          },
  };
}

export const serializeAttestation = (o: Record<string, unknown>): string => `${JSON.stringify(o, null, 2)}\n`;

/** Ed25519 서명 (base64, 끝 줄바꿈) */
export function signText(text: string, privatePem: string): string {
  return `${sign(null, Buffer.from(text, 'utf8'), createPrivateKey(privatePem)).toString('base64')}\n`;
}

export function verifyText(text: string, signatureB64: string, publicPem: string): boolean {
  try {
    return verify(null, Buffer.from(text, 'utf8'), createPublicKey(publicPem), Buffer.from(signatureB64.trim(), 'base64'));
  } catch {
    return false;
  }
}

/** 증명 파일 경로: attest/YYYY/YYYY-MM-DD.json */
export const attestPath = (day: string): string => `${ATTEST_DIR}/${day.slice(0, 4)}/${day}.json`;

/** 경로 목록에서 가장 최근 증명 경로 (오늘 것 제외) */
export function latestBefore(paths: readonly string[], day: string): string | null {
  const re = /^attest\/\d{4}\/(\d{4}-\d{2}-\d{2})\.json$/;
  const days = paths.map((p) => re.exec(p)?.[1]).filter((d): d is string => !!d && d < day).sort();
  return days.length ? attestPath(days[days.length - 1]!) : null;
}

export const ATTEST_README = `# Lowdown attestations

One file per day: \`YYYY/YYYY-MM-DD.json\`, its Ed25519 signature \`.json.sig\` (base64) and an OpenTimestamps proof \`.json.ots\`.

- **Who**: signed with the key in \`PUBLIC_KEY.pem\` (\`signing_key_id\` = first 16 hex of SHA-256 of the key's DER).
- **What**: SHA-256 of \`MANIFEST.csv\` of this repository (every archived file with its path, rows, bytes and SHA-256) and of the private archive's manifest (digests only, not published).
- **When**: the \`.ots\` proof anchors the attestation's SHA-256 in Bitcoin through OpenTimestamps calendars. It starts as pending and is upgraded on later days.
- **Order**: \`prev\` is the SHA-256 of the previous attestation, so the files form a chain. The first file (\`baseline: true\`) covers everything archived before it.

It shows that these files existed in this form at that time. It does not show that the observations are correct, and it is not a score.

Verify (Node 18+):

\`\`\`
node -e "const c=require('crypto'),f=require('fs');const d=process.argv[1];console.log(c.verify(null,f.readFileSync(d),c.createPublicKey(f.readFileSync('attest/PUBLIC_KEY.pem')),Buffer.from(f.readFileSync(d+'.sig','utf8').trim(),'base64')))" attest/2026/2026-11-13.json
sha256sum MANIFEST.csv   # compare with public_archive.manifest_sha256 of the day's file (MANIFEST.csv at that commit)
pip install opentimestamps-client && ots verify attest/2026/2026-11-13.json.ots
\`\`\`
`;
