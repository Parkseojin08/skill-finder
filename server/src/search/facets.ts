import type { SkillRow, Store } from '../db/store.ts';
import { planInstall } from '../install/plan.ts';
import type { OwnerFilter } from '../prefs/ownerPrefs.ts';
import { ownerOfRepo } from '../prefs/ownerPrefs.ts';
import { categorize } from './category.ts';
import { trustTier } from './rank.ts';
import type { Lookup } from './result.ts';

/**
 * "이 조건으로 전체에서 다시 찾기" (F19, feature review 2026-11-04; user decision 17, D#440b kept): the side filters
 * the page has picked, sent with a search and applied to every candidate before the results are cut to 50. The
 * page's own side filter (over the 50 it has) stays as it was; this is one button more.
 *
 * Groups: provider (trust), category, install method (the page's three), and new ones: license, how it runs
 * (run), last update, owner, and "믿는 제작자" (trusted, F20: a filter only, never a ranking signal).
 * OR within a group, AND across groups, as the side panel; `run` is a list of conditions that must all hold.
 */

export const RUN_FEATURES = ['noHooksMcp', 'manualOnly', 'noBashPreapproved'] as const;
export type RunFeature = (typeof RUN_FEATURES)[number];
export const UPDATED_WITHIN = ['30d', '90d', '1y'] as const;
export type UpdatedWithin = (typeof UPDATED_WITHIN)[number];
const UPDATED_MS: Record<UpdatedWithin, number> = { '30d': 30 * 86_400_000, '90d': 90 * 86_400_000, '1y': 365 * 86_400_000 };

export type SearchFacets = {
  trust?: string[];
  category?: string[];
  method?: string[];
  /** SPDX ids as GitHub gives them ("MIT", "Apache-2.0"); "other" for NOASSERTION, "unknown" when not known. */
  license?: string[];
  run?: RunFeature[];
  updated?: UpdatedWithin;
  /** Lower-case GitHub owners. */
  owner?: string[];
  /** Only skills of trusted owners or repos (F20). */
  trusted?: boolean;
};

const LIST_GROUPS = ['trust', 'category', 'method', 'license', 'owner'] as const;
type ListGroup = (typeof LIST_GROUPS)[number];

/** Sorted, deduplicated, lower-cased where it should be; null when nothing is picked (the search is the plain one). */
export function normalizeFacets(f: SearchFacets | null | undefined): SearchFacets | null {
  if (!f) return null;
  const out: SearchFacets = {};
  for (const g of LIST_GROUPS) {
    const list = f[g];
    if (!list?.length) continue;
    const vals = [...new Set(list.map((v) => (g === 'owner' ? v.toLowerCase() : v)))].sort();
    out[g] = vals;
  }
  if (f.run?.length) out.run = [...new Set(f.run)].sort() as RunFeature[];
  if (f.updated) out.updated = f.updated;
  if (f.trusted) out.trusted = true;
  return Object.keys(out).length ? out : null;
}

/** What one skill is under each group. */
export type FacetValues = {
  trust: string;
  category: string[];
  method: string;
  license: string;
  run: RunFeature[];
  updatedAt: number | null;
  owner: string | null;
  trusted: boolean;
};

const HOOK_MCP_FLAGS = new Set(['skillHooks', 'pluginHooks', 'pluginMcp']);
const BASH_FLAGS = new Set(['preapprovedBash', 'unscopedBash']);

/** The skill's license as a facet value: the repo's SPDX id ("other" for GitHub's NOASSERTION, "unknown" without one). */
export function licenseValue(license: string | null | undefined): string {
  if (!license) return 'unknown';
  return license === 'NOASSERTION' ? 'other' : license;
}

/** `disable-model-invocation: true` in the frontmatter: Claude never picks it by itself, only `/name` runs it. */
export function manualOnly(s: Pick<SkillRow, 'frontmatter_json'>): boolean {
  if (!s.frontmatter_json) return false;
  try {
    const v = (JSON.parse(s.frontmatter_json) as Record<string, unknown>)['disable-model-invocation'];
    return v === true || v === 'true';
  } catch {
    return false;
  }
}

export function runFeatures(flags: readonly string[], manual: boolean): RunFeature[] {
  const out: RunFeature[] = [];
  if (!flags.some((f) => HOOK_MCP_FLAGS.has(f))) out.push('noHooksMcp');
  if (manual) out.push('manualOnly');
  if (!flags.some((f) => BASH_FLAGS.has(f))) out.push('noBashPreapproved');
  return out;
}

export function facetValuesOf(lookup: Lookup, skill: SkillRow, owners: OwnerFilter, licenseOf: (repo: string | null) => string | null): FacetValues {
  const plugin = lookup.plugin(skill.plugin_id);
  const flags: string[] = skill.risk_json ? (JSON.parse(skill.risk_json) as string[]) : [];
  const updated = skill.last_commit_at ? Date.parse(skill.last_commit_at) : NaN;
  return {
    trust: trustTier(skill, plugin),
    category: categorize({ name: skill.name, description: skill.description ?? '', whenToUse: skill.when_to_use, marketplaceCategory: plugin?.category }),
    method: planInstall(skill, plugin, lookup.marketplace(plugin?.marketplace)).method,
    license: licenseValue(licenseOf(skill.repo)),
    run: runFeatures(flags, manualOnly(skill)),
    updatedAt: Number.isNaN(updated) ? null : updated,
    owner: ownerOfRepo(skill.repo),
    trusted: owners.trusted(skill.repo),
  };
}

/** A license lookup that reads each repo row once. */
export function licenseLookup(store: Store): (repo: string | null) => string | null {
  const memo = new Map<string, string | null>();
  return (repo) => {
    if (!repo) return null;
    const k = repo.toLowerCase();
    if (!memo.has(k)) memo.set(k, store.getRepo(repo)?.license ?? null);
    return memo.get(k)!;
  };
}

export type FacetGroup = ListGroup | 'run' | 'updated' | 'trusted';

/** Whether `v` passes the picked facets; `skip` leaves one group out (for that group's own counts). */
export function matchFacetValues(v: FacetValues, f: SearchFacets, now = Date.now(), skip?: FacetGroup): boolean {
  const any = (g: ListGroup, vals: string[]) => g === skip || !f[g]?.length || vals.some((x) => f[g]!.includes(x));
  if (!any('trust', [v.trust])) return false;
  if (!any('category', v.category)) return false;
  if (!any('method', [v.method])) return false;
  if (!any('license', [v.license])) return false;
  if (!any('owner', v.owner ? [v.owner] : [])) return false;
  if (skip !== 'run' && f.run?.length && !f.run.every((r) => v.run.includes(r))) return false;
  if (skip !== 'updated' && f.updated && !(v.updatedAt != null && now - v.updatedAt <= UPDATED_MS[f.updated])) return false;
  if (skip !== 'trusted' && f.trusted && !v.trusted) return false;
  return true;
}

/**
 * The parts of a facet a candidate not read yet can be judged on (its repo and the trust tier its source gives):
 * true when it may still pass. The rest is checked once it is read.
 */
export function mayMatchPending(f: SearchFacets, repo: string | null, tier: string | null, owners: OwnerFilter): boolean {
  if (f.owner?.length && !(repo && f.owner.includes(ownerOfRepo(repo)!))) return false;
  if (f.trust?.length && tier && !f.trust.includes(tier)) return false;
  if (f.trusted && !owners.trusted(repo)) return false;
  return true;
}

/** Per group, how many candidates each value would leave (the other groups applied, as the side panel counts). */
export type FacetCounts = {
  trust: Record<string, number>;
  category: Record<string, number>;
  method: Record<string, number>;
  license: Record<string, number>;
  run: Record<RunFeature, number>;
  updated: Record<UpdatedWithin, number>;
  /** The most common owners only (OWNER_TOP), plus any picked. */
  owner: Record<string, number>;
  trusted: number;
  /** Candidates counted (after hidden repos, risk, stars, description and query-word rules, one per SKILL.md). */
  total: number;
};

const OWNER_TOP = 20;

export function countFacets(list: FacetValues[], f: SearchFacets, now = Date.now()): FacetCounts {
  const out: FacetCounts = {
    trust: {},
    category: {},
    method: {},
    license: {},
    run: { noHooksMcp: 0, manualOnly: 0, noBashPreapproved: 0 },
    updated: { '30d': 0, '90d': 0, '1y': 0 },
    owner: {},
    trusted: 0,
    total: 0,
  };
  const bump = (m: Record<string, number>, k: string) => (m[k] = (m[k] ?? 0) + 1);
  for (const v of list) {
    if (matchFacetValues(v, f, now)) out.total++;
    if (matchFacetValues(v, f, now, 'trust')) bump(out.trust, v.trust);
    if (matchFacetValues(v, f, now, 'category')) for (const c of new Set(v.category)) bump(out.category, c);
    if (matchFacetValues(v, f, now, 'method')) bump(out.method, v.method);
    if (matchFacetValues(v, f, now, 'license')) bump(out.license, v.license);
    if (v.owner && matchFacetValues(v, f, now, 'owner')) bump(out.owner, v.owner);
    // run conditions narrow together: each count is with the others picked
    for (const r of RUN_FEATURES) if (v.run.includes(r) && matchFacetValues(v, { ...f, run: [...new Set([...(f.run ?? []), r])] }, now)) out.run[r]++;
    if (matchFacetValues(v, f, now, 'updated') && v.updatedAt != null) for (const u of UPDATED_WITHIN) if (now - v.updatedAt <= UPDATED_MS[u]) out.updated[u]++;
    if (v.trusted && matchFacetValues(v, f, now, 'trusted')) out.trusted++;
  }
  const keep = new Set([...Object.entries(out.owner).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, OWNER_TOP).map(([k]) => k), ...(f.owner ?? [])]);
  out.owner = Object.fromEntries(Object.entries(out.owner).filter(([k]) => keep.has(k)));
  return out;
}
