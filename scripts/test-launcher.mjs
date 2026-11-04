// Runs SkillFinder.exe through install, update and rollback in temporary folders, with a local "download page"
// and a stand-in app whose server answers /api/health (project review 2026-11-02 #11). The real
// %LOCALAPPDATA%\SkillFinder, desktop and user PATH (HKCU\Environment) are never touched: the PATH checks use a
// throwaway registry key, deleted at the end. Usage: node scripts/test-launcher.mjs
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createServer as netServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { crc32 } from 'node:zlib';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WINDIR = process.env.SystemRoot ?? 'C:\\Windows';
const CSC = join(WINDIR, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
const work = mkdtempSync(join(tmpdir(), 'sf-launcher-test-'));
const home = join(work, 'home');
const desktop = join(work, 'desktop');
mkdirSync(desktop);

const exe = join(work, 'SkillFinder.exe');
const REFS = ['System.Windows.Forms.dll', 'System.Drawing.dll', 'System.IO.Compression.dll', 'System.IO.Compression.FileSystem.dll'].map((r) => '/r:' + r);
execFileSync(CSC, ['/nologo', '/codepage:65001', '/target:exe', ...REFS, '/out:' + exe, join(ROOT, 'launcher', 'SkillFinder.cs')], { stdio: 'inherit' });

// ── a stand-in app ────────────────────────────────────────────────────────────────────────────────────────────
const GOOD_SERVER = [
  "import { createServer } from 'node:http';",
  "import { readFileSync } from 'node:fs';",
  "const version = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;",
  'createServer((req, res) => {',
  "  res.writeHead(200, { 'content-type': 'application/json' });",
  "  res.end(JSON.stringify({ ok: true, app: 'skill-finder', appVersion: version }));",
  "}).listen(Number(process.env.PORT), '127.0.0.1');",
].join('\n');
const BROKEN_SERVER = "console.error('broken on purpose'); process.exit(3);";

/** Files of an unpacked download (folder `skill-finder/`), as path → content. */
function appFiles(version, server = GOOD_SERVER) {
  return {
    'package.json': JSON.stringify({ name: 'skill-finder', version, private: true, type: 'module' }),
    'server/src/index.ts': server,
    'web/dist/index.html': '<!doctype html><div id="root"></div>',
    'SkillFinder.exe': readFileSync(exe),
  };
}

function writeFolder(dir, files) {
  for (const [path, data] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), data);
  }
}

/** A plain (stored) zip; names are taken as given, so a test can put `../` in one. */
function makeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, content] of entries) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content);
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, data);
    centrals.push(central, nameBuf);
    offset += local.length + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

const zipOf = (version, server) => makeZip(Object.entries(appFiles(version, server)).map(([p, d]) => ['skill-finder/' + p, d]));

// ── the local download page ─────────────────────────────────────────────────────────────────────────────────
let page = { meta: null, zip: null };
const site = createServer((req, res) => {
  if (req.url === '/meta.json' && page.meta) {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(page.meta));
  }
  if (req.url === '/skill-finder-win.zip' && page.zip) {
    res.writeHead(200, { 'content-type': 'application/zip', 'content-length': page.zip.length });
    return res.end(page.zip);
  }
  res.writeHead(404).end();
});
await new Promise((r) => site.listen(0, '127.0.0.1', r));
const SITE = `http://127.0.0.1:${site.address().port}/`;
// Updates are signed (user decision 2026-11-02): this page signs with a test key the launcher is told about through
// SKILL_FINDER_UPDATE_KEY, which it accepts only for a download page on 127.0.0.1.
const { releaseMessage, signText } = await import(pathToFileURL(join(ROOT, 'server', 'src', 'release.ts')).href);
const testKey = generateKeyPairSync('rsa', { modulusLength: 2048 });
const TEST_KEY_MODULUS = Buffer.from(testKey.publicKey.export({ format: 'jwk' }).n, 'base64url').toString('base64');
/** `sha`: a different value to publish a tampered zip; `sign`: false for no signature, or another version's. */
function publish(version, zip, sha, sign = true) {
  const meta = { version, bytes: zip.length, sha256: sha ?? createHash('sha256').update(zip).digest('hex') };
  if (sign) meta.signature = signText(releaseMessage(sign === true ? meta : { ...meta, version: sign }), testKey.privateKey);
  page = { meta, zip };
}

// ── running the launcher ────────────────────────────────────────────────────────────────────────────────────
const freePort = () =>
  new Promise((done) => {
    const s = netServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => done(port));
    });
  });

async function health(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1000) });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

// The skill-finder command goes on PATH (user request 2026-11-04): here a throwaway key under HKCU\Software stands
// in for the user's environment (HKCU\Environment), seeded with an unexpanded entry that must stay as it is.
const PATH_KEY = `Software\\SkillFinderTest-${process.pid}`;
const SEEDED_PATH = '%SystemRoot%\\sf-test;C:\\sf-test-other';
const setTestPath = (value, kind = 'REG_EXPAND_SZ') => execFileSync('reg', ['add', `HKCU\\${PATH_KEY}`, '/v', 'Path', '/t', kind, '/d', value, '/f'], { stdio: 'ignore' });
/** A key's Path as stored: { kind, value }, or null. */
function readPath(key) {
  try {
    const m = execFileSync('reg', ['query', `HKCU\\${key}`, '/v', 'Path'], { encoding: 'utf8' }).match(/Path\s+(REG_\w+)\s+(.*)/);
    return m ? { kind: m[1], value: m[2].trim() } : null;
  } catch {
    return null;
  }
}
const testPath = () => readPath(PATH_KEY);
setTestPath(SEEDED_PATH);
// read only: compared at the end, to show the real one was left alone
const realPathBefore = JSON.stringify(readPath('Environment'));

const testEnv = (update, extra = {}) => ({
  ...process.env,
  SKILL_FINDER_HOME: home,
  SKILL_FINDER_DESKTOP: desktop,
  SKILL_FINDER_NO_BROWSER: '1',
  SKILL_FINDER_UPDATE_URL: update,
  SKILL_FINDER_DATA_DIR: '',
  SKILL_FINDER_ENV_PATH: '',
  SKILL_FINDER_RELAUNCHED: '',
  SKILL_FINDER_NO_UPDATE: '',
  SKILL_FINDER_UPDATE_KEY: TEST_KEY_MODULUS,
  SKILL_FINDER_PATH_KEY: PATH_KEY,
  ...extra,
});

/** Runs a command to the end (the launcher with arguments, or a shim): { status, out }. */
function runCommand(file, args, opts = {}) {
  const r = spawnSync(file, args, { env: testEnv('http://127.0.0.1:1/'), encoding: 'utf8', timeout: 20000, ...opts });
  return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

/**
 * Starts the launcher at `exePath`, waits until its server answers (or it exits), then ends the launcher with
 * everything it started. Returns the console output and the version that answered.
 */
async function launch(exePath, { update = SITE, waitMs = 40000, after, port: fixedPort, env = {}, untilExit = false } = {}) {
  const port = fixedPort ?? (await freePort());
  const child = spawn(exePath, [], {
    cwd: dirname(exePath),
    env: testEnv(update, { PORT: String(port), ...env }),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  let exited = false;
  child.on('exit', () => (exited = true));
  const deadline = Date.now() + waitMs;
  let answered = null;
  while (!exited && Date.now() < deadline) {
    answered = untilExit ? null : await health(port);
    if (answered) break;
    await new Promise((r) => setTimeout(r, 300));
  }
  if (answered && after) await after();
  if (!exited) {
    execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    await new Promise((r) => (exited ? r() : child.on('exit', r)));
  }
  return { out, version: answered?.appVersion ?? null };
}

const installed = () => {
  try {
    return JSON.parse(readFileSync(join(home, 'app', 'package.json'), 'utf8')).version;
  } catch {
    return null;
  }
};
/** Waits for a file test the launcher finishes just after its server answers. */
async function eventually(test, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (test()) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return test();
}

const results = [];
function check(name, ok, detail) {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : `\n${detail}`}`);
}

// ── the cases ───────────────────────────────────────────────────────────────────────────────────────────────
const homeExe = join(home, 'SkillFinder.exe');
try {
  const download1 = join(work, 'download-1.0.0', 'skill-finder');
  writeFolder(download1, appFiles('1.0.0'));
  const offline = 'http://127.0.0.1:1/';

  let r = await launch(join(download1, 'SkillFinder.exe'), { update: offline });
  check('내려받은 폴더에서 실행하면 설치하고 바로가기를 만든 뒤 켠다', r.version === '1.0.0' && installed() === '1.0.0' && existsSync(join(desktop, 'Skill Finder.lnk')), r.out);
  const bin = join(home, 'bin');
  const withBin = `${SEEDED_PATH};${bin}`;
  let p = testPath();
  check(
    '설치하면 bin\\에 skill-finder 명령을 만들고 사용자 Path 끝에 더한다 (원래 항목·%변수%·값 형식은 그대로)',
    existsSync(join(bin, 'skill-finder.cmd')) && existsSync(join(bin, 'skill-finder')) && p?.value === withBin && p?.kind === 'REG_EXPAND_SZ' && r.out.includes('skill-finder를 만들었습니다'),
    `${JSON.stringify(p)}\n${r.out}`,
  );

  writeFileSync(join(home, 'app', 'server', 'src', 'index.ts'), BROKEN_SERVER);
  r = await launch(join(download1, 'SkillFinder.exe'), { update: offline });
  check('같은 버전을 다시 실행하면 손상된 설치를 다시 설치한다', r.version === '1.0.0' && r.out.includes('다시 설치합니다'), r.out);
  check('다시 설치해도 Path에 두 번 넣지 않는다', testPath()?.value === withBin, JSON.stringify(testPath()));

  // the user took it off PATH by hand: a plain start leaves it off
  setTestPath(SEEDED_PATH);
  r = await launch(homeExe, { update: offline });
  check('다운로드 페이지에 닿지 않으면 지금 버전으로 켠다', r.version === '1.0.0', r.out);
  check('직접 Path에서 뺀 명령은 그냥 켤 때 다시 넣지 않는다', testPath()?.value === SEEDED_PATH, JSON.stringify(testPath()));

  // an install from before the command (no path-added.txt) gets it on its next start, here the one that updates
  rmSync(join(home, 'path-added.txt'));
  publish('2.0.0', zipOf('2.0.0'));
  // the launcher cleans up once it sees the new server answer: wait for that before ending it (ending it as soon
  // as this script saw the answer raced the launcher's own check, 500 ms apart)
  const prevGone = () => !existsSync(join(home, 'app.prev')) && !existsSync(join(home, 'update-check.txt'));
  r = await launch(homeExe, { after: () => eventually(prevGone, 10000) });
  const cleaned = prevGone();
  check(
    '새 버전을 받아 바꾸고, 새 서버가 응답하면 이전 버전 폴더를 지운다',
    r.version === '2.0.0' && installed() === '2.0.0' && cleaned && existsSync(join(home, 'downloads', 'skill-finder-2.0.0.zip')),
    r.out,
  );
  check('명령이 없던 설치는 다음 실행에서 한 번 Path에 더한다', testPath()?.value === withBin, JSON.stringify(testPath()));

  // the command itself: the installed version, without starting anything
  let c = runCommand('cmd.exe', ['/d', '/s', '/c', `""${join(bin, 'skill-finder.cmd')}" --version"`], { windowsVerbatimArguments: true });
  check('skill-finder --version(cmd·PowerShell용 .cmd)은 설치된 버전만 출력한다', c.status === 0 && c.out.trim() === '2.0.0', JSON.stringify(c));
  const sh = join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'bin', 'sh.exe');
  if (existsSync(sh)) {
    c = runCommand(sh, [join(bin, 'skill-finder').replace(/\\/g, '/'), '--version']);
    check('skill-finder --version(Git Bash용)도 같은 버전을 출력한다', c.status === 0 && c.out.trim() === '2.0.0', JSON.stringify(c));
  } else {
    console.log('SKIP Git Bash가 없어 sh용 명령은 시험하지 않음');
  }
  c = runCommand(join(download1, 'SkillFinder.exe'), ['--version']);
  check('내려받은 폴더의 SkillFinder.exe --version은 설치하지 않고 그 폴더의 버전을 출력한다', c.status === 0 && c.out.trim() === '1.0.0' && installed() === '2.0.0', JSON.stringify(c));
  c = runCommand(homeExe, ['--help']);
  const usage = c;
  c = runCommand(homeExe, ['search', 'pdf']);
  check(
    '--help는 사용법을, 모르는 인수는 앱을 켜지 않고 사용법과 함께 실패한다',
    usage.status === 0 && usage.out.includes('skill-finder --version') && c.status === 2 && c.out.includes('사용법'),
    JSON.stringify({ usage, c }),
  );
  c = runCommand('cmd.exe', ['/d', '/s', '/c', `""${join(bin, 'skill-finder.cmd')}" search pdf"`], { windowsVerbatimArguments: true });
  check('.cmd를 거쳐도 종료 코드가 그대로 나온다', c.status === 2, JSON.stringify(c));

  // the duplicate check: the same folder quoted, in other case and with a trailing backslash is already there
  const sameBin = `C:\\x;"${bin.toUpperCase()}\\"`;
  setTestPath(sameBin);
  rmSync(join(home, 'path-added.txt'));
  r = await launch(homeExe, { update: offline });
  check('Path에 따옴표·대소문자·끝 \\만 다르게 이미 있으면 더하지 않는다', r.version === '2.0.0' && testPath()?.value === sameBin, `${JSON.stringify(testPath())}\n${r.out}`);
  // plain text (REG_SZ) ending in ';'
  setTestPath('C:\\x;', 'REG_SZ');
  rmSync(join(home, 'path-added.txt'));
  r = await launch(homeExe, { update: offline });
  p = testPath();
  check('REG_SZ 값은 형식을 그대로 두고, 끝의 ;는 하나로 이어 붙인다', p?.kind === 'REG_SZ' && p?.value === `C:\\x;${bin}`, `${JSON.stringify(p)}\n${r.out}`);

  publish('3.0.0', zipOf('3.0.0'), 'f'.repeat(64));
  r = await launch(homeExe);
  check('SHA-256이 다르면 바꾸지 않는다', r.version === '2.0.0' && r.out.includes('SHA-256이 다릅니다'), r.out);

  publish('3.0.0', zipOf('3.0.0'), undefined, false);
  r = await launch(homeExe);
  check('서명이 없는 새 버전은 받지 않는다', r.version === '2.0.0' && r.out.includes('서명이 맞지 않아'), r.out);

  publish('3.0.0', zipOf('3.0.0'), undefined, '2.5.0');
  r = await launch(homeExe);
  check('다른 버전에 한 서명이면 받지 않는다', r.version === '2.0.0' && r.out.includes('서명이 맞지 않아'), r.out);

  const evil = makeZip([...Object.entries(appFiles('3.0.0')).map(([p, d]) => ['skill-finder/' + p, d]), ['../../escaped.txt', 'x']]);
  publish('3.0.0', evil);
  r = await launch(homeExe);
  check('압축 안의 경로가 폴더 밖을 가리키면 바꾸지 않는다', r.version === '2.0.0' && !existsSync(join(home, 'escaped.txt')) && r.out.includes('경로가 올바르지 않습니다'), r.out);

  // the next version cannot start: the launcher must put 2.0.0 and its data back
  const data = join(home, 'data');
  mkdirSync(data, { recursive: true });
  writeFileSync(join(data, 'skill-finder.db'), 'changed by 3.0.0');
  writeFileSync(join(data, 'skill-finder.db.before-3.0.0.bak'), 'as 2.0.0 left it');
  publish('3.0.0', zipOf('3.0.0', BROKEN_SERVER));
  r = await launch(homeExe, { waitMs: 90000 });
  check(
    '새 버전이 켜지지 않으면 이전 버전과 데이터로 되돌리고 그 버전을 건너뛴다',
    r.version === '2.0.0' &&
      installed() === '2.0.0' &&
      readFileSync(join(data, 'skill-finder.db'), 'utf8') === 'as 2.0.0 left it' &&
      readFileSync(join(home, 'skip-version.txt'), 'utf8').trim() === '3.0.0',
    r.out,
  );
  r = await launch(homeExe);
  check('되돌린 버전은 다음 확인에서 받지 않는다', r.version === '2.0.0' && r.out.includes('건너뜁니다'), r.out);

  publish('3.0.1', zipOf('3.0.1'));
  r = await launch(homeExe);
  check('그보다 새 버전은 다시 받는다', r.version === '3.0.1', r.out);

  // another dev server on the saved port, and a second launcher while one holds the mutex (review #5, #11)
  const fake = (body) =>
    new Promise((done) => {
      const s = createServer((_req, res) => res.writeHead(200, { 'content-type': 'application/json' }).end(body));
      s.listen(0, '127.0.0.1', () => done(s));
    });
  const other = await fake('{"ok":true}');
  r = await launch(homeExe, { port: other.address().port, env: { SKILL_FINDER_NO_UPDATE: '1' }, untilExit: true, waitMs: 8000 });
  check('같은 포트의 다른 개발 서버({"ok":true})는 Skill Finder로 보지 않는다', !r.out.includes('이미 실행 중') && r.out.includes('다른 프로그램이 쓰고 있습니다'), r.out);
  other.close();
  const holder = spawn('powershell', ['-NoProfile', '-Command', "$m = New-Object System.Threading.Mutex($true, 'Local\\SkillFinderLauncher'); Write-Output held; Start-Sleep -Seconds 60"], { stdio: ['ignore', 'pipe', 'ignore'] });
  await new Promise((done) => holder.stdout.on('data', (d) => String(d).includes('held') && done()));
  try {
    const sf = await fake('{"ok":true,"app":"skill-finder","appVersion":"3.0.1"}');
    r = await launch(homeExe, { port: sf.address().port, untilExit: true, waitMs: 15000 });
    check('다른 실행기가 도는 중이고 서버가 켜져 있으면 브라우저만 연다', r.out.includes('이미 실행 중입니다. 브라우저를 엽니다.'), r.out);
    sf.close();
    r = await launch(homeExe, { port: await freePort(), untilExit: true, waitMs: 15000 });
    check('다른 실행기가 켜지는 중이면 기다리라고 하고 아무것도 하지 않는다', r.out.includes('이미 켜지는 중입니다'), r.out);
  } finally {
    execFileSync('taskkill', ['/pid', String(holder.pid), '/T', '/F'], { stdio: 'ignore' });
  }
  check('실제 사용자 Path(HKCU\\Environment)는 그대로다', JSON.stringify(readPath('Environment')) === realPathBefore, 'changed');
} finally {
  site.close();
  try {
    execFileSync('reg', ['delete', `HKCU\\${PATH_KEY}`, '/f'], { stdio: 'ignore' });
  } catch {
    // already gone
  }
  rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
}

const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} 통과`);
process.exit(failed ? 1 : 0);
