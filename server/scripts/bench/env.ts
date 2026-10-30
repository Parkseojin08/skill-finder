// Measurement environment for the bench tools (perf debate 1-1): a pinned clock, and one network layer (fetch and
// child processes such as git) with three modes.
//   offline: every request and git run fails at once (local index only).
//   record:  real network; every response with its body, status, headers and timing, and every git run, is kept.
//   replay:  answers come from a recording after their recorded delay; nothing touches the network.
// Search results depend on the date (30-day downloads, 7-day stored stars, freshness), so the clock is pinned:
// replay runs at the recording's time, offline at a given time.
import { createHash } from 'node:crypto';

/** Starts the clock at `epochMs` and lets it tick from there (timeouts and sleeps keep working). */
export function pinClock(epochMs: number): void {
  const RealDate = Date;
  const offset = epochMs - RealDate.now();
  class PinnedDate extends RealDate {
    constructor(...a: unknown[]) {
      if (a.length === 0) super(RealDate.now() + offset);
      else super(...(a as [string | number]));
    }
    static now() {
      return RealDate.now() + offset;
    }
  }
  globalThis.Date = PinnedDate as unknown as DateConstructor;
}

export type NetRec = {
  q: string;
  method: string;
  url: string;
  reqBody: string | null;
  start: number;
  headersAt?: number;
  endAt?: number;
  status?: number;
  bytes?: number;
  resHeaders?: Record<string, string>;
  body?: string;
  err?: string;
};
export type ProcRec = { q: string; file: string; args: string[]; start: number; end: number; result?: unknown };
export type Recording = { version: 1; epoch0: number; token: boolean; recs: NetRec[]; procs: ProcRec[] };

type ProcResult = { exitCode: number; stdout: string; stderr: string; timedOut: boolean };
type ProcHook = (file: string, args: string[], opts: unknown, real: (f: string, a: string[], o: unknown) => Promise<ProcResult>) => Promise<ProcResult>;
const setProcHook = (hook: ProcHook) => ((globalThis as { __skillFinderProcHook?: ProcHook }).__skillFinderProcHook = hook);

const KEEP_HEADERS = ['etag', 'x-ratelimit-resource', 'x-ratelimit-remaining', 'x-ratelimit-reset', 'retry-after', 'content-type'];
const keyOf = (method: string, url: string, body: string | null) => `${method} ${url}${body ? ' ' + createHash('sha1').update(body).digest('hex') : ''}`;
/** git arguments without credentials and per-run folders, so a replay matches what was recorded */
const cleanArgs = (args: string[]) => args.filter((a) => !/^(credential|core\.|http\.)/.test(a)).map((a) => (/[\\/]tmp[\\/]git[\\/]/.test(a) ? '<dir>' : a));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type Net = {
  /** The query now running, to group requests per query in the output. */
  setQuery(q: string): void;
  recs: NetRec[];
  procs: ProcRec[];
  /** Replay only: requests or git runs that were not in the recording. */
  misses: string[];
};

export function installNet(mode: 'offline' | 'record' | 'replay', rec: Recording | null, clock: () => number): Net {
  const net: Net = { setQuery: (q) => void (cur = q), recs: [], procs: [], misses: [] };
  let cur = '';
  const realFetch = globalThis.fetch;

  if (mode === 'offline') {
    globalThis.fetch = (async () => {
      throw new TypeError('offline');
    }) as typeof fetch;
    setProcHook(async () => ({ exitCode: 128, stdout: '', stderr: 'offline', timedOut: false }));
    return net;
  }

  if (mode === 'record') {
    globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const r: NetRec = { q: cur, method: init.method ?? 'GET', url, reqBody: typeof init.body === 'string' ? init.body : null, start: clock() };
      net.recs.push(r);
      try {
        const res = await realFetch(input, init);
        r.headersAt = clock();
        r.status = res.status;
        r.resHeaders = Object.fromEntries(KEEP_HEADERS.flatMap((h) => (res.headers.get(h) != null ? [[h, res.headers.get(h)!]] : [])));
        // every body, whatever its size (a 10MB tree is exactly what a replay must reproduce)
        res
          .clone()
          .arrayBuffer()
          .then((b) => {
            r.endAt = clock();
            r.bytes = b.byteLength;
            r.body = Buffer.from(b).toString('utf8');
          })
          .catch((e) => (r.err = String(e)));
        return res;
      } catch (e) {
        r.headersAt = clock();
        r.err = String((e as Error)?.message ?? e);
        throw e;
      }
    }) as typeof fetch;
    setProcHook(async (file, args, opts, real) => {
      const p: ProcRec = { q: cur, file, args: cleanArgs(args), start: clock(), end: 0 };
      net.procs.push(p);
      try {
        p.result = await real(file, args, opts);
        return p.result as ProcResult;
      } finally {
        p.end = clock();
      }
    });
    return net;
  }

  // replay
  const queues = new Map<string, NetRec[]>();
  for (const r of rec!.recs) queues.set(keyOf(r.method, r.url, r.reqBody), [...(queues.get(keyOf(r.method, r.url, r.reqBody)) ?? []), r]);
  globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = init.method ?? 'GET';
    const q = queues.get(keyOf(method, url, typeof init.body === 'string' ? init.body : null));
    const r: NetRec = { q: cur, method, url, reqBody: null, start: clock() };
    net.recs.push(r);
    if (!q?.length) {
      net.misses.push(`${cur} | ${method} ${url}`);
      r.err = 'not recorded';
      throw new TypeError('replay: not recorded');
    }
    const src = q.length > 1 ? q.shift()! : q[0];
    await sleep(Math.max(0, (src.headersAt ?? src.start) - src.start));
    r.headersAt = clock();
    r.status = src.status;
    if (src.status == null) {
      r.err = src.err;
      throw new TypeError(src.err ?? 'replay: recorded failure');
    }
    r.bytes = src.bytes;
    r.endAt = clock();
    const noBody = src.status === 204 || src.status === 304;
    return new Response(noBody ? null : (src.body ?? ''), { status: src.status, headers: src.resHeaders ?? {} });
  }) as typeof fetch;
  const procQueues = new Map<string, ProcRec[]>();
  for (const p of rec!.procs ?? []) {
    const k = `${p.file} ${cleanArgs(p.args).join(' ')}`; // cleaned again: older recordings kept the folders
    procQueues.set(k, [...(procQueues.get(k) ?? []), p]);
  }
  setProcHook(async (file, args) => {
    const k = `${file} ${cleanArgs(args).join(' ')}`;
    const q = procQueues.get(k);
    const p: ProcRec = { q: cur, file, args: cleanArgs(args), start: clock(), end: 0 };
    net.procs.push(p);
    if (!q?.length) {
      net.misses.push(`${cur} | ${k.slice(0, 160)}`);
      p.end = clock();
      return { exitCode: 128, stdout: '', stderr: 'replay: not recorded', timedOut: false };
    }
    const src = q.length > 1 ? q.shift()! : q[0];
    await sleep(src.end - src.start);
    p.end = clock();
    return src.result as ProcResult;
  });
  return net;
}
