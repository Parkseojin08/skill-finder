import { useEffect, useState } from 'react';
import { apiGet } from './api.ts';
import type { InstalledIds } from './types.ts';
import { t } from './i18n.ts';

const SCOPE_SHORT: Record<string, string> = { user: t('개인'), project: t('프로젝트'), local: t('로컬'), synced: t('앱 동기화') };

/**
 * One request per project folder ('' = the settings' default folder) shared by every screen, kept for a minute; an
 * install or delete drops them all (forgetInstalled).
 */
const cache = new Map<string, { at: number; value: Promise<InstalledIds | null> }>();
const listeners = new Set<() => void>();

export function forgetInstalled(): void {
  cache.clear();
  for (const l of listeners) l();
}

function load(projectPath: string): Promise<InstalledIds | null> {
  const hit = cache.get(projectPath);
  if (hit && Date.now() - hit.at < 60_000) return hit.value;
  const value = apiGet<InstalledIds>('/installed/ids', { projectPath: projectPath || undefined }).catch(() => {
    cache.delete(projectPath); // a failure (server just starting) is not kept: the next screen asks again
    return null;
  });
  cache.set(projectPath, { at: Date.now(), value });
  return value;
}

/**
 * What is installed (UI debate 3-1), as a lookup from a result to "개인" / "프로젝트" / "플러그인·개인".
 * `projectPath`: whose project skills count (README 추천's folder); without it, the settings' default folder.
 * Unknown means no badge: the app never says "not installed", since a skill installed another way may not match.
 */
export function useInstalled(projectPath = ''): (item: { id: string; plugin?: { id: string } | null }) => string | null {
  const [ids, setIds] = useState<InstalledIds | null>(null);
  useEffect(() => {
    let alive = true;
    const refresh = () => void load(projectPath).then((v) => alive && setIds(v));
    setIds(null); // another folder's badges are not shown while this one's load
    refresh();
    listeners.add(refresh);
    return () => {
      alive = false;
      listeners.delete(refresh);
    };
  }, [projectPath]);
  return (item) => {
    if (!ids) return null;
    const lower = item.id.toLowerCase();
    const skill = ids.skills.filter((s) => s.id.toLowerCase() === lower).map((s) => SCOPE_SHORT[s.scope] ?? s.scope);
    if (skill.length) return [...new Set(skill)].join('·');
    const plugin = item.plugin ? ids.plugins.filter((p) => p.id === item.plugin!.id).map((p) => SCOPE_SHORT[p.scope] ?? p.scope) : [];
    return plugin.length ? t('플러그인 {0}', [...new Set(plugin)].join('·')) : null;
  };
}
