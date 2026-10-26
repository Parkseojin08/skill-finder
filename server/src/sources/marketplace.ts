import { parseMarketplace, MARKETPLACE_JSON } from '../discovery/classifyRepo.ts';
import type { Store } from '../db/store.ts';
import type { StoredPluginEntry } from '../indexer.ts';
import { sanitizeLine } from '../util/sanitize.ts';
import type { GitHub } from './github.ts';
import { normalizeSource, sourceColumns } from './pluginSource.ts';

export type SyncResult = { name: string; changed: boolean; pluginCount: number };

const textOrNull = (v: unknown) => (typeof v === 'string' && v.trim() ? sanitizeLine(v) : null);

/** Reads a marketplace.json at the repo's current head. Used both for sync and for "add marketplace". */
export async function fetchMarketplaceManifest(github: GitHub, repo: string) {
  const ref = await github.resolveRef(repo, null);
  if (!ref) throw new Error(`저장소를 찾을 수 없습니다: ${repo}`);
  const res = await github.getRawText(repo, ref.sha, MARKETPLACE_JSON, 32 * 1024 * 1024);
  if (res.text == null) throw new Error(`marketplace.json을 가져오지 못했습니다 (${res.status})`);
  if (res.truncated) throw new Error('marketplace.json이 너무 큽니다');
  return { sha: ref.sha, etag: res.etag, manifest: parseMarketplace(res.text) };
}

/**
 * Upserts plugins from marketplace.json. Skips the download when the repo head commit is unchanged.
 * Relative-path plugins get the marketplace commit as their `sha`, so a new commit re-queues them for indexing.
 */
export async function syncMarketplace(store: Store, github: GitHub, name: string, force = false): Promise<SyncResult> {
  const mp = store.getMarketplace(name);
  if (!mp) throw new Error(`unknown marketplace ${name}`);
  try {
    const head = await github.resolveRef(mp.repo, null);
    if (!head) throw new Error(`저장소를 찾을 수 없습니다: ${mp.repo}`);
    if (!force && head.sha === mp.commit_sha && mp.synced_at && store.listPlugins(name).length > 0) {
      store.updateMarketplaceSync(name, {});
      return { name, changed: false, pluginCount: mp.plugin_count ?? 0 };
    }
    const { sha, etag, manifest } = await fetchMarketplaceManifest(github, mp.repo);
    const pluginRoot = manifest.metadata?.pluginRoot ?? null;
    store.transaction(() => {
      const keep = new Set<string>();
      for (const entry of manifest.plugins) {
        const id = `${entry.name}@${name}`;
        keep.add(id);
        const src = normalizeSource(entry.source, pluginRoot);
        const cols = sourceColumns(src, mp.repo);
        if (src.kind === 'relative') cols.sha = sha;
        const keywords = [
          ...(Array.isArray(entry.keywords) ? entry.keywords : []),
          ...(Array.isArray(entry.tags) ? entry.tags : []),
        ].filter((k): k is string => typeof k === 'string');
        const stored: StoredPluginEntry = { entry, pluginRoot };
        store.upsertPlugin({
          id,
          marketplace: name,
          name: entry.name,
          display_name: textOrNull(entry.displayName),
          description: textOrNull(entry.description),
          category: textOrNull(entry.category),
          keywords: keywords.length ? sanitizeLine(keywords.join(' ')) : null,
          source_json: JSON.stringify(entry.source ?? null),
          source_kind: src.kind,
          repo: cols.repo,
          path: cols.path,
          ref: cols.ref,
          sha: cols.sha,
          strict: typeof entry.strict === 'boolean' ? (entry.strict ? 1 : 0) : null,
          entry_json: JSON.stringify(stored),
        });
      }
      for (const p of store.listPlugins(name)) if (!keep.has(p.id)) store.deletePlugin(p.id);
    });
    store.updateMarketplaceSync(name, { etag, plugin_count: manifest.plugins.length, commit_sha: sha, error: null });
    return { name, changed: true, pluginCount: manifest.plugins.length };
  } catch (err) {
    store.updateMarketplaceSync(name, { error: String((err as Error).message ?? err).slice(0, 300) });
    throw err;
  }
}
