import { RISK_ORDER, type RiskLevel } from '../analyze/risk.ts';
import type { MarketplaceRow, PluginRow, SkillRow, Store } from '../db/store.ts';
import { planInstall, type InstallMethod } from '../install/plan.ts';
import { truncate } from '../util/sanitize.ts';
import { categorize, type Category } from './category.ts';
import { freshInstalls, freshness, TRUST_SCORE, trustTier, type Breakdown, type TrustTier } from './rank.ts';

export type SourceKind = 'marketplace' | 'skillssh' | 'github';
export type SourceRef = { kind: SourceKind; label: string; url: string };

export type ResultItem = {
  id: string;
  name: string;
  /**
   * GitHub and skills.sh pages of other copies (same SKILL.md, other repos) folded into this result. Kept apart
   * from `sources`, whose badges are this skill's own: a "GitHub" badge on the official pdf led to a copy's repo
   * (review 2026-11-02).
   */
  copies?: SourceRef[];
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
  plugin?: { id: string; name: string; marketplace: string; skillCount: number; topRisk: RiskLevel };
  /** Who stands behind it (same tiers as the T score); the sidebar filters on it. */
  trust: TrustTier;
  /** 1–2 rule-based categories from the marketplace category and name/description keywords. */
  categories: Category[];
  /** Search results only: 1 when the name has a query word and half the words match (sorted first), else 0. */
  tier?: number;
};

/** A GitHub repository shown as a result of its own (one-word query equal to its name, e.g. "rea"). */
export type RepoResult = {
  repo: string;
  url: string;
  description: string | null;
  stars: number | null;
  topics: string[];
  /** Skills found in the repo (also listed among the skill results), with what installing them would take. */
  skills: Array<{ id: string; name: string; riskLevel: RiskLevel; riskFlags: string[]; method: InstallMethod; installable: boolean; scopes: string[] }>;
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

/** `owner/repo` a GitHub or skills.sh page is about; null for other links. */
function repoOfSource(s: SourceRef): string | null {
  const m = s.url.match(/^https:\/\/(?:github\.com|skills\.sh)\/([^/?#]+\/[^/?#]+)/i);
  return m ? decodeURIComponent(m[1]).toLowerCase() : null;
}

/** Sources of this skill's own repo, and those of copies in other repos (merged in from duplicates). */
export function splitCopies(sources: SourceRef[], repo: string | null): { own: SourceRef[]; copies: SourceRef[] } {
  if (!repo) return { own: sources, copies: [] };
  const own: SourceRef[] = [];
  const copies: SourceRef[] = [];
  for (const s of sources) {
    const r = repoOfSource(s);
    if (r && r !== repo.toLowerCase() && s.kind !== 'marketplace') copies.push(s);
    else own.push(s);
  }
  return { own, copies };
}

/** One link per kind, label and repo: copies in other repos are kept (buildResultItem shows them apart). */
export function mergeSources(a: SourceRef[], b: SourceRef[]): SourceRef[] {
  const out = [...a];
  const same = (x: SourceRef, s: SourceRef) => x.kind === s.kind && x.label === s.label && repoOfSource(x) === repoOfSource(s);
  for (const s of b) if (!out.some((x) => same(x, s))) out.push(s);
  return out;
}

export type Lookup = {
  plugin(id: string | null): PluginRow | null;
  marketplace(name: string | null | undefined): MarketplaceRow | null;
  pluginSkillCount(id: string): number;
  /** The highest risk level among the plugin's skills (they all install together). */
  pluginTopRisk(id: string): RiskLevel;
};

export function storeLookup(store: Store): Lookup {
  const plugins = new Map<string, PluginRow | null>();
  const mps = new Map<string, MarketplaceRow | null>();
  const skillsOf = new Map<string, SkillRow[]>();
  const list = (id: string) => {
    if (!skillsOf.has(id)) skillsOf.set(id, store.listSkillsByPlugin(id));
    return skillsOf.get(id)!;
  };
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
      return list(id).length;
    },
    pluginTopRisk(id) {
      return list(id).reduce<RiskLevel>((top, s) => (RISK_ORDER[s.risk_level as RiskLevel] > RISK_ORDER[top] ? (s.risk_level as RiskLevel) : top), 'low');
    },
  };
}

/** An indexed skill as a card outside a search (favorites, installed): no relevance or popularity score. */
export function indexItem(store: Store, lookup: Lookup, skill: SkillRow): ResultItem {
  const plugin = lookup.plugin(skill.plugin_id);
  const source = plugin ? marketplaceSource(skill, plugin) : githubSource(skill);
  const breakdown = { R: 0, P: 0, F: freshness(skill.last_commit_at), T: TRUST_SCORE[trustTier(skill, plugin)] };
  const stars = skill.repo ? (store.getRepo(skill.repo)?.stars ?? null) : null;
  return buildResultItem({ skill, lookup, sources: source ? [source] : [], installs: freshInstalls(skill), stars, breakdown, score: 0 });
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
  const { own, copies } = splitCopies(a.sources, skill.repo);
  return {
    id: skill.id,
    name: skill.name,
    description: truncate(desc, 300),
    sources: own,
    ...(copies.length ? { copies } : {}),
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
      ? {
          plugin: {
            id: plugin.id,
            name: plugin.name,
            marketplace: plugin.marketplace,
            skillCount: a.lookup.pluginSkillCount(plugin.id),
            topRisk: a.lookup.pluginTopRisk(plugin.id),
          },
        }
      : {}),
    trust: trustTier(skill, plugin),
    categories: categorize({ name: skill.name, description: desc, whenToUse: skill.when_to_use, marketplaceCategory: plugin?.category }),
  };
}
