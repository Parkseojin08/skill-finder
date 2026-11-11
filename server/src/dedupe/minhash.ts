// Near-copies (feature review B8): a MinHash signature of a skill's description, when_to_use and body, so copies
// renamed or lightly edited are found without comparing every pair. 64 values of 32 bits, stored little-endian in
// skills.minhash; LSH puts signatures into 16 bands of 4 values, and two skills sharing a band are compared.
// Everything here is linear in the text's length (D#4de9): one pass to split words, one hash per word triple.

import { extractSkillMeta } from '../analyze/frontmatter.ts';

export const MINHASH_SIZE = 64;
export const LSH_BANDS = 16;
export const LSH_ROWS = 4;
/** Estimated Jaccard (share of equal signature values) at which two skills count as copies of one another. */
export const COPY_SIMILARITY = 0.75;
/** Fewer distinct word triples than this say too little to tell a copy from a skill on the same topic. */
export const MIN_SHINGLES = 6;
/** Words read from one skill: a 512KB SKILL.md has ~80,000; the first 50,000 are plenty to tell copies apart. */
const MAX_WORDS = 50_000;

/** The text a signature is made of: what a copy keeps when it renames the skill (the name is left out). */
export function minhashText(parts: { description?: string | null; whenToUse?: string | null; body?: string | null }): string {
  return [parts.description ?? '', parts.whenToUse ?? '', parts.body ?? ''].join('\n');
}

/** murmur3's finalizer: a bijection on 32-bit values that mixes every input bit into every output bit. */
function fmix32(h: number): number {
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** One seed per signature value: each `fmix32(x ^ seed)` acts as its own random permutation of the hashes. */
const SEEDS = (() => {
  const s = new Uint32Array(MINHASH_SIZE);
  let x = 0x9e3779b9;
  for (let i = 0; i < MINHASH_SIZE; i++) {
    x = fmix32((x + 0x6d2b79f5) >>> 0);
    s[i] = x;
  }
  return s;
})();

/** FNV-1a over a string's UTF-16 units. */
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Lower-case words (letters and digits of any script), as one linear scan. */
function words(text: string): string[] {
  const out: string[] = [];
  for (const m of text.normalize('NFKC').toLowerCase().matchAll(/[\p{L}\p{N}]+/gu)) {
    out.push(m[0]);
    if (out.length >= MAX_WORDS) break;
  }
  return out;
}

/**
 * The signature of a text: for each of the 64 permutations, the smallest permuted hash of its word triples (single
 * words when it has fewer than three). Null when the text has fewer than MIN_SHINGLES distinct triples.
 */
export function computeMinhash(text: string): Uint32Array | null {
  const w = words(text);
  const shingles = new Set<number>();
  if (w.length < 3) for (const x of w) shingles.add(fnv1a(x));
  else for (let i = 0; i + 2 < w.length; i++) shingles.add(fnv1a(`${w[i]} ${w[i + 1]} ${w[i + 2]}`));
  if (shingles.size < MIN_SHINGLES) return null;
  const sig = new Uint32Array(MINHASH_SIZE).fill(0xffffffff);
  for (const h of shingles) {
    for (let i = 0; i < MINHASH_SIZE; i++) {
      const v = fmix32((h ^ SEEDS[i]) >>> 0);
      if (v < sig[i]) sig[i] = v;
    }
  }
  return sig;
}

/** A SKILL.md's signature (description, when_to_use and body as the index reads them). */
export function skillMinhash(raw: string): Uint32Array | null {
  const meta = extractSkillMeta(raw, '');
  return computeMinhash(minhashText({ description: meta.description, whenToUse: meta.whenToUse, body: meta.body }));
}

/** 64 values as 256 bytes, little-endian (skills.minhash). */
export function encodeMinhash(sig: Uint32Array): Uint8Array {
  const out = new Uint8Array(MINHASH_SIZE * 4);
  const view = new DataView(out.buffer);
  for (let i = 0; i < MINHASH_SIZE; i++) view.setUint32(i * 4, sig[i], true);
  return out;
}

/**
 * What skills.minhash holds: the signature, or an empty blob when the text was too short for one ("worked out, none"),
 * so the background fill (NULL = not worked out yet) does not download it again every day.
 */
export function minhashBytes(sig: Uint32Array | null): Uint8Array {
  return sig ? encodeMinhash(sig) : new Uint8Array(0);
}

/** The stored bytes back as values; null for anything that is not 256 bytes. */
export function decodeMinhash(buf: Uint8Array | null | undefined): Uint32Array | null {
  if (!buf || buf.byteLength !== MINHASH_SIZE * 4) return null;
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const sig = new Uint32Array(MINHASH_SIZE);
  for (let i = 0; i < MINHASH_SIZE; i++) sig[i] = view.getUint32(i * 4, true);
  return sig;
}

/** Share of equal values: an estimate of the two texts' Jaccard similarity over word triples. */
export function similarity(a: Uint32Array, b: Uint32Array): number {
  let same = 0;
  for (let i = 0; i < MINHASH_SIZE; i++) if (a[i] === b[i]) same++;
  return same / MINHASH_SIZE;
}

/** The LSH bucket of each band: band number and its four values. Two signatures sharing one are compared. */
export function bandKeys(sig: Uint32Array): string[] {
  const keys: string[] = [];
  for (let b = 0; b < LSH_BANDS; b++) {
    const o = b * LSH_ROWS;
    keys.push(`${b}:${sig[o]}:${sig[o + 1]}:${sig[o + 2]}:${sig[o + 3]}`);
  }
  return keys;
}
