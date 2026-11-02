import { goInApp } from '../../lib/links.ts';
import type { Health } from '../../types.ts';
import { TranslationNotice } from '../TranslationNotice.tsx';
import { t } from '../../i18n.ts';
import { tj } from '../../i18nNodes.tsx';

/** The search page before a search: what it does, example queries, versions and what is missing (split out of SearchPage). */
export function SearchIntro({ examples, onExample, health, githubToken }: { examples: string[]; onExample: (query: string) => void; health: Health | null; githubToken: boolean | null }) {
  return (
    <div className="empty">
      <p>
        {t('원하는 기능을 적으면 공식·커뮤니티 마켓플레이스, skills.sh, GitHub에서 Claude Code 스킬을 찾아 점수와 위험 신호를 붙여 보여 줍니다. 영어로 적을 때 가장 정확하고, 한국어로 적으면 영어 검색어를 제안합니다.')}
      </p>
      <div className="examples">
        {examples.map((ex) => (
          <button key={ex} type="button" className="chip-btn" onClick={() => onExample(ex)}>
            {ex}
          </button>
        ))}
      </div>
      {health && (
        <p className="sysline">
          {health.appVersion && <span>skill-finder {health.appVersion}</span>}
          <span className={health.claudeVersion ? '' : 'warn-text'}>claude-code {health.claudeVersion ?? t('없음')}</span>
          <span>skills-cli {health.skillsCli}</span>
          <span>
            {t('색인 스킬 {0} · 플러그인 {1}', health.skills.toLocaleString(), health.plugins.toLocaleString())}
          </span>
        </p>
      )}
      {health && !health.claudeVersion && <p className="warn-text small">{t('Claude Code를 찾지 못해 플러그인 설치가 되지 않습니다.')}</p>}
      {githubToken === false && (
        // before the first search only (UI debate D-4); in results it stays in the folded notices (D#260b)
        <p className="muted small">
          {tj('GitHub 토큰 없음 · GitHub 코드 검색을 건너뛰고 스킬 목록도 느리게 모읍니다. {0}', <a href="/settings" onClick={(e) => goInApp(e, '/settings')}>
            {t('설정에서 넣기')}
          </a>)}
        </p>
      )}
      <TranslationNotice />
    </div>
  );
}
