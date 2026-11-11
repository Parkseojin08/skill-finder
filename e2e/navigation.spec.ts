// Every screen of the menu opens, by its link and by its address, shows its own title, and logs no error
// (the `problems` fixture fails a test whose page logged one).
import { expect, test } from './fixtures.ts';

/** The menu's screens: the link's name, the address it leads to, the screen's title (its only visible H1). */
const SCREENS = [
  { menu: 'README 추천', path: '/recommend', title: 'README 추천' },
  { menu: '설치됨', path: '/installed', title: '설치됨' },
  { menu: '즐겨찾기', path: '/favorites', title: '즐겨찾기' },
  { menu: '마켓플레이스', path: '/marketplaces', title: '마켓플레이스' },
  { menu: '설정', path: '/settings', title: '설정' },
];

test.describe('메뉴의 화면들', () => {
  test('메뉴 링크로 각 화면에 간다', async ({ page }) => {
    await page.goto('/');
    const menu = page.getByRole('banner').getByRole('navigation');
    for (const screen of SCREENS) {
      const link = menu.getByRole('link', { name: screen.menu, exact: true });
      await link.click();
      await expect(page).toHaveURL(new RegExp(`${screen.path}$`));
      // the screens not shown are hidden, not removed: exactly one title is visible
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(screen.title);
      await expect(link).toHaveAttribute('aria-current', 'page');
      await expect(page).toHaveTitle(new RegExp(screen.title));
    }
    // and back to the search
    await menu.getByRole('link', { name: '검색', exact: true }).click();
    await expect(page.getByRole('combobox', { name: '검색어' })).toBeVisible();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('스킬 검색');
  });

  for (const screen of SCREENS) {
    test(`주소로 바로 연다: ${screen.path}`, async ({ page }) => {
      await page.goto(screen.path);
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(screen.title);
      await expect(page.getByRole('banner').getByRole('link', { name: screen.menu, exact: true })).toHaveAttribute('aria-current', 'page');
      // what the screen reads from the server has arrived (nothing on screen still says "불러오는 중…")
      await expect(page.getByRole('main').getByText('불러오는 중…').filter({ visible: true })).toHaveCount(0);
    });
  }
});
