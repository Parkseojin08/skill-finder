import { useState } from 'react';
import { CATEGORY, METHOD, TRUST } from '../labels.ts';
import type { ResultItem } from '../types.ts';
import { Icon } from './Icon.tsx';
import { t } from '../i18n.ts';

export type Facets = { trust: string[]; category: string[]; method: string[] };
type Group = keyof Facets;

export const NO_FACETS: Facets = { trust: [], category: [], method: [] };

const VALUES: Record<Group, (it: ResultItem) => string[]> = {
  trust: (it) => [it.trust],
  category: (it) => it.categories ?? [],
  method: (it) => [it.install.method],
};
const GROUPS = Object.keys(VALUES) as Group[];
const CATEGORY_ORDER = Object.keys(CATEGORY);

/** OR within a group, AND across groups. `skip` leaves one group out, for that group's own counts. */
export function matchFacets(it: ResultItem, f: Facets, skip?: Group): boolean {
  return GROUPS.every((g) => g === skip || f[g].length === 0 || VALUES[g](it).some((v) => f[g].includes(v)));
}

export function facetCount(f: Facets): number {
  return GROUPS.reduce((n, g) => n + f[g].length, 0);
}

function options(group: Group, counts: Map<string, number>, selected: string[]): string[] {
  const present = (k: string) => (counts.get(k) ?? 0) > 0 || selected.includes(k);
  if (group === 'trust') return Object.keys(TRUST); // always all four, so "Anthropic 공식" never disappears
  if (group === 'method') return Object.keys(METHOD).filter(present);
  // categories: most common first, 기타 always last
  return [...new Set([...counts.keys(), ...selected])]
    .filter(present)
    .sort((a, b) => Number(a === 'other') - Number(b === 'other') || (counts.get(b) ?? 0) - (counts.get(a) ?? 0) || CATEGORY_ORDER.indexOf(a) - CATEGORY_ORDER.indexOf(b));
}

/** Sidebar that narrows the current results by provider, category and install method, with live counts. */
export const facetLabel = (g: Group, k: string) =>
  (g === 'trust' ? TRUST[k as keyof typeof TRUST]?.label : g === 'method' ? METHOD[k as keyof typeof METHOD] : CATEGORY[k]) ?? k;

/**
 * The side filters in force, as chips in the results toolbar ("Anthropic 공식 ×"): a filter kept from the last
 * search used to empty a new one with the reason only in the side panel (review 2026-11-02).
 */
export function ActiveFacets({ value, onChange }: { value: Facets; onChange: (f: Facets) => void }) {
  const on = GROUPS.flatMap((g) => value[g].map((k) => [g, k] as const));
  if (!on.length) return null;
  return (
    <>
      {on.map(([g, k]) => (
        <button
          key={`${g}:${k}`}
          type="button"
          className="status-chip action"
          aria-label={t('필터 {0} 끄기', facetLabel(g, k))}
          onClick={() => onChange({ ...value, [g]: value[g].filter((x) => x !== k) })}
        >
          {t('필터 {0}', facetLabel(g, k))} ×
        </button>
      ))}
    </>
  );
}

export function FacetPanel({ items, value, onChange }: { items: ResultItem[]; value: Facets; onChange: (f: Facets) => void }) {
  const [open, setOpen] = useState(false); // narrow screens only; always shown on desktop
  const active = facetCount(value);
  const toggle = (g: Group, v: string) => onChange({ ...value, [g]: value[g].includes(v) ? value[g].filter((x) => x !== v) : [...value[g], v] });

  const title: Record<Group, string> = { trust: t('제공자'), category: t('카테고리'), method: t('설치 방식') };
  const label = facetLabel;

  return (
    <aside className={`facets ${open ? 'open' : ''}`} aria-label={t('결과 분류 필터')}>
      <div className="facets-head">
        <button type="button" className="facets-toggle" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          <Icon name="sliders" size={15} />{' '}{t('필터{0}', active > 0 ? ` ${active}` : '')}
        </button>
        <span className="facets-title">{t('필터')}</span>
        {active > 0 && (
          <button type="button" className="linkish small" onClick={() => onChange(NO_FACETS)}>
            {t('초기화')}
          </button>
        )}
      </div>
      <div className="facet-body">
        {GROUPS.map((g) => {
          const counts = new Map<string, number>();
          for (const it of items) {
            if (!matchFacets(it, value, g)) continue;
            for (const v of new Set(VALUES[g](it))) counts.set(v, (counts.get(v) ?? 0) + 1);
          }
          const keys = options(g, counts, value[g]);
          if (keys.length === 0) return null;
          return (
            <fieldset key={g} className="facet">
              <legend>{title[g]}</legend>
              {keys.map((k) => (
                <label key={k} className="facet-opt">
                  <input type="checkbox" checked={value[g].includes(k)} disabled={!counts.get(k) && !value[g].includes(k)} onChange={() => toggle(g, k)} />
                  <span className="facet-label">
                    {label(g, k)}
                    {g === 'trust' && <span className="facet-hint">{TRUST[k as keyof typeof TRUST].hint}</span>}
                  </span>
                  <span className="facet-count">{counts.get(k) ?? 0}</span>
                </label>
              ))}
            </fieldset>
          );
        })}
        <p className="facet-note">{t('카테고리는 마켓플레이스 분류와 이름·설명의 키워드로 자동 분류해 틀릴 수 있습니다.')}</p>
      </div>
    </aside>
  );
}
