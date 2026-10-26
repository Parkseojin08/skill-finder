import { useEffect, useSyncExternalStore } from 'react';

// English → Korean with the browser's built-in, on-device Translator API (Chrome 138+). Nothing is sent to a server.
// Where the API is missing or never answers (other browsers, embedded Chromium), descriptions stay in English.

type TranslatorLike = { translate(text: string): Promise<string> };
type CreateOptions = {
  sourceLanguage: string;
  targetLanguage: string;
  monitor?: (m: EventTarget) => void;
};
type TranslatorStatic = {
  availability(o: { sourceLanguage: string; targetLanguage: string }): Promise<'unavailable' | 'downloadable' | 'downloading' | 'available'>;
  create(o: CreateOptions): Promise<TranslatorLike>;
};

export type TranslateState = 'checking' | 'ready' | 'needs-download' | 'downloading' | 'unsupported' | 'error';
export type TranslateStatus = { state: TranslateState; progress: number | null; error: string | null };

const LANGS = { sourceLanguage: 'en', targetLanguage: 'ko' };
const STORAGE_KEY = 'sf-ko-translations';
const MAX_STORED = 3000;

let status: TranslateStatus = { state: 'checking', progress: null, error: null };
let translator: TranslatorLike | null = null;
let version = 0;
const listeners = new Set<() => void>();
const translations = new Map<string, string>(loadStored());
/** Waiting texts → priority (lower runs first; result cards pass their position so the visible top goes first). */
const pending = new Map<string, number>();
const inFlight = new Set<string>();
const CONCURRENCY = 3;
let workers = 0;

function loadStored(): Array<[string, string]> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Array<[string, string]>) : [];
  } catch {
    return [];
  }
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
function saveSoon() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify([...translations].slice(-MAX_STORED)));
    } catch {
      // storage full or blocked: keep the in-memory cache only
    }
  }, 1000);
}

function notify() {
  version++;
  for (const l of listeners) l();
}

function setStatus(patch: Partial<TranslateStatus>) {
  status = { ...status, ...patch };
  notify();
}

function api(): TranslatorStatic | null {
  return (globalThis as unknown as { Translator?: TranslatorStatic }).Translator ?? null;
}

function nextPending(): string | null {
  let best: string | null = null;
  let bestPriority = Infinity;
  for (const [text, priority] of pending) {
    if (priority < bestPriority) {
      best = text;
      bestPriority = priority;
    }
  }
  return best;
}

async function worker() {
  workers++;
  try {
    for (let text = nextPending(); text != null && translator; text = nextPending()) {
      pending.delete(text);
      if (translations.has(text)) continue;
      inFlight.add(text);
      try {
        translations.set(text, await translator.translate(text));
        saveSoon();
      } catch {
        // leave this one in English
      } finally {
        inFlight.delete(text);
        notify();
      }
    }
  } finally {
    workers--;
  }
}

function pump() {
  if (!translator) return;
  while (workers < CONCURRENCY && pending.size > 0) void worker();
}

async function create(): Promise<void> {
  const T = api()!;
  translator = await T.create({
    ...LANGS,
    monitor(m) {
      m.addEventListener('downloadprogress', (e) => setStatus({ progress: (e as ProgressEvent).loaded }));
    },
  });
  setStatus({ state: 'ready', progress: null, error: null });
  pump();
}

async function init() {
  const T = api();
  if (!T) return setStatus({ state: 'unsupported' });
  // Embedded Chromium exposes the API but availability() never settles; treat a slow answer as unsupported.
  const availability = await Promise.race([
    T.availability(LANGS).catch(() => 'unavailable' as const),
    new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 3000)),
  ]);
  if (availability === 'available') {
    try {
      await create();
    } catch (err) {
      setStatus({ state: 'error', error: String((err as Error).message ?? err) });
    }
  } else if (availability === 'downloadable' || availability === 'downloading') {
    setStatus({ state: 'needs-download' });
  } else {
    setStatus({ state: 'unsupported' });
  }
}

let started = false;
function ensureStarted() {
  if (started) return;
  started = true;
  void init();
}

/** Downloads the language model; must run from a click (browsers require user activation for the download). */
export async function enableTranslation(): Promise<void> {
  if (!api() || status.state === 'ready') return;
  setStatus({ state: 'downloading', progress: 0, error: null });
  try {
    await create();
  } catch (err) {
    setStatus({ state: 'error', error: String((err as Error).message ?? err) });
  }
}

function subscribe(l: () => void) {
  listeners.add(l);
  ensureStarted();
  return () => listeners.delete(l);
}

export function useTranslateStatus(): TranslateStatus {
  useSyncExternalStore(subscribe, () => version);
  return status;
}

/**
 * Korean translation of `text` once available (`ko` is null while waiting or when translation is unavailable).
 * `priority` is the on-screen position: lower is translated first, and re-sorting moves the new top ahead.
 */
export function useKorean(text: string | null | undefined, priority = 0): { ko: string | null; waiting: boolean } {
  useSyncExternalStore(subscribe, () => version);
  const t = text?.trim() ?? '';
  useEffect(() => {
    if (!t || translations.has(t) || inFlight.has(t)) return;
    pending.set(t, priority);
    pump();
  }, [t, priority]);
  const ko = t ? (translations.get(t) ?? null) : null;
  return { ko, waiting: !ko && !!t && status.state === 'ready' && (pending.has(t) || inFlight.has(t)) };
}
