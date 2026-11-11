// Stage 3, bundle D (feature review 2026-11-04): the page's side of F19 (filters sent to the server, the same
// conditions as server/src/search/facets.ts) and F20 (which repo a result comes from).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { runFeatures } from '../../server/src/search/facets.ts';
import { itemRepo, ownerOf } from '../src/lib/ownerPrefs.ts';
import { browseQuery, itemRunFeatures, itemUpdatedWithin, RUN_FEATURES, sameFacets, toServerFacets, UPDATED_WITHIN } from '../src/lib/searchExtras.ts';
import * as serverFacets from '../../server/src/search/facets.ts';

const NONE = { trust: [], category: [], method: [] };

describe('F19 전체에서 다시 찾기: 보내는 조건', () => {
  it('고른 것이 없으면 null(보통 검색), 있으면 정렬해 보낸다', () => {
    assert.equal(toServerFacets(NONE), null);
    assert.equal(toServerFacets({ ...NONE, license: [], run: [], updated: [], owner: [], trusted: [] }), null);
    assert.deepEqual(toServerFacets({ trust: ['partner', 'official'], category: ['security'], method: [], updated: ['90d'], trusted: ['trusted'], owner: ['b', 'a'] }), {
      trust: ['official', 'partner'],
      category: ['security'],
      updated: '90d',
      trusted: true,
      owner: ['a', 'b'],
    });
    assert.ok(sameFacets(NONE, null));
    assert.ok(sameFacets({ ...NONE, category: ['a', 'b'] }, { ...NONE, category: ['b', 'a'] }));
    assert.ok(!sameFacets({ ...NONE, category: ['a'] }, null));
  });

  it('값 목록은 서버와 같다', () => {
    assert.deepEqual([...RUN_FEATURES], [...serverFacets.RUN_FEATURES]);
    assert.deepEqual([...UPDATED_WITHIN], [...serverFacets.UPDATED_WITHIN]);
  });

  it('실행 특성은 서버의 runFeatures와 같게 판정한다', () => {
    const cases: Array<[string[], boolean]> = [
      [[], false],
      [['preapprovedBash'], false],
      [['unscopedBash', 'pluginMcp'], true],
      [['skillHooks'], true],
      [['scripts', 'rmRf'], false],
    ];
    for (const [flags, manual] of cases) {
      assert.deepEqual(itemRunFeatures({ riskFlags: flags, ...(manual ? { manualOnly: true as const } : {}) }), runFeatures(flags, manual), flags.join(','));
    }
  });

  it('업데이트 창: 30일 안이면 90일·1년에도 든다, 모르면 없음', () => {
    const now = Date.parse('2026-11-09T00:00:00Z');
    assert.deepEqual(itemUpdatedWithin({ lastCommitAt: '2026-11-01T00:00:00Z' }, now), ['30d', '90d', '1y']);
    assert.deepEqual(itemUpdatedWithin({ lastCommitAt: '2026-06-01T00:00:00Z' }, now), ['1y']);
    assert.deepEqual(itemUpdatedWithin({ lastCommitAt: '2020-01-01T00:00:00Z' }, now), []);
    assert.deepEqual(itemUpdatedWithin({}, now), []);
  });
});

describe('F20 결과의 저장소', () => {
  it('GitHub 색인 id에서, 아니면 자기 출처 링크에서 owner/repo를 소문자로', () => {
    assert.equal(itemRepo({ id: 'gh:Obra/Superpowers:skills/tdd', sources: [] }), 'obra/superpowers');
    assert.equal(
      itemRepo({ id: 'pdf@anthropic-agent-skills:pdf', sources: [{ kind: 'marketplace', label: '공식', url: 'https://github.com/anthropics/skills/tree/abc/skills/pdf' }] }),
      'anthropics/skills',
    );
    assert.equal(itemRepo({ id: 'wk:docs.example.com:x', sources: [{ kind: 'skillssh', label: 'skills.sh', url: 'https://skills.sh/docs.example.com/x' }] }), null);
    assert.equal(ownerOf('Obra/Superpowers'), 'obra');
    assert.equal(ownerOf(null), null);
  });

  it('둘러보기 주소: showHidden은 켰을 때만', () => {
    assert.equal(browseQuery({ cat: 'testing' }, 1, 'medium', false).showHidden, undefined);
    assert.equal(browseQuery({ cat: 'testing' }, 1, 'medium', false, true).showHidden, '1');
  });
});
