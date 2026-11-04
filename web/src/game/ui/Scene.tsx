import { useMemo, useState } from 'react';

/** Small deterministic generator so each place always draws the same skyline. */
function seeded(text: string) {
  let h = 2166136261;
  for (const ch of text) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return ((h ^= h >>> 16) >>> 0) / 4294967296;
  };
}

interface Building { x: number; w: number; h: number; windows: { x: number; y: number; on: boolean }[]; antenna: boolean }

function skyline(seed: string, layer: number): Building[] {
  const r = seeded(`${seed}:${layer}`);
  const out: Building[] = [];
  for (let x = -20; x < 1020;) {
    const w = 34 + r() * (layer ? 70 : 50);
    const h = (layer ? 90 : 150) + r() * (layer ? 170 : 130);
    const windows: Building['windows'] = [];
    for (let wy = 300 - h + 14; wy < 290; wy += 14) for (let wx = x + 6; wx < x + w - 8; wx += 10) windows.push({ x: wx, y: wy, on: r() < (layer ? 0.18 : 0.08) });
    out.push({ x, w, h, windows, antenna: r() < 0.3 });
    x += w + (r() < 0.25 ? r() * 18 : 1);
  }
  return out;
}

/**
 * Place header: a slim strip with a dim skyline and small red signs, the place name, and one line from its NPC.
 * Kept quiet on purpose (playable at the office). The skyline is drawn here, no artwork is used.
 */
export function Scene({ title, tag, npc, lines, hue, glyph, children }: { title: string; tag?: string; npc?: string; lines: string[]; hue: number; glyph?: string; children?: React.ReactNode }) {
  const back = useMemo(() => skyline(title, 0), [title]);
  const front = useMemo(() => skyline(title, 1), [title]);
  const signs = useMemo(() => {
    const r = seeded(`${title}:signs`);
    return Array.from({ length: 5 }, () => ({ x: r() * 960, y: 70 + r() * 150, w: 20 + r() * 60, h: 4 + r() * 10, alt: r() < 0.4 }));
  }, [title]);
  const [line] = useState(() => lines[Math.floor(Math.random() * lines.length)] ?? '');
  // every sign is red; `hue` only nudges the shade so places still differ a little
  const red = 350 + ((hue % 21) - 10);
  const neon = `hsl(${red} 70% 52%)`;
  const neon2 = `hsl(${red + 8} 55% 42%)`;
  return (
    <section className="sc">
      <svg className="sc-sky" viewBox="0 0 1000 300" preserveAspectRatio="xMidYMax slice" aria-hidden>
        <rect width="1000" height="300" fill="#1a1b1d" />
        {back.map((b, i) => (
          <g key={`b${i}`}>
            <rect x={b.x} y={300 - b.h} width={b.w} height={b.h} fill="#222427" />
            {b.windows.filter((w) => w.on).map((w, j) => <rect key={j} x={w.x} y={w.y} width="4" height="5" fill="#5a5f63" opacity="0.5" />)}
          </g>
        ))}
        {signs.map((s, i) => <rect key={`s${i}`} x={s.x} y={s.y} width={s.w} height={s.h} fill={s.alt ? neon2 : neon} opacity="0.85" />)}
        {front.map((b, i) => (
          <g key={`f${i}`}>
            <rect x={b.x} y={300 - b.h} width={b.w} height={b.h} fill="#121314" />
            {b.antenna && <rect x={b.x + b.w / 2} y={300 - b.h - 26} width="2" height="26" fill="#121314" />}
            {b.windows.filter((w) => w.on).map((w, j) => <rect key={j} x={w.x} y={w.y} width="4" height="5" fill={j % 4 ? '#6b7074' : neon} opacity="0.55" />)}
          </g>
        ))}
      </svg>
      <div className="sc-dots" aria-hidden />
      {glyph && <span className="sc-emblem" aria-hidden>{glyph}</span>}
      <h2 className="sc-title">{title}</h2>
      {(line || children) && (
        <div className="sc-dialog">
          {tag && <span className="sc-tag">[{tag}]</span>}
          {npc && <b>{npc}:</b>}
          {line && <p>{line}</p>}
          {children}
        </div>
      )}
    </section>
  );
}
