import { statSync } from 'node:fs';
import { isAbsolute } from 'node:path';

export const OWNER_REPO_RE = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;
export const PLUGIN_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
export const SKILL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/;

export const isRepo = (s: unknown): s is string => typeof s === 'string' && OWNER_REPO_RE.test(s) && !s.includes('..');
export const isPluginName = (s: unknown): s is string => typeof s === 'string' && PLUGIN_NAME_RE.test(s);
export const isSkillName = (s: unknown): s is string => typeof s === 'string' && SKILL_NAME_RE.test(s) && !/\s$/.test(s);

/** Absolute path to an existing directory. */
export function isProjectDir(p: unknown): p is string {
  if (typeof p !== 'string' || !p || !isAbsolute(p) || /[\0\r\n]/.test(p)) return false;
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}
