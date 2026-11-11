import { useEffect, useState } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { apiGet } from '../api.ts';
import { t } from '../i18n.ts';
import { formatAgo, formatCount, TRUST } from '../labels.ts';
import type { RiskLevel, TrustTier } from '../types.ts';
import { RiskBadge } from './Badges.tsx';
import { Icon } from './Icon.tsx';
import './source-card.css';

/** `GET /api/skills/:id/source` (server/src/dedupe/sourceCard.ts). */
type ClusterMember = {
  id: string;
  name: string;
  repo: string | null;
  trust: TrustTier;
  installs: number | null;
  stars: number | null;
  riskLevel: RiskLevel;
  sameText: boolean;
  since: string | null;
};
type SourceInfo = {
  repo: string | null;
  createdAt: string | null;
  ownerType: string | null;
  fork: boolean;
  parent: string | null;
  movedTo: string | null;
  goneAt: string | null;
  archived: boolean;
  firstSeenAt: string | null;
  trust: TrustTier;
  officialTwins: Array<{ id: string; name: string; repo: string | null; trust: TrustTier }>;
  cluster: { size: number; representative: ClusterMember; members: ClusterMember[]; renamed: number } | null;
};
type CompareResponse = {
  other: { id: string; name: string; repo: string | null; ref: string | null };
  diff: { text: string; added: number; removed: number; truncated: boolean; approximate: boolean };
};

const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString() : '–');
const ownerLabel = (type: string | null) => (type === 'Organization' ? t('조직') : type === 'User' ? t('개인') : (type ?? t('모름')));
const githubUrl = (repo: string) => `https://github.com/${repo.split('/').map(encodeURIComponent).join('/')}`;

/**
 * Where the skill comes from (feature review F5): the repo's age, a person or an organization, what it was forked from,
 * moved or gone, and when this app first saw it; a warning when an official or partner skill of the same name has
 * other text, with its line differences. Then its near-copy group (B8): the likely original and the copies. From
 * the local index; only the line differences read the two SKILL.md files.
 */
export function SourceCard({ skillId, onOpenSkill }: { skillId: string; onOpenSkill: (id: string) => void }) {
  const [data, setData] = useState<SourceInfo | null>(null);
  const [failed, setFailed] = useState(false);
  const [compare, setCompare] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setData(null);
    setFailed(false);
    apiGet<SourceInfo>(`/skills/${encodeURIComponent(skillId)}/source`)
      .then((d) => alive && setData(d))
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, [skillId]);

  // a side section: when it cannot be had, the page goes without it
  if (failed || !data || !data.repo) return null;
  const c = data.cluster;
  const others = c ? c.members.length : 0;
  return (
    <section aria-labelledby="source-title">
      <h2 id="source-title">{t('출처')}</h2>
      <dl className="source-card">
        <dt>{t('저장소')}</dt>
        <dd>
          <a className="mono" href={githubUrl(data.repo)} target="_blank" rel="noopener noreferrer">
            {data.repo} <Icon name="external" size={12} />
          </a>
        </dd>
        <dt>{t('저장소 나이')}</dt>
        <dd>{data.createdAt ? t('{0}에 만듦 ({1})', day(data.createdAt), formatAgo(data.createdAt)) : t('모름 (별 정보 갱신 때 채워집니다)')}</dd>
        <dt>{t('소유자')}</dt>
        <dd>{ownerLabel(data.ownerType)}</dd>
        {data.fork && (
          <>
            <dt>{t('포크 원본')}</dt>
            <dd>
              {data.parent ? (
                <a className="mono" href={githubUrl(data.parent)} target="_blank" rel="noopener noreferrer">
                  {data.parent}
                </a>
              ) : (
                t('포크입니다 (원본은 모름)')
              )}
            </dd>
          </>
        )}
        {data.movedTo && (
          <>
            <dt>{t('옮겨짐')}</dt>
            <dd>{t('지금 이름은 {0}입니다', data.movedTo)}</dd>
          </>
        )}
        {data.goneAt && (
          <>
            <dt>{t('사라짐')}</dt>
            <dd className="gone">{t('{0}부터 GitHub에서 찾을 수 없습니다 (삭제됐거나 비공개)', day(data.goneAt))}</dd>
          </>
        )}
        {data.archived && (
          <>
            <dt>{t('보관')}</dt>
            <dd>{t('보관된 저장소')}</dd>
          </>
        )}
        <dt>{t('앱이 처음 본 날')}</dt>
        <dd>{day(data.firstSeenAt)}</dd>
      </dl>

      {data.officialTwins.length > 0 && (
        <div className="warn-box source-twins">
          <p>
            <b>{t('공식 스킬과 다른 내용')}</b> — {t('이름이 같은 공식·파트너 스킬과 SKILL.md가 다릅니다. 사본을 고친 것일 수 있으니 차이를 확인하세요.')}
          </p>
          {data.officialTwins.map((tw) => (
            <p key={tw.id} className="small">
              <button type="button" className="linkish" onClick={() => onOpenSkill(tw.id)}>
                {tw.name}
              </button>{' '}
              <span className="mono muted">{tw.repo}</span> · {TRUST[tw.trust].label} ·{' '}
              <button type="button" className="linkish" onClick={() => setCompare(tw.id)}>
                {t('줄 차이 보기')}
              </button>
            </p>
          ))}
        </div>
      )}

      {c && (
        <>
          <h3>{t('원본 후보·사본')}</h3>
          <p className="muted small">
            {t('내용이 거의 같은 스킬 {0}개가 한 계열입니다(이름 다른 사본 {1}개 포함). 다운로드 수는 합치지 않습니다.', c.size, c.renamed)}
          </p>
          <p className="small">
            {c.representative.id === skillId ? (
              <span className="rep">{t('이 스킬이 원본 후보입니다 (공식 → 파트너 → 다운로드 → 스타 → 오래된 저장소 순).')}</span>
            ) : (
              <>
                {t('원본 후보: ')}
                <button type="button" className="linkish" onClick={() => onOpenSkill(c.representative.id)}>
                  {c.representative.name}
                </button>{' '}
                <span className="mono muted">{c.representative.repo}</span>
              </>
            )}
          </p>
          {others > 0 && (
            <ul className="cluster-list" aria-label={t('사본')}>
              {c.members.map((m) => (
                <li key={m.id}>
                  <button type="button" className="linkish" onClick={() => onOpenSkill(m.id)}>
                    {m.name}
                  </button>
                  <span className="mono">{m.repo}</span>
                  {m.id === c.representative.id && <span className="rep small">{t('원본 후보')}</span>}
                  {m.trust !== 'other' && <span className="small">{TRUST[m.trust].label}</span>}
                  <span className="small muted">
                    <Icon name="download" size={12} /> {formatCount(m.installs)} · <Icon name="star" size={12} /> {formatCount(m.stars)}
                  </span>
                  <span className="small muted">{m.sameText ? t('같은 SKILL.md') : t('조금 다름')}</span>
                  {m.riskLevel !== 'low' && <RiskBadge level={m.riskLevel} />}
                </li>
              ))}
            </ul>
          )}
          {c.size - 1 > others && <p className="muted small">{t('… 외 {0}개', c.size - 1 - others)}</p>}
        </>
      )}

      {compare && <CompareDialog skillId={skillId} withId={compare} onOpenChange={(open) => !open && setCompare(null)} />}
    </section>
  );
}

/** The other skill's SKILL.md (−) against this one's (+), line by line (server/src/watch/diff.ts). */
function CompareDialog({ skillId, withId, onOpenChange }: { skillId: string; withId: string; onOpenChange: (open: boolean) => void }) {
  const [data, setData] = useState<CompareResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    apiGet<CompareResponse>(`/skills/${encodeURIComponent(skillId)}/compare`, { with: withId })
      .then((d) => alive && setData(d))
      .catch((e) => alive && setError(String((e as Error).message ?? e)));
    return () => {
      alive = false;
    };
  }, [skillId, withId]);
  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{t('공식 스킬과 다른 내용')}</DialogTitle>
          <DialogDescription>{data ? t('{0}의 SKILL.md(−)와 이 스킬의 SKILL.md(+)의 줄 단위 차이입니다.', data.other.repo ?? data.other.name) : t('불러오는 중…')}</DialogDescription>
        </DialogHeader>
        {error && <p className="warn-box">{error}</p>}
        {data && (
          <>
            <p className="muted small">
              {data.diff.text ? t('{0}줄 추가, {1}줄 삭제', data.diff.added, data.diff.removed) : t('SKILL.md 내용은 같습니다 (다른 파일이 다를 수 있음).')}
              {data.diff.approximate && ` ${t('차이가 너무 커서 바뀐 부분을 통째로 보입니다.')}`}
              {data.diff.truncated && ` ${t('길어서 앞부분만 보입니다.')}`}
            </p>
            {data.diff.text && (
              <pre className="mono small max-h-[55vh] overflow-auto whitespace-pre" aria-label={t('차이')}>
                {data.diff.text.split('\n').map((line, i) => (
                  <div
                    key={i}
                    className={line.startsWith('@@') ? 'text-(--info)' : line.startsWith('+') && i > 1 ? 'text-(--ok)' : line.startsWith('-') && i > 1 ? 'text-(--danger)' : undefined}
                  >
                    {line || ' '}
                  </div>
                ))}
              </pre>
            )}
          </>
        )}
        <DialogFooter>
          <button type="button" className="ghost" onClick={() => onOpenChange(false)}>
            {t('닫기')}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
