import type { PluginSignals } from '../analyze/risk.ts';
import { joinPath, resolveRel, skillMdPath, type TreeIndex } from './tree.ts';

export type MarketplaceEntry = {
  name: string;
  source: unknown;
  skills?: unknown;
  strict?: boolean;
  [key: string]: unknown;
};

export type PluginManifest = Record<string, unknown>;

export type PluginDiscovery = {
  root: string;
  skillDirs: string[];
  signals: PluginSignals;
  /** strict:false entry that declares components while plugin.json also does — Claude Code refuses to load it. */
  strictConflict: boolean;
};

const COMPONENT_FIELDS = ['commands', 'agents', 'skills', 'hooks', 'mcpServers', 'lspServers', 'outputStyles', 'monitors'];

export function hasComponentFields(obj: Record<string, unknown> | null | undefined): boolean {
  return !!obj && COMPONENT_FIELDS.some((k) => obj[k] != null);
}

const toPathList = (v: unknown): string[] =>
  typeof v === 'string' ? [v] : Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

/**
 * Skill folders of one plugin (Claude Code plugin manifest rules):
 * - default `skills/<name>/SKILL.md`
 * - plugin.json `skills` and marketplace entry `skills` add to the default scan; each path is either a folder
 *   holding SKILL.md or a folder of `<name>/SKILL.md` bundles
 * - a root SKILL.md is a single-skill plugin when there is no `skills/` folder and no `skills` key
 * - an entry whose source is the marketplace root and lists `skills` loads only that list
 */
export function discoverPluginSkills(
  tree: TreeIndex,
  root: string,
  manifest: PluginManifest | null,
  entry: MarketplaceEntry | null,
  opts: { entryAtMarketplaceRoot?: boolean } = {},
): PluginDiscovery {
  const dirs = new Set<string>();
  const addPath = (rel: string) => {
    const abs = resolveRel(root, rel);
    if (abs == null) return;
    if (tree.hasFile(skillMdPath(abs))) {
      dirs.add(abs);
      return;
    }
    for (const child of tree.childDirs(abs)) if (tree.hasFile(skillMdPath(child))) dirs.add(child);
  };

  const entrySkills = toPathList(entry?.skills);
  if (opts.entryAtMarketplaceRoot && entrySkills.length > 0) {
    for (const p of entrySkills) addPath(p);
  } else {
    const defaultDir = joinPath(root, 'skills');
    for (const child of tree.childDirs(defaultDir)) if (tree.hasFile(skillMdPath(child))) dirs.add(child);
    for (const p of toPathList(manifest?.skills)) addPath(p);
    for (const p of entrySkills) addPath(p);
    const noSkillsKey = manifest?.skills == null && entry?.skills == null;
    if (tree.hasFile(skillMdPath(root)) && !tree.hasDir(defaultDir) && noSkillsKey) dirs.add(root);
  }

  const experimental = (manifest?.experimental ?? null) as Record<string, unknown> | null;
  const lsp = tree.hasFile(joinPath(root, '.lsp.json')) || manifest?.lspServers != null || entry?.lspServers != null;
  const signals: PluginSignals = {
    hooks: tree.hasFile(joinPath(root, 'hooks/hooks.json')) || manifest?.hooks != null || entry?.hooks != null,
    mcp: tree.hasFile(joinPath(root, '.mcp.json')) || manifest?.mcpServers != null || entry?.mcpServers != null,
    bin: tree.hasDir(joinPath(root, 'bin')) && tree.dirHasAnyFile(joinPath(root, 'bin')),
    monitors:
      tree.hasFile(joinPath(root, 'monitors/monitors.json')) ||
      experimental?.monitors != null ||
      manifest?.monitors != null ||
      entry?.monitors != null,
    // LSP servers run once installed (F3 full): shown with what runs, not a risk flag of its own. Only when present,
    // so the signals stored for every other plugin (and the rows built from them) stay as they were.
    ...(lsp ? { lsp: true } : {}),
  };

  const strictConflict = entry?.strict === false && hasComponentFields(manifest) && hasComponentFields(entry);

  return { root, skillDirs: [...dirs].sort(), signals, strictConflict };
}
