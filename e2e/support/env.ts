// Where the E2E server lives; read by playwright.config.ts, the launcher (e2e/server/launch.ts) and the global setup.
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Not 4317 (the app's own port, a developer may have it running) and not 4393. `E2E_PORT` picks another. */
export const PORT = Number(process.env.E2E_PORT) || 4399;
/** The address the server allows as Host and Origin (127.0.0.1, not localhost: one origin for every request). */
export const BASE_URL = `http://127.0.0.1:${PORT}`;

/**
 * Nothing listens here (port 9 is the discard service, off on any normal PC and CI runner), and the server's proxy
 * settings point at it: every request it makes to the outside is refused at once, on this PC, before any DNS lookup.
 * `E2E_BLACKHOLE_PORT` picks another closed port.
 */
export const BLACKHOLE_PORT = Number(process.env.E2E_BLACKHOLE_PORT) || 9;
export const BLACKHOLE = `http://127.0.0.1:${BLACKHOLE_PORT}`;

/** The server's data folder, home folder, empty .env and seed file; emptied at each start. */
export const RUNTIME_DIR = join(tmpdir(), 'skill-finder-e2e', String(PORT));
/** The server's own log (console output with secrets masked), copied next to the test results when the run ends. */
export const SERVER_LOG = join(RUNTIME_DIR, 'data', 'logs', 'server.log');

/** What `/api` asks of every request, and of state-changing ones: the page's own origin. */
export const API_HEADERS = { 'X-Skill-Finder': '1', Origin: BASE_URL, 'Content-Type': 'application/json' };
