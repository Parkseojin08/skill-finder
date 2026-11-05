import type { InstallMethod, Job, RiskLevel, TrustTier } from './types.ts';
import { t } from './i18n.ts';

export const RISK_FLAGS: Record<string, { label: string; meaning: string; info?: boolean }> = {
  scripts: { label: t('스크립트 포함'), meaning: t('실행 가능한 코드(.sh, .py, .js 등)가 들어 있습니다(정보). Bash로만 실행되고, 그 전에 Claude Code가 허락을 묻습니다.'), info: true },
  preapprovedBash: { label: t('Bash 사전 승인'), meaning: t('이 스킬이 쓰이는 동안 Bash가 승인 없이 실행될 수 있습니다.') },
  unscopedBash: { label: t('Bash 무제한'), meaning: t('Bash 사전 승인에 명령 제한도 없습니다.') },
  shellInjection: { label: t('셸 명령 주입'), meaning: t('스킬이 호출되면 Claude가 내용을 보기 전에 셸 명령이 실행됩니다.') },
  skillHooks: { label: t('스킬 훅'), meaning: t('스킬이 호출되면 훅을 등록합니다.') },
  pluginRootDependency: { label: t('플러그인 전용'), meaning: t('플러그인으로 설치해야 동작합니다. 폴더만 복사하면 깨집니다. 위험 신호가 아니라 설치 방식 정보입니다.'), info: true },
  pluginHooks: { label: t('플러그인 훅'), meaning: t('플러그인을 설치하면 훅이 함께 설치·실행됩니다.') },
  pluginMcp: { label: t('MCP 서버'), meaning: t('플러그인을 설치하면 MCP 서버가 함께 설치·실행됩니다.') },
  pluginBin: { label: t('실행 파일(bin)'), meaning: t('플러그인이 활성화되면 실행 파일이 Bash PATH에 올라갑니다(정보). Bash로만 실행되고, 그 전에 Claude Code가 허락을 묻습니다.'), info: true },
  pluginMonitors: { label: t('모니터'), meaning: t('플러그인을 설치하면 모니터가 함께 설치·실행됩니다.') },
  curlPipeShell: { label: t('원격 스크립트 실행'), meaning: t('원격 스크립트를 내려받아 바로 실행하는 명령(curl | sh)이 있습니다.') },
  rmRf: { label: 'rm -rf', meaning: t('강제 삭제 명령이 들어 있습니다(정보).'), info: true },
  commandSource: { label: t('command 출처'), meaning: t('설치할 때 마켓플레이스가 지정한 명령이 실행됩니다.') },
  unscanned: { label: t('끝까지 검사 못 함'), meaning: t('SKILL.md가 512KB를 넘거나 frontmatter가 너무 커서 일부만 검사했습니다. 검사하지 못한 부분에 명령이 있을 수 있습니다.') },
  hiddenContent: {
    label: t('숨은 내용'),
    meaning: t('화면에는 보이지 않지만 Claude는 읽는 내용이 있습니다(글이 든 HTML 주석, 숨김 HTML, 보이지 않는 글자, 긴 base64, 글자와 실제 주소가 다른 링크). SKILL.md 탭의 "Claude가 읽는 원문"에서 확인하세요.'),
  },
};

/** The kinds of hidden content the SKILL.md tab marks in the raw text (server analyze/hiddenContent.ts). */
export const HIDDEN_KIND: Record<string, string> = {
  comment: t('HTML 주석'),
  hiddenHtml: t('숨김 HTML'),
  tagChars: t('태그 문자'),
  bidi: t('방향 제어 문자'),
  zeroWidth: t('폭 없는 글자 묶음'),
  base64: t('긴 base64'),
  linkMismatch: t('글자와 주소가 다른 링크'),
};

export const QUALITY: Record<string, { label: string; meaning: string; info?: boolean }> = {
  noFrontmatter: { label: t('frontmatter 없음'), meaning: t('첫 줄이 ---로 시작하는 frontmatter가 없습니다.') },
  yamlError: { label: t('YAML 오류'), meaning: t('frontmatter YAML을 파싱하지 못했습니다.') },
  nameMissing: { label: t('name 없음'), meaning: t('name이 없어 폴더명을 씁니다.') },
  nameFormat: { label: t('name 형식'), meaning: t('소문자·숫자·하이픈만, 양끝·연속 하이픈 금지 규칙에 어긋납니다.') },
  nameLength: { label: t('name 길이'), meaning: t('name은 1–64자여야 합니다.') },
  nameMismatch: { label: t('name≠폴더명'), meaning: t('name이 폴더명과 다릅니다.') },
  descriptionMissing: { label: t('description 없음'), meaning: t('description이 없어 본문 첫 줄을 씁니다.') },
  descriptionLength: { label: t('description 김'), meaning: t('description이 1,024자를 넘습니다.') },
  bodyTooLong: { label: t('본문 500줄 초과'), meaning: t('본문은 500줄 이하를 권장합니다.') },
  listingTruncated: { label: t('목록에서 잘림'), meaning: t('description + when_to_use가 1,536자를 넘어 스킬 목록에서 잘립니다.') },
  reservedWord: { label: t('예약어'), meaning: t('이름에 anthropic/claude가 들어 있습니다(API 업로드 시 예약어).'), info: true },
};

export const RISK_LEVEL: Record<RiskLevel, string> = { low: t('위험 낮음'), medium: t('주의'), high: t('위험 높음') };
export const RISK_RANK: Record<RiskLevel, number> = { low: 0, medium: 1, high: 2 };
/** "Low" only means the rule check found no signal (UI debate 1-5). */
export const LOW_RISK_NOTE = t('위험 낮음은 규칙 검사에서 위험 신호를 찾지 못했다는 뜻이지, 안전하다는 보증이 아닙니다. 설치 전에 SKILL.md와 파일을 직접 확인하세요.');

export const METHOD: Record<InstallMethod, string> = { plugin: t('플러그인 설치'), 'skills-cli': t('skills CLI 설치'), 'manual-only': t('수동 설치') };

export const TRUST: Record<TrustTier, { label: string; hint: string }> = {
  official: { label: t('Anthropic 공식'), hint: t('anthropics 저장소') },
  partner: { label: t('파트너'), hint: t('공식 마켓의 외부 제작') },
  community: { label: t('커뮤니티'), hint: t('커뮤니티 마켓') },
  other: { label: t('기타'), hint: t('skills.sh·GitHub 등') },
};

/** Keys and order match server/src/search/category.ts. */
export const CATEGORY: Record<string, string> = {
  testing: t('테스트'),
  review: t('코드 리뷰·품질'),
  git: t('Git·협업'),
  ops: t('배포·인프라'),
  security: t('보안'),
  data: t('데이터·DB'),
  docs: t('문서·글쓰기'),
  design: t('디자인·UI'),
  ai: t('AI·에이전트'),
  productivity: t('생산성·업무'),
  business: t('비즈니스·마케팅'),
  dev: t('개발 일반'),
  other: t('기타'),
};

export const SCOPE: Record<string, string> ={ user: t('개인 (모든 프로젝트)'), project: t('프로젝트'), local: t('로컬 (이 프로젝트, 나만)') };

export const BREAKDOWN: Record<string, string> = { R: t('관련도'), P: t('인기'), F: t('최신성'), T: t('신뢰도') };

export const STAGES: Record<string, string> = {
  collect: t('후보 수집'),
  enrich: t('정보 확인'),
  score: t('점수 계산'),
};

export function formatCount(n: number | null | undefined): string {
  if (n == null) return '–';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}K`;
  return String(n);
}

export function formatAgo(iso: string | null | undefined): string {
  if (!iso) return '–';
  const days = Math.floor((Date.now() - Date.parse(iso)) / 86_400_000);
  if (Number.isNaN(days)) return '–';
  if (days < 1) return t('오늘');
  if (days < 30) return t('{0}일 전', days);
  if (days < 365) return t('{0}개월 전', Math.floor(days / 30));
  return t('{0}년 전', (days / 365).toFixed(1).replace(/\.0$/, ''));
}

export function formatBytes(n: number | null): string {
  if (n == null) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** "?" explanations next to a few headings (UI debate stage 4), read from the same labels as the badges. */
export const HELP = {
  risk:
    t('위험 낮음·주의·위험 높음은 SKILL.md와 파일 목록을 규칙으로 검사한 결과입니다. 위험 높음: 내려받은 코드를 바로 실행하거나, 아무 명령이나 미리 허락하고 셸을 실행합니다. 주의: 스크립트·훅·MCP 서버처럼 내 PC에서 무언가 실행될 수 있습니다. ') +
    LOW_RISK_NOTE,
  scope: t('개인: 내 모든 프로젝트에서 씁니다. 프로젝트: 고른 폴더에서만 쓰고, 설정 파일이 git으로 팀과 공유될 수 있습니다. 로컬: 고른 폴더에서 나만 씁니다(플러그인만).'),
  score: t('점수는 관련도·인기·최신성·신뢰도를 고정 비율(55·20·10·15)로 더한 참고값입니다. 결과 순서는 이름 일치 → 다운로드 → 스타 기준이라 점수 순서와 다를 수 있습니다.'),
} as const;

/** The popular-repo collection's job label (server tasks.ts). */
export const POPULAR_JOB = 'popular-repos';
/** What a job works on: "인기 저장소", "전체" (every marketplace) or the marketplace's name. */
export const jobTarget = (j: Pick<Job, 'label'>) => (j.label === POPULAR_JOB ? t('인기 저장소') : j.label === '*' ? t('전체') : j.label);
/** A running job in one line, as the search page's status line says it ("claude-community 마켓플레이스 스킬 모으는 중 12/40"). */
export function jobLine(j: Pick<Job, 'kind' | 'label' | 'done' | 'total'>): string {
  const what =
    j.kind === 'sync'
      ? t('{0} 동기화 중', j.label === '*' ? t('마켓플레이스') : t('{0} 마켓플레이스', j.label))
      : j.label === POPULAR_JOB
        ? t('인기 저장소의 스킬 모으는 중')
        : t('{0} 스킬 모으는 중', j.label === '*' ? t('모든 마켓플레이스') : t('{0} 마켓플레이스', j.label));
  const pct = j.total > 0 ? ` (${Math.floor((j.done / j.total) * 100)}%)` : '';
  return `${what} ${j.done}/${j.total || '?'}${pct}`;
}
