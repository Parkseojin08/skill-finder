// ARASAKA_IN game API on Cloudflare Workers. For now: the bindings and a health check proving the Worker can
// reach Workers KV (ranking cache) and Neon (source of truth). The game endpoints in docs/arasaka-db.md come next.
import { neon } from '@neondatabase/serverless';

/** The local Skill Finder page is the only caller: http://127.0.0.1:<port> or http://localhost:<port>. */
const LOOPBACK_ORIGIN = /^http:\/\/(?:127\.0\.0\.1|localhost):\d{1,5}$/;

function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get('Origin') ?? '';
  if (!LOOPBACK_ORIGIN.test(origin)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    Vary: 'Origin',
  };
}

function json(req: Request, body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...corsHeaders(req) },
  });
}

/** Reports only reachability, never error text: errors from the driver can echo connection details. */
async function health(env: Env): Promise<{ kv: boolean; db: boolean }> {
  const out = { kv: false, db: false };
  try {
    await env.RANK.get('season:v1:current');
    out.kv = true;
  } catch {
    // KV binding missing or unavailable
  }
  try {
    const sql = neon(env.DATABASE_URL);
    const rows = await sql`select count(*)::int as n from players`;
    out.db = typeof rows[0]?.n === 'number';
  } catch {
    // secret missing, database asleep past the timeout, or schema not applied
  }
  return out;
}

export default {
  async fetch(req, env): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(req) });
    if (url.pathname === '/v1/health' && req.method === 'GET') {
      const h = await health(env);
      return json(req, h, h.kv && h.db ? 200 : 503);
    }
    return json(req, { error: 'not found' }, 404);
  },

  /** Daily: expired sessions and login requests, and action logs older than 30 days. */
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(neon(env.DATABASE_URL)`select housekeeping()`.then(() => undefined));
  },
} satisfies ExportedHandler<Env>;
