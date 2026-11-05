// What runs in the background, polled once for the whole page (feature review F22): the menu bar's task indicator,
// the marketplace screen's job rows and the status view read this one store instead of each polling /jobs.
// Every 1.5 s while something runs, 15 s otherwise, a minute while the tab is hidden; nothing without a reader.
import { useSyncExternalStore } from 'react';
import { apiGet } from './api.ts';
import type { Job } from './types.ts';

export type TaskTrigger = 'startup' | 'schedule' | 'manual';
export type TaskRun = {
  id: number;
  kind: string;
  trigger: TaskTrigger;
  startedAt: string;
  finishedAt: string | null;
  status: 'running' | 'ok' | 'failed' | 'skipped';
  counts: Record<string, number> | null;
  error: string | null;
};
export type RunningTask = { kind: string; label: string; trigger: TaskTrigger; startedAt: string; job: Job | null };
export type NetworkState = { offline: boolean; since: string | null; lastError: string | null };
export type Activity = { jobs: Job[]; running: RunningTask[]; network: NetworkState; failures: TaskRun[] };

const ACTIVE_MS = 1500;
const IDLE_MS = 15_000;
const HIDDEN_MS = 60_000;

let snapshot: Activity | null = null;
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setTimeout> | undefined;
let inflight: Promise<void> | null = null;

export const isActiveJob = (j: Job) => j.status === 'running' || j.status === 'paused';
const busy = (a: Activity | null) => !!a && (a.running.length > 0 || a.jobs.some(isActiveJob));

function schedule(): void {
  clearTimeout(timer);
  if (listeners.size === 0) return;
  const hidden = typeof document !== 'undefined' && document.hidden;
  timer = setTimeout(() => void refreshActivity(), hidden ? HIDDEN_MS : busy(snapshot) ? ACTIVE_MS : IDLE_MS);
}

/** Asks now (after starting or stopping something); one request at a time. */
export function refreshActivity(): Promise<void> {
  if (inflight) return inflight;
  inflight = apiGet<Activity>('/activity')
    .then((a) => {
      snapshot = a;
      for (const l of listeners) l();
    })
    .catch(() => {
      // the server is away for a moment: keep what was there and try again
    })
    .finally(() => {
      inflight = null;
      schedule();
    });
  return inflight;
}

const onVisible = () => {
  if (!document.hidden) void refreshActivity();
};

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) {
    document.addEventListener('visibilitychange', onVisible);
    void refreshActivity();
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    }
  };
}

/** null until the first answer. */
export function useActivity(): Activity | null {
  return useSyncExternalStore(subscribe, () => snapshot);
}

/** The job of `kind` and `label` that is running or paused. */
export function activeJob(a: Activity | null, kind: Job['kind'], label: string): Job | undefined {
  return a?.jobs.find((j) => j.kind === kind && j.label === label && isActiveJob(j));
}
