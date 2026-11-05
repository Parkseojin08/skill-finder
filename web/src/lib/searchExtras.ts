// Fields the search and README recommendation answers carry beyond types.ts (feature review 2026-11-04: B1, B4,
// F18). Kept here so types.ts stays as it is; pages use them as intersections with its types.
import { t } from '../i18n.ts';
import type { ResultItem, SearchEvent } from '../types.ts';

export type SuspectReason = 'ratio' | 'copies' | 'impostor';

/** F18: the download count looks inflated. It is left out of `installs` (sorted as unknown) and given here. */
export type InstallsSuspect = { installs: number; reasons: SuspectReason[] };
export type SuspectFields = { installsSuspect?: InstallsSuspect };
export type SearchItem = ResultItem & SuspectFields;

export type SearchResultsExtra = {
  /** Aliases that found shown results ("ppt → pptx도 함께 찾음"). */
  aliases?: Array<{ from: string; to: string[] }>;
  /** Few results and two swapped letters: the fixed query, offered as a button (never applied by itself). */
  spelling?: { query: string; words: Array<{ from: string; to: string }> };
  /** A search cached before the index last changed, shown while it runs again. */
  stale?: boolean;
};
export type SearchResults = Extract<SearchEvent, { type: 'results' }> & SearchResultsExtra;

/** Why a download count is not trusted, for the badge's tooltip. */
export function suspectReasonText(r: SuspectReason): string {
  switch (r) {
    case 'ratio':
      return t('별 수에 비해 다운로드가 지나치게 많습니다');
    case 'copies':
      return t('별 적은 저장소 여러 곳에 같은 스킬이 올라와 각각 다운로드가 많습니다');
    case 'impostor':
      return t('별 많은 유명 저장소와 이름이 같고 만든 곳이 다릅니다');
  }
}
