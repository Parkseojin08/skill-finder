import { useEffect, useSyncExternalStore } from 'react';
import { apiGet, apiSend } from './api.ts';
import { LANG, serverText, t } from './i18n.ts';

// English → Korean/Japanese on this PC; descriptions are never sent anywhere. The browser's built-in Translator API
// (Chrome 138+) when it has one; elsewhere (Firefox, Safari, embedded Chromium) Firefox's own Mozilla models run in
// a worker by the Bergamot engine, the files fetched once by the app's server (user request 2026-11-03).

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

export type TranslateState = 'checking' | 'ready' | 'needs-download' | 'downloading' | 'loading' | 'unsupported' | 'error' | 'off';
/**
 * `engine`: the browser's own translator or the Bergamot engine with Mozilla's models. `size`: bytes the Bergamot
 * download takes. `progress`: 0–1 while downloading.
 */
export type TranslateStatus = { state: TranslateState; progress: number | null; error: string | null; engine: 'builtin' | 'bergamot' | null; size: number | null };
type ModelStatus = { state: 'absent' | 'downloading' | 'ready' | 'error'; received: number; total: number; error: string | null };

/** The screen's language when descriptions need translating into it; English screens show them as they are. */
export const TRANSLATE_TO: 'ko' | 'ja' | null = LANG === 'en' ? null : LANG;
const LANGS = { sourceLanguage: 'en', targetLanguage: TRANSLATE_TO ?? 'ko' };
const STORAGE_KEY = TRANSLATE_TO === 'ja' ? 'sf-ja-translations' : 'sf-ko-translations';
const MAX_STORED = 3000;

let status: TranslateStatus = { state: 'checking', progress: null, error: null, engine: null, size: null };
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
  if (!TRANSLATE_TO) return setStatus({ state: 'off' });
  const T = api();
  if (T) {
    // Embedded Chromium exposes the API but availability() never settles: a slow answer falls through to Bergamot.
    const availability = await Promise.race([
      T.availability(LANGS).catch(() => 'unavailable' as const),
      new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 3000)),
    ]);
    if (availability === 'available') {
      setStatus({ engine: 'builtin' });
      try {
        await create();
      } catch (err) {
        setStatus({ state: 'error', error: String((err as Error).message ?? err) });
      }
      return;
    }
    if (availability === 'downloadable' || availability === 'downloading') return setStatus({ state: 'needs-download', engine: 'builtin' });
  }
  await initBergamot();
}

/* ── Bergamot: Firefox's models, fetched once by the server, run in a worker ── */

const modelPath = () => `/translate/models/${TRANSLATE_TO}`;
/** Loading the model into the engine took about 2 s here; a slow PC gets plenty more before it counts as broken. */
const OPEN_TIMEOUT_MS = 90_000;

async function initBergamot() {
  if (typeof WebAssembly === 'undefined' || typeof Worker === 'undefined') return setStatus({ state: 'unsupported' });
  setStatus({ engine: 'bergamot' });
  try {
    const m = await apiGet<ModelStatus>(modelPath());
    setStatus({ size: m.total });
    if (m.state === 'ready') await createBergamot();
    else if (m.state === 'downloading') await waitForModel();
    else setStatus({ state: 'needs-download', error: m.error && serverText(m.error) });
  } catch (err) {
    setStatus({ state: 'error', error: String((err as Error).message ?? err) });
  }
}

/** Follows the server's download, then starts the engine. */
async function waitForModel() {
  for (;;) {
    const m = await apiGet<ModelStatus>(modelPath());
    if (m.state === 'ready') return createBergamot();
    if (m.state !== 'downloading') throw new Error(serverText(m.error) || t('번역 모델 받기가 멈췄습니다'));
    setStatus({ state: 'downloading', progress: m.total ? m.received / m.total : null });
    await new Promise((r) => setTimeout(r, 700));
  }
}

async function createBergamot() {
  setStatus({ state: 'loading', progress: null });
  const { BatchTranslator } = await import('@mkljczk/bergamot-translator');
  const to = TRANSLATE_TO!;
  const engine = new BatchTranslator({
    registryUrl: new URL('/translate-models/index.json', location.origin).href,
    workerUrl: new URL('/bergamot/translator-worker.js', location.origin).href,
    downloadTimeout: 0,
  });
  const run = async (text: string) => (await engine.translate({ from: 'en', to, text, html: false, qualityScores: false })).target.text;
  // The engine only logs a worker that failed to start, and its requests then never settle (review 2026-11-03):
  // its errors and a time limit end the first request, so a broken engine shows as an error, not as "opening" forever.
  // (Set here, not as options: the options are copied to the worker, and a function cannot be.)
  let fail: (err: Error) => void = () => {};
  const failed = new Promise<never>((_, reject) => (fail = reject));
  engine.onerror = engine.backing.onerror = (err) => fail(err instanceof Error ? err : new Error(String(err)));
  const timer = setTimeout(() => fail(new Error(t('번역 모델을 열지 못했습니다'))), OPEN_TIMEOUT_MS);
  try {
    await Promise.race([run('Hello.'), failed]);
  } catch (err) {
    void engine.delete().catch(() => {});
    throw err;
  } finally {
    clearTimeout(timer);
  }
  translator = { translate: run };
  setStatus({ state: 'ready', progress: null, error: null });
  pump();
}

let started = false;
function ensureStarted() {
  if (started) return;
  started = true;
  void init();
}

/**
 * Downloads the language model; must run from a click (browsers require user activation for the built-in one's
 * download, and the Bergamot model is tens of MB the user agrees to).
 */
export async function enableTranslation(): Promise<void> {
  if (status.state === 'ready' || status.state === 'downloading' || status.state === 'loading') return;
  setStatus({ state: 'downloading', progress: 0, error: null });
  try {
    if (status.engine === 'bergamot') {
      await apiSend('POST', modelPath());
      await waitForModel();
    } else if (api()) {
      await create();
    }
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
    if (!TRANSLATE_TO || !t || translations.has(t) || inFlight.has(t)) return;
    pending.set(t, priority);
    pump();
  }, [t, priority]);
  const ko = t ? (translations.get(t) ?? null) : null;
  return { ko, waiting: !ko && !!t && status.state === 'ready' && (pending.has(t) || inFlight.has(t)) };
}
