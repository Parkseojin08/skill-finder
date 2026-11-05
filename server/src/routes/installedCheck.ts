// GET /api/installed/check: the overlaps the 설치됨 screen's check chips need and its /installed answer lacks
// (feature review F8): installed copies with the same SKILL.md, and pairs whose words mostly match. Every agent's
// folder is read (F9 stage 1), and the skills of the Claude Code plugins that apply here. Read only.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Router } from 'express';
import { extractSkillMeta } from '../analyze/frontmatter.ts';
import type { AppContext } from '../context.ts';
import { listClaudePlugins } from '../agentConfig/read.ts';
import { scanInstalledSkills, scanPluginSkills } from '../install/installed.ts';
import { isProjectDir } from '../install/validate.ts';
import { duplicateGroups, OVERLAP_MAX_SKILLS, overlapPairs, overlapTokens, type OverlapInput } from '../installedCheck/overlap.ts';
import { MAX_FILE_BYTES } from '../util/textFiles.ts';
import { truncate } from '../util/sanitize.ts';

/** As the indexer and installed.ts hash SKILL.md: line endings would otherwise make every copy differ. */
const mdHash = (raw: string) => createHash('sha256').update(raw.replace(/\r\n/g, '\n')).digest('hex');

export type CheckSide = { path: string; name: string; description: string; tokens: string[] };
export type InstalledCheck = {
  duplicates: Array<{ hash: string; paths: string[] }>;
  pairs: Array<{ a: CheckSide; b: CheckSide; score: number; shared: string[] }>;
  /** Skills compared, and those past OVERLAP_MAX_SKILLS left out. */
  compared: number;
  skipped: number;
};

export function installedCheckRouter(ctx: AppContext, opts: { home?: string } = {}): Router {
  const r = Router();
  r.get('/installed/check', async (req, res) => {
    const projectPath = typeof req.query.projectPath === 'string' && req.query.projectPath.trim() ? req.query.projectPath.trim() : null;
    if (projectPath && !isProjectDir(projectPath)) {
      res.status(400).json({ error: '프로젝트 경로는 존재하는 디렉터리의 절대경로여야 합니다' });
      return;
    }
    const home = opts.home ?? homedir();
    const rows: Array<{ path: string; folder: string; name: string; description: string }> = [
      ...(await scanInstalledSkills(ctx.store, 'user', null, undefined, { home })),
      ...(projectPath ? await scanInstalledSkills(ctx.store, 'project', projectPath, undefined, { home }) : []),
    ];
    for (const p of await listClaudePlugins({ home, projectPath })) {
      rows.push(...(await scanPluginSkills(ctx.store, { id: p.id, scope: p.scope, installPath: p.installPath, enabled: p.enabled })));
    }
    const seen = new Set<string>();
    const unique = rows.filter((s) => !seen.has(s.path) && seen.add(s.path));
    const compared = unique.slice(0, OVERLAP_MAX_SKILLS);
    const sides: CheckSide[] = [];
    const inputs: OverlapInput[] = [];
    for (const s of compared) {
      let raw: string | null = null;
      try {
        raw = await readFile(join(s.path, 'SKILL.md'), 'utf8');
      } catch {
        // gone since the scan
      }
      // the frontmatter is at the top: a huge SKILL.md is hashed whole but parsed only so far
      const description = raw ? extractSkillMeta(raw.length > MAX_FILE_BYTES ? raw.slice(0, MAX_FILE_BYTES) : raw, s.folder).description : s.description;
      const tokens = overlapTokens(s.name, description);
      sides.push({ path: s.path, name: s.name, description: truncate(description, 1000), tokens });
      inputs.push({ path: s.path, hash: raw ? mdHash(raw) : null, tokens });
    }
    const body: InstalledCheck = {
      duplicates: duplicateGroups(inputs),
      pairs: overlapPairs(inputs).map((p) => ({ a: sides[p.a], b: sides[p.b], score: p.score, shared: p.shared })),
      compared: compared.length,
      skipped: unique.length - compared.length,
    };
    res.json(body);
  });
  return r;
}
