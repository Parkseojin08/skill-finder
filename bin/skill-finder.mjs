#!/usr/bin/env node
// Skill Finder on Windows, macOS and Linux: `npx @seojin08/skill-finder` (the npm package) or `node bin/skill-finder.mjs`
// (a checkout). With no command it starts the local app and opens the browser. `search`, `show`, `recommend` and
// `installed` read from the app, starting it in the background when it is not running, and print text or --json,
// so Claude Code can call them from its shell. Nothing here installs or removes a skill: that stays in the app,
// behind its confirm dialog (user decision 2026-11-02). Each result carries an appUrl, the app's install tab for
// that skill and project, and `open <id>` opens it in the browser (F23 (a)): the agent hands the link over, the
// user installs. `check` (F12) compares a project with its standard files through the app's API; `lint` (F15) checks
// a hand-made skill folder in this process (read only, any folder, with or without the app). Both exit 1 on a finding,
// for CI or a hook. (launcher/SkillFinder.cs has a `skill-finder` command of its own; this is not it.)
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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
  skill-finder recommend [폴더]    프로젝트 README·기술 스택과 비슷한 스킬 (기본: 지금 폴더)
  skill-finder installed [폴더]    설치된 플러그인·스킬
  skill-finder open <id>           앱에서 그 스킬의 설치 확인 창까지 엽니다 (--project [폴더])
  skill-finder check [폴더]        프로젝트 표준(skills-lock.json, .claude/settings.json)과 설치된 것을 대조합니다
                                   (맞으면 0, 어긋나면 1. "표준에 없음"은 알림만)
  skill-finder lint <폴더>         직접 만든 스킬 폴더를 검사합니다 (문제가 있으면 1)
  skill-finder stop                이 명령이 백그라운드로 켠 앱을 끕니다

공통: --json(기계가 읽는 출력), --port N, --no-open, --lang ko|en|ja, --project 폴더(appUrl의 프로젝트, 기본: 지금 폴더)
결과마다 appUrl(앱의 설치 확인 창 주소)이 붙습니다. 설치·삭제는 앱 화면의 확인 창에서만 합니다.`,
    node: (v) => `Node.js ${v}는 너무 오래됐습니다. 22.20 이상이 필요합니다: https://nodejs.org`,
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
    stack: (s) => `감지한 스택: ${s}`,
    appUrl: '앱에서 설치',
    opened: (u) => `브라우저에서 열었습니다: ${u}\n설치는 앱의 확인 창에서 직접 하세요.`,
    openUrl: (u) => `이 주소를 브라우저로 여세요: ${u}`,
    failed: (m) => `실패: ${m}`,
    status: { ok: '맞음', missing: '설치 안 됨', differs: '내용 다름', extra: '표준에 없음', disabled: '플러그인 꺼짐', unregistered: '마켓 미등록' },
    kind: { skill: '스킬', plugin: '플러그인', marketplace: '마켓' },
    noStandard: (p) => `${p}에 프로젝트 표준(skills-lock.json, .claude/settings.json의 플러그인)이 없습니다.`,
    unreadable: (f) => `${f}을(를) 읽지 못했습니다.`,
    checkOk: '프로젝트 표준과 맞습니다.',
    checkBad: (n) => `프로젝트 표준과 어긋난 것이 ${n}개 있습니다. 빠진 것은 앱의 설치됨 화면에서 설치 확인 창을 거쳐 설치하세요.`,
    notForClaude: 'Claude Code 폴더에는 없음',
    needFolder: '검사할 스킬 폴더를 넣으세요. 예: skill-finder lint .claude/skills/my-skill',
    lintOk: '고칠 문제를 찾지 못했습니다.',
    lintBad: (n) => `고칠 문제 ${n}개 (오류·경고)`,
    lintSummary: (risk, perTurn, onUse) => `${risk} · 토큰(추정): 매 턴 ${perTurn}, 쓸 때 ${onUse}`,
    severity: { error: '오류', warning: '경고', info: '정보' },
    notFolder: (p) => `폴더가 아닙니다: ${p}`,
  },
  en: {
    usage: `Skill Finder ${VERSION} — find Claude Code skills (read-only commands)

Usage:
  skill-finder                     start the app and open the browser
  skill-finder search <query>      find skills (--limit N, --risk low|medium|high)
  skill-finder show <id>           one skill's risk signals and install command
  skill-finder recommend [folder]  skills like the project's README and tech stack (default: this folder)
  skill-finder installed [folder]  installed plugins and skills
  skill-finder open <id>           open the app at that skill's install confirm dialog (--project [folder])
  skill-finder check [folder]      compare the project standard (skills-lock.json, .claude/settings.json) with what
                                   is installed (0 when it matches, 1 when not; "not in the standard" is only reported)
  skill-finder lint <folder>       check a skill folder you made (1 when there are problems)
  skill-finder stop                stop the app this command started in the background

Common: --json (machine-readable), --port N, --no-open, --lang ko|en|ja, --project folder (appUrl's project, default: this folder)
Each result has an appUrl (the app's install confirm dialog). Installing and removing happen only in that dialog.`,
    node: (v) => `Node.js ${v} is too old. 22.20 or later is needed: https://nodejs.org`,
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
    stack: (s) => `Detected stack: ${s}`,
    appUrl: 'Install in the app',
    opened: (u) => `Opened in the browser: ${u}\nInstall from the app's confirm dialog yourself.`,
    openUrl: (u) => `Open this address in a browser: ${u}`,
    failed: (m) => `Failed: ${m}`,
    status: { ok: 'OK', missing: 'not installed', differs: 'content differs', extra: 'not in the standard', disabled: 'plugin off', unregistered: 'marketplace not added' },
    kind: { skill: 'skill', plugin: 'plugin', marketplace: 'marketplace' },
    noStandard: (p) => `${p} has no project standard (skills-lock.json, plugins in .claude/settings.json).`,
    unreadable: (f) => `Could not read ${f}.`,
    checkOk: 'Matches the project standard.',
    checkBad: (n) => `${n} item(s) differ from the project standard. Install missing ones from the app's Installed screen, through its confirm dialog.`,
    notForClaude: 'not in a Claude Code folder',
    needFolder: 'Give a skill folder to check. Example: skill-finder lint .claude/skills/my-skill',
    lintOk: 'Nothing to fix.',
    lintBad: (n) => `${n} problem(s) to fix (errors and warnings)`,
    lintSummary: (risk, perTurn, onUse) => `${risk} · tokens (estimate): ${perTurn} every turn, ${onUse} when used`,
    severity: { error: 'error', warning: 'warning', info: 'info' },
    notFolder: (p) => `Not a folder: ${p}`,
  },
  ja: {
    usage: `Skill Finder ${VERSION} — Claude Code スキル検索(読み取り専用のコマンド)

使い方:
  skill-finder                     アプリを起動してブラウザを開く
  skill-finder search <検索語>     スキルを探す (--limit N, --risk low|medium|high)
  skill-finder show <id>           スキルのリスク信号とインストールコマンド
  skill-finder recommend [フォルダ] プロジェクトの README・技術スタックに似たスキル(既定: 今のフォルダ)
  skill-finder installed [フォルダ] インストール済みのプラグイン・スキル
  skill-finder open <id>           アプリでそのスキルのインストール確認画面まで開く (--project [フォルダ])
  skill-finder check [フォルダ]    プロジェクト標準(skills-lock.json, .claude/settings.json)とインストール済みを照合する
                                   (一致で 0、ずれがあれば 1。「標準にない」は通知のみ)
  skill-finder lint <フォルダ>     自作のスキルフォルダを検査する(問題があれば 1)
  skill-finder stop                このコマンドがバックグラウンドで起動したアプリを止める

共通: --json(機械向け出力), --port N, --no-open, --lang ko|en|ja, --project フォルダ(appUrl のプロジェクト、既定: 今のフォルダ)
結果ごとに appUrl(アプリのインストール確認画面)が付きます。インストールと削除はその確認画面でのみ行います。`,
    node: (v) => `Node.js ${v} は古すぎます。22.20 以上が必要です: https://nodejs.org`,
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
    stack: (s) => `検出したスタック: ${s}`,
    appUrl: 'アプリでインストール',
    opened: (u) => `ブラウザで開きました: ${u}\nインストールはアプリの確認画面でご自身で行ってください。`,
    openUrl: (u) => `このアドレスをブラウザで開いてください: ${u}`,
    failed: (m) => `失敗: ${m}`,
    status: { ok: '一致', missing: '未インストール', differs: '内容が異なる', extra: '標準にない', disabled: 'プラグイン無効', unregistered: 'マーケット未登録' },
    kind: { skill: 'スキル', plugin: 'プラグイン', marketplace: 'マーケット' },
    noStandard: (p) => `${p} にプロジェクト標準(skills-lock.json、.claude/settings.json のプラグイン)がありません。`,
    unreadable: (f) => `${f} を読めませんでした。`,
    checkOk: 'プロジェクト標準と一致しています。',
    checkBad: (n) => `プロジェクト標準とずれている項目が ${n} 個あります。足りないものはアプリのインストール済み画面から確認画面を経てインストールしてください。`,
    notForClaude: 'Claude Code のフォルダにはない',
    needFolder: '検査するスキルフォルダを指定してください。例: skill-finder lint .claude/skills/my-skill',
    lintOk: '直すべき問題は見つかりませんでした。',
    lintBad: (n) => `直すべき問題 ${n} 件(エラー・警告)`,
    lintSummary: (risk, perTurn, onUse) => `${risk} · トークン(推定): 毎ターン ${perTurn}、使用時 ${onUse}`,
    severity: { error: 'エラー', warning: '警告', info: '情報' },
    notFolder: (p) => `フォルダではありません: ${p}`,
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
/** `--project [folder]`: the folder appUrl and `open` start the install at; alone (or before another flag) the current one. */
const projectArg = (() => {
  const i = args.indexOf('--project');
  if (i < 0) return null;
  const next = args[i + 1];
  const withPath = next != null && !next.startsWith('--');
  args.splice(i, withPath ? 2 : 1);
  return resolve(withPath ? next : process.cwd());
})();
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
  if (major < 22 || (major === 22 && minor < 20)) throw new Error(t.node(process.versions.node));
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
  // Windows: not `cmd /c start`, which reads the `&` between query parameters as a command separator and opened
  // `open`'s address without tab=install and project (review 2026-11-05); the URL handler takes it whole
  const [cmd, cmdArgs] =
    process.platform === 'win32'
      ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]];
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
/**
 * The app's skill page at its install tab, with the project folder the install should start at (D#b2b1: the page
 * takes `tab` and `project`). The agent hands this to the user; the app's confirm dialog does the installing.
 */
function appUrl(port, id, project) {
  const q = new URLSearchParams({ id, tab: 'install' });
  if (project) q.set('project', project);
  return `http://127.0.0.1:${port}/skill?${q}`;
}
/** Set once the app's port is known: every printed result carries its appUrl. */
let linkTo = null;
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
  ...(linkTo ? { appUrl: linkTo(it.id) } : {}),
});
function printItems(items, extra = null) {
  if (json) return console.log(JSON.stringify(extra ? { ...extra, skills: items.map(brief) } : items.map(brief), null, 2));
  if (!items.length) return console.log(t.none);
  for (const it of items) {
    const b = brief(it);
    console.log(`${b.name}  [${t.risk[b.riskLevel] ?? b.riskLevel}]  ↓${count(b.installs)} ★${count(b.stars)}${b.repo ? `  ${b.repo}` : ''}`);
    if (b.description) console.log(`  ${b.description.replace(/\s+/g, ' ').slice(0, 160)}`);
    console.log(`  id: ${b.id}`);
    if (b.appUrl) console.log(`  ${t.appUrl}: ${b.appUrl}`);
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
    linkTo = (id) => appUrl(port, id, projectArg ?? process.cwd());
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
    linkTo = (sid) => appUrl(port, sid, projectArg ?? process.cwd());
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
    linkTo = (id) => appUrl(port, id, projectPath);
    const r = JSON.parse(await api(port, 'POST', '/readme-skills', { projectPath }));
    const stack = r.stack ?? [];
    if (!json && r.readmePath) console.log(t.readFrom([r.readmePath, ...(r.alsoRead ?? [])].join(' + ')));
    if (!json && stack.length) console.log(t.stack(stack.map((s) => s.tag).join(', ')));
    // --json: an object since 0.3.6 (the stack and keywords ride along with the skills)
    return printItems(r.skills.map((s) => s.item).slice(0, limit), {
      readmePath: r.readmePath || null,
      stack: stack.map((s) => ({ tag: s.tag, evidence: s.evidence })),
      keywords: (r.keywords ?? []).map((k) => k.term),
    });
  }

  if (command === 'open') {
    const id = rest[0];
    if (!id) throw new Error(t.needId);
    const port = await ensureRunning();
    // the skill must be in the index (the server's own error otherwise); nothing is installed here
    await api(port, 'GET', `/skills/${encodeURIComponent(id)}`);
    const url = appUrl(port, id, projectArg);
    if (json) console.log(JSON.stringify({ id, appUrl: url, opened: !noOpen }, null, 2));
    if (noOpen) return json ? undefined : console.log(t.openUrl(url));
    openBrowser(url);
    if (!json) console.log(t.opened(url));
    return;
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

  if (command === 'check') {
    // F12: for CI and a SessionStart hook; 0 when the project matches its standard, 1 when not (an error is 1 too)
    const projectPath = resolve(rest[0] ?? process.cwd());
    const port = await ensureRunning();
    const s = JSON.parse(await api(port, 'GET', `/projects/standard?projectPath=${encodeURIComponent(projectPath)}`));
    const failing = s.items.filter((i) => ['missing', 'differs', 'disabled', 'unregistered'].includes(i.status));
    process.exitCode = s.ok ? 0 : 1;
    if (json) {
      return console.log(
        JSON.stringify(
          {
            projectPath: s.projectPath,
            ok: s.ok,
            hasStandard: s.hasStandard,
            files: s.files,
            counts: s.counts,
            items: s.items.map((i) => ({
              kind: i.kind,
              name: i.name,
              status: i.status,
              source: i.source,
              ref: i.ref,
              skillPath: i.skillPath,
              skillId: i.skillId,
              paths: i.paths,
              notForClaude: i.notForClaude,
              lockHash: i.lockHash,
              localHash: i.localHash,
              hashNote: i.hashNote,
              marketplace: i.marketplace,
            })),
          },
          null,
          2,
        ),
      );
    }
    if (s.files.lock === 'unreadable') console.log(t.unreadable('skills-lock.json'));
    if (s.files.settings === 'unreadable') console.log(t.unreadable('.claude/settings.json'));
    if (!s.hasStandard) return console.log(t.noStandard(s.projectPath));
    for (const i of s.items) {
      const where = i.kind === 'skill' && i.source ? `  ${i.source}${i.ref ? `#${i.ref}` : ''}` : i.kind !== 'skill' && i.marketplace ? `  ${i.marketplace}` : '';
      console.log(`  [${t.status[i.status] ?? i.status}] ${t.kind[i.kind] ?? i.kind} ${i.name}${where}${i.notForClaude ? `  (${t.notForClaude})` : ''}`);
    }
    console.log(`\n${failing.length || !s.ok ? t.checkBad(failing.length) : t.checkOk}`);
    return;
  }

  if (command === 'lint') {
    // F15 (feature review): the index's own checks on a skill folder made by hand, read in this process: any folder,
    // with or without the app (its POST /api/lint-skill takes only folders the 설치됨 screen lists), and without the
    // index, so no similar skills. Nothing in the folder is run. 0: nothing to fix (notes only), 1: an error or a
    // warning, 2: not a folder.
    if (!rest[0]) throw new Error(t.needFolder);
    const dir = resolve(rest[0]);
    let isDir = false;
    try {
      isDir = statSync(dir).isDirectory();
    } catch {
      // missing: not a folder
    }
    if (!isDir) {
      process.exitCode = 2;
      return console.log(json ? JSON.stringify({ ok: false, error: t.notFolder(dir) }, null, 2) : t.failed(t.notFolder(dir)));
    }
    const { lintSkillFolder } = await import(pathToFileURL(join(ROOT, 'server', 'src', 'lint', PACKAGED ? 'lint.js' : 'lint.ts')).href);
    const r = await lintSkillFolder(dir);
    process.exitCode = r.ok ? 0 : 1;
    if (json) return console.log(JSON.stringify(r, null, 2));
    console.log(`${r.name}  (${r.path})`);
    console.log(t.lintSummary(t.risk[r.risk.level] ?? r.risk.level, r.tokens.perTurn, r.tokens.onUse ?? '?'));
    const toFix = r.problems.filter((p) => p.severity !== 'info').length;
    console.log(toFix ? t.lintBad(toFix) : t.lintOk);
    for (const p of r.problems) {
      const at = [p.file, p.line].filter((x) => x != null && x !== '').join(':');
      console.log(`  [${t.severity[p.severity] ?? p.severity}] ${p.message}${at ? `  (${at})` : ''}`);
    }
    return;
  }

  console.log(t.usage);
  process.exitCode = 2;
}

main().catch((e) => {
  console.error(t.failed(String(e?.message ?? e)));
  process.exitCode = 1;
});
