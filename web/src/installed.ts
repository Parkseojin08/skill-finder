import { useEffect, useState } from 'react';
import { apiGet } from './api.ts';
import type { InstalledIds } from './types.ts';

const SCOPE_SHORT: Record<string, string> = { user: '개인', project: '프로젝트', local: '로컬', synced: '앱 동기화' };

/** One request shared by every screen, kept for a minute; an install or delete drops it (forgetInstalled). */
let cache: { at: number; value: Promise<InstalledIds | null> } | null = null;
const listeners = new Set<() => void>();

export function forgetInstalled(): void {
  cache = null;
  for (const l of listeners) l();
}

function load(): Promise<InstalledIds | null> {
  if (cache && Date.now() - cache.at < 60_000) return cache.value;
  const value = apiGet<InstalledIds>('/installed/ids').catch(() => {
    cache = null; // a failure (server just starting) is not kept: the next screen asks again
    return null;
  });
  cache = { at: Date.now(), value };
  return value;
}

/**
 * What is installed (UI debate 3-1), as a lookup from a result to "개인" / "프로젝트" / "플러그인·개인".
 * Unknown means no badge: the app never says "not installed", since a skill installed another way may not match.
 */
export function useInstalled(): (item: { id: string; plugin?: { id: string } | null }) => string | null {
  const [ids, setIds] = useState<InstalledIds | null>(null);
  useEffect(() => {
    let alive = true;
    const refresh = () => void load().then((v) => alive && setIds(v));
    refresh();
    listeners.add(refresh);
    return () => {
      alive = false;
      listeners.delete(refresh);
    };
  }, []);
  return (item) => {
    if (!ids) return null;
    const lower = item.id.toLowerCase();
    const skill = ids.skills.filter((s) => s.id.toLowerCase() === lower).map((s) => SCOPE_SHORT[s.scope] ?? s.scope);
    if (skill.length) return [...new Set(skill)].join('·');
    const plugin = item.plugin ? ids.plugins.filter((p) => p.id === item.plugin!.id).map((p) => SCOPE_SHORT[p.scope] ?? p.scope) : [];
    return plugin.length ? `플러그인 ${[...new Set(plugin)].join('·')}` : null;
  };
}
