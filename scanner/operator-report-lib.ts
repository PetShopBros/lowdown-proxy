// 서버 운영자용 1쪽 관측 요약 (2026-11-15) — 공개 조회 응답(GET /api/reputation/<이름>) 하나를 Markdown 으로 옮긴다.
// 순수 함수만: 네트워크·파일 쓰기 없음. 실행은 scanner/operator-report.ts.
// 원칙
//   - 조회 응답에 있는 사실만 옮긴다. 판정·점수·권고 문장을 만들지 않는다.
//   - 링크에는 ref=operator 를 붙인다(access_daily 에서 이 경로를 따로 센다).
//   - 비어 있는 블록은 "recorded 없음"으로 쓰고 추측하지 않는다.

export const SITE = 'https://lowdown-proxy.vercel.app';
export const REF = 'operator';
const NAME_RE = /^[A-Za-z0-9._-]{1,200}\/[A-Za-z0-9._-]{1,200}$/;
const MAX_EVENTS = 5;

type J = Record<string, any>;
const obj = (v: unknown): J | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as J) : null);
const arr = (v: unknown): any[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
/** 표 칸·목록에 넣을 값: 줄바꿈·파이프·백틱 제거, 길이 제한 */
const cell = (v: unknown, max = 120): string => String(v ?? '').replace(/[\r\n|`]+/g, ' ').trim().slice(0, max);
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** 'mcp:ns/name' 또는 'ns/name' → 'ns/name'. 형식이 아니면 null */
export function registryName(input: string): string | null {
  const s = input.startsWith('mcp:') ? input.slice(4) : input;
  return NAME_RE.test(s) ? s : null;
}

export function pageUrl(name: string): string {
  return `${SITE}/servers/${name}?ref=${REF}`;
}

function sinceText(s: J | null, what: string): string {
  if (!s || typeof s.match !== 'boolean') return '';
  const state = s.match ? 'matched' : 'differed';
  if (str(s.state_since)) return ` The ${what} has ${state} on every comparable check since ${s.state_since}.`;
  if (s.throughout_window === true) return ` The ${what} ${state} on every comparable check in the last 30 days.`;
  return '';
}

function statusSection(r: J): string[] {
  const st = obj(r.status);
  const out = ['## Daily checks (last 30 days)', ''];
  if (!st) return [...out, '- No daily check recorded for this server.', ''];
  const c = obj(st.checks_30d) ?? {};
  out.push(`- Latest check: ${cell(st.latest_check)}, result \`${cell(st.state)}\`${num(st.tool_count) !== null ? `, ${plural(st.tool_count, 'tool')} listed` : ''}.`);
  const parts = [
    `answered ${num(c.answered) ?? 0}`,
    `authentication required ${num(c.auth_required) ?? 0}`,
    `no response ${num(c.no_response) ?? 0}`,
    `mixed ${num(c.mixed) ?? 0}`,
  ];
  out.push(`- ${plural(num(c.observed) ?? 0, 'check')} recorded: ${parts.join(', ')}.`);
  if (num(st.consecutive_days)) out.push(`- Same result on ${plural(st.consecutive_days, 'consecutive day')}${str(st.consecutive_since) ? ` since ${st.consecutive_since}` : ''}.`);
  out.push('- Method: one check per day from one network location (GitHub Actions): `initialize`, then `tools/list`. No tool calls, no credentials.', '');
  return out;
}

function declaredSection(r: J): string[] {
  const dvo = obj(obj(r.scanner)?.declared_vs_observed);
  const reg = obj(r.registry);
  const out = ['## Registry declaration and what the server sent', ''];
  if (!dvo && !reg) return [...out, '- Not recorded.', ''];
  const since = obj(dvo?.since);
  const dv = str(dvo?.declared_version) ?? str(reg?.declared_version);
  const ov = str(dvo?.observed_server_version);
  if (dv || ov) {
    out.push(`- Version: the MCP Registry declares \`${cell(dv ?? 'none')}\`; the server sent \`serverInfo.version\` \`${cell(ov ?? 'none')}\`.${sinceText(obj(since?.version), 'version')}`);
  }
  const dh = arr(dvo?.declared_hosts ?? reg?.remote_hosts).map((h) => cell(h));
  const oh = arr(dvo?.observed_hosts).map((h) => cell(h));
  if (dh.length || oh.length) {
    out.push(`- Hosts: declared ${dh.length ? dh.map((h) => `\`${h}\``).join(', ') : 'none'}; observed ${oh.length ? oh.map((h) => `\`${h}\``).join(', ') : 'none'}.${sinceText(obj(since?.hosts), 'host list')}`);
  }
  const cards = obj(dvo?.cards);
  if (cards?.checked === true) {
    const items: string[] = [];
    for (const rm of arr(cards.remotes)) {
      const sc = obj(rm?.server_card);
      if (sc) items.push(`\`${cell(sc.url)}\`: ${cell(sc.outcome)}${num(sc.http_status) ? ` (HTTP ${sc.http_status})` : ''}`);
    }
    for (const h of arr(cards.hosts)) {
      for (const k of ['mcp_well_known', 'ai_catalog', 'a2a_agent_card']) {
        const c = obj(h?.[k]);
        if (c) items.push(`\`${cell(c.url)}\`: ${cell(c.outcome)}${num(c.http_status) ? ` (HTTP ${c.http_status})` : ''}`);
      }
    }
    if (items.length) {
      const day = str(arr(cards.remotes)[0]?.checked_on) ?? str(arr(cards.hosts)[0]?.checked_on);
      out.push(`- Server and host cards${day ? ` (checked ${day})` : ''}:`, ...items.slice(0, 6).map((i) => `  - ${i}`));
      out.push('  - Outcome terms are defined in the `cards.basis` text of the JSON record.');
    }
  }
  out.push('');
  return out;
}

function changesSection(r: J): string[] {
  const out = ['## Changes recorded in the last 30 days', ''];
  const reg = obj(r.registry);
  const rc = arr(reg?.changes_30d);
  if (rc.length) {
    out.push(`- MCP Registry entry: ${plural(rc.length, 'change')}${rc.length > MAX_EVENTS ? `, latest ${MAX_EVENTS} shown` : ''}:`);
    for (const c of rc.slice(0, MAX_EVENTS)) {
      const vals = str(c?.old) || str(c?.new) ? ` (\`${cell(c.old ?? '', 60)}\` → \`${cell(c.new ?? '', 60)}\`)` : '';
      out.push(`  - ${cell(c?.on)}: ${cell(c?.kind)}${vals}`);
    }
  } else if (reg) out.push('- MCP Registry entry: no change recorded.');
  const dc = obj(obj(r.scanner)?.definition_changes);
  if (dc && num(dc.compared_days)) {
    const ev = arr(dc.events);
    out.push(`- Tool definitions: changed on ${plural(num(dc.change_days) ?? 0, 'day')} of ${plural(dc.compared_days, 'compared day')}${str(dc.last_change) ? `; last change ${dc.last_change}` : ''}${ev.length > MAX_EVENTS ? `; latest ${MAX_EVENTS} shown` : ''}.`);
    for (const e of ev.slice(0, MAX_EVENTS)) {
      const tc = obj(e?.tool_count);
      const flags = arr(e?.new_flags).map((f) => cell(f?.rule)).filter(Boolean);
      out.push(`  - ${cell(e?.day)}: ${arr(e?.kinds).map((k) => cell(k)).join(', ')}${tc ? ` (tools ${tc.from} → ${tc.to})` : ''}${e?.returned_to_earlier_definition === true ? ', returned to an earlier definition' : ''}${flags.length ? `; new content markers: ${flags.join(', ')}` : ''}`);
    }
  }
  if (out.length === 2) out.push('- No change recorded.');
  out.push('');
  return out;
}

function paymentSection(r: J): string[] {
  const p = obj(r.payment);
  const out = ['## Payment (HTTP 402)', ''];
  const o = obj(p?.observed);
  if (!o) out.push('- Not recorded on Lowdown\'s checks.');
  else {
    out.push(`- Latest check (${cell(o.latest_check)}): ${o.payment_required ? 'answered with HTTP 402' : 'no HTTP 402'}.`);
    for (const rm of arr(o.remotes).slice(0, 3)) {
      const opts = arr(rm?.options).slice(0, 3).map((x) => [x?.scheme, x?.network, x?.asset, x?.amount].filter((v) => v !== undefined && v !== null).map((v) => cell(v, 60)).join(' '));
      out.push(`  - \`${cell(rm?.remote_host ?? 'remote')}\`: ${cell(rm?.protocol ?? 'terms recorded')}${opts.length ? ` — ${opts.join('; ')}` : ''}`);
    }
    const h = obj(o.history_30d);
    if (h) {
      const lc = obj(h.last_change);
      out.push(`- Term changes in 30 days: ${num(h.changes) ?? 0}${lc ? ` (last ${cell(lc.day)}: ${arr(lc.kinds).map((k) => cell(k)).join(', ')})` : ''}.`);
    }
  }
  const d = arr(p?.declared);
  if (d.length) out.push(`- Payment support declared in a card or registration file: ${d.slice(0, 3).map((x) => `${arr(x?.protocols).map((v) => cell(v)).join('/')} (${cell(x?.source)}, ${cell(x?.checked_on)})`).join('; ')}.`);
  out.push('- Lowdown does not pay and does not call tools, so payment asked only at tool call time is not seen.', '');
  return out;
}

function packagesSection(r: J): string[] {
  const pk = arr(r.packages);
  if (!pk.length) return [];
  const out = ['## Declared packages', ''];
  for (const p of pk.slice(0, 5)) {
    const info = obj(p?.npm) ?? obj(p?.pypi);
    const bits: string[] = [];
    if (info) {
      bits.push(`status ${cell(info.status)}`);
      if (str(info.latest)) bits.push(`latest ${cell(info.latest)}`);
      if (info.latest_deprecated === true) bits.push('latest marked deprecated');
      if (info.declared_is_latest === false) bits.push(`declared version ${cell(p?.declared_version)} is not the latest`);
      if (str(info.not_found_since)) bits.push(`404 since ${cell(info.not_found_since)}`);
    } else if (str(p?.note)) bits.push(cell(p.note));
    out.push(`- ${cell(p?.registry)} \`${cell(p?.name)}\`: ${bits.join(', ') || 'not checked'}.`);
  }
  out.push('');
  return out;
}

export interface OperatorReportInput {
  response: unknown;
  /** 보고서를 만든 날 (UTC, YYYY-MM-DD) */
  day: string;
}

/** 조회 응답 → Markdown. 응답에 Registry 이름이 없으면 예외 */
export function renderOperatorReport({ response, day }: OperatorReportInput): string {
  const r = obj(response);
  if (!r) throw new Error('lookup response is not an object');
  if (str(r.error)) throw new Error(`lookup answered with an error: ${cell(r.error)}`);
  const name = registryName(str(r.resolved_target) ?? str(r.target) ?? '');
  if (!name) throw new Error('lookup response has no MCP Registry name (resolved_target)');
  const retrieved = str(obj(r.source)?.retrieved_at);
  const lines = [
    `# Lowdown observation summary: ${name}`,
    '',
    `Prepared ${day} (UTC) from Lowdown's public record${retrieved ? ` (retrieved ${retrieved})` : ''}. These are dated facts as Lowdown recorded them, not a score, a review or a judgment about the server.`,
    '',
    ...statusSection(r),
    ...declaredSection(r),
    ...changesSection(r),
    ...paymentSection(r),
    ...packagesSection(r),
    '## Check or correct this record',
    '',
    `- Server page: ${pageUrl(name)}`,
    `- Same data as JSON: ${SITE}/api/reputation/mcp:${name}`,
    `- Something wrong or missing? Reply to this message, or send it to ${SITE}/api/feedback.`,
    `- Data: https://github.com/PetShopBros/lowdown-data (CC BY 4.0). Method and definitions: ${SITE}/llms.txt`,
    '',
  ];
  return lines.join('\n');
}
