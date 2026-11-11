// Builds the prebuilt index (seed) the E2E server starts from: the fixture's plugins and skills go into a scratch
// database through the app's own row builders (so risk flags, quality warnings and the search text are what a real
// sync would have stored), and the app's own writeSeedFile turns it into the file a new install imports.
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { pluginRiskFlags } from '../../server/src/analyze/risk.ts';
import { createContext } from '../../server/src/bootstrap.ts';
import { writeSeedFile } from '../../server/src/db/seed.ts';
import { TreeIndex } from '../../server/src/discovery/tree.ts';
import { buildSkillRow, pluginFtsText } from '../../server/src/indexer.ts';
import { MARKETPLACE_REPOS, PLUGINS, skillMd, type FixtureMarketplace } from '../support/fixture.ts';

const DAY_MS = 24 * 60 * 60 * 1000;
/** A commit id per repo: made up, but the same on every run. */
const commitOf = (repo: string) => createHash('sha1').update(`skill-finder-e2e:${repo}`).digest('hex');
const NO_SIGNALS = { hooks: false, mcp: false, bin: false, monitors: false };

export type SeedSummary = { plugins: number; skills: number; repos: number; levels: Record<string, number>; unexpected: string[] };

/**
 * Writes the seed to `outPath`, using `workDir` for the scratch database. `unexpected`: skills whose risk level under
 * the app's current rules is not the one the fixture was written for (the fixture then needs another look).
 */
export function buildSeed(workDir: string, outPath: string, now = new Date()): SeedSummary {
  const dbPath = join(workDir, 'index.db');
  const { store } = createContext({ port: 0, dev: false, dataDir: workDir, githubToken: null }, dbPath);
  const lastCommitAt = new Date(now.getTime() - 12 * DAY_MS).toISOString();
  const levels: Record<string, number> = {};
  const unexpected: string[] = [];
  try {
    store.transaction(() => {
      for (const [name, repo] of Object.entries(MARKETPLACE_REPOS) as Array<[FixtureMarketplace, string]>) {
        store.updateMarketplaceSync(name, { commit_sha: commitOf(repo), plugin_count: PLUGINS.filter((p) => p.marketplace === name).length, etag: null });
      }
      for (const p of PLUGINS) {
        const id = `${p.name}@${p.marketplace}`;
        const sha = commitOf(p.repo);
        // in the marketplace's own repo: a relative source; elsewhere: a GitHub source pinned to a commit
        const relative = p.repo === MARKETPLACE_REPOS[p.marketplace];
        const source = relative ? `./${p.path ?? ''}` : { source: 'github', repo: p.repo, sha };
        const signals = p.signals ?? NO_SIGNALS;
        store.upsertPlugin({
          id,
          marketplace: p.marketplace,
          name: p.name,
          display_name: null,
          description: p.description,
          category: p.category,
          keywords: null,
          source_json: JSON.stringify(source),
          source_kind: relative ? 'relative' : 'github',
          repo: p.repo,
          path: p.path,
          ref: null,
          sha,
          strict: null,
          entry_json: JSON.stringify({ entry: { name: p.name, source, description: p.description }, pluginRoot: null }),
        });
        // indexed at its pinned commit, so the app has nothing to read again
        store.markPluginIndexed(id, sha, signals, null);
        const pluginText = pluginFtsText(store.getPlugin(id) ?? null);
        for (const s of p.skills) {
          const raw = skillMd(s);
          const tree = new TreeIndex([
            { path: `${s.dir}/SKILL.md`, size: Buffer.byteLength(raw) },
            ...(s.files ?? []).map((f) => ({ path: `${s.dir}/${f.path}`, size: f.size })),
          ]);
          const row = buildSkillRow({
            repo: p.repo,
            sha,
            dirPath: s.dir,
            raw,
            tree,
            origin: 'plugin',
            pluginId: id,
            extraFlags: pluginRiskFlags(signals, relative ? 'relative' : 'github'),
            install: null,
            lastCommitAt,
          });
          store.upsertSkill({ ...row, installs: s.installs ?? null }, pluginText);
          const level = row.risk_level ?? 'low';
          levels[level] = (levels[level] ?? 0) + 1;
          if (level !== s.intendedRisk) unexpected.push(`${s.name}: ${level} (fixture: ${s.intendedRisk})`);
        }
        store.upsertRepo({
          full_name: p.repo,
          stars: p.stars,
          pushed_at: lastCommitAt,
          archived: 0,
          fork: 0,
          license: 'MIT',
          default_branch: 'main',
          etag: null,
          // just read: a search takes the stored star count instead of asking GitHub
          fetched_at: now.toISOString(),
        });
      }
    });
  } finally {
    store.db.close();
  }
  const written = writeSeedFile(dbPath, outPath);
  return { plugins: written.plugins, skills: written.skills, repos: written.repos, levels, unexpected };
}
