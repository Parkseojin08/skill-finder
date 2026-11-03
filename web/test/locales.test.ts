// Every sentence the screen translates has an English and a Japanese entry with the same {n} (review 2026-11-03:
// a t() call split over lines had none, and the English settings page showed Korean around English links).
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const SRC = join(import.meta.dirname, '..', 'src');
const locale = (lang: string) => JSON.parse(readFileSync(join(SRC, 'locales', `${lang}.json`), 'utf8')) as Record<string, string>;

/** The literal keys of t('…') and tj('…') in web/src, the way i18n.ts looks them up. */
function usedKeys(): Map<string, string> {
  const keys = new Map<string, string>();
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, e.name);
      // ui: shadcn's own files; game: not part of the app's screens; locales: the dictionaries themselves
      if (e.isDirectory()) {
        if (!['ui', 'game', 'locales'].includes(e.name)) walk(path);
      } else if (/\.tsx?$/.test(e.name) && e.name !== 'i18n.ts') {
        for (const m of readFileSync(path, 'utf8').matchAll(/\btj?\(\s*'((?:[^'\\]|\\.)*)'/g)) {
          keys.set(m[1].replace(/\\'/g, "'").replace(/\\n/g, '\n').replace(/\\\\/g, '\\'), e.name);
        }
      }
    }
  };
  walk(SRC);
  return keys;
}

const placeholders = (s: string) => [...s.matchAll(/\{(\d+)\}/g)].map((m) => m[1]).sort().join(',');

describe('번역 사전', () => {
  const keys = usedKeys();
  for (const lang of ['en', 'ja']) {
    it(`${lang}: 화면의 모든 문구가 있고 {n}이 같다`, () => {
      const dict = locale(lang);
      const missing = [...keys].filter(([k]) => !(k in dict)).map(([k, file]) => `${file}: ${k}`);
      assert.deepEqual(missing, []);
      const mismatched = [...keys.keys()].filter((k) => k in dict && placeholders(k) !== placeholders(dict[k]));
      assert.deepEqual(mismatched, []);
    });
  }
});
