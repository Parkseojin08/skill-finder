// Small per-browser preferences shared by screens (review 2026-11-02: README 추천 did not remember its page size).

/** Results per page (10 unless chosen), remembered in this browser; the search page and README 추천 share it. */
const PAGE_SIZE_KEY = 'skill-finder-page-size';

export function readPageSize(): number {
  try {
    const n = Number(localStorage.getItem(PAGE_SIZE_KEY));
    return [5, 10, 20].includes(n) ? n : 10;
  } catch {
    return 10;
  }
}

export function savePageSize(n: number): void {
  try {
    localStorage.setItem(PAGE_SIZE_KEY, String(n));
  } catch {
    // not remembered; nothing else changes
  }
}
