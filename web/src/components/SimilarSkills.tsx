import { useEffect, useState } from 'react';
import { apiGet } from '../api.ts';
import { t } from '../i18n.ts';
import { useInstalled } from '../installed.ts';
import type { ResultItem } from '../types.ts';
import { ResultCard, skillHref } from './ResultCard.tsx';

/** `GET /api/skills/:id/similar` (server/src/routes/similar.ts). */
type SimilarEntry = { item: ResultItem; score: number; matchedTerms: string[]; lowerRisk: boolean };
type SimilarResult = {
  terms: string[];
  similar: SimilarEntry[];
  siblings: SimilarEntry[];
  siblingsOf: 'plugin' | 'repo' | null;
  siblingsTotal: number;
  hidden: { highRisk: number; lowStars: number };
};

/**
 * Similar skills and alternatives on a skill's page (feature review 2026-11-04 F4): skills of other repos that do the
 * same job, flagged when their risk is lower, and the other skills of the same plugin or repo. No AI: the skill's
 * words matched against the local index, as README 추천 does.
 */
export function SimilarSkills({ skillId, projectPath, onOpenSkill }: { skillId: string; projectPath?: string | null; onOpenSkill: (id: string) => void }) {
  const [data, setData] = useState<SimilarResult | null>(null);
  const [failed, setFailed] = useState(false);
  const installedAs = useInstalled(projectPath ?? '');

  useEffect(() => {
    let alive = true;
    setData(null);
    setFailed(false);
    apiGet<SimilarResult>(`/skills/${encodeURIComponent(skillId)}/similar`)
      .then((d) => alive && setData(d))
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, [skillId]);

  // a side section: when it cannot be had, the page simply goes without it
  if (failed) return null;

  const cards = (entries: SimilarEntry[], offset: number) => (
    <div className="results">
      {entries.map((e, i) => (
        <div key={e.item.id}>
          <ResultCard
            item={e.item}
            position={offset + i}
            href={skillHref(e.item.id, undefined, projectPath)}
            installed={installedAs(e.item)}
            onSelect={() => onOpenSkill(e.item.id)}
          />
          {(e.lowerRisk || e.matchedTerms.length > 0) && (
            <p className="muted small matched-terms">
              {e.lowerRisk && (
                <span className="status-chip ok" title={t('이 스킬보다 위험 등급이 낮습니다')}>
                  {t('더 낮은 위험')}
                </span>
              )}{' '}
              {e.matchedTerms.length > 0 && t('겹친 단어: {0}', e.matchedTerms.join(', '))}
            </p>
          )}
        </div>
      ))}
    </div>
  );

  const hidden = data ? data.hidden.highRisk + data.hidden.lowStars : 0;
  return (
    <section aria-labelledby="similar-title">
      <h2 id="similar-title">{t('비슷한 스킬')}</h2>
      {!data ? (
        <p className="muted small">{t('불러오는 중…')}</p>
      ) : (
        <>
          <h3>{t('같은 일을 하는 다른 스킬')}</h3>
          {data.similar.length > 0 ? (
            cards(data.similar, 0)
          ) : (
            <p className="muted small">{t('색인에서 비슷한 스킬을 찾지 못했습니다.')}</p>
          )}
          {hidden > 0 && <p className="muted small">{t('검색처럼 위험 높음 {0}개와 별 기준에 못 미치거나 별 수를 모르는 {1}개는 뺐습니다.', data.hidden.highRisk, data.hidden.lowStars)}</p>}
          {data.siblings.length > 0 && (
            <>
              <h3>{t('같은 저장소·플러그인의 다른 스킬')}</h3>
              {data.siblingsTotal > data.siblings.length && <p className="muted small">{t('{0}개 중 {1}개', data.siblingsTotal, data.siblings.length)}</p>}
              {cards(data.siblings, data.similar.length)}
            </>
          )}
        </>
      )}
    </section>
  );
}
