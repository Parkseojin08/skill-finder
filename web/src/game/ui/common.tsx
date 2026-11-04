import type { ReactNode } from 'react';
import { PCT_STATS, RARITY_LABEL, SLOT_LABEL, STAT_LABEL, type Rarity, type StatKey } from '../data.ts';
import type { Item } from '../core.ts';
import type { Action } from '../actions.ts';

export type Send = (actions: Action[]) => Promise<boolean>;

export const fmt = (n: number) => Math.round(n).toLocaleString('ko-KR');

export function dur(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h) return `${h}시간 ${m}분`;
  if (m) return `${m}분 ${sec}초`;
  return `${sec}초`;
}

export function Bar({ value, max, kind, label, compact }: { value: number; max: number; kind: 'hp' | 'shield' | 'xp' | 'time' | 'ally'; label?: string; compact?: boolean }) {
  const pct = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  return (
    <div className={`ar-bar ar-bar--${kind}${compact ? ' ar-bar--compact' : ''}`} role="meter" aria-valuenow={Math.round(value)} aria-valuemin={0} aria-valuemax={Math.round(max)} aria-label={label}>
      <i style={{ width: `${pct}%` }} />
      <span>{label ? `${label} ` : ''}{fmt(value)} / {fmt(max)}</span>
    </div>
  );
}

export function Rar({ r, children }: { r: Rarity; children: ReactNode }) {
  return <span className={`rar rar-${r}`}>{children}</span>;
}

export function statText(k: StatKey, v: number) {
  return `${STAT_LABEL[k]} +${PCT_STATS.includes(k) ? `${v}%` : k === 'armor' ? v.toFixed(1) : fmt(v)}`;
}

/** One-line summary of an item's numbers. */
export function itemStats(it: Item): string {
  if (it.kind === 'module') return statText(it.stat!, it.main);
  const weapon = it.slot === 'primary' || it.slot === 'special' || it.slot === 'destructive';
  const parts = [weapon ? `피해 ${fmt(it.main)}` : `체력 ${fmt(it.main)}`];
  for (const [k, v] of Object.entries(it.affixes)) parts.push(statText(k as StatKey, v ?? 0));
  return parts.join(' · ');
}

export function ItemName({ it }: { it: Item }) {
  return (
    <span className="ar-item-name">
      <Rar r={it.rarity}>{it.name}</Rar>
      <small>
        Lv.{it.level} {RARITY_LABEL[it.rarity]} {it.kind === 'module' ? '모듈' : SLOT_LABEL[it.slot!]}
      </small>
    </span>
  );
}

export function Panel({ title, sub, children, aside, className }: { title: ReactNode; sub?: ReactNode; children: ReactNode; aside?: ReactNode; className?: string }) {
  return (
    <section className={`ar-panel${className ? ` ${className}` : ''}`}>
      <header>
        <div>
          <h2>{title}</h2>
          {sub && <p>{sub}</p>}
        </div>
        {aside}
      </header>
      <div className="ar-panel-body">{children}</div>
    </section>
  );
}

export function Btn({ children, onClick, disabled, kind = 'normal', title, hotkey }: { children: ReactNode; onClick: () => void; disabled?: boolean; kind?: 'normal' | 'primary' | 'danger' | 'ghost'; title?: string; hotkey?: string }) {
  return (
    <button type="button" className={`ar-btn ar-btn--${kind}`} onClick={onClick} disabled={disabled} title={title}>
      {hotkey && <kbd>{hotkey}</kbd>}
      {children}
    </button>
  );
}

export const STACK_LABEL: Record<string, string> = {
  cells: '에너지 탄약', antimatter: '반물질', med: '의료 부품', ammoparts: '탄약 부품', scrap: '고철',
};
