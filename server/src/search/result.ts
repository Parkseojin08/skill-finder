import type { RiskLevel } from '../analyze/risk.ts';
import type { MarketplaceRow, PluginRow, SkillRow, Store } from '../db/store.ts';
import { planInstall, type InstallMethod } from '../install/plan.ts';
import { truncate } from '../util/sanitize.ts';
import { categorize, type Category } from './category.ts';
import { trustTier, type Breakdown, type TrustTier } from './rank.ts';

export type SourceKind = 'marketplace' | 'skillssh' | 'github';
export type SourceRef = { kind: SourceKind; label: string; url: string };

export type ResultItem = {
  id: string;
  name: string;
  /** SKILL.md description, trimmed. */
  description: string;
  sources: SourceRef[];
  installs?: number;
  stars?: number;
  lastCommitAt?: string;
  score: number;
  breakdown: Breakdown;
  riskLevel: RiskLevel;
  riskFlags: string[];
  qualityWarnings: string[];
  install: { method: InstallMethod; command: string; pluginId?: string; disabled?: boolean };
  plugin?: { id: string; name: string; marketplace: string; skillCount: number };
  /** Who stands behind it (same tiers as the T score); the sidebar filters on it. */
  trust: TrustTier;
  /** 1–2 rule-based categories from the marketplace category and name/description keywords. */
  categories: Category[];
};

/** A GitHub repository shown as a result of its own (one-word query equal to its name, e.g. "rea"). */
export type RepoResult = {
  repo: string;
  url: string;
  description: string | null;
  stars: number | null;
  topics: string[];
  /** Skills found in the repo (also listed among the skill results), with what installing them would take. */
  skills: Array<{ id: string; name: string; riskLevel: RiskLevel; method: InstallMethod; installable: boolean; scopes: string[] }>;
};

export const TRUST_LABEL = { official: '공식', partner: '파트너', community: '커뮤니티' } as const;

export function treeUrl(repo: string, ref: string | null, dir: string | null): string {
  const base = `https://github.com/${repo}`;
  if (!ref) return base;
  return dir ? `${base}/tree/${ref}/${dir.split('/').map(encodeURIComponent).join('/')}` : `${base}/tree/${ref}`;
}

export function marketplaceSource(skill: SkillRow, plugin: PluginRow): SourceRef {
  const tier = trustTier(skill, plugin);
  const label = tier === 'other' ? plugin.marketplace : TRUST_LABEL[tier];
  return { kind: 'marketplace', label, url: skill.repo ? treeUrl(skill.repo, skill.ref, skill.dir_path) : '' };
}

export function githubSource(skill: SkillRow): SourceRef | null {
  if (!skill.repo) return null;
  return { kind: 'github', label: 'GitHub', url: treeUrl(skill.repo, skill.ref, skill.dir_path) };
}

export function mergeSources(a: SourceRef[], b: SourceRef[]): SourceRef[] {
  const out = [...a];
  for (const s of b) if (!out.some((x) => x.kind === s.kind && x.label === s.label)) out.push(s);
  return out;
}

export type Lookup = {
  plugin(id: string | null): PluginRow | null;
  marketplace(name: string | null | undefined): MarketplaceRow | null;
  pluginSkillCount(id: string): number;
};

export function storeLookup(store: Store): Lookup {
  const plugins = new Map<string, PluginRow | null>();
  const mps = new Map<string, MarketplaceRow | null>();
  const counts = new Map<string, number>();
  return {
    plugin(id) {
      if (!id) return null;
      if (!plugins.has(id)) plugins.set(id, store.getPlugin(id) ?? null);
      return plugins.get(id)!;
    },
    marketplace(name) {
      if (!name) return null;
      if (!mps.has(name)) mps.set(name, store.getMarketplace(name) ?? null);
      return mps.get(name)!;
    },
    pluginSkillCount(id) {
      if (!counts.has(id)) counts.set(id, store.listSkillsByPlugin(id).length);
      return counts.get(id)!;
    },
  };
}

export function buildResultItem(a: {
  skill: SkillRow;
  lookup: Lookup;
  sources: SourceRef[];
  installs: number | null;
  stars: number | null;
  breakdown: Breakdown;
  score: number;
}): ResultItem {
  const { skill } = a;
  const plugin = a.lookup.plugin(skill.plugin_id);
  const plan = planInstall(skill, plugin, a.lookup.marketplace(plugin?.marketplace));
  const desc = skill.description ?? '';
  return {
    id: skill.id,
    name: skill.name,
    description: truncate(desc, 300),
    sources: a.sources,
    ...(a.installs != null ? { installs: a.installs } : {}),
    ...(a.stars != null ? { stars: a.stars } : {}),
    ...(skill.last_commit_at ? { lastCommitAt: skill.last_commit_at } : {}),
    score: Math.round(a.score * 1000) / 1000,
    breakdown: {
      R: Math.round(a.breakdown.R * 1000) / 1000,
      P: Math.round(a.breakdown.P * 1000) / 1000,
      F: Math.round(a.breakdown.F * 1000) / 1000,
      T: Math.round(a.breakdown.T * 1000) / 1000,
    },
    riskLevel: (skill.risk_level as RiskLevel) ?? 'low',
    riskFlags: skill.risk_json ? JSON.parse(skill.risk_json) : [],
    qualityWarnings: skill.quality_json ? JSON.parse(skill.quality_json) : [],
    install: {
      method: plan.method,
      command: plan.command,
      ...(plan.pluginId ? { pluginId: plan.pluginId } : {}),
      ...(plan.disabled ? { disabled: true } : {}),
    },
    ...(plugin
      ? { plugin: { id: plugin.id, name: plugin.name, marketplace: plugin.marketplace, skillCount: a.lookup.pluginSkillCount(plugin.id) } }
      : {}),
    trust: trustTier(skill, plugin),
    categories: categorize({ name: skill.name, description: desc, whenToUse: skill.when_to_use, marketplaceCategory: plugin?.category }),
  };
}
