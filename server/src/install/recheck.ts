// The commit an install fetches, checked right before it runs (feature review B6, user decision 11). A plugin cannot
// be pinned: Claude Code fetches the marketplace's and the plugin's current commit, which may be newer than the one
// the risk check read (a time-of-check/time-of-use gap). So just before `claude plugin install` the app asks git for
// those heads; when one moved, nothing is installed, that plugin alone is read again and checked, and the page shows
// what changed with a new confirm dialog. A skill the skills CLI cannot pin (plan.ts skillsSource) is checked the
// same way. Only `git ls-remote` (shell: false, validated repo and ref) is run; nothing from the repo is run.
import { MARKETPLACE_JSON, parseMarketplace } from '../discovery/classifyRepo.ts';
import type { MarketplaceRow, PluginRow, SkillRow, Store } from '../db/store.ts';
import type { Indexer, StoredPluginEntry } from '../indexer.ts';
import { trackIndexChanges } from '../search/indexGeneration.ts';
import { lsRemote } from '../sources/gitTree.ts';
import type { GitHub } from '../sources/github.ts';
import { normalizeSource, resolveRelativeRoot, sourceColumns } from '../sources/pluginSource.ts';
import { TreeIndex } from '../discovery/tree.ts';
import { sanitizeLine } from '../util/sanitize.ts';
import type { InstallPlan } from './plan.ts';
import { isCommitSha, isRepo } from './validate.ts';

/** A repo's current commit for a ref (null: its default branch), or null when it could not be asked. */
export type HeadLookup = (repo: string, ref: string | null) => Promise<string | null>;

const REF_RE = /^[A-Za-z0-9._/-]{1,200}$/;

/** `git ls-remote`, past the ref cache: the cached answer may be ten minutes old, which is the gap this closes. */
export const gitHead: HeadLookup = async (repo, ref) => {
  if (!isRepo(repo) || (ref != null && (!REF_RE.test(ref) || ref.includes('..')))) return null;
  const r = await lsRemote(repo, ref).catch(() => null);
  return r && isCommitSha(r.sha) ? r.sha : null;
};

/** What moved: the marketplace (its plugin entry or, for a plugin inside it, its folder), the plugin's repo, a skill's repo. */
export type CommitChange = { what: 'marketplace' | 'plugin' | 'skill'; repo: string; checked: string | null; now: string };
export type SkillRisk = { id: string; name: string; riskLevel: string; riskFlags: string[] };

export type Recheck =
  | { ok: true }
  /** git could not be asked: nothing is installed unchecked. */
  | { ok: false; code: 'unverified'; message: string }
  | {
      ok: false;
      code: 'changedSinceScan';
      message: string;
      changes: CommitChange[];
      /** The skills (all of a plugin's) as checked before, and as checked now at the new commit. */
      before: SkillRisk[];
      after: SkillRisk[];
      /** Signals now present that no skill had before; skills whose level went up; skills added or gone. */
      newFlags: string[];
      raised: string[];
      added: string[];
      removed: string[];
      /** The plugin is no longer in the marketplace, or the new commit could not be read. */
      gone?: boolean;
      error?: string;
    };

const risk = (s: SkillRow): SkillRisk => ({ id: s.id, name: s.name, riskLevel: s.risk_level ?? 'low', riskFlags: s.risk_json ? (JSON.parse(s.risk_json) as string[]) : [] });
const RANK: Record<string, number> = { low: 0, medium: 1, high: 2 };

function changed(changes: CommitChange[], before: SkillRisk[], after: SkillRisk[], extra: { gone?: boolean; error?: string } = {}): Recheck {
  const had = new Set(before.flatMap((s) => s.riskFlags));
  const old = new Map(before.map((s) => [s.id, s]));
  const now = new Map(after.map((s) => [s.id, s]));
  return {
    ok: false,
    code: 'changedSinceScan',
    message: '위험 검사를 한 뒤 저장소가 바뀌어 설치하지 않았습니다. 바뀐 내용을 다시 검사했으니 확인한 뒤 다시 설치하세요.',
    changes,
    before,
    after,
    newFlags: [...new Set(after.flatMap((s) => s.riskFlags))].filter((f) => !had.has(f)),
    raised: after.filter((s) => old.has(s.id) && (RANK[s.riskLevel] ?? 0) > (RANK[old.get(s.id)!.riskLevel] ?? 0)).map((s) => s.name),
    added: after.filter((s) => !old.has(s.id)).map((s) => s.name),
    removed: before.filter((s) => !now.has(s.id)).map((s) => s.name),
    ...extra,
  };
}

const unverified = (repo: string): Recheck => ({
  ok: false,
  code: 'unverified',
  message: `설치 직전에 ${repo}의 최신 커밋을 확인하지 못해 설치하지 않았습니다. 네트워크와 git을 확인한 뒤 다시 시도하세요.`,
});

const textOrNull = (v: unknown) => (typeof v === 'string' && v.trim() ? sanitizeLine(v) : null);

/**
 * Whether a plugin inside its marketplace repo holds the same files (path and blob) at both commits, its folder found
 * as the index finds it; null when that cannot be told (no blob ids, an empty or missing folder, a failed read).
 */
async function sameFolder(github: GitHub, plugin: PluginRow, repo: string, a: string, b: string): Promise<boolean | null> {
  try {
    const [ta, tb] = await Promise.all([github.getTree(repo, a), github.getTree(repo, b)]);
    const stored = (plugin.entry_json ? JSON.parse(plugin.entry_json) : null) as StoredPluginEntry | null;
    const src = normalizeSource(stored?.entry.source ?? JSON.parse(plugin.source_json), stored?.pluginRoot);
    if (src.kind !== 'relative') return null;
    const root = resolveRelativeRoot(src.raw as string, stored?.pluginRoot ?? null, new TreeIndex(ta.entries));
    if (root == null) return null;
    const prefix = root ? `${root}/` : '';
    const files = (entries: Array<{ path: string; sha: string | null }>) => {
      const out = new Map<string, string | null>();
      for (const e of entries) if (!prefix || e.path.startsWith(prefix)) out.set(e.path, e.sha);
      return out;
    };
    const fa = files(ta.entries);
    const fb = files(tb.entries);
    if (fa.size === 0) return null;
    if (fa.size !== fb.size) return false;
    for (const [p, sha] of fa) {
      if (sha == null || !fb.has(p)) return sha == null ? null : false;
      if (fb.get(p) !== sha) return false;
    }
    return true;
  } catch {
    return null;
  }
}

/**
 * Updates one plugin's row from the marketplace.json at `mpSha`, as the marketplace sync would for it alone. Returns
 * false when the plugin is no longer listed there.
 */
async function refreshEntry(store: Store, github: GitHub, plugin: PluginRow, mp: MarketplaceRow, mpSha: string): Promise<boolean> {
  const res = await github.getRawText(mp.repo, mpSha, MARKETPLACE_JSON, 32 * 1024 * 1024);
  if (res.text == null || res.truncated) throw new Error(`marketplace.json을 가져오지 못했습니다 (${res.status})`);
  const manifest = parseMarketplace(res.text);
  const entry = manifest.plugins.find((p) => p.name === plugin.name);
  if (!entry) return false;
  const pluginRoot = manifest.metadata?.pluginRoot ?? null;
  const src = normalizeSource(entry.source, pluginRoot);
  const cols = sourceColumns(src, mp.repo);
  if (src.kind === 'relative') cols.sha = mpSha;
  const keywords = [...(Array.isArray(entry.keywords) ? entry.keywords : []), ...(Array.isArray(entry.tags) ? entry.tags : [])].filter((k): k is string => typeof k === 'string');
  const stored: StoredPluginEntry = { entry, pluginRoot };
  store.upsertPlugin({
    id: plugin.id,
    marketplace: plugin.marketplace,
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
  return true;
}

/** The parts of a marketplace entry that decide what is installed (its source and components), not its wording. */
const INSTALLED_FIELDS = ['source', 'strict', 'skills', 'commands', 'agents', 'hooks', 'mcpServers', 'lspServers', 'outputStyles', 'monitors'];
const entryOf = (p: PluginRow) => {
  const stored = p.entry_json ? (JSON.parse(p.entry_json) as StoredPluginEntry) : null;
  const entry: Record<string, unknown> = stored?.entry ?? { source: JSON.parse(p.source_json) };
  return JSON.stringify([stored?.pluginRoot ?? null, ...INSTALLED_FIELDS.map((k) => entry[k] ?? null)]);
};

/**
 * A registered marketplace's plugin, right before `claude plugin install`: the marketplace's head against the commit
 * its entry (and, for a plugin inside the marketplace repo, its folder) was checked at; an outside plugin repo's
 * head against the commit its skills were checked at, unless the entry pins a commit.
 */
export async function recheckPlugin(store: Store, github: GitHub, indexer: Indexer, pluginId: string, head: HeadLookup = gitHead): Promise<Recheck> {
  const plugin = store.getPlugin(pluginId);
  const mp = plugin ? store.getMarketplace(plugin.marketplace) : undefined;
  if (!plugin?.repo || !mp) return { ok: true }; // not one the app installs (planInstall says so first)
  const mpHead = await head(mp.repo, null);
  if (!mpHead) return unverified(mp.repo);
  const changes: CommitChange[] = [];
  const relative = plugin.source_kind === 'relative';
  let entryMoved = false;
  if (relative) {
    const checked = plugin.skills_indexed_sha;
    if (checked !== mpHead) {
      // the marketplace moved; its entry and this plugin's folder may well be what they were
      const same = checked ? await sameFolder(github, plugin, mp.repo, checked, mpHead) : null;
      if (same !== true) changes.push({ what: 'marketplace', repo: mp.repo, checked, now: mpHead });
      else entryMoved = true; // compared below with the entry at the new commit
    }
  } else if (mp.commit_sha !== mpHead) entryMoved = true;
  let pluginHead: string | null = null;
  if (!relative && !isCommitSha(plugin.sha)) {
    pluginHead = await head(plugin.repo, plugin.ref);
    if (!pluginHead) return unverified(plugin.repo);
    if (pluginHead !== plugin.skills_indexed_sha) changes.push({ what: 'plugin', repo: plugin.repo, checked: plugin.skills_indexed_sha, now: pluginHead });
  }

  const before = store.listSkillsByPlugin(pluginId).map(risk);
  // the entry at the new marketplace commit: an outside plugin moved by its entry (another repo, ref or pinned commit)
  let entryChanged = false;
  if (entryMoved || changes.length) {
    try {
      const prevEntry = entryOf(plugin);
      const listed = await trackIndexChanges(store, async () => {
        if (!(await refreshEntry(store, github, plugin, mp, mpHead))) return false;
        const now = store.getPlugin(pluginId)!;
        entryChanged = entryOf(now) !== prevEntry;
        if (!entryChanged && !changes.length) return true; // nothing that is installed moved
        if (entryChanged && !changes.some((c) => c.what === 'marketplace')) changes.push({ what: 'marketplace', repo: mp.repo, checked: mp.commit_sha, now: mpHead });
        // an outside plugin whose entry now names another repo or ref: its head there
        const at = !relative && !isCommitSha(now.sha) && now.repo ? (now.repo === plugin.repo && now.ref === plugin.ref ? pluginHead : await head(now.repo, now.ref)) : null;
        await indexer.indexPlugin(pluginId, at ? { atSha: at } : {});
        return true;
      });
      if (!listed) return changed([{ what: 'marketplace', repo: mp.repo, checked: mp.commit_sha, now: mpHead }], before, [], { gone: true });
    } catch (err) {
      if (!changes.length) changes.push({ what: 'marketplace', repo: mp.repo, checked: mp.commit_sha, now: mpHead });
      return changed(changes, before, before, { error: String((err as Error).message ?? err).slice(0, 200) });
    }
  }
  if (!changes.length) return { ok: true };
  return changed(changes, before, store.listSkillsByPlugin(pluginId).map(risk));
}

/**
 * A skill installed from its repo's head (the skills CLI install that cannot be pinned, or a plugin from a repo's
 * own marketplace): the head against the commit it was checked at; when it moved, that skill is read again there.
 */
export async function recheckRepoSkill(store: Store, indexer: Indexer, skill: SkillRow, head: HeadLookup = gitHead): Promise<Recheck> {
  if (!skill.repo || skill.dir_path == null) return { ok: true };
  const now = await head(skill.repo, null);
  if (!now) return unverified(skill.repo);
  if (now === skill.ref) return { ok: true };
  const before = [risk(skill)];
  const changes: CommitChange[] = [{ what: 'skill', repo: skill.repo, checked: skill.ref, now }];
  try {
    const row = await trackIndexChanges(store, () => indexer.indexSkillAt(skill.repo!, skill.dir_path!, now));
    return changed(changes, before, row ? [risk(row)] : [], row ? {} : { gone: true });
  } catch (err) {
    return changed(changes, before, before, { error: String((err as Error).message ?? err).slice(0, 200) });
  }
}

/** The check that applies to an install plan; `{ok: true}` when what is installed is the commit checked. */
export function recheckInstall(ctx: { store: Store; github: GitHub; indexer: Indexer }, skill: SkillRow, plan: InstallPlan, head: HeadLookup = gitHead): Promise<Recheck> {
  if (plan.method === 'plugin') {
    if (plan.pluginId && ctx.store.getPlugin(plan.pluginId)) return recheckPlugin(ctx.store, ctx.github, ctx.indexer, plan.pluginId, head);
    return recheckRepoSkill(ctx.store, ctx.indexer, skill, head);
  }
  if (plan.method === 'skills-cli' && !plan.pinnedRef) return recheckRepoSkill(ctx.store, ctx.indexer, skill, head);
  return Promise.resolve({ ok: true });
}
