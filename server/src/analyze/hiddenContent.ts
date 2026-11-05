// What Claude reads in a SKILL.md but a person looking at the rendered page does not see (feature review F2, P2):
// HTML comments with text, HTML hidden by its attributes, Unicode tag characters, direction overrides, runs of
// zero-width characters, very long base64 blocks, and links whose text shows another domain than they go to.
// The text is remote, so every check here is linear in its length (D#4de9): plain character loops and indexOf,
// and regexes whose repeats stop at a character they cannot cross (no nested or overlapping repeats).

export type HiddenKind = 'comment' | 'hiddenHtml' | 'tagChars' | 'bidi' | 'zeroWidth' | 'base64' | 'linkMismatch';
/** `start`/`end`: UTF-16 offsets into the text checked (end exclusive). */
export type HiddenSpan = { kind: HiddenKind; start: number; end: number };

/** Spans returned at most (the detail view lists them; the risk flag needs one). */
export const HIDDEN_SPANS_MAX = 500;
/** A base64 run at least this long, with upper case, lower case and digits, is a hidden payload rather than a word. */
export const BASE64_MIN = 256;
/** How far after a hidden opening tag its closing tag is looked for. */
const CLOSE_WINDOW = 16 * 1024;

// U+E0000–E007F are \uDB40 followed by \uDC00–\uDC7F.
const isTagLow = (c: number) => c >= 0xdc00 && c <= 0xdc7f;
/** Overrides, embeddings and isolates: they reorder what is shown (LRM/RLM/ALM only mark direction and are common). */
const isBidiControl = (c: number) => (c >= 0x202a && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069);
/** Zero-width space, (non-)joiners, word joiner, invisible operators, BOM, Mongolian vowel separator, soft hyphen. */
const isZeroWidth = (c: number) => (c >= 0x200b && c <= 0x200d) || (c >= 0x2060 && c <= 0x2064) || c === 0xfeff || c === 0x180e || c === 0xad;
const isB64 = (c: number) => (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || (c >= 0x30 && c <= 0x39) || c === 0x2b || c === 0x2f;

/**
 * A subdivision flag emoji (🏴 + 2–6 lower-case or digit tags + CANCEL TAG, as in England's flag) is the one
 * legitimate use of tag characters; anything longer or otherwise shaped can carry text.
 */
function isEmojiFlag(text: string, start: number, end: number): boolean {
  if (start < 2 || text.charCodeAt(start - 2) !== 0xd83c || text.charCodeAt(start - 1) !== 0xdff4) return false;
  const count = (end - start) / 2;
  if (count < 3 || count > 7 || text.charCodeAt(end - 1) !== 0xdc7f) return false;
  for (let i = start + 1; i < end - 2; i += 2) {
    const low = text.charCodeAt(i) - 0xdc00; // the tag's ASCII value
    if (!((low >= 0x30 && low <= 0x39) || (low >= 0x61 && low <= 0x7a))) return false;
  }
  return true;
}

function mixedBase64(text: string, start: number, end: number): boolean {
  let upper = false;
  let lower = false;
  let digit = false;
  for (let i = start; i < end; i++) {
    const c = text.charCodeAt(i);
    if (c >= 0x41 && c <= 0x5a) upper = true;
    else if (c >= 0x61 && c <= 0x7a) lower = true;
    else if (c >= 0x30 && c <= 0x39) digit = true;
    if (upper && lower && digit) return true;
  }
  return false;
}

const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/** Fenced code blocks: shown as code, so a comment or tag inside them is visible on the page. Sorted [start, end). */
function codeRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  let open: { ch: string; len: number; start: number } | null = null;
  for (let ls = 0; ls <= text.length; ) {
    let le = text.indexOf('\n', ls);
    if (le < 0) le = text.length;
    // a fence line starts with at most 3 spaces and its marker; 200 characters are enough to see it
    const m = FENCE.exec(text.slice(ls, Math.min(le, ls + 200)));
    if (m) {
      // a backtick fence's info string has no backtick: "```x```" is inline code, and the text after it is not code
      if (!open) {
        if (m[1][0] !== '`' || !text.slice(ls + m[0].length, le).includes('`')) open = { ch: m[1][0], len: m[1].length, start: ls };
      }
      else if (m[1][0] === open.ch && m[1].length >= open.len && text.slice(ls + m[0].length, le).trim() === '') {
        ranges.push([open.start, le]);
        open = null;
      }
    }
    ls = le + 1;
  }
  if (open) ranges.push([open.start, text.length]); // an unclosed fence runs to the end
  return ranges;
}

/** Whether `pos` is in a code range; `at` walks forward through the sorted ranges as the callers' positions grow. */
function inCode(ranges: Array<[number, number]>, cursor: { at: number }, pos: number): [number, number] | null {
  while (cursor.at < ranges.length && ranges[cursor.at][1] <= pos) cursor.at++;
  const r = ranges[cursor.at];
  return r && r[0] <= pos ? r : null;
}

const HAS_TEXT = /[\p{L}\p{N}]/u;
// `[^<>]*` stops at the next `<`, so each attempt scans only up to the next tag start. The lookahead keeps the name
// whole: without it a `<` and a long run of letters with no `>` was tried at every split of the name (quadratic,
// review 2026-11-04: 80K characters took 4.6 s).
const OPEN_TAG = /<([a-zA-Z][a-zA-Z0-9-]*)(?![a-zA-Z0-9-])([^<>]*)>/g;
const HIDDEN_ATTR =
  /(?:^|[\s"'])hidden(?=[\s=/"']|$)|display[ \t]*:[ \t]*none|visibility[ \t]*:[ \t]*hidden|font-size[ \t]*:[ \t]*0(?:px|em|rem|pt|%)?[ \t]*(?:[;"']|$)|opacity[ \t]*:[ \t]*0(?:\.0+)?[ \t]*(?:[;"']|$)/i;
// The link text cannot contain brackets or a newline and is at most 300 characters; the address stops at space or ().
const MD_LINK = /\[([^[\]\n]{1,300})\]\([ \t]*<?([^\s()<>]{1,2000})/g;
const URL_TEXT = /^(?:https?:\/\/|www\.)(?:www\.)?([a-z0-9-]+(?:\.[a-z0-9-]+)+)(?:[/:?#]|$)/i;
// A bare "name.tld" only counts with a common web TLD: README.md, setup.py or install.sh are file names, not domains.
const BARE_DOMAIN = /^([a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|org|net|io|dev|ai|app|co|gov|edu|info|xyz|me|tech|site|online|page|cloud))(?:[/:?#]|$)/i;

const stripWww = (h: string) => h.toLowerCase().replace(/^www\./, '');
/** The same site: one host is the other or under it (docs.github.com and github.com). */
const sameSite = (a: string, b: string) => a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);

/** The domain a link's text shows, or null when the text does not look like an address. */
export function shownDomain(label: string): string | null {
  const s = label.trim().replace(/^[`*_<\s]+|[`*_>\s]+$/g, '');
  const m = URL_TEXT.exec(s) ?? BARE_DOMAIN.exec(s);
  return m ? stripWww(m[1]) : null;
}

/** The host an absolute http(s) address goes to, or null. */
function hrefHost(href: string): string | null {
  if (!/^https?:\/\//i.test(href)) return null;
  try {
    return stripWww(new URL(href).hostname);
  } catch {
    return null;
  }
}

/**
 * The places in `text` a reader of the rendered page does not see (or cannot read), in text order, at most `max`
 * (`more`: there were others). Linear in the length of `text`.
 */
export function findHiddenContent(text: string, max = HIDDEN_SPANS_MAX): { spans: HiddenSpan[]; more: boolean } {
  const spans: HiddenSpan[] = [];
  let more = false;
  const add = (kind: HiddenKind, start: number, end: number) => {
    if (spans.length >= max) more = true;
    else spans.push({ kind, start, end });
  };
  // stop once one past the limit was seen (so `more` is known), not at the limit
  const full = () => more;
  const n = text.length;

  // invisible characters and base64, one pass
  for (let i = 0; i < n && !full(); ) {
    const c = text.charCodeAt(i);
    if (c === 0xdb40 && isTagLow(text.charCodeAt(i + 1))) {
      let j = i;
      while (j < n && text.charCodeAt(j) === 0xdb40 && isTagLow(text.charCodeAt(j + 1))) j += 2;
      if (!isEmojiFlag(text, i, j)) add('tagChars', i, j);
      i = j;
    } else if (isBidiControl(c)) {
      let j = i + 1;
      while (j < n && isBidiControl(text.charCodeAt(j))) j++;
      add('bidi', i, j);
      i = j;
    } else if (isZeroWidth(c)) {
      let j = i + 1;
      while (j < n && isZeroWidth(text.charCodeAt(j))) j++;
      // one joiner shapes emoji and Persian or Indic text; a run of them carries nothing a reader sees
      if (j - i >= 2) add('zeroWidth', i, j);
      i = j;
    } else if (isB64(c)) {
      let j = i + 1;
      while (j < n && isB64(text.charCodeAt(j))) j++;
      if (j - i >= BASE64_MIN && mixedBase64(text, i, j)) {
        let e = j;
        while (e < n && e < j + 2 && text.charCodeAt(e) === 0x3d) e++; // `=` padding
        add('base64', i, e);
      }
      i = j;
    } else i++;
  }

  const code = codeRanges(text);

  // HTML comments with text: the page drops them, Claude reads them. An unclosed one hides the rest of the file.
  for (let p = 0, cur = { at: 0 }; p < n && !full(); ) {
    const s = text.indexOf('<!--', p);
    if (s < 0) break;
    const r = inCode(code, cur, s);
    if (r) {
      p = r[1];
      continue;
    }
    const e = text.indexOf('-->', s + 4);
    const end = e < 0 ? n : e + 3;
    if (HAS_TEXT.test(text.slice(s + 4, e < 0 ? n : e))) add('comment', s, end);
    p = end;
  }

  // elements hidden by their attributes (display:none, hidden, …), up to their closing tag when it is near
  OPEN_TAG.lastIndex = 0;
  for (let m: RegExpExecArray | null, cur = { at: 0 }; !full() && (m = OPEN_TAG.exec(text)); ) {
    if (inCode(code, cur, m.index) || !HIDDEN_ATTR.test(m[2])) continue;
    const tagEnd = m.index + m[0].length;
    const close = new RegExp(`</${m[1]}[ \\t]*>`, 'i').exec(text.slice(tagEnd, tagEnd + CLOSE_WINDOW));
    const end = close ? tagEnd + close.index + close[0].length : tagEnd;
    add('hiddenHtml', m.index, end);
    OPEN_TAG.lastIndex = end;
  }

  // a link whose text is one address and whose target is another site
  MD_LINK.lastIndex = 0;
  for (let m: RegExpExecArray | null, cur = { at: 0 }; !full() && (m = MD_LINK.exec(text)); ) {
    if (inCode(code, cur, m.index)) continue;
    const shown = shownDomain(m[1]);
    const host = shown ? hrefHost(m[2]) : null;
    if (shown && host && !sameSite(shown, host)) add('linkMismatch', m.index, m.index + m[0].length);
  }

  spans.sort((a, b) => a.start - b.start || a.end - b.end);
  return { spans, more };
}

/** Whether the text hides anything (the `hiddenContent` risk flag). */
export function hasHiddenContent(text: string): boolean {
  return findHiddenContent(text, 1).spans.length > 0;
}
