// Team presets (user decision 2026-11-02): the 설치됨 list as a file a teammate imports to install the same skills.
// The file only names skills (this PC's index ids and plugin ids); the importing app looks each one up in its own
// index and installs through the usual confirm dialog.
import type { InstalledResponse } from '../types.ts';
import { t } from '../i18n.ts';

export const PRESET_FORMAT = 'skill-finder-preset';
const MAX_ITEMS = 200;
const MAX_BYTES = 1_000_000;

export type PresetItem = { id?: string; plugin?: string; name?: string };
export type Preset = { format: typeof PRESET_FORMAT; version: 1; name: string; createdAt: string; items: PresetItem[] };

/** The installed skills the index knows (others cannot be found on another PC), and the indexed plugins. */
export function presetFrom(data: InstalledResponse, name: string): Preset {
  const items: PresetItem[] = [];
  const seen = new Set<string>();
  for (const p of data.plugins) {
    if (!p.indexed || seen.has(`p:${p.id}`)) continue;
    seen.add(`p:${p.id}`);
    items.push({ plugin: p.id, name: p.id.split('@')[0] });
  }
  for (const s of data.skills) {
    if (!s.skillId || seen.has(s.skillId)) continue;
    seen.add(s.skillId);
    items.push({ id: s.skillId, name: s.name });
  }
  // as many as an import takes (the rest would be left out there without a word)
  return { format: PRESET_FORMAT, version: 1, name: name.trim() || t('내 스킬'), createdAt: new Date().toISOString(), items: items.slice(0, MAX_ITEMS) };
}

/** The items count, without what the index does not know. */
export const presetSize = (data: InstalledResponse) => presetFrom(data, '').items.length;
export const PRESET_MAX = MAX_ITEMS;

const short = (v: unknown, max: number) => (typeof v === 'string' && v.trim() && v.length <= max ? v.trim() : undefined);

/** Reads a preset file; throws with a message to show when it is not one. `skipped`: past the 200 an import takes. */
export function parsePreset(text: string): { name: string; items: PresetItem[]; skipped: number } {
  if (text.length > MAX_BYTES) throw new Error(t('프리셋 파일이 1MB를 넘습니다.'));
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(t('JSON 파일이 아닙니다.'));
  }
  const d = data as Partial<Preset>;
  if (!d || d.format !== PRESET_FORMAT || d.version !== 1 || !Array.isArray(d.items)) throw new Error(t('Skill Finder 팀 프리셋 파일이 아닙니다.'));
  const all = d.items
    .map((i) => ({ id: short(i?.id, 400), plugin: short(i?.plugin, 200), name: short(i?.name, 200)?.slice(0, 80) }))
    .filter((i) => i.id || i.plugin);
  if (!all.length) throw new Error(t('프리셋에 스킬이 없습니다.'));
  return { name: short(d.name, 100) ?? t('팀 프리셋'), items: all.slice(0, MAX_ITEMS), skipped: Math.max(0, all.length - MAX_ITEMS) };
}
