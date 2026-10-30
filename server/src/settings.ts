import { z } from 'zod';
import type { Store } from './db/store.ts';

export const SettingsSchema = z.object({
  weights: z.object({
    R: z.number().min(0).max(1),
    P: z.number().min(0).max(1),
    F: z.number().min(0).max(1),
    T: z.number().min(0).max(1),
  }),
  telemetryDisabled: z.boolean(),
  /** Collect skills of lazily indexed marketplaces in the background after each sync. */
  autoCollect: z.boolean(),
  defaultScope: z.enum(['user', 'project']),
  defaultProjectPath: z.string().max(1000),
  /** Search results must come from a GitHub repo with at least this many stars (0 = no limit). */
  minStars: z.number().int().min(0).max(1_000_000),
  /** Keep a search log on this PC (U5-2): what was searched and which results were opened, 90 days. */
  searchLog: z.boolean(),
});

export type Settings = z.infer<typeof SettingsSchema>;

export const DEFAULT_SETTINGS: Settings = {
  weights: { R: 0.55, P: 0.2, F: 0.1, T: 0.15 },
  telemetryDisabled: true,
  autoCollect: true,
  defaultScope: 'user',
  defaultProjectPath: '',
  minStars: 5000,
  searchLog: true,
};

/** Search log entries older than this are deleted (at startup and daily). */
export const SEARCH_LOG_KEEP_MS = 90 * 24 * 60 * 60 * 1000;

export const DEFAULT_MARKETPLACES = [
  { name: 'claude-plugins-official', repo: 'anthropics/claude-plugins-official', enabled: true, index_mode: 'eager' },
  { name: 'anthropic-agent-skills', repo: 'anthropics/skills', enabled: true, index_mode: 'eager' },
  { name: 'claude-community', repo: 'anthropics/claude-plugins-community', enabled: true, index_mode: 'lazy' },
  { name: 'knowledge-work-plugins', repo: 'anthropics/knowledge-work-plugins', enabled: false, index_mode: 'lazy' },
] as const;

/** Anthropic-run marketplaces whose external plugins count as partners for the trust score. */
export const PARTNER_MARKETPLACES = new Set(['claude-plugins-official', 'anthropic-agent-skills', 'knowledge-work-plugins']);
export const COMMUNITY_MARKETPLACES = new Set(['claude-community']);

export function getSettings(store: Store): Settings {
  const saved = store.getSetting<Partial<Settings>>('app') ?? {};
  // Weights are no longer a setting (UI debate D-1): they never changed the order, only the card numbers and the
  // cache. Saved ones from older versions are ignored.
  const merged = { ...DEFAULT_SETTINGS, ...saved, weights: DEFAULT_SETTINGS.weights };
  const parsed = SettingsSchema.safeParse(merged);
  return parsed.success ? parsed.data : DEFAULT_SETTINGS;
}

export function saveSettings(store: Store, next: Settings): void {
  store.setSetting('app', next);
}

export function seedMarketplaces(store: Store): void {
  if (store.getSetting<boolean>('marketplacesSeeded')) return;
  for (const m of DEFAULT_MARKETPLACES) store.insertMarketplaceIfMissing({ ...m });
  store.setSetting('marketplacesSeeded', true);
}
