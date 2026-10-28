import { parse } from 'yaml';
import { sanitizeLine, sanitizeName, sanitizeText } from '../util/sanitize.ts';

export type ParsedSkillMd = {
  hasFrontmatter: boolean;
  frontmatter: Record<string, unknown>;
  body: string;
  yamlError: string | null;
  /** The frontmatter was over FRONTMATTER_MAX_CHARS and was not parsed as YAML (only name/description read). */
  frontmatterTooLarge?: boolean;
};

/**
 * YAML is parsed on the main thread; deeply nested frontmatter takes ~0.2s each, so a repo full of them
 * could block the server for minutes. Real frontmatter is far smaller (largest stored: 13.7K chars).
 */
export const FRONTMATTER_MAX_CHARS = 16 * 1024;

// Claude Code only treats the block as frontmatter when the very first line is `---`.
const FRONTMATTER_RE = /^---[ \t]*\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*(?:\r?\n|$)([\s\S]*)$/;

function regexField(block: string, key: string): string | undefined {
  const m = block.match(new RegExp(`^${key}:[ \\t]*(.+)$`, 'm'));
  if (!m) return undefined;
  return m[1].trim().replace(/^(['"])(.*)\1$/, '$2');
}

export function parseSkillMd(raw: string): ParsedSkillMd {
  const text = raw.replace(/^﻿/, '');
  const m = text.match(FRONTMATTER_RE);
  if (!m) return { hasFrontmatter: false, frontmatter: {}, body: text, yamlError: null };
  const block = m[1] ?? '';
  const body = m[2] ?? '';
  if (block.length > FRONTMATTER_MAX_CHARS) {
    const fallback: Record<string, unknown> = {};
    const name = regexField(block, 'name');
    const description = regexField(block, 'description');
    if (name) fallback.name = name;
    if (description) fallback.description = description;
    const yamlError = `frontmatter가 ${FRONTMATTER_MAX_CHARS / 1024}KB를 넘어 해석하지 않았습니다`;
    return { hasFrontmatter: true, frontmatter: fallback, body, yamlError, frontmatterTooLarge: true };
  }
  try {
    const data = parse(block, { prettyErrors: false });
    if (data == null) return { hasFrontmatter: true, frontmatter: {}, body, yamlError: null };
    if (typeof data !== 'object' || Array.isArray(data)) {
      return { hasFrontmatter: true, frontmatter: {}, body, yamlError: 'frontmatter가 매핑이 아닙니다' };
    }
    return { hasFrontmatter: true, frontmatter: data as Record<string, unknown>, body, yamlError: null };
  } catch (err) {
    const fallback: Record<string, unknown> = {};
    const name = regexField(block, 'name');
    const description = regexField(block, 'description');
    if (name) fallback.name = name;
    if (description) fallback.description = description;
    return { hasFrontmatter: true, frontmatter: fallback, body, yamlError: String((err as Error).message ?? err).split('\n')[0] };
  }
}

/** Splits `allowed-tools` given as a YAML list or a comma/space separated string, respecting parentheses. */
export function parseAllowedTools(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
  if (typeof value !== 'string') return [];
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of value) {
    if (ch === '(') depth++;
    if (ch === ')') depth = Math.max(0, depth - 1);
    if (depth === 0 && (ch === ',' || /\s/.test(ch))) {
      if (cur.trim()) out.push(cur.trim());
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

export type SkillMeta = {
  name: string;
  description: string;
  whenToUse: string | null;
  nameFromFrontmatter: string | null;
  descriptionFromFrontmatter: string | null;
  allowedTools: string[];
  hasHooks: boolean;
  frontmatter: Record<string, unknown>;
  body: string;
  bodyLines: number;
  hasFrontmatter: boolean;
  yamlError: string | null;
  frontmatterTooLarge: boolean;
};

const asString = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);

function firstBodyLine(body: string): string {
  for (const line of body.split('\n')) {
    const t = line.replace(/^#+\s*/, '').trim();
    if (t) return t;
  }
  return '';
}

const PICKED_FIELDS = [
  'name',
  'description',
  'when_to_use',
  'allowed-tools',
  'disable-model-invocation',
  'user-invocable',
  'hooks',
  'paths',
  'model',
  'context',
  'license',
  'compatibility',
  'metadata',
];

/** Applies Claude Code's defaults: name falls back to the folder, description to the first body line. */
export function extractSkillMeta(raw: string, folderName: string): SkillMeta {
  const parsed = parseSkillMd(sanitizeText(raw));
  const fm = parsed.frontmatter;
  const nameFm = asString(fm.name);
  const descFm = asString(fm.description);
  const picked: Record<string, unknown> = {};
  for (const k of PICKED_FIELDS) if (fm[k] !== undefined) picked[k] = fm[k];
  const body = parsed.body;
  return {
    name: sanitizeName(nameFm ?? folderName),
    description: sanitizeLine(descFm ?? firstBodyLine(body)),
    whenToUse: asString(fm.when_to_use) ? sanitizeLine(fm.when_to_use as string) : null,
    nameFromFrontmatter: nameFm ? sanitizeName(nameFm) : null,
    descriptionFromFrontmatter: descFm ? sanitizeLine(descFm) : null,
    allowedTools: parseAllowedTools(fm['allowed-tools']),
    hasHooks: fm.hooks != null && fm.hooks !== false,
    frontmatter: picked,
    body,
    bodyLines: body.length === 0 ? 0 : body.replace(/\n$/, '').split('\n').length,
    hasFrontmatter: parsed.hasFrontmatter,
    yamlError: parsed.yamlError,
    frontmatterTooLarge: parsed.frontmatterTooLarge === true,
  };
}
