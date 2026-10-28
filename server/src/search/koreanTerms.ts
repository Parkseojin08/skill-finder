import { GENERIC_WORDS } from './rank.ts';

// Korean words → the English words skill descriptions actually use. Rule-based only (no AI, user decision):
// the search suggests the English query as a button, and the README recommendation maps Korean READMEs with it.

export const KO_EN: Record<string, string[]> = {
  // xlsx and excel first: the words skill names and descriptions use most (spreadsheet narrowed the search)
  엑셀: ['xlsx', 'excel', 'spreadsheet'],
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
  // second batch (search debate, panel 7): words real Korean queries use that the first list lacked
  코드: ['code'],
  메시지: ['message'],
  점검: ['audit'],
  감사: ['audit'],
  웹사이트: ['website'],
  사이트: ['website'],
  크롤러: ['scraper'],
  프롬프트: ['prompt'],
  에이전트: ['agent'],
  스킬: ['skill'],
  버그: ['bug'],
  수정: ['fix'],
  오류: ['error'],
  에러: ['error'],
  타입: ['type'],
  로고: ['logo'],
  알림: ['notification'],
  회의: ['meeting'],
  문서화: ['documentation'],
  생성: ['generate'],
  한글: ['hwp'],
  파일: ['file'],
  플러그인: ['plugin'],
  터미널: ['terminal'],
  스크립트: ['script'],
  템플릿: ['template'],
  대시보드: ['dashboard'],
  컴포넌트: ['component'],
  함수: ['function'],
  린트: ['lint'],
  포맷: ['format'],
  정규식: ['regex'],
  브랜치: ['branch'],
  머지: ['merge'],
  충돌: ['conflict'],
  변경로그: ['changelog'],
  보고서: ['report'],
  리포트: ['report'],
  이력서: ['resume'],
  계약서: ['contract'],
  자막: ['subtitle'],
  썸네일: ['thumbnail'],
  아이콘: ['icon'],
  폰트: ['font'],
  접근성: ['accessibility'],
  마케팅: ['marketing'],
  광고: ['ads'],
  게임: ['game'],
  유니티: ['unity'],
  안드로이드: ['android'],
  스위프트: ['swift'],
  코틀린: ['kotlin'],
  자바: ['java'],
  러스트: ['rust'],
  스프링: ['spring'],
  장고: ['django'],
  넥스트: ['nextjs'],
  테일윈드: ['tailwind'],
  수파베이스: ['supabase'],
  파이어베이스: ['firebase'],
  모니터링: ['monitoring'],
  백업: ['backup'],
  머신러닝: ['machine', 'learning'],
  챗봇: ['chatbot'],
  웹훅: ['webhook'],
  큐: ['queue'],
  캐시: ['cache'],
  쿼리: ['query'],
  스키마: ['schema'],
  랜딩페이지: ['landing', 'page'],
  크롬: ['chrome'],
  확장: ['extension'],
  유튜브: ['youtube'],
  트위터: ['twitter'],
  인스타그램: ['instagram'],
  주식: ['stock'],
  회계: ['accounting'],
  세금: ['tax'],
  논문: ['paper'],
  연구: ['research'],
  그림: ['image'],
  사진: ['photo'],
  음악: ['music'],
};

/** Endings a Korean noun takes in a query ("엑셀로", "표를", "정리해줘" → the noun before them). */
const PARTICLES = ['', '을', '를', '이', '가', '은', '는', '의', '에', '에서', '로', '으로', '와', '과', '도', '만', '까지', '부터', '하기', '하는', '해', '해줘', '하고', '용'];
/** More endings, for splitting a query word into dictionary words (koreanSuggestion). */
// (no "화": "한글화" is localization, not 한글 + an ending; "문서화" has its own entry)
const ENDINGS = [...PARTICLES.slice(1), '에게', '한테', '랑', '이랑', '처럼', '들', '들을', '할', '한', '하자', '해서', '하려면', '시키기'];
/**
 * Words that say what to do rather than what about ("정리", "만들기"): dropped from the English query rather
 * than blocking it. Those in REQUEST_WORDS are not even worth showing as dropped.
 */
const EMPTY_WORDS = ['정리', '작성', '만들기', '만들어', '만들어줘', '만드는', '찾기', '찾아줘', '해줘', '해', '하기', '그리기', '좀', '관련', '방법', '내용', '도구', '자동', '자료'];
const REQUEST_WORDS = new Set(['해줘', '해', '하기', '좀', '만들어', '만들어줘', '찾아줘']);
/** At most this many dropped words of at most this many characters are listed (a pasted sentence stays short). */
const DROPPED_MAX = 5;
const DROPPED_CHARS = 12;

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

/** Words longer than this are not split (a pasted sentence without spaces would only waste time). */
const SPLIT_MAX_CHARS = 40;

/**
 * Splits a Korean word into dictionary words and empty words, each optionally followed by one ending
 * ("코드리뷰" → 코드 + 리뷰, "엑셀표추출해줘" → 엑셀 + 표 + 추출 + 해줘), in the fewest pieces. Null unless
 * the whole word is covered: "표준" is not 표 + something, "서버리스" is not 서버.
 */
function splitKorean(word: string): Array<{ key: string; en: string[] | null }> | null {
  if (word.length > SPLIT_MAX_CHARS) return null;
  // longest keys first: with as many pieces either way, the first found stays, so "문서화" is one word
  // (documentation) rather than 문서 + an ending, whatever order the dictionary lists them in
  const keys = [...Object.keys(KO_EN), ...EMPTY_WORDS].sort((a, b) => b.length - a.length);
  const best: Array<Array<{ key: string; en: string[] | null }> | null> = Array(word.length + 1).fill(null);
  best[0] = [];
  for (let i = 0; i < word.length; i++) {
    const here = best[i];
    if (!here) continue;
    for (const k of keys) {
      if (!word.startsWith(k, i)) continue;
      for (const e of ['', ...ENDINGS]) {
        if (e && !word.startsWith(e, i + k.length)) continue;
        const j = i + k.length + e.length;
        const piece = { key: k, en: EMPTY_WORDS.includes(k) ? null : KO_EN[k] };
        if (!best[j] || here.length + 1 < best[j]!.length) best[j] = [...here, piece];
      }
    }
  }
  return best[word.length];
}

export type KoreanSuggestion = {
  /** The English query to offer. */
  query: string;
  /** Korean words left out: not in the dictionary, or words like "정리" that only say what to do. */
  dropped: string[];
};

/**
 * An English query for a Korean one, word by word: Latin words stay ("pdf에서" → "pdf"), dictionary words are
 * replaced (two synonyms at most, and not "deploy deployment"), other Korean words are dropped and listed.
 * Null unless at least one Korean word was translated. Rule-based only (no AI, user decision).
 */
export function koreanSuggestion(query: string): KoreanSuggestion | null {
  if (!/\p{Script=Hangul}/u.test(query)) return null;
  const out: string[] = [];
  const dropped: string[] = [];
  let translated = false;
  for (const token of query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
    out.push(...(token.match(/[a-z0-9]+/g) ?? []).filter((w) => w.length >= 2));
    const korean = token.replace(/[a-z0-9]+/g, ''); // "pdf에서" → "에서", an ending: nothing to translate
    if (!korean || ENDINGS.includes(korean)) continue;
    const pieces = splitKorean(korean);
    if (!pieces) {
      dropped.push(korean);
      continue;
    }
    for (const p of pieces) {
      if (!p.en) {
        if (!REQUEST_WORDS.has(p.key)) dropped.push(p.key);
        continue;
      }
      // two words at most, the second only if it is not a form of the first: more would lower each result's
      // share of matching words and narrow the all-words search
      const [a, b] = p.en;
      out.push(a);
      if (b && !b.startsWith(a) && !a.startsWith(b)) out.push(b);
      translated = true;
    }
  }
  const words = [...new Set(out)];
  // "스킬 만들기" → "skill" alone would only lead to the "too broad" notice
  if (!translated || words.length === 0 || words.every((w) => GENERIC_WORDS.has(w))) return null;
  return { query: words.join(' '), dropped: [...new Set(dropped)].slice(0, DROPPED_MAX).map((w) => (w.length > DROPPED_CHARS ? `${w.slice(0, DROPPED_CHARS)}…` : w)) };
}

/** koreanSuggestion's query alone. */
export function englishSuggestion(query: string): string | null {
  return koreanSuggestion(query)?.query ?? null;
}
