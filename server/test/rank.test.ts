import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { bm25ToRelevance, freshness, popularity, totalScore, TRUST_SCORE, trustTier } from '../src/search/rank.ts';
import { DEFAULT_SETTINGS } from '../src/settings.ts';

const DAY = 24 * 60 * 60 * 1000;

describe('§9 점수', () => {
  it('F: 90일 이내 1, 730일 0, 사이는 선형', () => {
    const now = Date.parse('2026-10-23T00:00:00Z');
    const ago = (d: number) => new Date(now - d * DAY).toISOString();
    assert.equal(freshness(ago(10), now), 1);
    assert.equal(freshness(ago(90), now), 1);
    assert.equal(freshness(ago(730), now), 0);
    assert.equal(freshness(ago(1000), now), 0);
    assert.ok(Math.abs(freshness(ago(410), now) - 0.5) < 1e-9);
    assert.equal(freshness(null, now), 0);
  });

  it('P: 설치 수 우선, 없으면 별점 × 0.6', () => {
    assert.equal(popularity({ installs: 1000 }, 1000, 0), 1);
    assert.ok(Math.abs(popularity({ installs: 99 }, 9999, 0) - 0.5) < 1e-9);
    assert.ok(Math.abs(popularity({ stars: 500 }, 0, 500) - 0.6) < 1e-9);
    assert.equal(popularity({}, 100, 100), 0);
    assert.equal(popularity({ installs: 50, stars: 500 }, 50, 500), 1);
  });

  it('T: anthropics 1.0, 파트너 0.8, 커뮤니티 0.6, 그 외 0.4', () => {
    assert.equal(TRUST_SCORE[trustTier({ repo: 'anthropics/skills', dir_path: 'skills/pdf' }, { marketplace: 'anthropic-agent-skills' })], 1);
    assert.equal(TRUST_SCORE[trustTier({ repo: 'anthropics/claude-plugins-official', dir_path: 'external_plugins/x/skills/y' }, { marketplace: 'claude-plugins-official' })], 0.8);
    assert.equal(TRUST_SCORE[trustTier({ repo: 'acme/x', dir_path: 's' }, { marketplace: 'claude-plugins-official' })], 0.8);
    assert.equal(TRUST_SCORE[trustTier({ repo: 'anthropics/claude-plugins-community', dir_path: 'p' }, { marketplace: 'claude-community' })], 0.6);
    assert.equal(TRUST_SCORE[trustTier({ repo: 'someone/repo', dir_path: '' }, null)], 0.4);
  });

  it('합산: 0.55R + 0.20P + 0.10F + 0.15T', () => {
    const s = totalScore({ R: 1, P: 0.5, F: 0, T: 0.4 }, DEFAULT_SETTINGS.weights);
    assert.ok(Math.abs(s - (0.55 + 0.1 + 0 + 0.06)) < 1e-9);
    assert.ok(Math.abs(totalScore({ R: 1, P: 1, F: 1, T: 1 }, { R: 2, P: 2, F: 2, T: 2 }) - 1) < 1e-9);
  });

  it('bm25 대체 관련도: 최고 1, 최저 0.3', () => {
    assert.equal(bm25ToRelevance(-10, -10, -2), 1);
    assert.ok(Math.abs(bm25ToRelevance(-2, -10, -2) - 0.3) < 1e-9);
  });
});

describe('직접 단어 일치 (정확도 보정)', () => {
  it('어미가 달라도 같은 단어로 본다', async () => {
    const { stem } = await import('../src/search/rank.ts');
    assert.equal(stem('extracting'), stem('extract'));
    assert.equal(stem('extraction'), stem('extracts'));
    assert.equal(stem('tables'), stem('table'));
  });

  it('검색어 단어가 이름·설명에 있는 스킬이 퍼지 검색 상위보다 앞선다', async () => {
    const { lexicalMatch, blendRelevance } = await import('../src/search/rank.ts');
    const q = 'extract tables from pdf';
    const pdf = lexicalMatch(q, 'pdf', 'Extracting text and tables from PDF files, filling PDF forms.');
    const reader = lexicalMatch(q, 'nature-reader', 'Create Chinese-English paper readers with aligned text, figures, tables, and equations.');
    assert.equal(pdf.text, 1);
    assert.ok(reader.text < 0.5);
    // a fuzzy rank-1 hit (base 0.8) without the words loses to a solid keyword hit (base 0.7)
    assert.ok(blendRelevance(0.7, pdf) > blendRelevance(0.8, reader));
    const phrase = lexicalMatch('extract tables', 'x', 'Tools to extract tables quickly');
    assert.equal(phrase.phrase, 1);
  });

  it('한국어 어미가 붙은 영어 단어도 그 영어 단어로 맞춘다', async () => {
    const { lexicalMatch, matchTokens } = await import('../src/search/rank.ts');
    assert.deepEqual(matchTokens('pdf에서 표 추출'), ['pdf', '추출']);
    // with an English word in the query, Korean words (which English text can never contain) don't count
    assert.equal(lexicalMatch('pdf에서 표 추출', 'pdf', 'Extract tables from PDF files.').name, 1);
    assert.equal(lexicalMatch('react 성능 최적화', 'react-perf', 'React rendering performance.').any, 1);
    assert.equal(lexicalMatch('엑셀 정리', 'xlsx', 'Spreadsheets.').any, 0, '한국어뿐이면 그대로 셈');
  });

  it('불용어만 있는 검색어는 불용어로 맞춘다', async () => {
    const { lexicalMatch, queryTokens } = await import('../src/search/rank.ts');
    assert.deepEqual(queryTokens('claude code'), ['claude', 'code']);
    assert.deepEqual(queryTokens('a the'), [], '문법 단어만이면 맞출 단어가 없음');
    assert.equal(lexicalMatch('skill', 'skill-creator', 'Create skills.').name, 1);
    assert.equal(lexicalMatch('pdf', 'skill-creator', 'Create skills.').name, 0, '평소엔 skill이 일치에 끼지 않음');
  });

  it('긴 검색어 단어는 앞부분 일치도 인정하고, 짧은 단어는 정확히 같아야 한다', async () => {
    const { lexicalMatch } = await import('../src/search/rank.ts');
    assert.equal(lexicalMatch('docker', 'multi-stage-dockerfile', 'Write small images.').name, 1);
    assert.equal(lexicalMatch('pdf', 'pdfkit-helper', 'Build documents.').name, 0);
  });
});
