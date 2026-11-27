import { test } from "node:test";
import assert from "node:assert/strict";
import { interestBlock, renderServerPage } from "../api/page.ts";

const j = {
  message: "m",
  status: { state: "answered", latest_check: "2026-11-26", stale: false, checks_30d: { observed: 29, answered: 29 } },
  registry: { listed: true, name: "com.grabbitapp/grabblist" },
};

test("관심 버튼: 링크가 아니라 GET 양식, 가격·약속 문구 없음", () => {
  const h = interestBlock("com.grabbitapp/grabblist", false, null);
  assert.match(h, /<form[^>]+action="\/servers\/com\.grabbitapp\/grabblist" method="get">/);
  assert.match(h, /name="interest" value="alerts"/);
  assert.doesNotMatch(h, /<a /);
  assert.doesNotMatch(h, /\$|price|free|soon|coming|will be|yet/i);
});

test("누른 뒤: 제공하지 않음 + 셌음 + RSS 안내, 버튼 없음", () => {
  const h = interestBlock("a.b/c", true, "https://x/servers/a.b/c/feed.xml");
  assert.match(h, /Alerts are not offered\. This click was counted as interest\./);
  assert.match(h, /feed\.xml/);
  assert.doesNotMatch(h, /<button/);
  assert.doesNotMatch(h, /soon|coming|will be|yet/i);
});

test("서버 페이지: 관찰 기록 있으면 버튼, interest 이면 안내 문장", () => {
  assert.match(renderServerPage("com.grabbitapp/grabblist", j)!.html, /Alerts for this server/);
  const clicked = renderServerPage("com.grabbitapp/grabblist", j, { interest: true })!.html;
  assert.match(clicked, /This click was counted as interest/);
  assert.doesNotMatch(clicked, /Alerts for this server/);
  const noObs = renderServerPage("com.grabbitapp/grabblist", { registry: { listed: true } })!.html;
  assert.doesNotMatch(noObs, /Alerts for this server|counted as interest/);
});
