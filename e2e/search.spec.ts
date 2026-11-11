// The main flow: type a query, get result cards, open one, look at its tabs, and go as far as the install
// confirmation without installing. Written against roles and names (the search box, the tabs, the skill's own
// name), so more buttons, columns or chips on these screens do not break it.
import { expect, test } from './fixtures.ts';
import { findSkill, SEARCH } from './support/fixture.ts';

const { plugin, skill } = findSkill(SEARCH.skill);

test.describe('검색 흐름', () => {
  test('검색창에 이름 앞부분을 치면 제안 목록이 뜬다', async ({ page }) => {
    await page.goto('/');
    const box = page.getByRole('combobox', { name: '검색어' });
    // key by key, as a person types: the list is asked for after a short pause in typing
    await box.pressSequentially(SEARCH.prefix, { delay: 50 });
    const list = page.getByRole('listbox');
    await expect(list).toBeVisible();
    await expect(box).toHaveAttribute('aria-expanded', 'true');
    await expect(list.getByRole('option').filter({ hasText: SEARCH.skill }).first()).toBeVisible();
    // Esc closes the list and leaves what was typed
    await box.press('Escape');
    await expect(list).toBeHidden();
    await expect(box).toHaveValue(SEARCH.prefix);
  });

  test('검색 → 결과 카드 → 스킬 상세의 탭 → 설치 확인 창에서 취소', async ({ page, problems }) => {
    // Offline, the server cannot read the files an install would bring: that one request answers 502 and the install
    // tab says so (the install then needs a deliberate tick). The browser logs the 502 as a console error.
    problems.allow(/\/install-scan/);
    const installRequests: string[] = [];
    page.on('request', (req) => {
      if (req.method() !== 'GET' && /\/api\/(install|uninstall)$/.test(new URL(req.url()).pathname)) installRequests.push(req.url());
    });

    await page.goto('/');
    const box = page.getByRole('combobox', { name: '검색어' });
    await box.fill(SEARCH.query);
    await box.press('Enter');

    // a result card is an article whose title links to the skill
    const card = page.getByRole('article').filter({ has: page.getByRole('link', { name: skill.name, exact: true }) });
    await expect(card).toBeVisible();
    await expect(card).toContainText(skill.description);
    await card.getByRole('link', { name: skill.name, exact: true }).click();

    // the skill's own screen
    await expect(page).toHaveURL(/\/skill\?id=/);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(skill.name);
    const tab = (name: string | RegExp) => page.getByRole('tab', { name, exact: typeof name === 'string' });
    const panel = page.getByRole('tabpanel');
    for (const name of ['개요', '설치', 'SKILL.md', /^파일/]) await expect(tab(name)).toBeVisible();
    await expect(tab('개요')).toHaveAttribute('aria-selected', 'true');
    await expect(panel).toContainText(skill.description);

    await tab('SKILL.md').click();
    await expect(tab('SKILL.md')).toHaveAttribute('aria-selected', 'true');
    await expect(panel).toBeVisible();

    await tab(/^파일/).click();
    await expect(tab(/^파일/)).toHaveAttribute('aria-selected', 'true');
    for (const file of skill.files ?? []) await expect(panel.getByText(file.path, { exact: true })).toBeVisible();

    // the install tab: what would run, and the button that opens the confirmation
    await tab('설치').click();
    await expect(tab('설치')).toHaveAttribute('aria-selected', 'true');
    await expect(panel).toContainText(`${plugin.name}@${plugin.marketplace}`);
    const start = panel.getByRole('button', { name: /설치…$/ });
    await expect(start).toBeEnabled({ timeout: 30_000 }); // once the preview and the file check have answered

    // the confirmation names the skill; it is cancelled, never confirmed
    await start.click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('heading')).toContainText(skill.name);
    await dialog.getByRole('button', { name: '취소', exact: true }).click();
    await expect(dialog).toBeHidden();
    expect(installRequests, '설치 요청은 보내지 않습니다').toEqual([]);

    // back in the results: the search screen kept them while the skill was open
    await page.goBack();
    await expect(card).toBeVisible();
    await expect(box).toHaveValue(SEARCH.query);
  });
});
