import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

// sitemap 분할 (2026-11-05): /sitemap.xml = index, /sitemaps/pages.xml + /sitemaps/servers-N.xml (5,000개씩)
const page = (await import('../api/page.ts' as string)) as any;
const SITE = 'https://lowdown-proxy.vercel.app';

// 12,127개 + 이름 형식 밖 2개 + 중복 1개 + deleted 3개
const rows: Array<{ target_id: string; latest_day: string | null; latest_state: string }> = [];
for (let i = 0; i < 12_127; i++) rows.push({ target_id: `mcp:io.github.u${i}/s${i}`, latest_day: i % 10 === 0 ? null : `2026-11-0${(i % 4) + 1}`, latest_state: 'answered' });
rows.push({ target_id: 'mcp:bad name/x', latest_day: '2026-11-04', latest_state: 'answered' });
rows.push({ target_id: 'npm:pkg', latest_day: '2026-11-04', latest_state: 'answered' });
rows.push({ ...rows[5]! });
const deleted = new Set(['mcp:io.github.u1/s1', 'mcp:io.github.u2/s2', 'mcp:io.github.u3/s3']);

describe('sitemap 분할', () => {
  const entries = page.sitemapEntries(rows, deleted);
  const parts = page.sitemapParts(entries);

  test('빠짐·중복 없음, deleted·형식 밖 제외', () => {
    assert.equal(entries.length, 12_127 - 3);
    const locs = entries.map((e: any) => e.loc);
    assert.equal(new Set(locs).size, locs.length);
    assert.ok(!locs.some((l: string) => /u[123]\/s[123]$/.test(l)));
    assert.ok(!locs.some((l: string) => /bad|npm/.test(l)));
    assert.ok(locs.includes(`${SITE}/servers/io.github.u12126/s12126`));
  });

  test('5,000개씩 자동 분할, 모든 묶음 10,000개 이하, 합치면 원래 목록', () => {
    assert.deepEqual(parts.map((p: unknown[]) => p.length), [5000, 5000, 2124]);
    assert.ok(parts.every((p: unknown[]) => p.length <= 10_000));
    assert.deepEqual(parts.flat(), entries);
    // 서버가 늘면 묶음도 늘어난다
    assert.equal(page.sitemapParts(entries, 5000).length, 3);
    assert.equal(page.sitemapParts([...entries, ...entries.slice(0, 2900)], 5000).length, 4);
  });

  test('index 가 pages.xml 과 모든 서버 묶음을 가리킨다', () => {
    const idx = page.renderSitemapIndex(parts);
    assert.match(idx, /^<\?xml version="1\.0" encoding="UTF-8"\?>\n<sitemapindex xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9">/);
    const locs = [...idx.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
    assert.deepEqual(locs, [`${SITE}/sitemaps/pages.xml`, `${SITE}/sitemaps/servers-1.xml`, `${SITE}/sitemaps/servers-2.xml`, `${SITE}/sitemaps/servers-3.xml`]);
    assert.match(idx, /servers-1\.xml<\/loc><lastmod>2026-11-04<\/lastmod>/);
    assert.equal((idx.match(/<sitemap>/g) ?? []).length, (idx.match(/<\/sitemap>/g) ?? []).length);
  });

  test('묶음 urlset: lastmod 는 점검 날짜가 있을 때만', () => {
    const xml = page.renderUrlset(parts[0]);
    assert.equal((xml.match(/<url>/g) ?? []).length, 5000);
    assert.match(xml, /<url><loc>https:\/\/lowdown-proxy\.vercel\.app\/servers\/io\.github\.u0\/s0<\/loc><\/url>/); // latest_day 없음
    assert.match(xml, /<url><loc>https:\/\/lowdown-proxy\.vercel\.app\/servers\/io\.github\.u10001\/s10001<\/loc><lastmod>2026-11-02<\/lastmod><\/url>|<lastmod>2026-11-0\d<\/lastmod>/);
    assert.doesNotMatch(xml, /<lastmod>(null|undefined)?<\/lastmod>/);
  });

  test('고정 페이지와 파일 이름 해석', () => {
    const xml = page.renderUrlset(page.STATIC_PAGES.map((p: string) => ({ loc: `${SITE}${p}`, lastmod: null })));
    assert.deepEqual([...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]), [`${SITE}/`, `${SITE}/servers`, `${SITE}/agents`, `${SITE}/privacy`, `${SITE}/terms`]);
    assert.equal(page.sitemapFile('pages.xml'), 'pages');
    assert.equal(page.sitemapFile('servers-3.xml'), 3);
    for (const bad of ['servers-0.xml', 'servers-01.xml', 'servers-x.xml', '../servers-1.xml', 'servers-1.xml.gz', undefined]) assert.equal(page.sitemapFile(bad), null);
  });
});
