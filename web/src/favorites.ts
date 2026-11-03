import { useEffect, useState } from 'react';
import { apiGet, apiSend } from './api.ts';

// This PC's favorite skills, shared by every screen (user decision 2026-11-02: no accounts, a star is enough).

let favorites = new Set<string>();
let loaded = false;
const listeners = new Set<(ids: Set<string>) => void>();
const set = (next: Set<string>) => {
  favorites = next;
  for (const l of listeners) l(favorites);
};

export async function refreshFavorites(): Promise<void> {
  try {
    set(new Set((await apiGet<{ ids: string[] }>('/favorites/ids')).ids));
  } catch {
    // the server is starting: asked again by the next screen
  }
}

/**
 * Adds or removes a favorite; the star changes at once and goes back if the server refuses. `name` keeps a result
 * the index does not have yet (still being checked) until it does.
 */
export async function toggleFavorite(id: string, name?: string): Promise<void> {
  const on = !favorites.has(id);
  const next = new Set(favorites);
  if (on) next.add(id);
  else next.delete(id);
  set(next);
  try {
    if (on) await apiSend('POST', '/favorites', { id, name });
    else await apiSend('DELETE', `/favorites?id=${encodeURIComponent(id)}`);
  } catch (e) {
    // back as it was, also when the server cannot be reached to ask (review 2026-11-03: the star stayed changed)
    const back = new Set(favorites);
    if (on) back.delete(id);
    else back.add(id);
    set(back);
    await refreshFavorites();
    throw e;
  }
}

export function useFavorites(): Set<string> {
  const [ids, setIds] = useState(favorites);
  useEffect(() => {
    listeners.add(setIds);
    setIds(favorites);
    if (!loaded) {
      loaded = true;
      void refreshFavorites();
    }
    return () => {
      listeners.delete(setIds);
    };
  }, []);
  return ids;
}
