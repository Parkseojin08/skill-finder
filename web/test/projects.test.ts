// 설치됨 › 프로젝트 표준 (F12) and 모든 프로젝트 (F13): the order and summaries the panels show.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { failingCount, sortProjects, sortStandardItems, standardSummary, type ProjectSummary, type StandardItem, type StandardStatus } from '../src/lib/projects.ts';

const counts = (c: Partial<Record<StandardStatus, number>> = {}): Record<StandardStatus, number> => ({ ok: 0, missing: 0, differs: 0, extra: 0, disabled: 0, unregistered: 0, ...c });

const item = (kind: StandardItem['kind'], name: string, status: StandardStatus): StandardItem => ({
  kind,
  name,
  status,
  source: null,
  ref: null,
  skillPath: null,
  skillId: null,
  paths: [],
  agents: [],
  notForClaude: false,
  lockHash: null,
  localHash: null,
  hashNote: null,
  marketplace: null,
  preset: null,
});

const project = (name: string, over: Partial<ProjectSummary> = {}): ProjectSummary => ({
  path: `C:\\p\\${name}`,
  name,
  from: ['install'],
  skills: { project: 0, loaded: 0 },
  plugins: { project: 0, enabled: 0 },
  mcp: { project: 0, total: 0 },
  perTurnTokens: 0,
  standard: null,
  changed: 0,
  usage: null,
  errors: [],
  ...over,
});

describe('프로젝트 표준 표시', () => {
  it('문제 먼저, 표준에 없음, 맞음 순; 같은 상태는 종류·이름 순', () => {
    const sorted = sortStandardItems([item('skill', 'b', 'ok'), item('plugin', 'p', 'missing'), item('skill', 'x', 'extra'), item('skill', 'a', 'missing'), item('skill', 'd', 'differs'), item('marketplace', 'm', 'unregistered')]);
    assert.deepEqual(
      sorted.map((i) => `${i.status}:${i.name}`),
      ['missing:a', 'missing:p', 'unregistered:m', 'differs:d', 'extra:x', 'ok:b'],
    );
  });

  it('요약: 표준 없음·맞음·어긋남·읽지 못함', () => {
    assert.equal(standardSummary(null).text, '-');
    assert.equal(standardSummary({ hasStandard: false, ok: true, counts: counts() }).text, '표준 없음');
    assert.deepEqual(standardSummary({ hasStandard: true, ok: true, counts: counts({ ok: 3 }) }), { text: '맞음', tone: 'ok' });
    assert.equal(standardSummary({ hasStandard: true, ok: true, counts: counts({ ok: 1, extra: 2 }) }).text, '맞음 · 표준에 없음 2');
    assert.deepEqual(standardSummary({ hasStandard: true, ok: false, counts: counts({ missing: 1, differs: 2, extra: 5 }) }), { text: '어긋남 3', tone: 'warn' });
    assert.equal(standardSummary({ hasStandard: true, ok: false, counts: counts() }).text, '표준 파일을 읽지 못함');
    assert.equal(failingCount(counts({ missing: 1, disabled: 1, unregistered: 1, extra: 9, ok: 9 })), 3);
  });
});

describe('모든 프로젝트 정렬', () => {
  const list = [
    project('b', { perTurnTokens: 100, standard: { hasStandard: true, ok: false, counts: counts({ missing: 2 }) }, usage: { unused30d: 1, lastUsed: '2026-11-01' } }),
    project('a', { perTurnTokens: 500, changed: 3, standard: { hasStandard: true, ok: true, counts: counts({ ok: 1 }) }, usage: { unused30d: 4, lastUsed: null } }),
    project('c', { perTurnTokens: 300, usage: null }),
  ];
  it('기준마다', () => {
    assert.deepEqual(sortProjects(list, 'name').map((p) => p.name), ['a', 'b', 'c']);
    assert.deepEqual(sortProjects(list, 'tokens').map((p) => p.name), ['a', 'c', 'b']);
    assert.deepEqual(sortProjects(list, 'standard').map((p) => p.name), ['b', 'a', 'c']);
    assert.deepEqual(sortProjects(list, 'changed').map((p) => p.name), ['a', 'b', 'c']);
    assert.deepEqual(sortProjects(list, 'unused').map((p) => p.name), ['a', 'b', 'c']);
    assert.deepEqual(sortProjects(list, 'lastUsed').map((p) => p.name), ['b', 'a', 'c']);
  });
});
