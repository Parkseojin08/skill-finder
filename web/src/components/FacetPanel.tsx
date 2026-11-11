import { useState, type ReactNode } from 'react';
import { CATEGORY, METHOD, TRUST } from '../labels.ts';
import type { ResultItem } from '../types.ts';
import { Icon } from './Icon.tsx';
import { t } from '../i18n.ts';
import { itemRepo, ownerOf, ownerPrefsNow, useOwnerPrefs } from '../lib/ownerPrefs.ts';
import { itemRunFeatures, itemUpdatedWithin, RUN_FEATURES, UPDATED_WITHIN, type SearchFacetCounts, type SearchItem } from '../lib/searchExtras.ts';

/**
 * The side filters. `trust`, `category`, `method` are every screen's; the rest are the search page's and README
 * 추천's (feature review 2026-11-04 stage 3: F19 license, how it runs, last update, owner; F20 trusted owners),
 * shown only with `more`. `run` values must all hold; `updated` takes one value; the others are OR within a group.
 */
export type Facets = {
  trust: string[];
  category: string[];
  method: string[];
  license?: string[];
  run?: string[];
  updated?: string[];
  owner?: string[];
  /** ['trusted'] when on. */
  trusted?: string[];
};
type Group = keyof Facets;
const BASE_GROUPS: Group[] = ['trust', 'category', 'method'];
const MORE_GROUPS: Group[] = ['trusted', 'run', 'updated', 'license', 'owner'];
const GROUPS: Group[] = [...BASE_GROUPS, ...MORE_GROUPS];

export const NO_FACETS: Facets = { trust: [], category: [], method: [] };

const VALUES: Record<Group, (it: ResultItem) => string[]> = {
  trust: (it) => [it.trust],
  category: (it) => it.categories ?? [],
  method: (it) => [it.install.method],
  license: (it) => [(it as SearchItem).license ?? 'unknown'],
  run: (it) => itemRunFeatures(it),
  updated: (it) => itemUpdatedWithin(it),
  owner: (it) => {
    const o = ownerOf(itemRepo(it));
    return o ? [o] : [];
  },
  // read when filtering; the screens re-render on a change through useOwnerPrefs
  trusted: (it) => (ownerPrefsNow().trusted(itemRepo(it)) ? ['trusted'] : []),
};
const CATEGORY_ORDER = Object.keys(CATEGORY);
const OWNER_SHOWN = 8;

const picked = (f: Facets, g: Group) => f[g] ?? [];

/** OR within a group (all of `run`), AND across groups. `skip` leaves one group out, for that group's own counts. */
export function matchFacets(it: ResultItem, f: Facets, skip?: Group): boolean {
  return GROUPS.every((g) => {
    const want = picked(f, g);
    if (g === skip || want.length === 0) return true;
    const has = VALUES[g](it);
    return g === 'run' ? want.every((v) => has.includes(v)) : has.some((v) => want.includes(v));
  });
}

export function facetCount(f: Facets): number {
  return GROUPS.reduce((n, g) => n + picked(f, g).length, 0);
}

function options(group: Group, counts: Map<string, number>, selected: string[]): string[] {
  const present = (k: string) => (counts.get(k) ?? 0) > 0 || selected.includes(k);
  if (group === 'trust') return Object.keys(TRUST); // always all four, so "Anthropic 공식" never disappears
  if (group === 'method') return Object.keys(METHOD).filter(present);
  if (group === 'run') return [...RUN_FEATURES];
  if (group === 'updated') return [...UPDATED_WITHIN];
  if (group === 'trusted') return ['trusted'];
  const byCount = (a: string, b: string) => (counts.get(b) ?? 0) - (counts.get(a) ?? 0) || a.localeCompare(b);
  if (group === 'license') {
    // known licenses by count, then "기타" and "모름"
    const last = (k: string) => (k === 'unknown' ? 2 : k === 'other' ? 1 : 0);
    return [...new Set([...counts.keys(), ...selected])].filter(present).sort((a, b) => last(a) - last(b) || byCount(a, b));
  }
  if (group === 'owner') {
    const top = [...counts.keys()].sort(byCount).slice(0, OWNER_SHOWN);
    return [...new Set([...top, ...selected])].filter(present);
  }
  // categories: most common first, 기타 always last
  return [...new Set([...counts.keys(), ...selected])]
    .filter(present)
    .sort((a, b) => Number(a === 'other') - Number(b === 'other') || (counts.get(b) ?? 0) - (counts.get(a) ?? 0) || CATEGORY_ORDER.indexOf(a) - CATEGORY_ORDER.indexOf(b));
}

const RUN_LABEL: Record<string, string> = {
  noHooksMcp: t('훅·MCP 없음'),
  manualOnly: t('직접 부를 때만'),
  noBashPreapproved: t('Bash 사전 승인 없음'),
};
const RUN_HINT: Record<string, string> = {
  noHooksMcp: t('스스로 실행되는 훅이나 MCP 서버가 없음'),
  manualOnly: t('Claude가 알아서 쓰지 않고 /이름으로 부를 때만'),
  noBashPreapproved: t('묻지 않고 Bash를 쓰도록 미리 허락하지 않음'),
};
const UPDATED_LABEL: Record<string, string> = { '30d': t('30일 안'), '90d': t('90일 안'), '1y': t('1년 안') };

/** Sidebar that narrows the current results by provider, category and install method, with live counts. */
export const facetLabel = (g: Group, k: string): string => {
  switch (g) {
    case 'trust':
      return TRUST[k as keyof typeof TRUST]?.label ?? k;
    case 'method':
      return METHOD[k as keyof typeof METHOD] ?? k;
    case 'category':
      return CATEGORY[k] ?? k;
    case 'license':
      return k === 'unknown' ? t('라이선스 모름') : k === 'other' ? t('기타 라이선스') : k;
    case 'run':
      return RUN_LABEL[k] ?? k;
    case 'updated':
      return t('업데이트 {0}', UPDATED_LABEL[k] ?? k);
    case 'owner':
      return k;
    case 'trusted':
      return t('믿는 제작자');
  }
};

/**
 * The side filters in force, as chips in the results toolbar ("Anthropic 공식 ×"): a filter kept from the last
 * search used to empty a new one with the reason only in the side panel (review 2026-11-02).
 */
export function ActiveFacets({ value, onChange }: { value: Facets; onChange: (f: Facets) => void }) {
  const on = GROUPS.flatMap((g) => picked(value, g).map((k) => [g, k] as const));
  if (!on.length) return null;
  return (
    <>
      {on.map(([g, k]) => (
        <button
          key={`${g}:${k}`}
          type="button"
          className="status-chip action"
          aria-label={t('필터 {0} 끄기', facetLabel(g, k))}
          onClick={() => onChange({ ...value, [g]: picked(value, g).filter((x) => x !== k) })}
        >
          {t('필터 {0}', facetLabel(g, k))} ×
        </button>
      ))}
    </>
  );
}

/** A group of a screen's own above the shared ones (the favorites' 종류), counted and reset with them. */
export type ExtraFacet = { node: ReactNode; active: number; reset: () => void };

/** The server's counts over every candidate (F19), per group, in the panel's shape. */
function serverCountsOf(c: SearchFacetCounts, g: Group): Map<string, number> {
  if (g === 'trusted') return new Map([['trusted', c.trusted]]);
  return new Map(Object.entries(c[g] ?? {}));
}

export function FacetPanel({
  items,
  value,
  onChange,
  extra,
  more = false,
  serverCounts,
  footer,
}: {
  items: ResultItem[];
  value: Facets;
  onChange: (f: Facets) => void;
  extra?: ExtraFacet;
  /** The stage-3 groups too (license, how it runs, update, owner, trusted owners). */
  more?: boolean;
  /** Counts over every candidate, from a search run with these very filters ("전체에서 다시 찾기"). */
  serverCounts?: SearchFacetCounts;
  /** Below the groups: the search page's "이 조건으로 전체에서 다시 찾기". */
  footer?: ReactNode;
}) {
  const [open, setOpen] = useState(false); // narrow screens only; always shown on desktop
  useOwnerPrefs(); // the 믿는 제작자 group follows a change made on a card or in the settings
  const active = facetCount(value) + (extra?.active ?? 0);
  const toggle = (g: Group, v: string) => {
    const cur = picked(value, g);
    // one update window at a time
    const next = cur.includes(v) ? cur.filter((x) => x !== v) : g === 'updated' ? [v] : [...cur, v];
    onChange({ ...value, [g]: next });
  };

  const title: Record<Group, string> = {
    trust: t('제공자'),
    category: t('카테고리'),
    method: t('설치 방식'),
    trusted: t('믿는 제작자'),
    run: t('실행 특성'),
    updated: t('업데이트'),
    license: t('라이선스'),
    owner: t('저장소(제작자)'),
  };
  const groups = more ? GROUPS : BASE_GROUPS;

  return (
    <aside className={`facets ${open ? 'open' : ''}`} aria-label={t('결과 분류 필터')}>
      <div className="facets-head">
        <button type="button" className="facets-toggle" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          <Icon name="sliders" size={15} />{' '}{t('필터{0}', active > 0 ? ` ${active}` : '')}
        </button>
        <span className="facets-title">{t('필터')}</span>
        {active > 0 && (
          <button
            type="button"
            className="linkish small"
            onClick={() => {
              onChange(NO_FACETS);
              extra?.reset();
            }}
          >
            {t('초기화')}
          </button>
        )}
      </div>
      <div className="facet-body">
        {extra?.node}
        {serverCounts && <p className="facet-note">{t('개수는 이 조건으로 찾은 전체 후보 {0}개 기준입니다.', serverCounts.total)}</p>}
        {groups.map((g) => {
          let counts: Map<string, number>;
          if (serverCounts) counts = serverCountsOf(serverCounts, g);
          else {
            const local = new Map<string, number>();
            const inc = (v: string) => local.set(v, (local.get(v) ?? 0) + 1);
            for (const it of items) {
              // run conditions narrow together: a value's count is with the others picked
              if (g === 'run') {
                for (const v of VALUES.run(it)) if (matchFacets(it, { ...value, run: [...new Set([...picked(value, 'run'), v])] })) inc(v);
              } else if (matchFacets(it, value, g)) {
                for (const v of new Set(VALUES[g](it))) inc(v);
              }
            }
            counts = local;
          }
          const sel = picked(value, g);
          const keys = options(g, counts, sel);
          if (keys.length === 0) return null;
          if (g === 'trusted' && !ownerPrefsNow().list.some((p) => p.pref === 'trust') && !sel.length) return null;
          return (
            <fieldset key={g} className="facet">
              <legend>{title[g]}</legend>
              {keys.map((k) => (
                <label key={k} className="facet-opt">
                  <input
                    type={g === 'updated' ? 'radio' : 'checkbox'}
                    name={g === 'updated' ? 'facet-updated' : undefined}
                    checked={sel.includes(k)}
                    disabled={!counts.get(k) && !sel.includes(k)}
                    onChange={() => toggle(g, k)}
                    onClick={(e) => {
                      // a picked radio clicked again turns the window off
                      if (g === 'updated' && sel.includes(k)) {
                        e.preventDefault();
                        toggle(g, k);
                      }
                    }}
                  />
                  <span className="facet-label">
                    {g === 'trusted' ? t('믿는 제작자만') : g === 'updated' ? UPDATED_LABEL[k] : facetLabel(g, k)}
                    {g === 'trust' && <span className="facet-hint">{TRUST[k as keyof typeof TRUST].hint}</span>}
                    {g === 'run' && <span className="facet-hint">{RUN_HINT[k]}</span>}
                  </span>
                  <span className="facet-count">{counts.get(k) ?? 0}</span>
                </label>
              ))}
            </fieldset>
          );
        })}
        <p className="facet-note">{t('카테고리는 마켓플레이스 분류와 이름·설명의 키워드로 자동 분류해 틀릴 수 있습니다.')}</p>
        {footer}
      </div>
    </aside>
  );
}
