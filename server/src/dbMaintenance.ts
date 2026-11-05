// The weekly database check (feature review B2), run by the scheduler when nothing else runs: SQLite's quick check,
// the full-text indexes' own check and merge, the planner's statistics, the write-ahead log folded back into the
// file, and star-count rows nothing points at any more. Each step is timed; past the time budget the rest wait for
// the next week. Problems found are the run's error (shown in the status view); nothing is repaired automatically.
import type { AppContext } from './context.ts';
import type { TaskOutcome, TaskRunInfo } from './scheduler.ts';

/** Repo rows (star counts) nothing refers to are dropped once this old. */
export const REPO_ROW_KEEP_MS = 30 * 24 * 60 * 60 * 1000;
export const DB_CHECK_BUDGET_MS = 60 * 1000;
const FTS_TABLES = ['skills_fts', 'plugins_fts'] as const;

const yieldToServer = () => new Promise<void>((r) => setImmediate(r));

/**
 * Deletes repos rows older than 30 days that no skill, plugin, marketplace, favorite or moved-repo row names (case
 * ignored, as GitHub names are). Rows never fetched (no time) are kept.
 */
export function pruneUnusedRepos(ctx: AppContext, now = Date.now()): number {
  const before = new Date(now - REPO_ROW_KEEP_MS).toISOString();
  return Number(
    ctx.store.db
      .prepare(
        `DELETE FROM repos WHERE fetched_at IS NOT NULL AND fetched_at < ? AND lower(full_name) NOT IN (
           SELECT lower(repo) FROM skills WHERE repo IS NOT NULL
           UNION SELECT lower(repo) FROM plugins WHERE repo IS NOT NULL
           UNION SELECT lower(repo) FROM marketplaces
           UNION SELECT lower(substr(skill_id, 6)) FROM favorites WHERE skill_id LIKE 'repo:%'
           UNION SELECT lower(moved_to) FROM repos WHERE moved_to IS NOT NULL)`,
      )
      .run(before).changes,
  );
}

export async function runDbMaintenance(ctx: AppContext, info?: TaskRunInfo, opts: { budgetMs?: number; now?: () => number } = {}): Promise<TaskOutcome> {
  const db = ctx.store.db;
  const clock = opts.now ?? Date.now;
  const budget = opts.budgetMs ?? DB_CHECK_BUDGET_MS;
  const t0 = clock();
  const counts: Record<string, number> = {};
  const problems: string[] = [];
  const steps: Array<[string, () => void]> = [
    [
      'quickCheck',
      () => {
        const rows = db.prepare('PRAGMA quick_check(20)').all() as Array<Record<string, unknown>>;
        const bad = rows.map((r) => String(Object.values(r)[0])).filter((v) => v !== 'ok');
        counts.quickCheckProblems = bad.length;
        if (bad.length) problems.push(`quick_check: ${bad.slice(0, 3).join('; ')}`);
      },
    ],
    [
      'ftsCheck',
      () => {
        for (const t of FTS_TABLES) {
          try {
            db.prepare(`INSERT INTO ${t}(${t}) VALUES ('integrity-check')`).run();
          } catch (err) {
            counts.ftsProblems = (counts.ftsProblems ?? 0) + 1;
            problems.push(`${t}: ${String((err as Error).message ?? err).slice(0, 120)}`);
          }
        }
      },
    ],
    [
      'ftsOptimize',
      () => {
        for (const t of FTS_TABLES) db.prepare(`INSERT INTO ${t}(${t}) VALUES ('optimize')`).run();
      },
    ],
    ['optimize', () => void db.exec('PRAGMA optimize')],
    [
      'checkpoint',
      () => {
        const r = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get() as { busy?: number; log?: number; checkpointed?: number } | undefined;
        counts.walBusy = Number(r?.busy ?? 0);
        counts.walPages = Number(r?.checkpointed ?? 0);
      },
    ],
    ['repos', () => void (counts.reposPruned = pruneUnusedRepos(ctx, clock()))],
  ];
  let skipped = 0;
  for (const [name, step] of steps) {
    if (info?.signal.aborted || clock() - t0 > budget) {
      skipped++;
      continue;
    }
    const s0 = clock();
    try {
      step();
    } catch (err) {
      problems.push(`${name}: ${String((err as Error).message ?? err).slice(0, 120)}`);
    }
    counts[`${name}Ms`] = clock() - s0;
    await yieldToServer(); // each step is one synchronous statement; let requests through in between
  }
  if (skipped) counts.skippedSteps = skipped;
  if (problems.length) throw new Error(`DB 점검에서 문제를 찾았습니다: ${problems.join(' · ')}`.slice(0, 300));
  return { counts, note: skipped ? `시간 제한으로 ${skipped}단계를 다음 점검으로 미룸` : undefined };
}
