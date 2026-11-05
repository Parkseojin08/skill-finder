// What the agent config view says about one command line (feature review F10): whether it fetches a package or an
// image whose version is not fixed, and the same line with secrets covered. Token scans only, each token looked at a
// bounded number of times: time grows with the length of the line (D#4de9).
import { maskSecrets } from '../util/log.ts';

/** How a runner fetches what it runs without a fixed version: `npx`, `uvx`, `pipx run`, `docker`. */
export type Unpinned = 'npx' | 'pnpm dlx' | 'yarn dlx' | 'bunx' | 'uvx' | 'pipx run' | 'docker';

/** Most tokens read after a runner to find what it runs. */
const LOOKAHEAD = 64;

/** Quotes around a token taken off (by index: an end-anchored pattern rescans a long run of quotes). */
function unquote(t: string): string {
  let a = 0;
  let b = t.length;
  while (a < b && (t[a] === '"' || t[a] === "'")) a++;
  while (b > a && (t[b - 1] === '"' || t[b - 1] === "'")) b--;
  return a === 0 && b === t.length ? t : t.slice(a, b);
}

/** A token's program name: no folder, no quotes, no `.cmd`/`.exe` (Windows writes `npx.cmd`). */
function programName(token: string): string {
  const t = unquote(token);
  const slash = Math.max(t.lastIndexOf('/'), t.lastIndexOf('\\'));
  return t
    .slice(slash + 1)
    .replace(/\.(cmd|exe|bat|ps1)$/i, '')
    .toLowerCase();
}

const isFlag = (t: string) => t.startsWith('-');
/** Not from a registry: a local path, a URL, a git or file spec. Its version is whatever is there. */
const isLocal = (spec: string) => /^(\.|\/|~|[A-Za-z]:[\\/]|file:|git\+|git:|https?:|github:)/.test(spec) || spec.includes('\\');

/** An npm spec names a version unless it has none, or names `latest`/`next`/`*`. */
function npmPinned(spec: string): boolean {
  const at = spec.startsWith('@') ? spec.indexOf('@', 1) : spec.indexOf('@');
  if (at <= 0) return false;
  const version = spec.slice(at + 1);
  return version !== '' && version !== 'latest' && version !== 'next' && version !== '*';
}

/** A Python spec names a version with `==` (pipx, uvx) or `@` (uvx `pkg@1.2`); `@latest` is none. */
const pyPinned = (spec: string) => spec.includes('==') || (spec.includes('@') && !spec.endsWith('@latest'));

/**
 * The first package after a runner's own options. `valued`: options that take the next token as their value;
 * `pkgOpts`: options whose value is the package itself (`npx -p pkg`, `uvx --from pkg`, `pipx run --spec pkg`).
 */
function packageAfter(tokens: string[], from: number, valued: ReadonlySet<string>, pkgOpts: ReadonlySet<string>): string | null {
  for (let j = from; j < tokens.length && j < from + LOOKAHEAD; j++) {
    const t = unquote(tokens[j]);
    if (!isFlag(t)) return t;
    const eq = t.indexOf('=');
    const name = eq > 0 ? t.slice(0, eq) : t;
    if (pkgOpts.has(name)) return eq > 0 ? t.slice(eq + 1) : (tokens[j + 1] ? unquote(tokens[j + 1]) : null);
    if (eq < 0 && valued.has(name)) j++;
  }
  return null;
}

const NPX_VALUED = new Set(['--node-options', '--cache', '--registry', '--userconfig', '--prefix', '-c', '--call', '--shell', '--workspace', '-w']);
const NPX_PKG = new Set(['-p', '--package']);
const UVX_VALUED = new Set(['--with', '--python', '-p', '--index', '--index-url', '--extra-index-url', '--directory', '--project', '--cache-dir', '--with-requirements', '--with-editable', '--config-file', '--env-file']);
const UVX_PKG = new Set(['--from']);
const PIPX_VALUED = new Set(['--python', '--pip-args', '--index-url', '--backend']);
const PIPX_PKG = new Set(['--spec']);
const DOCKER_VALUED = new Set([
  '-e', '--env', '--env-file', '-v', '--volume', '-p', '--publish', '--name', '--network', '--net', '-w', '--workdir', '--entrypoint', '-u', '--user',
  '--mount', '--platform', '-l', '--label', '--add-host', '--cpus', '-m', '--memory', '--restart', '--hostname', '-h', '--device', '--cap-add',
  '--cap-drop', '--security-opt', '--ulimit', '--pull', '--runtime', '--gpus', '--tmpfs', '--dns', '--log-driver', '--log-opt', '--ipc', '--pid',
]);
const NONE = new Set<string>();

/** An image names a fixed version with a tag other than `latest`, or a digest. */
function imagePinned(image: string): boolean {
  if (image.includes('@sha256:')) return true;
  const slash = image.lastIndexOf('/');
  const colon = image.lastIndexOf(':');
  if (colon <= slash) return false; // no tag: docker takes latest
  return image.slice(colon + 1) !== 'latest';
}

/**
 * The first runner on the line that fetches something without a fixed version, or null. The tokens are the
 * command and its args; a single string (a hook's shell line) is split on white space.
 */
export function unpinnedRunner(command: string | null, args: readonly string[] = []): Unpinned | null {
  const tokens = [...(command ?? '').split(/\s+/), ...args.flatMap((a) => a.split(/\s+/))].filter(Boolean);
  for (let i = 0; i < tokens.length; i++) {
    const p = programName(tokens[i]);
    const next = tokens[i + 1] ? programName(tokens[i + 1]) : '';
    let found: Unpinned | null = null;
    if (p === 'npx' || p === 'bunx') {
      const spec = packageAfter(tokens, i + 1, NPX_VALUED, NPX_PKG);
      if (spec && !isLocal(spec) && !npmPinned(spec)) found = p;
    } else if ((p === 'pnpm' || p === 'yarn') && next === 'dlx') {
      const spec = packageAfter(tokens, i + 2, NPX_VALUED, NPX_PKG);
      if (spec && !isLocal(spec) && !npmPinned(spec)) found = p === 'pnpm' ? 'pnpm dlx' : 'yarn dlx';
    } else if (p === 'uvx' || (p === 'uv' && next === 'tool' && tokens[i + 2] && programName(tokens[i + 2]) === 'run')) {
      const spec = packageAfter(tokens, i + (p === 'uvx' ? 1 : 3), UVX_VALUED, UVX_PKG);
      if (spec && !isLocal(spec) && !pyPinned(spec)) found = 'uvx';
    } else if (p === 'pipx' && next === 'run') {
      const spec = packageAfter(tokens, i + 2, PIPX_VALUED, PIPX_PKG);
      if (spec && !isLocal(spec) && !pyPinned(spec)) found = 'pipx run';
    } else if ((p === 'docker' || p === 'podman') && (next === 'run' || next === 'create')) {
      const image = packageAfter(tokens, i + 2, DOCKER_VALUED, NONE);
      if (image && !imagePinned(image)) found = 'docker';
    }
    if (found) return found;
  }
  return null;
}

/** Option names whose value is a secret. */
const SECRET_NAME = /(api[-_]?key|token|secret|password|passwd|auth|bearer|credential|private[-_]?key|session)/i;
const MASK = '[가림]';

/** Query values of a URL whose names look secret (`?api_key=…`), by splitting, not by a regular expression. */
function maskQuery(s: string): string {
  const q = s.indexOf('?');
  if (q < 0) return s;
  const parts = s.slice(q + 1).split('&').map((kv) => {
    const eq = kv.indexOf('=');
    return eq > 0 && SECRET_NAME.test(kv.slice(0, eq)) ? `${kv.slice(0, eq)}=${MASK}` : kv;
  });
  return `${s.slice(0, q)}?${parts.join('&')}`;
}

/**
 * Args as shown and copied: maskSecrets (tokens, `KEY=value`, the home folder as ~), then the value after an option
 * named like a secret (`--api-key xyz`, `--token=xyz`, `API_KEY=xyz`) and secret-looking URL query values.
 */
export function maskArgs(args: readonly string[]): string[] {
  return hideValues(args.map(maskSecrets));
}

/** The value after a secret-named option, of a secret-named `KEY=`, and secret query values. */
function hideValues(args: readonly string[]): string[] {
  const out: string[] = [];
  let hideNext = false;
  for (let a of args) {
    if (hideNext) {
      out.push(MASK);
      hideNext = false;
      continue;
    }
    const eq = a.indexOf('=');
    if (eq > 0 && SECRET_NAME.test(a.slice(0, eq)) && !a.slice(0, eq).includes('/')) a = `${a.slice(0, eq)}=${MASK}`;
    else if (isFlag(a) && SECRET_NAME.test(a)) hideNext = true;
    out.push(maskQuery(a));
  }
  return out;
}

/** A whole shell line (a hook command) masked word by word, its spacing kept. */
export function maskLine(line: string): string {
  // maskSecrets once on the whole line (per word it costs its regular expressions a quarter million times)
  const words = maskSecrets(line).split(/(\s+)/);
  const masked = hideValues(words.filter((_, k) => k % 2 === 0));
  return words.map((w, k) => (k % 2 === 0 ? masked[k / 2] : w)).join('');
}

/** A remote server's host (no path, no query: they can carry keys); null when it is not a URL. */
export function urlHost(url: unknown): string | null {
  if (typeof url !== 'string') return null;
  try {
    return new URL(url).host || null;
  } catch {
    return null;
  }
}
