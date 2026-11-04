import { BOSS_KEY_CODE } from '../data.ts';

const KEYWORDS = /\b(import|from|export|class|constructor|private|readonly|async|await|const|for|of|if|continue|return|new)\b/g;

function highlight(line: string) {
  const parts: React.ReactNode[] = [];
  const comment = line.indexOf('/**') >= 0 ? line.indexOf('/**') : line.indexOf('//');
  const code = comment >= 0 ? line.slice(0, comment) : line;
  let last = 0;
  for (const m of code.matchAll(new RegExp(`${KEYWORDS.source}|'[^']*'|@\\w+`, 'g'))) {
    if (m.index > last) parts.push(code.slice(last, m.index));
    const t = m[0];
    parts.push(<span key={m.index} className={t.startsWith("'") ? 'bk-str' : t.startsWith('@') ? 'bk-dec' : 'bk-kw'}>{t}</span>);
    last = m.index + t.length;
  }
  parts.push(code.slice(last));
  if (comment >= 0) parts.push(<span key="c" className="bk-com">{line.slice(comment)}</span>);
  return parts;
}

/** Instant disguise: a plausible editor full of boring work code. ` (backtick) toggles it. */
export function BossKey({ onBack }: { onBack: () => void }) {
  const lines = BOSS_KEY_CODE.split('\n');
  return (
    <div className="bk" onDoubleClick={onBack}>
      <div className="bk-title"><span>invoice-reconciler.service.ts — billing-core — Visual Studio Code</span></div>
      <div className="bk-body">
        <div className="bk-activity" aria-hidden><i /><i /><i /><i /></div>
        <div className="bk-tree">
          <p>EXPLORER</p>
          <ul>
            <li>▾ billing-core</li>
            <li className="bk-l1">▾ src</li>
            <li className="bk-l2">▾ invoices</li>
            <li className="bk-l3">invoice.entity.ts</li>
            <li className="bk-l3 is-on">invoice-reconciler.service.ts</li>
            <li className="bk-l3">invoices.module.ts</li>
            <li className="bk-l2">▸ payments</li>
            <li className="bk-l1">package.json</li>
          </ul>
        </div>
        <div className="bk-editor">
          <div className="bk-tabs"><span className="is-on">invoice-reconciler.service.ts</span><span>invoice.entity.ts</span></div>
          <pre>
            {lines.map((l, i) => (
              <div key={i}><span className="bk-ln">{i + 1}</span>{highlight(l)}</div>
            ))}
          </pre>
        </div>
      </div>
      <div className="bk-status"><span>⎇ main</span><span>TypeScript</span><span>UTF-8</span><span>Ln 18, Col 42</span></div>
    </div>
  );
}
