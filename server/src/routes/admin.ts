import { Router } from 'express';
import { z } from 'zod';
import { saveGithubToken } from '../config.ts';
import type { AppContext } from '../context.ts';
import { isPluginName, isRepo } from '../install/validate.ts';
import { getSettings, saveSettings, SettingsSchema } from '../settings.ts';
import { fetchMarketplaceManifest } from '../sources/marketplace.ts';
import { parseGithubRepo } from '../sources/pluginSource.ts';
import { popularState } from '../sources/popularRepos.ts';
import { startCollect, startPopularCollect, startSync } from '../tasks.ts';

const SettingsPut = z.object({
  settings: SettingsSchema.partial().optional(),
  githubToken: z.string().max(400).regex(/^[A-Za-z0-9_\-]*$/, '토큰 형식이 올바르지 않습니다').optional(),
});

const AddMarketplace = z.object({ repo: z.string().min(3).max(200), indexMode: z.enum(['eager', 'lazy']).default('lazy') });
const PatchMarketplace = z.object({ enabled: z.boolean().optional(), indexMode: z.enum(['eager', 'lazy']).optional() });

export function adminRouter(ctx: AppContext): Router {
  const r = Router();
  const { store, jobs } = ctx;

  const marketplaces = () =>
    store.listMarketplaces().map((m) => ({
      name: m.name,
      repo: m.repo,
      enabled: m.enabled === 1,
      indexMode: m.index_mode,
      syncedAt: m.synced_at,
      pluginCount: m.plugin_count,
      error: m.error,
      pendingSkillIndex: store.listPluginsNeedingIndex(m.name).length,
    }));

  r.get('/settings', (_req, res) => {
    res.json({ settings: getSettings(store), githubToken: !!ctx.config.githubToken, marketplaces: marketplaces() });
  });

  r.put('/settings', (req, res) => {
    const parsed = SettingsPut.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? '설정 형식이 올바르지 않습니다' });
      return;
    }
    if (parsed.data.settings) {
      const cur = getSettings(store);
      const next = SettingsSchema.safeParse({
        ...cur,
        ...parsed.data.settings,
        weights: { ...cur.weights, ...(parsed.data.settings.weights ?? {}) },
      });
      if (!next.success) {
        res.status(400).json({ error: next.error.issues[0]?.message ?? '설정 형식이 올바르지 않습니다' });
        return;
      }
      saveSettings(store, next.data);
      store.clearSearchCache();
    }
    if (parsed.data.githubToken !== undefined) {
      saveGithubToken(parsed.data.githubToken || null);
      store.clearSearchCache();
    }
    res.json({ settings: getSettings(store), githubToken: !!ctx.config.githubToken, marketplaces: marketplaces() });
  });

  r.get('/marketplaces', (_req, res) => {
    res.json({ marketplaces: marketplaces() });
  });

  r.post('/marketplaces', async (req, res) => {
    const parsed = AddMarketplace.safeParse(req.body);
    const repo = parsed.success ? parseGithubRepo(parsed.data.repo) : null;
    if (!parsed.success || !repo || !isRepo(repo)) {
      res.status(400).json({ error: 'GitHub 저장소(owner/repo 또는 URL)를 입력하세요' });
      return;
    }
    try {
      const { manifest } = await fetchMarketplaceManifest(ctx.github, repo);
      if (!isPluginName(manifest.name)) throw new Error('마켓플레이스 이름 형식이 올바르지 않습니다');
      if (store.getMarketplace(manifest.name)) throw new Error(`이미 있는 마켓플레이스입니다: ${manifest.name}`);
      store.upsertMarketplace({ name: manifest.name, repo, enabled: true, index_mode: parsed.data.indexMode });
      const job = startSync(ctx, manifest.name, true);
      res.json({ marketplaces: marketplaces(), jobId: job.id });
    } catch (err) {
      res.status(400).json({ error: String((err as Error).message ?? err).slice(0, 300) });
    }
  });

  r.patch('/marketplaces/:name', (req, res) => {
    const parsed = PatchMarketplace.safeParse(req.body);
    const m = store.getMarketplace(req.params.name);
    if (!parsed.success || !m) {
      res.status(m ? 400 : 404).json({ error: m ? '요청 형식이 올바르지 않습니다' : '마켓플레이스가 없습니다' });
      return;
    }
    store.upsertMarketplace({
      name: m.name,
      repo: m.repo,
      enabled: parsed.data.enabled ?? m.enabled === 1,
      index_mode: parsed.data.indexMode ?? m.index_mode,
    });
    store.clearSearchCache();
    res.json({ marketplaces: marketplaces() });
  });

  r.delete('/marketplaces/:name', (req, res) => {
    if (!store.getMarketplace(req.params.name)) {
      res.status(404).json({ error: '마켓플레이스가 없습니다' });
      return;
    }
    store.deleteMarketplace(req.params.name);
    store.clearSearchCache();
    res.json({ marketplaces: marketplaces() });
  });

  r.post('/sync', (req, res) => {
    const name = typeof req.body?.marketplace === 'string' ? req.body.marketplace : undefined;
    if (name && !store.getMarketplace(name)) {
      res.status(404).json({ error: '마켓플레이스가 없습니다' });
      return;
    }
    res.json({ jobId: startSync(ctx, name, true).id });
  });

  r.post('/collect', (req, res) => {
    const name = typeof req.body?.marketplace === 'string' ? req.body.marketplace : '';
    if (!store.getMarketplace(name)) {
      res.status(404).json({ error: '마켓플레이스가 없습니다' });
      return;
    }
    res.json({ jobId: startCollect(ctx, name).id });
  });

  r.get('/popular-repos', (_req, res) => {
    const s = popularState(ctx);
    const repos = Object.values(s.repos);
    res.json({ lastRunAt: s.lastRunAt, repos: repos.length, withSkills: repos.filter((r) => r.skills > 0).length, skills: repos.reduce((n, r) => n + r.skills, 0) });
  });

  r.post('/popular-repos/collect', (req, res) => {
    res.json({ jobId: startPopularCollect(ctx, false, req.body?.force === true).id });
  });

  r.get('/jobs', (_req, res) => {
    res.json({ jobs: jobs.list() });
  });

  r.get('/jobs/:id', (req, res) => {
    const job = jobs.get(req.params.id);
    if (!job) {
      res.status(404).json({ error: '작업이 없습니다' });
      return;
    }
    res.json(job);
  });

  r.post('/jobs/:id/:action', (req, res) => {
    const { id, action } = req.params;
    const ok = action === 'pause' ? jobs.pause(id) : action === 'resume' ? jobs.resume(id) : action === 'cancel' ? jobs.cancel(id) : null;
    if (ok === null) {
      res.status(404).json({ error: '알 수 없는 동작입니다' });
      return;
    }
    const job = jobs.get(id);
    if (!job) {
      res.status(404).json({ error: '작업이 없습니다' });
      return;
    }
    res.status(ok ? 200 : 409).json(job);
  });

  return r;
}
