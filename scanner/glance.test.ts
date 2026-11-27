import { test } from "node:test";
import assert from "node:assert/strict";
import { atAGlance } from "../api/page.ts";

const base = {
  status: { state: "answered", latest_check: "2026-11-26", stale: false, checks_30d: { observed: 29, answered: 29 } },
  scanner: {
    declared_vs_observed: {
      declared_version: "2.2.1", observed_server_version: "2.2.1", observed_hosts: ["mcp.grabbitapp.com"],
      since: { version: { match: true, last_compared: "2026-11-27" }, hosts: { match: true, last_compared: "2026-11-27" } },
      cards: { checked: true, remotes: [{ checked_on: "2026-11-27", server_card: { outcome: "not_found" } }], hosts: [{ checked_on: "2026-11-27", ai_catalog: { outcome: "not_found" }, a2a_agent_card: { outcome: "not_found" }, mcp_well_known: { outcome: "not_found" } }] },
    },
    definition_changes: { compared_days: 29, first_compared_day: "2026-10-29", last_change: "2026-11-05", events: [{ day: "2026-11-05", kinds: ["schema_changed", "server_version_changed"] }] },
  },
};

test("한눈에 보기: grabblist 형태의 값 6줄", () => {
  const h = atAGlance(base);
  assert.match(h, /<h2>At a glance<\/h2>/);
  assert.match(h, /answered initialize and tools\/list<\/td><td>2026-11-26/);
  assert.match(h, /29 of 29 observed days/);
  assert.match(h, /match \(Registry 2\.2\.1, server 2\.2\.1\)/);
  assert.match(h, /match \(mcp\.grabbitapp\.com\)/);
  assert.match(h, /last changed: input or output schemas changed, server version changed<\/td><td>2026-11-05/);
  assert.match(h, /none found at the standard paths/);
  assert.equal((h.match(/<tr><td>/g) ?? []).length, 6);
});

test("점수처럼 읽히는 것 없음: 개수·퍼센트·통과 표시", () => {
  const h = atAGlance(base);
  assert.doesNotMatch(h, /score:|\d+%|\d+ ?\/ ?6|✓|✗|pass|fail|trusted|safe/i);
});

test("불일치·변경 없음·카드 발견·기록 없음", () => {
  const j = structuredClone(base) as any;
  j.scanner.declared_vs_observed.since.version.match = false;
  j.scanner.declared_vs_observed.observed_server_version = "2.3.0";
  j.scanner.definition_changes = { compared_days: 12, first_compared_day: "2026-11-15", events: [] };
  j.scanner.declared_vs_observed.cards.hosts[0].a2a_agent_card.outcome = "found";
  delete j.scanner.declared_vs_observed.since.hosts;
  const h = atAGlance(j);
  assert.match(h, /differ \(Registry 2\.2\.1, server 2\.3\.0\)/);
  assert.match(h, /no change in 12 compared days<\/td><td>since 2026-11-15/);
  assert.match(h, /found: A2A agent card/);
  assert.match(h, /Registry hosts vs observed hosts<\/td><td>not compared/);
});

test("관찰 기록 없음: 표를 만들지 않음, 이스케이프", () => {
  assert.equal(atAGlance({}), "");
  const j = structuredClone(base) as any;
  j.scanner.declared_vs_observed.observed_hosts = ["<x>"];
  assert.doesNotMatch(atAGlance(j), /<x>/);
});
