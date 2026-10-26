// Same escape classes the skills CLI strips (src/cli: stripTerminalEscapes).
const CSI_RE = /\x1b\[[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]/g;
const OSC_RE = /\x1b\][\s\S]*?(?:\x07|\x1b\\)/g;
const DCS_PM_APC_RE = /\x1b[P^_][\s\S]*?(?:\x1b\\)/g;
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

/** sanitizeText plus newline collapsing, for single-line metadata. */
export function sanitizeLine(input: string): string {
  return sanitizeText(input).replace(/\s*\n\s*/g, ' ').trim();
}

export function truncate(input: string, max: number): string {
  const chars = Array.from(input);
  return chars.length <= max ? input : chars.slice(0, max - 1).join('') + '…';
}
