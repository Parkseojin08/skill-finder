// The skill page's "출처" card (feature review F5) and its "원본 후보·사본" part (B8): where the repo comes from (its age,
// a person or an organization, what it was forked from, moved, gone), when the app first saw the skill, and official
// or partner skills of the same name whose text differs. Read from the index only; nothing here asks GitHub.
import type { PluginRow, SkillRow, Store } from '../db/store.ts';
import { trustTier, type TrustTier } from '../search/rank.ts';
import { clusterInfo, type ClusterInfo } from './clusters.ts';
import { stmt } from './rows.ts';

export type SourceTwin = { id: string; name: string; repo: string | null; trust: TrustTier };

export type SourceCard = {
  repo: string | null;
  /** When the repo was created on GitHub (null: not known yet; the metadata refresh fills it). */
  createdAt: string | null;
  /** GitHub's owner kind: User, Organization (others as GitHub names them); null when not known. */
  ownerType: string | null;
  fork: boolean;
  /** The repo it was forked from, when it is a fork and GitHub said. */
  parent: string | null;
  /** The name GitHub now gives the repo (renamed or transferred, P9). */
  movedTo: string | null;
  /** Since when GitHub says the repo is not there (deleted or made private). */
  goneAt: string | null;
  archived: boolean;
  /** When this app first indexed the skill. */
  firstSeenAt: string | null;
  trust: TrustTier;
  /** Official or partner skills with the same name and other text (only for a skill that is neither). */
  officialTwins: SourceTwin[];
  /** Its near-copy group (B8), or null. */
  cluster: ClusterInfo | null;
};

const TWINS_MAX = 5;
/** Name key as search folds same-name results ("PDF_Tools" = "pdf-tools"). */
export const nameKey = (name: string) => name.normalize('NFC').toLowerCase().replace(/[\s_]+/g, '-');

/** Official and partner skills named like this one whose SKILL.md differs. */
export function officialTwins(store: Store, skill: SkillRow): SourceTwin[] {
  const key = nameKey(skill.name);
  // one pass over the names (no index on name alone: ~20 ms for 20,000 rows); the exact rule is applied below
  const rows = stmt(
    store,
    `SELECT s.id, s.name, s.repo, s.dir_path, s.skill_md_sha256, p.marketplace AS marketplace FROM skills s
       LEFT JOIN plugins p ON p.id = s.plugin_id
      WHERE lower(replace(replace(s.name, '_', '-'), ' ', '-')) = ? AND s.id != ? AND s.origin != 'wellknown' LIMIT 200`,
  ).all(key, skill.id) as Array<Pick<SkillRow, 'id' | 'name' | 'repo' | 'dir_path' | 'skill_md_sha256'> & { marketplace: string | null }>;
  return rows
    .map((r) => ({ r, trust: trustTier(r, r.marketplace ? ({ marketplace: r.marketplace } as Pick<PluginRow, 'marketplace'>) : null) }))
    .filter(({ r, trust }) => (trust === 'official' || trust === 'partner') && nameKey(r.name) === key && !!r.skill_md_sha256 && r.skill_md_sha256 !== skill.skill_md_sha256)
    .sort((a, b) => (a.trust === b.trust ? (a.r.id < b.r.id ? -1 : 1) : a.trust === 'official' ? -1 : 1))
    .slice(0, TWINS_MAX)
    .map(({ r, trust }) => ({ id: r.id, name: r.name, repo: r.repo, trust }));
}

export function sourceCard(store: Store, skill: SkillRow): SourceCard {
  const plugin = skill.plugin_id ? (store.getPlugin(skill.plugin_id) ?? null) : null;
  const repo = skill.repo ? (store.getRepo(skill.repo) ?? null) : null;
  const trust = trustTier(skill, plugin);
  const firstSeen = (skill as SkillRow & { first_seen_at?: string | null }).first_seen_at ?? null;
  return {
    repo: skill.repo,
    createdAt: repo?.created_at ?? null,
    ownerType: repo?.owner_type ?? null,
    fork: repo?.fork === 1,
    parent: repo?.parent ?? null,
    movedTo: repo?.moved_to ?? null,
    goneAt: repo?.gone_at ?? null,
    archived: repo?.archived === 1,
    firstSeenAt: firstSeen,
    trust,
    officialTwins: trust === 'official' || trust === 'partner' ? [] : officialTwins(store, skill),
    cluster: clusterInfo(store, skill),
  };
}
