// The 설치됨 screen's check chips (feature review F8): what stands out among the installed skills, each a filter.
// Computed from the /installed rows, plus /installed/check for what they lack (same SKILL.md hash, overlapping
// descriptions). Pure, so the web tests run it.
import type { RiskLevel } from '../types.ts';

export type CheckKey = 'riskUp' | 'originChanged' | 'twoScopes' | 'sameContent' | 'pluginOff' | 'unindexed' | 'topContext' | 'overlap';

/** What the chips read of a skills-table row (installed directly, or a plugin's). */
export type CheckRow = {
  path: string;
  name: string;
  scope: string;
  risk: { level: RiskLevel };
  installedRisk: RiskLevel | null;
  skillId: string | null;
  tokens: { perTurn: number };
  plugin?: { enabled: boolean | null };
  agents?: Array<{ id: string }>;
  /** The change-tracking work's field (feature review F6, components/InstalledChange.tsx Drift), when /installed has it. */
  drift?: unknown;
};

/** One side of an overlapping pair, as /installed/check sends it. */
export type CheckSide = { path: string; name: string; description: string; tokens: string[] };
export type CheckPair = { a: CheckSide; b: CheckSide; score: number; shared: string[] };
/** GET /api/installed/check (server/src/routes/installedCheck.ts). */
export type InstalledCheckResponse = {
  duplicates: Array<{ hash: string; paths: string[] }>;
  pairs: CheckPair[];
  compared: number;
  skipped: number;
};

export type CheckChip = { key: CheckKey; count: number; paths: ReadonlySet<string> };

const RANK: Record<RiskLevel, number> = { low: 0, medium: 1, high: 2 };
export const TOP_CONTEXT = 5;

/**
 * Whether the source has a newer version than the install, from a row's `drift` (feature review F6:
 * `{ change: 'latest' | 'upstream' | 'local' | 'unknown', upstreamToo }`; a local edit can have a newer source too).
 * Null without the field (an older server: the row's `change` cannot tell a newer source from an edit), and then the
 * chip stays hidden.
 */
export function originChanged(drift: unknown): boolean | null {
  if (!drift || typeof drift !== 'object') return null;
  const d = drift as { change?: unknown; upstreamToo?: unknown };
  if (typeof d.change !== 'string') return null;
  return d.change === 'upstream' || d.upstreamToo === true;
}

/** Claude Code loads it with every request: its own folder, and not inside a plugin that is off. */
const loaded = (r: CheckRow) => (r.agents ?? [{ id: 'claude-code' }]).some((a) => a.id === 'claude-code') && r.plugin?.enabled !== false;

/**
 * The chips in the order shown, those with nothing to show left out. Counts are rows (skills), except the overlap
 * chip, which counts pairs. "원본 바뀜" is there only when the rows carry the change-tracking field.
 */
export function installedChecks(rows: readonly CheckRow[], check: InstalledCheckResponse | null): CheckChip[] {
  const paths = (list: readonly CheckRow[]) => new Set(list.map((r) => r.path));
  const out: CheckChip[] = [];
  const add = (key: CheckKey, set: Set<string>, count = set.size) => {
    if (count > 0) out.push({ key, count, paths: set });
  };
  add('riskUp', paths(rows.filter((r) => r.installedRisk && RANK[r.risk.level] > RANK[r.installedRisk])));
  if (rows.some((r) => originChanged(r.drift) !== null)) add('originChanged', paths(rows.filter((r) => originChanged(r.drift) === true)));
  const scopes = new Map<string, Set<string>>();
  for (const r of rows) {
    const k = r.name.toLowerCase();
    const s = scopes.get(k) ?? new Set<string>();
    s.add(r.scope);
    scopes.set(k, s);
  }
  add('twoScopes', paths(rows.filter((r) => (scopes.get(r.name.toLowerCase())?.size ?? 0) > 1)));
  if (check) {
    const known = new Set(rows.map((r) => r.path));
    const dup = new Set(check.duplicates.flatMap((d) => d.paths.filter((p) => known.has(p))));
    // a group of which only one row is listed here is no duplicate on this screen
    for (const d of check.duplicates) if (d.paths.filter((p) => known.has(p)).length < 2) for (const p of d.paths) dup.delete(p);
    add('sameContent', dup);
  }
  add('pluginOff', paths(rows.filter((r) => r.plugin?.enabled === false)));
  add('unindexed', paths(rows.filter((r) => !r.skillId)));
  const top = rows
    .filter((r) => loaded(r) && r.tokens.perTurn > 0)
    .sort((a, b) => b.tokens.perTurn - a.tokens.perTurn || a.name.localeCompare(b.name))
    .slice(0, TOP_CONTEXT);
  add('topContext', paths(top));
  if (check) {
    const pairs = shownPairs(rows, check);
    add('overlap', new Set(pairs.flatMap((p) => [p.a.path, p.b.path])), pairs.length);
  }
  return out;
}

/** The overlapping pairs whose two skills are both rows here. */
export function shownPairs(rows: readonly CheckRow[], check: InstalledCheckResponse): CheckPair[] {
  const known = new Set(rows.map((r) => r.path));
  return check.pairs.filter((p) => known.has(p.a.path) && known.has(p.b.path));
}
