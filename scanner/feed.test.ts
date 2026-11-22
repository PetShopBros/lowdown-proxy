import { test } from "node:test";
import assert from "node:assert/strict";
import { renderFeed, feedItems, dayState, guidFor, xmlEscape } from "../api/feed.ts";

const NAME = "com.grabbitapp/grabblist";

const day = (d: string, o: Record<string, unknown> = {}) => ({ day: d, remotes: 1, error_type: null, tool_count: 22, http_status: 200, reached_level: 2, tools_changed: false, retry_reached_level: null, ...o });

// 11/22 실제 카드(grabblist)에서 줄인 것
const grabblist = {
  status: { check_interval_days: 1 },
  scanner: {
    first_observed_at: "2026-10-29T10:17:00Z",
    daily_30d: [day("2026-11-04"), day("2026-11-05", { tools_changed: true }), day("2026-11-06")],
    definition_changes: {
      events: [{
        day: "2026-11-05",
        kinds: ["schema_changed", "description_changed", "server_version_changed"],
        new_flags: [],
        compared_with: "2026-11-04",
        server_version: { to: "2.2.1", from: "2.1.0" },
        returned_to_earlier_definition: false,
      }],
    },
  },
  registry: { changes_30d: [] },
};

test("grabblist: 도구 정의 변경 1건", () => {
  const items = feedItems(NAME, grabblist, "2026-11-22T05:31:42Z");
  assert.equal(items.length, 1);
  assert.equal(items[0]!.kind, "definition");
  assert.equal(items[0]!.day, "2026-11-05");
  assert.match(items[0]!.title, /tool input\/output schemas, tool descriptions/);
  assert.match(items[0]!.description, /Server version 2\.1\.0 → 2\.2\.1/);
  assert.match(items[0]!.description, /Compared with the observation of 2026-11-04/);
});

test("guid: 다시 만들어도 같고, 키 순서가 달라도 같음", () => {
  const a = feedItems(NAME, grabblist, null)[0]!.guid;
  const b = feedItems(NAME, JSON.parse(JSON.stringify(grabblist)), null)[0]!.guid;
  assert.equal(a, b);
  assert.equal(guidFor(NAME, "x", "2026-01-01", { a: 1, b: 2 }), guidFor(NAME, "x", "2026-01-01", { b: 2, a: 1 }));
  assert.match(a, /^lowdown:com\.grabbitapp\/grabblist:definition:2026-11-05:[0-9a-f]{12}$/);
});

test("guid: 같은 날·같은 종류 이벤트 두 개(원격 2개)는 겹치지 않음", () => {
  const card = { scanner: { definition_changes: { events: [
    { day: "2026-11-05", kinds: ["schema_changed"], remote: "a" },
    { day: "2026-11-05", kinds: ["schema_changed"], remote: "b" },
  ] } } };
  const items = feedItems(NAME, card, null);
  assert.equal(items.length, 2);
  assert.notEqual(items[0]!.guid, items[1]!.guid);
});

test("상태: 관측 없는 날은 건너뜀(3일 순환 서버의 빈 날 ≠ 중단)", () => {
  const card = { status: { check_interval_days: 3 }, scanner: { daily_30d: [day("2026-11-01"), day("2026-11-04"), day("2026-11-07")] } };
  assert.equal(feedItems(NAME, card, null).filter((i) => i.kind === "status").length, 0);
});

test("상태: 응답 없음 → 복구, 401 은 인증 요구로 구분", () => {
  const card = { status: { check_interval_days: 3 }, scanner: { daily_30d: [
    day("2026-11-01"),
    day("2026-11-04", { reached_level: 0, http_status: null, error_type: "timeout" }),
    day("2026-11-07"),
    day("2026-11-10", { reached_level: 0, http_status: 401 }),
  ] } };
  const st = feedItems(NAME, card, null).filter((i) => i.kind === "status");
  assert.deepEqual(st.map((i) => i.day), ["2026-11-10", "2026-11-07", "2026-11-04"]);
  assert.match(st[0]!.title, /required authentication/);
  assert.equal(st[1]!.title, "Responding again");
  assert.match(st[2]!.description, /did not respond\. Previous check \(2026-11-01\): it answered initialize and tools\/list\. Lowdown checks this server every 3 days\./);
});

test("dayState: 재시도에서 응답하면 응답으로 봄, 402 는 HTTP 코드 그대로", () => {
  assert.equal(dayState({ reached_level: 0, retry_reached_level: 2 }), "responded");
  assert.equal(dayState({ reached_level: 0, http_status: 403 }), "auth_required");
  assert.equal(dayState({ reached_level: 0, http_status: 402 }), "http_402");
  assert.equal(dayState({ reached_level: 1, http_status: 200 }), "initialize_only");
  assert.equal(dayState({ reached_level: 0, http_status: null }), "no_response");
});

// 11/22 실제 카드(nodepal-mcp)에서 줄인 것: Registry 같은 날 두 종류 + PyPI 변화
const nodepal = {
  registry: { changes_30d: [
    { on: "2026-11-21", new: "0.4.0", old: "0.3.0", kind: "version" },
    { on: "2026-11-21", kind: "packages" },
    { on: "2026-11-20", new: "0.3.0", old: "0.2.0", kind: "version" },
    { on: "2026-11-20", kind: "packages" },
    { on: "2026-11-19", kind: "new" },
  ] },
  packages: [{ name: "nodepal-mcp", registry: "pypi", declared_version: "0.4.0", pypi: {
    recent_events: [{ on: "2026-11-20", new: "0.3.1", old: "0.3.0", kind: "latest_changed" }],
  } }],
};

test("nodepal: Registry·PyPI 항목, 최신순, guid 모두 다름", () => {
  const items = feedItems("net.nodepal/nodepal-mcp", nodepal, null);
  assert.equal(items.length, 6);
  assert.deepEqual(items.map((i) => i.day), ["2026-11-21", "2026-11-21", "2026-11-20", "2026-11-20", "2026-11-20", "2026-11-19"]);
  assert.equal(new Set(items.map((i) => i.guid)).size, 6);
  assert.ok(items.some((i) => i.title === "Registry version 0.3.0 → 0.4.0"));
  assert.ok(items.some((i) => i.title === "PyPI nodepal-mcp: latest 0.3.0 → 0.3.1"));
  assert.ok(items.some((i) => i.title === "Listed in the MCP Registry"));
});

test("변경 없는 서버: 관측 시작 항목 1개", () => {
  const card = { status: { check_interval_days: 1 }, scanner: { first_observed_at: "2026-10-20T00:00:00Z", daily_30d: [day("2026-11-20"), day("2026-11-21")], definition_changes: { events: [] } } };
  const items = feedItems(NAME, card, null);
  assert.equal(items.length, 1);
  assert.equal(items[0]!.kind, "start");
  assert.equal(items[0]!.day, "2026-10-20");
});

test("빈 카드: 항목 없음, 피드는 여전히 올바른 XML 껍데기", () => {
  const xml = renderFeed(NAME, {}, null);
  assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
  assert.equal((xml.match(/<item>/g) ?? []).length, 0);
  assert.match(xml, /<\/rss>\n$/);
});

test("XML: 특수 문자 이스케이프, 제어 문자 제거, pubDate·링크", () => {
  assert.equal(xmlEscape(`a<b>&"c'\u0001`), "a&lt;b&gt;&amp;&quot;c&apos;");
  const card = { registry: { changes_30d: [{ on: "2026-11-21", kind: "status", new: "<deprecated>&" }] } };
  const xml = renderFeed(NAME, card, "2026-11-22T05:31:42Z");
  assert.ok(!xml.includes("<deprecated>"));
  assert.ok(xml.includes("&lt;deprecated&gt;&amp;"));
  assert.ok(xml.includes("<pubDate>Sat, 21 Nov 2026 00:00:00 GMT</pubDate>"));
  assert.ok(xml.includes("<lastBuildDate>Sun, 22 Nov 2026 05:31:42 GMT</lastBuildDate>"));
  assert.ok(xml.includes(`<atom:link href="https://lowdown-proxy.vercel.app/servers/${NAME}/feed.xml" rel="self" type="application/rss+xml"/>`));
  assert.ok(xml.includes(`Record: https://lowdown-proxy.vercel.app/api/reputation/mcp:${NAME}`));
});

test("이상한 값은 건너뜀(날짜 형식, 종류 없음)", () => {
  const card = { registry: { changes_30d: [{ on: "not-a-day", kind: "version" }, { on: "2026-11-21" }] }, scanner: { definition_changes: { events: [{ day: "x" }] } } };
  assert.equal(feedItems(NAME, card, null).length, 0);
});
