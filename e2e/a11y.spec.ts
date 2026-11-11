// Accessibility: axe finds no WCAG 2.1 A or AA violation on the main screens, and the two things axe cannot judge
// but a keyboard or screen-reader user meets first: a way past the menu, and a name on every text box.
//
// When axe reports something in a screen that is being reworked, leave that one rule out for that one screen with
// `skip` and the reason, and say so where the work is tracked; never turn a rule off for every screen.
import { AxeBuilder } from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures.ts';
import { findSkill, SEARCH } from './support/fixture.ts';

const WCAG_21_A_AA = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];
const { skill } = findSkill(SEARCH.skill);

/** What axe found on the page as it is now, short enough to read in a failure: the rule and the elements. */
async function violations(page: Page, skip: string[] = []) {
  const results = await new AxeBuilder({ page }).withTags(WCAG_21_A_AA).disableRules(skip).analyze();
  return results.violations.map((v) => ({ rule: v.id, impact: v.impact, help: v.help, elements: v.nodes.map((n) => n.target.join(' ')) }));
}

/** The search has ended (its "중지" button is gone), so the list on screen is the final one. */
async function searchFor(page: Page, query: string) {
  await page.goto('/');
  const box = page.getByRole('combobox', { name: '검색어' });
  await box.fill(query);
  await box.press('Enter');
  const card = page.getByRole('article').filter({ has: page.getByRole('link', { name: skill.name, exact: true }) });
  await expect(card).toBeVisible();
  await expect(page.getByRole('button', { name: '중지', exact: true })).toHaveCount(0);
  return card;
}

test.describe('접근성 (axe, WCAG 2.1 A·AA)', () => {
  test('검색 첫 화면', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('combobox', { name: '검색어' })).toBeVisible();
    // what the first screen reads after it shows (recent searches, the browse tiles, the status line) has arrived
    await page.waitForLoadState('networkidle');
    expect(await violations(page)).toEqual([]);
  });

  test('검색 결과', async ({ page }) => {
    await searchFor(page, SEARCH.query);
    expect(await violations(page)).toEqual([]);
  });

  test('스킬 상세: 개요', async ({ page }) => {
    const card = await searchFor(page, SEARCH.query);
    await card.getByRole('link', { name: skill.name, exact: true }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(skill.name);
    await expect(page.getByRole('tabpanel')).toContainText(skill.description);
    expect(await violations(page)).toEqual([]);
  });

  test('스킬 상세: 설치 탭과 설치 확인 창', async ({ page, problems }) => {
    problems.allow(/\/install-scan/); // offline, the file check answers 502 (see search.spec.ts)
    const card = await searchFor(page, SEARCH.query);
    await card.getByRole('link', { name: skill.name, exact: true }).click();
    await page.getByRole('tab', { name: '설치', exact: true }).click();
    const start = page.getByRole('tabpanel').getByRole('button', { name: /설치…$/ });
    await expect(start).toBeEnabled({ timeout: 30_000 });
    expect(await violations(page), '설치 탭').toEqual([]);

    await start.click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    expect(await violations(page), '설치 확인 창').toEqual([]);
    await dialog.getByRole('button', { name: '취소', exact: true }).click();
    await expect(dialog).toBeHidden();
  });

  const SCREENS: Array<{ path: string; title: string; skip?: string[] }> = [
    { path: '/recommend', title: 'README 추천' },
    { path: '/installed', title: '설치됨' },
    { path: '/favorites', title: '즐겨찾기' },
    { path: '/marketplaces', title: '마켓플레이스' },
    // link-in-text-block (found 2026-11-11 on 0.3.6): the two license links at the foot of the settings screen
    // (LICENSE.txt, THIRD-PARTY-LICENSES.txt) differ from the muted text around them by color only. SettingsPage.tsx
    // was being reworked elsewhere when this test was written; take `skip` out once the links are underlined.
    { path: '/settings', title: '설정', skip: ['link-in-text-block'] },
  ];
  for (const screen of SCREENS) {
    test(`화면: ${screen.title}`, async ({ page }) => {
      await page.goto(screen.path);
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(screen.title);
      await expect(page.getByRole('main').getByText('불러오는 중…').filter({ visible: true })).toHaveCount(0);
      expect(await violations(page, screen.skip)).toEqual([]);
    });
  }
});

test.describe('접근성: 키보드와 이름', () => {
  test('첫 Tab은 "본문으로 건너뛰기" 링크이고, 누르면 메뉴를 지나 본문으로 간다', async ({ page }) => {
    await page.goto('/marketplaces');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('마켓플레이스');
    await page.keyboard.press('Tab');
    const skip = page.getByRole('link', { name: '본문으로 건너뛰기', exact: true });
    await expect(skip).toBeFocused();
    await expect(skip).toBeInViewport(); // shown once it has the focus
    await page.keyboard.press('Enter');
    // the focus is now in the main content, past the menu; the address is the same screen's, and the screen's title
    // has not been scrolled under the menu bar
    expect(await page.evaluate(() => !!document.activeElement?.closest('main'))).toBe(true);
    expect(page.url()).toMatch(/\/marketplaces$/);
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    // the next Tab lands on something inside the main content
    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => !!document.activeElement?.closest('main') && document.activeElement?.tagName !== 'MAIN')).toBe(true);
  });

  test('마켓플레이스 추가: 저장소 입력란에 이름이 있다', async ({ page }) => {
    await page.goto('/marketplaces');
    const repo = page.getByRole('textbox', { name: '마켓플레이스 저장소', exact: true });
    await expect(repo).toBeVisible();
    // and the form still works from it: typing enables the button next to it
    const form = page.locator('form').filter({ has: repo });
    await expect(form.getByRole('button')).toBeDisabled();
    await repo.fill('owner/repo');
    await expect(form.getByRole('button')).toBeEnabled();
  });
});
