import { t } from '../i18n.ts';
/** A small "?" that opens a short explanation in place; works with keyboard and touch (no hover needed). */
export function HelpTip({ label, text }: { label: string; text: string }) {
  return (
    <details className="help-tip">
      <summary aria-label={t('{0} 설명', label)}>?</summary>
      <p className="help-body">{text}</p>
    </details>
  );
}
