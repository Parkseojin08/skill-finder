// Starts the Skill Finder server the E2E tests drive (playwright.config.ts runs this as its webServer):
//   - a new data folder and a new, empty home folder under the system's temporary folder: the developer's index,
//     settings, ~/.claude and ~/.agents are never read or written;
//   - no GitHub token (an empty .env; a GITHUB_TOKEN in the environment is dropped);
//   - the fixed index of e2e/support/fixture.ts, imported at startup as a prebuilt index (seed);
//   - no way out to the network: the server process (and the git it starts) gets proxy settings that point at a
//     closed port on this PC, so every outside request fails at once and the app works from its local index, as
//     it does on a PC that is offline. The app's own code is unchanged: these are environment variables only.
//   - no Claude Code: folders holding a `claude` executable are left out of PATH, so the screens look the same on a
//     developer's PC as on a CI runner, and no test can start it.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BLACKHOLE, BLACKHOLE_PORT, PORT, RUNTIME_DIR, SERVER_LOG } from '../support/env.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');
const WEB = join(ROOT, 'web');
const NODE_FLAGS = ['--disable-warning=ExperimentalWarning'];

function fail(message: string): never {
  console.error(`[e2e] ${message}`);
  process.exit(1);
}

/** The newest change under a folder (or of a file). */
function newestChange(path: string): number {
  const st = statSync(path);
  if (!st.isDirectory()) return st.mtimeMs;
  return Math.max(0, ...readdirSync(path).map((name) => newestChange(join(path, name))));
}

/** The server hands out web/dist: tests against a missing or older build would say nothing about the code. */
function checkWebBuild(): void {
  const index = join(WEB, 'dist', 'index.html');
  if (!existsSync(index)) fail('web/dist가 없습니다. 먼저 `npm run build`를 실행한 뒤 다시 `npm run e2e`를 실행하세요.');
  if (process.env.E2E_ALLOW_STALE_DIST === '1') return;
  const sources = ['src', 'index.html', 'vite.config.ts', 'package.json'].map((p) => join(WEB, p)).filter((p) => existsSync(p));
  if (Math.max(...sources.map(newestChange)) > statSync(index).mtimeMs) {
    fail('web/dist가 web/src보다 오래됐습니다(빌드한 뒤 화면 코드가 바뀜). `npm run build`를 다시 실행하세요. 그대로 돌리려면 E2E_ALLOW_STALE_DIST=1.');
  }
}

/** Whether something accepts connections on the port the proxy settings point at (then requests would not fail). */
function blackholeIsOpen(): Promise<boolean> {
  return new Promise((done) => {
    const socket = connect({ host: '127.0.0.1', port: BLACKHOLE_PORT });
    const answer = (open: boolean) => {
      socket.destroy();
      done(open);
    };
    socket.setTimeout(3000);
    socket.once('connect', () => answer(true));
    socket.once('timeout', () => answer(false));
    socket.once('error', () => answer(false));
  });
}

type Paths = { data: string; home: string; envFile: string; gitConfig: string; seed: string };

/** The environment of the server process: this PC's, minus what would leak in, plus the folders and the blackhole. */
function serverEnv(paths: Paths): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  // dropped: the developer's token and app switches, and any proxy this PC is set to use (lower case wins in Node)
  const dropped = /^(GITHUB_TOKEN|GH_TOKEN|SKILL_FINDER_\w+|PORT|NODE_USE_ENV_PROXY|(HTTPS?|ALL|NO)_PROXY|GIT_CONFIG\w*|XDG_(CONFIG|DATA|CACHE|STATE)_HOME)$/i;
  for (const [key, value] of Object.entries(process.env)) if (!dropped.test(key)) env[key] = value;

  // no Claude Code: the app looks for it in PATH, ~/.local/bin, ~/.claude/local and %APPDATA%\npm
  const pathKey = Object.keys(env).find((k) => k.toLowerCase() === 'path') ?? 'PATH';
  const hasClaude = (dir: string) => ['claude', 'claude.exe', 'claude.cmd'].some((name) => existsSync(join(dir, name)));
  env[pathKey] = (env[pathKey] ?? '')
    .split(delimiter)
    .filter((dir) => dir && !hasClaude(dir))
    .join(delimiter);

  const noProxy = '127.0.0.1,localhost';
  Object.assign(env, {
    PORT: String(PORT),
    SKILL_FINDER_DATA_DIR: paths.data,
    SKILL_FINDER_ENV_PATH: paths.envFile,
    SKILL_FINDER_SEED_PATH: paths.seed,
    // os.homedir() reads USERPROFILE on Windows and HOME elsewhere
    USERPROFILE: paths.home,
    HOME: paths.home,
    APPDATA: join(paths.home, 'AppData', 'Roaming'),
    LOCALAPPDATA: join(paths.home, 'AppData', 'Local'),
    XDG_CONFIG_HOME: join(paths.home, '.config'),
    // Node's fetch goes through these only with NODE_USE_ENV_PROXY (checked by net-probe.ts before the server starts)
    NODE_USE_ENV_PROXY: '1',
    HTTP_PROXY: BLACKHOLE,
    HTTPS_PROXY: BLACKHOLE,
    NO_PROXY: noProxy,
    // git: no system or personal configuration (either may name a real proxy, which would win over the variables
    // above), and the same blackhole as its proxy
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: paths.gitConfig,
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.proxy',
    GIT_CONFIG_VALUE_0: BLACKHOLE,
  });
  // names are case-sensitive outside Windows, and curl (git) reads the lower-case ones
  if (process.platform !== 'win32') Object.assign(env, { http_proxy: BLACKHOLE, https_proxy: BLACKHOLE, no_proxy: noProxy });
  return env;
}

checkWebBuild();
if (await blackholeIsOpen()) {
  fail(`127.0.0.1:${BLACKHOLE_PORT}에서 무언가 연결을 받고 있어, 서버의 바깥 요청을 막는 데 쓸 수 없습니다. E2E_BLACKHOLE_PORT로 닫힌 포트를 지정하세요.`);
}

// a new place for everything the server writes (what an earlier run left is removed first)
rmSync(RUNTIME_DIR, { recursive: true, force: true });
const paths: Paths = {
  data: join(RUNTIME_DIR, 'data'),
  home: join(RUNTIME_DIR, 'home'),
  envFile: join(RUNTIME_DIR, 'empty.env'),
  gitConfig: join(RUNTIME_DIR, 'empty.gitconfig'),
  seed: join(RUNTIME_DIR, 'seed-index.json.gz'),
};
const seedWork = join(RUNTIME_DIR, 'seed-work');
for (const dir of [paths.data, paths.home, seedWork]) mkdirSync(dir, { recursive: true });
for (const file of [paths.envFile, paths.gitConfig]) writeFileSync(file, '');
const env = serverEnv(paths);

const probe = spawnSync(process.execPath, [...NODE_FLAGS, join(HERE, 'net-probe.ts'), String(BLACKHOLE_PORT)], { env, encoding: 'utf8', timeout: 30_000 });
if (probe.status !== 0) {
  fail(
    `Node ${process.version}의 fetch가 프록시 환경 변수(NODE_USE_ENV_PROXY)를 따르지 않아 서버의 바깥 요청을 막을 수 없습니다 (${(probe.stderr || String(probe.error ?? '')).trim()}). ` +
      'Node 24 이상(또는 22.21 이상)으로 실행하세요. 실제 GitHub·skills.sh를 부르지 않도록 서버를 띄우지 않았습니다.',
  );
}

// The seed is built with the app's own modules. They read the configuration when first loaded, so this process gets
// the empty .env before that (the launcher itself never needs the developer's token).
process.env.SKILL_FINDER_ENV_PATH = paths.envFile;
const { buildSeed } = await import('./seed.ts');
const seed = buildSeed(seedWork, paths.seed);
const levels = Object.entries(seed.levels).map(([level, n]) => `${level} ${n}`);
console.log(`[e2e] 고정 색인: 플러그인 ${seed.plugins}개, 스킬 ${seed.skills}개 (${levels.join(', ')}), 저장소 ${seed.repos}개 → ${RUNTIME_DIR}`);
if (seed.unexpected.length > 0) {
  console.error(`[e2e] 위험 등급이 고정 색인이 뜻한 것과 다릅니다(위험 규칙이 바뀌었으면 e2e/support/fixture.ts를 고치세요): ${seed.unexpected.join('; ')}`);
}

// The server's console also goes to its log file (SERVER_LOG). Here it is only kept to show the end of it when the
// server stops by itself: offline, it warns about every background task, which would bury the test output.
const server = spawn(process.execPath, [...NODE_FLAGS, join(ROOT, 'server', 'src', 'index.ts')], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
let tail = '';
for (const stream of [server.stdout, server.stderr]) {
  stream.setEncoding('utf8');
  stream.on('data', (text: string) => (tail = (tail + text).slice(-8000)));
}
server.on('error', (err) => fail(`서버를 시작하지 못했습니다: ${err.message}`));
server.on('exit', (code, signal) => {
  if (code !== 0) console.error(`[e2e] 서버가 멈췄습니다 (${signal ?? `exit ${code}`}). 마지막 출력:\n${tail.trim()}\n[e2e] 전체 로그: ${SERVER_LOG}`);
  process.exit(code ?? 1);
});
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => server.kill(signal));
