import type { Response } from 'express';

export type NdjsonWriter = {
  send(event: Record<string, unknown>): void;
  end(): void;
  readonly closed: boolean;
};

export function ndjson(res: Response): NdjsonWriter {
  res.status(200);
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  let closed = false;
  res.on('close', () => {
    closed = true;
  });
  return {
    send(event) {
      if (closed) return;
      res.write(JSON.stringify(event) + '\n');
    },
    end() {
      if (closed) return;
      closed = true;
      res.end();
    },
    get closed() {
      return closed;
    },
  };
}
