// 샌드박스 서버 감시 — GitHub Actions 에서 매일 실행(읽기만). 서버가 멈췄으면 실패 → 워크플로가 이슈를 연다.
//   기준: sandbox_batches 의 가장 최근 started_at 이 SANDBOX_STALE_HOURS(기본 36) 시간보다 오래됨
//   아직 한 번도 돈 적이 없으면(행 없음) 통과(파일럿 시작 전). 사용: node sandbox/watchdog.ts
import { latestBatchStartedAt } from './sandbox-io.ts';

const url = process.env.LOWDOWN_SUPABASE_URL?.trim();
const key = process.env.LOWDOWN_SCANNER_KEY?.trim();
if (!url || !key) {
  console.error('::error::LOWDOWN_SUPABASE_URL / LOWDOWN_SCANNER_KEY 가 없습니다.');
  process.exit(1);
}
const staleHours = Number(process.env.SANDBOX_STALE_HOURS) > 0 ? Number(process.env.SANDBOX_STALE_HOURS) : 36;

const last = await latestBatchStartedAt({ url, key });
if (last === null) {
  console.log('sandbox: no batches yet');
  process.exit(0);
}
const ageH = (Date.now() - Date.parse(last)) / 3_600_000;
console.log(`sandbox: last batch ${last} (${ageH.toFixed(1)}h ago, limit ${staleHours}h)`);
if (!(ageH <= staleHours)) {
  console.error(`::error::sandbox server has not run for ${ageH.toFixed(1)}h`);
  process.exit(1);
}
