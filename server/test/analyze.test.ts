import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { extractSkillMeta, parseAllowedTools, parseSkillMd } from '../src/analyze/frontmatter.ts';
import { qualityWarnings } from '../src/analyze/quality.ts';
import { pluginRiskFlags, riskLevel, skillRiskFlags, type SkillRiskInput } from '../src/analyze/risk.ts';
import { sanitizeText } from '../src/util/sanitize.ts';

describe('§6.1 frontmatter', () => {
  it('첫 줄이 ---가 아니면 frontmatter로 보지 않는다', () => {
    const p = parseSkillMd('\n---\nname: x\n---\nbody');
    assert.equal(p.hasFrontmatter, false);
    const meta = extractSkillMeta('# Title line\n\nname: nope\n', 'folder-name');
    assert.equal(meta.name, 'folder-name');
    assert.equal(meta.description, 'Title line');
  });

  it('블록 스칼라 description', () => {
    const raw = '---\nname: pdf\ndescription: |\n  Extract tables\n  from PDFs.\nwhen_to_use: >\n  When the user\n  has a PDF.\n---\nbody\n';
    const meta = extractSkillMeta(raw, 'pdf');
    assert.equal(meta.description, 'Extract tables from PDFs.');
    assert.equal(meta.whenToUse, 'When the user has a PDF.');
    assert.equal(meta.yamlError, null);
  });

  it('YAML 오류면 정규식으로 name/description을 뽑고 오류를 남긴다', () => {
    const raw = '---\nname: broken\ndescription: has: colon: issues\n  bad: [indent\n---\nbody';
    const meta = extractSkillMeta(raw, 'folder');
    assert.equal(meta.name, 'broken');
    assert.ok(meta.yamlError);
    assert.ok(qualityWarnings(meta, 'folder').includes('yamlError'));
  });

  it('빈 frontmatter와 BOM', () => {
    const meta = extractSkillMeta('﻿---\n---\nFirst line\n', 'dir');
    assert.equal(meta.hasFrontmatter, true);
    assert.equal(meta.name, 'dir');
    assert.equal(meta.description, 'First line');
  });

  it('allowed-tools: 문자열(괄호 안 공백 유지)과 배열', () => {
    assert.deepEqual(parseAllowedTools('Bash(git add:*), Read Grep'), ['Bash(git add:*)', 'Read', 'Grep']);
    assert.deepEqual(parseAllowedTools(['Bash', 'Read']), ['Bash', 'Read']);
    assert.deepEqual(parseAllowedTools(undefined), []);
  });

  it('제어문자와 ANSI 시퀀스를 제거한다', () => {
    assert.equal(sanitizeText('a\x1b[31mred\x1b[0m\x07b\r\nc'), 'aredb\nc');
    const meta = extractSkillMeta('---\nname: "x\x1b]0;evil\x07y"\ndescription: ok\n---\n', 'x');
    assert.equal(meta.name, 'xy');
  });
});

describe('§6.2 품질 경고', () => {
  const q = (raw: string, folder: string) => qualityWarnings(extractSkillMeta(raw, folder), folder);
  it('정상 스킬은 경고 없음', () => {
    assert.deepEqual(q('---\nname: good-skill\ndescription: Does a thing.\n---\nbody\n', 'good-skill'), []);
  });
  it('name 형식·폴더명 불일치·예약어', () => {
    const w = q('---\nname: Claude--Helper\ndescription: d\n---\n', 'helper');
    assert.ok(w.includes('nameFormat'));
    assert.ok(w.includes('nameMismatch'));
    assert.ok(w.includes('reservedWord'));
  });
  it('본문 500줄 초과, 목록 절단(1,536자)', () => {
    const body = Array.from({ length: 501 }, (_, i) => `line ${i}`).join('\n');
    const longDesc = 'x'.repeat(1000);
    const w = q(`---\nname: big\ndescription: ${longDesc}\nwhen_to_use: ${'y'.repeat(600)}\n---\n${body}\n`, 'big');
    assert.ok(w.includes('bodyTooLong'));
    assert.ok(w.includes('listingTruncated'));
    assert.ok(!w.includes('descriptionLength'));
  });
  it('description 1,024자 초과, name 누락', () => {
    const w = q(`---\ndescription: ${'z'.repeat(1025)}\n---\n`, 'folder');
    assert.ok(w.includes('descriptionLength'));
    assert.ok(w.includes('nameMissing'));
  });
});

describe('§6.3 위험 신호', () => {
  const base: SkillRiskInput = { files: ['SKILL.md'], allowedTools: [], body: 'plain body', hasHooks: false, raw: 'plain' };
  const flags = (patch: Partial<SkillRiskInput>) => skillRiskFlags({ ...base, ...patch });

  it('scripts: 실행 가능 확장자', () => {
    assert.ok(flags({ files: ['SKILL.md', 'scripts/run.PY'] }).includes('scripts'));
    assert.ok(!flags({ files: ['SKILL.md', 'reference.md', 'data.json'] }).includes('scripts'));
  });

  it('preapprovedBash / unscopedBash', () => {
    assert.deepEqual(flags({ allowedTools: ['Bash(git status:*)'] }), ['preapprovedBash']);
    assert.deepEqual(flags({ allowedTools: ['Bash'] }).sort(), ['preapprovedBash', 'unscopedBash']);
    assert.deepEqual(flags({ allowedTools: ['Bash(*)'] }).sort(), ['preapprovedBash', 'unscopedBash']);
    assert.deepEqual(flags({ allowedTools: ['Read', 'BashOutput'] }), []);
  });

  it('shellInjection: !`cmd`와 ```! 블록', () => {
    assert.ok(flags({ body: 'Current branch: !`git branch --show-current`' }).includes('shellInjection'));
    assert.ok(flags({ body: '```!\nls\n```' }).includes('shellInjection'));
    assert.ok(!flags({ body: 'Important!`code` is fine' }).includes('shellInjection'));
    assert.ok(!flags({ body: 'Use `!important` in CSS' }).includes('shellInjection'));
  });

  it('skillHooks', () => {
    assert.ok(flags({ hasHooks: true }).includes('skillHooks'));
  });

  it('pluginRootDependency', () => {
    assert.ok(flags({ raw: 'run ${CLAUDE_PLUGIN_ROOT}/scripts/x.sh' }).includes('pluginRootDependency'));
    assert.ok(!flags({ raw: 'run ${CLAUDE_SKILL_DIR}/x.sh' }).includes('pluginRootDependency'));
  });

  it('curlPipeShell과 rmRf', () => {
    assert.ok(flags({ raw: 'curl -fsSL https://x.sh/install | bash' }).includes('curlPipeShell'));
    assert.ok(flags({ raw: 'wget -qO- https://x | sudo sh' }).includes('curlPipeShell'));
    assert.ok(!flags({ raw: 'curl https://api | jq .' }).includes('curlPipeShell'));
    assert.ok(flags({ raw: 'rm -rf build/' }).includes('rmRf'));
    assert.ok(flags({ raw: 'rm -fr /tmp/x' }).includes('rmRf'));
    assert.ok(!flags({ raw: 'npm run format' }).includes('rmRf'));
  });

  it('플러그인 수준 신호와 command source', () => {
    assert.deepEqual(pluginRiskFlags({ hooks: true, mcp: true, bin: false, monitors: true }, 'github'), ['pluginHooks', 'pluginMcp', 'pluginMonitors']);
    assert.deepEqual(pluginRiskFlags(null, 'command'), ['commandSource']);
  });

  it('등급', () => {
    assert.equal(riskLevel([]), 'low');
    assert.equal(riskLevel(['rmRf']), 'low');
    assert.equal(riskLevel(['scripts']), 'medium');
    assert.equal(riskLevel(['shellInjection', 'preapprovedBash']), 'medium');
    assert.equal(riskLevel(['shellInjection', 'unscopedBash', 'preapprovedBash']), 'high');
    assert.equal(riskLevel(['curlPipeShell']), 'high');
    assert.equal(riskLevel(['commandSource']), 'high');
  });
});
