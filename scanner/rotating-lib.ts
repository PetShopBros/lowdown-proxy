// 바깥 고리(순환 관찰) — 고정 코호트 밖의 점검 가능한 Registry 대상을 ROTATION_DAYS 묶음으로 나눠 하루 한 묶음씩 본다.
// 설계: 프로젝트 문서 claude/lowdown-rotating-ring-2026-11-06.md
//   묶음 = sha256(Registry 이름) mod days (늘 같은 묶음, 배정 표 없음). 오늘 묶음 = UTC 날짜 번호 mod days.
//   고정 코호트(매일)·그날 조회 대상(매일)에 든 대상은 뺀다 → 같은 날 같은 대상 행이 두 줄 생기지 않는다.
//   days = 1 이면 바깥 고리도 매일, 0 이면 끔. 관찰 행: source = 'scanner_rotating', metadata.observation_basis = 'rotating'.
//   보고서·시장판·일일 기록은 source = 'scanner'(고정 코호트)만 집계하므로 표본 통계는 바뀌지 않는다.

import { createHash } from 'node:crypto';

export const ROTATING_SOURCE = 'scanner_rotating';
export const ROTATING_VERSION = 'rotating';
/** 기본은 끔. 상태 계산 v2(supabase/2026-11-06_target_status_v2.sql)를 적용한 뒤 저장소 변수 ROTATION_DAYS 로 켠다. */
export const DEFAULT_ROTATION_DAYS = 0;
export const MAX_ROTATION_DAYS = 7;
const DAY_MS = 86_400_000;

export function rotationGroupOf(name: string, days: number): number {
  if (days <= 1) return 0;
  return createHash('sha256').update(name).digest().readUInt32BE(0) % days;
}

export function rotationGroupForDay(now: number, days: number): number {
  if (days <= 1) return 0;
  return Math.floor(now / DAY_MS) % days;
}

/**
 * 오늘 볼 바깥 고리 대상(target_id 'mcp:<이름>').
 * @param names   점검 가능한 Registry 이름(registry.targets 의 name)
 * @param exclude 오늘 다른 줄이 이미 보는 target_id(고정 코호트·조회 대상)
 */
export function pickRotating(names: readonly string[], exclude: ReadonlySet<string>, days: number, now: number): { ids: string[]; group: number; outside: number } {
  if (days <= 0) return { ids: [], group: 0, outside: 0 };
  const group = rotationGroupForDay(now, days);
  const ids: string[] = [];
  let outside = 0;
  for (const n of [...new Set(names)].sort()) {
    const id = `mcp:${n}`;
    if (exclude.has(id)) continue;
    outside++;
    if (rotationGroupOf(n, days) === group) ids.push(id);
  }
  return { ids, group, outside };
}

export function rotationMeta(days: number, group: number) {
  return { cohort_version: ROTATING_VERSION, cohort_versions: [ROTATING_VERSION], observation_basis: 'rotating', rotation: { days, group } };
}
