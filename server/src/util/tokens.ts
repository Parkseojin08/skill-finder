// How much of the model's context a skill takes (review 2026-11-02: Claude Code shows this for the official
// marketplace only). Counted without a tokenizer or any AI call, so it is an estimate and is shown as one.

/** About 4 characters per token for ASCII text, 1.5 per character for other scripts (Korean, CJK). */
export function estimateTokens(text: string): number {
  let ascii = 0;
  let other = 0;
  for (const ch of text) {
    if (ch.charCodeAt(0) < 128) ascii++;
    else other++;
  }
  return Math.ceil(ascii / 4 + other / 1.5);
}

/**
 * `perTurn`: the name and description Claude Code lists with every request while the skill is installed;
 * `onUse`: the whole SKILL.md, read when the skill is used (null when not known).
 */
export function skillTokens(name: string, description: string | null, skillMd: string | null): { perTurn: number; onUse: number | null } {
  return { perTurn: estimateTokens(`${name}: ${description ?? ''}`), onUse: skillMd == null ? null : estimateTokens(skillMd) };
}
