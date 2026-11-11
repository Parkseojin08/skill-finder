// Feature review stage 3 B8: search results fold near-copies (the server's clusterId) as well as same names.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { foldResults } from '../src/lib/resultOrder.ts';
import type { ResultItem } from '../src/types.ts';

let n = 0;
function item(name: string, repo: string, over: Partial<ResultItem> & { clusterId?: string } = {}): ResultItem {
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
  } as ResultItem;
}

describe('같은 계열 접기 (B8)', () => {
  it('이름을 바꾼 사본도 cluster로 첫 결과 아래에 접고, 이름 다른 사본 수를 센다', () => {
    const first = item('pdf', 'x/one', { installs: 100, clusterId: 'c1' });
    const renamed = item('pdf-helper', 'y/two', { clusterId: 'c1', riskLevel: 'medium' });
    const sameName = item('PDF', 'z/three');
    const other = item('docx', 'w/four', { clusterId: 'c2' });
    const rows = foldResults([first, other, renamed, sameName], new Set(), new Set(), null);
    assert.deepEqual(rows.map((r) => r.item.name), ['pdf', 'docx']);
    assert.deepEqual(rows[0].same, { key: 'c:c1', count: 2, riskier: true, renamed: 1 });
    assert.equal(rows[1].same, undefined, '혼자인 계열은 접지 않음');
    const opened = foldResults([first, other, renamed, sameName], new Set(), new Set(['c:c1']), null);
    assert.deepEqual(opened.map((r) => r.item.name), ['pdf', 'pdf-helper', 'PDF', 'docx']);
    assert.deepEqual(opened[2].copyOf, { key: 'c:c1', last: true });
  });

  it('정렬이 바뀌어도 접기 키가 같다 (열어 둔 상태 유지)', () => {
    const a = item('alpha', 'a/a', { clusterId: 'k' });
    const b = item('beta', 'b/b', { clusterId: 'k' });
    assert.equal(foldResults([a, b], new Set(), new Set(), null)[0].same!.key, foldResults([b, a], new Set(), new Set(), null)[0].same!.key);
  });

  it('cluster가 없으면 예전처럼 같은 이름만 접는다', () => {
    const rows = foldResults([item('pdf', 'x/one'), item('pdf_', 'y/two'), item('Pdf', 'z/three')], new Set(), new Set(), null);
    assert.deepEqual(rows[0].same, { key: 'pdf', count: 1, riskier: false });
  });
});
