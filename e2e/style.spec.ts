// The page is styled. On 2026-11-05 a component's `@layer app` stylesheet got into the bundle ahead of the layer
// order declared in index.css; `app` became the weakest layer, Tailwind's reset (layer base) beat every app rule and
// all screens lost their look, while every test passed. These tests read the running page: the order of the cascade
// layers as the browser sees them, and a few computed styles that the reset zeroes when it wins.
// No screenshots: fonts differ between systems.
import type { Locator, Page } from '@playwright/test';
import { expect, test } from './fixtures.ts';

/** Top-level cascade layers in the order the document declares them (the first mention of a name places it). */
function layerOrder(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const order: string[] = [];
    const note = (name: string) => {
      // "a.b" is a sub-layer of a: only the top level orders the app's stylesheet against Tailwind's
      const top = name.split('.')[0];
      if (top && !order.includes(top)) order.push(top);
    };
    const walk = (rules: CSSRuleList) => {
      for (const rule of Array.from(rules)) {
        if (rule instanceof CSSLayerStatementRule) rule.nameList.forEach(note);
        else if (rule instanceof CSSLayerBlockRule) note(rule.name);
        else if (rule instanceof CSSImportRule) {
          if (rule.layerName) note(rule.layerName);
          if (rule.styleSheet) walk(rule.styleSheet.cssRules);
        } else if (rule instanceof CSSMediaRule) {
          if (window.matchMedia(rule.conditionText).matches) walk(rule.cssRules);
        } else if (rule instanceof CSSSupportsRule) {
          if (CSS.supports(rule.conditionText)) walk(rule.cssRules);
        }
      }
    };
    for (const sheet of Array.from(document.styleSheets)) walk(sheet.cssRules);
    return order;
  });
}

const px = (locator: Locator, property: string) => locator.evaluate((el, prop) => parseFloat(getComputedStyle(el).getPropertyValue(prop)), property);

/** A design token (`--bg`) as the color the browser computes for it, and that color's brightness (0 black, 1 white). */
function token(page: Page, name: string): Promise<{ color: string; brightness: number }> {
  return page.evaluate((variable) => {
    const probe = document.createElement('span');
    probe.style.color = `var(${variable})`;
    document.body.append(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    const [r = 0, g = 0, b = 0] = (color.match(/[\d.]+/g) ?? []).map(Number);
    return { color, brightness: (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 };
  }, name);
}

test.describe('모양: 스타일이 적용되어 있다', () => {
  test('캐스케이드 레이어 순서는 theme, base 다음에 app, 그다음 utilities', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('combobox', { name: '검색어' })).toBeVisible();
    const order = await layerOrder(page);
    for (const name of ['theme', 'base', 'app', 'utilities']) expect(order, `레이어 ${name}이(가) 있어야 합니다`).toContain(name);
    // a later layer wins: the app's rules must beat Tailwind's reset (base) and lose to utility classes
    expect(order.indexOf('theme'), `레이어 순서: ${order.join(', ')}`).toBeLessThan(order.indexOf('app'));
    expect(order.indexOf('base'), `레이어 순서: ${order.join(', ')}`).toBeLessThan(order.indexOf('app'));
    expect(order.indexOf('app'), `레이어 순서: ${order.join(', ')}`).toBeLessThan(order.indexOf('utilities'));
  });

  test('검색 화면: 메뉴·검색창·버튼에 앱 스타일이 살아 있다', async ({ page }) => {
    await page.goto('/');
    const search = page.getByRole('combobox', { name: '검색어' });
    await expect(search).toBeVisible();

    // Tailwind's reset sets padding and border of every element to 0; the app's rules give them back
    const menuLink = page.getByRole('banner').getByRole('link', { name: '설정', exact: true });
    expect(await px(menuLink, 'padding-left'), '메뉴 링크의 왼쪽 안쪽 여백').toBeGreaterThan(0);
    expect(await px(menuLink, 'padding-right'), '메뉴 링크의 오른쪽 안쪽 여백').toBeGreaterThan(0);

    const searchBox = page.locator('form').filter({ has: search });
    expect(await px(searchBox, 'border-top-width'), '검색창 테두리').toBeGreaterThan(0);
    expect(await px(searchBox, 'padding-left'), '검색창 안쪽 여백').toBeGreaterThan(0);

    const submit = searchBox.getByRole('button', { name: '검색', exact: true });
    expect(await px(submit, 'border-top-width'), '검색 버튼 테두리').toBeGreaterThan(0);
    expect(await px(submit, 'padding-left'), '검색 버튼 안쪽 여백').toBeGreaterThan(0);

    // the dark theme's tokens are there and the page uses them
    const background = await token(page, '--bg');
    const text = await token(page, '--text');
    expect(background.brightness, `--bg ${background.color}`).toBeLessThan(0.1);
    expect(text.brightness, `--text ${text.color}`).toBeGreaterThan(0.7);
    const body = page.locator('body');
    await expect(body).toHaveCSS('background-color', background.color);
    await expect(body).toHaveCSS('color', text.color);
  });

  test('제목이 있는 화면: 제목 크기와 표 칸 여백이 살아 있다', async ({ page }) => {
    await page.goto('/marketplaces');
    const title = page.getByRole('heading', { level: 1, name: '마켓플레이스', exact: true });
    await expect(title).toBeVisible();
    // the reset makes headings the size of body text
    const bodySize = await px(page.locator('body'), 'font-size');
    expect(await px(title, 'font-size'), '화면 제목 글자 크기').toBeGreaterThan(bodySize * 1.2);

    const cell = page.getByRole('table').first().getByRole('cell').first();
    await expect(cell).toBeVisible();
    expect(await px(cell, 'padding-left'), '표 칸의 안쪽 여백').toBeGreaterThan(0);
  });
});
