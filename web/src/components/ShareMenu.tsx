import { RISK_FLAGS, RISK_LEVEL } from '../labels.ts';
import type { SkillDetail } from '../types.ts';
import { linkText } from '../lib/exportList.ts';
import { shareLink } from '../lib/shareLink.ts';
import { CopyButton } from './CopyButton.tsx';

/**
 * "공유": what to paste in a chat or a README to point someone at this skill (review 2026-11-02: recommendations
 * spread in chats, and the app's own address opens on this PC only).
 */
export function ShareMenu({ detail }: { detail: SkillDetail }) {
  const url = detail.url ?? detail.sources.find((s) => s.url)?.url ?? '';
  const desc = (detail.description ?? '').replace(/\s+/g, ' ').trim();
  const short = desc.length > 120 ? `${desc.slice(0, 117)}…` : desc;
  const flags = detail.riskFlags.filter((f) => !RISK_FLAGS[f]?.info).map((f) => RISK_FLAGS[f]?.label ?? f);
  const risk = `${RISK_LEVEL[detail.riskLevel]}${flags.length ? ` (${flags.join(', ')})` : ''} · Skill Finder 규칙 기준, 안전 보증 아님`;
  const command = detail.install.command;
  // a page anyone can open (the landing site's /s/), with the risk and the command; the skill rides in the fragment
  const link = shareLink({ n: detail.name, d: desc, u: url, c: command, r: detail.riskLevel, f: detail.riskFlags, i: detail.id });
  const items: Array<{ label: string; text: string }> = [];
  items.push({ label: '공유 링크', text: link });
  if (url) items.push({ label: '저장소 주소', text: url });
  if (command) items.push({ label: '설치 명령', text: command });
  if (url) items.push({ label: 'Markdown 한 줄', text: `[${linkText(detail.name)}](${url})${short ? ` — ${short}` : ''}` });
  items.push({ label: '공유용 글', text: [`${detail.name}${short ? ` — ${short}` : ''}`, risk, command ? `설치: ${command}` : '', link].filter(Boolean).join('\n') });
  return (
    <details className="share-menu">
      <summary className="stat">공유</summary>
      <div className="share-items">
        {items.map((it) => (
          <div key={it.label} className="share-item">
            <span className="muted small">{it.label}</span>
            <code>{it.text.split('\n')[0]}</code>
            <CopyButton text={it.text} />
          </div>
        ))}
        <p className="muted small">공유 링크는 앱 없이도 열리는 소개 사이트의 페이지입니다. 스킬 정보는 주소의 # 뒤에 담겨 서버로 보내지지 않습니다.</p>
      </div>
    </details>
  );
}
