import { useEffect, useState } from 'react';
import { apiGet, apiSend } from './api.ts';

// The signed-in account and its favorite skill ids, shared by every screen (user decision 2026-11-02: favorites
// need a sign-up and a login). The server keeps the login in an HttpOnly cookie; this only mirrors who it is.

export type User = { id: number; username: string };
type State = { user: User | null; favorites: Set<string>; loaded: boolean };

let state: State = { user: null, favorites: new Set(), loaded: false };
const listeners = new Set<(s: State) => void>();
const set = (next: Partial<State>) => {
  state = { ...state, ...next };
  for (const l of listeners) l(state);
};

/** Asks the server who is signed in (at start, and after a login or logout elsewhere in the app). */
export async function refreshAccount(): Promise<void> {
  try {
    const { user } = await apiGet<{ user: User | null }>('/auth/me');
    const ids = user ? (await apiGet<{ ids: string[] }>('/favorites/ids')).ids : [];
    set({ user, favorites: new Set(ids), loaded: true });
  } catch {
    set({ loaded: true }); // the server is starting: stays signed out until the next ask
  }
}

export async function signIn(mode: 'login' | 'signup', username: string, password: string): Promise<void> {
  const { user } = await apiSend<{ user: User }>('POST', mode === 'login' ? '/auth/login' : '/auth/signup', { username, password });
  set({ user });
  await refreshAccount();
}

export async function signOut(): Promise<void> {
  await apiSend('POST', '/auth/logout', {});
  set({ user: null, favorites: new Set() });
}

/** Adds or removes a favorite; the star changes at once and goes back if the server refuses. */
export async function toggleFavorite(id: string): Promise<void> {
  const on = !state.favorites.has(id);
  const next = new Set(state.favorites);
  if (on) next.add(id);
  else next.delete(id);
  set({ favorites: next });
  try {
    if (on) await apiSend('POST', '/favorites', { id });
    else await apiSend('DELETE', `/favorites?id=${encodeURIComponent(id)}`);
  } catch (e) {
    await refreshAccount();
    throw e;
  }
}

/** Opens the login dialog from anywhere (the star on a card when signed out). */
const LOGIN_EVENT = 'skill-finder-login';
export const askLogin = (why?: string) => window.dispatchEvent(new CustomEvent(LOGIN_EVENT, { detail: why ?? null }));
export function onAskLogin(fn: (why: string | null) => void): () => void {
  const h = (e: Event) => fn((e as CustomEvent<string | null>).detail);
  window.addEventListener(LOGIN_EVENT, h);
  return () => window.removeEventListener(LOGIN_EVENT, h);
}

let started = false;
export function useAccount(): State {
  const [s, setS] = useState(state);
  useEffect(() => {
    listeners.add(setS);
    setS(state);
    if (!started) {
      started = true;
      void refreshAccount();
    }
    return () => {
      listeners.delete(setS);
    };
  }, []);
  return s;
}
