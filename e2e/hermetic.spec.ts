// The tests' own ground: the server is the fixed, offline one, and neither it nor the browser can reach the outside.
// If one of these fails, the other tests' results say little (they may have been run against the real network).
import { expect, test } from './fixtures.ts';
import { SKILL_COUNT } from './support/fixture.ts';

const API = { 'X-Skill-Finder': '1' };

test.describe('테스트 환경', () => {
  test('서버: 고정 색인, 토큰·Claude Code 없음, 오프라인', async ({ request }) => {
    const health = await (await request.get('/api/health', { headers: API })).json();
    expect(health).toMatchObject({ skills: SKILL_COUNT, githubToken: false, claudeVersion: null, offline: true });
    // nothing is installed in the server's (new, empty) home folder
    const installed = await (await request.get('/api/installed', { headers: API })).json();
    expect(installed.skills ?? []).toEqual([]);
    expect(installed.plugins ?? []).toEqual([]);
  });

  test('서버의 보안 검사는 그대로다: 헤더 없는 /api 요청과 다른 출처의 변경 요청은 거절', async ({ request }) => {
    expect((await request.get('/api/health')).status()).toBe(403);
    const fromElsewhere = await request.post('/api/search', { headers: { ...API, Origin: 'http://example.com' }, data: { query: 'pdf' } });
    expect(fromElsewhere.status()).toBe(403);
  });

  test('브라우저: 이 PC 밖으로는 나가지 못한다', async ({ page, context }) => {
    // an address that leads nowhere (kept for documentation): refused by the closed proxy port, not after a wait
    const outside = await context.newPage();
    await expect(outside.goto('http://192.0.2.1/', { timeout: 15_000 })).rejects.toThrow(/ERR_PROXY_CONNECTION_FAILED/);
    await outside.close();
    // the app itself, on this PC, loads as usual
    await page.goto('/');
    await expect(page.getByRole('combobox', { name: '검색어' })).toBeVisible();
  });
});
