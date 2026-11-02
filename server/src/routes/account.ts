import { Router, type Request } from 'express';
import { z } from 'zod';
import {
  clearedCookie,
  hashPassword,
  loginBlocked,
  noteLogin,
  PASSWORD_MAX,
  PASSWORD_MIN,
  serialLogin,
  sessionCookie,
  sessionCookieName,
  sessionToken,
  userFromCookie,
  USERNAME_RE,
  verifyPassword,
} from '../auth.ts';
import type { AppContext } from '../context.ts';
import type { UserRow } from '../db/store.ts';
import { freshInstalls, freshness, TRUST_SCORE, trustTier } from '../search/rank.ts';
import { buildResultItem, githubSource, marketplaceSource, storeLookup, type ResultItem } from '../search/result.ts';

const Credentials = z.object({ username: z.string().max(64), password: z.string().max(PASSWORD_MAX) });
const FavoriteBody = z.object({ id: z.string().min(1).max(400) });

/** Sign-up, login and the signed-in user's favorite skills (user decision 2026-11-02). */
export function accountRouter(ctx: AppContext): Router {
  const r = Router();
  const { store } = ctx;
  // the port is read per request: a test server learns its port after the router is made
  const cookieName = () => sessionCookieName(ctx.config.port);
  const userOf = (req: Request): UserRow | null => userFromCookie(store, req.headers.cookie, cookieName());
  /** Answers a wrong name and a wrong password alike, after the same scrypt work (made once, at start). */
  const dummyHash = hashPassword('not a password of anyone');
  dummyHash.catch(() => {});
  const publicUser = (u: UserRow) => ({ id: u.id, username: u.username });

  r.get('/auth/me', (req, res) => {
    const u = userOf(req);
    res.json({ user: u ? publicUser(u) : null });
  });

  r.post('/auth/signup', async (req, res) => {
    const parsed = Credentials.safeParse(req.body);
    if (!parsed.success) return void res.status(400).json({ error: '아이디와 비밀번호를 입력하세요' });
    const { username, password } = parsed.data;
    if (!USERNAME_RE.test(username)) return void res.status(400).json({ error: '아이디는 영문·숫자·_.- 3~32자입니다' });
    if (password.length < PASSWORD_MIN) return void res.status(400).json({ error: `비밀번호는 ${PASSWORD_MIN}자 이상이어야 합니다` });
    if (store.getUserByName(username)) return void res.status(409).json({ error: '이미 있는 아이디입니다' });
    const hash = await hashPassword(password);
    let user;
    try {
      user = store.createUser(username, hash);
    } catch {
      return void res.status(409).json({ error: '이미 있는 아이디입니다' }); // the same name signed up meanwhile
    }
    res.setHeader('Set-Cookie', sessionCookie(cookieName(), sessionToken(store, user)));
    res.status(201).json({ user: publicUser(user) });
  });

  r.post('/auth/login', async (req, res) => {
    const parsed = Credentials.safeParse(req.body);
    if (!parsed.success) return void res.status(400).json({ error: '아이디와 비밀번호를 입력하세요' });
    const { username, password } = parsed.data;
    const outcome = await serialLogin(username, async () => {
      const wait = loginBlocked(username);
      if (wait) return { wait };
      const user = store.getUserByName(username);
      const ok = await verifyPassword(password, user?.password_hash ?? (await dummyHash));
      noteLogin(username, !!user && ok);
      return { user: user && ok ? user : null };
    });
    if ('wait' in outcome) return void res.status(429).json({ error: `잘못된 비밀번호가 여러 번 들어왔습니다. ${outcome.wait}초 뒤에 다시 해 보세요` });
    if (!outcome.user) return void res.status(401).json({ error: '아이디 또는 비밀번호가 맞지 않습니다' });
    res.setHeader('Set-Cookie', sessionCookie(cookieName(), sessionToken(store, outcome.user)));
    res.json({ user: publicUser(outcome.user) });
  });

  r.post('/auth/logout', (_req, res) => {
    res.setHeader('Set-Cookie', clearedCookie(cookieName()));
    res.json({ ok: true });
  });

  // ── favorites: only for a signed-in user ──
  const needUser = (req: Request, res: import('express').Response): UserRow | null => {
    const u = userOf(req);
    if (!u) res.status(401).json({ error: '즐겨찾기는 로그인한 뒤에 쓸 수 있습니다' });
    return u;
  };

  r.get('/favorites/ids', (req, res) => {
    const u = userOf(req);
    res.json({ ids: u ? store.listFavorites(u.id).map((f) => f.skill_id) : [] });
  });

  /** The favorites as result cards; ones whose skill left the index are listed by name. */
  r.get('/favorites', (req, res) => {
    const u = needUser(req, res);
    if (!u) return;
    const lookup = storeLookup(store);
    const items: ResultItem[] = [];
    const gone: Array<{ id: string; name: string }> = [];
    for (const f of store.listFavorites(u.id)) {
      const s = store.getSkill(f.skill_id);
      if (!s) {
        gone.push({ id: f.skill_id, name: f.skill_name });
        continue;
      }
      const plugin = lookup.plugin(s.plugin_id);
      const source = plugin ? marketplaceSource(s, plugin) : githubSource(s);
      const breakdown = { R: 0, P: 0, F: freshness(s.last_commit_at), T: TRUST_SCORE[trustTier(s, plugin)] };
      items.push(
        buildResultItem({ skill: s, lookup, sources: source ? [source] : [], installs: freshInstalls(s), stars: s.repo ? (store.getRepo(s.repo)?.stars ?? null) : null, breakdown, score: 0 }),
      );
    }
    res.json({ items, gone });
  });

  r.post('/favorites', (req, res) => {
    const u = needUser(req, res);
    if (!u) return;
    const parsed = FavoriteBody.safeParse(req.body);
    const skill = parsed.success ? store.getSkill(parsed.data.id) : undefined;
    if (!skill) return void res.status(404).json({ error: '스킬을 찾을 수 없습니다' });
    store.addFavorite(u.id, skill.id, skill.name);
    res.json({ ok: true });
  });

  // the id in the address: some clients send no body with DELETE
  r.delete('/favorites', (req, res) => {
    const u = needUser(req, res);
    if (!u) return;
    const parsed = FavoriteBody.safeParse({ id: req.query.id });
    if (!parsed.success) return void res.status(400).json({ error: '스킬 id가 없습니다' });
    store.removeFavorite(u.id, parsed.data.id);
    res.json({ ok: true });
  });

  return r;
}
