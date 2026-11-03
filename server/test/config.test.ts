import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

describe('설정 파일과 버전 (전체 점검 3차)', () => {
  it('토큰은 임시 파일에 쓴 뒤 이름을 바꿔 .env에 넣고, 다른 줄은 그대로 둔다', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sf-env-'));
    const env = join(dir, '.env');
    writeFileSync(env, 'OTHER=1\nGITHUB_TOKEN=old\n');
    // config.ts reads the path once, when first imported in this test process
    process.env.SKILL_FINDER_ENV_PATH = env;
    const { config, saveGithubToken } = await import('../src/config.ts');
    saveGithubToken('github_pat_new');
    assert.equal(readFileSync(env, 'utf8'), 'OTHER=1\nGITHUB_TOKEN=github_pat_new\n');
    assert.deepEqual(readdirSync(dir), ['.env'], '임시 파일이 남지 않음');
    assert.equal(config.githubToken, 'github_pat_new');
  });

  it('앱 버전은 루트 package.json 한 곳에만 있다', () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
    const pkg = (p: string) => JSON.parse(readFileSync(join(root, p), 'utf8')) as { version?: string };
    assert.match(pkg('package.json').version ?? '', /^\d+\.\d+\.\d+$/);
    assert.equal(pkg('server/package.json').version, undefined, 'server/package.json에 버전을 두지 않음');
    assert.equal(pkg('web/package.json').version, undefined, 'web/package.json에 버전을 두지 않음');
  });

  it('skills CLI는 정확한 버전으로 고정하고, 보여 주는 명령의 버전은 설치된 패키지에서 읽는다', async () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
    const pin = (JSON.parse(readFileSync(join(root, 'server', 'package.json'), 'utf8')) as { dependencies: Record<string, string> }).dependencies.skills;
    assert.match(pin, /^\d+\.\d+\.\d+$/, '범위(^, ~) 없이 고정');
    const { SKILLS_CLI_VERSION } = await import('../src/config.ts');
    assert.equal(SKILLS_CLI_VERSION, pin);
  });
});
