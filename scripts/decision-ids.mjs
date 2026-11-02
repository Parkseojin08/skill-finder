// Stable IDs for docs/DECISIONS.md entries (project review 2026-11-02 U6): "- [#3f2a] (2026-10-23 …) …".
// An ID is the start of a hash of the entry's own first line, so adding or removing other lines never changes it;
// line-number citations ("D:122") went stale whenever lines were inserted above. Cite an entry as D#3f2a.
// Run after adding a decision (entries that have an ID keep it):
//   node scripts/decision-ids.mjs [--cite <file> ...]
// --cite rewrites "D:NNN" and "D:NNN-MMM" in those files to the IDs of the entries at those lines of
// DECISIONS.md as it is before this run (only for files whose line numbers match the current file).
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ID = /^- \[#([0-9a-f]{4,8})\] /;

/** Adds an ID to every top-level entry without one; returns the text and, per 1-based line, its entry's ID. */
export function withIds(text) {
  const lines = text.split('\n');
  const used = new Set(lines.map((l) => l.match(ID)?.[1]).filter(Boolean));
  const lineToId = new Map();
  let current = null;
  const out = lines.map((line, i) => {
    if (!line.startsWith('- ')) {
      // a sub-bullet or a continuation belongs to the entry above; a heading or table ends it
      if (/^(#|\||\S)/.test(line) && !line.startsWith('  ')) current = null;
      if (current) lineToId.set(i + 1, current);
      return line;
    }
    const existing = line.match(ID)?.[1];
    if (existing) {
      current = existing;
      lineToId.set(i + 1, current);
      return line;
    }
    const hash = createHash('sha1').update(line.slice(2).trim().slice(0, 80)).digest('hex');
    let len = 4;
    while (used.has(hash.slice(0, len))) len++;
    current = hash.slice(0, len);
    used.add(current);
    lineToId.set(i + 1, current);
    return `- [#${current}] ${line.slice(2)}`;
  });
  return { text: out.join('\n'), lineToId };
}

/** "D:122-124" → "D#3f2a·D#9b0c" (the entries those lines belong to), unknown lines left as they are. */
export function rewriteCitations(text, lineToId) {
  return text.replace(/\bD:(\d{1,4})(?:-(\d{1,4}))?/g, (whole, a, b) => {
    const ids = [];
    for (let n = Number(a); n <= Number(b ?? a); n++) {
      const id = lineToId.get(n);
      if (id && !ids.includes(id)) ids.push(id);
    }
    return ids.length ? ids.map((id) => `D#${id}`).join('·') : whole;
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const file = join(ROOT, 'docs', 'DECISIONS.md');
  const { text, lineToId } = withIds(readFileSync(file, 'utf8'));
  writeFileSync(file, text);
  const cite = process.argv.indexOf('--cite');
  for (const f of cite >= 0 ? process.argv.slice(cite + 1) : []) {
    const path = resolve(f);
    writeFileSync(path, rewriteCitations(readFileSync(path, 'utf8'), lineToId));
    console.log(`citations: ${f}`);
  }
  console.log(`${[...new Set(lineToId.values())].length} entries with IDs`);
}
