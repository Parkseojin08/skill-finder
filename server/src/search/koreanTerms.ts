// Korean words → the English words skill descriptions actually use. Rule-based only (no AI, user decision):
// the search suggests the English query as a button, and the README recommendation maps Korean READMEs with it.

export const KO_EN: Record<string, string[]> = {
  엑셀: ['spreadsheet', 'xlsx', 'excel'],
  스프레드시트: ['spreadsheet'],
  표: ['table'],
  추출: ['extract'],
  변환: ['convert'],
  요약: ['summarize'],
  번역: ['translate'],
  리액트: ['react'],
  워드: ['docx', 'word'],
  파워포인트: ['pptx', 'powerpoint'],
  피피티: ['pptx', 'slides'],
  슬라이드: ['slides'],
  발표: ['presentation'],
  테스트: ['testing'],
  단위: ['unit'],
  브라우저: ['browser'],
  데이터베이스: ['database', 'sql'],
  배포: ['deploy', 'deployment'],
  보안: ['security'],
  취약점: ['vulnerability'],
  디자인: ['design'],
  문서: ['document', 'documentation'],
  이미지: ['image'],
  서버: ['server'],
  깃허브: ['github'],
  깃: ['git'],
  커밋: ['commit'],
  리뷰: ['review'],
  검토: ['review'],
  풀리퀘스트: ['pull', 'request'],
  이슈: ['issue'],
  자동화: ['automation'],
  크롤링: ['scraping'],
  스크래핑: ['scraping'],
  웹: ['web'],
  앱: ['app'],
  모바일: ['mobile'],
  프론트엔드: ['frontend'],
  백엔드: ['backend'],
  성능: ['performance'],
  최적화: ['optimization'],
  디버깅: ['debugging'],
  디버그: ['debug'],
  로그: ['logging'],
  리팩토링: ['refactoring'],
  리팩터링: ['refactoring'],
  마이그레이션: ['migration'],
  차트: ['chart'],
  그래프: ['chart'],
  시각화: ['visualization'],
  분석: ['analysis'],
  데이터: ['data'],
  이메일: ['email'],
  메일: ['email'],
  캘린더: ['calendar'],
  일정: ['calendar'],
  영상: ['video'],
  동영상: ['video'],
  음성: ['audio'],
  회의록: ['meeting', 'notes'],
  릴리스: ['release'],
  릴리즈: ['release'],
  노트: ['notes'],
  마크다운: ['markdown'],
  파이썬: ['python'],
  자바스크립트: ['javascript'],
  타입스크립트: ['typescript'],
  도커: ['docker'],
  쿠버네티스: ['kubernetes'],
  인프라: ['infrastructure'],
  클라우드: ['cloud'],
  결제: ['payment'],
  인증: ['authentication'],
  로그인: ['login'],
  검색: ['search'],
  기획: ['planning'],
  글쓰기: ['writing'],
  블로그: ['blog'],
  피그마: ['figma'],
  노션: ['notion'],
  슬랙: ['slack'],
};

/** Endings a Korean noun takes in a query ("엑셀로", "표를", "정리해줘" → the noun before them). */
const PARTICLES = ['', '을', '를', '이', '가', '은', '는', '의', '에', '에서', '로', '으로', '와', '과', '도', '만', '까지', '부터', '하기', '하는', '해', '해줘', '하고', '용'];

/**
 * The words the README recommendation maps (the specific ones: "데이터", "웹" or "검색" in a README say little
 * about which skills fit). It also takes any ending ("문서화", "테스트합니다"), as it always has.
 */
export const README_TERMS = new Set(['엑셀', '스프레드시트', '리액트', '워드', '파워포인트', '슬라이드', '테스트', '브라우저', '데이터베이스', '배포', '보안', '디자인', '문서', '이미지', '서버', '깃허브']);

/**
 * Longest dictionary word the token starts with, when what follows it is only an ending ("엑셀로" → 엑셀,
 * "표준" is not 표); else null. `readme`: only README_TERMS, and anything may follow.
 */
export function koreanTerm(token: string, readme = false): string[] | null {
  let best: string | null = null;
  for (const k of Object.keys(KO_EN)) {
    if (readme ? !README_TERMS.has(k) : !PARTICLES.includes(token.slice(k.length))) continue;
    if (token.startsWith(k) && (!best || k.length > best.length)) best = k;
  }
  return best ? KO_EN[best] : null;
}

/**
 * An English query for a Korean one, word by word: Latin words stay ("pdf에서" → "pdf"), dictionary words are
 * replaced, other Korean words are dropped. Null unless at least one Korean word was translated.
 */
export function englishSuggestion(query: string): string | null {
  if (!/\p{Script=Hangul}/u.test(query)) return null;
  const out: string[] = [];
  let translated = false;
  for (const token of query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
    out.push(...(token.match(/[a-z0-9]+/g) ?? []).filter((w) => w.length >= 2));
    const korean = token.replace(/[a-z0-9]+/g, ''); // "pdf에서" → "에서", an ending: nothing to translate
    const en = korean ? koreanTerm(korean) : null;
    if (en) {
      // two words at most: more synonyms would lower each result's share of matching words
      out.push(...en.slice(0, 2));
      translated = true;
    }
  }
  const words = [...new Set(out)];
  return translated && words.length ? words.join(' ') : null;
}
