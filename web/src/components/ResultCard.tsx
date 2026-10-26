import { Icon } from './Icon.tsx';
import { formatAgo, formatCount, METHOD } from '../labels.ts';
import { useKorean } from '../translate.ts';
import type { ResultItem } from '../types.ts';
import { QualityBadges, RiskBadge, RiskFlags, ScoreBar, SourceBadges } from './Badges.tsx';

export function ResultCard({ item, position, provisional, onSelect }: { item: ResultItem; position: number; provisional?: boolean; onSelect: () => void }) {
  const { ko, waiting } = useKorean(item.description, position);
  return (
    <article
      className={`card ${provisional ? 'provisional' : ''}`}
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect();
        }
      }}
      aria-label={`${item.name} 상세 페이지로 이동`}
    >
      <div className="card-head">
        <h3>{item.name}</h3>
        {item.plugin && (
          <span className="muted small" title={`${item.plugin.marketplace} 마켓플레이스의 플러그인`}>
            {item.plugin.name} 플러그인{item.plugin.skillCount > 1 ? ` · 스킬 ${item.plugin.skillCount}개` : ''}
          </span>
        )}
        <span className="spacer" />
        <ScoreBar score={item.score} breakdown={item.breakdown} />
      </div>
      <p className="summary clamp" title={ko ? item.description : undefined} lang={ko ? 'ko' : 'en'}>
        {waiting && <span className="translating">번역 중 · </span>}
        {ko ?? (item.description || '설명 없음')}
      </p>
      <div className="meta">
        <SourceBadges sources={item.sources} />
        <span className="stat" title="설치 수 (skills.sh)">
          <Icon name="download" size={14} /> {formatCount(item.installs)}
        </span>
        <span className="stat" title="저장소 별점">
          <Icon name="star" size={14} /> {formatCount(item.stars)}
        </span>
        <span className="stat" title="최근 커밋">
          <Icon name="clock" size={14} /> {formatAgo(item.lastCommitAt)}
        </span>
        <span className="stat method">{METHOD[item.install.method]}</span>
      </div>
      <div className="badges">
        <RiskBadge level={item.riskLevel} />
        <RiskFlags flags={item.riskFlags} />
        <QualityBadges codes={item.qualityWarnings} />
      </div>
    </article>
  );
}
