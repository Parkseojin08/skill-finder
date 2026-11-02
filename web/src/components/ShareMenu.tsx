import { RISK_FLAGS, RISK_LEVEL } from '../labels.ts';
import type { SkillDetail } from '../types.ts';
import { linkText } from '../lib/exportList.ts';
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
  const items: Array<{ label: string; text: string }> = [];
  if (url) items.push({ label: '저장소 주소', text: url });
  if (command) items.push({ label: '설치 명령', text: command });
  if (url) items.push({ label: 'Markdown 한 줄', text: `[${linkText(detail.name)}](${url})${short ? ` — ${short}` : ''}` });
  items.push({ label: '공유용 글', text: [`${detail.name}${short ? ` — ${short}` : ''}`, risk, command ? `설치: ${command}` : '', url].filter(Boolean).join('\n') });
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
        <p className="muted small">앱 주소(127.0.0.1)는 이 PC에서만 열려 공유용으로 넣지 않았습니다.</p>
      </div>
    </details>
  );
}
