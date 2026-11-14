import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { pageUrl, registryName, renderOperatorReport } from './operator-report-lib.ts';

// 2026-11-15 실시간 조회(ai.trendsmcp/google-trends)를 줄인 것 + 결제·패키지 칸을 채운 가상 값
const sample = {
  schema_version: 1,
  target: 'ai.trendsmcp/google-trends',
  resolved_target: 'mcp:ai.trendsmcp/google-trends',
  status: {
    state: 'answered', latest_check: '2026-11-14', consecutive_days: 30, consecutive_since: '2026-10-16', tool_count: 6,
    checks_30d: { observed: 30, answered: 30, auth_required: 0, no_response: 0, mixed: 0, scheduled: 30 },
  },
  registry: {
    listed: true, name: 'ai.trendsmcp/google-trends', declared_version: '1.0.7', remote_hosts: ['google-trends.api.trendsmcp.ai'],
    changes_30d: [{ on: '2026-10-22', kind: 'version', old: '1.0.6', new: '1.0.7' }],
  },
  scanner: {
    definition_changes: {
      compared_days: 29, change_days: 5, last_change: '2026-11-07',
      events: [
        { day: '2026-11-07', kinds: ['schema_changed', 'description_changed'], returned_to_earlier_definition: false, new_flags: [] },
        { day: '2026-10-24', kinds: ['tool_names_changed'], tool_count: { from: 4, to: 5 }, returned_to_earlier_definition: false, new_flags: [{ rule: 'description_url' }] },
      ],
    },
    declared_vs_observed: {
      declared_version: '1.0.7', observed_server_version: '1.0.0',
      declared_hosts: ['google-trends.api.trendsmcp.ai'], observed_hosts: ['google-trends.api.trendsmcp.ai'],
      since: {
        version: { match: false, last_compared: '2026-11-14', state_since: null, throughout_window: true },
        hosts: { match: true, last_compared: '2026-11-14', state_since: '2026-11-02' },
      },
      cards: {
        checked: true,
        remotes: [{ endpoint: 'https://google-trends.api.trendsmcp.ai/mcp', checked_on: '2026-11-08', server_card: { outcome: 'http_error', url: 'https://google-trends.api.trendsmcp.ai/mcp/server-card', http_status: 400 } }],
        hosts: [],
      },
    },
  },
  payment: {
    observed: {
      latest_check: '2026-11-14', payment_required: true,
      remotes: [{ remote_host: 'pay.example', protocol: 'x402', options: [{ scheme: 'exact', network: 'base', asset: 'USDC', amount: '10000', pay_to: '0xabc' }] }],
      history_30d: { changes: 1, last_change: { day: '2026-11-13', kinds: ['amount_changed'] } },
    },
    declared: [{ source: 'server_card', protocols: ['x402'], checked_on: '2026-11-08' }],
  },
  packages: [{ registry: 'npm', name: '@x/y', declared_version: '1.0.0', npm: { status: 'found', latest: '1.1.0', latest_deprecated: false, declared_is_latest: false } }],
  source: { retrieved_at: '2026-11-14T18:57:49.209Z' },
};

describe('운영자 관측 요약', () => {
  test('이름 형식', () => {
    assert.equal(registryName('mcp:ai.trendsmcp/google-trends'), 'ai.trendsmcp/google-trends');
    assert.equal(registryName('io.github.a/b'), 'io.github.a/b');
    assert.equal(registryName('npm:pkg'), null);
    assert.equal(registryName('a/b/c'), null);
    assert.equal(pageUrl('a.b/c'), 'https://lowdown-proxy.vercel.app/servers/a.b/c?ref=operator');
  });

  test('조회 응답의 사실만 옮긴다', () => {
    const md = renderOperatorReport({ response: sample, day: '2026-11-15' });
    assert.match(md, /^# Lowdown observation summary: ai\.trendsmcp\/google-trends$/m);
    assert.match(md, /Latest check: 2026-11-14, result `answered`, 6 tools listed\./);
    assert.match(md, /30 checks recorded: answered 30, authentication required 0, no response 0, mixed 0\./);
    assert.match(md, /declares `1\.0\.7`; the server sent `serverInfo\.version` `1\.0\.0`\. The version differed on every comparable check in the last 30 days\./);
    assert.match(md, /The host list has matched on every comparable check since 2026-11-02\./);
    assert.match(md, /mcp\/server-card`: http_error \(HTTP 400\)/);
    assert.match(md, /2026-10-22: version \(`1\.0\.6` → `1\.0\.7`\)/);
    assert.match(md, /MCP Registry entry: 1 change:/);
    assert.match(md, /^Prepared 2026-11-15 \(UTC\)/m);
    assert.match(md, /changed on 5 days of 29 compared days; last change 2026-11-07/);
    assert.match(md, /2026-10-24: tool_names_changed \(tools 4 → 5\); new content markers: description_url/);
    assert.match(md, /answered with HTTP 402/);
    assert.match(md, /`pay\.example`: x402 — exact base USDC 10000/);
    assert.doesNotMatch(md, /0xabc/); // 수신 주소는 옮기지 않음
    assert.match(md, /Term changes in 30 days: 1 \(last 2026-11-13: amount_changed\)/);
    assert.match(md, /npm `@x\/y`: status found, latest 1\.1\.0, declared version 1\.0\.0 is not the latest\./);
    assert.match(md, /servers\/ai\.trendsmcp\/google-trends\?ref=operator/);
    // 판정 낱말을 만들지 않는다
    assert.doesNotMatch(md, /\b(risky|unsafe|trustworthy|recommend\w*)\b/i);
  });

  test('빈 블록은 기록 없음으로', () => {
    const md = renderOperatorReport({ response: { resolved_target: 'mcp:a.b/c' }, day: '2026-11-15' });
    assert.match(md, /No daily check recorded/);
    assert.match(md, /## Registry declaration and what the server sent\n\n- Not recorded\./);
    assert.match(md, /No change recorded\./);
    assert.match(md, /Not recorded on Lowdown's checks\./);
    assert.doesNotMatch(md, /Declared packages/);
  });

  test('오류 응답·이름 없음은 예외', () => {
    assert.throws(() => renderOperatorReport({ response: { error: 'not_found' }, day: '2026-11-15' }), /error/);
    assert.throws(() => renderOperatorReport({ response: { target: 'npm:x' }, day: '2026-11-15' }), /no MCP Registry name/);
    assert.throws(() => renderOperatorReport({ response: null, day: '2026-11-15' }), /not an object/);
  });

  test('6건 이상이면 개수와 "latest 5 shown"', () => {
    const changes = Array.from({ length: 7 }, (_, i) => ({ on: `2026-11-0${i + 1}`, kind: 'version', old: '1', new: '2' }));
    const md = renderOperatorReport({ response: { resolved_target: 'mcp:a.b/c', registry: { changes_30d: changes } }, day: '2026-11-15' });
    assert.match(md, /MCP Registry entry: 7 changes, latest 5 shown:/);
    assert.equal((md.match(/^  - 2026-11-0\d: version/gm) ?? []).length, 5);
  });

  test('값 안의 줄바꿈·백틱은 지운다', () => {
    const md = renderOperatorReport({ response: { resolved_target: 'mcp:a.b/c', registry: { changes_30d: [{ on: '2026-11-01', kind: 'description\n# injected', old: 'a`b', new: 'c' }] } }, day: '2026-11-15' });
    assert.doesNotMatch(md, /^# injected/m);
    assert.match(md, /description # injected \(`a b` → `c`\)/);
  });
});
