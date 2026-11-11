// What an install brings besides SKILL.md (project review 2026-11-02 F1). The risk rules run on SKILL.md when a
// skill is indexed; the other text files of the folder (scripts, references) are installed unchecked. Before an
// install the app reads them at the pinned commit and runs the same text rules on each. Remote files are only read.
import { TEXT_FILE_RULES, textEvidence, textFileInput, TICK_FLAGS, type Evidence, type RiskFlag } from '../analyze/risk.ts';
import type { SkillRow } from '../db/store.ts';
import type { StoredFiles } from '../indexer.ts';
import type { GitHub } from '../sources/github.ts';
import { looksBinary } from '../util/http.ts';
import { pool } from '../util/limiter.ts';
import { SizedCache } from '../util/sizedCache.ts';
import { isTextPath, MAX_FILE_BYTES } from '../util/textFiles.ts';

/** Text files read per skill: scripts first, then the rest in path order. */
export const SCAN_MAX_FILES = 50;
const SCRIPT_EXT = /\.(sh|bash|zsh|fish|py|js|mjs|cjs|ts|rb|pl|ps1|psm1|bat|cmd)$/i;

export type SkipReason = 'binary' | 'large' | 'limit' | 'failed';

export type FileScan = {
  /** The commit read (the one a pinned install installs). */
  commit: string;
  /** Text files read and checked (SKILL.md is not counted: it was checked when indexed). */
  checked: number;
  /** Checked files with a signal. */
  findings: Array<{ path: string; flags: RiskFlag[] }>;
  /** Files not checked, and why. */
  skipped: Array<{ path: string; reason: SkipReason }>;
  /** Files past the 500 the index keeps per skill, never listed. */
  unlisted: number;
  /** Where in each finding's file its signals are (feature review F1): path, line and the lines around it. */
  evidence: Array<Evidence & { flag: RiskFlag }>;
};

/**
 * The text rules that apply outside SKILL.md: download-and-run, rm -rf and the B5 malicious-pattern rules (the rest
 * read frontmatter). `path`: a Markdown or text document is read as SKILL.md is (commands only where they are
 * written); without it, or for a script or command line, all of the text is code.
 */
export function textFileFlags(text: string, path?: string): RiskFlag[] {
  const input = textFileInput(text, path);
  return TEXT_FILE_RULES.filter((r) => r.scan(input, 1).length > 0).map((r) => r.flag);
}

/** A file finding as serious as download-and-run (needs the install's confirm tick, decision 9). */
export const needsTick = (flags: readonly RiskFlag[]) => flags.some((f) => TICK_FLAGS.has(f));

const cache = new SizedCache<FileScan>({ maxSize: 500, ttlMs: 30 * 60 * 1000, sizeOf: () => 1 });

/** One skill folder at its indexed commit; kept 30 minutes unless a file could not be downloaded. */
export async function scanSkillFiles(github: GitHub, skill: SkillRow): Promise<FileScan> {
  const key = `${skill.repo}@${skill.ref}:${skill.dir_path}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const scan = await runScan(github, skill);
  if (!scan.skipped.some((s) => s.reason === 'failed')) cache.set(key, Promise.resolve(scan));
  return scan;
}

async function runScan(github: GitHub, skill: SkillRow): Promise<FileScan> {
  const repo = skill.repo!;
  const ref = skill.ref!;
  const stored = (skill.files_json ? JSON.parse(skill.files_json) : { files: [], total: 0 }) as StoredFiles;
  const files = stored.files.filter((f) => f.path !== 'SKILL.md');
  const skipped: FileScan['skipped'] = [];
  const text: StoredFiles['files'] = [];
  for (const f of files) {
    if (!isTextPath(f.path)) skipped.push({ path: f.path, reason: 'binary' });
    else if (f.size != null && f.size > MAX_FILE_BYTES) skipped.push({ path: f.path, reason: 'large' });
    else text.push(f);
  }
  text.sort((a, b) => Number(SCRIPT_EXT.test(b.path)) - Number(SCRIPT_EXT.test(a.path)) || a.path.localeCompare(b.path));
  for (const f of text.slice(SCAN_MAX_FILES)) skipped.push({ path: f.path, reason: 'limit' });
  const findings: FileScan['findings'] = [];
  const evidence: FileScan['evidence'] = [];
  let checked = 0;
  await pool(text.slice(0, SCAN_MAX_FILES), 6, async (f) => {
    const full = skill.dir_path ? `${skill.dir_path}/${f.path}` : f.path;
    const out = await github.getRawText(repo, ref, full, MAX_FILE_BYTES).catch(() => null);
    if (!out || out.text == null) return skipped.push({ path: f.path, reason: 'failed' });
    if (out.truncated) return skipped.push({ path: f.path, reason: 'large' });
    if (looksBinary(out.text)) return skipped.push({ path: f.path, reason: 'binary' });
    checked++;
    const flags = textFileFlags(out.text, f.path);
    if (flags.length) {
      findings.push({ path: f.path, flags });
      evidence.push(...textEvidence(out.text, f.path));
    }
  });
  findings.sort((a, b) => a.path.localeCompare(b.path));
  skipped.sort((a, b) => a.path.localeCompare(b.path));
  evidence.sort((a, b) => a.path.localeCompare(b.path) || (a.line ?? 0) - (b.line ?? 0));
  return { commit: ref, checked, findings, skipped, unlisted: Math.max(0, stored.total - stored.files.length), evidence };
}
