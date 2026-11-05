import type { Store } from '../db/store.ts';
import { indexGeneration } from './indexGeneration.ts';
import { INSTALLS_MAX_AGE_MS } from './rank.ts';

/**
 * Download counts that look inflated (F18, user decision 7, "가벼움"): skills.sh counts installs, and copies of a
 * popular skill in repos nobody stars rank at the top by them (101-skills/superpowers 883K downloads with 18 stars,
 * magentosh/superpowers 775K with 4). A suspected count is treated as unknown when sorting (D#d7c3's order stays,
 * only this value is not trusted) and the card says "다운로드 수 의심". Computed when results are built; nothing
 * is stored.
 *
 * - ratio:    downloads ÷ max(stars, 1) > 1,000 and fewer than 100 stars
 * - copies:   the same name + description (name_desc_sha256) with big downloads in 3+ repos of fewer than 100 stars
 *             (several accounts publishing one skill)
 * - impostor: a repo named like a repo of 10,000+ stars (qu-skills/superpowers after obra/superpowers) by another
 *             owner, with big downloads and fewer stars. Only a name one famous repo has: "skills" belongs to ten
 *             (anthropics, openai, google, …), so cloudflare/skills or supabase/agent-skills are not impostors
 *             (measured on the index of 2026-11-04: by skill name the rule hit supabase, antfu, coderabbitai, …)
 *
 * GitHub sources only: well-known sites (open.feishu.cn's lark-*) have no star count to compare with. Official
 * and partner skills are left alone, as for the star minimum (U1): their plugin repos have few stars by nature.
 */
export const SUSPECT_RULES = { ratio: 1000, lowStars: 100, bigInstalls: 1000, minCopies: 3, famousStars: 10_000 } as const;

export type SuspectReason = 'ratio' | 'copies' | 'impostor';
/** `installs`: the count not trusted (shown with the badge; the result's own `installs` is left out). */
export type InstallsSuspect = { installs: number; reasons: SuspectReason[] };

export type SuspectInput = {
  repo: string | null;
  name: string;
  /** name_desc_sha256 of the skill row, when there is one. */
  nameDesc: string | null;
  origin?: string | null;
  installs: number | null;
  stars: number | null;
  /** Official or partner (not judged). */
  exempt?: boolean;
};

type Facts = {
  /** name_desc_sha256 → low-star repos (lowercase) where that skill has big downloads. */
  copies: Map<string, Set<string>>;
  /** Repo name (after the owner) → owners (lowercase) of 10,000+ star repos with that name. */
  famous: Map<string, Set<string>>;
};

const FACTS_MAX_AGE_MS = 60 * 60 * 1000;
const facts = new WeakMap<Store, { gen: number; at: number; facts: Facts }>();

/** Repo names any skill publisher picks ("skills", "claude-skills", "agent-toolkit"): never taken as imitation. */
const COMMON_REPO_NAME = /skill|agent|claude|plugin|prompt|awesome|tool|mcp|cookbook|template|starter|kit/;
const ownerOf = (repo: string) => repo.split('/')[0]?.toLowerCase() ?? '';
const repoName = (repo: string) => repo.split('/')[1]?.toLowerCase() ?? '';

/** What the copies and impostor rules compare with, read from the whole index (~0.1 s on 20K skills), kept per generation for an hour. */
function factsOf(store: Store, now = Date.now()): Facts {
  const gen = indexGeneration(store);
  const hit = facts.get(store);
  if (hit && hit.gen === gen && now - hit.at < FACTS_MAX_AGE_MS) return hit.facts;
  const since = new Date(now - INSTALLS_MAX_AGE_MS).toISOString();
  const copies = new Map<string, Set<string>>();
  const rows = store.db
    .prepare(
      `SELECT s.name_desc_sha256 AS h, s.repo AS repo FROM skills s LEFT JOIN repos r ON r.full_name = s.repo COLLATE NOCASE
       WHERE s.name_desc_sha256 IS NOT NULL AND s.repo IS NOT NULL AND s.origin != 'wellknown'
         AND s.installs >= ? AND s.installs_at >= ? AND r.stars IS NOT NULL AND r.stars < ?`,
    )
    .all(SUSPECT_RULES.bigInstalls, since, SUSPECT_RULES.lowStars) as Array<{ h: string; repo: string }>;
  for (const r of rows) {
    const set = copies.get(r.h) ?? new Set<string>();
    set.add(r.repo.toLowerCase());
    copies.set(r.h, set);
  }
  const famous = new Map<string, Set<string>>();
  const big = store.db.prepare('SELECT full_name FROM repos WHERE stars >= ?').all(SUSPECT_RULES.famousStars) as Array<{ full_name: string }>;
  for (const r of big) {
    const k = repoName(r.full_name);
    const set = famous.get(k) ?? new Set<string>();
    set.add(ownerOf(r.full_name));
    famous.set(k, set);
  }
  const f = { copies, famous };
  facts.set(store, { gen, at: now, facts: f });
  return f;
}

/** The ratio rule alone (no index needed). */
export function ratioSuspect(installs: number | null, stars: number | null): boolean {
  return installs != null && stars != null && stars < SUSPECT_RULES.lowStars && installs / Math.max(stars, 1) > SUSPECT_RULES.ratio;
}

/** Why this download count is not trusted, or null. */
export function installsSuspect(store: Store, s: SuspectInput): InstallsSuspect | null {
  if (s.exempt || !s.repo || s.origin === 'wellknown' || s.installs == null || s.installs < SUSPECT_RULES.bigInstalls) return null;
  const reasons: SuspectReason[] = [];
  if (ratioSuspect(s.installs, s.stars)) reasons.push('ratio');
  const f = factsOf(store);
  const repo = s.repo.toLowerCase();
  if (s.nameDesc && s.stars != null && s.stars < SUSPECT_RULES.lowStars) {
    const set = new Set(f.copies.get(s.nameDesc) ?? []);
    set.add(repo);
    if (set.size >= SUSPECT_RULES.minCopies) reasons.push('copies');
  }
  // a name only one famous repo has ("superpowers"); a name several have ("skills", "agent-skills"), or one made of
  // the words every skill repo uses, is a common one
  const name = repoName(s.repo);
  const owners = COMMON_REPO_NAME.test(name) ? undefined : f.famous.get(name);
  if (owners?.size === 1 && !owners.has(ownerOf(s.repo)) && s.stars != null && s.stars < SUSPECT_RULES.famousStars) reasons.push('impostor');
  return reasons.length ? { installs: s.installs, reasons } : null;
}
