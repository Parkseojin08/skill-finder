import { z } from 'zod';
import { normalizeSource, resolveRelativeRoot } from '../sources/pluginSource.ts';
import { discoverGenericSkills, type GenericSkill, type SkillMdReader, type SkillMdValidator } from './genericRules.ts';
import { discoverPluginSkills, type MarketplaceEntry, type PluginDiscovery, type PluginManifest } from './pluginRules.ts';
import { joinPath, type TreeIndex } from './tree.ts';

export type RepoMode = 'marketplace' | 'plugin' | 'generic';

export const MARKETPLACE_JSON = '.claude-plugin/marketplace.json';
export const PLUGIN_JSON = '.claude-plugin/plugin.json';

export function classifyRepo(tree: TreeIndex): RepoMode {
  if (tree.hasFile(MARKETPLACE_JSON)) return 'marketplace';
  if (tree.hasFile(PLUGIN_JSON)) return 'plugin';
  return 'generic';
}

export const MarketplaceSchema = z.looseObject({
  name: z.string().min(1),
  metadata: z.looseObject({ pluginRoot: z.string().optional() }).optional(),
  plugins: z.array(z.looseObject({ name: z.string().min(1), source: z.unknown() })),
});

export type MarketplaceManifest = z.infer<typeof MarketplaceSchema>;

export function parseMarketplace(text: string): MarketplaceManifest {
  return MarketplaceSchema.parse(JSON.parse(text));
}

export function parseJsonObject(text: string | null): Record<string, unknown> | null {
  if (text == null) return null;
  try {
    const v = JSON.parse(text);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export type DiscoveredPlugin = PluginDiscovery & { name: string; manifest: PluginManifest | null };

export type RepoDiscovery = {
  mode: RepoMode;
  marketplaceName: string | null;
  plugins: DiscoveredPlugin[];
  generic: GenericSkill[];
};

/**
 * §5.1: marketplace.json → each relative entry with plugin rules; plugin.json → plugin rules at the root;
 * otherwise the generic (skills CLI) rules. External entries of a marketplace live in other repos and are skipped.
 */
export async function discoverRepo(
  tree: TreeIndex,
  read: SkillMdReader,
  validate: SkillMdValidator,
): Promise<RepoDiscovery> {
  const mode = classifyRepo(tree);
  if (mode === 'generic') {
    return { mode, marketplaceName: null, plugins: [], generic: await discoverGenericSkills(tree, read, validate) };
  }
  if (mode === 'plugin') {
    const manifest = parseJsonObject(await read(PLUGIN_JSON));
    const d = discoverPluginSkills(tree, '', manifest, null);
    const name = typeof manifest?.name === 'string' ? manifest.name : '';
    return { mode, marketplaceName: null, plugins: [{ ...d, name, manifest }], generic: [] };
  }
  let market: MarketplaceManifest;
  try {
    market = parseMarketplace((await read(MARKETPLACE_JSON)) ?? '');
  } catch {
    // An unreadable marketplace.json: fall back to plugin.json or the generic rules.
    if (tree.hasFile(PLUGIN_JSON)) {
      const manifest = parseJsonObject(await read(PLUGIN_JSON));
      const d = discoverPluginSkills(tree, '', manifest, null);
      return { mode: 'plugin', marketplaceName: null, plugins: [{ ...d, name: String(manifest?.name ?? ''), manifest }], generic: [] };
    }
    return { mode: 'generic', marketplaceName: null, plugins: [], generic: await discoverGenericSkills(tree, read, validate) };
  }
  const pluginRoot = market.metadata?.pluginRoot ?? null;
  const plugins: DiscoveredPlugin[] = [];
  for (const entry of market.plugins as MarketplaceEntry[]) {
    const src = normalizeSource(entry.source, pluginRoot);
    if (src.kind !== 'relative') continue;
    const root = resolveRelativeRoot(src.raw, pluginRoot, tree);
    if (root == null || !tree.hasDir(root)) continue;
    const manifestPath = joinPath(root, PLUGIN_JSON);
    const manifest = tree.hasFile(manifestPath) ? parseJsonObject(await read(manifestPath)) : null;
    const d = discoverPluginSkills(tree, root, manifest, entry, { entryAtMarketplaceRoot: root === '' });
    plugins.push({ ...d, name: entry.name, manifest });
  }
  return { mode, marketplaceName: market.name, plugins, generic: [] };
}
