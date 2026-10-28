import { z } from 'zod';
import type { Store } from '../db/store.ts';
import { USER_AGENT } from '../util/http.ts';
import { sanitizeLine } from '../util/sanitize.ts';

export type SkillsShHit = { id: string; source: string; skillId: string | null; name: string; installs: number };

const ResponseSchema = z.object({
  skills: z.array(
    z.looseObject({
      id: z.string(),
      name: z.string(),
      source: z.string().optional().default(''),
      skillId: z.string().optional(),
      installs: z.number().optional().default(0),
    }),
  ),
});

const DAY_MS = 24 * 60 * 60 * 1000;
export const SKILLS_SH_BASE = 'https://skills.sh';

/**
 * Undocumented endpoint used by the official skills CLI (`skills find`). Only called on a user search,
 * at most a few times per search, with results cached for 24h (robots.txt disallows crawling this path).
 */
export async function searchSkillsSh(store: Store, query: string, limit = 20): Promise<SkillsShHit[]> {
  const q = query.trim().replace(/\s+/g, ' ').slice(0, 200);
  if (!q) return [];
  const key = `skillssh:${limit}:${q.toLowerCase()}`;
  const cached = store.getCached(key, DAY_MS) as SkillsShHit[] | undefined;
  if (cached) return cached;
  // one request per query at a time (a re-search while the first is still out reuses it)
  let p = inFlight.get(key);
  if (!p) {
    p = fetchSkillsSh(store, key, q, limit)
      .catch((err) => {
        // down or slow: an answer from the last week beats none (installs are the first sort key)
        const stale = store.getCached(key, STALE_OK_MS) as SkillsShHit[] | undefined;
        if (stale) return stale;
        throw err;
      })
      .finally(() => inFlight.delete(key));
    inFlight.set(key, p);
  }
  return p;
}

const inFlight = new Map<string, Promise<SkillsShHit[]>>();
/** How old an earlier answer may be to stand in when skills.sh fails. */
const STALE_OK_MS = 7 * DAY_MS;

async function fetchSkillsSh(store: Store, key: string, q: string, limit: number): Promise<SkillsShHit[]> {
  const params = new URLSearchParams({ q, limit: String(limit) });
  const res = await fetch(`${SKILLS_SH_BASE}/api/search?${params}`, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`skills.sh 응답 ${res.status}`);
  const body = ResponseSchema.parse(await res.json());
  const hits = body.skills.map((s) => ({
    id: sanitizeLine(s.id),
    source: sanitizeLine(s.source),
    skillId: s.skillId ? sanitizeLine(s.skillId) : null,
    name: sanitizeLine(s.name),
    installs: Math.max(0, Math.floor(s.installs)),
  }));
  store.putCached(key, hits);
  return hits;
}

const OWNER_REPO_RE = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;
const DOMAIN_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

export function classifySkillsShSource(source: string): { kind: 'github'; repo: string } | { kind: 'domain'; domain: string } | null {
  if (OWNER_REPO_RE.test(source)) return { kind: 'github', repo: source };
  const host = source.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (DOMAIN_RE.test(host)) return { kind: 'domain', domain: host.toLowerCase() };
  return null;
}
