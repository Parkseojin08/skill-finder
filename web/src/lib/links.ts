// Links in a skill's SKILL.md (review 2026-11-02).

/** A link inside the skill's own folder ("./reference.md"): its path there, or null for other links. */
export function relativeTarget(href: string | undefined): string | null {
  if (!href || /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('#') || href.startsWith('/') || href.startsWith('//')) return null;
  let path: string;
  try {
    path = decodeURIComponent(href.split('#')[0].split('?')[0]).replace(/^\.\//, '');
  } catch {
    return null; // a malformed %-escape
  }
  return path && !path.split('/').includes('..') ? path : null;
}
