import type { AppContext } from './context.ts';
import { PluginUnavailableError } from './indexer.ts';
import type { Job, JobControl } from './jobs.ts';
import { syncMarketplace } from './sources/marketplace.ts';
import { collectPopularRepos, popularState } from './sources/popularRepos.ts';
import { searchActivity } from './search/activity.ts';
import { getSettings } from './settings.ts';
import { pool, sleep } from './util/limiter.ts';

const COLLECT_CONCURRENCY = 4;
const BACKGROUND_CONCURRENCY = 3;

async function indexPending(ctx: AppContext, marketplace: string, ctl: JobControl, background = false): Promise<void> {
  const pending = ctx.store.listPluginsNeedingIndex(marketplace);
  ctl.addTotal(pending.length);
  await pool(
    pending,
    background ? BACKGROUND_CONCURRENCY : COLLECT_CONCURRENCY,
    async (p) => {
      await ctl.checkpoint();
      // Background collection steps aside while a search is running so searches stay fast.
      while (background && searchActivity.busy() && !ctl.cancelled) await sleep(500);
      try {
        await ctx.indexer.indexPlugin(p.id);
        ctl.tick();
      } catch (err) {
        const line = `${p.id}: ${String((err as Error).message ?? err).slice(0, 200)}`;
        if (err instanceof PluginUnavailableError) ctl.skip(line);
        else ctl.tick(line);
      }
    },
    () => ctl.cancelled,
  );
}

/** Syncs marketplace.json for one or all enabled marketplaces; eager ones also index their plugins' skills. */
export function startSync(ctx: AppContext, marketplace?: string, force = false): Job {
  const label = marketplace ?? '*';
  const running = ctx.jobs.active('sync', label);
  if (running) return running;
  return ctx.jobs.start('sync', label, async (ctl) => {
    const targets = ctx.store
      .listMarketplaces()
      .filter((m) => (marketplace ? m.name === marketplace : m.enabled === 1));
    ctl.setTotal(targets.length);
    for (const m of targets) {
      await ctl.checkpoint();
      try {
        await syncMarketplace(ctx.store, ctx.github, m.name, force);
        ctl.tick();
      } catch (err) {
        ctl.tick(`${m.name}: ${String((err as Error).message ?? err).slice(0, 200)}`);
        continue;
      }
      if (m.index_mode === 'eager') await indexPending(ctx, m.name, ctl);
    }
    ctx.store.clearSearchCache();
    if (!marketplace && getSettings(ctx.store).autoCollect) {
      startAutoCollect(ctx);
      const last = popularState(ctx).lastRunAt;
      if (!last || Date.now() - Date.parse(last) > POPULAR_EVERY_MS) startPopularCollect(ctx, true);
    }
  });
}

const POPULAR_EVERY_MS = 24 * 60 * 60 * 1000;
export const POPULAR_JOB_LABEL = 'popular-repos';

/** Finds GitHub repos with many stars that hold skills and indexes them (daily after sync, or on demand). */
export function startPopularCollect(ctx: AppContext, background = false, force = false): Job {
  const running = ctx.jobs.active('collect', POPULAR_JOB_LABEL);
  if (running) return running;
  return ctx.jobs.start('collect', POPULAR_JOB_LABEL, async (ctl) => {
    await collectPopularRepos(ctx, ctl, background, force);
    ctx.store.clearSearchCache();
  });
}

/** After a full sync: collect skills of every enabled lazy marketplace in the background (yields to searches). */
export function startAutoCollect(ctx: AppContext): void {
  for (const m of ctx.store.listMarketplaces()) {
    if (m.enabled !== 1 || m.index_mode !== 'lazy') continue;
    if (ctx.store.listPluginsNeedingIndex(m.name).length === 0) continue;
    startCollect(ctx, m.name, true);
  }
}

/** Background skill collection for a lazy marketplace; pause/resume via the job controls, restart-safe. */
export function startCollect(ctx: AppContext, marketplace: string, background = false): Job {
  const running = ctx.jobs.active('collect', marketplace);
  if (running) return running;
  return ctx.jobs.start('collect', marketplace, async (ctl) => {
    await indexPending(ctx, marketplace, ctl, background);
    ctx.store.clearSearchCache();
  });
}
