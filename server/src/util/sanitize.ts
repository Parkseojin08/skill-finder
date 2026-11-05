// Same escape classes the skills CLI strips (src/cli: stripTerminalEscapes).
const CSI_RE = /\x1b\[[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]/g;
// OSC/DCS bodies stop at the next ESC (or BEL): a lazy `[\s\S]*?` scanned to the end of the text from every
// unterminated ESC], quadratic (95s on a crafted 512KB SKILL.md). A sequence with an ESC inside is no longer
// removed whole, but its ESCs are still stripped below, so no escape survives either way.
const OSC_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const DCS_PM_APC_RE = /\x1b[P^_][^\x1b]*\x1b\\/g;
const SIMPLE_ESC_RE = /\x1b[\x20-\x7e]/g;
const C1_RE = /[\x80-\x9f]/g;
// Keeps \t (0x09) and \n (0x0a); drops other C0 controls, \r and DEL.
const CONTROL_RE = /[\x00-\x08\x0b-\x1f\x7f]/g;

/** Removes ANSI/terminal escape sequences and control characters, keeping newlines and tabs. */
export function sanitizeText(input: string): string {
  return input
    .replace(/\r\n?/g, '\n')
    .replace(OSC_RE, '')
    .replace(DCS_PM_APC_RE, '')
    .replace(CSI_RE, '')
    .replace(SIMPLE_ESC_RE, '')
    .replace(C1_RE, '')
    .replace(CONTROL_RE, '');
}

// Direction overrides/isolates and marks, zero-width space, word joiner, BOM: invisible, and able to make a
// name read as something else ("txt.exe" shown as "exe.txt"). Also Unicode tag characters (U+E0000–E007F, a
// surrogate pair each): invisible, and able to carry a whole sentence only Claude reads (feature review P2).
const INVISIBLE_RE = /[؜​‎‏‪-‮⁠⁦-⁩﻿]|\uDB40[\uDC00-\uDC7F]/g;
// Zero-width (non-)joiners shape Persian, Indic scripts and emoji, so descriptions keep them; names do not.
const JOINER_RE = /[‌‍]/g;

/** sanitizeText plus newline collapsing, for single-line metadata. */
export function sanitizeLine(input: string): string {
  // split + trim rather than /\s*\n\s*/: that regex rescans a long whitespace run from every position (2.9s at 64K)
  return sanitizeText(input)
    .replace(INVISIBLE_RE, '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .join(' ');
}

/** sanitizeLine for names, also without zero-width joiners. */
export function sanitizeName(input: string): string {
  return sanitizeLine(input).replace(JOINER_RE, '');
}

export function truncate(input: string, max: number): string {
  const chars = Array.from(input);
  return chars.length <= max ? input : chars.slice(0, max - 1).join('') + '…';
}
