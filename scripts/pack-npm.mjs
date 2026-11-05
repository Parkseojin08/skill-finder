// Builds the npm package (`npx @seojin08/skill-finder` on Windows, macOS and Linux; user decision 2026-11-02) into
// release/npm/skill-finder and packs it to release/seojin08-skill-finder-<version>.tgz. The server is compiled to
// JavaScript (Node does not strip types under node_modules). Only an allow-list goes in, as in the Windows zip.
// Then the tarball is installed into a temporary project and started once with a temporary data folder.
// Publishing is a separate, deliberate step (npm login with 2FA): npm publish ./release/<file>.tgz --access public
// ("./" matters: without it npm reads "release/x" as a GitHub repository).
// The name is scoped: npm refused "skill-finder" as too close to the existing "skillfinder" (2026-11-03).
// Usage: node scripts/pack-npm.mjs
import { execFileSync, spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const NAME = '@seojin08/skill-finder';
const OUT = join(ROOT, 'release', 'npm', 'skill-finder');
// npm through node itself, without a shell: the repo path has spaces, which a .cmd shim would split
const NPM_CLI = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
const npm = (args, cwd = ROOT, opts = {}) =>
  existsSync(NPM_CLI) ? execFileSync(process.execPath, [NPM_CLI, ...args], { cwd, stdio: 'inherit', ...opts }) : execFileSync('npm', args, { cwd, stdio: 'inherit', ...opts });
const step = (msg) => console.log(`\n▶ ${msg}`);
const run = (cmd, args, cwd = ROOT) => execFileSync(cmd, args, { cwd, stdio: 'inherit' });

const rootPkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const serverPkg = JSON.parse(readFileSync(join(ROOT, 'server', 'package.json'), 'utf8'));
/** Never in the package. */
const FORBIDDEN = [/(^|\/)\.env$/, /(^|\/)data\//, /(^|\/)CLAUDE\.md$/, /(^|\/)AGENTS\.md$/, /(^|\/)\.claude\//, /(^|\/)\.codex\//, /\.db$/];

step('웹 빌드');
npm(['run', 'build']);

step('서버를 JavaScript로 컴파일');
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
run(process.execPath, [join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', join(ROOT, 'server', 'tsconfig.build.json'), '--outDir', join(OUT, 'server', 'src')]);

step('파일 모으기');
cpSync(join(ROOT, 'web', 'dist'), join(OUT, 'web', 'dist'), { recursive: true });
cpSync(join(ROOT, 'bin'), join(OUT, 'bin'), { recursive: true });
// the agent skill that tells Claude Code (and other agents) to look skills up with this CLI and hand the install link over (F23 (c))
cpSync(join(ROOT, 'skills'), join(OUT, 'skills'), { recursive: true });
for (const f of ['README.md', 'LICENSE', 'CHANGELOG.md', '.env.example']) cpSync(join(ROOT, f), join(OUT, f));
// the prebuilt index (server/src/db/seed.ts): a new install searches at once instead of reading 2,600 plugins first
run(process.execPath, [join(ROOT, 'scripts', 'export-seed.mjs'), join(OUT, 'seed-index.json.gz')]);
writeFileSync(
  join(OUT, 'package.json'),
  JSON.stringify(
    {
      name: NAME,
      version: rootPkg.version,
      description: 'Find Claude Code skills across marketplaces, skills.sh and GitHub, see their risk signals, and install them after checking what comes along. Local web app and read-only CLI.',
      license: 'MIT',
      type: 'module',
      bin: { 'skill-finder': 'bin/skill-finder.mjs' },
      engines: rootPkg.engines,
      dependencies: serverPkg.dependencies,
      repository: { type: 'git', url: 'git+https://github.com/Parkseojin08/skill-finder.git' },
      homepage: 'https://seojin-skill-finder.pages.dev',
      bugs: 'https://github.com/Parkseojin08/skill-finder/issues',
      keywords: ['claude-code', 'claude-skills', 'agent-skills', 'skills', 'cli'],
      files: ['bin', 'server', 'web/dist', 'skills', 'seed-index.json.gz', 'README.md', 'LICENSE', 'CHANGELOG.md', '.env.example'],
    },
    null,
    2,
  ) + '\n',
);
// the compiled code must not still import .ts files
const leftover = execFileSync(process.execPath, ['-e', `const fs=require('fs'),p=require('path');let n=0;const w=d=>{for(const e of fs.readdirSync(d,{withFileTypes:true})){const f=p.join(d,e.name);if(e.isDirectory())w(f);else if(f.endsWith('.js')&&/from '[^']+\\.ts'|import\\('[^']+\\.ts'\\)/.test(fs.readFileSync(f,'utf8')))n++;}};w(process.argv[1]);console.log(n)`, join(OUT, 'server')], { encoding: 'utf8' }).trim();
if (leftover !== '0') throw new Error(`.ts를 불러오는 JavaScript 파일이 ${leftover}개 남았습니다`);

step('압축(npm pack)');
const packed = npm(['pack', '--json', '--pack-destination', join(ROOT, 'release')], OUT, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
const info = JSON.parse(packed)[0];
const bad = info.files.map((f) => f.path).filter((p) => FORBIDDEN.some((re) => re.test(p.replace(/\\/g, '/'))));
if (bad.length) throw new Error(`패키지에 들어가면 안 되는 파일: ${bad.slice(0, 5).join(', ')}`);
const tgz = join(ROOT, 'release', info.filename);
console.log(`${info.filename}: 파일 ${info.files.length}개, ${(info.size / 1048576).toFixed(1)}MB`);

step('시험 설치·실행 (임시 폴더)');
const proj = mkdtempSync(join(tmpdir(), 'sf-npm-try-'));
const data = join(proj, 'data');
writeFileSync(join(proj, 'package.json'), '{"name":"try","private":true}');
npm(['install', '--no-audit', '--no-fund', '--loglevel=error', tgz], proj);
const bin = join(proj, 'node_modules', ...NAME.split('/'), 'bin', 'skill-finder.mjs');
const version = execFileSync(process.execPath, [bin, '--version'], { encoding: 'utf8' }).trim();
if (version !== rootPkg.version) throw new Error(`--version이 ${version}입니다`);
const port = 4400 + Math.floor(Math.random() * 400);
const child = spawn(process.execPath, [bin, '--no-open', '--port', String(port), '--lang', 'en'], { env: { ...process.env, SKILL_FINDER_DATA_DIR: data, GITHUB_TOKEN: '' }, stdio: 'pipe' });
let out = '';
child.stdout.on('data', (d) => (out += d));
child.stderr.on('data', (d) => (out += d));
let health = null;
for (let i = 0; i < 120 && !health; i++) {
  await new Promise((r) => setTimeout(r, 500));
  health = await fetch(`http://127.0.0.1:${port}/api/health`, { headers: { 'X-Skill-Finder': '1' } })
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null);
}
const page = health ? await fetch(`http://127.0.0.1:${port}/`).then((r) => r.text()) : '';
child.kill();
await new Promise((r) => setTimeout(r, 1000));
// Windows may still hold the stopped server's database for a moment: retried, and a leftover never hides the result
try {
  rmSync(proj, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
} catch (e) {
  console.warn(`임시 폴더를 지우지 못했습니다 (${e.code}): ${proj}`);
}
if (!health || health.appVersion !== rootPkg.version || !page.includes('<div id="root">')) throw new Error(`설치한 패키지가 켜지지 않았습니다\n${out}`);
console.log(`켜짐: ${health.app} ${health.appVersion}, 화면 응답함`);
console.log(`\n완료: ${tgz}\n올리기(직접, 루트에서): npm publish ./release/${info.filename} --access public`);
