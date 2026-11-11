// After the last test: the server's log goes next to the test results (traces, screenshots), so a failed run can be
// read in one place, on a CI runner too. The server's temporary folders are left for the next start to remove.
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { FullConfig } from '@playwright/test';
import { SERVER_LOG } from './support/env.ts';

export default function globalTeardown(config: FullConfig): void {
  const outputDir = config.projects[0]?.outputDir;
  if (!outputDir || !existsSync(SERVER_LOG)) return;
  try {
    mkdirSync(outputDir, { recursive: true });
    copyFileSync(SERVER_LOG, join(outputDir, 'server.log'));
  } catch {
    // the log is a help for reading failures, never a reason to fail the run
  }
}
