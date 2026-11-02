// Web pure modules, run with node --test (project review 2026-11-02 #12: the web had no tests).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as server from '../../server/src/search/pipeline.ts';
import { foldResults, nameMatches, navigationalWord, SORTS } from '../src/lib/resultOrder.ts';
import type { ResultItem } from '../src/types.ts';

let n = 0;
function item(name: string, repo: string, over: Partial<ResultItem> = {}): ResultItem {
  n++;
  return {
    id: `gh:${repo}:skills/${name}-${n}`,
    name,
    description: '',
    sources: [],
    score: 50,
    breakdown: { R: 0.5, P: 0, F: 0, T: 0 },
    riskLevel: 'low',
    riskFlags: [],
    qualityWarnings: [],
    install: { method: 'skills-cli', command: '' },
    trust: 'community',
    categories: [],
    ...over,
  };
}

describe('검색 결과 순서·접기 (resultOrder.ts)', () => {
  it('기본 정렬: 이름에 검색어가 있는 것(tier) → 다운로드 → 스타', () => {
    const a = item('a', 'o/a', { installs: 10 });
    const b = item('b', 'o/b', { installs: 500 });
    const c = item('c', 'o/c', { installs: 1, tier: 1 });
    const d = item('d', 'o/d', { stars: 900 });
    const popular = SORTS.find((s) => s.key === 'popular')!;
    assert.deepEqual([a, b, c, d].sort(popular.compare).map((x) => x.name), ['c', 'b', 'a', 'd']);
  });

  it('같은 이름은 첫 번째 아래로 접고, 접힌 것이 더 위험하면 알린다', () => {
    const first = item('pdf', 'x/one', { installs: 100 });
    const copy = item('PDF', 'y/two', { installs: 5, riskLevel: 'high' });
    const other = item('docx', 'z/three');
    const rows = foldResults([first, other, copy], new Set(), new Set(), null);
    assert.deepEqual(rows.map((r) => r.item.name), ['pdf', 'docx']);
    assert.deepEqual(rows[0].same, { key: 'pdf', count: 1, riskier: true });
    const opened = foldResults([first, other, copy], new Set(), new Set(['pdf']), null);
    assert.deepEqual(opened.map((r) => r.item.name), ['pdf', 'PDF', 'docx']);
  });

  it('한 저장소는 2개만 보이고 나머지는 "N개 더"로 접는다; 검색어와 같은 이름의 저장소는 접지 않는다', () => {
    const many = ['a', 'b', 'c', 'd'].map((x) => item(x, 'big/rea'));
    const rows = foldResults(many, new Set(), new Set(), null);
    assert.deepEqual(rows.map((r) => r.item.name), ['a', 'b']);
    assert.deepEqual(rows[1].more, { repo: 'big/rea', count: 2 });
    assert.equal(foldResults(many, new Set(['big/rea']), new Set(), null).length, 4);
    assert.equal(foldResults(many, new Set(), new Set(), 'rea').length, 4);
  });
});

describe('서버와 웹이 같은 규칙을 쓴다 (전체 점검 #12)', () => {
  it('한 단어 검색어 판단과 이름 일치가 서버(pipeline.ts)와 같다', () => {
    for (const q of ['rea', 'PDF', '  pdf ', 'pdf tables', 'a', 'next.js', 'ui-ux', '한글', 'x'.repeat(101)]) {
      assert.equal(navigationalWord(q), server.navigationalWord(q), q);
    }
    const cases: Array<[string, string, string]> = [
      ['rea', 'gh:morluto/rea:skills/x', 'rea'],
      ['rea-tools', 'gh:o/r:skills/x', 'rea'],
      ['area', 'gh:o/r:skills/x', 'rea'],
      ['pdf', 'gh:o/r:skills/pdf', 'pdf'],
    ];
    for (const [name, id, word] of cases) {
      const it = { ...item(name, 'o/r'), id };
      assert.equal(nameMatches(it, word), server.nameMatches({ name, id } as never, word), `${name} ${id} ${word}`);
    }
  });
});
