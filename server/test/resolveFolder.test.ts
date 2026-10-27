import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { isPlainFolderName, resolveDroppedFolder } from '../src/util/resolveFolder.ts';

describe('끌어다 놓은 폴더 경로 찾기', () => {
  it('이름과 안의 파일이 맞는 폴더를 찾고, 이름만 같은 폴더는 거른다', () => {
    const root = mkdtempSync(join(tmpdir(), 'sf-drop-'));
    try {
      const real = join(root, 'work', 'my-app');
      const decoy = join(root, 'old', 'my-app');
      mkdirSync(join(real, 'src'), { recursive: true });
      writeFileSync(join(real, 'package.json'), '{}');
      writeFileSync(join(real, 'README.md'), '#');
      mkdirSync(decoy, { recursive: true });
      writeFileSync(join(decoy, 'notes.txt'), '');
      // the hint's parent is searched first, so the temp tree is found without walking the whole home
      const matches = resolveDroppedFolder('my-app', ['package.json', 'README.md', 'src'], [join(root, 'work', 'x'), join(root, 'old', 'x')]);
      assert.equal(matches[0]?.path, real);
      assert.ok(!matches.some((m) => m.path === decoy));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('폴더 이름은 경로 한 조각만 허용한다', () => {
    assert.ok(isPlainFolderName('my-app'));
    assert.ok(!isPlainFolderName('../etc'));
    assert.ok(!isPlainFolderName('a/b'));
    assert.ok(!isPlainFolderName('..'));
  });
});
