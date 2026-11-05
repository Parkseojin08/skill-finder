/**
 * English aliases searched along with a query word (B4 / perf debate D1, user decision 5): the file formats the
 * official skills are named by and two common abbreviations. Eight pairs, frozen as measured (SYN2: new queries
 * nDCG@10 +0.182, CI [0.087, 0.288], 9 wins 0 losses, must 1/6 → 6/6). The query on screen stays as typed; the
 * results say "ppt → pptx도 함께 찾음" when an alias found something. Word-form pairs (create → creator,
 * analyze → analysis) were measured too and hurt (`create react app` −0.191), so they are not here; a new pair
 * goes in only after it is judged on queries fixed beforehand.
 */
export const QUERY_ALIASES: Readonly<Record<string, readonly string[]>> = {
  ppt: ['pptx', 'powerpoint'],
  powerpoint: ['pptx', 'ppt'],
  excel: ['xlsx'],
  xls: ['xlsx'],
  k8s: ['kubernetes'],
  postgres: ['postgresql'],
};

/** "word" means the document format only next to a document word ("edit word document", not "word count"). */
const DOC_WORDS = new Set(['document', 'documents', 'doc', 'docs', 'file', 'files']);

/** Query words (lowercase, as typed) → the alias words searched with them. Empty when the query has none. */
export function queryAliases(query: string): Map<string, string[]> {
  const words: string[] = query.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  const out = new Map<string, string[]>();
  for (const w of words) {
    const a = QUERY_ALIASES[w];
    if (a) out.set(w, [...a]);
  }
  if (words.includes('word') && words.some((w) => DOC_WORDS.has(w))) {
    // as measured: "word" and the doc… words also match docx ("file" only makes "word" a format)
    for (const w of words) if (w === 'word' || (DOC_WORDS.has(w) && w.startsWith('doc'))) out.set(w, [...new Set([...(out.get(w) ?? []), 'docx'])]);
  }
  return out;
}

/** One alias the results used: the query word and the alias words that matched a shown result. */
export type AliasUse = { from: string; to: string[] };
