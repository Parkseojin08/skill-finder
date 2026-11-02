import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { TreeIndex } from '../src/discovery/tree.ts';
import { buildSkillRow } from '../src/indexer.ts';
import { rawRequest, startTestServer } from './helpers.ts';

const md = (name: string, extra = '') => `---\nname: ${name}\ndescription: ${name} helper for tests.\n${extra}---\nBody\n`;

describe('팀 프리셋 가져오기 (사용자 결정 2026-11-02)', () => {
  it('이 PC의 색인으로 찾아 설치 목록을 만들고, 없는 것은 따로 알린다', async () => {
    const srv = await startTestServer();
    try {
      const { store } = srv.ctx;
      const generic = buildSkillRow({ repo: 'a/b', sha: '0'.repeat(40), dirPath: 'skills/web-guide', raw: md('web-guide'), tree: new TreeIndex([]), origin: 'generic', pluginId: null, extraFlags: [], install: null, lastCommitAt: null });
      store.upsertSkill(generic, '');
      store.upsertPlugin({ id: 'tools@claude-plugins-official', marketplace: 'claude-plugins-official', name: 'tools', display_name: null, description: 'tools plugin', category: null, keywords: null, source_json: '"./"', source_kind: 'relative', repo: 'o/tools', path: null, ref: null, sha: 'a'.repeat(40), strict: null, entry_json: null });
      for (const name of ['lint', 'format']) {
        store.upsertSkill(buildSkillRow({ repo: 'o/tools', sha: 'a'.repeat(40), dirPath: `skills/${name}`, raw: md(name), tree: new TreeIndex([]), origin: 'plugin', pluginId: 'tools@claude-plugins-official', extraFlags: [], install: null, lastCommitAt: null }), '');
      }
      // an unknown repo is read first; keep the test offline
      let indexed = 0;
      srv.ctx.indexer.indexRepo = async () => {
        indexed++;
        return { skills: 0, sha: 'x', unchanged: false, removed: 0 };
      };
      const headers = { 'X-Skill-Finder': '1', Origin: `http://127.0.0.1:${srv.port}`, 'Content-Type': 'application/json' };
      const items = [
        { id: generic.id, name: 'web-guide' },
        { plugin: 'tools@claude-plugins-official', name: 'tools' },
        { id: store.listSkillsByPlugin('tools@claude-plugins-official')[1].id, name: 'format' }, // the same plugin again: listed once
        { id: 'gh:nobody/nothing:skills/x', name: 'x' },
        { id: 'gh:bad repo/../x:y', name: 'bad' }, // not a repo name: never read
      ];
      const r = await rawRequest({ port: srv.port, method: 'POST', path: '/api/presets/resolve', headers, body: JSON.stringify({ items }) });
      assert.equal(r.status, 200, r.body);
      const out = JSON.parse(r.body) as { skills: Array<{ id: string; name: string; method: string; installable: boolean }>; missing: Array<{ name: string }> };
      assert.deepEqual(
        out.skills.map((s) => s.name),
        ['web-guide', 'tools (플러그인)'],
      );
      assert.equal(out.skills[0].method, 'skills-cli');
      assert.equal(out.skills[1].method, 'plugin');
      assert.deepEqual(out.missing.map((m) => m.name), ['x', 'bad']);
      assert.equal(indexed, 1, '모르는 저장소는 읽어 보되, 저장소 이름이 아니면 읽지 않음');

      const bad = await rawRequest({ port: srv.port, method: 'POST', path: '/api/presets/resolve', headers, body: JSON.stringify({ items: 'nope' }) });
      assert.equal(bad.status, 400);
    } finally {
      await srv.close();
    }
  });
});
