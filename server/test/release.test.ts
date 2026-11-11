import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { createHash, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';
import { notesMessage, releaseMessage, signText } from '../src/release.ts';

// scripts/release.mjs: its text functions directly, its commands through main() with a command runner and a fetch
// of the test's own, and the command line itself as a child process (bump, and deploy --dry-run in an empty folder).
// No network, no build, no deploy: nothing here reaches the script's own runner, which refuses to run under the
// test runner anyway.
const ROOT = join(import.meta.dirname, '..', '..');
const SCRIPT = join(ROOT, 'scripts', 'release.mjs');

type Step = { title: string; cwd: string; tool: 'node' | 'npx'; args: string[] };
type Deps = {
  run?: (step: Step) => void;
  fetch?: (url: string) => Promise<Response>;
  publicKey?: KeyObject;
  sleep?: (ms: number) => Promise<void>;
  signingKey?: string;
  log?: (line: string) => void;
  error?: (line: string) => void;
};
type Texts = { pkg: string; lock: string; changelog: string };
type Release = {
  SITES: { name: string; base: string; config: string; wrangler: string[] }[];
  isVersion(v: unknown): boolean;
  isDate(s: unknown): boolean;
  compareVersions(a: string, b: string): number;
  localDate(d?: Date): string;
  changelogSection(text: string, version: string): { line: number; heading: string; notes: string[] } | null;
  notesProblems(notes: string[]): string[];
  dateChangelog(text: string, version: string, date: string): string;
  setJsonString(text: string, path: string[], value: string, label?: string): string;
  bumpTexts(files: Texts, version: string, date: string): { from: string; notes: string[]; texts: Texts };
  runStep(step: Step): void;
  main(argv: string[], deps?: Deps): Promise<number>;
};
// a path worked out at run time: the script is JavaScript without type declarations
const release = (await import(pathToFileURL(SCRIPT).href)) as Release;

const tmp = mkdtempSync(join(tmpdir(), 'sf-release-'));
after(() => rmSync(tmp, { recursive: true, force: true, maxRetries: 5 }));

// git as the tests use it, and as the script uses it from this process: without the user's own configuration
// (commit signing, hooks, a global ignore file), with a name for the fixture's commits
writeFileSync(join(tmp, 'gitconfig'), '');
Object.assign(process.env, {
  GIT_CONFIG_GLOBAL: join(tmp, 'gitconfig'),
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'release test',
  GIT_AUTHOR_EMAIL: 'release-test@example.invalid',
  GIT_COMMITTER_NAME: 'release test',
  GIT_COMMITTER_EMAIL: 'release-test@example.invalid',
});
const git = (root: string, ...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** The key the fixtures' meta.json is signed with (the real one never leaves the publisher's PC). */
const KEY = generateKeyPairSync('rsa', { modulusLength: 2048 });
const OTHER_KEY = generateKeyPairSync('rsa', { modulusLength: 2048 });
writeFileSync(join(tmp, 'signing-key.pem'), 'only has to exist: build checks that it is there, package-win.mjs reads it');

function signedMeta(version: string, zip: Buffer, by: KeyObject = KEY.privateKey) {
  const notes = ['첫 번째 변경입니다.', '두 번째 변경입니다.'];
  const m = { version, bytes: zip.length, sha256: createHash('sha256').update(zip).digest('hex') };
  return { ...m, builtAt: '2026-11-10', notes, signature: signText(releaseMessage(m), by), notesSignature: signText(notesMessage(version, notes), by) };
}

/** main() with everything that touches the world replaced: the exit code, what it printed, ran and fetched. */
async function cli(argv: string[], deps: Deps = {}) {
  const out: string[] = [];
  const ran: Step[] = [];
  const fetched: string[] = [];
  let slept = 0;
  const code = await release.main(argv, {
    publicKey: KEY.publicKey,
    signingKey: join(tmp, 'signing-key.pem'),
    log: (line) => void out.push(line),
    error: (line) => void out.push(line),
    ...deps,
    run: (step) => {
      ran.push(step);
      deps.run?.(step);
    },
    fetch: async (url) => {
      fetched.push(url);
      return deps.fetch ? deps.fetch(url) : new Response('not found', { status: 404 });
    },
    sleep: async () => void slept++,
  });
  return { code, out: out.join('\n'), ran, fetched, slept };
}

type Run = { code: number; out: string; err: string };
/** The script as a child process: the command line as the user types it. */
const script = (args: string[]) =>
  new Promise<Run>((resolve) => {
    execFile(process.execPath, [SCRIPT, ...args], { timeout: 60_000 }, (error, out, err) => resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, out, err }));
  });

// Small files in the shape of the real ones (CRLF as git checks them out on Windows). A dependency has the root's
// version on purpose: only the root's two may change.
const PKG = ['{', '  "name": "skill-finder",', '  "version": "1.4.0",', '  "private": true,', '  "workspaces": ["server", "web"],', '  "engines": { "node": ">=22.20" }', '}', ''].join('\r\n');
const LOCK =
  JSON.stringify(
    {
      name: 'skill-finder',
      version: '1.4.0',
      lockfileVersion: 3,
      requires: true,
      packages: {
        '': { name: 'skill-finder', version: '1.4.0', workspaces: ['server', 'web'] },
        'node_modules/dep': { version: '1.4.0', resolved: 'https://registry.npmjs.org/dep/-/dep-1.4.0.tgz', license: 'MIT' },
      },
    },
    null,
    2,
  ).replace(/\n/g, '\r\n') + '\r\n';
/** CHANGELOG.md with these sections ("heading": notes), newest first. */
const changelog = (sections: Record<string, string[]>, eol = '\r\n') =>
  ['# 변경 기록', '', '한 줄이 한 항목입니다.', '', ...Object.entries(sections).flatMap(([heading, notes]) => [`## ${heading}`, '', ...notes.map((n) => `- ${n}`), '']), ''].join(eol);

/** A folder with the three files `bump` changes. */
function folder(files: Partial<Record<'package.json' | 'package-lock.json' | 'CHANGELOG.md', string | Buffer>>) {
  const root = mkdtempSync(join(tmp, 'root-'));
  for (const [name, data] of Object.entries(files)) writeFileSync(join(root, name), data);
  return root;
}
const readAll = (root: string) => Object.fromEntries(readdirSync(root).map((name) => [name, readFileSync(join(root, name), 'utf8')]));
/** The lines that differ between two texts of the same number of lines, as [before, after]. */
function changedLines(a: string, b: string) {
  const [x, y] = [a.split('\n'), b.split('\n')];
  assert.equal(y.length, x.length, '줄 수가 같다');
  return x.flatMap((line, i) => (line === y[i] ? [] : [[line, y[i]]]));
}

describe('release.mjs: 글만 다루는 함수', () => {
  it('버전: 숫자 세 개만 받고, 숫자로 비교한다', () => {
    for (const v of ['0.3.7', '1.0.0', '10.20.300']) assert.ok(release.isVersion(v), v);
    for (const v of ['v0.3.7', '0.3', '0.3.7.1', '0.3.7-beta.1', '01.2.3', '0.3.x', '', undefined, 37]) assert.ok(!release.isVersion(v), String(v));
    assert.equal(release.compareVersions('0.3.7', '0.3.6'), 1);
    assert.equal(release.compareVersions('0.10.0', '0.9.9'), 1, '글자 순서가 아니라 숫자');
    assert.equal(release.compareVersions('0.3.6', '0.3.6'), 0);
    assert.equal(release.compareVersions('0.3.6', '1.0.0'), -1);
  });

  it('날짜: 이 PC의 날짜를 쓰고, 달력에 없는 날은 받지 않는다', () => {
    // 00:30 local time: in Korea toISOString() would still say the day before
    assert.equal(release.localDate(new Date(2026, 0, 5, 0, 30)), '2026-01-05');
    assert.equal(release.localDate(new Date(2026, 10, 30, 23, 59)), '2026-11-30');
    assert.ok(release.isDate('2026-11-10'));
    for (const d of ['2026-02-30', '2026-13-01', '26-11-10', '2026/11/10', '', undefined]) assert.ok(!release.isDate(d), String(d));
  });

  it('CHANGELOG 절: npm run package가 읽는 줄을 그대로 찾는다', () => {
    for (const eol of ['\r\n', '\n']) {
      const text = changelog({ '0.3.70 (2026-12-01)': ['다른 버전'], '0.3.7': ['  앞뒤 공백은 뺌  ', '둘째'], '0.3.6 (2026-11-09)': ['이전 것'] }, eol);
      const section = release.changelogSection(text, '0.3.7')!;
      assert.deepEqual(section.notes, ['앞뒤 공백은 뺌', '둘째'], '0.3.70의 줄도, 다음 절의 줄도 아님');
      assert.equal(section.heading, '## 0.3.7');
      assert.equal(text.split(/\r?\n/)[section.line], '## 0.3.7');
      assert.deepEqual(release.changelogSection(text, '0.3.6')!.notes, ['이전 것'], '마지막 절은 파일 끝까지');
      assert.equal(release.changelogSection(text, '0.3.8'), null);
    }
    // only "- " lines are notes: prose and indented sub-items are not
    assert.deepEqual(release.changelogSection('## 1.0.0\n\n설명 글\n- 항목\n  - 하위 항목\n-붙여 쓴 줄\n', '1.0.0')!.notes, ['항목']);
  });

  it('변경 기록: 없거나, 30줄·300자를 넘거나, 빈 항목이면 문제로 알린다', () => {
    assert.deepEqual(release.notesProblems(['하나', '둘']), []);
    assert.deepEqual(release.notesProblems(Array.from({ length: 30 }, (_, i) => `항목 ${i}`)), []);
    assert.deepEqual(release.notesProblems(['가'.repeat(300)]), []);
    assert.match(release.notesProblems([]).join(), /"- "로 시작하는 줄이 없습니다/);
    assert.match(release.notesProblems(Array.from({ length: 31 }, (_, i) => `항목 ${i}`)).join(), /31줄/);
    assert.match(release.notesProblems(['짧은 것', '가'.repeat(301)]).join(), /2번째 항목이 301자/);
    assert.match(release.notesProblems(['하나', '']).join(), /2번째 항목이 비어/);
  });

  it('CHANGELOG 제목 날짜: 그 줄만 바꾸고 줄 끝은 그대로 둔다', () => {
    for (const eol of ['\r\n', '\n']) {
      const text = changelog({ '0.3.7': ['새것'], '0.3.6 (2026-11-09)': ['이전 것'] }, eol);
      const dated = release.dateChangelog(text, '0.3.7', '2026-11-10');
      assert.equal(dated, text.replace('## 0.3.7', '## 0.3.7 (2026-11-10)'), '날짜가 없으면 붙인다');
      assert.equal(release.dateChangelog(dated, '0.3.7', '2026-11-12'), text.replace('## 0.3.7', '## 0.3.7 (2026-11-12)'), '있으면 바꾼다');
      assert.equal(release.dateChangelog(text.replace('## 0.3.7', '## 0.3.7 (예정)  '), '0.3.7', '2026-11-10'), dated, '괄호 안이 날짜가 아니어도');
      assert.equal(release.dateChangelog(text, '0.3.6', '2026-11-09'), text, '같은 날짜면 그대로');
    }
    assert.throws(() => release.dateChangelog(changelog({ '0.3.7 - 큰 변화': ['새것'] }), '0.3.7', '2026-11-10'), /날짜를 넣을 수 없습니다/);
    assert.throws(() => release.dateChangelog(changelog({ '0.3.6': ['이전 것'] }), '0.3.7', '2026-11-10'), /"## 0\.3\.7" 절이 없습니다/);
  });

  it('JSON의 문자열 하나만 바꾼다: 한 줄 배열·CRLF·다른 "version"은 그대로', () => {
    const pkg = release.setJsonString(PKG, ['version'], '1.4.1');
    assert.equal(pkg, PKG.replace('"version": "1.4.0"', '"version": "1.4.1"'));
    assert.ok(pkg.includes('"workspaces": ["server", "web"],\r\n'), '한 줄 배열과 CRLF가 남는다');

    const lock = release.setJsonString(release.setJsonString(LOCK, ['version'], '1.4.1'), ['packages', '', 'version'], '1.4.1');
    assert.deepEqual(
      changedLines(LOCK, lock).map(([from, to]) => [from.trim(), to.trim()]),
      [
        ['"version": "1.4.0",', '"version": "1.4.1",'],
        ['"version": "1.4.0",', '"version": "1.4.1",'],
      ],
    );
    assert.equal(JSON.parse(lock).packages['node_modules/dep'].version, '1.4.0', '같은 버전의 의존성은 그대로');

    // text that only looks like the key, inside strings and other objects, is not it
    const tricky = '{"a": "\\"version\\": \\"1.0.0\\"", "deep": {"version": "1.0.0", "list": [{"version": "1.0.0"}, "version"]}, "n": -1.5e3, "t": true, "z": null, "version" : "1.0.0"}';
    assert.equal(release.setJsonString(tricky, ['version'], '2.0.0'), tricky.replace('"version" : "1.0.0"', '"version" : "2.0.0"'));
    assert.equal(release.setJsonString(tricky, ['deep', 'version'], '2.0.0'), tricky.replace('{"version": "1.0.0", "list"', '{"version": "2.0.0", "list"'));
    assert.equal(release.setJsonString('{"v": "a\\\\"}', ['v'], 'b"c'), '{"v": "b\\"c"}', '역슬래시로 끝나는 값, 따옴표가 든 새 값');

    assert.throws(() => release.setJsonString(PKG, ['packages', '', 'version'], '1.4.1', 'package.json'), /package\.json에 packages\.""\.version 문자열이 없습니다/);
    assert.throws(() => release.setJsonString('{"version": 3}', ['version'], '1.4.1'), /문자열이 없습니다/, '문자열이 아닌 값');
    assert.throws(() => release.setJsonString('{"version": "1.4.0",}', ['version'], '1.4.1'), /JSON이 아닙니다/);
  });

  it('bumpTexts: 세 파일을 한 번에 계산하고, 멈출 때는 아무것도 돌려주지 않는다', () => {
    const files = { pkg: PKG, lock: LOCK, changelog: changelog({ '1.5.0': ['새 기능'], '1.4.0 (2026-11-09)': ['이전 것'] }) };
    const plan = release.bumpTexts(files, '1.5.0', '2026-11-10');
    assert.equal(plan.from, '1.4.0');
    assert.deepEqual(plan.notes, ['새 기능']);
    assert.equal(JSON.parse(plan.texts.pkg).version, '1.5.0');
    assert.deepEqual([JSON.parse(plan.texts.lock).version, JSON.parse(plan.texts.lock).packages[''].version], ['1.5.0', '1.5.0']);
    assert.ok(plan.texts.changelog.includes('## 1.5.0 (2026-11-10)\r\n'));
    assert.throws(() => release.bumpTexts(files, '1.4.0', '2026-11-10'), /높아야 합니다/);
    assert.throws(() => release.bumpTexts(files, '1.6.0', '2026-11-10'), /"## 1\.6\.0" 절이 없습니다/);
  });
});

describe('release.mjs bump', () => {
  // the real package.json and package-lock.json (7,500 lines), whatever version they are at
  const VERSION: string = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
  const NEXT = VERSION.replace(/\d+$/, (patch) => String(Number(patch) + 1));
  const realCopy = () =>
    folder({
      'package.json': readFileSync(join(ROOT, 'package.json')),
      'package-lock.json': readFileSync(join(ROOT, 'package-lock.json')),
      'CHANGELOG.md': changelog({ [NEXT]: ['새 기능입니다.', '고친 것입니다.'], [`${VERSION} (2026-11-09)`]: ['이전 것'] }),
    });

  it('세 파일을 고친다: 실제 package.json·package-lock.json 사본에서 버전 줄만, CHANGELOG는 제목 날짜만', async () => {
    const root = realCopy();
    const was = readAll(root);
    const r = await script(['bump', NEXT, '--root', root, '--date', '2026-12-01']);
    assert.equal(r.code, 0, r.err);
    const now = readAll(root);
    assert.deepEqual(Object.keys(now).sort(), ['CHANGELOG.md', 'package-lock.json', 'package.json'], '다른 파일은 만들지 않는다');

    const versionLine = ([from, to]: string[]) => /^\s*"version": "/.test(from) && to === from.replace(`"${VERSION}"`, `"${NEXT}"`);
    const pkgLines = changedLines(was['package.json'], now['package.json']);
    assert.ok(pkgLines.length === 1 && versionLine(pkgLines[0]), JSON.stringify(pkgLines));
    const lockLines = changedLines(was['package-lock.json'], now['package-lock.json']);
    assert.ok(lockLines.length === 2 && lockLines.every(versionLine), JSON.stringify(lockLines));
    const lock = JSON.parse(now['package-lock.json']);
    assert.deepEqual([JSON.parse(now['package.json']).version, lock.version, lock.packages[''].version], [NEXT, NEXT, NEXT]);
    assert.equal(now['CHANGELOG.md'], was['CHANGELOG.md'].replace(`## ${NEXT}`, `## ${NEXT} (2026-12-01)`));

    // what comes next, and nothing was committed, built or published for the user
    assert.match(r.out, new RegExp(`${VERSION.replaceAll('.', '\\.')} → ${NEXT.replaceAll('.', '\\.')} \\(2026-12-01\\), 변경 기록 2줄`));
    for (const next of ['git add package.json package-lock.json CHANGELOG.md', 'node scripts/release.mjs build', 'git push origin main', 'node scripts/release.mjs deploy', `npm publish ./release/seojin08-skill-finder-${NEXT}.tgz --access public`]) {
      assert.ok(r.out.includes(next), next);
    }
  });

  it('날짜를 주지 않으면 오늘, --dry-run이면 아무것도 쓰지 않는다', async () => {
    const root = realCopy();
    const was = readAll(root);
    const dry = await cli(['bump', NEXT, '--root', root, '--dry-run']);
    assert.equal(dry.code, 0, dry.out);
    assert.match(dry.out, /--dry-run: 파일은 고치지 않았습니다/);
    assert.deepEqual(readAll(root), was);

    const real = await cli(['bump', NEXT, `--root=${root}`]);
    assert.equal(real.code, 0, real.out);
    assert.ok(readAll(root)['CHANGELOG.md'].includes(`## ${NEXT} (${release.localDate()})`));
    assert.deepEqual([real.ran, real.fetched], [[], []], 'bump는 명령도 요청도 하지 않는다');
  });

  it('멈추는 입력: 이유를 말하고 세 파일은 그대로', async () => {
    const sections = {
      '2.0.4 - 큰 변화': ['제목 모양이 다름'],
      '2.0.3': ['짧은 것', '가'.repeat(301)],
      '2.0.2': Array.from({ length: 31 }, (_, i) => `항목 ${i + 1}`),
      '2.0.1': [],
      '2.0.0': ['좋은 절'],
      '1.4.0 (2026-11-09)': ['지금 버전'],
      '1.3.0 (2026-11-01)': ['이전 버전'],
    };
    const root = folder({ 'package.json': PKG, 'package-lock.json': LOCK, 'CHANGELOG.md': changelog(sections) });
    const was = readAll(root);
    const cases: [string[], RegExp][] = [
      [['1.4.0'], /새 버전\(1\.4\.0\)은 지금 버전\(1\.4\.0\)보다 높아야 합니다/],
      [['1.3.0'], /새 버전\(1\.3\.0\)은 지금 버전\(1\.4\.0\)보다 높아야 합니다/],
      [['v2.0.0'], /숫자 세 개여야 합니다/],
      [['2.0.0-beta.1'], /숫자 세 개여야 합니다/],
      [['2.0'], /숫자 세 개여야 합니다/],
      [['2.1.0'], /CHANGELOG\.md에 "## 2\.1\.0" 절이 없습니다/],
      [['2.0.1'], /"- "로 시작하는 줄이 없습니다/],
      [['2.0.2'], /항목이 31줄입니다\. 30줄까지만/],
      [['2.0.3'], /2번째 항목이 301자입니다\. 300자까지만/],
      [['2.0.4'], /날짜를 넣을 수 없습니다/],
      [['2.0.0', '--date', '2026-02-30'], /날짜는 2026-11-10 모양이어야 합니다/],
    ];
    for (const [args, message] of cases) {
      const r = await cli(['bump', ...args, '--root', root]);
      assert.equal(r.code, 1, `${args.join(' ')}: ${r.out}`);
      assert.match(r.out, message, args.join(' '));
      assert.deepEqual(readAll(root), was, `${args.join(' ')}: 파일이 그대로`);
    }
    // the good one still goes through after all those stops
    assert.equal((await cli(['bump', '2.0.0', '--root', root, '--date', '2026-11-10'])).code, 0);
    assert.ok(readAll(root)['CHANGELOG.md'].includes('## 2.0.0 (2026-11-10)\r\n'));
  });

  it('lock에 루트 버전이 없거나 파일이 없으면 멈춘다 (package.json도 그대로)', async () => {
    const oldLock = JSON.stringify({ name: 'skill-finder', version: '1.4.0', lockfileVersion: 1, dependencies: {} }, null, 2);
    const root = folder({ 'package.json': PKG, 'package-lock.json': oldLock, 'CHANGELOG.md': changelog({ '2.0.0': ['좋은 절'] }) });
    const was = readAll(root);
    const r = await cli(['bump', '2.0.0', '--root', root]);
    assert.equal(r.code, 1);
    assert.match(r.out, /package-lock\.json에 packages\.""\.version 문자열이 없습니다/);
    assert.deepEqual(readAll(root), was);

    const missing = await cli(['bump', '2.0.0', '--root', folder({ 'package.json': PKG, 'package-lock.json': LOCK })]);
    assert.equal(missing.code, 1);
    assert.match(missing.out, /CHANGELOG\.md 파일이 없습니다/);
  });

  it('명령줄이 틀리면 2로 끝나고 사용법을 보인다', async () => {
    const root = folder({ 'package.json': PKG, 'package-lock.json': LOCK, 'CHANGELOG.md': changelog({ '2.0.0': ['좋은 절'] }) });
    const was = readAll(root);
    const wrong: [string[], RegExp][] = [
      [[], /명령이 없습니다/],
      [['frobnicate'], /모르는 명령: frobnicate/],
      [['bump', '--root', root], /bump에는 새 버전 하나를 적습니다/],
      [['bump', '2.0.0', '2.0.1', '--root', root], /bump에는 새 버전 하나를 적습니다/],
      [['bump', '2.0.0', '--root'], /--root에 값이 없습니다/],
      [['bump', '2.0.0', '--root', root, '--force'], /모르는 옵션: --force/],
      [['bump', '2.0.0', '--root', root, '--dry-run=no'], /모르는 옵션: --dry-run=no/],
      [['bump', '2.0.0', '--root', root, '--dirty'], /bump에는 쓸 수 없는 옵션입니다: --dirty/],
      [['deploy', '--root', root, '--date', '2026-11-10'], /deploy에는 쓸 수 없는 옵션입니다: --date/],
      [['verify', '--root', root, '--dry-run'], /verify에는 쓸 수 없는 옵션입니다: --dry-run/],
      [['build', 'now', '--root', root], /build에는 더 적을 것이 없습니다: now/],
    ];
    for (const [args, message] of wrong) {
      const r = await cli(args);
      assert.equal(r.code, 2, args.join(' '));
      assert.match(r.out, message, args.join(' '));
      assert.match(r.out, /사용법: node scripts\/release\.mjs/, args.join(' '));
      assert.deepEqual([r.ran, r.fetched], [[], []], args.join(' '));
    }
    assert.deepEqual(readAll(root), was);

    const help = await cli(['--help']);
    assert.equal(help.code, 0);
    assert.match(help.out, /순서: bump → 커밋 → build → git push origin main → deploy → npm publish/);
    // and as a process: the code is the exit code, the message goes to stderr
    const child = await script(['bump', '--root', root]);
    assert.equal(child.code, 2);
    assert.match(child.err, /bump에는 새 버전 하나를 적습니다/);
    assert.equal(child.out, '');
  });
});

describe('release.mjs build', () => {
  const root = folder({ 'package.json': PKG, 'package-lock.json': LOCK, 'CHANGELOG.md': changelog({ '1.4.0 (2026-11-10)': ['첫 번째', '두 번째'] }) });
  const shown = (steps: Step[]) => steps.map((s) => `${s.tool} ${s.args.join(' ')}`);

  it('zip을 먼저, 그다음 npm 패키지: zip 스크립트가 release/를 비우기 때문', async () => {
    const r = await cli(['build', '--root', root]);
    assert.equal(r.code, 0, r.out);
    assert.deepEqual(shown(r.ran), ['node scripts/package-win.mjs', 'node scripts/pack-npm.mjs']);
    assert.ok(r.ran.every((s) => s.cwd === root));
    assert.match(r.out, /✔ CHANGELOG\.md: 1\.4\.0 변경 기록 2줄/);
    for (const next of ['git push origin main', 'node scripts/release.mjs deploy', 'npm publish ./release/seojin08-skill-finder-1.4.0.tgz --access public']) assert.ok(r.out.includes(next), next);

    // the package script's own switches go to it, and only to it
    assert.deepEqual(shown((await cli(['build', '--root', root, '--dirty', '--same-version'])).ran), ['node scripts/package-win.mjs --dirty --same-version', 'node scripts/pack-npm.mjs']);
  });

  it('--dry-run: 두 명령을 순서대로 보이기만 한다', async () => {
    const r = await cli(['build', '--root', root, '--dry-run', '--dirty']);
    assert.equal(r.code, 0, r.out);
    assert.deepEqual(r.ran, []);
    assert.ok(r.out.indexOf('node scripts/package-win.mjs --dirty') > 0 && r.out.indexOf('node scripts/package-win.mjs --dirty') < r.out.indexOf('node scripts/pack-npm.mjs'), r.out);
    assert.match(r.out, /--dry-run: 실행하지 않음/);
  });

  it('변경 기록이나 서명 키가 없으면 빌드를 시작하지 않는다', async () => {
    const noKey = await cli(['build', '--root', root], { signingKey: join(tmp, 'no-such-key.pem') });
    assert.equal(noKey.code, 1);
    assert.match(noKey.out, /✖ 업데이트 서명 키: 없습니다: .*no-such-key\.pem/);
    assert.deepEqual(noKey.ran, []);

    const noNotes = folder({ 'package.json': PKG, 'CHANGELOG.md': changelog({ '1.3.0 (2026-11-01)': ['이전 버전'] }) });
    const r = await cli(['build', '--root', noNotes]);
    assert.equal(r.code, 1);
    assert.match(r.out, /✖ CHANGELOG\.md: "## 1\.4\.0" 절이 없습니다/);
    assert.deepEqual(r.ran, []);

    // --dry-run still shows the commands, and still ends with 1
    const dry = await cli(['build', '--root', noNotes, '--dry-run']);
    assert.equal(dry.code, 1);
    assert.ok(dry.out.includes('node scripts/pack-npm.mjs'));
    assert.match(dry.out, /실제 실행은 여기서 멈추고 아무것도 만들지 않습니다/);
    assert.deepEqual(dry.ran, []);
  });

  it('zip이 실패하면 npm 패키지는 만들지 않고, npm 패키지만 실패하면 그것만 다시 하라고 알린다', async () => {
    const failing = (name: string) => (step: Step) => {
      if (step.args[0] === name) throw Object.assign(new Error('Command failed'), { status: 1 });
    };
    const zip = await cli(['build', '--root', root], { run: failing('scripts/package-win.mjs') });
    assert.equal(zip.code, 1);
    assert.equal(zip.ran.length, 1);
    assert.match(zip.out, /zip을 만들지 못했습니다 \(종료 코드 1\)/);

    const npm = await cli(['build', '--root', root], { run: failing('scripts/pack-npm.mjs') });
    assert.equal(npm.code, 1);
    assert.equal(npm.ran.length, 2);
    assert.match(npm.out, /node scripts\/pack-npm\.mjs만 다시 실행하세요/);
  });
});

describe('release.mjs deploy · verify', () => {
  const [PAGES, WORKER] = release.SITES.map((s) => s.base);
  const ZIP = Buffer.from('not a real zip: only the bytes that meta.json describes');
  const urls = [`${PAGES}download/meta.json`, `${PAGES}download/skill-finder-win.zip`, `${WORKER}download/meta.json`, `${WORKER}download/skill-finder-win.zip`];
  const DEPLOYS = ['cd site && npx --yes wrangler@4 pages deploy', 'cd site && npx --yes wrangler@4 deploy --config wrangler.old-worker.jsonc'];

  /** A fetch that answers for each address with what "is deployed" there. */
  const served = (sites: Record<string, { meta?: string; zip?: Buffer }>) => async (url: string) => {
    for (const [base, files] of Object.entries(sites)) {
      if (url === `${base}download/meta.json` && files.meta !== undefined) return new Response(files.meta);
      if (url === `${base}download/skill-finder-win.zip` && files.zip) return new Response(files.zip);
    }
    return new Response('not found', { status: 404 });
  };
  const good = { meta: JSON.stringify(signedMeta('1.4.0', ZIP)), zip: ZIP };

  // A repo that is ready to deploy 1.4.0: the built download in place (ignored, as in the real repo), everything
  // committed on main, origin/main at the same commit. Each test changes one thing and puts it back.
  let root: string;
  let first: string;
  let head: string;
  const write = (rel: string, data: string | Buffer) => {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), data);
  };
  before(() => {
    root = mkdtempSync(join(tmp, 'repo-'));
    write('package.json', PKG);
    write('package-lock.json', LOCK);
    write('CHANGELOG.md', changelog({ '1.4.0 (2026-11-10)': ['첫 번째 변경입니다.', '두 번째 변경입니다.'] }));
    write('.gitignore', 'site/public/download/\nrelease/\n');
    // the repo's own wrangler configurations: deploy wants both in site/
    for (const site of release.SITES) write(`site/${site.config}`, readFileSync(join(ROOT, 'site', site.config)));
    write('site/public/index.html', '<!doctype html><title>Skill Finder</title>');
    write('site/public/download/skill-finder-win.zip', ZIP);
    write('site/public/download/meta.json', `${good.meta}\n`);
    git(root, 'init', '--quiet', '-b', 'main');
    git(root, 'add', '-A');
    git(root, 'commit', '--quiet', '-m', 'first');
    write('site/public/page.js', '// the second commit\n');
    git(root, 'add', '-A');
    git(root, 'commit', '--quiet', '-m', 'second');
    head = git(root, 'rev-parse', 'HEAD');
    first = git(root, 'rev-parse', 'HEAD~1');
    git(root, 'update-ref', 'refs/remotes/origin/main', head);
    // what `build` leaves next to the tarball: the zip was made from this commit (release/ is ignored)
    write('release/built-from.json', builtFrom(head));
  });
  const builtFrom = (commit: string, more: Record<string, unknown> = {}) => JSON.stringify({ version: '1.4.0', commit, sha256: createHash('sha256').update(ZIP).digest('hex'), dirty: false, ...more });

  it('옛 Worker 설정이 저장소에 있다: 이름 skill-finder, 정적 파일은 설정 파일 옆의 ./public', () => {
    const jsonc = (name: string) => JSON.parse(readFileSync(join(ROOT, 'site', name), 'utf8').split(/\r?\n/).filter((l) => !l.trimStart().startsWith('//')).join('\n'));
    assert.deepEqual(jsonc('wrangler.old-worker.jsonc'), { name: 'skill-finder', compatibility_date: '2026-10-01', assets: { directory: './public' } });
    // the Pages project serves the same folder
    assert.equal(jsonc('wrangler.jsonc').pages_build_output_dir, './public');
    assert.deepEqual(release.SITES.map((s) => s.config), ['wrangler.jsonc', 'wrangler.old-worker.jsonc']);
  });

  it('--dry-run: 확인은 하고, 두 명령과 확인할 주소를 보이기만 한다 (실행 0, 요청 0)', async () => {
    const r = await cli(['deploy', '--dry-run', '--root', root], { fetch: served({ [PAGES]: good, [WORKER]: good }) });
    assert.equal(r.code, 0, r.out);
    assert.deepEqual([r.ran, r.fetched], [[], []]);
    for (const line of [...DEPLOYS, ...urls]) assert.ok(r.out.includes(`  ${line}`), line);
    assert.ok(r.out.indexOf(DEPLOYS[0]) < r.out.indexOf(DEPLOYS[1]), 'Pages가 먼저');
    assert.match(r.out, /✔ 올릴 zip \(site\/public\/download\): 1\.4\.0, 서명 맞음/);
    assert.match(r.out, /✔ 커밋 상태: 커밋하지 않은 변경 없음/);
    assert.match(r.out, new RegExp(`✔ push 상태: main = origin/main \\(${head.slice(0, 7)}\\)`));
    assert.match(r.out, /npm publish \.\/release\/seojin08-skill-finder-1\.4\.0\.tgz --access public/);
    assert.deepEqual(readdirSync(join(root, 'site')).sort(), ['public', 'wrangler.jsonc', 'wrangler.old-worker.jsonc'], 'site/에 생긴 것이 없다');
  });

  it('--dry-run (명령줄): 준비되지 않은 폴더에서도 명령을 보이고 1로 끝난다', async () => {
    // no site/ at all: even a run that ignored --dry-run and the failed checks would have no folder to start in
    const bare = folder({ 'package.json': PKG });
    const r = await script(['deploy', '--dry-run', '--root', bare]);
    assert.equal(r.code, 1, r.out + r.err);
    for (const line of [...DEPLOYS, ...urls]) assert.ok(r.out.includes(`  ${line}`), line);
    assert.match(r.out, /✖ 배포 설정: site\/에 wrangler\.jsonc, wrangler\.old-worker\.jsonc 파일이 없습니다/);
    assert.match(r.out, /✖ 올릴 zip \(site\/public\/download\): meta\.json이 없습니다/);
    assert.match(r.out, /✖ git: /);
    assert.match(r.err, /--dry-run: 배포 전 확인 3개가 통과하지 못했습니다/);
    assert.deepEqual(readdirSync(bare), ['package.json'], '아무것도 만들지 않는다');
  });

  it('Pages, 옛 Worker 순서로 site/에서 올리고, 두 주소의 meta.json과 zip을 확인한다', async () => {
    const r = await cli(['deploy', '--root', root], { fetch: served({ [PAGES]: good, [WORKER]: good }) });
    assert.equal(r.code, 0, r.out);
    assert.deepEqual(
      r.ran.map((s) => [s.cwd, s.tool, s.args]),
      [
        [join(root, 'site'), 'npx', ['--yes', 'wrangler@4', 'pages', 'deploy']],
        [join(root, 'site'), 'npx', ['--yes', 'wrangler@4', 'deploy', '--config', 'wrangler.old-worker.jsonc']],
      ],
    );
    assert.deepEqual([...r.fetched].sort(), [...urls].sort());
    assert.equal(r.slept, 0);
    for (const url of urls) assert.ok(r.out.includes(`✔ ${url}`), url);
    // the last step is the user's
    assert.match(r.out, /남은 일: npm에 올리기[\s\S]*npm publish \.\/release\/seojin08-skill-finder-1\.4\.0\.tgz --access public/);
    assert.match(r.out, /release\/ 폴더에 seojin08-skill-finder-1\.4\.0\.tgz 파일이 지금 없습니다/);
  });

  it('배포 전 확인이 하나라도 걸리면 아무것도 올리지 않는다', async () => {
    const blocked = async (message: RegExp, failed = 1) => {
      const r = await cli(['deploy', '--root', root], { fetch: served({ [PAGES]: good, [WORKER]: good }) });
      assert.equal(r.code, 1, r.out);
      assert.match(r.out, message);
      assert.ok(r.out.includes(`배포 전 확인 ${failed}개가 통과하지 못해 아무것도 올리지 않았습니다`), r.out);
      assert.deepEqual([r.ran, r.fetched], [[], []], String(message));
    };
    const meta = join(root, 'site', 'public', 'download', 'meta.json');
    const zip = join(root, 'site', 'public', 'download', 'skill-finder-win.zip');
    const withFile = async (path: string, data: string | Buffer | null, message: RegExp, failed = 1) => {
      const was = readFileSync(path);
      if (data === null) rmSync(path);
      else writeFileSync(path, data);
      try {
        await blocked(message, failed);
      } finally {
        writeFileSync(path, was);
      }
    };

    // the download is from another build: an older version, no file, a different zip, another key's signature
    await withFile(meta, JSON.stringify(signedMeta('1.3.9', ZIP)), /✖ 올릴 zip .*: zip은 1\.3\.9인데 package\.json은 1\.4\.0입니다\. node scripts\/release\.mjs build/);
    await withFile(meta, null, /✖ 올릴 zip .*: meta\.json이 없습니다/);
    await withFile(zip, Buffer.from('another build of the same version'), /✖ 올릴 zip .*: skill-finder-win\.zip이 meta\.json의 크기·SHA-256과 다릅니다/);
    await withFile(meta, JSON.stringify(signedMeta('1.4.0', ZIP, OTHER_KEY.privateKey)), /✖ 올릴 zip .*: meta\.json: 서명이 맞지 않습니다/);
    // a checkout from before the old Worker's configuration was in the repo (the deleted file is also uncommitted)
    await withFile(join(root, 'site', 'wrangler.old-worker.jsonc'), null, /✖ 배포 설정: site\/에 wrangler\.old-worker\.jsonc 파일이 없습니다/, 2);

    // something not committed: a changed file, or a new one that would be published with the rest
    await withFile(join(root, 'CHANGELOG.md'), 'changed', /✖ 커밋 상태: 커밋하지 않은 변경 1개 \(CHANGELOG\.md\)/);
    writeFileSync(join(root, 'site', 'public', '새 파일.html'), 'not committed');
    try {
      await blocked(/✖ 커밋 상태: 커밋하지 않은 변경 1개 \(site\/public\/새 파일\.html\)/);
    } finally {
      rmSync(join(root, 'site', 'public', '새 파일.html'));
    }

    // not pushed: origin/main is a commit behind, or was never there
    git(root, 'update-ref', 'refs/remotes/origin/main', first);
    try {
      await blocked(/✖ push 상태: main이 origin\/main과 다릅니다: push하지 않은 커밋 1개 \(git push origin main\)/);
      git(root, 'update-ref', '-d', 'refs/remotes/origin/main');
      await blocked(/✖ push 상태: origin\/main이 없습니다/);
    } finally {
      git(root, 'update-ref', 'refs/remotes/origin/main', head);
    }

    // another branch at the same commit: wrangler would make it a Pages preview
    git(root, 'update-ref', 'refs/heads/next', head);
    git(root, 'symbolic-ref', 'HEAD', 'refs/heads/next');
    try {
      await blocked(/✖ push 상태: 지금 브랜치는 next입니다\. main에서 배포하세요/);
    } finally {
      git(root, 'symbolic-ref', 'HEAD', 'refs/heads/main');
      git(root, 'update-ref', '-d', 'refs/heads/next');
    }

    // and back as it was: ready again
    assert.equal((await cli(['deploy', '--dry-run', '--root', root])).code, 0);
  });

  it('zip을 만든 뒤 커밋이 더해졌거나 빌드 기록이 맞지 않으면 올리지 않는다 (리뷰 2026-11-11)', async () => {
    const note = join(root, 'release', 'built-from.json');
    const blocked = async (data: string | null, message: RegExp) => {
      if (data === null) rmSync(note);
      else writeFileSync(note, data);
      const r = await cli(['deploy', '--root', root], { fetch: served({ [PAGES]: good, [WORKER]: good }) });
      assert.equal(r.code, 1, r.out);
      assert.match(r.out, message);
      assert.ok(r.out.includes('배포 전 확인 1개가 통과하지 못해 아무것도 올리지 않았습니다'), r.out);
      assert.deepEqual([r.ran, r.fetched], [[], []], String(message));
    };
    try {
      // built at the commit before: everything else (version, signature, clean, pushed) still passes
      await blocked(builtFrom(first), new RegExp(`✖ zip을 만든 커밋: zip은 ${first.slice(0, 7)}에서 만들었는데 지금은 ${head.slice(0, 7)}입니다`));
      await blocked(builtFrom(head, { dirty: true }), /✖ zip을 만든 커밋: zip을 --dirty로 만들었습니다/);
      await blocked(builtFrom(head, { sha256: '0'.repeat(64) }), /✖ zip을 만든 커밋: 빌드 기록이 지금 zip의 것이 아닙니다/);
      await blocked(null, /✖ zip을 만든 커밋: 빌드 기록\(release\/built-from\.json\)이 없습니다\. node scripts\/release\.mjs build/);

      // `build` writes the note after the zip step: this commit, this zip, and whether --dirty was given
      const built = await cli(['build', '--root', root, '--dirty']);
      assert.equal(built.code, 0, built.out);
      assert.deepEqual(JSON.parse(readFileSync(note, 'utf8')), JSON.parse(builtFrom(head, { dirty: true })));
      assert.equal((await cli(['build', '--root', root])).code, 0);
      assert.deepEqual(JSON.parse(readFileSync(note, 'utf8')), JSON.parse(builtFrom(head)));
    } finally {
      writeFileSync(note, builtFrom(head));
    }
    const ready = await cli(['deploy', '--dry-run', '--root', root]);
    assert.equal(ready.code, 0, ready.out);
    assert.match(ready.out, new RegExp(`✔ zip을 만든 커밋: ${head.slice(0, 7)}`));
  });

  it('실제 배포는 origin에 직접 물어 main이 같은지 본다: 다른 곳에서 push했을 수 있다 (리뷰 2026-11-11)', async () => {
    // a remote on this disk: asking it needs no network
    const bare = join(tmp, 'origin.git');
    git(tmp, 'init', '--quiet', '--bare', '-b', 'main', bare);
    git(root, 'remote', 'add', 'origin', bare);
    try {
      git(root, 'push', '--quiet', 'origin', 'main');
      const ok = await cli(['deploy', '--root', root], { fetch: served({ [PAGES]: good, [WORKER]: good }) });
      assert.equal(ok.code, 0, ok.out);
      assert.match(ok.out, new RegExp(`✔ push 상태: main = origin/main \\(${head.slice(0, 7)}, origin에 확인\\)`));

      // origin's main changed after the last fetch here: the local tracking ref still says "the same"
      git(bare, 'update-ref', 'refs/heads/main', first);
      assert.equal(git(root, 'rev-parse', 'refs/remotes/origin/main'), head);
      const r = await cli(['deploy', '--root', root], { fetch: served({ [PAGES]: good, [WORKER]: good }) });
      assert.equal(r.code, 1, r.out);
      assert.match(r.out, /✖ push 상태: main이 origin\/main과 다릅니다/);
      assert.deepEqual([r.ran, r.fetched], [[], []]);
      // --dry-run asks nothing of the remote and reads the local ref
      const dry = await cli(['deploy', '--dry-run', '--root', root]);
      assert.equal(dry.code, 0, dry.out);
      assert.match(dry.out, new RegExp(`✔ push 상태: main = origin/main \\(${head.slice(0, 7)}\\)`));

      // a remote that cannot be reached stops the deploy
      git(root, 'remote', 'set-url', 'origin', join(tmp, 'no-such-remote.git'));
      const gone = await cli(['deploy', '--root', root], { fetch: served({ [PAGES]: good, [WORKER]: good }) });
      assert.equal(gone.code, 1, gone.out);
      assert.match(gone.out, /✖ push 상태: origin에 main의 커밋을 물어보지 못했습니다/);
      assert.deepEqual(gone.ran, []);
    } finally {
      git(root, 'remote', 'remove', 'origin');
      git(root, 'update-ref', 'refs/remotes/origin/main', head);
    }
  });

  it('첫 배포가 실패하면 둘째는 하지 않고, 둘째가 실패하면 첫째는 올라갔다고 알린다', async () => {
    const failing = (arg: string) => (step: Step) => {
      if (step.args.includes(arg)) throw Object.assign(new Error('Command failed'), { status: 1 });
    };
    const pages = await cli(['deploy', '--root', root], { run: failing('pages'), fetch: served({ [PAGES]: good, [WORKER]: good }) });
    assert.equal(pages.code, 1);
    assert.equal(pages.ran.length, 1, '옛 Worker는 시도하지 않는다');
    assert.match(pages.out, /소개 페이지\(Pages\)에 올리지 못했습니다 \(종료 코드 1\)\. 아무것도 올라가지 않았습니다/);
    assert.deepEqual(pages.fetched, []);

    const worker = await cli(['deploy', '--root', root], { run: failing('--config'), fetch: served({ [PAGES]: good, [WORKER]: good }) });
    assert.equal(worker.code, 1);
    assert.equal(worker.ran.length, 2);
    assert.match(worker.out, /옛 업데이트 주소\(Worker\)에 올리지 못했습니다 \(종료 코드 1\)\. 소개 페이지\(Pages\)에는 이미 올라갔습니다/);
    assert.deepEqual(worker.fetched, []);
  });

  it('올린 직후 옛 버전이 보이면 다시 확인하고, 끝내 아니면 1로 끝난다', async () => {
    const old = { meta: JSON.stringify(signedMeta('1.3.9', Buffer.from('the previous zip'))), zip: Buffer.from('the previous zip') };
    // the Worker answers with the previous release twice, then with the new one
    let asked = 0;
    const late = async (url: string) => served({ [PAGES]: good, [WORKER]: url === urls[2] && asked++ < 2 ? old : good })(url);
    const r = await cli(['deploy', '--root', root], { fetch: late });
    assert.equal(r.code, 0, r.out);
    assert.equal(r.slept, 2);
    assert.match(r.out, /✖ .*workers\.dev\/download\/meta\.json: 버전이 1\.3\.9입니다 \(기대: 1\.4\.0\)/);
    assert.match(r.out, /5초 뒤 다시 확인합니다 \(1\/6\)/);
    assert.equal(r.fetched.filter((u) => u === urls[1]).length, 1, '통과한 주소의 zip은 다시 받지 않는다');
    assert.equal(r.fetched.filter((u) => u === urls[3]).length, 1, '옛 버전을 주는 동안에는 zip을 받지 않는다');

    const never = await cli(['deploy', '--root', root], { fetch: served({ [PAGES]: good, [WORKER]: old }) });
    assert.equal(never.code, 1);
    assert.equal(never.ran.length, 2, '올리기는 끝났다');
    assert.equal(never.slept, 5);
    assert.match(never.out, /주소 확인 1개가 통과하지 못했습니다\. 올리기는 끝났습니다\. 잠시 뒤 node scripts\/release\.mjs verify로 다시 확인하세요/);
    assert.ok(!never.out.includes('npm publish'), '확인이 안 됐으면 npm에 올리라고 하지 않는다');
  });

  it('verify: 두 주소가 서명된 이 버전과 그 zip을 줄 때만 통과한다 (읽기만)', async () => {
    const only = folder({ 'package.json': PKG });
    const check = async (worker: { meta?: string; zip?: Buffer }) => cli(['verify', '--root', only], { fetch: served({ [PAGES]: good, [WORKER]: worker }) });

    const ok = await check(good);
    assert.equal(ok.code, 0, ok.out);
    assert.deepEqual([...ok.fetched].sort(), [...urls].sort());
    assert.deepEqual([ok.ran, ok.slept], [[], 0], '실행도, 다시 묻기도 없다');
    assert.match(ok.out, /✔ .*pages\.dev\/download\/meta\.json: 1\.4\.0, 서명 맞음, 변경 기록 2줄/);
    assert.match(ok.out, /✔ .*workers\.dev\/download\/skill-finder-win\.zip: 200, 0\.0MB, SHA-256이 meta\.json과 같음/);
    assert.match(ok.out, /npm publish \.\/release\/seojin08-skill-finder-1\.4\.0\.tgz --access public/);

    const cases: [{ meta?: string; zip?: Buffer }, RegExp][] = [
      [{ meta: JSON.stringify(signedMeta('1.3.9', ZIP)), zip: ZIP }, /meta\.json: 버전이 1\.3\.9입니다 \(기대: 1\.4\.0\)/],
      [{ meta: JSON.stringify(signedMeta('1.4.0', ZIP, OTHER_KEY.privateKey)), zip: ZIP }, /meta\.json: 서명이 맞지 않습니다/],
      [{ meta: JSON.stringify({ ...signedMeta('1.4.0', ZIP), notes: ['서명한 뒤 바꾼 글'] }), zip: ZIP }, /meta\.json: 변경 기록이 없거나 그 서명이 맞지 않습니다/],
      [{ meta: JSON.stringify({ ...signedMeta('1.4.0', ZIP), bytes: ZIP.length + 1 }), zip: ZIP }, /meta\.json: 서명이 맞지 않습니다/],
      // a missing file answered with the landing page and 200
      [{ meta: '<!doctype html><title>Skill Finder</title>', zip: ZIP }, /meta\.json: JSON이 아닙니다/],
      [{ zip: ZIP }, /meta\.json: 응답 404/],
      [{ meta: good.meta, zip: Buffer.from('the previous zip') }, /skill-finder-win\.zip: meta\.json이 말하는 파일이 아닙니다/],
      [{ meta: good.meta }, /skill-finder-win\.zip: 응답 404/],
    ];
    for (const [worker, message] of cases) {
      const r = await check(worker);
      assert.equal(r.code, 1, String(message));
      assert.match(r.out, new RegExp(`✖ .*workers\\.dev/download/${message.source}`));
      assert.match(r.out, /✔ .*pages\.dev\/download\/skill-finder-win\.zip/, '다른 주소의 결과도 함께 보인다');
      assert.match(r.out, /주소 확인 1개가 통과하지 못했습니다/);
      assert.equal(r.slept, 0, 'verify는 한 번만 묻는다');
    }

    // no answer at all
    const offline = await cli(['verify', '--root', only], {
      fetch: async () => {
        throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } });
      },
    });
    assert.equal(offline.code, 1);
    assert.match(offline.out, /meta\.json: 받지 못했습니다 \(ENOTFOUND\)/);
    assert.match(offline.out, /주소 확인 2개가 통과하지 못했습니다/);
  });

  it('스크립트의 실행기는 테스트 러너 아래에서 명령을 실행하지 않는다', () => {
    // the runner sets it for this file already; set here too so the test means the same when the file is run alone
    const was = process.env.NODE_TEST_CONTEXT;
    process.env.NODE_TEST_CONTEXT = was ?? 'child-v8';
    try {
      assert.throws(() => release.runStep({ title: '아무 일도 하지 않는 명령', cwd: tmp, tool: 'node', args: ['-e', ''] }), /테스트 안에서는 실제 명령을 실행하지 않습니다: node -e/);
    } finally {
      if (was === undefined) delete process.env.NODE_TEST_CONTEXT;
    }
  });
});
