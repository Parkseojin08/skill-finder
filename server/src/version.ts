import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT_DIR } from './config.ts';

/** The app's version from the root package.json (the release zip writes its own with the same version). */
export const APP_VERSION = (() => {
  try {
    return String((JSON.parse(readFileSync(join(ROOT_DIR, 'package.json'), 'utf8')) as { version?: unknown }).version ?? '') || null;
  } catch {
    return null;
  }
})();
