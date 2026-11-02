import { Router } from 'express';
import { z } from 'zod';
import type { AppContext } from '../context.ts';
import type { SkillRow } from '../db/store.ts';
import { installSummary, type InstallSummary } from '../install/summary.ts';
import { isRepo } from '../install/validate.ts';
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

export function presetsRouter(ctx: AppContext): Router {
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
      skills.push(installSummary(skill, lookup, plugin ? `${plugin.name} (플러그인)` : skill.name));
    }
    res.json({ skills, missing });
  });

  return r;
}
