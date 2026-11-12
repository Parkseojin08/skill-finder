// Builds release/skill-finder-win.zip: SkillFinder.exe + the server code + the built web app + production
// dependencies. Node.js itself is not included (the launcher asks the user to install it).
// Only an allow-list is copied, so .env (GitHub token), data/ (the local index) and AI assistant files can
// never end up in the archive. Usage: npm run package
// Before building it checks that what ships is committed (`--dirty` builds anyway), runs the type checks and
// server tests, installs the versions in package-lock.json, and starts the packed server once.
import { execFileSync, spawn } from 'node:child_process';
import { createHash, createPrivateKey, createPublicKey } from 'node:crypto';
import { once } from 'node:events';
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'release');
const APP = join(OUT, 'skill-finder');
const ZIP = join(OUT, 'skill-finder-win.zip');
const SITE_DOWNLOAD = join(ROOT, 'site', 'public', 'download');
const WINDIR = process.env.SystemRoot ?? 'C:\\Windows';
const CSC = join(WINDIR, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
// Windows' own bsdtar; a GNU tar from Git on PATH would read "C:" as a remote host.
const TAR = join(WINDIR, 'System32', 'tar.exe');
/** Cloudflare Workers static assets: 25 MiB per file. */
const MAX_BYTES = 25 * 1024 * 1024;
/** Archive entries that must never ship. */
const FORBIDDEN = [/(^|\/)\.env$/, /(^|\/)data\//, /(^|\/)CLAUDE\.md$/, /(^|\/)AGENTS\.md$/, /(^|\/)\.claude\//, /(^|\/)\.codex\//, /\.db$/];
/** What the archive is built from: a release should be a commit, not whatever the working tree holds. */
const SHIPPED = ['server/src', 'server/package.json', 'web', 'launcher', 'package.json', 'package-lock.json', 'scripts/package-win.mjs', 'scripts/export-seed.mjs', '.env.example', 'CHANGELOG.md', 'LICENSE'];

const step = (msg) => console.log(`\n▶ ${msg}`);

/** This version's lines of CHANGELOG.md ("## 0.3.0 (date)" then "- …" lines), at most 30. */
function changelogNotes(version) {
  const lines = readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8').split(/\r?\n/);
  const start = lines.findIndex((l) => l === `## ${version}` || l.startsWith(`## ${version} `));
  if (start < 0) return [];
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => l.startsWith('## '));
  return (end < 0 ? rest : rest.slice(0, end))
    .filter((l) => l.startsWith('- '))
    .map((l) => l.slice(2).trim().slice(0, 300))
    .slice(0, 30);
}
const rootPkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const serverPkg = JSON.parse(readFileSync(join(ROOT, 'server', 'package.json'), 'utf8'));

/**
 * The root lock's entries for the server's production dependencies, at the same paths, so the release
 * installs the versions the tests ran with (a plain `npm install` resolved newer qs and encodeurl).
 */
function serverLock() {
  const lock = JSON.parse(readFileSync(join(ROOT, 'package-lock.json'), 'utf8'));
  const pkgs = lock.packages;
  const parent = (dir) => {
    const i = dir.lastIndexOf('/node_modules/');
    return i < 0 ? '' : dir.slice(0, i);
  };
  // npm's lookup: the closest node_modules/<name> from the package's own folder up to the root
  const find = (from, name) => {
    for (let dir = from; ; dir = parent(dir)) {
      const path = dir ? `${dir}/node_modules/${name}` : `node_modules/${name}`;
      if (pkgs[path]) return path;
      if (!dir) return null;
    }
  };
  const keep = new Map();
  const add = (from, deps, required) => {
    for (const name of Object.keys(deps ?? {})) {
      const path = find(from, name);
      if (!path) {
        if (required) throw new Error(`package-lock.json에 ${name}이(가) 없습니다 (${from}에서 찾음). npm install로 lock을 맞추세요.`);
        continue;
      }
      if (keep.has(path)) continue;
      const entry = pkgs[path];
      keep.set(path, entry);
      add(path, entry.dependencies, true);
      add(path, entry.optionalDependencies, false);
      add(path, entry.peerDependencies, false);
    }
  };
  add('server', serverPkg.dependencies, true);
  const packages = { '': { name: 'skill-finder', version: rootPkg.version, dependencies: serverPkg.dependencies, engines: rootPkg.engines } };
  for (const path of [...keep.keys()].sort()) {
    // dev flags describe the workspace root's tree; here every entry is a production dependency
    const { dev, devOptional, peer, ...entry } = keep.get(path);
    packages[path] = entry;
  }
  return { name: 'skill-finder', version: rootPkg.version, lockfileVersion: 3, requires: true, packages };
}

const freePort = () =>
  new Promise((done, fail) => {
    const s = createServer();
    s.once('error', fail);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => done(port));
    });
  });

/** Starts the packed server on a free port with an empty data folder and checks /api/health and the page. */
async function smokeTest() {
  const port = await freePort();
  const dataDir = mkdtempSync(join(tmpdir(), 'sf-release-'));
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', join('server', 'src', 'index.ts')], {
    cwd: APP,
    // no token and no update check: only whether the packed files start
    env: { ...process.env, PORT: String(port), SKILL_FINDER_DATA_DIR: dataDir, SKILL_FINDER_ENV_PATH: join(dataDir, '.env'), GITHUB_TOKEN: '', SKILL_FINDER_UPDATES: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (d) => (output += d));
  child.stderr.on('data', (d) => (output += d));
  const base = `http://127.0.0.1:${port}`;
  try {
    const deadline = Date.now() + 30_000;
    let health = null;
    let last = '응답 없음';
    while (!health) {
      if (child.exitCode != null) throw new Error(`압축할 서버가 켜지자마자 꺼졌습니다 (종료 코드 ${child.exitCode}):\n${output}`);
      if (Date.now() > deadline) throw new Error(`압축할 서버의 /api/health가 30초 안에 200이 아니었습니다 (마지막: ${last}):\n${output}`);
      try {
        const res = await fetch(`${base}/api/health`, { headers: { 'X-Skill-Finder': '1' } });
        if (res.ok) health = await res.json();
        else last = `${res.status} ${(await res.text()).slice(0, 200)}`;
      } catch (e) {
        last = String(e.cause?.code ?? e.message);
      }
      if (!health) await new Promise((r) => setTimeout(r, 300));
    }
    if (health.app !== 'skill-finder' || health.appVersion !== rootPkg.version) {
      throw new Error(`/api/health 응답이 예상과 다릅니다: ${JSON.stringify({ app: health.app, appVersion: health.appVersion })}`);
    }
    const page = await (await fetch(`${base}/`)).text();
    if (!page.includes('id="root"')) throw new Error('첫 화면(index.html)을 받지 못했습니다');
    console.log(`127.0.0.1:${port}에서 켜짐 확인 (버전 ${health.appVersion})`);
  } finally {
    if (child.exitCode == null) {
      child.kill();
      await once(child, 'exit');
    }
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 5 });
  }
}

step('커밋 상태 확인');
const dirty = execFileSync('git', ['status', '--porcelain', '--', ...SHIPPED], { cwd: ROOT, encoding: 'utf8' }).split(/\r?\n/).filter(Boolean);
if (dirty.length && !process.argv.includes('--dirty')) {
  throw new Error(
    `커밋하지 않은 변경 ${dirty.length}개가 압축에 들어갑니다:\n${dirty.slice(0, 15).join('\n')}${dirty.length > 15 ? '\n…' : ''}\n` +
      '커밋한 뒤 다시 실행하거나, 이대로 만들려면 npm run package -- --dirty',
  );
}
console.log(dirty.length ? `커밋하지 않은 변경 ${dirty.length}개를 그대로 넣습니다 (--dirty)` : '모두 커밋됨');

step('실행기와 서버가 같은 값을 쓰는지 확인');
// the launcher (C#) cannot import the server's constants: the update page and default port are compared here
{
  const cs = readFileSync(join(ROOT, 'launcher', 'SkillFinder.cs'), 'utf8');
  const update = readFileSync(join(ROOT, 'server', 'src', 'update.ts'), 'utf8');
  const config = readFileSync(join(ROOT, 'server', 'src', 'config.ts'), 'utf8');
  const pairs = [
    ['업데이트 주소', cs.match(/UpdateBase = "([^"]+)"/)?.[1], update.match(/DEFAULT_BASE = '([^']+)'/)?.[1]],
    ['기본 포트', cs.match(/DefaultPort = (\d+)/)?.[1], config.match(/\?\? (\d+)\) \|\| (\d+)/)?.[1]],
  ];
  // the update key: the launcher's modulus and exponent must be those of release.ts's public key, or every
  // installed launcher would refuse the release
  const { UPDATE_PUBLIC_KEY } = await import(pathToFileURL(join(ROOT, 'server', 'src', 'release.ts')).href);
  const jwk = createPublicKey(UPDATE_PUBLIC_KEY).export({ format: 'jwk' });
  const b64 = (s) => Buffer.from(s, 'base64url').toString('base64');
  pairs.push(['업데이트 키', cs.match(/UpdateKeyModulus = "([^"]+)"/)?.[1], b64(jwk.n)], ['업데이트 키 지수', cs.match(/UpdateKeyExponent = "([^"]+)"/)?.[1], b64(jwk.e)]);
  for (const [what, launcher, server] of pairs) {
    if (!launcher || launcher !== server) throw new Error(`${what}가 실행기(${launcher ?? '없음'})와 서버(${server ?? '없음'})에서 다릅니다`);
  }
  console.log(pairs.map(([what, value]) => `${what} ${String(value).slice(0, 24)}`).join(' · '));
}

step('타입 검사·서버 테스트');
// npm is a .cmd file on Windows, which only runs through a shell; the arguments are fixed strings.
execFileSync('npm', ['run', 'typecheck'], { cwd: ROOT, stdio: 'inherit', shell: true });
// on Node, as the zip runs: npm test runs the same files on Bun, the development runtime (D#b7e3)
execFileSync('npm', ['run', 'test:node'], { cwd: ROOT, stdio: 'inherit', shell: true });

step('웹 빌드');
execFileSync('npm', ['run', 'build'], { cwd: ROOT, stdio: 'inherit', shell: true });

step('허용된 파일만 복사');
rmSync(OUT, { recursive: true, force: true });
mkdirSync(APP, { recursive: true });
cpSync(join(ROOT, 'server', 'src'), join(APP, 'server', 'src'), { recursive: true });
copyFileSync(join(ROOT, 'server', 'package.json'), join(APP, 'server', 'package.json'));
cpSync(join(ROOT, 'web', 'dist'), join(APP, 'web', 'dist'), { recursive: true });
copyFileSync(join(ROOT, '.env.example'), join(APP, '.env.example'));
// MIT: the notice goes with every copy; the bundled libraries' notices are in web/dist (vite build.license)
copyFileSync(join(ROOT, 'LICENSE'), join(APP, 'LICENSE.txt'));
// the prebuilt index (server/src/db/seed.ts): a new install searches at once instead of reading 2,600 plugins first
execFileSync(process.execPath, [join(ROOT, 'scripts', 'export-seed.mjs'), join(APP, 'seed-index.json.gz')], { stdio: 'inherit' });
writeFileSync(
  join(APP, 'package.json'),
  JSON.stringify(
    {
      name: 'skill-finder',
      version: rootPkg.version,
      private: true,
      type: 'module',
      engines: rootPkg.engines,
      scripts: { start: 'node --disable-warning=ExperimentalWarning server/src/index.ts' },
      dependencies: serverPkg.dependencies,
    },
    null,
    2,
  ) + '\n',
);
// Notepad shows Korean correctly with a BOM.
writeFileSync(
  join(APP, 'README.txt'),
  '\uFEFF' +
    [
      `Skill Finder ${rootPkg.version}`,
      '',
      'Claude Code 스킬을 마켓플레이스·skills.sh·GitHub에서 찾아 점수·위험 신호와 함께 보여 주고 설치·삭제하는 앱입니다.',
      '',
      '설치와 실행',
      '  1. 이 폴더의 SkillFinder.exe를 더블클릭합니다.',
      '     %LOCALAPPDATA%\\SkillFinder 에 설치되고 바탕화면에 "Skill Finder" 바로가기가 생깁니다.',
      '     설치가 끝나면 이 폴더는 지워도 됩니다. 다음부터는 바탕화면 바로가기로 여세요.',
      '  2. 브라우저에서 http://127.0.0.1:4317 이 자동으로 열립니다.',
      '     4317 포트를 다른 프로그램이 쓰고 있으면, 비어 있는 개발용 포트를 고르는 창이 뜹니다.',
      '  3. 검은 창을 닫으면 Skill Finder가 꺼집니다.',
      '',
      '터미널 명령',
      '  설치하면 skill-finder 명령이 생깁니다 (사용자 환경 변수 Path에 %LOCALAPPDATA%\\SkillFinder\\bin 을 더합니다).',
      '  새로 연 터미널(cmd, PowerShell, Git Bash)에서 씁니다. 이미 켜져 있던 VS Code·Windows Terminal·Claude Code는',
      '  다시 켠 뒤에 보입니다.',
      '    skill-finder --version   설치된 버전',
      '    skill-finder             Skill Finder를 켭니다 (바탕화면 바로가기와 같음)',
      '  빼려면 Windows 검색에서 "계정의 환경 변수 편집"을 열어 Path의 그 줄을 지우세요.',
      '  한 번 뺀 뒤에는 바로가기로 켜도 다시 넣지 않고, 내려받은 zip으로 다시 설치하면 다시 넣습니다.',
      '',
      '필요한 것',
      '  - Windows 10/11',
      '  - Node.js 22.20 이상 (https://nodejs.org/ko/download). 없으면 SkillFinder.exe가 설치 페이지를 엽니다.',
      '  - git (토큰 없이 GitHub 저장소 파일 목록을 읽을 때 사용)',
      '  - Claude Code (스킬 설치·삭제에 사용)',
      '',
      '처음 실행할 때',
      '  마켓플레이스의 스킬 목록을 모으느라 몇 분 걸립니다. 그동안에도 검색할 수 있고, 결과는 점점 늘어납니다.',
      '  GitHub 토큰을 설정 화면에 넣으면 GitHub 검색이 더해지고 목록을 더 빨리 모읍니다.',
      '',
      '업데이트',
      '  바로가기로 켤 때마다 소개 페이지에 새 버전이 있는지 보고, 있으면 내려받아 자동으로 바꿉니다',
      '  (크기와 SHA-256을 확인한 뒤). 켜져 있는 동안 새 버전이 나오면 검색 화면에 알림이 뜨고, 다시 켜면 바뀝니다.',
      '  새 버전이 켜지지 않으면 이전 버전과 그 데이터로 저절로 되돌리고, 그 버전은 다음부터 건너뜁니다.',
      '  스킬 목록·검색 기록·토큰은 %LOCALAPPDATA%\\SkillFinder 에 있어 그대로 이어집니다.',
      '  0.1.0을 쓰던 경우: 이전 폴더의 data\\ 폴더와 .env 파일을 이 폴더에 복사한 뒤 SkillFinder.exe를 실행하면 옮겨 줍니다.',
      '',
      '안전',
      '  이 앱은 내 PC(127.0.0.1)에서만 열립니다. 다른 기기에서는 접속할 수 없습니다.',
      '  검색 기록·색인·토큰은 이 PC의 %LOCALAPPDATA%\\SkillFinder 에만 저장됩니다 (설정 화면에 위치가 나옵니다).',
      '',
      '라이선스',
      '  Skill Finder는 MIT 라이선스입니다 (LICENSE.txt).',
      '  함께 들어 있는 오픈소스의 라이선스: web\\dist\\THIRD-PARTY-LICENSES.txt, node_modules 안 각 패키지의 LICENSE',
      '',
    ].join('\r\n'),
);

step('실행에 필요한 패키지 설치 (개발용 제외, lock 버전 그대로)');
writeFileSync(join(APP, 'package-lock.json'), JSON.stringify(serverLock(), null, 2) + '\n');
execFileSync('npm', ['ci', '--omit=dev', '--no-audit', '--no-fund', '--ignore-scripts', '--loglevel=error'], { cwd: APP, stdio: 'inherit', shell: true });
// fails on a missing or mismatched dependency, which a lock cut from the root one could miss
execFileSync('npm', ['ls', '--omit=dev', '--all'], { cwd: APP, stdio: 'ignore', shell: true });

step('압축할 서버 시험 실행');
await smokeTest();

step('SkillFinder.exe 빌드');
if (!existsSync(CSC)) throw new Error(`C# 컴파일러가 없습니다: ${CSC}`);
// WinForms for the port picker, System.IO.Compression for unpacking updates (all part of .NET Framework 4.5+)
const REFS = ['System.Windows.Forms.dll', 'System.Drawing.dll', 'System.IO.Compression.dll', 'System.IO.Compression.FileSystem.dll'].map((r) => `/r:${r}`);
execFileSync(CSC, ['/nologo', '/codepage:65001', '/target:exe', ...REFS, `/out:${join(APP, 'SkillFinder.exe')}`, join(ROOT, 'launcher', 'SkillFinder.cs')], { stdio: 'inherit' });

step('실행기 시험 (임시 폴더에서 설치·업데이트·되돌리기)');
execFileSync(process.execPath, [join(ROOT, 'scripts', 'test-launcher.mjs')], { stdio: 'inherit' });

step('압축');
// Windows' bundled bsdtar writes a standard zip with UTF-8 names.
execFileSync(TAR, ['-a', '-c', '-f', ZIP, '-C', OUT, 'skill-finder'], { stdio: 'inherit' });

step('검사');
const size = statSync(ZIP).size;
const entries = execFileSync(TAR, ['-t', '-f', ZIP], { encoding: 'utf8' }).split(/\r?\n/).filter(Boolean);
const bad = entries.filter((e) => FORBIDDEN.some((re) => re.test(e.replace(/\\/g, '/'))));
if (bad.length) throw new Error(`압축에 들어가면 안 되는 파일이 있습니다: ${bad.slice(0, 5).join(', ')}`);
if (size > MAX_BYTES) throw new Error(`압축 파일이 ${(size / 1048576).toFixed(1)}MB로 25MB 한도를 넘습니다`);
console.log(`파일 ${entries.length}개, ${(size / 1048576).toFixed(1)}MB, 금지 파일 없음`);

step('소개 페이지 다운로드 폴더로 복사');
const zipSha = createHash('sha256').update(readFileSync(ZIP)).digest('hex');
// A changed zip under the published version would look like the same release to people who already have it
// (UI debate 1-4). `--same-version` allows it on purpose, e.g. to rebuild after fixing only the page.
const META = join(SITE_DOWNLOAD, 'meta.json');
const published = existsSync(META) ? JSON.parse(readFileSync(META, 'utf8')) : null;
if (published?.version === rootPkg.version && published.sha256 !== zipSha && !process.argv.includes('--same-version')) {
  throw new Error(
    `소개 페이지에 이미 ${rootPkg.version} 버전이 올라가 있습니다. package.json의 version을 올리고 다시 실행하세요` +
      ` (같은 버전으로 바꾸려면 npm run package -- --same-version). 압축 파일은 ${ZIP}에 있습니다.`,
  );
}
// Signed (user decision 2026-11-02): the launcher installs only a meta.json signed with the key on this PC, and
// the app shows only signed notes. The notes are this version's lines of CHANGELOG.md.
step('서명');
const { notesMessage, releaseMessage, signText, verifyText } = await import(pathToFileURL(join(ROOT, 'server', 'src', 'release.ts')).href);
const KEY_PATH = process.env.SKILL_FINDER_SIGNING_KEY || join(homedir(), '.skill-finder-release', 'update-signing-key.pem');
if (!existsSync(KEY_PATH)) throw new Error(`업데이트 서명 키가 없습니다: ${KEY_PATH} (node scripts/signing-key.mjs로 만들고 공개 키를 코드에 넣으세요)`);
const privateKey = createPrivateKey(readFileSync(KEY_PATH));
const notes = changelogNotes(rootPkg.version);
if (!notes.length) throw new Error(`CHANGELOG.md에 ## ${rootPkg.version} 항목이 없습니다`);
const release = { version: rootPkg.version, bytes: size, sha256: zipSha };
const signature = signText(releaseMessage(release), privateKey);
// the key must be the one the app and the launcher trust
if (!verifyText(releaseMessage(release), signature)) throw new Error('서명 키가 server/src/release.ts의 공개 키와 맞지 않습니다');
console.log(`서명함 (변경 기록 ${notes.length}줄)`);

mkdirSync(SITE_DOWNLOAD, { recursive: true });
copyFileSync(ZIP, join(SITE_DOWNLOAD, 'skill-finder-win.zip'));
// the landing footer links to these
copyFileSync(join(ROOT, 'web', 'dist', 'THIRD-PARTY-LICENSES.txt'), join(SITE_DOWNLOAD, 'THIRD-PARTY-LICENSES.txt'));
copyFileSync(join(ROOT, 'LICENSE'), join(SITE_DOWNLOAD, '..', 'LICENSE.txt'));
writeFileSync(
  join(SITE_DOWNLOAD, 'meta.json'),
  // sha256 lets people check that the zip they got is the one built here
  JSON.stringify({
    ...release,
    builtAt: new Date().toISOString().slice(0, 10),
    notes,
    signature,
    notesSignature: signText(notesMessage(rootPkg.version, notes), privateKey),
  }) + '\n',
);
console.log(`완료: ${ZIP}`);
