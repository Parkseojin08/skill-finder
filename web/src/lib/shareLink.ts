// A link to the landing site's share page (/s/) that shows one skill to someone without the app. The skill rides
// in the fragment (`#v1.` + base64url JSON), which browsers never send to the server; the page checks each field
// and draws it as text (site/public/s/share.js reads this format).

export const SITE = 'https://seojin-skill-finder.pages.dev';

export type SharedSkill = {
  /** name, description, repo or skills.sh page, install command, risk level, risk flag codes, the app's skill id */
  n: string;
  d?: string;
  u?: string;
  c?: string;
  r?: 'low' | 'medium' | 'high';
  f?: string[];
  i?: string;
};

const clip = (s: string | null | undefined, max: number) => {
  const t = (s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

function base64url(text: string): string {
  let bin = '';
  for (const b of new TextEncoder().encode(text)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function shareLink(s: SharedSkill): string {
  const data: SharedSkill = { n: clip(s.n, 120) };
  if (s.d) data.d = clip(s.d, 300);
  if (s.u && /^https:\/\/(github\.com|skills\.sh)\//.test(s.u)) data.u = s.u;
  if (s.c) data.c = clip(s.c, 600);
  if (s.r) data.r = s.r;
  if (s.f?.length) data.f = s.f.slice(0, 12);
  if (s.i) data.i = s.i;
  return `${SITE}/s/#v1.${base64url(JSON.stringify(data))}`;
}

/** The reverse, as the share page reads it (for tests). */
export function readShareLink(url: string): SharedSkill | null {
  const m = /#v1\.([A-Za-z0-9_-]+)$/.exec(url);
  if (!m) return null;
  const b64 = m[1].replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)))) as SharedSkill;
}
