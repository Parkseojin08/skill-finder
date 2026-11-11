// A phone-width window (375×812): the menu keeps every screen reachable, nothing pushes the page wider than the
// window, and the search flow still works.
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures.ts';
import { findSkill, SEARCH } from './support/fixture.ts';

test.use({ viewport: { width: 375, height: 812 } });

const { skill } = findSkill(SEARCH.skill);

/** How far the page can be scrolled sideways (0: it fits the window). */
const sidewaysOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

test.describe('좁은 화면 (375×812)', () => {
  test('메뉴의 모든 화면에 갈 수 있고 옆으로 넘치지 않는다', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('combobox', { name: '검색어' })).toBeVisible();
    expect(await sidewaysOverflow(page), '검색 화면이 창보다 넓음').toBeLessThanOrEqual(1);

    // short labels on a narrow window, but each link keeps its full name
    const menu = page.getByRole('banner').getByRole('navigation');
    for (const name of ['검색', 'README 추천', '설치됨', '즐겨찾기', '마켓플레이스', '설정']) {
      await expect(menu.getByRole('link', { name, exact: true })).toBeAttached();
    }
    const settings = menu.getByRole('link', { name: '설정', exact: true });
    await settings.scrollIntoViewIfNeeded();
    await settings.click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('설정');
    expect(await sidewaysOverflow(page), '설정 화면이 창보다 넓음').toBeLessThanOrEqual(1);
  });

  test('검색하고 스킬을 연다', async ({ page }) => {
    await page.goto('/');
    const box = page.getByRole('combobox', { name: '검색어' });
    await box.fill(SEARCH.query);
    await box.press('Enter');
    const card = page.getByRole('article').filter({ has: page.getByRole('link', { name: skill.name, exact: true }) });
    await expect(card).toBeVisible();
    expect(await sidewaysOverflow(page), '검색 결과가 창보다 넓음').toBeLessThanOrEqual(1);
    await card.getByRole('link', { name: skill.name, exact: true }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(skill.name);
    await expect(page.getByRole('tab', { name: '설치', exact: true })).toBeVisible();
    expect(await sidewaysOverflow(page), '스킬 화면이 창보다 넓음').toBeLessThanOrEqual(1);
  });
});
