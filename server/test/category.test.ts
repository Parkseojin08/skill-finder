import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { categorize } from '../src/search/category.ts';

describe('검색 결과 카테고리 (키워드 규칙)', () => {
  it('설명의 키워드로 분류한다', () => {
    assert.deepEqual(categorize({ name: 'pdf', description: 'Extract tables and text from PDF files.' }), ['docs']);
  });

  it('이름에 든 키워드가 설명보다 앞선다', () => {
    const cats = categorize({ name: 'webapp-testing', description: 'Drive a local React app with Playwright and capture screenshots.' });
    assert.equal(cats[0], 'testing');
    assert.ok(cats.length <= 2);
  });

  it('구체적인 마켓플레이스 분류는 항상 먼저 넣는다', () => {
    assert.deepEqual(categorize({ name: 'guard', description: 'Checks things before you ship.', marketplaceCategory: 'Security' }), ['security']);
  });

  it('일반 분류(development)는 키워드가 없을 때만 쓴다', () => {
    assert.deepEqual(categorize({ name: 'helper', description: 'Does helpful things.', marketplaceCategory: 'development' }), ['dev']);
    assert.deepEqual(categorize({ name: 'sql-helper', description: 'Write SQL migrations.', marketplaceCategory: 'development' }), ['data']);
  });

  it('두 번째 카테고리는 첫 번째의 절반을 넘을 때만 붙는다', () => {
    // the official pdf skill: name match (docs ×2) vs one "encrypting" (security ×1)
    const cats = categorize({
      name: 'pdf',
      description: 'Combine or merge PDFs, split them apart, rotate pages, add watermarks, fill forms, encrypting/decrypting PDFs, OCR scanned images.',
    });
    assert.deepEqual(cats, ['docs']);
    // equal evidence keeps both
    assert.deepEqual(categorize({ name: 'x', description: 'Run Playwright checks before each deploy.' }), ['testing', 'ops']);
  });

  it('"designed to" 같은 상투어 하나로는 디자인이 되지 않는다', () => {
    assert.deepEqual(categorize({ name: 'helper', description: 'A skill designed to help with everyday chores.' }), ['other']);
  });

  it('맞는 규칙이 없으면 기타', () => {
    assert.deepEqual(categorize({ name: 'xyz', description: '' }), ['other']);
  });
});
