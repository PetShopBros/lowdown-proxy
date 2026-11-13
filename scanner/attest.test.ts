// 관측 서명 (scanner/attest-lib.ts, scanner/attest.ts)
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';
import {
  attestPath,
  buildAttestation,
  keyId,
  latestBefore,
  parseManifestRows,
  publicPemFromPrivate,
  serializeAttestation,
  sha256Hex,
  signText,
  verifyText,
} from './attest-lib.ts';

const H = (c: string) => c.repeat(64);
const HEADER = 'dataset,day,path,rows,bytes,sha256,written_at';
const PUB = `${HEADER}\nobservations,2026-11-10,observations/2026/11/2026-11-10.csv.gz,100,2000,${H('a')},2026-11-11T01:00:00.000Z\nobservations,2026-11-11,observations/2026/11/2026-11-11.csv.gz,110,2100,${H('b')},2026-11-12T01:00:00.000Z\n`;
const PRIV = `${HEADER}\ntool_defs,2026-11-11,tool_defs/daily/2026/11/2026-11-11.jsonl.gz,50,900,${H('c')},2026-11-12T01:05:00.000Z\n`;

function keys() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    priv: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    pub: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  };
}

describe('관측 서명 — 순수 함수', () => {
  test('MANIFEST 파싱: 헤더·열 수·sha256 형식', () => {
    assert.equal(parseManifestRows(PUB).length, 2);
    assert.deepEqual(parseManifestRows(''), []);
    assert.throws(() => parseManifestRows('a,b\n'), /header/);
    assert.throws(() => parseManifestRows(`${HEADER}\nx,y\n`), /7 fields/);
    assert.throws(() => parseManifestRows(`${HEADER}\na,b,c,1,2,nothex,t\n`), /sha256/);
  });

  test('첫 증명은 기준선: 전부 new_entries, prev 없음, 비공개는 경로 없이 해시만', () => {
    const k = keys();
    const o = buildAttestation({ day: '2026-11-13', createdAt: '2026-11-13T01:00:00.000Z', publicManifest: PUB, privateManifest: PRIV, prev: null, publicKeyPem: k.pub }) as any;
    assert.equal(o.baseline, true);
    assert.equal(o.prev, null);
    assert.equal(o.public_archive.manifest_sha256, sha256Hex(PUB));
    assert.equal(o.public_archive.new_entries.length, 2);
    assert.equal(o.public_archive.new_entries[0].path, 'observations/2026/11/2026-11-10.csv.gz');
    assert.equal(o.private_archive.manifest_sha256, sha256Hex(PRIV));
    assert.equal(o.private_archive.new_entries[0].path, undefined);
    assert.equal(o.private_archive.new_entries[0].sha256, H('c'));
    assert.equal(o.signing_key_id, keyId(k.pub));
    assert.ok(!JSON.stringify(o).includes('BEGIN'));
  });

  test('다음 증명: 직전 이후 written_at 만 new_entries, prev 사슬', () => {
    const k = keys();
    const o = buildAttestation({
      day: '2026-11-14', createdAt: '2026-11-14T01:00:00.000Z', publicManifest: PUB, privateManifest: null,
      prev: { path: 'attest/2026/2026-11-13.json', sha256: H('d'), createdAt: '2026-11-11T12:00:00.000Z' }, publicKeyPem: k.pub,
    }) as any;
    assert.equal(o.baseline, false);
    assert.deepEqual(o.prev, { path: 'attest/2026/2026-11-13.json', sha256: H('d') });
    assert.deepEqual(o.public_archive.new_entries.map((e: any) => e.day), ['2026-11-11']);
    assert.equal(o.private_archive, null);
  });

  test('직렬화는 늘 같고, 서명은 같은 텍스트에만 맞는다', () => {
    const k = keys();
    const input = { day: '2026-11-13', createdAt: '2026-11-13T01:00:00.000Z', publicManifest: PUB, privateManifest: PRIV, prev: null, publicKeyPem: k.pub };
    const t1 = serializeAttestation(buildAttestation(input));
    const t2 = serializeAttestation(buildAttestation(input));
    assert.equal(t1, t2);
    const sig = signText(t1, k.priv);
    assert.equal(verifyText(t1, sig, k.pub), true);
    assert.equal(verifyText(t1.replace('2026-11-13', '2026-11-12'), sig, k.pub), false);
    assert.equal(verifyText(t1, sig, keys().pub), false);
    assert.equal(verifyText(t1, 'garbage', k.pub), false);
    assert.equal(publicPemFromPrivate(k.priv), k.pub);
  });

  test('경로와 직전 증명 찾기', () => {
    assert.equal(attestPath('2026-11-13'), 'attest/2026/2026-11-13.json');
    assert.equal(latestBefore(['attest/2026/2026-11-12.json', 'attest/2026/2026-11-13.json', 'attest/README.md'], '2026-11-13'), 'attest/2026/2026-11-12.json');
    assert.equal(latestBefore([], '2026-11-13'), null);
    assert.throws(() => buildAttestation({ day: '13-11-2026', createdAt: 'x', publicManifest: '', privateManifest: null, prev: null, publicKeyPem: keys().pub }), /YYYY-MM-DD/);
  });
});

describe('관측 서명 — 실행 (scanner/attest.ts)', () => {
  function setup() {
    const root = mkdtempSync(join(tmpdir(), 'attest-'));
    const data = join(root, 'data');
    const priv = join(root, 'priv');
    mkdirSync(data);
    mkdirSync(priv);
    writeFileSync(join(data, 'MANIFEST.csv'), PUB);
    writeFileSync(join(priv, 'MANIFEST.csv'), PRIV);
    return { data, priv };
  }
  const run = (data: string, priv: string, env: Record<string, string>) =>
    execFileSync(process.execPath, [fileURLToPath(new URL('./attest.ts', import.meta.url)), data, priv], { env: { ...process.env, ...env, GITHUB_OUTPUT: '' }, encoding: 'utf8' });

  test('키 없으면 건너뜀(실패 아님), 있으면 오늘 파일·서명·공개키·README, 다시 실행하면 그대로', () => {
    const { data, priv } = setup();
    assert.match(run(data, priv, { LOWDOWN_ATTEST_KEY: '' }), /not set/);
    const k = keys();
    const out = run(data, priv, { LOWDOWN_ATTEST_KEY: k.priv });
    const day = new Date().toISOString().slice(0, 10);
    const rel = attestPath(day);
    assert.match(out, /prev=none \(baseline\)/);
    assert.ok(!out.includes('BEGIN'));
    const text = readFileSync(join(data, rel), 'utf8');
    assert.equal(verifyText(text, readFileSync(join(data, `${rel}.sig`), 'utf8'), k.pub), true);
    assert.equal(readFileSync(join(data, 'attest', 'PUBLIC_KEY.pem'), 'utf8'), k.pub);
    assert.ok(existsSync(join(data, 'attest', 'README.md')));
    assert.match(run(data, priv, { LOWDOWN_ATTEST_KEY: k.priv }), /exists \(skip\)/);
    assert.equal(readFileSync(join(data, rel), 'utf8'), text);
  });

  test('직전 증명이 있으면 사슬로 잇고, 다른 키면 실패', () => {
    const { data, priv } = setup();
    const k = keys();
    const prevText = serializeAttestation(buildAttestation({ day: '2026-01-01', createdAt: '2026-01-01T00:00:00.000Z', publicManifest: PUB, privateManifest: PRIV, prev: null, publicKeyPem: k.pub }));
    mkdirSync(join(data, 'attest', '2026'), { recursive: true });
    writeFileSync(join(data, 'attest/2026/2026-01-01.json'), prevText);
    writeFileSync(join(data, 'attest/2026/2026-01-01.json.sig'), signText(prevText, k.priv));
    writeFileSync(join(data, 'attest/PUBLIC_KEY.pem'), k.pub);
    const out = run(data, priv, { LOWDOWN_ATTEST_KEY: k.priv });
    assert.match(out, /prev=attest\/2026\/2026-01-01\.json/);
    const o = JSON.parse(readFileSync(join(data, attestPath(new Date().toISOString().slice(0, 10))), 'utf8'));
    assert.equal(o.prev.sha256, sha256Hex(prevText));
    const other = setup();
    mkdirSync(join(other.data, 'attest'), { recursive: true });
    writeFileSync(join(other.data, 'attest/PUBLIC_KEY.pem'), k.pub);
    assert.throws(() => run(other.data, other.priv, { LOWDOWN_ATTEST_KEY: keys().priv }));
  });
});
