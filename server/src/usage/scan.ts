// The usage-scan task (feature review F11, decision 14): counts skill uses in Claude Code's transcripts
// (~/.claude/projects/<project>/*.jsonl and the subagents' <session>/subagents/*.jsonl) into skill_usage. Off by
// default; with the setting off nothing is read. Each file goes on from where the last run stopped
// (usage_scan_files: offset, size, mtime) and starts over when it got shorter or older. Lines are read in chunks and
// only those holding a mark are decoded and parsed: about 1.5GB in 584 files on the reviewer's PC, never in memory
// at once. A run stops at its time budget and pauses while a search is running (search/activity.ts).
import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AppContext } from '../context.ts';
import type { Store } from '../db/store.ts';
import { searchActivity } from '../search/activity.ts';
import { getSettings } from '../settings.ts';
import { mayHoldUse, usesInLine } from './parse.ts';

export type UsageScanOptions = {
  /** The home folder whose ~/.claude/projects is read (tests: a temporary one). */
  home?: string;
  /** How long one run may read (default 20 s); the rest waits for the next run. */
  budgetMs?: number;
  /** A line longer than this is skipped unread (a pasted image, a huge tool result): uses are short lines. */
  maxLineBytes?: number;
};

export type UsageScanOutcome = { counts?: Record<string, number>; skipped?: boolean; note?: string };

export const USAGE_SCAN_BUDGET_MS = 20_000;
export const USAGE_SCAN_EVERY_MS = 60 * 60 * 1000;
const MAX_LINE_BYTES = 8 * 1024 * 1024;
/** Longest a run waits for searches to finish before it stops and leaves the rest for later. */
const MAX_PAUSE_MS = 30_000;
const CHUNK = 1 << 20;
/** Repeated uses (one id in two files) are dropped within a run; the set is cut at this size. */
const MAX_SEEN = 200_000;

type FileState = { path: string; size: number; mtime_ms: number; offset: number };

/** The transcript files under <home>/.claude/projects: each project's *.jsonl and its sessions' subagents/*.jsonl. */
export async function transcriptFiles(home: string): Promise<string[]> {
  const root = join(home, '.claude', 'projects');
  const out: string[] = [];
  const dirs = await readdir(root, { withFileTypes: true }).catch(() => []);
  for (const d of dirs) {
    if (!d.isDirectory()) continue; // a link is not followed
    const dir = join(root, d.name);
    for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (e.isFile() && e.name.endsWith('.jsonl')) out.push(join(dir, e.name));
      else if (e.isDirectory()) {
        const sub = join(dir, e.name, 'subagents');
        for (const f of await readdir(sub, { withFileTypes: true }).catch(() => [])) if (f.isFile() && f.name.endsWith('.jsonl')) out.push(join(sub, f.name));
      }
    }
  }
  return out;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Tally = Map<string, { day: string; project: string; skill: string; plugin: string; count: number }>;

/**
 * Reads `path` from byte `start` up to `end`, a line at a time, adding the uses found to `tally`. Returns the offset
 * after the last whole line read (a line still being written stays for the next run) and whether it stopped early.
 */
export async function readLines(
  path: string,
  start: number,
  end: number,
  onLine: (line: Buffer) => void,
  stop: () => Promise<boolean>,
  maxLine = MAX_LINE_BYTES,
): Promise<{ offset: number; stopped: boolean }> {
  if (end <= start) return { offset: start, stopped: false };
  const stream = createReadStream(path, { start, end: end - 1, highWaterMark: CHUNK });
  let chunkStart = start;
  let offset = start; // just after the last whole line
  let parts: Buffer[] = [];
  let partLen = 0;
  let skipping = false; // inside a line longer than maxLine: its bytes are dropped as they come
  try {
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      let i = 0;
      while (i < chunk.length) {
        const nl = chunk.indexOf(0x0a, i);
        if (nl < 0) {
          if (!skipping) {
            parts.push(chunk.subarray(i));
            partLen += chunk.length - i;
            if (partLen > maxLine) {
              skipping = true;
              parts = [];
              partLen = 0;
            }
          }
          break;
        }
        const piece = chunk.subarray(i, nl);
        if (!skipping && partLen + piece.length <= maxLine) onLine(parts.length ? Buffer.concat([...parts, piece]) : piece);
        skipping = false;
        parts = [];
        partLen = 0;
        offset = chunkStart + nl + 1;
        i = nl + 1;
      }
      chunkStart += chunk.length;
      if (await stop()) return { offset, stopped: true };
    }
  } finally {
    stream.destroy();
  }
  return { offset, stopped: false };
}

/** Adds one file's counts and its new position in one transaction, so a crash never counts a line twice. */
function saveFile(store: Store, tally: Tally, state: FileState): void {
  store.transaction(() => {
    const add = store.db.prepare(
      `INSERT INTO skill_usage (day, project_path, skill, plugin, count) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(day, project_path, skill, plugin) DO UPDATE SET count = count + excluded.count`,
    );
    for (const t of tally.values()) add.run(t.day, t.project, t.skill, t.plugin, t.count);
    store.db
      .prepare(
        `INSERT INTO usage_scan_files (path, size, mtime_ms, offset, scanned_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET size = excluded.size, mtime_ms = excluded.mtime_ms, offset = excluded.offset, scanned_at = excluded.scanned_at`,
      )
      .run(state.path, state.size, state.mtime_ms, state.offset, new Date().toISOString());
  });
}

/** Empties the counts and the read positions (turning the setting off, "기록 비우기"). */
export function clearUsage(store: Store): { rows: number } {
  return store.transaction(() => {
    const rows = Number(store.db.prepare('DELETE FROM skill_usage').run().changes);
    store.db.prepare('DELETE FROM usage_scan_files').run();
    return { rows };
  });
}

export async function runUsageScan(ctx: AppContext, info?: { signal?: AbortSignal }, opts: UsageScanOptions = {}): Promise<UsageScanOutcome> {
  const { store } = ctx;
  if (!getSettings(store).usageScan) return { skipped: true, note: '설정에서 꺼져 있어 읽지 않았습니다' };
  const home = opts.home ?? homedir();
  const budget = opts.budgetMs ?? USAGE_SCAN_BUDGET_MS;
  const began = Date.now();
  let paused = 0;
  let outOfTime = false;
  // turned off while this runs (the page then clears the tables): nothing more is read or written (review 2026-11-10)
  let turnedOff = false;
  const stop = async (): Promise<boolean> => {
    if (info?.signal?.aborted) return true;
    // a search is running: wait for it (not counted against the budget), give up after a while
    while (searchActivity.busy()) {
      if (paused >= MAX_PAUSE_MS) return true;
      await sleep(200);
      paused += 200;
    }
    // asked after the wait, so one turned off during it is seen at once
    if (!getSettings(store).usageScan) {
      turnedOff = true;
      return true;
    }
    if (Date.now() - began - paused > budget) {
      outOfTime = true;
      return true;
    }
    return false;
  };

  const known = new Map(
    (store.db.prepare('SELECT path, size, mtime_ms, offset FROM usage_scan_files').all() as FileState[]).map((r) => [r.path, r]),
  );
  const paths = await transcriptFiles(home);
  const stats = (
    await Promise.all(paths.map(async (p) => ({ path: p, st: await stat(p).catch(() => null) })))
  ).filter((x): x is { path: string; st: NonNullable<typeof x.st> } => !!x.st && x.st.isFile());
  // newest first: when the budget runs out, the recent days are the ones already counted
  stats.sort((a, b) => b.st.mtimeMs - a.st.mtimeMs);

  const counts = { files: stats.length, read: 0, restarted: 0, uses: 0, bytes: 0, left: 0 };
  const seen = new Set<string>();
  let stopped = false;
  for (const { path, st } of stats) {
    if (stopped) {
      counts.left++;
      continue;
    }
    const size = st.size;
    const mtime = Math.floor(st.mtimeMs);
    const prev = known.get(path);
    if (prev && prev.size === size && prev.mtime_ms === mtime) continue;
    // shorter than what was read, or older than when it was read: written anew, so read from the start
    const restart = !!prev && (size < prev.size || size < prev.offset || mtime < prev.mtime_ms);
    if (restart) counts.restarted++;
    const from = prev && !restart ? prev.offset : 0;
    const tally: Tally = new Map();
    const r = await readLines(
      path,
      from,
      size,
      (line) => {
        if (!mayHoldUse(line)) return;
        for (const u of usesInLine(line.toString('utf8'))) {
          if (u.key) {
            if (seen.has(u.key)) continue;
            if (seen.size < MAX_SEEN) seen.add(u.key);
          }
          const k = `${u.day}\u0000${u.project}\u0000${u.skill}\u0000${u.plugin}`;
          const hit = tally.get(k);
          if (hit) hit.count++;
          else tally.set(k, { day: u.day, project: u.project, skill: u.skill, plugin: u.plugin, count: 1 });
          counts.uses++;
        }
      },
      stop,
      opts.maxLineBytes ?? MAX_LINE_BYTES,
    ).catch(() => null); // a file removed or locked meanwhile: tried again next time
    if (!r) continue;
    if (turnedOff || !getSettings(store).usageScan) return { skipped: true, note: '읽는 중에 설정이 꺼져 멈췄습니다' };
    counts.read++;
    counts.bytes += r.offset - from;
    // stopped midway: the size kept is how far it got, so the next run goes on from there
    saveFile(store, tally, { path, size: r.stopped ? r.offset : size, mtime_ms: mtime, offset: r.offset });
    if (r.stopped) {
      stopped = true;
      counts.left++;
    }
  }
  // files gone from the disk: their positions are of no use (their counts stay)
  const present = new Set(stats.map((s) => s.path));
  const gone = [...known.keys()].filter((p) => !present.has(p));
  if (gone.length) {
    const del = store.db.prepare('DELETE FROM usage_scan_files WHERE path = ?');
    store.transaction(() => gone.forEach((p) => del.run(p)));
  }
  return { counts, ...(outOfTime || counts.left ? { note: `시간 상한으로 ${counts.left}개 파일은 다음에 이어 읽습니다` } : {}) };
}
