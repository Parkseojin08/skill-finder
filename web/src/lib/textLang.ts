/**
 * Whether a text is English worth sending to the English → Korean/Japanese model. The model was handed every text:
 * a Korean README intro came back as ". , , ロ アロキ…" and a row of symbols as a made-up sentence (user report
 * 2026-11-04). English means most letters are A–Z (a Korean sentence naming "Claude Code" is not), at least three
 * of them, and letters are at least half of what is not space (badge rows and separators are not).
 */
export function worthTranslating(text: string): boolean {
  const letters = text.match(/\p{L}/gu)?.length ?? 0;
  const latin = text.match(/[A-Za-z]/g)?.length ?? 0;
  const visible = text.replace(/\s/g, '').length;
  return latin >= 3 && latin >= letters * 0.7 && letters >= visible * 0.5;
}
