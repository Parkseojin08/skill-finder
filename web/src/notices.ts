import { useEffect, useState } from 'react';
import { apiGet, apiSend } from './api.ts';

// Changes to installed and favorite skills (feature review F7), shared by every screen: the menu's "설치됨 N" badge,
// the favorite cards' chips and the 설치됨 screen's 변경·기록 tab read the same list.

export type NoticeKind = 'risk_up' | 'new_commit' | 'archived' | 'gone' | 'moved';
export type Notice = {
  id: number;
  /** A skill id, or `repo:<owner/name>` / `plugin:<id>` for a repository or an installed plugin. */
  skillId: string;
  kind: NoticeKind;
  from: string | null;
  to: string | null;
  detail: {
    name?: string | null;
    repo?: string | null;
    riskFrom?: string | null;
    riskTo?: string | null;
    commitAt?: string | null;
    flagsAdded?: string[];
    highRisk?: number;
    highSkills?: string[];
    plugin?: string;
    [k: string]: unknown;
  };
  createdAt: string;
  seenAt: string | null;
  /** The skills it is about (a repository or plugin notice names several). */
  skillIds: string[];
  watch: Array<'installed' | 'favorite'>;
};
export type NoticeCounts = { unseen: number; installed: number; favorite: number };
type State = { notices: Notice[]; counts: NoticeCounts; loaded: boolean };

/** How often the list is asked again while the app is open (the watch itself runs every few hours). */
const POLL_MS = 10 * 60 * 1000;

let state: State = { notices: [], counts: { unseen: 0, installed: 0, favorite: 0 }, loaded: false };
let started = false;
const listeners = new Set<(s: State) => void>();
const set = (next: State) => {
  state = next;
  for (const l of listeners) l(state);
};

export async function refreshNotices(): Promise<void> {
  try {
    const r = await apiGet<{ notices: Notice[]; counts: NoticeCounts }>('/notices');
    set({ notices: r.notices, counts: r.counts, loaded: true });
  } catch {
    // the server is starting or older than this page: asked again on the next poll
  }
}

/** Marks these notices seen (every unseen one without ids). */
export async function markNoticesSeen(ids?: number[]): Promise<void> {
  const r = await apiSend<{ counts: NoticeCounts }>('POST', '/notices/seen', ids ? { ids } : {});
  const at = new Date().toISOString();
  set({ ...state, counts: r.counts, notices: state.notices.map((n) => (!n.seenAt && (!ids || ids.includes(n.id)) ? { ...n, seenAt: at } : n)) });
}

/** The notices about one skill (or a `repo:` favorite), newest first. */
export function noticesFor(notices: Notice[], id: string): Notice[] {
  return notices.filter((n) => n.skillId === id || n.skillIds.includes(id));
}

/**
 * The shared notice list and its unseen counts. The menu's badge uses `counts.installed` ("설치됨 N"), the favorite
 * cards `noticesFor(notices, id)`.
 */
export function useNotices(): State & { refresh: () => Promise<void>; markSeen: (ids?: number[]) => Promise<void> } {
  const [s, setS] = useState(state);
  useEffect(() => {
    listeners.add(setS);
    setS(state);
    if (!started) {
      started = true;
      void refreshNotices();
      setInterval(() => void refreshNotices(), POLL_MS);
    }
    return () => {
      listeners.delete(setS);
    };
  }, []);
  return { ...s, refresh: refreshNotices, markSeen: markNoticesSeen };
}
