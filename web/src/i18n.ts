// Korean, English and Japanese screens (user decision 2026-11-02). The Korean text in the code is the key:
// t('결과 {0}개', n) looks it up in locales/<lang>.json and fills {0}, {1}, … The language is read once at start
// (a choice saved in this browser, else the browser's language) and changing it reloads the page, so labels made
// at module level follow it too. The server answers in Korean; serverText() translates its messages by matching
// the same dictionary's templates.
import en from './locales/en.json' with { type: 'json' };
import ja from './locales/ja.json' with { type: 'json' };

export type Lang = 'ko' | 'en' | 'ja';
export const LANGS: Array<{ code: Lang; label: string }> = [
  { code: 'ko', label: '한국어' },
  { code: 'en', label: 'English' },
  { code: 'ja', label: '日本語' },
];
const KEY = 'skill-finder-lang';

function detect(): Lang {
  if (typeof window === 'undefined') return 'ko'; // tests and the CLI read the Korean source
  try {
    const saved = localStorage.getItem(KEY);
    if (saved === 'ko' || saved === 'en' || saved === 'ja') return saved;
  } catch {
    // not remembered: the browser's language
  }
  const nav = (navigator.language || 'ko').slice(0, 2).toLowerCase();
  return nav === 'ko' ? 'ko' : nav === 'ja' ? 'ja' : 'en';
}

export const LANG: Lang = detect();
const DICT: Record<string, string> | null = LANG === 'en' ? en : LANG === 'ja' ? ja : null;

const fill = (s: string, args: unknown[]) => s.replace(/\{(\d+)\}/g, (m, i: string) => (Number(i) < args.length ? String(args[Number(i)]) : m));

/** The text in the chosen language; `args` fill {0}, {1}, … */
export function t(ko: string, ...args: unknown[]): string {
  return fill(DICT?.[ko] ?? ko, args);
}

export function setLang(lang: Lang): void {
  try {
    localStorage.setItem(KEY, lang);
  } catch {
    // only this visit
  }
  window.location.reload();
}

type Pattern = { re: RegExp; to: string; order: number[] };
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Templates ("{0}") of a dictionary as patterns; the longest keys first, so a specific message beats a general one. */
function patternsOf(dict: Record<string, string>): Pattern[] {
  return Object.entries(dict)
    .filter(([k]) => /\{\d+\}/.test(k))
    .sort((a, b) => b[0].length - a[0].length)
    .flatMap(([k, to]) => {
      const order: number[] = [];
      const src = escape(k).replace(/\\\{(\d+)\\\}/g, (_m, i: string) => {
        order.push(Number(i));
        return '([\\s\\S]*?)';
      });
      try {
        return [{ re: new RegExp(`^${src}$`), to, order }];
      } catch {
        return [];
      }
    });
}

const cache = new WeakMap<Record<string, string>, Pattern[]>();

/** `message` through `dict`: an exact key, else the first template it fits (its values filled in, and translated too). */
export function matchMessage(dict: Record<string, string>, message: string): string {
  const exact = dict[message];
  if (exact) return exact;
  let patterns = cache.get(dict);
  if (!patterns) cache.set(dict, (patterns = patternsOf(dict)));
  for (const { re, to, order } of patterns) {
    const m = re.exec(message);
    if (!m) continue;
    const values = new Map(order.map((idx, j) => [idx, m[j + 1]]));
    // a filled-in value may itself be a known message ("skills.sh 검색 실패 (시간 초과)")
    return to.replace(/\{(\d+)\}/g, (s, i: string) => {
      const v = values.get(Number(i));
      return v == null ? s : (dict[v] ?? v);
    });
  }
  return message;
}

/** A message the server wrote in Korean, in the chosen language when the dictionary knows it; else as it came. */
export function serverText(message: string | null | undefined): string {
  if (!message || !DICT) return message ?? '';
  return matchMessage(DICT, message);
}
