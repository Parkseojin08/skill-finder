import { existsSync } from 'node:fs';
import express, { type ErrorRequestHandler } from 'express';
import { WEB_DIST_DIR } from './config.ts';
import type { AppContext } from './context.ts';
import { adminRouter } from './routes/admin.ts';
import { healthRouter } from './routes/health.ts';
import { installRouter } from './routes/install.ts';
import { presetsRouter } from './routes/presets.ts';
import { favoritesRouter } from './routes/favorites.ts';
import { recommendRouter } from './routes/recommend.ts';
import { searchRouter } from './routes/search.ts';
import { skillsRouter } from './routes/skills.ts';
import { similarRouter } from './routes/similar.ts';
import { translateFiles, translateRouter } from './routes/translate.ts';
import type { SearchDeps } from './search/pipeline.ts';
import { CSP, securityMiddleware } from './security.ts';

export function createApp(
  ctx: AppContext,
  opts: { searchDeps?: SearchDeps; webDistDir?: string } = {},
): express.Express {
  const webDistDir = opts.webDistDir ?? WEB_DIST_DIR;
  const app = express();
  app.disable('x-powered-by');
  app.set('etag', false);
  // /API/... must not reach the /api routes past a check written for /api (project review 2026-11-02)
  app.set('case sensitive routing', true);
  app.use(securityMiddleware(ctx.config));
  app.use('/api', express.json({ limit: '64kb' }));

  app.use('/api', healthRouter(ctx));
  app.use('/api', searchRouter(ctx, opts.searchDeps));
  app.use('/api', skillsRouter(ctx));
  app.use('/api', similarRouter(ctx));
  app.use('/api', installRouter(ctx));
  app.use('/api', presetsRouter(ctx));
  app.use('/api', favoritesRouter(ctx));
  app.use('/api', recommendRouter(ctx));
  app.use('/api', adminRouter(ctx));
  app.use('/api', translateRouter(ctx));

  // any other /api path, in any case (/API/... is not an API route and not a page either)
  app.use((req, res, next) => {
    if (!req.path.toLowerCase().startsWith('/api')) return next();
    res.status(404).json({ error: '없는 API 주소입니다' });
  });
  app.use(translateFiles(ctx));

  if (existsSync(webDistDir)) {
    app.use((_req, res, next) => {
      res.setHeader('Content-Security-Policy', CSP);
      next();
    });
    // index.html must never be cached (it names the current hashed bundles); it is served by the fallback below.
    app.use(express.static(webDistDir, { index: false, maxAge: '1h' }));
    app.get(/^\/(?!api\/).*/i, (_req, res) => {
      res.setHeader('Cache-Control', 'no-cache');
      // root keeps send's dotfile check off the install path (npx unpacks under ~/.npm/_npx, which 404'd every page)
      res.sendFile('index.html', { root: webDistDir });
    });
  }

  const onError: ErrorRequestHandler = (err, _req, res, _next) => {
    const status = typeof err?.status === 'number' && err.status >= 400 && err.status < 600 ? err.status : 500;
    if (status >= 500) console.error('[api]', err);
    if (!res.headersSent) res.status(status).json({ error: status >= 500 ? '서버 오류' : String(err.message ?? err) });
  };
  app.use(onError);
  return app;
}
