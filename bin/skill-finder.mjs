#!/usr/bin/env node
// Skill Finder on Windows, macOS and Linux: `npx skill-finder` (the npm package) or `node bin/skill-finder.mjs`
// (a checkout). With no command it starts the local app and opens the browser. `search`, `show`, `recommend` and
// `installed` read from the app, starting it in the background when it is not running, and print text or --json,
// so Claude Code can call them from its shell. Nothing here installs or removes a skill: that stays in the app,
// behind its confirm dialog (user decision 2026-11-02).
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version ?? '?';
// the npm package ships compiled JavaScript (Node does not strip types under node_modules); a checkout runs the TS
const PACKAGED = existsSync(join(ROOT, 'server', 'src', 'index.js'));
const ENTRY = join(ROOT, 'server', 'src', PACKAGED ? 'index.js' : 'index.ts');
const DEFAULT_PORT = 4317;

// ── messages ─────────────────────────────────────────────────────────────────────────────────────────────────
const LANGS = ['ko', 'en', 'ja'];
const T = {
  ko: {
    usage: `Skill Finder ${VERSION} — Claude Code 스킬 검색 (읽기 전용 명령)

사용법:
  skill-finder                     앱을 켜고 브라우저를 엽니다
  skill-finder search <검색어>     스킬을 찾습니다 (--limit N, --risk low|medium|high)
  skill-finder show <id>           스킬 하나의 위험 신호와 설치 명령
  skill-finder recommend [폴더]    프로젝트 README와 비슷한 스킬 (기본: 지금 폴더)
  skill-finder installed [폴더]    설치된 플러그인·스킬
  skill-finder stop                이 명령이 백그라운드로 켠 앱을 끕니다

공통: --json(기계가 읽는 출력), --port N, --no-open, --lang ko|en|ja
설치·삭제는 앱 화면의 확인 창에서만 합니다.`,
    node: (v) => `Node.js ${v}는 너무 오래됐습니다. 22.18 이상이 필요합니다: https://nodejs.org`,
    noWeb: '웹 화면이 빌드되지 않았습니다. 먼저 npm run build를 실행하세요.',
    starting: (p) => `Skill Finder를 켜는 중입니다 (127.0.0.1:${p})…`,
    background: (p) => `Skill Finder를 백그라운드로 켰습니다 (127.0.0.1:${p}). 끄려면: skill-finder stop`,
    running: (p) => `Skill Finder가 이미 켜져 있습니다: http://127.0.0.1:${p}`,
    ready: (p) => `준비됐습니다: http://127.0.0.1:${p}  (끄려면 Ctrl+C)`,
    busy: (p, q) => `포트 ${p}를 다른 프로그램이 쓰고 있어 ${q}를 씁니다.`,
    timeout: '서버가 60초 안에 응답하지 않았습니다.',
    first: '처음 켜면 스킬 색인을 모으느라 몇 분 걸릴 수 있습니다.',
    stopped: 'Skill Finder를 껐습니다.',
    notMine: '이 명령이 켠 Skill Finder가 없습니다 (앱 창이나 실행기로 켠 것은 거기서 끄세요).',
    none: '결과가 없습니다.',
    needQuery: '검색어를 넣으세요. 예: skill-finder search "pdf tables"',
    needId: '스킬 id를 넣으세요 (search 결과의 id). 예: skill-finder show gh:anthropics/skills:skills/pdf',
    install: '설치',
    noInstall: '앱에서 설치 불가',
    risk: { low: '위험 낮음', medium: '주의', high: '위험 높음' },
    note: '위험 등급은 규칙 판정이며 안전 보증이 아닙니다. 설치는 앱의 확인 창에서 하세요.',
    plugins: '플러그인',
    skills: '스킬',
    readFrom: (f) => `읽은 파일: ${f}`,
    failed: (m) => `실패: ${m}`,
  },
  en: {
    usage: `Skill Finder ${VERSION} — find Claude Code skills (read-only commands)

Usage:
  skill-finder                     start the app and open the browser
  skill-finder search <query>      find skills (--limit N, --risk low|medium|high)
  skill-finder show <id>           one skill's risk signals and install command
  skill-finder recommend [folder]  skills like the project's README (default: this folder)
  skill-finder installed [folder]  installed plugins and skills
  skill-finder stop                stop the app this command started in the background

Common: --json (machine-readable), --port N, --no-open, --lang ko|en|ja
Installing and removing happen only in the app's confirm dialog.`,
    node: (v) => `Node.js ${v} is too old. 22.18 or later is needed: https://nodejs.org`,
    noWeb: 'The web app is not built. Run npm run build first.',
    starting: (p) => `Starting Skill Finder (127.0.0.1:${p})…`,
    background: (p) => `Started Skill Finder in the background (127.0.0.1:${p}). To stop it: skill-finder stop`,
    running: (p) => `Skill Finder is already running: http://127.0.0.1:${p}`,
    ready: (p) => `Ready: http://127.0.0.1:${p}  (Ctrl+C to stop)`,
    busy: (p, q) => `Port ${p} is used by another program; using ${q}.`,
    timeout: 'The server did not answer within 60 seconds.',
    first: 'The first start gathers the skill index and can take a few minutes.',
    stopped: 'Stopped Skill Finder.',
    notMine: 'No Skill Finder started by this command (stop one started by the app or launcher there).',
    none: 'No results.',
    needQuery: 'Give a query. Example: skill-finder search "pdf tables"',
    needId: 'Give a skill id (the id in search results). Example: skill-finder show gh:anthropics/skills:skills/pdf',
    install: 'Install',
    noInstall: 'not installable from the app',
    risk: { low: 'Low risk', medium: 'Caution', high: 'High risk' },
    note: 'Risk levels come from rules and are not a safety guarantee. Install from the app’s confirm dialog.',
    plugins: 'Plugins',
    skills: 'Skills',
    readFrom: (f) => `Read: ${f}`,
    failed: (m) => `Failed: ${m}`,
  },
  ja: {
    usage: `Skill Finder ${VERSION} — Claude Code スキル検索(読み取り専用のコマンド)

使い方:
  skill-finder                     アプリを起動してブラウザを開く
  skill-finder search <検索語>     スキルを探す (--limit N, --risk low|medium|high)
  skill-finder show <id>           スキルのリスク信号とインストールコマンド
  skill-finder recommend [フォルダ] プロジェクトの README に似たスキル(既定: 今のフォルダ)
  skill-finder installed [フォルダ] インストール済みのプラグイン・スキル
  skill-finder stop                このコマンドがバックグラウンドで起動したアプリを止める

共通: --json(機械向け出力), --port N, --no-open, --lang ko|en|ja
インストールと削除はアプリの確認画面でのみ行います。`,
    node: (v) => `Node.js ${v} は古すぎます。22.18 以上が必要です: https://nodejs.org`,
    noWeb: 'Web 画面がビルドされていません。先に npm run build を実行してください。',
    starting: (p) => `Skill Finder を起動しています (127.0.0.1:${p})…`,
    background: (p) => `Skill Finder をバックグラウンドで起動しました (127.0.0.1:${p})。止めるには: skill-finder stop`,
    running: (p) => `Skill Finder はすでに起動しています: http://127.0.0.1:${p}`,
    ready: (p) => `準備ができました: http://127.0.0.1:${p}  (Ctrl+C で終了)`,
    busy: (p, q) => `ポート ${p} は別のプログラムが使っているため ${q} を使います。`,
    timeout: 'サーバーが 60 秒以内に応答しませんでした。',
    first: '初回起動ではスキルの索引を集めるため数分かかることがあります。',
    stopped: 'Skill Finder を止めました。',
    notMine: 'このコマンドが起動した Skill Finder はありません(アプリやランチャーで起動したものはそちらで止めてください)。',
    none: '結果がありません。',
    needQuery: '検索語を入れてください。例: skill-finder search "pdf tables"',
    needId: 'スキル id を入れてください(search 結果の id)。例: skill-finder show gh:anthropics/skills:skills/pdf',
    install: 'インストール',
    noInstall: 'アプリからインストールできません',
    risk: { low: 'リスク低', medium: '注意', high: 'リスク高' },
    note: 'リスクの判定はルールによる目安で、安全の保証ではありません。インストールはアプリの確認画面で行ってください。',
    plugins: 'プラグイン',
    skills: 'スキル',
    readFrom: (f) => `読んだファイル: ${f}`,
    failed: (m) => `失敗: ${m}`,
  },
};

// ── arguments ────────────────────────────────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  if (i < 0) return false;
  args.splice(i, 1);
  return true;
};
const option = (name) => {
  const i = args.indexOf(name);
  if (i < 0 || i === args.length - 1) return null;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
};
const json = flag('--json');
const noOpen = flag('--no-open');
const langArg = option('--lang');
const portArg = option('--port');
const limit = Math.min(50, Math.max(1, Number(option('--limit')) || 10));
const risk = option('--risk');
const systemLang = (process.env.SKILL_FINDER_LANG || Intl.DateTimeFormat().resolvedOptions().locale || 'en').slice(0, 2).toLowerCase();
const lang = LANGS.includes(langArg) ? langArg : LANGS.includes(systemLang) ? systemLang : 'en';
const t = T[lang];
const [command = 'start', ...rest] = args;

// ── where the app lives ──────────────────────────────────────────────────────────────────────────────────────
/** A checkout keeps its data in ./data as `npm start` does; the package keeps it per user, outside the npm cache. */
function dataDir() {
  if (process.env.SKILL_FINDER_DATA_DIR) return process.env.SKILL_FINDER_DATA_DIR;
  if (!PACKAGED) return join(ROOT, 'data');
  if (process.platform === 'win32') return join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'SkillFinder', 'npx-data');
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'Skill Finder');
  return join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'skill-finder');
}
const DATA = dataDir();
const PID_FILE = join(DATA, 'cli-server.json');

async function health(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { headers: { 'X-Skill-Finder': '1' }, signal: AbortSignal.timeout(1500) });
    const h = res.ok ? await res.json() : null;
    return h?.app === 'skill-finder' ? h : null;
  } catch {
    return null;
  }
}
const portFree = (port) =>
  new Promise((done) => {
    const s = createServer();
    s.once('error', () => done(false));
    s.listen(port, '127.0.0.1', () => s.close(() => done(true)));
  });

/** A running Skill Finder's port, or null. */
async function findRunning() {
  // a port given with --port is the only one: another Skill Finder elsewhere is not the one asked for
  const ports = Number(portArg) ? [Number(portArg)] : [...new Set([Number(process.env.PORT) || 0, DEFAULT_PORT, readPid()?.port ?? 0].filter(Boolean))];
  for (const p of ports) if (await health(p)) return p;
  return null;
}

function readPid() {
  try {
    return JSON.parse(readFileSync(PID_FILE, 'utf8'));
  } catch {
    return null;
  }
}

/** Starts the server: in this terminal (`start`), or detached for the read commands. Resolves its port. */
async function startServer(background) {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 18)) throw new Error(t.node(process.versions.node));
  if (!existsSync(join(ROOT, 'web', 'dist', 'index.html'))) throw new Error(t.noWeb);
  let port = Number(portArg) || Number(process.env.PORT) || DEFAULT_PORT;
  if (!(await portFree(port))) {
    let next = port + 1;
    while (next < port + 50 && !(await portFree(next))) next++;
    if (!json) console.error(t.busy(port, next));
    port = next;
  }
  mkdirSync(DATA, { recursive: true });
  const env = { ...process.env, PORT: String(port), SKILL_FINDER_DATA_DIR: DATA };
  if (PACKAGED) env.SKILL_FINDER_ENV_PATH = process.env.SKILL_FINDER_ENV_PATH || join(DATA, '.env');
  if (!json) console.error(background ? t.starting(port) : `${t.starting(port)}\n${t.first}`);
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', ENTRY], {
    cwd: ROOT,
    env,
    stdio: background ? 'ignore' : 'inherit',
    detached: background,
    windowsHide: true,
  });
  if (background) {
    writeFileSync(PID_FILE, JSON.stringify({ pid: child.pid, port }));
    child.unref();
  }
  const until = Date.now() + 60_000;
  while (Date.now() < until) {
    if (await health(port)) return { port, child };
    if (child.exitCode != null) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(t.timeout);
}

function openBrowser(url) {
  const [cmd, cmdArgs] =
    process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  spawn(cmd, cmdArgs, { stdio: 'ignore', detached: true, windowsHide: true }).on('error', () => {}).unref();
}

/** The app's API, the way its own page calls it (header, same origin). */
async function api(port, method, path, body) {
  const res = await fetch(`http://127.0.0.1:${port}/api${path}`, {
    method,
    headers: { 'X-Skill-Finder': '1', Origin: `http://127.0.0.1:${port}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error((() => { try { return JSON.parse(text).error; } catch { return `${res.status}`; } })());
  return text;
}

async function ensureRunning() {
  const running = await findRunning();
  if (running) return running;
  const { port } = await startServer(true);
  if (!json) console.error(t.background(port));
  return port;
}

// ── output ───────────────────────────────────────────────────────────────────────────────────────────────────
const count = (n) => (n == null ? '-' : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : String(n));
const repoOf = (id) => id.match(/^gh:([^:]+):/)?.[1] ?? '';
const brief = (it) => ({
  id: it.id,
  name: it.name,
  description: it.description,
  repo: repoOf(it.id) || null,
  installs: it.installs ?? null,
  stars: it.stars ?? null,
  riskLevel: it.riskLevel,
  riskFlags: it.riskFlags,
  installMethod: it.install?.method ?? null,
  installCommand: it.install?.command || null,
  url: it.sources?.find((s) => s.url)?.url ?? null,
});
function printItems(items) {
  if (json) return console.log(JSON.stringify(items.map(brief), null, 2));
  if (!items.length) return console.log(t.none);
  for (const it of items) {
    const b = brief(it);
    console.log(`${b.name}  [${t.risk[b.riskLevel] ?? b.riskLevel}]  ↓${count(b.installs)} ★${count(b.stars)}${b.repo ? `  ${b.repo}` : ''}`);
    if (b.description) console.log(`  ${b.description.replace(/\s+/g, ' ').slice(0, 160)}`);
    console.log(`  id: ${b.id}`);
  }
  console.log(`\n${t.note}`);
}

// ── commands ─────────────────────────────────────────────────────────────────────────────────────────────────
async function main() {
  if (command === '--help' || command === '-h' || command === 'help') return console.log(t.usage);
  if (command === '--version' || command === '-v') return console.log(VERSION);

  if (command === 'start') {
    const running = await findRunning();
    if (running) {
      console.log(t.running(running));
      if (!noOpen) openBrowser(`http://127.0.0.1:${running}`);
      return;
    }
    const { port, child } = await startServer(false);
    console.log(t.ready(port));
    if (!noOpen) openBrowser(`http://127.0.0.1:${port}`);
    for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
    await new Promise((r) => child.on('exit', r));
    return;
  }

  if (command === 'stop') {
    const p = readPid();
    // only the server this command started, still running as the same process (a stale pid may be anything now)
    const h = p?.pid ? await health(p.port) : null;
    if (!h || h.pid !== p.pid) {
      rmSync(PID_FILE, { force: true });
      return console.log(t.notMine);
    }
    process.kill(p.pid);
    rmSync(PID_FILE, { force: true });
    return console.log(t.stopped);
  }

  if (command === 'search') {
    const query = rest.join(' ').trim();
    if (!query) throw new Error(t.needQuery);
    const port = await ensureRunning();
    const filters = ['low', 'medium', 'high'].includes(risk) ? { maxRisk: risk } : undefined;
    const lines = (await api(port, 'POST', '/search', { query, filters })).trim().split('\n').map((l) => JSON.parse(l));
    // the last one: a slow search sends interim results first, then the final ones
    const results = lines.filter((e) => e.type === 'results').at(-1);
    return printItems((results?.items ?? []).slice(0, limit));
  }

  if (command === 'show') {
    const id = rest[0];
    if (!id) throw new Error(t.needId);
    const port = await ensureRunning();
    const d = JSON.parse(await api(port, 'GET', `/skills/${encodeURIComponent(id)}`));
    if (json) return console.log(JSON.stringify({ ...brief(d), whenToUse: d.whenToUse ?? null }, null, 2));
    printItems([d]);
    const cmd = d.install?.command;
    console.log(cmd ? `${t.install}: ${cmd}` : t.noInstall);
    return;
  }

  if (command === 'recommend') {
    const projectPath = resolve(rest[0] ?? process.cwd());
    const port = await ensureRunning();
    const r = JSON.parse(await api(port, 'POST', '/readme-skills', { projectPath }));
    if (!json && r.readmePath) console.log(t.readFrom([r.readmePath, ...(r.alsoRead ?? [])].join(' + ')));
    return printItems(r.skills.map((s) => s.item).slice(0, limit));
  }

  if (command === 'installed') {
    const projectPath = rest[0] ? resolve(rest[0]) : undefined;
    const port = await ensureRunning();
    const q = projectPath ? `?projectPath=${encodeURIComponent(projectPath)}` : '';
    const d = JSON.parse(await api(port, 'GET', `/installed${q}`));
    if (json) {
      return console.log(
        JSON.stringify(
          {
            plugins: d.plugins.map((p) => ({ id: p.id, scope: p.scope, version: p.version, topRisk: p.topRisk })),
            skills: d.skills.map((s) => ({ name: s.name, scope: s.scope, path: s.path, riskLevel: s.risk.level, id: s.skillId })),
          },
          null,
          2,
        ),
      );
    }
    console.log(`${t.plugins} (${d.plugins.length})`);
    for (const p of d.plugins) console.log(`  ${p.id}  [${p.scope}]${p.topRisk ? `  ${t.risk[p.topRisk]}` : ''}`);
    console.log(`${t.skills} (${d.skills.length})`);
    for (const s of d.skills) console.log(`  ${s.name}  [${s.scope}]  ${t.risk[s.risk.level]}`);
    return;
  }

  console.log(t.usage);
  process.exitCode = 2;
}

main().catch((e) => {
  console.error(t.failed(String(e?.message ?? e)));
  process.exitCode = 1;
});
