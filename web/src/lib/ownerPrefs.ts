import { useEffect, useState } from 'react';
import { apiGet, apiSend } from '../api.ts';
import type { ResultItem } from '../types.ts';

// Hidden repositories and trusted owners (F20, feature review 2026-11-04; user decision 18), kept on the server
// (GET/POST/DELETE /api/prefs/owners) and shared by every screen like the favorites. Hiding takes a repo's skills
// out of searches, README recommendations and browsing on the server; trusting only feeds the side filter
// "믿는 제작자" (never the order or the risk).

export type OwnerPrefKind = 'repo' | 'owner';
export type OwnerPrefValue = 'hide' | 'trust';
export type OwnerPref = { key: string; kind: OwnerPrefKind; pref: OwnerPrefValue; createdAt: string };

export type OwnerPrefs = {
  list: OwnerPref[];
  /** Whether this `owner/repo` is hidden (itself or its owner). */
  hidden(repo: string | null | undefined): boolean;
  /** Whether this `owner/repo`'s owner (or the repo itself) is trusted. */
  trusted(repo: string | null | undefined): boolean;
  /** The preference stored for exactly this key, if any. */
  of(key: string): OwnerPrefValue | null;
};

function build(list: OwnerPref[]): OwnerPrefs {
  const by = new Map(list.map((p) => [p.key, p.pref]));
  const check = (want: OwnerPrefValue) => (repo: string | null | undefined) => {
    if (!repo) return false;
    const r = repo.toLowerCase();
    return by.get(r) === want || by.get(r.split('/')[0]) === want;
  };
  return { list, hidden: check('hide'), trusted: check('trust'), of: (k) => by.get(k.toLowerCase()) ?? null };
}

let current = build([]);
let loaded = false;
const listeners = new Set<(p: OwnerPrefs) => void>();
const publish = (list: OwnerPref[]) => {
  current = build(list);
  for (const l of listeners) l(current);
};

export async function refreshOwnerPrefs(): Promise<void> {
  try {
    publish((await apiGet<{ items: OwnerPref[] }>('/prefs/owners')).items);
  } catch {
    // the server is starting: asked again by the next screen (`loaded` was set before the answer and stayed set
    // when it failed, so nothing asked again and hidden repositories showed until a reload; review 2026-11-10)
    loaded = false;
  }
}

/** Saves a preference (a key is either hidden or trusted); the list on every screen follows the server's answer. */
export async function saveOwnerPref(key: string, kind: OwnerPrefKind, pref: OwnerPrefValue): Promise<void> {
  publish((await apiSend<{ items: OwnerPref[] }>('POST', '/prefs/owners', { key, kind, pref })).items);
}

export async function removeOwnerPref(key: string): Promise<void> {
  publish((await apiSend<{ items: OwnerPref[] }>('DELETE', `/prefs/owners/${encodeURIComponent(key.toLowerCase())}`)).items);
}

export function ownerPrefsNow(): OwnerPrefs {
  return current;
}

export function useOwnerPrefs(): OwnerPrefs {
  const [p, setP] = useState(current);
  useEffect(() => {
    listeners.add(setP);
    setP(current);
    if (!loaded) {
      loaded = true;
      void refreshOwnerPrefs();
    }
    return () => {
      listeners.delete(setP);
    };
  }, []);
  return p;
}

/**
 * `owner/repo` a result comes from: from a GitHub-indexed id (`gh:owner/repo:dir`), else from its own source link
 * (a marketplace skill's link is its repo's tree). Lower case; null for well-known sites.
 */
export function itemRepo(item: Pick<ResultItem, 'id' | 'sources'>): string | null {
  const gh = item.id.match(/^gh:([^/]+\/[^:]+):/)?.[1];
  if (gh) return gh.toLowerCase();
  for (const s of item.sources ?? []) {
    const m = s.url.match(/^https:\/\/github\.com\/([A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100})(?:[/?#]|$)/);
    if (m) return m[1].toLowerCase();
  }
  return null;
}

export const ownerOf = (repo: string | null | undefined): string | null => (repo ? (repo.split('/')[0]?.toLowerCase() ?? null) : null);
