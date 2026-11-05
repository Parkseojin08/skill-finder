// The check chips above the 설치됨 screen's lists (feature review F8): each says how many skills it finds and
// turns on that filter for the skills table. The overlap chip also opens the pairs, each with both descriptions and
// words and a "delete one" that goes through the page's usual confirm dialog.
import { t } from '../i18n.ts';
import type { CheckChip, CheckKey, CheckPair, CheckSide } from '../lib/installedCheck.ts';
import { TOP_CONTEXT } from '../lib/installedCheck.ts';

export const CHECK_LABEL: Record<CheckKey, (n: number) => string> = {
  riskUp: (n) => t('위험 오름 {0}', n),
  originChanged: (n) => t('원본 바뀜 {0}', n),
  twoScopes: (n) => t('두 범위에 같은 이름 {0}', n),
  sameContent: (n) => t('같은 내용 중복 {0}', n),
  pluginOff: (n) => t('꺼진 플러그인 안 {0}', n),
  unindexed: (n) => t('색인에 없음 {0}', n),
  topContext: () => t('컨텍스트 상위 {0}', TOP_CONTEXT),
  overlap: (n) => t('설명이 겹치는 쌍 {0}', n),
};
const CHECK_TIP: Record<CheckKey, string> = {
  riskUp: t('설치할 때보다 지금 규칙의 위험 등급이 높은 스킬'),
  originChanged: t('설치한 뒤 원본 저장소에 새 버전이 나온 스킬'),
  twoScopes: t('같은 이름이 개인 범위와 프로젝트 범위에 모두 있는 스킬. 이름·설명이 두 번 실릴 수 있습니다(추측).'),
  sameContent: t('SKILL.md 내용이 똑같은 사본(다른 에이전트 폴더 포함)'),
  pluginOff: t('꺼진 플러그인에 들어 있어 지금은 실리지 않는 스킬'),
  unindexed: t('앱의 색인에 없어 상세 화면이 없는 스킬'),
  topContext: t('매 요청에 이름·설명으로 가장 많은 토큰을 차지하는 스킬'),
  overlap: t('이름·설명 단어가 60% 이상 겹치는 스킬 쌍. 비슷한 설명이 여럿이면 Claude가 엉뚱한 것을 고를 수 있습니다(추측).'),
};

export function CheckChips({ chips, active, onToggle, loadingCheck }: { chips: CheckChip[]; active: CheckKey | null; onToggle: (k: CheckKey) => void; loadingCheck: boolean }) {
  return (
    <div className="examples" role="group" aria-label={t('점검 요약')}>
      <span className="muted small">{t('점검:')}</span>
      {chips.map((c) => (
        <button
          key={c.key}
          type="button"
          className={`status-chip action${active === c.key ? ' bg-[var(--neon-soft)]' : ''}`}
          aria-pressed={active === c.key}
          title={CHECK_TIP[c.key]}
          onClick={() => onToggle(c.key)}
        >
          {CHECK_LABEL[c.key](c.count)}
        </button>
      ))}
      {chips.length === 0 && !loadingCheck && <span className="muted small">{t('눈에 띄는 것이 없습니다.')}</span>}
      {loadingCheck && <span className="muted small">{t('겹침 검사 중…')}</span>}
    </div>
  );
}

function Side({ side, shared, onRemove, removeBlocked }: { side: CheckSide; shared: ReadonlySet<string>; onRemove: (() => void) | null; removeBlocked: string | null }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <b className="mono">{side.name}</b>
      <div className="muted small mono break-all">{side.path}</div>
      <p className="small">{side.description || <span className="muted">{t('설명 없음')}</span>}</p>
      <div className="flex flex-wrap gap-1">
        {side.tokens.map((w) => (
          <span key={w} className={`badge ${shared.has(w) ? 'flag' : 'flag info'}`}>
            {w}
          </span>
        ))}
      </div>
      <div>
        <button type="button" className="ghost danger" disabled={!onRemove} title={removeBlocked ?? undefined} onClick={onRemove ?? undefined}>
          {t('이쪽 삭제')}
        </button>
      </div>
    </div>
  );
}

/**
 * The overlapping pairs. `remover(path)`: the row's delete (the page's confirm dialog), or a reason it cannot be
 * deleted here (a plugin's skill, another agent's folder).
 */
export function OverlapPairs({ pairs, remover }: { pairs: CheckPair[]; remover: (path: string) => { remove: (() => void) | null; blocked: string | null } }) {
  return (
    <section aria-label={t('설명이 겹치는 쌍')}>
      <h3>{t('설명이 겹치는 쌍 ({0})', pairs.length)}</h3>
      <p className="muted small">{t('강조한 단어가 두 스킬에 함께 있습니다. 하나만 남기려면 한쪽을 삭제하세요.')}</p>
      <ul className="flex flex-col gap-4">
        {pairs.map((p) => {
          const shared = new Set(p.shared);
          const a = remover(p.a.path);
          const b = remover(p.b.path);
          return (
            <li key={`${p.a.path}|${p.b.path}`} className="border-t border-[var(--line)] pt-3">
              <div className="muted small">{t('겹침 {0}%', Math.round(p.score * 100))}</div>
              <div className="grid gap-4 sm:grid-cols-2">
                <Side side={p.a} shared={shared} onRemove={a.remove} removeBlocked={a.blocked} />
                <Side side={p.b} shared={shared} onRemove={b.remove} removeBlocked={b.blocked} />
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
