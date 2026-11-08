// scanner/rest-retry.ts
// Supabase REST 읽기용: 5xx·네트워크 오류는 짧게 재시도하고, 실패하면 응답 본문(PostgREST code·message)을 에러에 붙인다.
// 읽기 요청 전용 — 쓰기 요청에는 쓰지 않는다.

const RETRY_STATUS = new Set([500, 502, 503, 504]);
const RETRY_DELAYS_MS = [10_000, 30_000];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function readErrorBody(res: Response, max = 300): Promise<string> {
  try {
    const t = (await res.text()).replace(/\s+/g, ' ').trim();
    return t.length > max ? `${t.slice(0, max)}…` : t;
  } catch {
    return '';
  }
}

/** init 은 시도마다 새로 만든다(AbortSignal.timeout 은 한 번만 쓸 수 있음). */
export async function fetchRetry(
  url: string,
  init: () => RequestInit,
  label: string,
  delays: readonly number[] = RETRY_DELAYS_MS,
): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const canRetry = attempt < delays.length;
    let res: Response;
    try {
      res = await fetch(url, init());
    } catch (e) {
      if (!canRetry) throw e;
      console.warn(`${label}: ${(e as Error).name ?? 'error'} — retry ${attempt + 1} in ${delays[attempt]! / 1000}s`);
      await sleep(delays[attempt]!);
      continue;
    }
    if (res.ok) return res;
    const body = await readErrorBody(res);
    if (RETRY_STATUS.has(res.status) && canRetry) {
      console.warn(`${label}: HTTP ${res.status} ${body} — retry ${attempt + 1} in ${delays[attempt]! / 1000}s`);
      await sleep(delays[attempt]!);
      continue;
    }
    throw new Error(`${label} failed: HTTP ${res.status} ${body}`.trim());
  }
}
