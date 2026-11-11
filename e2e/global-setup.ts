// Runs once the server answers and before any test: brings it to one known, quiet state.
//   1. The fixed index is in, there is no GitHub token and no Claude Code.
//   2. The startup tasks have ended. The popular-repo collection that follows the first sync is stopped (the same
//      request the "중단" button sends): offline it only waits for its request quota, about 30 seconds.
//   3. The app knows it is offline. It decides so after two requests in a row failed to connect, and searches are
//      what report them, so two throwaway searches are made; from then on every search answers from the local index
//      alone ("오프라인 · 로컬 색인만"), the same in the first test as in the last.
// If the server can still reach the network, step 3 never succeeds and no test runs.
import { API_HEADERS, BASE_URL } from './support/env.ts';
import { SEARCH, SKILL_COUNT } from './support/fixture.ts';

type Health = { offline: boolean; skills: number; githubToken: boolean; claudeVersion: string | null };
type Job = { id: string; kind: string; label: string; status: string };
type Activity = { jobs: Job[]; running: unknown[] };

async function api(path: string, init: { method?: string; body?: unknown } = {}): Promise<string> {
  const res = await fetch(`${BASE_URL}/api${path}`, {
    method: init.method ?? 'GET',
    headers: API_HEADERS,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: AbortSignal.timeout(60_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${init.method ?? 'GET'} /api${path}: ${res.status} ${text.slice(0, 200)}`);
  return text;
}

const health = async () => JSON.parse(await api('/health')) as Health;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export default async function globalSetup(): Promise<void> {
  const start = await health();
  if (start.skills !== SKILL_COUNT) throw new Error(`[e2e] 고정 색인이 들어가지 않았습니다: 스킬 ${start.skills}개 (기대 ${SKILL_COUNT}개)`);
  if (start.githubToken) throw new Error('[e2e] 서버에 GitHub 토큰이 있습니다. 토큰 없이 띄워야 합니다.');
  if (start.claudeVersion) throw new Error(`[e2e] 서버가 Claude Code(${start.claudeVersion})를 찾았습니다. 찾지 못하는 환경이어야 합니다.`);

  // 2. quiet: nothing running in the background
  const stopped = new Set<string>();
  const deadline = Date.now() + 120_000;
  for (;;) {
    const activity = JSON.parse(await api('/activity')) as Activity;
    const busy = activity.jobs.filter((j) => j.status === 'running' || j.status === 'paused');
    for (const job of busy) {
      if (job.kind !== 'collect' || stopped.has(job.id)) continue;
      stopped.add(job.id);
      await api(`/jobs/${job.id}/cancel`, { method: 'POST' }).catch(() => {}); // it may just have ended
    }
    if (busy.length === 0 && activity.running.length === 0) break;
    if (Date.now() > deadline) throw new Error(`[e2e] 서버의 시작 작업이 끝나지 않습니다: ${JSON.stringify(busy.map((j) => `${j.kind}:${j.label}`))}`);
    await sleep(250);
  }

  // 3. offline
  for (const query of SEARCH.warmUp) {
    if ((await health()).offline) break;
    await api('/search', { method: 'POST', body: { query } });
  }
  if (!(await health()).offline) {
    throw new Error(
      '[e2e] 서버가 오프라인 상태가 되지 않았습니다. 바깥 요청이 막히지 않았거나(실제 skills.sh가 응답함) 오프라인 판정 방식이 바뀌었습니다. ' +
        'e2e/server/launch.ts의 차단 설정과 server/src/scheduler.ts의 isOffline을 확인하세요.',
    );
  }
}
