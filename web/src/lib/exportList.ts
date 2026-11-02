// Search results and the 설치됨 list as files to keep or share (review 2026-11-02). Made in the browser only;
// nothing is sent anywhere.
import { RISK_LEVEL } from '../labels.ts';
import type { InstalledResponse, ResultItem } from '../types.ts';
import { repoOf } from './resultOrder.ts';
import { t } from '../i18n.ts';

const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
/** The text of a Markdown link: brackets in a name would end it early. */
export const linkText = (s: string) => s.replace(/[[\]\\]/g, (c) => `\\${c}`);
const today = () => new Date().toISOString().slice(0, 10);

export function resultsJson(query: string, items: ResultItem[]): string {
  return (
    JSON.stringify(
      {
        query,
        exportedAt: new Date().toISOString(),
        results: items.map((it) => ({
          id: it.id,
          name: it.name,
          repo: repoOf(it),
          url: it.sources.find((s) => s.url)?.url ?? null,
          description: it.description,
          installs: it.installs ?? null,
          stars: it.stars ?? null,
          riskLevel: it.riskLevel,
          riskFlags: it.riskFlags,
          installCommand: it.install.command || null,
        })),
      },
      null,
      2,
    ) + '\n'
  );
}

export function resultsMarkdown(query: string, items: ResultItem[]): string {
  const rows = items.map((it) => {
    const url = it.sources.find((s) => s.url)?.url;
    const name = url ? `[${linkText(cell(it.name))}](${url})` : cell(it.name);
    return `| ${name} | ${cell(repoOf(it) ?? '')} | ${it.installs ?? ''} | ${it.stars ?? ''} | ${RISK_LEVEL[it.riskLevel]} | ${it.install.command ? `\`${cell(it.install.command)}\`` : ''} |`;
  });
  return [
    t('# Skill Finder 검색: {0} ({1})', query, today()),
    '',
    t('위험 등급은 Skill Finder 규칙으로 판정한 것이고 안전 보증이 아닙니다.'),
    '',
    t('| 이름 | 저장소 | 설치 수 | 별 | 위험 | 설치 명령 |'),
    '|---|---|---|---|---|---|',
    ...rows,
    '',
  ].join('\n');
}

export function installedMarkdown(data: InstalledResponse, projectPath: string): string {
  const plugins = data.plugins.map(
    (p) => `| ${cell(p.id)} | ${p.scope} | ${p.version ?? ''} | ${p.topRisk ? RISK_LEVEL[p.topRisk] : t('알 수 없음')} | ${p.removeCommand ? `\`${p.removeCommand}\`` : ''} |`,
  );
  const skills = data.skills.map(
    (s) => `| ${cell(s.name)} | ${s.scope === 'user' ? t('개인') : t('프로젝트')} | ${RISK_LEVEL[s.risk.level]} | ${s.tokens.perTurn} | \`${cell(s.removeCommand)}\` |`,
  );
  return [
    t('# Skill Finder 설치됨 ({0})', today()),
    projectPath ? t('\n프로젝트: {0}', projectPath) : '',
    '',
    t('## 플러그인'),
    '',
    t('| 플러그인 | 범위 | 버전 | 위험(안의 스킬 중 최고) | 삭제 명령 |'),
    '|---|---|---|---|---|',
    ...plugins,
    '',
    t('## 스킬'),
    '',
    t('| 이름 | 범위 | 위험(설치된 파일 기준) | 매 턴 토큰(추정) | 삭제 명령 |'),
    '|---|---|---|---|---|',
    ...skills,
    '',
  ].join('\n');
}

/** Saves text as a file through the browser's download (no server involved). */
export function saveFile(name: string, text: string, type: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: `${type};charset=utf-8` }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** A file name part from a query ("pdf tables" → "pdf-tables"). */
export const fileStem = (query: string) => query.trim().toLowerCase().replace(/[^a-z0-9가-힣]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'results';
