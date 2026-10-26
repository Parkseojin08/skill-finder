import { basename, joinPath, skillMdPath, type TreeIndex } from './tree.ts';

// Mirrors skills CLI 1.7.4 src/skills.ts (discoverSkills) so that what we list is what `skills add --skill` can install.
export const SKIP_DIRS = ['node_modules', '.git', 'dist', 'build', '__pycache__'];

export const AGENT_PROJECT_SKILL_DIRS = [
  '.agents/skills',
  '.claude/skills',
  '.cline/skills',
  '.codebuddy/skills',
  '.codex/skills',
  '.commandcode/skills',
  '.continue/skills',
  '.factory/skills',
  '.github/skills',
  '.goose/skills',
  '.grok/skills',
  '.iflow/skills',
  '.junie/skills',
  '.kilo/skills',
  '.kilocode/skills',
  '.kimchi/skills',
  '.kiro/skills',
  '.minimax/skills',
  '.mux/skills',
  '.neovate/skills',
  '.opencode/skills',
  '.openhands/skills',
  '.pi/skills',
  '.posit/assistant/skills',
  '.qoder/skills',
  '.roo/skills',
  '.trae/skills',
  '.windsurf/skills',
  '.zcode/skills',
  '.zencoder/skills',
];

/**
 * Candidate skill folders in priority order: root children (depth 1), then `skills/`, `skills/.curated`,
 * `skills/.experimental`, `skills/.system` and agent project folders (depth 3). Does not descend below a
 * folder that has SKILL.md. The root SKILL.md case is handled by the caller.
 */
export function priorityCandidateDirs(tree: TreeIndex, base = ''): string[] {
  const priority = [
    base,
    joinPath(base, 'skills'),
    joinPath(base, 'skills/.curated'),
    joinPath(base, 'skills/.experimental'),
    joinPath(base, 'skills/.system'),
    ...AGENT_PROJECT_SKILL_DIRS.map((d) => joinPath(base, d)),
  ];
  const deep = new Set(priority.slice(1));
  const seen = new Set<string>();
  const out: string[] = [];
  const walk = (dir: string, maxDepth: number, depth: number) => {
    if (!tree.hasDir(dir)) return;
    for (const child of tree.childDirs(dir)) {
      if (tree.hasFile(skillMdPath(child))) {
        if (!seen.has(child)) {
          seen.add(child);
          out.push(child);
        }
        continue;
      }
      if (depth >= maxDepth || SKIP_DIRS.includes(basename(child))) continue;
      walk(child, maxDepth, depth + 1);
    }
  };
  for (const dir of priority) walk(dir, deep.has(dir) ? 3 : 1, 1);
  return out;
}

/** Fallback full recursion (max depth 5 from base) used when the priority scan found no valid skill. */
export function recursiveCandidateDirs(tree: TreeIndex, base = '', maxDepth = 5): string[] {
  const out: string[] = [];
  const visit = (dir: string, depth: number) => {
    if (depth > maxDepth) return;
    if (tree.hasFile(skillMdPath(dir))) out.push(dir);
    for (const child of tree.childDirs(dir)) {
      if (SKIP_DIRS.includes(basename(child))) continue;
      visit(child, depth + 1);
    }
  };
  visit(base, 0);
  return out;
}

export type GenericSkill = { dirPath: string; name: string; raw: string };

export type SkillMdReader = (path: string) => Promise<string | null>;
export type SkillMdValidator = (raw: string) => { name: string; description: string } | null;

/**
 * Generic repository mode. A SKILL.md needs a string name and description (as in the CLI);
 * same-name skills keep only the first one.
 */
export async function discoverGenericSkills(
  tree: TreeIndex,
  read: SkillMdReader,
  validate: SkillMdValidator,
  opts: { maxFetch?: number } = {},
): Promise<GenericSkill[]> {
  const maxFetch = opts.maxFetch ?? 300;
  if (tree.hasFile('SKILL.md')) {
    const raw = await read('SKILL.md');
    const v = raw != null ? validate(raw) : null;
    if (raw != null && v) return [{ dirPath: '', name: v.name, raw }];
  }
  const collect = async (dirs: string[]) => {
    const limited = dirs.slice(0, maxFetch);
    const raws = await Promise.all(limited.map((d) => read(skillMdPath(d))));
    const seen = new Set<string>();
    const out: GenericSkill[] = [];
    limited.forEach((dirPath, i) => {
      const raw = raws[i];
      const v = raw != null ? validate(raw) : null;
      if (raw == null || !v || seen.has(v.name)) return;
      seen.add(v.name);
      out.push({ dirPath, name: v.name, raw });
    });
    return out;
  };
  const found = await collect(priorityCandidateDirs(tree));
  if (found.length > 0) return found;
  return collect(recursiveCandidateDirs(tree).filter((d) => d !== ''));
}

export type GenericAcceptor = {
  /** Folders the generic rules could list, in the order the CLI looks (root, priority folders, recursion). */
  candidates: string[];
  /** The SKILL.md text if the generic rules list `dir`, else null. Reads only what the decision needs. */
  accepts(dir: string): Promise<string | null>;
};

/**
 * Same decision as {@link discoverGenericSkills} for one folder at a time, so looking up a single skill
 * in a repo with hundreds of them reads a handful of SKILL.md files instead of all of them:
 * a valid root SKILL.md hides everything else; a priority folder counts if its own SKILL.md is valid;
 * a deeper folder counts only when no priority folder holds a valid skill.
 */
export function genericAcceptor(tree: TreeIndex, read: SkillMdReader, validate: SkillMdValidator): GenericAcceptor {
  const priority = priorityCandidateDirs(tree);
  const prioritySet = new Set(priority);
  const recursive = recursiveCandidateDirs(tree).filter((d) => d !== '');
  const recursiveSet = new Set(recursive);
  const hasRoot = tree.hasFile('SKILL.md');

  const validRaw = async (dir: string) => {
    const raw = await read(skillMdPath(dir));
    return raw != null && validate(raw) ? raw : null;
  };
  let rootValid: Promise<boolean> | null = null;
  let anyPriorityValid: Promise<boolean> | null = null;
  const priorityHasValid = async () => {
    // Usually the first folder is valid, so check a few at a time and stop early.
    for (let i = 0; i < priority.length; i += 4) {
      const raws = await Promise.all(priority.slice(i, i + 4).map(validRaw));
      if (raws.some(Boolean)) return true;
    }
    return false;
  };

  // Same-name skills keep only the first one in scan order. Checking every earlier folder would mean
  // reading them all; copies almost always sit in a folder named after the skill, so check those.
  const firstWithName = async (tier: string[], dir: string, raw: string | null) => {
    if (raw == null) return null;
    const name = validate(raw)!.name;
    for (const other of tier.slice(0, tier.indexOf(dir))) {
      if (basename(other) !== name) continue;
      const earlier = await validRaw(other);
      if (earlier != null && validate(earlier)!.name === name) return null;
    }
    return raw;
  };

  return {
    candidates: [...(hasRoot ? [''] : []), ...priority, ...recursive.filter((d) => !prioritySet.has(d))],
    async accepts(dir) {
      if (hasRoot) {
        rootValid ??= validRaw('').then(Boolean);
        if (await rootValid) return dir === '' ? read('SKILL.md') : null;
      }
      if (prioritySet.has(dir)) return firstWithName(priority, dir, await validRaw(dir));
      if (!recursiveSet.has(dir)) return null;
      anyPriorityValid ??= priorityHasValid();
      return (await anyPriorityValid) ? null : firstWithName(recursive, dir, await validRaw(dir));
    },
  };
}
