import { existsSync } from 'node:fs';
import { join } from 'node:path';
import express, { type ErrorRequestHandler } from 'express';
import { WEB_DIST_DIR } from './config.ts';
import type { AppContext } from './context.ts';
import { adminRouter } from './routes/admin.ts';
import { healthRouter } from './routes/health.ts';
import { installRouter } from './routes/install.ts';
import { recommendRouter } from './routes/recommend.ts';
import { searchRouter } from './routes/search.ts';
import { skillsRouter } from './routes/skills.ts';
import type { SearchDeps } from './search/pipeline.ts';
import { CSP, securityMiddleware } from './security.ts';

export function createApp(ctx: AppContext, opts: { searchDeps?: SearchDeps } = {}): express.Express {
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
  app.use('/api', installRouter(ctx));
  app.use('/api', recommendRouter(ctx));
  app.use('/api', adminRouter(ctx));

  // any other /api path, in any case (/API/... is not an API route and not a page either)
  app.use((req, res, next) => {
    if (!req.path.toLowerCase().startsWith('/api')) return next();
    res.status(404).json({ error: '없는 API 주소입니다' });
  });

  if (existsSync(WEB_DIST_DIR)) {
    app.use((_req, res, next) => {
      res.setHeader('Content-Security-Policy', CSP);
      next();
    });
    // index.html must never be cached (it names the current hashed bundles); it is served by the fallback below.
    app.use(express.static(WEB_DIST_DIR, { index: false, maxAge: '1h' }));
    app.get(/^\/(?!api\/).*/i, (_req, res) => {
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(join(WEB_DIST_DIR, 'index.html'));
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
