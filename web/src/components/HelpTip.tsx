/** A small "?" that opens a short explanation in place; works with keyboard and touch (no hover needed). */
export function HelpTip({ label, text }: { label: string; text: string }) {
  return (
    <details className="help-tip">
      <summary aria-label={`${label} 설명`}>?</summary>
      <p className="help-body">{text}</p>
    </details>
  );
}
