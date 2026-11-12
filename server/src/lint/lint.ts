// "내 스킬 검사" (feature review 2026-11-04 F15): the checks the index runs on remote skills, run on a skill folder
// of this PC before it is shared. Frontmatter and quality rules (analyze/quality.ts), the risk signals with their
// lines (F1, B5) on SKILL.md and the folder's other text files, the context it takes, the text Claude sees in its
// skill list, whether the skills CLI finds it (D#532d), notes for other agents, and similar indexed skills (F4).
// Files are only read; nothing in the folder is run. No AI call: every check is a rule.
import { createHash } from 'node:crypto';
import { constants, existsSync } from 'node:fs';
import { lstat, open, readdir, realpath, stat, type FileHandle } from 'node:fs/promises';
import { basename, join, sep } from 'node:path';
import { extractSkillMeta } from '../analyze/frontmatter.ts';
import { LISTING_LIMIT, qualityWarnings, type QualityCode } from '../analyze/quality.ts';
import { RISK_ORDER, riskEvidence, riskLevel, skillRiskFlags, textEvidence, type Evidence, type FlagEvidence, type RiskFlag, type RiskLevel } from '../analyze/risk.ts';
import type { Store } from '../db/store.ts';
import { genericValidator } from '../indexer.ts';
import { skillFolderName } from '../install/installed.ts';
import { SCAN_MAX_FILES, textFileFlags } from '../install/scan.ts';
import { matchSkills } from '../recommend/readme.ts';
import { skillKeywords } from '../routes/similar.ts';
import type { Settings } from '../settings.ts';
import { RAW_MAX_BYTES } from '../sources/github.ts';
import { looksBinary } from '../util/http.ts';
import { isTextPath, MAX_FILE_BYTES } from '../util/textFiles.ts';
import { skillTokens } from '../util/tokens.ts';

export type LintSeverity = 'error' | 'warning' | 'info';
/**
 * One finding. `code`: a quality code (analyze/quality.ts), a risk flag, or one of LintCode; `message`: Korean, for
 * the CLI (the page words it from `code`). `file`/`line`: where, when there is one place.
 */
export type LintProblem = { severity: LintSeverity; code: string; message: string; file?: string; line?: number | null };
export type LintCode = 'skillMdMissing' | 'skillMdTooLarge' | 'notFoundByCli' | 'internalSkill' | 'claudeOnly' | 'folderName' | 'claudeKeys' | 'filesSkipped';

export type SimilarSkill = { id: string; name: string; description: string | null; riskLevel: RiskLevel; installs: number | null; stars: number | null; matchedTerms: string[] };

export type LintResult = {
  /** No error or warning (the CLI exits 1 otherwise). */
  ok: boolean;
  problems: LintProblem[];
  path: string;
  folder: string;
  name: string;
  description: string;
  quality: QualityCode[];
  risk: { level: RiskLevel; flags: RiskFlag[]; evidence: Partial<Record<RiskFlag, FlagEvidence>> };
  /** The folder's other text files with a signal (scripts first, at most SCAN_MAX_FILES read). */
  files: { checked: number; skipped: number; listed: number; findings: Array<{ path: string; flags: RiskFlag[]; evidence: Array<Evidence & { flag: RiskFlag }> }> };
  /** Context it takes (estimate): with every request while installed, and when used. */
  tokens: { perTurn: number; onUse: number | null };
  /** What Claude Code puts in its skill list: description and when_to_use, cut at LISTING_LIMIT characters. */
  listing: { text: string; chars: number; limit: number; truncated: boolean; cut: number };
  /** Whether `npx skills add` finds it (D#532d: name and description as strings, not metadata.internal). */
  skillsCli: { found: boolean; reason: 'nameOrDescription' | 'internal' | null; folder: string };
  /** Notes for agents other than Claude Code (codes of LintProblem with severity info, repeated for the page). */
  agents: { claudeOnlyFlags: RiskFlag[]; claudeKeys: string[] };
  /** Indexed skills that do the same job (null: no index at hand, as in the CLI without the app). */
  similar: SimilarSkill[] | null;
};

export type LintContext = {
  /** The index, for similar skills; without it `similar` is null. */
  store?: Store | null;
  settings?: Pick<Settings, 'weights' | 'minStars'>;
  /** Similar skills listed (default 5). */
  similarMax?: number;
  /**
   * Where the caller found the folder to be (after links) when it allowed it: the folder is read only from there, and
   * the result is void if the path leads elsewhere, before or after reading (FolderMovedError).
   */
  expectRealPath?: string;
};

/**
 * The folder is no longer where it was allowed: a link in its path was changed between the check and the reading, or
 * during it. What was read is not returned.
 */
export class FolderMovedError extends Error {
  constructor() {
    super('검사하는 동안 폴더의 위치가 바뀌었습니다. 다시 검사하세요');
  }
}

/** Flags whose meaning is Claude Code's own (web lib/security.ts CLAUDE_ONLY_FLAGS keeps the same list). */
export const CLAUDE_ONLY_FLAGS: ReadonlySet<RiskFlag> = new Set<RiskFlag>(['preapprovedBash', 'unscopedBash', 'shellInjection', 'skillHooks', 'pluginRootDependency', 'preapprovedNetwork', 'preapprovedWrite']);
/** Frontmatter keys of Claude Code beyond the agentskills.io ones (name, description, license, compatibility, metadata, allowed-tools). */
const CLAUDE_KEYS = ['when_to_use', 'hooks', 'model', 'disable-model-invocation', 'user-invocable', 'argument-hint', 'context', 'agent', 'paths'];
const SCRIPT_EXT = /\.(sh|bash|zsh|fish|py|js|mjs|cjs|ts|rb|pl|ps1|psm1|bat|cmd)$/i;
const LIST_MAX = 500;

const QUALITY_TEXT: Record<QualityCode, [LintSeverity, string]> = {
  noFrontmatter: ['error', '첫 줄이 ---로 시작하는 frontmatter가 없습니다'],
  yamlError: ['error', 'frontmatter YAML을 파싱하지 못했습니다'],
  nameMissing: ['error', 'name이 없어 폴더명을 씁니다'],
  nameFormat: ['warning', 'name은 소문자·숫자·하이픈만 씁니다(양끝·연속 하이픈 금지)'],
  nameLength: ['warning', 'name은 1–64자여야 합니다'],
  nameMismatch: ['warning', 'name이 폴더명과 다릅니다'],
  descriptionMissing: ['error', 'description이 없어 본문 첫 줄을 씁니다'],
  descriptionLength: ['warning', 'description이 1,024자를 넘습니다'],
  bodyTooLong: ['warning', '본문이 500줄을 넘습니다'],
  listingTruncated: ['warning', 'description + when_to_use가 1,536자를 넘어 스킬 목록에서 잘립니다'],
  reservedWord: ['info', '이름에 anthropic/claude가 들어 있습니다(API 업로드 시 예약어)'],
};

const RISK_TEXT: Partial<Record<RiskFlag, string>> = {
  scripts: '실행 가능한 코드 파일이 있습니다',
  preapprovedBash: 'allowed-tools가 Bash를 미리 허락합니다',
  unscopedBash: 'allowed-tools가 Bash를 명령 제한 없이 허락합니다',
  shellInjection: '!`명령`이 스킬을 읽기 전에 실행됩니다',
  skillHooks: '스킬이 훅을 등록합니다',
  pluginRootDependency: '${CLAUDE_PLUGIN_ROOT}에 기댑니다(플러그인으로만 동작)',
  curlPipeShell: '원격 스크립트를 내려받아 바로 실행합니다',
  rmRf: 'rm -rf가 있습니다',
  unscanned: 'SKILL.md가 512KB를 넘거나 frontmatter가 너무 커서 일부만 검사했습니다',
  hiddenContent: '화면에 보이지 않지만 Claude는 읽는 내용이 있습니다',
  obfuscatedExec: '인코딩한 내용을 풀어 실행합니다',
  claudeConfigTamper: 'Claude Code 설정을 바꾸거나 권한 확인을 끕니다',
  credentialAccess: '키·토큰·저장된 비밀번호를 읽거나 보냅니다',
  exfilEndpoint: '요청 수집·터널·붙여넣기 사이트나 IP 주소로 보냅니다',
  persistence: '다음에 다시 실행되도록 등록합니다(cron, 셸 시작 파일, 예약 작업, 시작 프로그램)',
  promptInjectionPhrase: '모델에게 지시를 무시하라거나 사용자에게 숨기라는 문구가 있습니다',
  preapprovedNetwork: 'allowed-tools가 네트워크 도구를 미리 허락합니다',
  preapprovedWrite: 'allowed-tools가 파일 쓰기를 미리 허락합니다',
  sensitiveReadNetwork: '민감한 파일을 읽으면서 네트워크도 미리 허락합니다',
};
const INFO_FLAGS = new Set<RiskFlag>(['rmRf', 'pluginRootDependency', 'scripts', 'pluginBin', 'promptInjectionPhrase']);

/** Files of the folder, relative with `/`, at most LIST_MAX; links and dependency folders are not followed. */
async function listFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string, prefix: string) => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (out.length >= LIST_MAX) return;
      if (e.name === 'node_modules' || e.name === '.git') continue;
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(join(dir, e.name), rel);
      else if (e.isFile()) out.push(rel);
      // a symbolic link is listed by name but never followed: it could lead out of the folder
      else if (e.isSymbolicLink()) out.push(rel);
    }
  };
  await walk(root, '');
  return out;
}

type FileId = { dev: bigint; ino: bigint };
const sameId = (a: FileId, b: FileId) => a.dev === b.dev && a.ino === b.ino;
/** Not on Windows (0 there): the last name of the path is then followed, and the identity check below decides. */
const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;

/**
 * The folder being checked: its real path, its identity, and on Linux the folder itself held open, so that files are
 * found beneath that very folder (its /proc/self/fd entry), not by a path whose names can be swapped meanwhile.
 */
type LintRoot = { path: string; id: FileId; dir: FileHandle | null };
const BENEATH = process.platform === 'linux' && existsSync('/proc/self/fd');

/**
 * On Linux: the file `rel` beneath the open folder, no name along the way followed if it is a link (each folder of
 * `rel` opened in turn the same way). Renaming or swapping the folder or anything in it cannot lead this elsewhere.
 */
async function openBeneath(dir: FileHandle, rel: string): Promise<FileHandle> {
  const parts = rel.split('/');
  const opened: FileHandle[] = [];
  let at = dir;
  try {
    for (const part of parts.slice(0, -1)) {
      at = await open(`/proc/self/fd/${at.fd}/${part}`, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      opened.push(at);
    }
    return await open(`/proc/self/fd/${at.fd}/${parts.at(-1)}`, constants.O_RDONLY | constants.O_NOFOLLOW);
  } finally {
    for (const h of opened) await h.close().catch(() => {});
  }
}

/**
 * Up to `limit` bytes of a file inside the folder (`more`: the file is longer), or null when it is not a plain file
 * of the folder. The file is opened first and only that opened file is read: checking a path and then opening it
 * again would read whatever a link put there in between (review 2026-11-12: a SKILL.md or a script swapped for a link
 * to a file outside, while "검사" ran). On Linux it is opened beneath the open folder (openBeneath). Elsewhere it is
 * checked to be the file the folder holds at that path (same device and inode as the path's real location inside the
 * folder), with the folder itself checked before and after: a folder swapped and swapped back between those checks
 * can still slip through there, as no openat() is available. `skipOver`: files larger than this are not read.
 */
async function readInsideBytes(root: LintRoot, rel: string, limit: number, skipOver = Infinity): Promise<{ data: Buffer; more: boolean } | null> {
  const full = join(root.path, ...rel.split('/'));
  const rootStill = async () => {
    const now = await lstat(root.path, { bigint: true });
    return now.isDirectory() && sameId(now, root.id);
  };
  let fh: FileHandle | undefined;
  try {
    if (root.dir) fh = await openBeneath(root.dir, rel);
    else {
      if (!(await rootStill())) return null;
      // the last name not followed where the system allows it: a link in the file's place fails here (ELOOP)
      fh = await open(full, constants.O_RDONLY | NO_FOLLOW);
    }
    const st = await fh.stat({ bigint: true });
    if (!st.isFile() || st.size > BigInt(Math.min(skipOver, Number.MAX_SAFE_INTEGER))) return null;
    if (!root.dir) {
      const real = await realpath(full);
      if (!real.startsWith(root.path + sep)) return null;
      if (!sameId(await stat(real, { bigint: true }), st)) return null;
      if (!(await rootStill())) return null;
    }
    // only what is checked is read (one byte more tells a longer file): a huge file is not loaded whole
    const buf = Buffer.alloc(Math.min(Number(st.size), limit) + 1);
    let got = 0;
    for (let n = -1; got < buf.length && n !== 0; got += n) n = (await fh.read(buf, got, buf.length - got, got)).bytesRead;
    return { data: buf.subarray(0, Math.min(got, limit)), more: got > limit };
  } catch {
    return null;
  } finally {
    await fh?.close().catch(() => {});
  }
}

/** A file inside the folder, read as text if it is one and small enough; null otherwise. */
async function readInside(root: LintRoot, rel: string): Promise<string | null> {
  const got = await readInsideBytes(root, rel, MAX_FILE_BYTES, MAX_FILE_BYTES);
  if (!got) return null;
  const text = got.data.toString('utf8');
  return looksBinary(text) ? null : text;
}

/** Indexed skills like a local one (F4's words and matching, findSimilar's "similar" section), high risk left out. */
export function similarToLocal(store: Store, skill: { name: string; description: string | null; when_to_use: string | null; sha256?: string | null }, settings: Pick<Settings, 'weights' | 'minStars'>, max = 5): SimilarSkill[] {
  const keywords = skillKeywords(store, skill);
  if (!keywords.length) return [];
  const out: SimilarSkill[] = [];
  const seen = new Set<string>(skill.sha256 ? [skill.sha256] : []);
  for (const m of matchSkills(store, keywords, settings.weights)) {
    if (out.length >= max) break;
    const row = store.getSkill(m.item.id);
    if (!row || m.item.riskLevel === 'high') continue;
    if (row.skill_md_sha256) {
      if (seen.has(row.skill_md_sha256)) continue;
      seen.add(row.skill_md_sha256);
    }
    const starsOk = settings.minStars <= 0 || m.item.trust === 'official' || m.item.trust === 'partner' || (m.item.stars ?? -1) >= settings.minStars;
    if (!starsOk) continue;
    out.push({ id: m.item.id, name: m.item.name, description: m.item.description ?? null, riskLevel: m.item.riskLevel, installs: m.item.installs ?? null, stars: m.item.stars ?? null, matchedTerms: m.matchedTerms });
  }
  return out;
}

/**
 * Checks one skill folder (`dir`, an absolute path the caller has already allowed). Reads SKILL.md (up to the
 * index's 512KB) and up to SCAN_MAX_FILES other text files of up to 256KB, scripts first.
 */
export async function lintSkillFolder(dir: string, ctx: LintContext = {}): Promise<LintResult> {
  const realRoot = await realpath(dir);
  let rootDir: FileHandle | null = null;
  try {
    // The folder by identity, not by spelling (a case-sensitive volume can hold Twin and twin side by side). On Linux
    // the folder is held open from here on, and its identity is that of what was opened: a link put in its place by
    // now fails to open (ELOOP).
    let rootId: FileId;
    if (BENEATH) {
      rootDir = await open(realRoot, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW).catch(() => {
        throw new FolderMovedError();
      });
      rootId = await rootDir.stat({ bigint: true });
    } else rootId = await stat(realRoot, { bigint: true });
    if (ctx.expectRealPath != null) {
      const expected = await lstat(ctx.expectRealPath, { bigint: true }).catch(() => null);
      if (!expected?.isDirectory() || !sameId(expected, rootId)) throw new FolderMovedError();
    }
    const result = await lintAt(dir, { path: realRoot, id: rootId, dir: rootDir }, ctx);
    // Each file was checked as it was read (readInsideBytes). The folder too: should the path have led elsewhere
    // meanwhile, or realRoot itself have been put a link in its place, the file names may be another folder's.
    const [viaDir, atRoot] = await Promise.all([stat(dir, { bigint: true }).catch(() => null), lstat(realRoot, { bigint: true }).catch(() => null)]);
    if (!viaDir || !atRoot?.isDirectory() || !sameId(viaDir, rootId) || !sameId(atRoot, rootId)) throw new FolderMovedError();
    return result;
  } finally {
    await rootDir?.close().catch(() => {});
  }
}

async function lintAt(dir: string, root: LintRoot, ctx: LintContext): Promise<LintResult> {
  const folder = basename(dir);
  const problems: LintProblem[] = [];
  const add = (severity: LintSeverity, code: string, message: string, file?: string, line?: number | null) => problems.push({ severity, code, message, ...(file ? { file } : {}), ...(line != null ? { line } : {}) });

  let raw: string | null = null;
  // as the other files: only the folder's own plain file, up to the index's limit
  const md = await readInsideBytes(root, 'SKILL.md', RAW_MAX_BYTES);
  if (md) {
    raw = md.data.toString('utf8');
    if (md.more) add('warning', 'skillMdTooLarge', `SKILL.md가 512KB를 넘어 앞부분만 검사했습니다`, 'SKILL.md');
  }
  if (raw == null) {
    add('error', 'skillMdMissing', 'SKILL.md가 없습니다');
    return {
      ok: false,
      problems,
      path: dir,
      folder,
      name: folder,
      description: '',
      quality: [],
      risk: { level: 'low', flags: [], evidence: {} },
      files: { checked: 0, skipped: 0, listed: 0, findings: [] },
      tokens: { perTurn: 0, onUse: null },
      listing: { text: '', chars: 0, limit: LISTING_LIMIT, truncated: false, cut: 0 },
      skillsCli: { found: false, reason: 'nameOrDescription', folder },
      agents: { claudeOnlyFlags: [], claudeKeys: [] },
      similar: null,
    };
  }

  const meta = extractSkillMeta(raw, folder);
  const quality = qualityWarnings(meta, folder);
  for (const q of quality) add(QUALITY_TEXT[q][0], q, QUALITY_TEXT[q][1], 'SKILL.md');

  // the folder's other text files, as the install check reads them (scan.ts), scripts first
  // on Linux the names too come from the folder held open
  const files = await listFiles(root.dir ? `/proc/self/fd/${root.dir.fd}` : root.path);
  const text = files
    .filter((f) => f !== 'SKILL.md' && isTextPath(f))
    .sort((a, b) => Number(SCRIPT_EXT.test(b)) - Number(SCRIPT_EXT.test(a)) || a.localeCompare(b));
  const findings: LintResult['files']['findings'] = [];
  let checked = 0;
  let skipped = Math.max(0, text.length - SCAN_MAX_FILES);
  for (const rel of text.slice(0, SCAN_MAX_FILES)) {
    const body = await readInside(root, rel);
    if (body == null) {
      skipped++;
      continue;
    }
    checked++;
    const flags = textFileFlags(body, rel);
    if (flags.length) findings.push({ path: rel, flags, evidence: textEvidence(body, rel) });
  }
  if (skipped) add('info', 'filesSkipped', `텍스트 파일 ${skipped}개는 검사하지 않았습니다(256KB 초과, 50개 넘음, 링크, 바이너리)`);

  const input = { files, allowedTools: meta.allowedTools, body: meta.body, hasHooks: meta.hasHooks, raw, partial: meta.frontmatterTooLarge || Buffer.byteLength(raw) >= RAW_MAX_BYTES - 3 };
  const evidence = riskEvidence(input, { perFlag: 20 });
  const flags = [...new Set([...skillRiskFlags(input), ...findings.flatMap((f) => f.flags)])];
  const level = riskLevel(flags);
  const levelOf = (f: RiskFlag): LintSeverity => (INFO_FLAGS.has(f) ? 'info' : RISK_ORDER[riskLevel([f])] >= RISK_ORDER.high ? 'error' : 'warning');
  for (const f of flags) {
    const first = evidence[f]?.items[0];
    const inFile = first ? null : findings.find((x) => x.flags.includes(f));
    const where = first ?? inFile?.evidence.find((e) => e.flag === f);
    add(levelOf(f), f, RISK_TEXT[f] ?? f, where?.path ?? inFile?.path, where?.line ?? null);
  }
  // shell injection is high only with unlimited Bash: rate it by the level it brings
  if (level === 'high') for (const p of problems) if (p.code === 'shellInjection' || p.code === 'unscopedBash') p.severity = 'error';

  const listingText = (meta.description ?? '') + (meta.whenToUse ? `\n${meta.whenToUse}` : '');
  const chars = Array.from(listingText).length;
  const shown = chars > LISTING_LIMIT ? Array.from(listingText).slice(0, LISTING_LIMIT).join('') : listingText;

  const valid = genericValidator(raw);
  const internal = !!meta.nameFromFrontmatter && !!meta.descriptionFromFrontmatter && !valid;
  if (!valid) add('warning', internal ? 'internalSkill' : 'notFoundByCli', internal ? 'metadata.internal: true라 skills CLI가 목록에 보이지 않습니다' : 'frontmatter에 name과 description이 모두 있어야 skills CLI(npx skills add)가 찾습니다', 'SKILL.md');

  const cliFolder = skillFolderName(meta.name);
  if (valid && cliFolder !== folder.toLowerCase()) add('info', 'folderName', `skills CLI로 설치하면 폴더 이름이 ${cliFolder}이 됩니다`, 'SKILL.md');
  const claudeOnlyFlags = flags.filter((f) => CLAUDE_ONLY_FLAGS.has(f));
  if (claudeOnlyFlags.length) add('info', 'claudeOnly', `Claude Code에서만 뜻이 있는 설정이 있습니다(${claudeOnlyFlags.join(', ')}). 다른 에이전트는 무시하거나 다르게 다룰 수 있습니다(추측)`, 'SKILL.md');
  const claudeKeys = CLAUDE_KEYS.filter((k) => meta.frontmatter[k] != null);
  if (claudeKeys.length) add('info', 'claudeKeys', `Claude Code 전용 frontmatter 키: ${claudeKeys.join(', ')}`, 'SKILL.md');

  const order: Record<LintSeverity, number> = { error: 0, warning: 1, info: 2 };
  problems.sort((a, b) => order[a.severity] - order[b.severity]);
  const sha = createHash('sha256').update(raw.replace(/\r\n/g, '\n')).digest('hex');
  return {
    ok: !problems.some((p) => p.severity !== 'info'),
    problems,
    path: dir,
    folder,
    name: meta.name,
    description: meta.description,
    quality,
    risk: { level, flags, evidence },
    files: { checked, skipped, listed: files.length, findings },
    tokens: skillTokens(meta.name, meta.description, raw),
    listing: { text: shown, chars, limit: LISTING_LIMIT, truncated: chars > LISTING_LIMIT, cut: Math.max(0, chars - LISTING_LIMIT) },
    skillsCli: { found: !!valid, reason: valid ? null : internal ? 'internal' : 'nameOrDescription', folder: cliFolder },
    agents: { claudeOnlyFlags, claudeKeys },
    similar: ctx.store && ctx.settings ? similarToLocal(ctx.store, { name: meta.name, description: meta.description || null, when_to_use: meta.whenToUse, sha256: sha }, ctx.settings, ctx.similarMax ?? 5) : null,
  };
}
