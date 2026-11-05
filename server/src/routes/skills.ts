import { Router } from 'express';
import { findHiddenContent } from '../analyze/hiddenContent.ts';
import { extractSkillMeta, parseAllowedTools } from '../analyze/frontmatter.ts';
import { permissionTable, type SiblingSkill } from '../analyze/permissions.ts';
import { riskEvidence, RISK_RULES_VERSION, type FlagEvidence, type RiskFlag, type SkillRiskInput } from '../analyze/risk.ts';
import type { AppContext } from '../context.ts';
import { recheckRisk, type StoredFiles } from '../indexer.ts';
import { installIsHighRisk } from '../install/acks.ts';
import { runInstallScan } from '../install/record.ts';
import { existingAgentFolders, installTargets } from '../install/targets.ts';
import { buildSteps, installAgents, installLocation, planInstall, type InstallScope } from '../install/plan.ts';
import { isProjectDir } from '../install/validate.ts';
import { bumpIndexGeneration } from '../search/indexGeneration.ts';
import { freshness, TRUST_SCORE, trustTier } from '../search/rank.ts';
import { githubSource, marketplaceSource, treeUrl } from '../search/result.ts';
import { getSettings } from '../settings.ts';
import { looksBinary } from '../util/http.ts';
import { sanitizeText } from '../util/sanitize.ts';
import { isTextPath, MAX_FILE_BYTES } from '../util/textFiles.ts';
import { skillTokens } from '../util/tokens.ts';

/**
 * Where an opened result was in its search (U5-2): the search's `sid`, its 1-based place in the list, the page,
 * and whether it was still an early card. Only well-formed values are kept; undefined when there are none.
 */
function viewMeta(q: Record<string, unknown>): Record<string, unknown> | undefined {
  const int = (v: unknown, max: number) => (typeof v === 'string' && /^\d{1,4}$/.test(v) && Number(v) >= 1 && Number(v) <= max ? Number(v) : undefined);
  const meta = {
    sid: typeof q.sid === 'string' && /^[0-9a-f-]{36}$/.test(q.sid) ? q.sid : undefined,
    pos: int(q.pos, 1000),
    page: int(q.page, 1000),
    provisional: q.prov === '1' ? true : undefined,
  };
  return Object.values(meta).some((v) => v !== undefined) ? meta : undefined;
}

/**
 * Where each of the row's flags was found in its SKILL.md (feature review F1), and what it may do by kind. `text`: the
 * SKILL.md as the page shows it (sanitized), so the lines are the ones the page numbers; null when it could not be
 * read (the table then comes from the stored frontmatter, without lines). Computed per request, nothing stored.
 */
function evidenceAndPermissions(
  skill: { files: string[]; frontmatter: Record<string, unknown>; flags: string[] },
  text: string | null,
  siblings: SiblingSkill[],
  plugin: { hooks: boolean; mcp: boolean; monitors: boolean; bin: boolean; lsp: boolean } | null,
): { riskEvidence: Partial<Record<RiskFlag, FlagEvidence>>; permissions: ReturnType<typeof permissionTable> } {
  let input: SkillRiskInput;
  if (text != null) {
    const raw = text.replace(/^\uFEFF/, '');
    const meta = extractSkillMeta(raw, '');
    input = { files: skill.files, allowedTools: meta.allowedTools, body: meta.body, hasHooks: meta.hasHooks, raw, partial: skill.flags.includes('unscanned') };
  } else {
    const fm = skill.frontmatter;
    input = { files: skill.files, allowedTools: parseAllowedTools(fm['allowed-tools']), body: '', hasHooks: fm.hooks != null && fm.hooks !== false, raw: '', partial: false };
  }
  const all = text != null ? riskEvidence(input) : {};
  // only the flags the row has: a place the stored judgement does not count is not shown as its reason
  const shown: Partial<Record<RiskFlag, FlagEvidence>> = {};
  for (const [flag, e] of Object.entries(all) as Array<[RiskFlag, FlagEvidence]>) if (skill.flags.includes(flag)) shown[flag] = e;
  return { riskEvidence: shown, permissions: permissionTable({ skill: input, evidence: shown, siblings, plugin }) };
}

/** `agents=claude-code,codex` of a query, as installAgents reads it. */
const agentsParam = (v: unknown) => installAgents(typeof v === 'string' ? v.split(',').slice(0, 10) : null);

export function skillsRouter(ctx: AppContext): Router {
  const r = Router();
  const { store, github } = ctx;

  r.get('/skills/:id', async (req, res) => {
    const skill = store.getSkill(req.params.id);
    if (!skill) {
      res.status(404).json({ error: '스킬을 찾을 수 없습니다' });
      return;
    }
    // Only results opened from a logged search (UI debate 1-6): a page reload, a pasted link or a script reading
    // the API would otherwise fill the log with views no search led to.
    const meta = viewMeta(req.query);
    if (getSettings(store).searchLog && meta?.sid) store.logEvent('view', skill.id, typeof req.query.q === 'string' ? req.query.q.slice(0, 300) : null, meta);
    const plugin = skill.plugin_id ? (store.getPlugin(skill.plugin_id) ?? null) : null;
    const marketplace = plugin ? (store.getMarketplace(plugin.marketplace) ?? null) : null;
    const plan = planInstall(skill, plugin, marketplace);
    const files = (skill.files_json ? JSON.parse(skill.files_json) : { files: [], total: 0 }) as StoredFiles;

    let skillMd: string | null = null;
    /** The SKILL.md as shown, without the "cut here" note: the text the evidence lines are counted in. */
    let shownText: string | null = null;
    let skillMdError: string | null = null;
    let risk = { json: skill.risk_json, level: skill.risk_level, rules: skill.risk_rules ?? null };
    if (skill.repo && skill.ref && skill.dir_path != null) {
      try {
        const res2 = await github.getRawText(skill.repo, skill.ref, skill.dir_path ? `${skill.dir_path}/SKILL.md` : 'SKILL.md', MAX_FILE_BYTES);
        if (res2.text == null) skillMdError = `SKILL.md를 가져오지 못했습니다 (${res2.status})`;
        else {
          shownText = sanitizeText(res2.text);
          skillMd = shownText + (res2.truncated ? '\n\n…(256KB에서 잘림)' : '');
          // judged under older rules (the background re-check has not reached it yet): the file is here now, so judge
          // it again and keep the result, as that re-check would (feature review P13). Only the same SKILL.md (hash).
          if ((risk.rules ?? 0) < RISK_RULES_VERSION && !res2.truncated && skill.skill_md_sha256) {
            const next = recheckRisk(skill, res2.text);
            if (next && store.setSkillRisk(skill.id, skill.skill_md_sha256, next.risk_json, next.risk_level, RISK_RULES_VERSION)) {
              // cards show the flags too, so a flag-only change counts, as in the background re-check
              if (next.risk_level !== skill.risk_level || next.risk_json !== skill.risk_json) bumpIndexGeneration(store);
              risk = { json: next.risk_json, level: next.risk_level, rules: RISK_RULES_VERSION };
            }
          }
        }
      } catch (err) {
        skillMdError = `SKILL.md를 가져오지 못했습니다 (${String((err as Error).message ?? err).slice(0, 100)})`;
      }
    }

    const signals = plugin?.signals_json ? JSON.parse(plugin.signals_json) : null;
    const repoMeta = skill.repo ? (store.getRepo(skill.repo) ?? null) : null;
    // skills.sh lists it (it has a download count from there): its page also shows Gen·Socket·Snyk audits.
    // Its page is named after the skill's folder (skillId), not the frontmatter name.
    const skillsShId = skill.dir_path ? (skill.dir_path.split('/').pop() ?? skill.name) : skill.name;
    const skillsSh =
      skill.installs != null && skill.repo
        ? { kind: 'skillssh' as const, label: 'skills.sh', url: `https://skills.sh/${[...skill.repo.split('/'), skillsShId].map(encodeURIComponent).join('/')}` }
        : null;
    const sources = [plugin ? marketplaceSource(skill, plugin) : null, githubSource(skill), skillsSh].filter(Boolean);
    const flags = (risk.json ? JSON.parse(risk.json) : []) as string[];
    const pluginSkills = plugin ? store.listSkillsByPlugin(plugin.id) : [];
    // the plugin's other skills and parts count too: installing this skill installs them all (F1)
    const siblings: SiblingSkill[] = pluginSkills
      .filter((s) => s.id !== skill.id)
      .map((s) => ({ name: s.name, frontmatter: s.frontmatter_json ? (JSON.parse(s.frontmatter_json) as Record<string, unknown>) : {}, flags: s.risk_json ? (JSON.parse(s.risk_json) as string[]) : [] }));
    const parts = plugin && signals ? { hooks: !!signals.hooks, mcp: !!signals.mcp, monitors: !!signals.monitors, bin: !!signals.bin, lsp: !!signals.lsp } : null;
    const { riskEvidence: evidence, permissions } = evidenceAndPermissions(
      { files: files.files.map((f) => f.path), frontmatter: skill.frontmatter_json ? JSON.parse(skill.frontmatter_json) : {}, flags },
      shownText,
      siblings,
      parts,
    );
    res.json({
      id: skill.id,
      name: skill.name,
      description: skill.description,
      whenToUse: skill.when_to_use,
      // context taken: name and description with every request once installed, SKILL.md when used (estimate)
      tokens: skillTokens(skill.name, skill.description, skillMd),
      origin: skill.origin,
      repo: skill.repo,
      ref: skill.ref,
      dirPath: skill.dir_path,
      url: skill.repo ? treeUrl(skill.repo, skill.ref, skill.dir_path) : null,
      sources,
      installs: skill.installs,
      stars: repoMeta?.stars ?? null,
      license: repoMeta?.license ?? null,
      archived: repoMeta?.archived === 1,
      movedTo: repoMeta?.moved_to ?? null,
      lastCommitAt: skill.last_commit_at,
      frontmatter: skill.frontmatter_json ? JSON.parse(skill.frontmatter_json) : {},
      bodyLines: skill.body_lines,
      /** Absolute parts of the score; R and P are relative to a result set and come from the result card. */
      partialBreakdown: { F: freshness(skill.last_commit_at), T: TRUST_SCORE[trustTier(skill, plugin)] },
      riskLevel: risk.level,
      riskFlags: flags,
      /** Where each flag was found: file, line and the lines around it (feature review F1). */
      riskEvidence: evidence,
      /** Shell, file read and write, network, MCP and what runs on its own: pre-approved, asks or none, with why. */
      permissions,
      /**
       * The level is from older risk rules than the app's (null: before versions) because the SKILL.md could not be
       * read again to judge it under the current ones (feature review P13). Well-known rows have no SKILL.md.
       */
      riskRulesStale: skill.origin !== 'wellknown' && (risk.rules ?? 0) < RISK_RULES_VERSION,
      qualityWarnings: skill.quality_json ? JSON.parse(skill.quality_json) : [],
      skillMd,
      skillMdError,
      // what the rendered SKILL.md hides but Claude reads, as offsets into skillMd (feature review F2)
      hiddenContent: skillMd ? findHiddenContent(skillMd) : { spans: [], more: false },
      files: files.files.map((f) => ({ path: f.path, size: f.size, isText: isTextPath(f.path) })),
      filesTotal: files.total,
      plugin: plugin
        ? {
            id: plugin.id,
            name: plugin.name,
            displayName: plugin.display_name,
            description: plugin.description,
            marketplace: plugin.marketplace,
            sourceKind: plugin.source_kind,
            // with their risk: installing any one of them installs all (UI debate 1-1)
            skills: pluginSkills.map((s) => ({
              id: s.id,
              name: s.name,
              riskLevel: s.risk_level,
              riskFlags: s.risk_json ? (JSON.parse(s.risk_json) as string[]) : [],
            })),
            hooks: !!signals?.hooks,
            mcp: !!signals?.mcp,
            bin: !!signals?.bin,
            monitors: !!signals?.monitors,
            lsp: !!signals?.lsp,
            strictConflict: !!signals?.strictConflict,
          }
        : null,
      install: plan,
    });
  });

  r.get('/skills/:id/file', async (req, res) => {
    const skill = store.getSkill(req.params.id);
    const path = typeof req.query.path === 'string' ? req.query.path : '';
    if (!skill || !skill.repo || !skill.ref || skill.dir_path == null) {
      res.status(404).json({ error: '스킬을 찾을 수 없습니다' });
      return;
    }
    const files = (skill.files_json ? JSON.parse(skill.files_json) : { files: [] }) as StoredFiles;
    const entry = files.files.find((f) => f.path === path);
    if (!entry) {
      res.status(404).json({ error: '스킬 폴더에 없는 파일입니다' });
      return;
    }
    if (!isTextPath(path)) {
      res.status(415).json({ error: '텍스트 파일만 열 수 있습니다' });
      return;
    }
    if (entry.size != null && entry.size > MAX_FILE_BYTES) {
      res.status(413).json({ error: '256KB를 넘는 파일은 열 수 없습니다' });
      return;
    }
    const full = skill.dir_path ? `${skill.dir_path}/${path}` : path;
    const out = await github.getRawText(skill.repo, skill.ref, full, MAX_FILE_BYTES).catch(() => null);
    if (!out || out.text == null) {
      res.status(502).json({ error: '파일을 가져오지 못했습니다' });
      return;
    }
    if (out.truncated) {
      res.status(413).json({ error: '256KB를 넘는 파일은 열 수 없습니다' });
      return;
    }
    if (looksBinary(out.text)) {
      res.status(415).json({ error: '텍스트 파일이 아닙니다' });
      return;
    }
    res.json({ path, content: sanitizeText(out.text) });
  });

  // What the install brings besides SKILL.md (project review F1): the folder's other text files checked with the
  // same rules, or what a plugin runs (hooks, MCP servers). Read only; asked once when the install tab opens.
  r.get('/skills/:id/install-scan', async (req, res) => {
    const skill = store.getSkill(req.params.id);
    if (!skill) {
      res.status(404).json({ error: '스킬을 찾을 수 없습니다' });
      return;
    }
    const plugin = skill.plugin_id ? (store.getPlugin(skill.plugin_id) ?? null) : null;
    const plan = planInstall(skill, plugin, plugin ? (store.getMarketplace(plugin.marketplace) ?? null) : null);
    try {
      res.json(await runInstallScan(ctx, skill, plan));
    } catch (err) {
      res.status(502).json({ error: `설치될 파일을 읽지 못했습니다: ${String((err as Error).message ?? err).slice(0, 200)}` });
    }
  });

  r.get('/install/preview', async (req, res) => {
    const id = typeof req.query.id === 'string' ? req.query.id : '';
    const scope = req.query.scope as InstallScope;
    const projectPath = typeof req.query.projectPath === 'string' && req.query.projectPath.trim() ? req.query.projectPath.trim() : null;
    const skill = store.getSkill(id);
    if (!skill) {
      res.status(404).json({ error: '스킬을 찾을 수 없습니다' });
      return;
    }
    const plugin = skill.plugin_id ? (store.getPlugin(skill.plugin_id) ?? null) : null;
    const plan = planInstall(skill, plugin, plugin ? (store.getMarketplace(plugin.marketplace) ?? null) : null);
    if (!plan.scopes.includes(scope)) {
      res.json({ plan, steps: [], location: '', error: plan.method === 'manual-only' ? plan.reason : '이 방식에서 지원하지 않는 범위입니다' });
      return;
    }
    if (scope !== 'user' && !isProjectDir(projectPath)) {
      res.json({ plan, steps: [], location: '', error: '프로젝트 경로는 존재하는 디렉터리의 절대경로여야 합니다' });
      return;
    }
    // the agents ticked (F9 stage 2): a plugin is Claude Code's only, whatever was asked
    const agents = plan.method === 'skills-cli' ? agentsParam(req.query.agents) : installAgents(null);
    const steps = buildSteps(plan, scope, projectPath, agents);
    const cli = plan.method === 'skills-cli' && scope !== 'local';
    // the skills CLI replaces a folder of the same name without asking (-y, D-5): say so before the install, for
    // every folder it writes
    const existingAll = cli ? await existingAgentFolders(store, skill.id, plan.skillName!, scope, projectPath, agents) : [];
    res.json({
      plan,
      steps: steps.map((s) => ({ display: s.display, cwd: s.cwd, note: s.note })),
      location: installLocation(plan, scope, projectPath, agents),
      createsLockFile: plan.method === 'skills-cli' && scope === 'project',
      // the install needs the dialog's high-risk tick (acks.high), as the server decides it (feature review P7)
      highRisk: installIsHighRisk(store, skill, plan),
      existing: existingAll[0] ?? null,
      existingAll,
      agents,
      // the agents a skills CLI install can go to, and which are set up here (only those can be ticked)
      targets: cli ? installTargets(scope, projectPath) : [],
    });
  });

  return r;
}
