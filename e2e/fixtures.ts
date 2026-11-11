// What every E2E test gets besides Playwright's own `page`:
//   - `problems` (always on): console errors and uncaught exceptions of the page fail the test when it ends, unless
//     the test said beforehand that it expects them (`problems.allow`).
//   - a safety net (always on): the three requests that act on the PC itself (install, uninstall, the system's folder
//     dialog) never leave the browser. No test asks for them; one that did by mistake fails on the blocked request.
//   - one translation state (always on): the browser's built-in Translator API is taken away before the page loads.
//     Whether a browser has it, and a language model for it, differs by browser, version and headless mode (the page
//     would show "ready", "download needed" or "unsupported" accordingly). Without it the page asks the server for
//     the Mozilla model, the server cannot fetch it offline, and every browser shows the same "번역을 시작하지 못해
//     설명을 영어로 보여 줍니다" state, with the descriptions in English as the fixture wrote them.
import { expect, test as base } from '@playwright/test';

export type Problems = {
  /** Errors matching `pattern` are expected in this test (say why in a comment where it is called). */
  allow(pattern: RegExp): void;
};

export const test = base.extend<{ problems: Problems; sameEverywhere: void }>({
  problems: [
    async ({ page }, use) => {
      const seen: string[] = [];
      const allowed: RegExp[] = [];
      page.on('console', (msg) => {
        if (msg.type() === 'error') seen.push(`console.error: ${msg.text()} @ ${msg.location().url}`);
      });
      page.on('pageerror', (err) => seen.push(`uncaught: ${err.message}`));
      await use({ allow: (pattern) => void allowed.push(pattern) });
      expect(seen.filter((line) => !allowed.some((p) => p.test(line))), '콘솔 오류나 잡히지 않은 예외가 없어야 합니다').toEqual([]);
    },
    { auto: true },
  ],
  sameEverywhere: [
    async ({ context }, use) => {
      await context.route(/\/api\/(install|uninstall|pick-folder)$/, (route) => (route.request().method() === 'POST' ? route.abort('blockedbyclient') : route.fallback()));
      await context.addInitScript(() => {
        const page = globalThis as { Translator?: unknown };
        delete page.Translator;
        if (page.Translator !== undefined) Object.defineProperty(page, 'Translator', { value: undefined, configurable: true });
      });
      await use();
    },
    { auto: true },
  ],
});

export { expect };
