const HEADERS = { 'X-Skill-Finder': '1' };

export class ApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

/**
 * fetch rejects with a bare TypeError ("Failed to fetch") when the server is not there; say what that means.
 * Aborts and every other error pass through unchanged.
 */
function request(input: string, init: RequestInit): Promise<Response> {
  return fetch(input, init).catch((err: unknown) => {
    if (err instanceof TypeError) throw new ApiError(`Skill Finder 서버에 연결하지 못했습니다. 검은 실행 창이 켜져 있는지 확인하세요. (${err.message})`, 0);
    throw err;
  });
}

async function handle<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new ApiError(body.error ?? `요청 실패 (${res.status})`, res.status);
  }
  return (await res.json()) as T;
}

export function apiGet<T>(path: string, params?: Record<string, string | undefined>): Promise<T> {
  const qs = params ? new URLSearchParams(Object.entries(params).filter(([, v]) => v != null && v !== '') as Array<[string, string]>).toString() : '';
  return request(`/api${path}${qs ? `?${qs}` : ''}`, { headers: HEADERS }).then((r) => handle<T>(r));
}

export function apiSend<T>(method: 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<T> {
  return request(`/api${path}`, {
    method,
    headers: { ...HEADERS, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then((r) => handle<T>(r));
}

/** POSTs and reads an NDJSON response, calling onEvent per line. */
export async function streamNdjson<E>(path: string, body: unknown, onEvent: (e: E) => void, signal?: AbortSignal): Promise<void> {
  const res = await request(`/api${path}`, {
    method: 'POST',
    headers: { ...HEADERS, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.body) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new ApiError(err.error ?? `요청 실패 (${res.status})`, res.status);
  }
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += value;
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) onEvent(JSON.parse(line) as E);
    }
  }
  if (buf.trim()) onEvent(JSON.parse(buf) as E);
}
