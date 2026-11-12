// One entry point for a release, in the order it was done by hand up to 0.3.6 (docs/release.md):
//   node scripts/release.mjs bump <version>   package.json, package-lock.json (two places), CHANGELOG.md's date
//   (commit the three files)
//   node scripts/release.mjs build            the Windows zip (scripts/package-win.mjs), then the npm tarball (scripts/pack-npm.mjs)
//   git push origin main
//   node scripts/release.mjs deploy           Cloudflare Pages, then the old workers.dev Worker, then `verify`
//   node scripts/release.mjs verify           read-only: both addresses serve this version, signed, with its zip
//   npm publish ./release/<file>.tgz --access public
// Committing, pushing and publishing to npm stay deliberate steps: this script never does them, it only says when
// they come. --dry-run prints what would run and runs nothing; --root <dir> works on another copy of the repo (the
// tests bump a temporary one). Everything is exported for server/test/release.test.ts, which passes its own
// command runner and fetch.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { releaseMessage, signedNotes, verifyText } from '../server/src/release.ts';

const HERE = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Where the landing page is served, and with it the update: download/meta.json and download/skill-finder-win.zip.
 * Both get the same site/public, in this order; `wrangler` is what follows `npx wrangler@4` in site/.
 */
export const SITES = [
  // the Pages project seojin-skill-finder: the address 0.3.5 and later look at (DECISIONS D#6a6e)
  { name: '소개 페이지(Pages)', base: 'https://seojin-skill-finder.pages.dev/', config: 'wrangler.jsonc', wrangler: ['pages', 'deploy'] },
  // the Worker skill-finder: where installs of 0.3.4 and earlier look for updates
  { name: '옛 업데이트 주소(Worker)', base: 'https://skill-finder.a01075011775.workers.dev/', config: 'wrangler.old-worker.jsonc', wrangler: ['deploy', '--config', 'wrangler.old-worker.jsonc'] },
];
const siteUrls = (site) => [`${site.base}download/meta.json`, `${site.base}download/skill-finder-win.zip`];
/** What `npm pack` names the tarball of @seojin08/skill-finder (scripts/pack-npm.mjs). */
const tarball = (version) => `seojin08-skill-finder-${version}.tgz`;

/** A stop the user can act on: shown without a stack. `code` is the exit code (2: the command line was wrong). */
export class Stop extends Error {
  constructor(message, code = 1) {
    super(message);
    this.code = code;
  }
}

// ---------- text in, text out (no files, no processes) ----------

// X.Y.Z in numbers without leading zeros: what npm takes and what the app and the launcher read (update.ts,
// SkillFinder.cs ReadVersion). No "v", no pre-release tag.
const VERSION_RE = /^(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,5})$/;
export const isVersion = (v) => typeof v === 'string' && VERSION_RE.test(v);

/** 1, 0 or -1 for a after, same as or before b, by number ("0.10.0" is after "0.9.9"). */
export function compareVersions(a, b) {
  const [x, y] = [a, b].map((v) => v.split('.').map(Number));
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i] ? 1 : -1;
  return 0;
}

/** Today as YYYY-MM-DD in local time (toISOString is UTC: before 09:00 in Korea that is still yesterday). */
export const localDate = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** YYYY-MM-DD that is a day of the calendar (not 2026-02-30). */
export function isDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** meta.json takes this many notes of this many characters (server/src/release.ts signedNotes). */
const MAX_NOTES = 30;
const MAX_NOTE_CHARS = 300;

/**
 * A version's section of CHANGELOG.md: the heading's line (0-based) and the notes, found the way `npm run package`
 * finds them for meta.json (package-win.mjs changelogNotes: "- " lines from "## <version>" to the next "## "),
 * but whole: that script cuts at 30 notes and 300 characters.
 */
export function changelogSection(text, version) {
  const lines = text.split(/\r?\n/);
  const line = lines.findIndex((l) => l === `## ${version}` || l.startsWith(`## ${version} `));
  if (line < 0) return null;
  const rest = lines.slice(line + 1);
  const end = rest.findIndex((l) => l.startsWith('## '));
  const notes = (end < 0 ? rest : rest.slice(0, end)).filter((l) => l.startsWith('- ')).map((l) => l.slice(2).trim());
  return { line, heading: lines[line], notes };
}

/** Why a version's notes would not reach the app as written: none, or more or longer than meta.json takes. */
export function notesProblems(notes) {
  const out = [];
  if (!notes.length) out.push('"- "로 시작하는 줄이 없습니다');
  if (notes.length > MAX_NOTES) out.push(`항목이 ${notes.length}줄입니다. ${MAX_NOTES}줄까지만 들어갑니다`);
  notes.forEach((note, i) => {
    if (!note) out.push(`${i + 1}번째 항목이 비어 있습니다`);
    if (note.length > MAX_NOTE_CHARS) out.push(`${i + 1}번째 항목이 ${note.length}자입니다. ${MAX_NOTE_CHARS}자까지만 들어갑니다`);
  });
  return out;
}

/** CHANGELOG.md with the version's heading dated: "## 0.3.7" or "## 0.3.7 (anything)" becomes "## 0.3.7 (date)". */
export function dateChangelog(text, version, date) {
  const section = changelogSection(text, version);
  if (!section) throw new Stop(`CHANGELOG.md에 "## ${version}" 절이 없습니다`);
  const after = section.heading.slice(`## ${version}`.length);
  if (after.trim() && !/^\s+\([^()]*\)\s*$/.test(after)) {
    throw new Stop(`CHANGELOG.md의 제목 "${section.heading}"에 날짜를 넣을 수 없습니다. "## ${version}" 또는 "## ${version} (날짜)" 모양으로 고치세요`);
  }
  // line by line with the separators kept, so a CRLF file stays one
  const parts = text.split(/(\r?\n)/);
  parts[section.line * 2] = `## ${version} (${date})`;
  return parts.join('');
}

/**
 * JSON `text` with the string at `path` (object keys) replaced and every other byte as it was. JSON.stringify
 * would rewrite package.json's one-line arrays, the lock's 7,500 lines and the CRLF of both. `label` names the
 * file in messages.
 */
export function setJsonString(text, path, value, label = 'JSON') {
  const where = path.map((key) => key || '""').join('.');
  const parse = (t) => JSON.parse(t.charCodeAt(0) === 0xfeff ? t.slice(1) : t);
  let want;
  try {
    want = parse(text);
  } catch {
    throw new Stop(`${label}: JSON이 아닙니다`);
  }
  const holder = path.slice(0, -1).reduce((o, key) => (o && typeof o === 'object' && !Array.isArray(o) ? o[key] : undefined), want);
  if (!holder || typeof holder !== 'object' || Array.isArray(holder) || typeof holder[path.at(-1)] !== 'string') throw new Stop(`${label}에 ${where} 문자열이 없습니다`);
  holder[path.at(-1)] = value;

  // Where that string is in the text: a walk that knows only where values begin and end (the text is valid JSON).
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  const lost = (what) => new Error(`${label}: ${i}번째 글자에서 ${what}`);
  const space = () => {
    while (i < text.length && ' \t\r\n'.includes(text[i])) i++;
  };
  /** At an opening quote: moves past the string and returns its span, quotes included. */
  const string = () => {
    if (text[i] !== '"') throw lost('문자열이 와야 함');
    const start = i++;
    while (i < text.length && text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
    if (i >= text.length) throw lost('문자열이 끝나지 않음');
    return [start, ++i];
  };
  let found = null;
  /** Moves past one value. `rest`: the keys still to follow from here to the wanted string, or null off the path. */
  const skipValue = (rest) => {
    space();
    const c = text[i];
    if (c === '{' || c === '[') {
      const close = c === '{' ? '}' : ']';
      i++;
      space();
      if (text[i] === close) return void i++;
      for (;;) {
        let next = null;
        if (c === '{') {
          space();
          const [start, end] = string();
          const key = JSON.parse(text.slice(start, end));
          space();
          if (text[i++] !== ':') throw lost('":"이 와야 함');
          if (rest?.length && rest[0] === key) next = rest.slice(1);
        }
        skipValue(next);
        space();
        const sep = text[i++];
        if (sep === close) return;
        if (sep !== ',') throw lost(`"," 또는 "${close}"이 와야 함`);
      }
    }
    if (c === '"') {
      const span = string();
      // the last one counts when a key is repeated, as for JSON.parse
      if (rest?.length === 0) found = span;
      return;
    }
    // a number, true, false or null
    const start = i;
    while (i < text.length && !',]} \t\r\n'.includes(text[i])) i++;
    if (i === start) throw lost('값이 와야 함');
  };
  skipValue(path);
  const out = found ? text.slice(0, found[0]) + JSON.stringify(value) + text.slice(found[1]) : null;
  // JSON.parse has the last word on where the value went: only that one string may differ
  if (out === null || !isDeepStrictEqual(parse(out), want)) throw new Error(`${label}: ${where} 값을 바꾼 결과가 예상과 다릅니다`);
  return out;
}

/**
 * The three files of a version bump with `version` in them: package.json, package-lock.json (its own version and
 * the root package's) and CHANGELOG.md (the version's heading dated). Stops, changing nothing, when the version is
 * not above the current one or its notes are missing or would be cut.
 */
export function bumpTexts({ pkg, lock, changelog }, version, date) {
  if (!isVersion(version)) throw new Stop(`버전은 0.3.7처럼 숫자 세 개여야 합니다 (v나 -beta 없이): ${version ?? '(없음)'}`);
  if (!isDate(date)) throw new Stop(`날짜는 2026-11-10 모양이어야 합니다: ${date}`);
  let from;
  try {
    from = JSON.parse(pkg).version;
  } catch {
    throw new Stop('package.json: JSON이 아닙니다');
  }
  if (!isVersion(from)) throw new Stop(`package.json의 version을 읽지 못했습니다: ${from}`);
  if (compareVersions(version, from) <= 0) throw new Stop(`새 버전(${version})은 지금 버전(${from})보다 높아야 합니다`);

  const section = changelogSection(changelog, version);
  if (!section) throw new Stop(`CHANGELOG.md에 "## ${version}" 절이 없습니다. 맨 위에 그 제목과 "- "로 시작하는 줄을 쓴 뒤 다시 실행하세요`);
  const problems = notesProblems(section.notes);
  if (problems.length) throw new Stop(`CHANGELOG.md의 ${version} 절을 고친 뒤 다시 실행하세요 (앱의 "새 버전" 창에 그대로 나오는 글입니다):\n${problems.map((p) => `  - ${p}`).join('\n')}`);

  return {
    from,
    notes: section.notes,
    texts: {
      pkg: setJsonString(pkg, ['version'], version, 'package.json'),
      lock: setJsonString(setJsonString(lock, ['version'], version, 'package-lock.json'), ['packages', '', 'version'], version, 'package-lock.json'),
      changelog: dateChangelog(changelog, version, date),
    },
  };
}

/**
 * Why a download page's meta.json would not be taken as `version` by the app and the launcher, or null: the
 * version, the shape, the release signature and the signed notes (as server/src/update.ts reads them).
 */
export function metaProblem(meta, version, publicKey) {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return 'meta.json이 JSON 객체가 아닙니다';
  const { version: found, bytes, sha256 } = meta;
  if (found !== version) return `버전이 ${typeof found === 'string' ? found : '없음'}입니다 (기대: ${version})`;
  if (!Number.isInteger(bytes) || bytes <= 0 || typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256)) return 'bytes·sha256이 없거나 모양이 다릅니다';
  if (!verifyText(releaseMessage({ version, bytes, sha256 }), meta.signature, publicKey)) return '서명이 맞지 않습니다 (설치된 앱이 이 업데이트를 받지 않습니다)';
  if (!signedNotes(meta, version, publicKey).length) return '변경 기록이 없거나 그 서명이 맞지 않습니다 (앱에 변경 기록이 보이지 않습니다)';
  return null;
}

// ---------- files, git, commands ----------

const readText = (root, name) => {
  const path = join(root, name);
  if (!existsSync(path)) throw new Stop(`${name} 파일이 없습니다: ${path}`);
  return readFileSync(path, 'utf8');
};

function currentVersion(root) {
  let version;
  try {
    version = JSON.parse(readText(root, 'package.json')).version;
  } catch (e) {
    if (e instanceof Stop) throw e;
  }
  if (!isVersion(version)) throw new Stop(`package.json의 version을 읽지 못했습니다: ${join(root, 'package.json')}`);
  return version;
}

const mb = (bytes) => `${(bytes / 1048576).toFixed(1)}MB`;
const sha256Of = (buffer) => createHash('sha256').update(buffer).digest('hex');
const reason = (e) => (e?.name === 'TimeoutError' ? '시간 초과' : e?.status != null ? `종료 코드 ${e.status}` : String(e?.cause?.code ?? e?.code ?? e?.message ?? e));
const wait = (ms) => new Promise((done) => setTimeout(done, ms));

/** One check's result: `problem` is null when it passed. */
const check = (what, problem, detail = '') => ({ what, problem, detail });
/** Prints one line per check and returns how many failed. */
function report(checks, log) {
  for (const c of checks) log(c.problem ? `  ✖ ${c.what}: ${c.problem}` : `  ✔ ${c.what}${c.detail ? `: ${c.detail}` : ''}`);
  return checks.filter((c) => c.problem).length;
}

/** A step as the user would type it at the repo root. */
const shown = (step, root) => {
  const dir = relative(root, step.cwd);
  return `${dir ? `cd ${dir} && ` : ''}${step.tool} ${step.args.join(' ')}`;
};

/**
 * Runs a step { cwd, tool: 'node' | 'npx', args } with its output on this terminal; throws when it fails.
 * Without a shell: the repo path has spaces, which a .cmd shim would split, so npx is node running npm's own
 * npx-cli.js (as scripts/pack-npm.mjs does for npm).
 */
export function runStep(step) {
  // node's test runner sets NODE_TEST_CONTEXT for the files it runs (and they pass it on to what they start), and
  // server/test/bun-setup.ts sets SKILL_FINDER_TESTING under bun test: a test that forgot to pass its own runner
  // must not start a real build, let alone deploy
  if (process.env.NODE_TEST_CONTEXT || process.env.SKILL_FINDER_TESTING) throw new Stop(`테스트 안에서는 실제 명령을 실행하지 않습니다: ${step.tool} ${step.args.join(' ')}`);
  let file = process.execPath;
  let args = step.args;
  if (step.tool === 'npx') {
    const bin = dirname(process.execPath);
    const cli = [join(bin, 'node_modules', 'npm', 'bin', 'npx-cli.js'), join(bin, '..', 'lib', 'node_modules', 'npm', 'bin', 'npx-cli.js')].find((p) => existsSync(p));
    if (cli) args = [cli, ...args];
    else if (process.platform === 'win32') throw new Stop(`npx를 찾지 못했습니다 (${bin} 아래에 node_modules\\npm이 없습니다)`);
    else file = 'npx';
  }
  execFileSync(file, args, { cwd: step.cwd, stdio: 'inherit' });
}

/** The signing key `npm run package` uses (scripts/package-win.mjs): outside the repo, on the publisher's PC. */
const signingKeyPath = () => process.env.SKILL_FINDER_SIGNING_KEY || join(homedir(), '.skill-finder-release', 'update-signing-key.pem');

/** Where `build` notes the commit its zip was made from; release/ is neither committed nor published. */
const builtFromPath = (root) => join(root, 'release', 'built-from.json');
const gitOut = (root, ...args) => execFileSync('git', ['--no-optional-locks', ...args], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).replace(/\r?\n$/, '');

/** After the zip step: the commit that was checked out, the zip it made (its hash, as meta.json has it), and --dirty. */
function noteBuiltFrom(root, version, dirty) {
  const meta = JSON.parse(readFileSync(join(root, 'site', 'public', 'download', 'meta.json'), 'utf8'));
  mkdirSync(dirname(builtFromPath(root)), { recursive: true });
  writeFileSync(builtFromPath(root), `${JSON.stringify({ version, commit: gitOut(root, 'rev-parse', 'HEAD'), sha256: meta.sha256, dirty }, null, 2)}\n`);
}

/**
 * The zip about to go up was made from the commit that is checked out (review 2026-11-11): the other checks pass
 * just as well when a commit was added after `build`, and the zip would then be a commit behind what was pushed.
 */
function builtFromCheck(root) {
  const what = 'zip을 만든 커밋';
  const again = 'node scripts/release.mjs build를 다시 실행하세요';
  let note;
  let meta;
  let head;
  try {
    note = JSON.parse(readFileSync(builtFromPath(root), 'utf8'));
  } catch {
    return check(what, `빌드 기록(release/built-from.json)이 없습니다. ${again}`);
  }
  try {
    meta = JSON.parse(readFileSync(join(root, 'site', 'public', 'download', 'meta.json'), 'utf8'));
    head = gitOut(root, 'rev-parse', 'HEAD');
  } catch {
    return check(what, `지금 커밋이나 meta.json을 읽지 못했습니다. ${again}`);
  }
  if (typeof note?.commit !== 'string' || note.sha256 !== meta?.sha256) return check(what, `빌드 기록이 지금 zip의 것이 아닙니다. ${again}`);
  if (note.dirty) return check(what, `zip을 --dirty로 만들었습니다 (커밋하지 않은 변경이 들어갔을 수 있음). 커밋한 뒤 ${again}`);
  if (note.commit !== head) return check(what, `zip은 ${note.commit.slice(0, 7)}에서 만들었는데 지금은 ${head.slice(0, 7)}입니다 (build 뒤에 커밋이 더해짐). ${again}`);
  return check(what, null, head.slice(0, 7));
}

/** The built download in site/public/download: this version's signed meta.json and the zip it describes. */
function downloadCheck(root, version, publicKey) {
  const what = '올릴 zip (site/public/download)';
  const dir = join(root, 'site', 'public', 'download');
  const again = 'node scripts/release.mjs build로 만드세요';
  if (!existsSync(join(dir, 'meta.json'))) return check(what, `meta.json이 없습니다. ${again}`);
  let meta;
  try {
    meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'));
  } catch {
    return check(what, `meta.json이 JSON이 아닙니다. ${again}`);
  }
  if (isVersion(meta?.version) && meta.version !== version) return check(what, `zip은 ${meta.version}인데 package.json은 ${version}입니다. ${again}`);
  const problem = metaProblem(meta, version, publicKey);
  if (problem) return check(what, `meta.json: ${problem}. ${again}`);
  if (!existsSync(join(dir, 'skill-finder-win.zip'))) return check(what, `skill-finder-win.zip이 없습니다. ${again}`);
  const zip = readFileSync(join(dir, 'skill-finder-win.zip'));
  if (zip.length !== meta.bytes || sha256Of(zip) !== meta.sha256) return check(what, `skill-finder-win.zip이 meta.json의 크기·SHA-256과 다릅니다. ${again}`);
  return check(what, null, `${version}, 서명 맞음, ${mb(zip.length)}`);
}

/**
 * Nothing uncommitted, and main is what origin/main is: what gets deployed is what was pushed. `askOrigin` (a real
 * `deploy`) asks the remote itself for its main, since another PC may have pushed after the last fetch here
 * (review 2026-11-11); otherwise, and without a remote called origin, the local tracking ref is read.
 */
function gitChecks(root, askOrigin = false) {
  // --no-optional-locks: `status` only looks, it does not take the index lock to save what it saw
  const git = (...args) => execFileSync('git', ['--no-optional-locks', ...args], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).replace(/\r?\n$/, '');
  try {
    // empty only at the top of a work tree: a folder inside some other repository would answer for that one
    if (git('rev-parse', '--show-prefix') !== '') throw new Error('not the top');
    git('rev-parse', '--verify', '--quiet', 'HEAD');
  } catch (e) {
    return [check('git', e?.code === 'ENOENT' ? 'git을 실행하지 못했습니다 (PATH에 없음)' : `커밋이 있는 git 저장소의 맨 위 폴더가 아닙니다: ${root}`)];
  }

  // Untracked files count too: one inside site/public would be published with the rest. -z: "XY path" entries
  // ended by NUL with the names as they are (no quoting of spaces or Korean); a rename's old name follows it.
  const entries = git('status', '--porcelain', '-z', '--untracked-files=normal').split('\0').filter(Boolean);
  const dirty = [];
  for (let i = 0; i < entries.length; i++) {
    dirty.push(entries[i].slice(3));
    if (/[RC]/.test(entries[i].slice(0, 2))) i++;
  }
  const clean = dirty.length
    ? check('커밋 상태', `커밋하지 않은 변경 ${dirty.length}개 (${dirty.slice(0, 5).join(', ')}${dirty.length > 5 ? ', …' : ''}). 커밋하거나 치운 뒤 다시 실행하세요`)
    : check('커밋 상태', null, '커밋하지 않은 변경 없음');

  const what = 'push 상태';
  const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
  const head = git('rev-parse', 'HEAD');
  let remote = null;
  let asked = false;
  let askProblem = null;
  if (askOrigin) {
    let hasOrigin = true;
    try {
      git('remote', 'get-url', 'origin');
    } catch {
      hasOrigin = false;
    }
    if (hasOrigin) {
      try {
        // read-only: the remote's own answer, no local ref is moved
        remote = git('ls-remote', 'origin', 'refs/heads/main').split(/\s+/)[0] || null;
        asked = true;
      } catch {
        askProblem = 'origin에 main의 커밋을 물어보지 못했습니다 (네트워크나 인증). 잠시 뒤 다시 실행하세요';
      }
    }
  }
  if (!asked && !askProblem) {
    // the tracking ref as the last push or fetch left it: nothing is asked of the network here
    try {
      remote = git('rev-parse', '--verify', '--quiet', 'refs/remotes/origin/main');
    } catch {
      // no origin/main
    }
  }
  let pushed;
  // wrangler takes the git branch for the Pages branch: anything but the production branch becomes a preview
  if (branch !== 'main') pushed = check(what, `지금 브랜치는 ${branch}입니다. main에서 배포하세요 (다른 브랜치에서 올리면 Pages가 미리보기로만 올립니다)`);
  else if (askProblem) pushed = check(what, askProblem);
  else if (!remote) pushed = check(what, 'origin/main이 없습니다. git push origin main 뒤에 다시 실행하세요');
  else if (head !== remote) {
    let parts;
    try {
      const [ahead, behind] = git('rev-list', '--left-right', '--count', `HEAD...${remote}`).split(/\s+/).map(Number);
      parts = [ahead ? `push하지 않은 커밋 ${ahead}개 (git push origin main)` : '', behind ? `origin/main에만 있는 커밋 ${behind}개 (git pull 뒤 build부터 다시)` : ''].filter(Boolean);
    } catch {
      // origin's commit is not in this repository yet: someone pushed from elsewhere
      parts = [`origin의 main은 이 PC에 없는 커밋 ${remote.slice(0, 7)}입니다 (git pull 뒤 build부터 다시)`];
    }
    pushed = check(what, `main이 origin/main과 다릅니다: ${parts.join(', ')}`);
  } else pushed = check(what, null, `main = origin/main (${head.slice(0, 7)}${asked ? ', origin에 확인' : ''})`);
  return [clean, pushed];
}

/** Everything `deploy` wants to be true before it uploads anything. */
export function deployChecks(root, version, sites = SITES, publicKey, askOrigin = false) {
  const missing = sites.map((s) => s.config).filter((name) => !existsSync(join(root, 'site', name)));
  const configs = missing.length ? check('배포 설정', `site/에 ${missing.join(', ')} 파일이 없습니다`) : check('배포 설정', null, sites.map((s) => `site/${s.config}`).join(' · '));
  const download = downloadCheck(root, version, publicKey);
  // which commit made the zip only matters once there is a good zip: one "build it" is enough
  return [configs, download, ...(download.problem ? [] : [builtFromCheck(root)]), ...gitChecks(root, askOrigin)];
}

/** One address: its meta.json is this version, signed, and the zip it serves is the one meta.json describes. */
async function checkSite(site, version, fetchImpl, publicKey) {
  const [metaUrl, zipUrl] = siteUrls(site);
  let meta;
  try {
    const res = await fetchImpl(metaUrl, { signal: AbortSignal.timeout(20_000) });
    if (res.status !== 200) return [check(metaUrl, `응답 ${res.status}`)];
    const text = await res.text();
    try {
      meta = JSON.parse(text);
    } catch {
      // a missing file can come back as the landing page itself, with 200
      return [check(metaUrl, 'JSON이 아닙니다')];
    }
  } catch (e) {
    return [check(metaUrl, `받지 못했습니다 (${reason(e)})`)];
  }
  const problem = metaProblem(meta, version, publicKey);
  // the zip (over 10MB) is only worth fetching once meta.json is right
  if (problem) return [check(metaUrl, problem)];
  const out = [check(metaUrl, null, `${version}, 서명 맞음, 변경 기록 ${meta.notes.length}줄`)];
  try {
    const res = await fetchImpl(zipUrl, { signal: AbortSignal.timeout(300_000) });
    if (res.status !== 200) return [...out, check(zipUrl, `응답 ${res.status}`)];
    const zip = Buffer.from(await res.arrayBuffer());
    const same = zip.length === meta.bytes && sha256Of(zip) === meta.sha256;
    out.push(same ? check(zipUrl, null, `200, ${mb(zip.length)}, SHA-256이 meta.json과 같음`) : check(zipUrl, `meta.json이 말하는 파일이 아닙니다 (받은 것 ${zip.length}바이트, meta.json ${meta.bytes}바이트)`));
  } catch (e) {
    out.push(check(zipUrl, `받지 못했습니다 (${reason(e)})`));
  }
  return out;
}

/** The one step left to the user: this script never publishes to npm. */
function publishHint(root, version, log) {
  log('\n남은 일: npm에 올리기 (직접 합니다. 이미 올렸으면 끝입니다)');
  log(`  npm publish ./release/${tarball(version)} --access public`);
  log('  npm login 세션은 2시간입니다. 401이나 404가 나오면 npm login을 다시 한 뒤 실행하세요.');
  if (!existsSync(join(root, 'release', tarball(version)))) log(`  release/ 폴더에 ${tarball(version)} 파일이 지금 없습니다. node scripts/pack-npm.mjs로 만듭니다.`);
}

// ---------- commands ----------

/** `bump <version>`: writes the three files (not with --dry-run) and says what comes next. Never commits. */
export function bump({ root = HERE, version, date = localDate(), dryRun = false, log = console.log }) {
  const names = { pkg: 'package.json', lock: 'package-lock.json', changelog: 'CHANGELOG.md' };
  const before = Object.fromEntries(Object.entries(names).map(([key, name]) => [key, readText(root, name)]));
  // everything is worked out before the first write: a stop leaves all three files as they were
  const { from, notes, texts } = bumpTexts(before, version, date);
  // package.json last: it is what "the current version" is read from, so a write that failed halfway can be run again
  if (!dryRun) for (const key of ['changelog', 'lock', 'pkg']) writeFileSync(join(root, names[key]), texts[key]);
  log(`${from} → ${version} (${date}), 변경 기록 ${notes.length}줄`);
  log(dryRun ? '  --dry-run: 파일은 고치지 않았습니다' : `  고침: ${names.pkg} · ${names.lock}(두 곳) · ${names.changelog}(제목의 날짜)`);
  log('\n다음 순서:');
  log('  1. 세 파일을 커밋합니다 (zip은 커밋된 내용으로 만듭니다)');
  log(`       git add ${Object.values(names).join(' ')}`);
  log(`       git commit -m "${version}: …"`);
  log('  2. node scripts/release.mjs build');
  log('  3. git push origin main');
  log('  4. node scripts/release.mjs deploy');
  log(`  5. npm publish ./release/${tarball(version)} --access public`);
}

/**
 * `build`: the Windows zip with its signed meta.json, then the npm tarball, by the existing scripts. The order
 * matters: package-win.mjs empties release/ first, which would take the tarball with it.
 */
export function build({ root = HERE, dryRun = false, dirty = false, sameVersion = false, signingKey = signingKeyPath(), run = runStep, log = console.log }) {
  const version = currentVersion(root);
  const flags = [...(dirty ? ['--dirty'] : []), ...(sameVersion ? ['--same-version'] : [])];
  const steps = [
    { title: 'Windows zip과 서명된 meta.json (npm run package)', cwd: root, tool: 'node', args: ['scripts/package-win.mjs', ...flags] },
    { title: 'npm 패키지', cwd: root, tool: 'node', args: ['scripts/pack-npm.mjs'] },
  ];

  // what package-win.mjs only finds out at its last step, after the tests, the installs and the launcher
  log(`\n▶ 만들기 전 확인 (${version})`);
  const section = changelogSection(readText(root, 'CHANGELOG.md'), version);
  const problems = section ? notesProblems(section.notes) : [`"## ${version}" 절이 없습니다`];
  const failed = report(
    [
      problems.length ? check('CHANGELOG.md', `${problems.join(', ')}. 고친 뒤 다시 실행하세요`) : check('CHANGELOG.md', null, `${version} 변경 기록 ${section.notes.length}줄`),
      existsSync(signingKey) ? check('업데이트 서명 키', null, '있음') : check('업데이트 서명 키', `없습니다: ${signingKey} (docs/release.md의 준비물)`),
    ],
    log,
  );
  if (failed && !dryRun) throw new Stop(`만들기 전 확인 ${failed}개가 통과하지 못해 아무것도 만들지 않았습니다`);

  for (const [i, step] of steps.entries()) {
    log(`\n▶ ${step.title}${dryRun ? ' (--dry-run: 실행하지 않음)' : ''}`);
    log(`  ${shown(step, root)}`);
    if (dryRun) continue;
    try {
      run(step);
      if (i === 0) {
        try {
          noteBuiltFrom(root, version, dirty);
        } catch (e) {
          log(`  (zip을 만든 커밋을 기록하지 못했습니다: ${reason(e)}. deploy가 "zip을 만든 커밋"에서 멈추면 build를 다시 실행하세요)`);
        }
      }
    } catch (e) {
      if (e instanceof Stop) throw e;
      // building again would stop at "this version is already on the page": the zip of this run is in place
      throw new Stop(i === 0 ? `zip을 만들지 못했습니다 (${reason(e)}). 위 출력을 보고 고친 뒤 다시 실행하세요` : `npm 패키지를 만들지 못했습니다 (${reason(e)}). zip은 만들어졌으니, 고친 뒤 node scripts/pack-npm.mjs만 다시 실행하세요`);
    }
  }

  if (failed) throw new Stop(`--dry-run: 만들기 전 확인 ${failed}개가 통과하지 못했습니다. 실제 실행은 여기서 멈추고 아무것도 만들지 않습니다`);
  log('\n다음 순서:');
  log('  1. git push origin main');
  log('  2. node scripts/release.mjs deploy');
  log(`  3. npm publish ./release/${tarball(version)} --access public`);
}

/**
 * `verify`: each address serves this version's meta.json with a good signature and the zip it describes. GET only.
 * `attempts` above 1 asks again after `waitMs` (right after a deploy the old files can still answer for a moment).
 */
export async function verify({ root = HERE, version, sites = SITES, fetch: fetchImpl = globalThis.fetch, publicKey, log = console.log, attempts = 1, waitMs = 5000, sleep = wait }) {
  version ??= currentVersion(root);
  log(`\n▶ 주소 ${sites.length}곳이 ${version} 버전을 주는지 확인`);
  const results = sites.map(() => null);
  for (let attempt = 1; ; attempt++) {
    // an address that passed is not asked again: that would be its whole zip once more
    await Promise.all(sites.map(async (site, i) => (results[i] = results[i]?.every((c) => !c.problem) ? results[i] : await checkSite(site, version, fetchImpl, publicKey))));
    const failed = report(results.flat(), log);
    if (!failed) return;
    if (attempt >= attempts) throw new Stop(`주소 확인 ${failed}개가 통과하지 못했습니다`);
    log(`  ${Math.round(waitMs / 1000)}초 뒤 다시 확인합니다 (${attempt}/${attempts})`);
    await sleep(waitMs);
  }
}

/**
 * `deploy`: after the checks, site/public goes to each address in turn (Pages, then the old Worker) and both are
 * verified. With --dry-run the checks still run (they only read) but nothing is uploaded or fetched.
 */
export async function deploy({ root = HERE, dryRun = false, sites = SITES, run = runStep, fetch: fetchImpl = globalThis.fetch, publicKey, log = console.log, attempts = 6, waitMs = 5000, sleep = wait }) {
  const version = currentVersion(root);
  log(`\n▶ 배포 전 확인 (${version})`);
  // a real deploy also asks origin for its main; --dry-run asks nothing of the network
  const failed = report(deployChecks(root, version, sites, publicKey, !dryRun), log);
  if (failed && !dryRun) throw new Stop(`배포 전 확인 ${failed}개가 통과하지 못해 아무것도 올리지 않았습니다`);

  const done = [];
  for (const site of sites) {
    // --yes answers npx's own "install wrangler?" so a run without a terminal does not wait; the name is fixed here
    const step = { title: site.name, cwd: join(root, 'site'), tool: 'npx', args: ['--yes', 'wrangler@4', ...site.wrangler] };
    log(`\n▶ ${site.name} 올리기${dryRun ? ' (--dry-run: 실행하지 않음)' : ''}`);
    log(`  ${shown(step, root)}`);
    if (dryRun) continue;
    try {
      run(step);
    } catch (e) {
      if (e instanceof Stop) throw e;
      const state = done.length ? `${done.join(', ')}에는 이미 올라갔습니다` : '아무것도 올라가지 않았습니다';
      throw new Stop(`${site.name}에 올리지 못했습니다 (${reason(e)}). ${state}. 고친 뒤 deploy를 다시 실행하세요 (같은 파일을 다시 올려도 됩니다)`);
    }
    done.push(site.name);
  }

  if (dryRun) {
    log('\n▶ 올린 뒤 확인할 주소 (--dry-run: 받지 않음)');
    for (const url of sites.flatMap(siteUrls)) log(`  ${url}`);
  } else {
    try {
      await verify({ root, version, sites, fetch: fetchImpl, publicKey, log, attempts, waitMs, sleep });
    } catch (e) {
      if (!(e instanceof Stop)) throw e;
      throw new Stop(`${e.message}. 올리기는 끝났습니다. 잠시 뒤 node scripts/release.mjs verify로 다시 확인하세요`);
    }
  }
  publishHint(root, version, log);
  if (failed) throw new Stop(`--dry-run: 배포 전 확인 ${failed}개가 통과하지 못했습니다. 실제 실행은 여기서 멈추고 아무것도 올리지 않습니다`);
}

// ---------- command line ----------

const USAGE = `사용법: node scripts/release.mjs <명령> [옵션]

  bump <버전> [--date YYYY-MM-DD]    package.json, package-lock.json, CHANGELOG.md 제목의 날짜를 새 버전으로 (커밋은 하지 않음)
  build [--dirty] [--same-version]   Windows zip(npm run package)을 만든 뒤 npm 패키지(scripts/pack-npm.mjs)
  deploy                             소개 페이지(Pages)와 옛 Worker에 올리고 두 주소를 확인
  verify                             두 주소의 download/meta.json과 zip이 지금 버전인지 확인 (읽기만)

  --dry-run       실행할 명령만 보여 주고 아무것도 고치거나 올리지 않음 (bump, build, deploy)
  --root <폴더>   이 저장소 대신 다른 사본에서

순서: bump → 커밋 → build → git push origin main → deploy → npm publish (docs/release.md)`;

/** Which options each command takes, and how many words after it. */
const COMMANDS = {
  bump: { options: ['date', 'dryRun'], words: 1 },
  build: { options: ['dirty', 'sameVersion', 'dryRun'], words: 0 },
  deploy: { options: ['dryRun'], words: 0 },
  verify: { options: [], words: 0 },
};
const FLAGS = { '--dry-run': 'dryRun', '--dirty': 'dirty', '--same-version': 'sameVersion', '--help': 'help', '-h': 'help' };
const VALUES = { '--root': 'root', '--date': 'date' };
/** dryRun → "--dry-run", for messages. */
const WRITTEN = Object.fromEntries(Object.entries({ ...FLAGS, ...VALUES }).map(([written, key]) => [key, written]));

function parseArgs(argv) {
  const opts = { words: [] };
  for (let i = 0; i < argv.length; i++) {
    const eq = argv[i].startsWith('--') ? argv[i].indexOf('=') : -1;
    const [name, inline] = eq < 0 ? [argv[i]] : [argv[i].slice(0, eq), argv[i].slice(eq + 1)];
    if (Object.hasOwn(VALUES, name)) {
      const value = inline ?? argv[++i];
      if (!value || value.startsWith('-')) throw new Stop(`${name}에 값이 없습니다`, 2);
      opts[VALUES[name]] = value;
    } else if (Object.hasOwn(FLAGS, name) && inline === undefined) opts[FLAGS[name]] = true;
    else if (name.startsWith('-')) throw new Stop(`모르는 옵션: ${argv[i]}`, 2);
    else opts.words.push(name);
  }
  return opts;
}

/**
 * Runs one command line and returns the exit code: 0, 1 for a stop, 2 for a wrong command line. `deps` replaces
 * what touches the world (run, fetch, publicKey, sleep, signingKey, log, error): the tests pass their own.
 */
export async function main(argv, deps = {}) {
  const log = deps.log ?? console.log;
  const error = deps.error ?? console.error;
  try {
    const { words, help, root, ...options } = parseArgs(argv);
    const [command, ...rest] = words;
    if (help || command === 'help') return log(USAGE), 0;
    if (!command) throw new Stop('명령이 없습니다', 2);
    const spec = Object.hasOwn(COMMANDS, command) ? COMMANDS[command] : null;
    if (!spec) throw new Stop(`모르는 명령: ${command}`, 2);
    const extra = Object.keys(options).find((key) => !spec.options.includes(key));
    if (extra) throw new Stop(`${command}에는 쓸 수 없는 옵션입니다: ${WRITTEN[extra]}`, 2);
    if (rest.length !== spec.words) throw new Stop(command === 'bump' ? 'bump에는 새 버전 하나를 적습니다: node scripts/release.mjs bump 0.3.7' : `${command}에는 더 적을 것이 없습니다: ${rest.join(' ')}`, 2);

    const common = { root: root ? resolve(root) : HERE, log, ...options };
    const world = Object.fromEntries(['run', 'fetch', 'publicKey', 'sleep', 'signingKey'].filter((key) => deps[key] !== undefined).map((key) => [key, deps[key]]));
    if (command === 'bump') bump({ ...common, version: rest[0] });
    else if (command === 'build') build({ ...common, ...world });
    else if (command === 'deploy') await deploy({ ...common, ...world });
    else {
      await verify({ ...common, ...world });
      publishHint(common.root, currentVersion(common.root), log);
    }
    return 0;
  } catch (e) {
    if (!(e instanceof Stop)) throw e;
    error(`\n✖ ${e.message}${e.code === 2 ? `\n\n${USAGE}` : ''}`);
    return e.code;
  }
}

// Run as a script, not imported. Real paths on both sides: node resolves links for the module's own address, and a
// repo reached through a junction would otherwise load this file, do nothing and exit 0.
const runAsScript = () => {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
};
if (runAsScript()) process.exitCode = await main(process.argv.slice(2));
