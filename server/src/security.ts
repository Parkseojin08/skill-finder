import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { DEV_VITE_PORT } from './config.ts';

export type SecurityOptions = { port: number; dev: boolean };

export function allowedHosts({ port, dev }: SecurityOptions): Set<string> {
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  if (dev) {
    hosts.add(`127.0.0.1:${DEV_VITE_PORT}`);
    hosts.add(`localhost:${DEV_VITE_PORT}`);
  }
  return hosts;
}

export function allowedOrigins(opts: SecurityOptions): Set<string> {
  return new Set([...allowedHosts(opts)].map((h) => `http://${h}`));
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function deny(res: Response, message: string) {
  res.status(403).json({ error: message });
}

/**
 * - Host allow-list on every request (DNS rebinding).
 * - `/api` requires `X-Skill-Finder: 1`, which forces a CORS preflight from other origins; no CORS headers are ever sent.
 * - State-changing methods require an Origin that is the app's own origin.
 */
export function securityMiddleware(opts: SecurityOptions): RequestHandler {
  // `opts` may be the live config object; the port is only known for sure after listen().
  return (req: Request, res: Response, next: NextFunction) => {
    const hosts = allowedHosts(opts);
    const origins = allowedOrigins(opts);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');

    const host = (req.headers.host ?? '').toLowerCase();
    if (!hosts.has(host)) return deny(res, 'host not allowed');

    if (req.path.startsWith('/api')) {
      if (req.method === 'OPTIONS') return deny(res, 'cors not allowed');
      if (req.get('x-skill-finder') !== '1') return deny(res, 'missing X-Skill-Finder header');
      if (!SAFE_METHODS.has(req.method)) {
        const origin = req.get('origin');
        if (!origin || !origins.has(origin.toLowerCase())) return deny(res, 'origin not allowed');
      }
    }
    next();
  };
}

export const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; " +
  "connect-src 'self'; font-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";
