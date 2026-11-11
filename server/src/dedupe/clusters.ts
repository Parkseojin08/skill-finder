// Near-copy groups (feature review B8). Skills whose signatures (minhash.ts) share an LSH band and agree on at least
// COPY_SIMILARITY of their values are one group; skills.cluster_id holds the group's smallest skill id (null alone).
// The group's representative ("원본 후보") is worked out when shown, since downloads and stars change: official >
// partner > downloads > stars > the oldest repository. Downloads are never added up (U4: copies are other copies).
import type { AppContext } from '../context.ts';
import type { PluginRow, SkillRow, Store } from '../db/store.ts';
import { searchActivity } from '../search/activity.ts';
import { bumpIndexGeneration, indexGeneration } from '../search/indexGeneration.ts';
import { freshInstalls, trustTier, type TrustTier } from '../search/rank.ts';
import { bandKeys, COPY_SIMILARITY, decodeMinhash, similarity } from './minhash.ts';
import { markGroupsCurrent, signaturesChanged } from './rows.ts';

/** Signatures a bucket keeps to compare newcomers with: a bucket of thousands is not compared pair by pair. */
const BUCKET_REPS = 40;

/**
 * Groups of near-copies: skill id → group id (the smallest id in it) for groups of two or more. Union-find over the
 * pairs that share an LSH bucket and are similar enough; within a bucket each signature is compared with at most
 * BUCKET_REPS earlier ones, so the work stays linear in the number of signatures.
 */
export function clusterSignatures(rows: Array<{ id: string; sig: Uint32Array }>, threshold = COPY_SIMILARITY): Map<string, string> {
  const parent = new Int32Array(rows.length).map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
  };
  const buckets = new Map<string, number[]>();
  rows.forEach((r, i) => {
    for (const key of bandKeys(r.sig)) {
      const reps = buckets.get(key);
      if (!reps) {
        buckets.set(key, [i]);
        continue;
      }
      let joined = false;
      for (const j of reps) {
        if (find(j) === find(i)) {
          joined = true;
          break;
        }
        if (similarity(rows[j].sig, r.sig) >= threshold) {
          union(i, j);
          joined = true;
          break;
        }
      }
      if (!joined && reps.length < BUCKET_REPS) reps.push(i);
    }
  });
  const groups = new Map<number, string[]>();
  rows.forEach((r, i) => {
    const root = find(i);
    const g = groups.get(root);
    if (g) g.push(r.id);
    else groups.set(root, [r.id]);
  });
  const out = new Map<string, string>();
  for (const ids of groups.values()) {
    if (ids.length < 2) continue;
    const key = ids.reduce((a, b) => (b < a ? b : a));
    for (const id of ids) out.set(id, key);
  }
  return out;
}

const WRITE_BATCH = 500;
/** The index generation each database's groups were last worked out at (a deleted or re-indexed row moves it on). */
const groupedAt = new WeakMap<Store, number>();

/**
 * Background task "비슷한 사본 묶기": groups every signed skill again and writes the cluster ids that changed (local
 * only, no network). Rows without a signature lose a stale group. The index generation goes up when a group changed,
 * since search folds results by it.
 */
export async function runClusterRefresh(ctx: AppContext): Promise<{ counts?: Record<string, number>; skipped?: boolean; note?: string }> {
  const { db } = ctx.store;
  // nothing to redo: no signature was written and no skill row changed since the last pass (review 2026-11-10: the
  // pass reads and groups every signed row in one go, about a second for 20,000, on the thread searches run on)
  if (!signaturesChanged(ctx.store) && groupedAt.get(ctx.store) === indexGeneration(ctx.store)) return { skipped: true, note: '바뀐 것이 없어 건너뜀' };
  // a search is running: wait for it, a minute at most
  for (let waited = 0; searchActivity.busy() && waited < 60_000; waited += 500) await new Promise((resolve) => setTimeout(resolve, 500));
  markGroupsCurrent(ctx.store);
  const rows: Array<{ id: string; sig: Uint32Array; was: string | null }> = [];
  // by id: the grouping compares a row with the first similar ones of its bucket, so the order rows arrive in must
  // not depend on where SQLite happens to keep them (a rewritten row would regroup its neighbours)
  for (const r of db.prepare('SELECT id, minhash, cluster_id FROM skills WHERE minhash IS NOT NULL ORDER BY id').iterate() as Iterable<{ id: string; minhash: Uint8Array; cluster_id: string | null }>) {
    const sig = decodeMinhash(r.minhash);
    if (sig) rows.push({ id: r.id, sig, was: r.cluster_id });
    else if (r.cluster_id != null) rows.push({ id: r.id, sig: new Uint32Array(0), was: r.cluster_id });
  }
  const signed = rows.filter((r) => r.sig.length > 0);
  const groups = clusterSignatures(signed);
  const changes = rows.flatMap((r) => {
    const next = groups.get(r.id) ?? null;
    return next === r.was ? [] : [{ id: r.id, next }];
  });
  const set = db.prepare('UPDATE skills SET cluster_id = ? WHERE id = ?');
  for (let i = 0; i < changes.length; i += WRITE_BATCH) {
    ctx.store.transaction(() => {
      for (const c of changes.slice(i, i + WRITE_BATCH)) set.run(c.next, c.id);
    });
    await new Promise((resolve) => setImmediate(resolve));
  }
  const cleared = Number(db.prepare('UPDATE skills SET cluster_id = NULL WHERE minhash IS NULL AND cluster_id IS NOT NULL').run().changes);
  if (changes.length + cleared > 0) bumpIndexGeneration(ctx.store);
  groupedAt.set(ctx.store, indexGeneration(ctx.store));
  return { counts: { signed: signed.length, clusters: new Set(groups.values()).size, clustered: groups.size, changed: changes.length + cleared } };
}

export type ClusterMember = {
  id: string;
  name: string;
  repo: string | null;
  trust: TrustTier;
  installs: number | null;
  stars: number | null;
  riskLevel: string;
  /** The same SKILL.md text as the skill asked about (an exact copy). */
  sameText: boolean;
  /** When the repository was created, or when the app first saw the skill. */
  since: string | null;
};

const TRUST_RANK: Record<TrustTier, number> = { official: 3, partner: 2, community: 1, other: 0 };

/** Representative order: official > partner > downloads > stars > oldest (repo creation, else first seen) > id. */
export function compareRepresentative(a: ClusterMember, b: ClusterMember): number {
  return (
    TRUST_RANK[b.trust] - TRUST_RANK[a.trust] ||
    (b.installs ?? -1) - (a.installs ?? -1) ||
    (b.stars ?? -1) - (a.stars ?? -1) ||
    (a.since ? Date.parse(a.since) : Infinity) - (b.since ? Date.parse(b.since) : Infinity) ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

/** Members read per group (a group of thousands of copies is listed by its best few). */
const CLUSTER_READ_MAX = 300;
export const CLUSTER_SHOWN = 12;

export type ClusterInfo = {
  /** Skills in the group, this one included (at most CLUSTER_READ_MAX counted). */
  size: number;
  /** The group's first by the representative order ("원본 후보"); may be this skill. */
  representative: ClusterMember;
  /** The others, best first, at most CLUSTER_SHOWN. */
  members: ClusterMember[];
  /** Copies whose name differs from this skill's (renamed copies). */
  renamed: number;
};

const nameKey = (name: string) => name.normalize('NFC').toLowerCase().replace(/[\s_]+/g, '-');

/** The near-copy group of a skill for its page ("원본 후보·사본"); null when it has none. */
export function clusterInfo(store: Store, skill: SkillRow): ClusterInfo | null {
  if (!skill.cluster_id) return null;
  const rows = store.db
    .prepare(
      `SELECT s.id, s.name, s.repo, s.dir_path, s.plugin_id, s.installs, s.installs_at, s.risk_level, s.skill_md_sha256, s.first_seen_at,
         p.marketplace AS marketplace, r.stars AS stars, r.created_at AS repo_created
       FROM skills s LEFT JOIN plugins p ON p.id = s.plugin_id LEFT JOIN repos r ON r.full_name = s.repo COLLATE NOCASE
       WHERE s.cluster_id = ? LIMIT ?`,
    )
    .all(skill.cluster_id, CLUSTER_READ_MAX) as Array<
    Pick<SkillRow, 'id' | 'name' | 'repo' | 'dir_path' | 'plugin_id' | 'installs' | 'installs_at' | 'risk_level' | 'skill_md_sha256'> & {
      first_seen_at: string | null;
      marketplace: string | null;
      stars: number | null;
      repo_created: string | null;
    }
  >;
  if (rows.length < 2 || !rows.some((r) => r.id === skill.id)) return null;
  const members: ClusterMember[] = rows
    .map((r) => ({
      id: r.id,
      name: r.name,
      repo: r.repo,
      trust: trustTier(r, r.marketplace ? ({ marketplace: r.marketplace } as Pick<PluginRow, 'marketplace'>) : null),
      installs: freshInstalls(r),
      stars: r.stars,
      riskLevel: r.risk_level ?? 'low',
      sameText: !!skill.skill_md_sha256 && r.skill_md_sha256 === skill.skill_md_sha256,
      since: r.repo_created ?? r.first_seen_at,
    }))
    .sort(compareRepresentative);
  const own = nameKey(skill.name);
  return {
    size: rows.length,
    representative: members[0],
    members: members.filter((m) => m.id !== skill.id).slice(0, CLUSTER_SHOWN),
    renamed: members.filter((m) => m.id !== skill.id && nameKey(m.name) !== own).length,
  };
}
