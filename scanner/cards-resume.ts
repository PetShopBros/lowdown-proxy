// scanner/cards-resume.ts — 서버 카드 이어 만들기 판단 (2026-11-12). scanner/cards.ts 가 쓴다.
// cards.ts 는 import 하면 바로 실행되므로 판단 함수만 여기 두고 테스트한다(scanner/cards.test.ts).

import { cardUsable } from "../api/reputation/[target].ts";

/** 요약(target_status_summary)에서 카드 판단에 쓰는 값. 카드 열과 같은 뜻(shapeStatus → cardColumns). */
export type SummaryRow = {
  target_id: string;
  latest_day: string | null;
  latest_state: string | null;
  observed_days_30d: number | null;
  answered_days_30d: number | null;
  streak_days: number | null;
};
/** 이미 있는 카드의 판단용 열 */
export type CardRow = {
  target_id: string;
  built_at: string | null;
  builder_version: string | null;
  latest_day: string | null;
  latest_state: string | null;
  observed_days_30d: number | null;
  answered_days_30d: number | null;
  consecutive_days: number | null;
};

/**
 * 다시 만들어야 하나.
 *  - 카드 없음 / 다른 조리 버전 / 오늘 쓸 수 없는 카드(cardUsable: 오늘 UTC 04:00 이전) → 만든다
 *  - 오늘 카드가 있으면 요약 값(마지막 점검일·상태·30일 관측·응답일·연속일)이 카드와 다를 때만 만든다
 *    (오후 실행: 예비 스캔·14:37 요약 갱신으로 바뀐 대상만)
 */
export function needsBuild(s: SummaryRow, card: CardRow | undefined, now: number, version: string): boolean {
  if (!card) return true;
  if (card.builder_version !== version) return true;
  if (!cardUsable(card.built_at, now)) return true;
  const day = (v: string | null) => (typeof v === "string" ? v.slice(0, 10) : null);
  const num = (v: number | null | undefined) => (typeof v === "number" ? v : null);
  if (day(s.latest_day) !== day(card.latest_day)) return true;
  if ((s.latest_state ?? null) !== (card.latest_state ?? null)) return true;
  if (num(s.observed_days_30d) !== num(card.observed_days_30d)) return true;
  if (num(s.answered_days_30d) !== num(card.answered_days_30d)) return true;
  if (num(s.streak_days) !== num(card.consecutive_days)) return true;
  return false;
}
