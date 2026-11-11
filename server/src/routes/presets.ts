import { homedir } from 'node:os';
import { Router } from 'express';
import { z } from 'zod';
import { listClaudePlugins } from '../agentConfig/read.ts';
import type { AppContext } from '../context.ts';
import type { SkillRow } from '../db/store.ts';
import { scanInstalledSkills } from '../install/installed.ts';
import { installSummary, type InstallSummary } from '../install/summary.ts';
import { isProjectDir, isRepo } from '../install/validate.ts';
import { knownMarketplaces, skillFolderHash, withoutUserinfo } from '../projects/standard.ts';
import { storeLookup } from '../search/result.ts';
import { withTimeout } from '../util/limiter.ts';

// A team preset is a file a teammate exported (설치됨 → 팀 프리셋 내보내기): skill ids from their index and plugin
// ids. It is untrusted input, so it only names things to look up here: what gets installed is this PC's indexed
// skill, risk-checked here, through the usual confirm dialog and /install (user decision 2026-11-02).
const Item = z.object({
  id: z.string().max(400).optional(),
  plugin: z.string().max(200).optional(),
  name: z.string().max(200).optional(),
});
const Body = z.object({ items: z.array(Item).max(200) });

/** GitHub repos to read before resolving: at most this many, each for at most REPO_WAIT_MS. */
const MAX_NEW_REPOS = 5;
const REPO_WAIT_MS = 10_000;

const repoOfId = (id: string) => id.match(/^gh:([^:]+):/)?.[1] ?? null;

/** `home`: the home folder read for the snippet (tests use a temporary one); the user's own otherwise. */
export function presetsRouter(ctx: AppContext, opts: { home?: string } = {}): Router {
  const r = Router();
  const { store } = ctx;

  r.post('/presets/resolve', async (req, res) => {
    const parsed = Body.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: '프리셋 형식이 맞지 않습니다' });
      return;
    }
    const items = parsed.data.items;
    // skills from GitHub repos this PC has not indexed yet: read a few of them now, as a repo-name search does
    const newRepos = [...new Set(items.flatMap((i) => (i.id && !store.getSkill(i.id) ? [repoOfId(i.id)] : [])))]
      .filter((r): r is string => isRepo(r))
      .slice(0, MAX_NEW_REPOS);
    await Promise.all(newRepos.map((repo) => withTimeout(ctx.indexer.indexRepo(repo), REPO_WAIT_MS).catch(() => null)));

    const lookup = storeLookup(store);
    const skills: InstallSummary[] = [];
    const missing: Array<{ name: string; reason: string }> = [];
    const seen = new Set<string>();
    for (const it of items) {
      const label = it.name ?? it.id ?? it.plugin ?? '?';
      let skill: SkillRow | null = it.id ? (store.getSkill(it.id) ?? null) : null;
      // a plugin installs whole, through any of its skills
      if (!skill && it.plugin) skill = store.listSkillsByPlugin(it.plugin)[0] ?? null;
      if (!skill) {
        missing.push({ name: label, reason: it.plugin ? '이 PC에서 그 플러그인의 스킬을 아직 색인하지 못했습니다' : '이 PC의 색인에 없습니다' });
        continue;
      }
      const plugin = lookup.plugin(skill.plugin_id);
      const key = plugin ? `plugin:${plugin.id}` : skill.id;
      if (seen.has(key)) continue;
      seen.add(key);
      const row = installSummary(skill, lookup, plugin ? `${plugin.name} (플러그인)` : skill.name);
      if (plugin) {
        // the whole plugin installs: its riskiest skill and every signal of its skills, so the dialog asks for the
        // tick a high-risk skill inside needs (review 2026-11-02)
        row.riskLevel = lookup.pluginTopRisk(plugin.id);
        row.riskFlags = [...new Set(store.listSkillsByPlugin(plugin.id).flatMap((s) => (s.risk_json ? (JSON.parse(s.risk_json) as string[]) : [])))];
      }
      skills.push(row);
    }
    res.json({ skills, missing });
  });

  // F12: the standard files' text for what is installed here — a skills-lock.json and the enabledPlugins /
  // extraKnownMarketplaces part of .claude/settings.json — to copy into a project. Read only; nothing is written.
  r.get('/presets/snippet', async (req, res) => {
    const projectPath = typeof req.query.projectPath === 'string' && req.query.projectPath.trim() ? req.query.projectPath.trim() : null;
    if (projectPath && !isProjectDir(projectPath)) {
      res.status(400).json({ error: '프로젝트 경로는 존재하는 디렉터리의 절대경로여야 합니다' });
      return;
    }
    try {
      res.json(await standardSnippet(store, projectPath, opts.home ?? homedir()));
    } catch (err) {
      res.status(500).json({ error: `조각을 만들지 못했습니다: ${String((err as Error).message ?? err).slice(0, 200)}` });
    }
  });

  return r;
}

export type StandardSnippet = {
  /** skills-lock.json as the skills CLI writes it (version 1, skills by name, sorted). */
  lock: string;
  /** The enabledPlugins / extraKnownMarketplaces part of .claude/settings.json. */
  settings: string;
  skills: number;
  plugins: number;
  /** Installed skills left out: not from a GitHub repo the index knows (hand-made, other hosts). */
  skippedSkills: number;
  /** Marketplaces added from a folder or file on this PC: not written (a teammate has no such path). */
  localMarkets: string[];
};

/**
 * The lock entries follow skills@1.7.6 `projectLockEntry` (source, sourceType, skillPath, computedHash), the hash
 * made over the installed copy as the CLI's update check does. No `ref`: the app installs the commit it checked.
 */
export async function standardSnippet(store: AppContext['store'], projectPath: string | null, home: string): Promise<StandardSnippet> {
  const installed = [
    ...(await scanInstalledSkills(store, 'user', null, undefined, { home })),
    ...(projectPath ? await scanInstalledSkills(store, 'project', projectPath, undefined, { home }) : []),
  ];
  const lockSkills: Record<string, Record<string, string>> = {};
  let skipped = 0;
  for (const s of installed) {
    const row = s.skillId ? store.getSkill(s.skillId) : undefined;
    if (!row || row.origin === 'plugin' || !row.repo || !isRepo(row.repo) || !row.id.startsWith('gh:')) {
      skipped++;
      continue;
    }
    if (lockSkills[s.name]) continue; // the same skill in both scopes: once
    const dir = (row.dir_path ?? '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    let hash: string | null = null;
    try {
      hash = await skillFolderHash(s.path);
    } catch {
      hash = null; // too large to hash: the CLI fills it in when it installs
    }
    lockSkills[s.name] = { source: row.repo, sourceType: 'github', skillPath: dir ? `${dir}/SKILL.md` : 'SKILL.md', ...(hash ? { computedHash: hash } : {}) };
  }
  const sorted = Object.fromEntries(Object.keys(lockSkills).sort().map((k) => [k, lockSkills[k]]));

  const plugins = (await listClaudePlugins({ home, projectPath })).filter((p) => p.enabled);
  const enabledPlugins: Record<string, boolean> = {};
  for (const p of plugins) enabledPlugins[p.id] = true;
  const known = knownMarketplaces(home);
  const extraKnownMarketplaces: Record<string, { source: unknown }> = {};
  const localMarkets: string[] = [];
  for (const id of Object.keys(enabledPlugins)) {
    const at = id.lastIndexOf('@');
    const market = at > 0 ? id.slice(at + 1) : null;
    if (!market || market === 'claude-plugins-official' || extraKnownMarketplaces[market] || localMarkets.includes(market)) continue;
    const source = known.get(market) as { source?: unknown; url?: unknown } | null | undefined;
    const kind = source && typeof source === 'object' ? source.source : null;
    // the snippet goes into the repository: a token written into the marketplace's address stays out of it
    if (kind === 'github' || kind === 'git' || kind === 'url') extraKnownMarketplaces[market] = { source: typeof source!.url === 'string' ? { ...source, url: withoutUserinfo(source!.url) } : source };
    else localMarkets.push(market);
  }
  const settings = {
    enabledPlugins,
    ...(Object.keys(extraKnownMarketplaces).length ? { extraKnownMarketplaces } : {}),
  };
  return {
    lock: `${JSON.stringify({ version: 1, skills: sorted }, null, 2)}\n`,
    settings: `${JSON.stringify(settings, null, 2)}\n`,
    skills: Object.keys(sorted).length,
    plugins: Object.keys(enabledPlugins).length,
    skippedSkills: skipped,
    localMarkets,
  };
}
