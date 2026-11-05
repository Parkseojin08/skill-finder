import { useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { HIDDEN_KIND } from '../labels.ts';
import type { SkillDetail } from '../types.ts';
import { t } from '../i18n.ts';
import { Markdown } from './Markdown.tsx';

/** What the server found hidden in skillMd, as offsets into it (server analyze/hiddenContent.ts). */
export type HiddenSpan = { kind: string; start: number; end: number };
export type HiddenContent = { spans: HiddenSpan[]; more: boolean };
type Detail = SkillDetail & { hiddenContent?: HiddenContent };

// Tag characters, direction marks and controls, zero-width characters, BOM, Mongolian vowel separator, soft hyphen:
// shown as ⟦U+…⟧ in the raw view. One character class, so the scan is linear.
const INVISIBLE = /[\u{E0000}-\u{E007F}​-‏‪-‮⁠-⁩﻿᠎­؜]/gu;
/** Styled tokens drawn at most; past that they stay text ("⟦U+200B⟧"), so a crafted file cannot flood the page. */
const MAX_TOKENS = 2000;

const codePoint = (ch: string) => `⟦U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}⟧`;

/** `text` with each invisible character as a visible ⟦U+…⟧ token. */
function showInvisible(text: string, budget: { left: number }, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let plain = '';
  for (const m of text.matchAll(INVISIBLE)) {
    plain += text.slice(last, m.index);
    last = m.index + m[0].length;
    if (budget.left > 0) {
      budget.left--;
      if (plain) out.push(plain);
      plain = '';
      out.push(
        <span key={`${key}-${m.index}`} className="bg-destructive/20 px-0.5 text-destructive">
          {codePoint(m[0])}
        </span>,
      );
    } else plain += codePoint(m[0]);
  }
  plain += text.slice(last);
  if (plain) out.push(plain);
  return out;
}

/** The raw text with the hidden spans marked (overlaps clipped) and invisible characters made visible. */
function RawText({ text, spans }: { text: string; spans: HiddenSpan[] }) {
  const budget = { left: MAX_TOKENS };
  const parts: ReactNode[] = [];
  let pos = 0;
  for (const s of spans) {
    const start = Math.max(s.start, pos);
    const end = Math.min(s.end, text.length);
    if (end <= start) continue;
    if (start > pos) parts.push(...showInvisible(text.slice(pos, start), budget, `p${pos}`));
    parts.push(
      <mark key={`m${start}`} className="bg-destructive/15 text-foreground outline outline-1 outline-destructive/40" title={HIDDEN_KIND[s.kind] ?? s.kind}>
        {showInvisible(text.slice(start, end), budget, `m${start}`)}
      </mark>,
    );
    pos = end;
  }
  if (pos < text.length) parts.push(...showInvisible(text.slice(pos), budget, `p${pos}`));
  return (
    <div className="file-view">
      <pre>{parts}</pre>
    </div>
  );
}

/** "HTML 주석 2 · 태그 문자 1": how many places of each kind. */
function kindSummary(spans: HiddenSpan[]): string {
  const counts = new Map<string, number>();
  for (const s of spans) counts.set(s.kind, (counts.get(s.kind) ?? 0) + 1);
  return [...counts].map(([k, n]) => `${HIDDEN_KIND[k] ?? k} ${n}`).join(' · ');
}

/**
 * The SKILL.md tab's text (feature review F2): rendered, or as Claude reads it, the raw file with what the rendered
 * page hides (comments, hidden HTML, invisible characters, …) marked. A band above says how many such places there are.
 */
export function SkillMdView({
  detail,
  md,
  onRelativeLink,
}: {
  detail: Detail;
  /** skillMd split by the page (splitFrontmatter). */
  md: { frontmatter: string | null; body: string } | null;
  onRelativeLink: (path: string) => void;
}) {
  const [raw, setRaw] = useState(false);
  if (!detail.skillMd || !md) return null;
  const hidden = detail.hiddenContent ?? { spans: [], more: false };
  const count = hidden.spans.length;
  return (
    <>
      {count > 0 && (
        <div className="warn-box" role="note">
          <b>{hidden.more ? t('화면에 보이지 않는 내용 {0}곳 이상', count) : t('화면에 보이지 않는 내용 {0}곳', count)}</b>
          {` (${kindSummary(hidden.spans)}). `}
          {t('렌더링 화면에는 보이지 않지만 Claude는 원문을 그대로 읽습니다.')}{' '}
          {!raw && (
            <button type="button" className="linkish" onClick={() => setRaw(true)}>
              {t('원문에서 보기')}
            </button>
          )}
        </div>
      )}
      <div className="flex gap-1" role="group" aria-label={t('SKILL.md 보기 방식')}>
        <Button type="button" size="sm" variant={raw ? 'ghost' : 'secondary'} aria-pressed={!raw} onClick={() => setRaw(false)}>
          {t('렌더링')}
        </Button>
        <Button type="button" size="sm" variant={raw ? 'secondary' : 'ghost'} aria-pressed={raw} onClick={() => setRaw(true)}>
          {t('Claude가 읽는 원문')}
        </Button>
      </div>
      {raw ? (
        <>
          <p className="muted small">{t('파일 그대로입니다. 강조한 곳은 렌더링 화면에서 보이지 않는 부분이고, 보이지 않는 글자는 ⟦U+…⟧로 표시합니다.')}</p>
          <RawText text={detail.skillMd} spans={hidden.spans} />
        </>
      ) : (
        <>
          {md.frontmatter && (
            <details className="frontmatter">
              <summary>frontmatter</summary>
              <pre>{md.frontmatter}</pre>
            </details>
          )}
          <Markdown text={md.body} onRelativeLink={onRelativeLink} />
        </>
      )}
    </>
  );
}
