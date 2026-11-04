import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { worthTranslating } from '../src/lib/textLang.ts';

describe('worthTranslating', () => {
  it('영어 설명은 번역한다', () => {
    assert.equal(worthTranslating('Browser automation CLI for AI agents.'), true);
    assert.equal(worthTranslating('Café menus, résumé builder'), true);
  });

  it('한국어·일본어 글은 영어 이름이 섞여도 번역하지 않는다 (이 저장소 README 소개 줄)', () => {
    assert.equal(worthTranslating('Claude Code 스킬을 한곳에서 찾아 점수·위험 신호와 함께 보고, 설치 전에 무엇이 함께 들어오는지 확인한 뒤 설치·삭제하는 로컬 웹 앱입니다.'), false);
    assert.equal(worthTranslating('PDF を読み込んで表を抽出するスキル'), false);
  });

  it('기호·숫자뿐이거나 너무 짧은 글은 번역하지 않는다', () => {
    assert.equal(worthTranslating('. , , , , , .'), false);
    assert.equal(worthTranslating('--- | --- | ---'), false);
    assert.equal(worthTranslating('v1.2.3 (2017-01-20)'), false);
    assert.equal(worthTranslating('ok'), false);
    assert.equal(worthTranslating(''), false);
  });
});
