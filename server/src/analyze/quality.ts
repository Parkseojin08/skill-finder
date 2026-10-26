import type { SkillMeta } from './frontmatter.ts';

export type QualityCode =
  | 'noFrontmatter'
  | 'yamlError'
  | 'nameMissing'
  | 'nameFormat'
  | 'nameLength'
  | 'nameMismatch'
  | 'descriptionMissing'
  | 'descriptionLength'
  | 'bodyTooLong'
  | 'listingTruncated'
  | 'reservedWord';

export const LISTING_LIMIT = 1536;

/** Badge-only checks (agentskills.io spec + Claude Code listing limits); never part of the score. */
export function qualityWarnings(meta: SkillMeta, folderName: string): QualityCode[] {
  const out: QualityCode[] = [];
  if (!meta.hasFrontmatter) out.push('noFrontmatter');
  if (meta.yamlError) out.push('yamlError');

  const name = meta.nameFromFrontmatter;
  if (!name) out.push('nameMissing');
  else {
    const len = Array.from(name).length;
    if (len < 1 || len > 64) out.push('nameLength');
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) out.push('nameFormat');
    if (folderName && name !== folderName) out.push('nameMismatch');
  }

  const desc = meta.descriptionFromFrontmatter;
  if (!desc) out.push('descriptionMissing');
  else if (Array.from(desc).length > 1024) out.push('descriptionLength');

  if (meta.bodyLines > 500) out.push('bodyTooLong');
  const listing = (meta.description ?? '') + (meta.whenToUse ?? '');
  if (Array.from(listing).length > LISTING_LIMIT) out.push('listingTruncated');
  if (/anthropic|claude/i.test(meta.name)) out.push('reservedWord');
  return out;
}
