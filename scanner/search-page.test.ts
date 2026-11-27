import { test } from "node:test";
import assert from "node:assert/strict";
import { planSearch, renderSearch, searchForm, SEARCH_LIMIT } from "../api/page.ts";

test("검색 입력 분류: 정확한 이름, mcp: 접두어, 단어, 이름 일부, 잘못된 입력", () => {
  assert.deepEqual(planSearch("com.grabbitapp/grabblist"), { kind: "name", name: "com.grabbitapp/grabblist", param: "q", value: "com.grabbitapp/grabblist" });
  assert.equal(planSearch(" mcp:com.grabbitapp/grabblist ").kind, "name");
  assert.deepEqual(planSearch("Github  Issue"), { kind: "words", param: "does", value: "github issue" });
  assert.deepEqual(planSearch("io.github.user/"), { kind: "part", param: "q", value: "io.github.user/" });
  assert.equal(planSearch("").kind, "empty");
  assert.equal(planSearch("a").kind, "bad");
  assert.equal(planSearch("<script>").kind, "bad");
  assert.equal(planSearch("one two three four").kind, "bad");
});

test("검색 결과: 이름 링크, 상태 문구, 날짜, noindex, 점수 없음", () => {
  const html = renderSearch("postgres", planSearch("postgres"), {
    total: 2,
    results: [
      { name: "ai.duvera/gateway", state: "answered", latest_check: "2026-11-26", tool_count: 52 },
      { name: "x.y/stale", state: null, latest_check: "2026-11-01", tool_count: null },
    ],
  });
  assert.match(html, /<meta name="robots" content="noindex">/);
  assert.match(html, /href="\/servers\/ai\.duvera\/gateway"/);
  assert.match(html, /answered initialize and tools\/list, 2026-11-26, 52 tools/);
  assert.match(html, /last checked, 2026-11-01/);
  assert.match(html, /2 servers matched\./);
  assert.doesNotMatch(html, /score:|rating|trusted|safe/i);
});

test("결과가 상한보다 많으면 find API 안내", () => {
  const results = Array.from({ length: SEARCH_LIMIT }, (_, i) => ({ name: `a.b/s${i}`, state: "answered", latest_check: "2026-11-26" }));
  const html = renderSearch("postgres", planSearch("postgres"), { total: 57, results });
  assert.match(html, /57 servers matched, first 20 by name/);
  assert.match(html, /api\/find\?does=postgres/);
});

test("결과 없음: 기록 없음이 서버에 대해 아무것도 뜻하지 않는다는 문장", () => {
  const html = renderSearch("zzqq", planSearch("zzqq"), { total: 0, results: [] });
  assert.match(html, /says nothing about a server/);
});

test("이스케이프: 입력값과 이상한 결과 이름", () => {
  assert.match(searchForm('"><x'), /value="&quot;&gt;&lt;x"/);
  const html = renderSearch("ab", planSearch("ab"), { total: 1, results: [{ name: "<b>/x" }] });
  assert.doesNotMatch(html, /<b>\/x/);
});
