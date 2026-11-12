// Paths and folder names compared as each platform's file systems tell them apart (CI review, 2026-11-12): any case
// on Windows and macOS, as written on Linux, and either slash only on Windows. Until then every platform got
// Windows' rule, so on Linux `.Claude/skills` passed for `.claude/skills`.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { describe, it } from 'node:test';
import { pathKey, pathWithin, sameName } from '../src/install/installed.ts';
import { skillFolderTarget } from '../src/install/quarantine.ts';
import { claudeSkillFolder } from '../src/routes/changes.ts';

const win = process.platform === 'win32';
const anyCase = win || process.platform === 'darwin';

describe('경로 비교 규칙 (OS별)', () => {
  it('pathKey: 끝 구분자는 빼고, 대소문자는 Windows·macOS에서만, /와 \\는 Windows에서만 같게 본다', () => {
    const p = join('base', 'Proj');
    assert.equal(pathKey(p + sep), pathKey(p));
    assert.equal(pathKey(p) === pathKey(p.toLowerCase()), anyCase);
    assert.equal(pathKey('a/b') === pathKey('a\\b'), win, '\\는 Windows 밖에서는 이름의 글자');
    assert.equal(sameName('Skills', 'skills'), anyCase);
    assert.ok(sameName('skills', 'skills'));
  });

  it('pathWithin: 그 폴더나 그 안이면 참, 이름이 같은 앞부분만 겹치면 거짓', () => {
    const root = join('base', 'proj');
    assert.ok(pathWithin(root, root));
    assert.ok(pathWithin(join(root, 'src', 'x'), root));
    assert.ok(!pathWithin(join('base', 'project2'), root), '앞부분만 같은 다른 폴더');
    assert.equal(pathWithin(join('BASE', 'Proj', 'src'), root), anyCase);
    // a parent written with its trailing separator, and the root of the file system
    assert.ok(pathWithin(join(root, 'src'), root + sep));
    assert.ok(!pathWithin(join('base', 'project2'), root + sep));
    const top = win ? 'C:\\' : '/';
    assert.ok(pathWithin(win ? 'C:\\work\\a' : '/work/a', top));
    if (win) assert.ok(!pathWithin('D:\\work\\a', top), '다른 드라이브');
  });

  it('보관함 복원 위치와 차이 보기: 대소문자만 다른 폴더는 Linux에서 에이전트 폴더가 아니다', () => {
    const home = mkdtempSync(join(tmpdir(), 'sf-pathkey-'));
    assert.equal(skillFolderTarget('user', null, join(home, '.claude', 'skills', 'x'), home), join(home, '.claude', 'skills', 'x'));
    const otherCase = join(home, '.Claude', 'skills', 'x');
    assert.equal(skillFolderTarget('user', null, otherCase, home) !== null, anyCase);
    assert.equal(claudeSkillFolder(otherCase, home) !== null, anyCase);
    assert.equal(claudeSkillFolder(join(home, '.claude', 'Skills', 'x'), home) !== null, anyCase);
    assert.ok(claudeSkillFolder(join(home, '.claude', 'skills', 'x'), home));
  });
});
