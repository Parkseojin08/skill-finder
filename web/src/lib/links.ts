// Links in a skill's SKILL.md, and links to the app's own screens (review 2026-11-02).

/** A link inside the skill's own folder ("./reference.md"): its path there, or null for other links. */
export function relativeTarget(href: string | undefined): string | null {
  if (!href || /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('#') || href.startsWith('/') || href.startsWith('//')) return null;
  let parts: string[];
  try {
    // "..\x" climbs out on Windows too; "./a/./b" is "a/b"
    parts = decodeURIComponent(href.split('#')[0].split('?')[0]).replace(/\\/g, '/').split('/').filter((p) => p && p !== '.');
  } catch {
    return null; // a malformed %-escape
  }
  return parts.length && !parts.includes('..') ? parts.join('/') : null;
}

/** A plain click on a link to another screen moves there without reloading the page (App reads the address). */
export function goInApp(e: { button: number; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; preventDefault(): void }, path: string): void {
  if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return; // new tab or window: the browser's
  e.preventDefault();
  window.history.pushState(null, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
}
