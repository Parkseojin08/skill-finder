import { useState } from 'react';

/** Copies `text` to the clipboard and says so for a moment ("복사됨"), or that it could not. */
export function CopyButton({ text, label = '복사', className = 'ghost', title }: { text: string; label?: string; className?: string; title?: string }) {
  const [state, setState] = useState<'idle' | 'done' | 'failed'>('idle');
  return (
    <button
      type="button"
      className={className}
      title={title}
      onClick={async (e) => {
        e.stopPropagation();
        try {
          await navigator.clipboard.writeText(text);
          setState('done');
        } catch {
          setState('failed');
        }
        setTimeout(() => setState('idle'), 1500);
      }}
    >
      {state === 'done' ? '복사됨' : state === 'failed' ? '복사 안 됨' : label}
    </button>
  );
}
