import { Router } from 'express';
import type { AppContext } from '../context.ts';
import type { StoredFiles } from '../indexer.ts';
import { existingSkillFolder } from '../install/installed.ts';
import { scanSkillFiles } from '../install/scan.ts';
import { buildSteps, installLocation, planInstall, type InstallScope } from '../install/plan.ts';
import { isProjectDir } from '../install/validate.ts';
import { freshness, TRUST_SCORE, trustTier } from '../search/rank.ts';
import { githubSource, marketplaceSource, treeUrl } from '../search/result.ts';
import { getSettings } from '../settings.ts';
import { looksBinary } from '../util/http.ts';
import { sanitizeText } from '../util/sanitize.ts';
import { isTextPath, MAX_FILE_BYTES } from '../util/textFiles.ts';

/**
 * Where an opened result was in its search (U5-2): the search's `sid`, its 1-based place in the list, the page,
 * and whether it was still an early card. Only well-formed values are kept; undefined when there are none.
 */
function viewMeta(q: Record<string, unknown>): Record<string, unknown> | undefined {
  const int = (v: unknown, max: number) => (typeof v === 'string' && /^\d{1,4}$/.test(v) && Number(v) >= 1 && Number(v) <= max ? Number(v) : undefined);
  const meta = {
    sid: typeof q.sid === 'string' && /^[0-9a-f-]{36}$/.test(q.sid) ? q.sid : undefined,
    pos: int(q.pos, 1000),
    page: int(q.page, 1000),
    provisional: q.prov === '1' ? true : undefined,
  };
  return Object.values(meta).some((v) => v !== undefined) ? meta : undefined;
}

export function skillsRouter(ctx: AppContext): Router {
  const r = Router();
  const { store, github } = ctx;

  r.get('/skills/:id', async (req, res) => {
    const skill = store.getSkill(req.params.id);
    if (!skill) {
      res.status(404).json({ error: '스킬을 찾을 수 없습니다' });
      return;
    }
    // Only results opened from a logged search (UI debate 1-6): a page reload, a pasted link or a script reading
    // the API would otherwise fill the log with views no search led to.
    const meta = viewMeta(req.query);
    if (getSettings(store).searchLog && meta?.sid) store.logEvent('view', skill.id, typeof req.query.q === 'string' ? req.query.q.slice(0, 300) : null, meta);
    const plugin = skill.plugin_id ? (store.getPlugin(skill.plugin_id) ?? null) : null;
    const marketplace = plugin ? (store.getMarketplace(plugin.marketplace) ?? null) : null;
    const plan = planInstall(skill, plugin, marketplace);
    const files = (skill.files_json ? JSON.parse(skill.files_json) : { files: [], total: 0 }) as StoredFiles;

    let skillMd: string | null = null;
    let skillMdError: string | null = null;
    if (skill.repo && skill.ref && skill.dir_path != null) {
      try {
        const res2 = await github.getRawText(skill.repo, skill.ref, skill.dir_path ? `${skill.dir_path}/SKILL.md` : 'SKILL.md', MAX_FILE_BYTES);
        if (res2.text == null) skillMdError = `SKILL.md를 가져오지 못했습니다 (${res2.status})`;
        else skillMd = sanitizeText(res2.text) + (res2.truncated ? '\n\n…(256KB에서 잘림)' : '');
      } catch (err) {
        skillMdError = `SKILL.md를 가져오지 못했습니다 (${String((err as Error).message ?? err).slice(0, 100)})`;
      }
    }

    const signals = plugin?.signals_json ? JSON.parse(plugin.signals_json) : null;
    const repoMeta = skill.repo ? (store.getRepo(skill.repo) ?? null) : null;
    // skills.sh lists it (it has a download count from there): its page also shows Gen·Socket·Snyk audits
    const skillsSh =
      skill.installs != null && skill.repo
        ? { kind: 'skillssh' as const, label: 'skills.sh', url: `https://skills.sh/${[...skill.repo.split('/'), skill.name].map(encodeURIComponent).join('/')}` }
        : null;
    const sources = [plugin ? marketplaceSource(skill, plugin) : null, githubSource(skill), skillsSh].filter(Boolean);
    res.json({
      id: skill.id,
      name: skill.name,
      description: skill.description,
      whenToUse: skill.when_to_use,
      origin: skill.origin,
      repo: skill.repo,
      ref: skill.ref,
      dirPath: skill.dir_path,
      url: skill.repo ? treeUrl(skill.repo, skill.ref, skill.dir_path) : null,
      sources,
      installs: skill.installs,
      stars: repoMeta?.stars ?? null,
      license: repoMeta?.license ?? null,
      archived: repoMeta?.archived === 1,
      lastCommitAt: skill.last_commit_at,
      frontmatter: skill.frontmatter_json ? JSON.parse(skill.frontmatter_json) : {},
      bodyLines: skill.body_lines,
      /** Absolute parts of the score; R and P are relative to a result set and come from the result card. */
      partialBreakdown: { F: freshness(skill.last_commit_at), T: TRUST_SCORE[trustTier(skill, plugin)] },
      riskLevel: skill.risk_level,
      riskFlags: skill.risk_json ? JSON.parse(skill.risk_json) : [],
      qualityWarnings: skill.quality_json ? JSON.parse(skill.quality_json) : [],
      skillMd,
      skillMdError,
      files: files.files.map((f) => ({ path: f.path, size: f.size, isText: isTextPath(f.path) })),
      filesTotal: files.total,
      plugin: plugin
        ? {
            id: plugin.id,
            name: plugin.name,
            displayName: plugin.display_name,
            description: plugin.description,
            marketplace: plugin.marketplace,
            sourceKind: plugin.source_kind,
            // with their risk: installing any one of them installs all (UI debate 1-1)
            skills: store.listSkillsByPlugin(plugin.id).map((s) => ({
              id: s.id,
              name: s.name,
              riskLevel: s.risk_level,
              riskFlags: s.risk_json ? (JSON.parse(s.risk_json) as string[]) : [],
            })),
            hooks: !!signals?.hooks,
            mcp: !!signals?.mcp,
            bin: !!signals?.bin,
            monitors: !!signals?.monitors,
            strictConflict: !!signals?.strictConflict,
          }
        : null,
      install: plan,
    });
  });

  r.get('/skills/:id/file', async (req, res) => {
    const skill = store.getSkill(req.params.id);
    const path = typeof req.query.path === 'string' ? req.query.path : '';
    if (!skill || !skill.repo || !skill.ref || skill.dir_path == null) {
      res.status(404).json({ error: '스킬을 찾을 수 없습니다' });
      return;
    }
    const files = (skill.files_json ? JSON.parse(skill.files_json) : { files: [] }) as StoredFiles;
    const entry = files.files.find((f) => f.path === path);
    if (!entry) {
      res.status(404).json({ error: '스킬 폴더에 없는 파일입니다' });
      return;
    }
    if (!isTextPath(path)) {
      res.status(415).json({ error: '텍스트 파일만 열 수 있습니다' });
      return;
    }
    if (entry.size != null && entry.size > MAX_FILE_BYTES) {
      res.status(413).json({ error: '256KB를 넘는 파일은 열 수 없습니다' });
      return;
    }
    const full = skill.dir_path ? `${skill.dir_path}/${path}` : path;
    const out = await github.getRawText(skill.repo, skill.ref, full, MAX_FILE_BYTES).catch(() => null);
    if (!out || out.text == null) {
      res.status(502).json({ error: '파일을 가져오지 못했습니다' });
      return;
    }
    if (out.truncated) {
      res.status(413).json({ error: '256KB를 넘는 파일은 열 수 없습니다' });
      return;
    }
    if (looksBinary(out.text)) {
      res.status(415).json({ error: '텍스트 파일이 아닙니다' });
      return;
    }
    res.json({ path, content: sanitizeText(out.text) });
  });

  // What the install brings besides SKILL.md (project review F1): the folder's other text files checked with the
  // same rules, or what a plugin runs (hooks, MCP servers). Read only; asked once when the install tab opens.
  r.get('/skills/:id/install-scan', async (req, res) => {
    const skill = store.getSkill(req.params.id);
    if (!skill) {
      res.status(404).json({ error: '스킬을 찾을 수 없습니다' });
      return;
    }
    const plugin = skill.plugin_id ? (store.getPlugin(skill.plugin_id) ?? null) : null;
    const plan = planInstall(skill, plugin, plugin ? (store.getMarketplace(plugin.marketplace) ?? null) : null);
    try {
      if (plan.method === 'skills-cli' && skill.repo && skill.ref && skill.dir_path != null) {
        res.json({ kind: 'files', pinned: !!plan.pinnedRef, scan: await scanSkillFiles(github, skill) });
      } else if (plan.method === 'plugin' && plan.pluginId && store.getPlugin(plan.pluginId)?.repo) {
        res.json({ kind: 'plugin', pluginId: plan.pluginId, config: await ctx.indexer.pluginRunConfig(plan.pluginId) });
      } else {
        res.json({ kind: 'none', reason: plan.method === 'plugin' ? '색인한 마켓플레이스에 없는 플러그인이라 실행 설정을 읽지 못했습니다' : '앱에서 설치하지 않는 스킬입니다' });
      }
    } catch (err) {
      res.status(502).json({ error: `설치될 파일을 읽지 못했습니다: ${String((err as Error).message ?? err).slice(0, 200)}` });
    }
  });

  r.get('/install/preview', async (req, res) => {
    const id = typeof req.query.id === 'string' ? req.query.id : '';
    const scope = req.query.scope as InstallScope;
    const projectPath = typeof req.query.projectPath === 'string' && req.query.projectPath ? req.query.projectPath : null;
    const skill = store.getSkill(id);
    if (!skill) {
      res.status(404).json({ error: '스킬을 찾을 수 없습니다' });
      return;
    }
    const plugin = skill.plugin_id ? (store.getPlugin(skill.plugin_id) ?? null) : null;
    const plan = planInstall(skill, plugin, plugin ? (store.getMarketplace(plugin.marketplace) ?? null) : null);
    if (!plan.scopes.includes(scope)) {
      res.json({ plan, steps: [], location: '', error: plan.method === 'manual-only' ? plan.reason : '이 방식에서 지원하지 않는 범위입니다' });
      return;
    }
    if (scope !== 'user' && !isProjectDir(projectPath)) {
      res.json({ plan, steps: [], location: '', error: '프로젝트 경로는 존재하는 디렉터리의 절대경로여야 합니다' });
      return;
    }
    const steps = buildSteps(plan, scope, projectPath);
    res.json({
      plan,
      steps: steps.map((s) => ({ display: s.display, cwd: s.cwd })),
      location: installLocation(plan, scope, projectPath),
      createsLockFile: plan.method === 'skills-cli' && scope === 'project',
      // the skills CLI replaces a folder of the same name without asking (-y, D-5): say so before the install
      existing: plan.method === 'skills-cli' && scope !== 'local' ? await existingSkillFolder(store, skill.id, plan.skillName!, scope, projectPath) : null,
    });
  });

  return r;
}
