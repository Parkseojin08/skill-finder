// Accounts on this PC (user decision 2026-11-02: favorites need a sign-up and a login). Passwords are scrypt
// hashes; the signed-in state is a cookie holding the user id, when it was issued and an HMAC over both and the
// password hash, so changing the password ends every older sign-in and no session table is needed. The cookie is
// HttpOnly and SameSite=Strict, and the API's own checks (header, same origin) still apply to every request.
import { createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import type { Store, UserRow } from './db/store.ts';

export const SESSION_COOKIE = 'sf_session';
const SESSION_DAYS = 30;
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };

export const USERNAME_RE = /^[A-Za-z0-9_.-]{3,32}$/;
export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 200;

const scryptAsync = (password: string, salt: Buffer, keylen: number, opts: { N: number; r: number; p: number }) =>
  new Promise<Buffer>((resolve, reject) => scrypt(password, salt, keylen, { ...opts, maxmem: 64 * 1024 * 1024 }, (err, key) => (err ? reject(err) : resolve(key))));

/** `scrypt$N$r$p$salt$hash` (base64). */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, SCRYPT.keylen, SCRYPT);
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), key.toString('base64')].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [kind, N, r, p, salt, hash] = stored.split('$');
  if (kind !== 'scrypt' || !salt || !hash) return false;
  const want = Buffer.from(hash, 'base64');
  const got = await scryptAsync(password, Buffer.from(salt, 'base64'), want.length, { N: Number(N), r: Number(r), p: Number(p) });
  return got.length === want.length && timingSafeEqual(got, want);
}

/** A random key kept in the app's database, made on first use. */
function sessionKey(store: Store): Buffer {
  let hex = store.getSetting<string>('sessionKey');
  if (!hex || !/^[0-9a-f]{64}$/.test(hex)) {
    hex = randomBytes(32).toString('hex');
    store.setSetting('sessionKey', hex);
  }
  return Buffer.from(hex, 'hex');
}

const sign = (key: Buffer, payload: string, passwordHash: string) => createHmac('sha256', key).update(`${payload}.${passwordHash}`).digest('base64url');

export function sessionToken(store: Store, user: UserRow, at = Date.now()): string {
  const payload = `${user.id}.${at}`;
  return `${payload}.${sign(sessionKey(store), payload, user.password_hash)}`;
}

/** The signed-in user of a request's Cookie header, or null. */
export function userFromCookie(store: Store, cookieHeader: string | undefined): UserRow | null {
  const raw = cookieHeader
    ?.split(';')
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${SESSION_COOKIE}=`))
    ?.slice(SESSION_COOKIE.length + 1);
  const m = raw?.match(/^(\d{1,12})\.(\d{10,16})\.([A-Za-z0-9_-]{43})$/);
  if (!m) return null;
  const [, id, at, sig] = m;
  if (Date.now() - Number(at) > SESSION_DAYS * 86_400_000 || Number(at) > Date.now() + 60_000) return null;
  const user = store.getUser(Number(id));
  if (!user) return null;
  const want = Buffer.from(sign(sessionKey(store), `${id}.${at}`, user.password_hash));
  const got = Buffer.from(sig);
  return got.length === want.length && timingSafeEqual(got, want) ? user : null;
}

export const sessionCookie = (token: string) => `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_DAYS * 86_400}`;
export const clearedCookie = () => `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;

/** Wrong passwords per name: after 5 in a row, that name waits 30 seconds (a local app, but still not a free guess loop). */
const failures = new Map<string, { count: number; until: number }>();
export function loginBlocked(username: string): number {
  const f = failures.get(username.toLowerCase());
  return f && f.until > Date.now() ? Math.ceil((f.until - Date.now()) / 1000) : 0;
}
export function noteLogin(username: string, ok: boolean): void {
  const k = username.toLowerCase();
  if (ok) return void failures.delete(k);
  const f = failures.get(k) ?? { count: 0, until: 0 };
  f.count++;
  if (f.count >= 5) {
    f.until = Date.now() + 30_000;
    f.count = 0;
  }
  failures.set(k, f);
}
