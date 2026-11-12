// Search speed-up (2026-11-12): a name or description is read in one pass (textWords), the query's words are kept
// with its aliases, and a card's categories are remembered per row. Each must give what the slower code gave.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { categorize, categorizeRow } from '../src/search/category.ts';
import { GENERIC_WORDS, lexicalMatch, matchTokens, stem, textWords } from '../src/search/rank.ts';

/** The two passes textWords replaced (0.3.7): matchTokens, then the generic words a stopword-only query uses. */
const twoPasses = (text: string) =>
  new Set([...matchTokens(text), ...(text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((t) => GENERIC_WORDS.has(t)).map(stem)]);

const sorted = (s: Set<string>) => [...s].sort();

const SAMPLES = [
  '',
  'Skills for Claude Code: a tool to extract tables from PDF files.',
  'pdf에서 표 추출, 엑셀로 정리하고 csv로 내보내기',
  'the a an of and to in for with on is are be',
  'skill SKILL Skills claude CODE tools tool',
  'React 19 + Vite 8, k8s, ppt→pptx, C++ / C# / F#, x86_64, utf-8',
  'docker-compose dockerfile Dockerfiles; kubernetes_helm.charts',
  '日本語のテキスト と English mixed 中文 한국어 text',
  'a b c 1 2 3 ab 12 a1 1a',
  'emoji 🚀 test — dashes – and “quotes” ‘here’',
  '   leading and trailing spaces   ',
  'Ünïcödé Ñame café naïve résumé',
];

/** A deterministic mix of the samples' words, so the comparison covers more orders and neighbours than the list. */
function* mixed(count: number): Generator<string> {
  const words = SAMPLES.join(' ').split(/\s+/).filter(Boolean);
  let seed = 7;
  for (let i = 0; i < count; i++) {
    const n = 1 + (i % 12);
    const out: string[] = [];
    for (let j = 0; j < n; j++) {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      out.push(words[seed % words.length]);
    }
    yield out.join(i % 3 === 0 ? ' ' : i % 3 === 1 ? '-' : ', ');
  }
}

describe('검색 속도 개선: 단어 읽기와 분류 기억이 예전과 같은 결과', () => {
  it('textWords는 matchTokens와 일반어를 따로 읽던 두 번의 결과와 같다', () => {
    for (const text of [...SAMPLES, ...mixed(2000)]) assert.deepEqual(sorted(textWords(text)), sorted(twoPasses(text)), text);
  });

  it('lexicalMatch: 검색어를 번갈아 바꿔도 처음 계산한 값과 같다 (검색어별 기억)', () => {
    const queries = ['extract tables from pdf', 'pdf에서 표 추출', 'skill', 'k8s deploy', 'react performance'];
    const pairs: Array<[string, string]> = [
      ['pdf', 'Extract text and tables from PDF files.'],
      ['k8s-helper', 'Deploy to kubernetes with helm charts.'],
      ['react-perf', 'React rendering performance tips.'],
      ['skill-finder', 'Find Claude Code skills.'],
    ];
    const first = new Map<string, string>();
    for (let round = 0; round < 3; round++) {
      for (const q of round === 1 ? [...queries].reverse() : queries) {
        for (const [name, text] of pairs) {
          const key = `${q}\n${name}`;
          const got = JSON.stringify(lexicalMatch(q, name, text));
          if (!first.has(key)) first.set(key, got);
          else assert.equal(got, first.get(key), key);
        }
      }
    }
  });

  it('categorizeRow: 같은 행·같은 입력이면 기억한 값, 입력이 바뀌면 다시 계산, 돌려준 배열을 바꿔도 기억은 그대로', () => {
    const row = {};
    const pdf = { name: 'pdf', description: 'Extract tables from PDF files and fill PDF forms.', whenToUse: null, marketplaceCategory: null };
    const a = categorizeRow(row, pdf);
    assert.deepEqual(a, categorize(pdf));
    a.length = 0;
    assert.deepEqual(categorizeRow(row, pdf), categorize(pdf), '돌려준 배열을 비워도 다음 호출은 그대로');
    const other = { ...pdf, name: 'deploy', description: 'Deploy to kubernetes with docker and helm.' };
    assert.deepEqual(categorizeRow(row, other), categorize(other), '같은 행이라도 입력이 다르면 다시 계산');
    assert.deepEqual(categorizeRow({}, pdf), categorize(pdf), '다른 행');
  });
});
