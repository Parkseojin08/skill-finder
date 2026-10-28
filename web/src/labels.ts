import type { InstallMethod, RiskLevel, TrustTier } from './types.ts';

export const RISK_FLAGS: Record<string, { label: string; meaning: string; info?: boolean }> = {
  scripts: { label: '스크립트 포함', meaning: '실행 가능한 코드(.sh, .py, .js 등)가 들어 있습니다.' },
  preapprovedBash: { label: 'Bash 사전 승인', meaning: '이 스킬이 쓰이는 동안 Bash가 승인 없이 실행될 수 있습니다.' },
  unscopedBash: { label: 'Bash 무제한', meaning: 'Bash 사전 승인에 명령 제한도 없습니다.' },
  shellInjection: { label: '셸 명령 주입', meaning: '스킬이 호출되면 Claude가 내용을 보기 전에 셸 명령이 실행됩니다.' },
  skillHooks: { label: '스킬 훅', meaning: '스킬이 호출되면 훅을 등록합니다.' },
  pluginRootDependency: { label: '플러그인 전용', meaning: '플러그인으로 설치해야 동작합니다. 폴더만 복사하면 깨집니다.' },
  pluginHooks: { label: '플러그인 훅', meaning: '플러그인을 설치하면 훅이 함께 설치·실행됩니다.' },
  pluginMcp: { label: 'MCP 서버', meaning: '플러그인을 설치하면 MCP 서버가 함께 설치·실행됩니다.' },
  pluginBin: { label: '실행 파일(bin)', meaning: '플러그인이 활성화되면 실행 파일이 Bash PATH에 올라갑니다.' },
  pluginMonitors: { label: '모니터', meaning: '플러그인을 설치하면 모니터가 함께 설치·실행됩니다.' },
  curlPipeShell: { label: '원격 스크립트 실행', meaning: '원격 스크립트를 내려받아 바로 실행하는 명령(curl | sh)이 있습니다.' },
  rmRf: { label: 'rm -rf', meaning: '강제 삭제 명령이 들어 있습니다(정보).', info: true },
  commandSource: { label: 'command 출처', meaning: '설치할 때 마켓플레이스가 지정한 명령이 실행됩니다.' },
  unscanned: { label: '끝까지 검사 못 함', meaning: 'SKILL.md가 512KB를 넘거나 frontmatter가 너무 커서 일부만 검사했습니다. 검사하지 못한 부분에 명령이 있을 수 있습니다.' },
};

export const QUALITY: Record<string, { label: string; meaning: string; info?: boolean }> = {
  noFrontmatter: { label: 'frontmatter 없음', meaning: '첫 줄이 ---로 시작하는 frontmatter가 없습니다.' },
  yamlError: { label: 'YAML 오류', meaning: 'frontmatter YAML을 파싱하지 못했습니다.' },
  nameMissing: { label: 'name 없음', meaning: 'name이 없어 폴더명을 씁니다.' },
  nameFormat: { label: 'name 형식', meaning: '소문자·숫자·하이픈만, 양끝·연속 하이픈 금지 규칙에 어긋납니다.' },
  nameLength: { label: 'name 길이', meaning: 'name은 1–64자여야 합니다.' },
  nameMismatch: { label: 'name≠폴더명', meaning: 'name이 폴더명과 다릅니다.' },
  descriptionMissing: { label: 'description 없음', meaning: 'description이 없어 본문 첫 줄을 씁니다.' },
  descriptionLength: { label: 'description 김', meaning: 'description이 1,024자를 넘습니다.' },
  bodyTooLong: { label: '본문 500줄 초과', meaning: '본문은 500줄 이하를 권장합니다.' },
  listingTruncated: { label: '목록에서 잘림', meaning: 'description + when_to_use가 1,536자를 넘어 스킬 목록에서 잘립니다.' },
  reservedWord: { label: '예약어', meaning: '이름에 anthropic/claude가 들어 있습니다(API 업로드 시 예약어).', info: true },
};

export const RISK_LEVEL: Record<RiskLevel, string> = { low: '위험 낮음', medium: '주의', high: '위험 높음' };

export const METHOD: Record<InstallMethod, string> = { plugin: '플러그인 설치', 'skills-cli': 'skills CLI 설치', 'manual-only': '수동 설치' };

export const TRUST: Record<TrustTier, { label: string; hint: string }> = {
  official: { label: 'Anthropic 공식', hint: 'anthropics 저장소' },
  partner: { label: '파트너', hint: '공식 마켓의 외부 제작' },
  community: { label: '커뮤니티', hint: '커뮤니티 마켓' },
  other: { label: '기타', hint: 'skills.sh·GitHub 등' },
};

/** Keys and order match server/src/search/category.ts. */
export const CATEGORY: Record<string, string> = {
  testing: '테스트',
  review: '코드 리뷰·품질',
  git: 'Git·협업',
  ops: '배포·인프라',
  security: '보안',
  data: '데이터·DB',
  docs: '문서·글쓰기',
  design: '디자인·UI',
  ai: 'AI·에이전트',
  productivity: '생산성·업무',
  business: '비즈니스·마케팅',
  dev: '개발 일반',
  other: '기타',
};

export const SCOPE: Record<string, string> ={ user: '개인 (모든 프로젝트)', project: '프로젝트', local: '로컬 (이 프로젝트, 나만)' };

export const BREAKDOWN: Record<string, string> = { R: '관련도', P: '인기', F: '최신성', T: '신뢰도' };

export const STAGES: Record<string, string> = {
  collect: '후보 수집',
  enrich: '정보 확인',
  score: '점수 계산',
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
  if (days < 1) return '오늘';
  if (days < 30) return `${days}일 전`;
  if (days < 365) return `${Math.floor(days / 30)}개월 전`;
  return `${(days / 365).toFixed(1).replace(/\.0$/, '')}년 전`;
}

export function formatBytes(n: number | null): string {
  if (n == null) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
