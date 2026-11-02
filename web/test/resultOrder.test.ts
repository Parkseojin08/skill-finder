// Web pure modules, run with node --test (project review 2026-11-02 #12: the web had no tests).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as server from '../../server/src/search/pipeline.ts';
import { foldResults, nameMatches, navigationalWord, repoMainSkill, SORTS } from '../src/lib/resultOrder.ts';
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
    assert.deepEqual(opened[1].copyOf, { key: 'pdf', last: true }, '펼친 사본에는 접기 표시');
    assert.equal(opened[0].copyOf, undefined);
  });

  it('한 저장소는 2개만 보이고 나머지는 "N개 더"로 접는다; 검색어와 같은 이름의 저장소는 이름 찾기 결과만 접지 않는다', () => {
    const many = ['a', 'b', 'c', 'd'].map((x) => item(x, 'big/rea'));
    const rows = foldResults(many, new Set(), new Set(), null);
    assert.deepEqual(rows.map((r) => r.item.name), ['a', 'b']);
    assert.deepEqual(rows[1].more, { repo: 'big/rea', count: 2 });
    assert.equal(foldResults(many, new Set(['big/rea']), new Set(), null).length, 4);
    // named like the query or downloaded: the lookup's results stay; the repo's other skills fold as anywhere else
    const lookup = [item('rea-a', 'big/rea'), item('main', 'big/rea', { installs: 11216 }), item('rea-b', 'big/rea'), ...['x', 'y', 'z'].map((x) => item(x, 'big/rea'))];
    const kept = foldResults(lookup, new Set(), new Set(), 'rea', repoMainSkill(lookup, 'rea'));
    assert.deepEqual(kept.map((r) => r.item.name), ['rea-a', 'main', 'rea-b', 'x', 'y']);
    assert.deepEqual(kept.at(-1)?.more, { repo: 'big/rea', count: 1 });
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
      ['flow', 'gh:react/react:.claude/skills/flow', 'react'],
    ];
    for (const [name, id, word] of cases) {
      const it = { ...item(name, 'o/r'), id };
      assert.equal(nameMatches(it, word), server.nameMatches({ name, id }, word), `${name} ${id} ${word}`);
    }
    // the same-name repo's main skill: one that stands out, none when the counts are even
    const sets: Array<[string, Array<[string, number | undefined]>]> = [
      ['rea', [['gh:morluto/rea:.agents/skills/r', 11216], ['gh:morluto/rea:.agents/skills/t', undefined]]],
      ['mastra', [['gh:mastra-ai/mastra:.claude/skills/a', 2633], ['gh:mastra-ai/mastra:.claude/skills/b', 2498]]],
      ['react', [['gh:react/react:.claude/skills/flow', undefined], ['gh:o/a:skills/react-x', 900]]],
    ];
    for (const [word, list] of sets) {
      const items = list.map(([id, installs]) => ({ ...item('x', 'o/r', { installs }), id }));
      assert.equal(repoMainSkill(items, word), server.repoMainSkill(items, word), word);
    }
  });
});

describe('SKILL.md 링크와 내보내기 (사용성 검토 2026-11-02)', () => {
  it('스킬 폴더 안을 가리키는 링크만 파일 경로로 본다', async () => {
    const { relativeTarget } = await import('../src/lib/links.ts');
    assert.equal(relativeTarget('./reference.md'), 'reference.md');
    assert.equal(relativeTarget('docs/a%20b.md#part'), 'docs/a b.md');
    assert.equal(relativeTarget('./a/./b.md'), 'a/b.md');
    for (const other of ['https://x.com', 'mailto:a@b.c', '#top', '/abs', '../outside.md', 'a/../../b', '..%5Cout.md', '%E0%A4%A', './', undefined]) {
      assert.equal(relativeTarget(other), null, String(other));
    }
  });

  it('결과를 JSON·Markdown으로 만든다 (표 구분자는 이스케이프)', async () => {
    const { resultsJson, resultsMarkdown } = await import('../src/lib/exportList.ts');
    const it1 = item('a|b', 'o/r', { installs: 5, sources: [{ kind: 'github', label: 'GitHub', url: 'https://github.com/o/r' }] });
    const json = JSON.parse(resultsJson('pdf', [it1]));
    assert.equal(json.query, 'pdf');
    assert.deepEqual(Object.keys(json.results[0]), ['id', 'name', 'repo', 'url', 'description', 'installs', 'stars', 'riskLevel', 'riskFlags', 'installCommand']);
    assert.equal(json.results[0].repo, 'o/r');
    const md = resultsMarkdown('pdf', [it1]);
    assert.match(md, /\| \[a\\|b\]\(https:\/\/github\.com\/o\/r\) \| o\/r \| 5 \|/);
  });
});
