import { arch, platform, release } from 'node:os';
import { Router } from 'express';
import { z } from 'zod';
import { claudeVersion } from '../claude/cli.ts';
import { ENV_PATH, saveGithubToken, SKILLS_CLI_VERSION } from '../config.ts';
import type { AppContext } from '../context.ts';
import { isPluginName, isRepo } from '../install/validate.ts';
import { bumpIndexGeneration } from '../search/indexGeneration.ts';
import { getSettings, saveSettings, SettingsSchema } from '../settings.ts';
import { fetchMarketplaceManifest } from '../sources/marketplace.ts';
import { parseGithubRepo } from '../sources/pluginSource.ts';
import { popularState } from '../sources/popularRepos.ts';
import { networkState, schedulerFor } from '../scheduler.ts';
import { startCollect, startPopularCollect, startSync } from '../tasks.ts';
import { addSecret, logFilePath, logTail, maskSecrets } from '../util/log.ts';
import { APP_VERSION } from '../version.ts';

const SettingsPut = z.object({
  settings: SettingsSchema.partial().optional(),
  githubToken: z.string().max(400).regex(/^[A-Za-z0-9_\-]*$/, '토큰 형식이 올바르지 않습니다').optional(),
});

const ClientError = z.object({ message: z.string().max(2000), stack: z.string().max(8000).optional() });

const AddMarketplace =z.object({ repo: z.string().min(3).max(200), indexMode: z.enum(['eager', 'lazy']).default('lazy') });
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

  const settingsResponse = () => ({
    settings: getSettings(store),
    githubToken: !!ctx.config.githubToken,
    /** Where the index, search log and token live, so people know what to keep or delete (UI debate D-6). */
    dataDir: ctx.config.dataDir,
    envPath: ENV_PATH,
    marketplaces: marketplaces(),
    searchLogCount: store.countSearchLog(),
  });

  r.get('/settings', (_req, res) => {
    res.json(settingsResponse());
  });

  r.put('/settings', (req, res) => {
    const parsed = SettingsPut.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? '설정 형식이 올바르지 않습니다' });
      return;
    }
    if (parsed.data.settings) {
      const cur = getSettings(store);
      const next = SettingsSchema.safeParse({ ...cur, ...parsed.data.settings, weights: cur.weights });
      if (!next.success) {
        res.status(400).json({ error: next.error.issues[0]?.message ?? '설정 형식이 올바르지 않습니다' });
        return;
      }
      saveSettings(store, next.data);
      store.clearSearchCache();
    }
    if (parsed.data.githubToken !== undefined) {
      addSecret(parsed.data.githubToken);
      saveGithubToken(parsed.data.githubToken || null);
      store.clearSearchCache();
    }
    res.json(settingsResponse());
  });

  // "진단 정보 복사" in the settings (project review F2): what helps tell a problem, without the token, searches or
  // the home folder's name (shown as ~). The page copies it to the clipboard; nothing is sent anywhere.
  r.get('/diagnostics', async (_req, res) => {
    const s = getSettings(store);
    const broken = marketplaces().filter((m) => m.error || m.pendingSkillIndex);
    const lines = [
      `Skill Finder ${APP_VERSION ?? '?'} · Node ${process.version} · ${platform()} ${release()} ${arch()}`,
      `Claude Code ${(await claudeVersion()) ?? '찾지 못함'} · skills CLI ${SKILLS_CLI_VERSION}`,
      `GitHub 토큰 ${ctx.config.githubToken ? '있음' : '없음'} · 포트 ${ctx.config.port}`,
      `데이터 ${ctx.config.dataDir} · 로그 ${logFilePath() ?? '없음'}`,
      `색인 플러그인 ${store.countPlugins()} · 스킬 ${store.countSkills()} · 마켓플레이스 ${store.listMarketplaces().length}`,
      ...broken.map((m) => `  ${m.name}: ${m.error ?? ''}${m.pendingSkillIndex ? ` (색인 대기 ${m.pendingSkillIndex})` : ''}`),
      `설정 최소 별 ${s.minStars} · 자동 수집 ${s.autoCollect ? '켬' : '끔'} · 기본 범위 ${s.defaultScope} · 검색 기록 ${s.searchLog ? '켬' : '끔'}`,
      ...jobs
        .list()
        .slice(-5)
        .map((j) => `작업 ${j.kind} ${j.status} ${j.done}/${j.total} ${j.label}${j.errors.length ? ` · 오류 ${j.errors.length} (${j.errors[0]})` : ''}`),
      ...(networkState().offline ? [`네트워크 끊김 (${networkState().since}) · ${networkState().lastError ?? ''}`] : []),
      ...schedulerFor(ctx)
        .recentRuns(5, { failedOnly: true })
        .map((r) => `실패한 작업 ${r.kind} ${r.started_at} (${r.trigger}) ${r.error ?? ''}`),
      '',
      '최근 로그',
      logTail(80) || '(없음)',
    ];
    res.json({ text: maskSecrets(lines.join('\n')) });
  });

  // A screen error caught by the page (its ErrorBoundary) goes into the log file, so the diagnostics carry it.
  r.post('/client-error', (req, res) => {
    const parsed = ClientError.safeParse(req.body);
    if (parsed.success) console.error('[화면 오류]', parsed.data.message, parsed.data.stack ?? '');
    res.status(204).end();
  });

  // "기록 지우기" in the settings (U5-2)
  r.delete('/search-log', (_req, res) => {
    store.clearSearchLog();
    res.json(settingsResponse());
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
    // the index changed: cached searches show as earlier results until searched again (feature review B1)
    bumpIndexGeneration(store);
    res.json({ marketplaces: marketplaces() });
  });

  r.delete('/marketplaces/:name', (req, res) => {
    if (!store.getMarketplace(req.params.name)) {
      res.status(404).json({ error: '마켓플레이스가 없습니다' });
      return;
    }
    store.deleteMarketplace(req.params.name);
    bumpIndexGeneration(store);
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
