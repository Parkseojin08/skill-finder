import { useEffect, useState } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { QUALITY, RISK_FLAGS, RISK_LEVEL } from '../labels.ts';
import { B5_RISK_FLAGS, lintSkill, type LintProblem, type LintResult } from '../lib/security.ts';
import { serverText, t } from '../i18n.ts';
import { EvidenceLine } from './RiskEvidence.tsx';
import './lint-dialog.css';

/** A risk flag's words: labels.ts, or the stage 3 table until labels.ts spreads it in. */
const flagInfo = (f: string) => RISK_FLAGS[f] ?? B5_RISK_FLAGS[f];
const flagLabel = (f: string) => flagInfo(f)?.label ?? f;

/** The lint's own findings (server lint/lint.ts LintCode). */
const LINT_CODE: Record<string, string> = {
  skillMdMissing: t('SKILL.md가 없습니다.'),
  skillMdTooLarge: t('SKILL.md가 512KB를 넘어 앞부분만 검사했습니다.'),
  notFoundByCli: t('frontmatter에 name과 description이 모두 있어야 skills CLI(npx skills add)가 찾습니다.'),
  internalSkill: t('metadata.internal: true라 skills CLI 목록에 보이지 않습니다.'),
  claudeOnly: t('Claude Code에서만 뜻이 있는 설정이 있습니다. 다른 에이전트는 무시하거나 다르게 다룰 수 있습니다(추측).'),
  folderName: t('skills CLI로 설치하면 폴더 이름이 name을 따라 바뀝니다.'),
  claudeKeys: t('Claude Code 전용 frontmatter 키가 있습니다. 다른 에이전트는 무시합니다(추측).'),
  filesSkipped: t('일부 텍스트 파일은 검사하지 않았습니다(256KB 초과, 50개 넘음, 링크, 바이너리).'),
};

const MARK = { error: '✖', warning: '!', info: '·' } as const;
const SEVERITY = { error: t('오류'), warning: t('경고'), info: t('정보') } as const;

function problemText(p: LintProblem): string {
  const q = QUALITY[p.code];
  if (q) return `${q.label} — ${q.meaning}`;
  const f = flagInfo(p.code);
  if (f) return `${f.label} — ${f.meaning}`;
  return LINT_CODE[p.code] ?? serverText(p.message);
}

/**
 * "검사" on a 설치됨 row the index does not know (feature review F15): the quality rules, risk signals with their lines,
 * the context it takes, what Claude sees in its skill list, whether the skills CLI finds it, notes for other agents
 * and similar indexed skills. Nothing is changed.
 */
export function LintDialog({ path, projectPath, onOpenChange, onOpenSkill }: { path: string; projectPath?: string | null; onOpenChange: (open: boolean) => void; onOpenSkill?: (id: string) => void }) {
  const [data, setData] = useState<LintResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    setData(null);
    setError(null);
    lintSkill(path, projectPath)
      .then((d) => alive && setData(d))
      .catch((e) => alive && setError(String((e as Error).message ?? e)));
    return () => {
      alive = false;
    };
  }, [path, projectPath]);

  const count = (s: LintProblem['severity']) => data?.problems.filter((p) => p.severity === s).length ?? 0;
  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="lint-dialog sm:max-w-3xl">
        <DialogHeader>
          {/* the folder's name until the answer brings the skill's own */}
          <DialogTitle>{t('{0} 검사', data?.name ?? path.split(/[\\/]/).filter(Boolean).pop() ?? '')}</DialogTitle>
          <DialogDescription>{t('색인에 없는 내 스킬을 색인과 같은 규칙으로 검사합니다. 파일은 읽기만 합니다.')}</DialogDescription>
        </DialogHeader>
        {error && <p className="warn-box">{error}</p>}
        {!data && !error && <p className="muted small">{t('검사하는 중…')}</p>}
        {data && (
          <div className="lint-scroll">
            <section>
              <p className={data.ok ? 'small' : 'warn-box'}>
                {data.ok ? t('고칠 문제를 찾지 못했습니다.') : t('오류 {0} · 경고 {1} · 정보 {2}', count('error'), count('warning'), count('info'))}{' '}
                <span className={`badge risk-${data.risk.level}`}>{RISK_LEVEL[data.risk.level]}</span>
              </p>
              <p className="muted small mono">{data.path}</p>
            </section>

            {data.problems.length > 0 && (
              <section>
                <h3>{t('찾은 것')}</h3>
                <ul className="lint-problems">
                  {data.problems.map((p, i) => (
                    <li key={i}>
                      <span className={`lint-mark ${p.severity}`} title={SEVERITY[p.severity]} aria-label={SEVERITY[p.severity]}>
                        {MARK[p.severity]}
                      </span>
                      <span>
                        {problemText(p)}
                        {p.file && <span className="lint-where mono"> {p.line != null ? `${p.file}:${p.line}` : p.file}</span>}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {data.risk.flags.length > 0 && (
              <section>
                <h3>{t('위험 신호와 근거')}</h3>
                <ul className="list-none pl-0">
                  {data.risk.flags.map((f) => {
                    const ev = data.risk.evidence[f];
                    const inFiles = data.files.findings.flatMap((x) => x.evidence.filter((e) => e.flag === f));
                    const places = [...(ev?.items ?? []), ...inFiles].slice(0, 10);
                    return (
                      <li key={f} className="my-2">
                        <b>{flagLabel(f)}</b> <span className="muted small">— {flagInfo(f)?.meaning ?? ''}</span>
                        {places.length > 0 && (
                          <ul className="list-none pl-0">
                            {places.map((e, i) => (
                              <EvidenceLine key={i} e={e} />
                            ))}
                          </ul>
                        )}
                      </li>
                    );
                  })}
                </ul>
                <p className="muted small">{t('SKILL.md와 텍스트 파일 {0}개를 검사했습니다.', data.files.checked)}</p>
              </section>
            )}

            <section>
              <h3>{t('컨텍스트 비용 (추정)')}</h3>
              <p className="small">{t('설치해 두면 매 요청 약 {0} 토큰, 쓸 때 약 {1} 토큰', data.tokens.perTurn, data.tokens.onUse ?? '?')}</p>
            </section>

            <section>
              <h3>{t('Claude가 스킬 목록에서 보는 글')}</h3>
              <p className="muted small">
                {data.listing.truncated
                  ? t('description과 when_to_use를 합쳐 {0}자 중 {1}자까지만 보입니다({2}자 잘림).', data.listing.chars, data.listing.limit, data.listing.cut)
                  : t('description과 when_to_use를 합쳐 {0}자 (한도 {1}자)', data.listing.chars, data.listing.limit)}
              </p>
              <pre className="lint-listing small">
                {data.listing.text || ' '}
                {data.listing.truncated && <span className="lint-cut">{t('… (여기서 잘림)')}</span>}
              </pre>
            </section>

            <section>
              <h3>{t('다른 도구에서')}</h3>
              <ul className="small">
                <li>
                  {data.skillsCli.found
                    ? t('skills CLI(npx skills add)가 이 스킬을 찾습니다. 설치하면 폴더 이름은 {0}입니다.', data.skillsCli.folder)
                    : data.skillsCli.reason === 'internal'
                      ? t('metadata.internal: true라 skills CLI 목록에 보이지 않습니다.')
                      : t('skills CLI가 찾지 못합니다: frontmatter에 name과 description이 모두 필요합니다.')}
                </li>
                {data.agents.claudeOnlyFlags.length > 0 && (
                  <li>{t('{0}은(는) Claude Code에서만 뜻이 있습니다. 다른 에이전트에서는 무시되거나 다르게 동작할 수 있습니다(추측).', data.agents.claudeOnlyFlags.map(flagLabel).join(', '))}</li>
                )}
                {data.agents.claudeKeys.length > 0 && <li>{t('Claude Code 전용 frontmatter 키: {0}', data.agents.claudeKeys.join(', '))}</li>}
                {data.agentsReading && data.agentsReading.length > 0 && <li>{t('이 폴더를 읽는 에이전트: {0}', data.agentsReading.map((a) => a.name).join(', '))}</li>}
              </ul>
            </section>

            {data.similar && (
              <section>
                <h3>{t('색인의 비슷한 스킬')}</h3>
                {data.similar.length === 0 ? (
                  <p className="muted small">{t('비슷한 스킬을 찾지 못했습니다.')}</p>
                ) : (
                  <ul className="lint-similar small">
                    {data.similar.map((s) => (
                      <li key={s.id}>
                        {onOpenSkill ? (
                          <button type="button" className="linkish" onClick={() => onOpenSkill(s.id)}>
                            {s.name}
                          </button>
                        ) : (
                          <b>{s.name}</b>
                        )}{' '}
                        <span className={`badge risk-${s.riskLevel}`}>{RISK_LEVEL[s.riskLevel]}</span>{' '}
                        <span className="muted">{s.description ?? ''}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            )}
          </div>
        )}
        <DialogFooter>
          <button type="button" className="primary" onClick={() => onOpenChange(false)}>
            {t('닫기')}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
