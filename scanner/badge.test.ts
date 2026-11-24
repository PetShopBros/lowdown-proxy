import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { badgeFor, renderSvg, badgeJson, badgeMarkdown, textWidth, BADGE_SITE } from "../api/badge.ts";

const NAME = "com.grabbitapp/grabblist";
const card = (status: Record<string, unknown> | null) => (status ? { status } : {});

test("관측 중: 파랑, observed · MM-DD", () => {
  const b = badgeFor(card({ state: "answered", latest_check: "2026-11-24", stale: false, check_interval_days: 1 }));
  assert.equal(b.state, "observed");
  assert.equal(b.message, "observed · 11-24");
  assert.equal(b.day, "2026-11-24");
  assert.equal(b.color, "#185FA5");
});

test("관측이 오래됨: 회색, last seen · MM-DD (카드의 stale 그대로)", () => {
  const b = badgeFor(card({ state: "answered", latest_check: "2026-11-02", stale: true, days_since_latest_check: 22 }));
  assert.equal(b.state, "stale");
  assert.equal(b.message, "last seen · 11-02");
  assert.equal(b.color, "#888780");
});

test("상태가 응답 없음이어도 관측 기록이면 observed (판정하지 않음)", () => {
  const b = badgeFor(card({ state: "no_response", latest_check: "2026-11-24", stale: false }));
  assert.equal(b.state, "observed");
});

test("기록 없음: 카드 없음·status 없음·날짜 없음", () => {
  for (const c of [null, {}, card({ state: "answered" }), card({ state: "answered", latest_check: "bad" }), card({ latest_check: "2026-11-24" })]) {
    const b = badgeFor(c as Record<string, unknown> | null);
    assert.equal(b.state, "not_observed");
    assert.equal(b.message, "not observed");
    assert.equal(b.day, null);
  }
});

test("SVG: 상태별로 문구·색·제목, 판정 단어 없음", () => {
  const cases = [
    card({ state: "answered", latest_check: "2026-11-24", stale: false }),
    card({ state: "answered", latest_check: "2026-11-02", stale: true }),
    null,
  ];
  for (const c of cases) {
    const b = badgeFor(c);
    const svg = renderSvg(b);
    assert.ok(svg.startsWith("<svg "), "svg 로 시작");
    assert.ok(svg.includes(`>${b.message}</text>`));
    assert.ok(svg.includes(b.color));
    assert.ok(svg.includes("<title>"));
    assert.doesNotMatch(svg.toLowerCase(), /safe|trusted|certified|verified|secure|approved/);
    assert.equal(svg.charCodeAt(0), 0x3c, "BOM 없음");
  }
  assert.match(renderSvg(badgeFor(cases[0]!)), /<title>Lowdown: observed 2026-11-24<\/title>/);
});

test("SVG 폭: 글자가 칸 안에 들어감", () => {
  const b = badgeFor(card({ state: "answered", latest_check: "2026-11-24", stale: false }));
  const svg = renderSvg(b);
  const w = Number(/width="(\d+)"/.exec(svg)![1]);
  assert.ok(w >= 21 + textWidth("Lowdown") + textWidth(b.message) + 14);
  assert.ok(w < 220);
});

test("XML 특수 문자는 바뀐다", () => {
  const svg = renderSvg({ ...badgeFor(null), message: `a<b>&"'` });
  assert.ok(svg.includes("a&lt;b&gt;&amp;&quot;&apos;"));
});

test("JSON: shields.io endpoint 형식, 스키마 키만", () => {
  const j = badgeJson(badgeFor(card({ state: "answered", latest_check: "2026-11-24", stale: false })));
  assert.deepEqual(Object.keys(j).sort(), ["cacheSeconds", "color", "label", "labelColor", "message", "schemaVersion"]);
  assert.equal(j.schemaVersion, 1);
  assert.equal(j.message, "observed · 11-24");
  assert.equal(j.color, "185FA5");
  assert.ok((j.cacheSeconds as number) >= 300);
});

test("README 한 줄: 전용 도메인, 클릭은 ?ref=badge, page.ts 와 같은 도메인", () => {
  assert.equal(BADGE_SITE, "https://lowdown.art2meta.com");
  // api 파일끼리 import 하지 않으므로 page.ts 의 같은 상수를 글자로 확인
  const page = readFileSync(join(import.meta.dirname, "..", "api", "page.ts"), "utf8");
  assert.ok(page.includes(`export const BADGE_SITE = "${BADGE_SITE}";`), "page.ts 의 BADGE_SITE 가 같은 값");
  assert.equal(
    badgeMarkdown(NAME),
    "[![Lowdown](https://lowdown.art2meta.com/servers/com.grabbitapp/grabblist/badge.svg)](https://lowdown.art2meta.com/servers/com.grabbitapp/grabblist?ref=badge)",
  );
});
