import { mkdtempSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.ts';
import { createContext } from '../src/bootstrap.ts';
import type { AppConfig } from '../src/config.ts';
import type { AppContext } from '../src/context.ts';

export type TestServer = { ctx: AppContext; port: number; close(): Promise<void> };

export async function startTestServer(
  overrides: Partial<AppConfig> = {},
  appOpts: Parameters<typeof createApp>[1] = {},
): Promise<TestServer> {
  const dataDir = mkdtempSync(join(tmpdir(), 'skill-finder-test-'));
  const config: AppConfig = { port: 0, dev: false, dataDir, githubToken: null, ...overrides };
  const ctx = createContext(config, ':memory:');
  const app = createApp(ctx, appOpts);
  const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  config.port = (server.address() as AddressInfo).port;
  return {
    ctx,
    port: config.port,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          ctx.store.db.close();
          rmSync(dataDir, { recursive: true, force: true });
          resolve();
        });
      }),
  };
}

export type RawResponse = { status: number; headers: Record<string, string | string[] | undefined>; body: string };

/** Raw HTTP request so that Host/Origin can be set freely (fetch forbids overriding Host). */
export function rawRequest(opts: {
  port: number;
  host?: string;
  address?: string;
  method?: string;
  path: string;
  headers?: Record<string, string>;
  body?: string;
}): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: opts.address ?? '127.0.0.1',
        port: opts.port,
        method: opts.method ?? 'GET',
        path: opts.path,
        headers: { Host: opts.host ?? `127.0.0.1:${opts.port}`, ...opts.headers },
        timeout: 5000,
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    if (opts.body) req.write(opts.body);
    req.end();
  });
}
