import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { estimateTokens, skillTokens } from '../src/util/tokens.ts';

describe('컨텍스트 비용 추정 (사용성 검토 2026-11-02)', () => {
  it('영어는 약 4글자, 한글은 약 1.5글자에 1토큰으로 센다', () => {
    assert.equal(estimateTokens('abcd'.repeat(10)), 10);
    assert.equal(estimateTokens('가나다'), 2);
    assert.equal(estimateTokens(''), 0);
  });

  it('매 턴은 이름과 설명, 쓸 때는 SKILL.md 전체', () => {
    const t = skillTokens('pdf', 'Read PDF files.', '---\nname: pdf\n---\n' + 'x'.repeat(400));
    assert.equal(t.perTurn, estimateTokens('pdf: Read PDF files.'));
    assert.ok(t.onUse! > 100);
    assert.equal(skillTokens('a', null, null).onUse, null);
  });
});
