// Public, privacy-preserving statistics and ratings for the OBR "AI Plugins" pages.
//   GET  /api/plugins/:id/stats   -> { views, users, ratings: { count, average }, ticket }
//   POST /api/plugins/:id/view    -> counts a page visit (one per visitor per 30 minutes)
//   POST /api/plugins/:id/rate    -> { stars, ticket, client, website(honeypot) } one rating per visitor (updatable)
// Visits are page views only; "users" are accounts that completed MCP activation (OAuth code exchange),
// excluding connections marked as tests. No IP address or user agent is stored: only HMAC digests keyed by STATS_SECRET.

const VIEW_WINDOW_MS = 30 * 60 * 1000;
const TICKET_MIN_AGE_MS = 2500;      // a human needs a moment between loading the page and rating
const TICKET_MAX_AGE_MS = 6 * 3600 * 1000;
const LIMITS = { view: 30, rate: 8 }; // per visitor fingerprint per hour

const enc = new TextEncoder();
async function hmac(secret, text) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(text));
  return btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function allowedOrigins(env) {
  return new Set(String(env.SITE_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean));
}

function cors(env, request) {
  const origin = request.headers.get('Origin') || '';
  const headers = { Vary: 'Origin', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
  if (allowedOrigins(env).has(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS';
    headers['Access-Control-Allow-Headers'] = 'Content-Type';
    headers['Access-Control-Max-Age'] = '600';
  }
  return headers;
}

const reply = (env, request, data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...cors(env, request) },
});

async function fingerprint(env, request) {
  const ip = request.headers.get('CF-Connecting-IP') || '0.0.0.0';
  const ua = (request.headers.get('User-Agent') || '').slice(0, 200);
  return hmac(env.STATS_SECRET, `fp|${ip}|${ua}`);
}

async function limited(env, kind, subject) {
  const bucket = `${kind}:${new Date().toISOString().slice(0, 13)}`;
  const row = await env.DB.prepare(
    'INSERT INTO plugin_rate_limits (bucket, subject, count) VALUES (?, ?, 1) ON CONFLICT(bucket, subject) DO UPDATE SET count = count + 1 RETURNING count',
  ).bind(bucket, subject).first();
  return (row?.count || 0) > LIMITS[kind];
}

async function stats(env, plugin) {
  const [views, ratings, users] = await env.DB.batch([
    env.DB.prepare('SELECT total FROM plugin_views WHERE plugin = ?').bind(plugin),
    env.DB.prepare('SELECT COUNT(*) AS count, AVG(stars) AS average FROM plugin_ratings WHERE plugin = ?').bind(plugin),
    // Users are only measurable for plugins served by this gateway (ArtForge).
    env.DB.prepare(`SELECT COUNT(DISTINCT c.user_id) AS n FROM code_exchanges c
                    JOIN gateway_users u ON u.user_id = c.user_id WHERE u.is_test = 0`),
  ]);
  const r = ratings.results[0] || {};
  return {
    plugin,
    views: views.results[0]?.total || 0,
    users: plugin === 'artforge' ? (users.results[0]?.n || 0) : null,
    ratings: { count: r.count || 0, average: r.count ? Math.round(r.average * 10) / 10 : null },
  };
}

async function ticketFor(env, fp) {
  const ts = Date.now();
  return `${ts}.${await hmac(env.STATS_SECRET, `ticket|${ts}|${fp}`)}`;
}

async function ticketValid(env, ticket, fp) {
  const [ts, sig] = String(ticket || '').split('.');
  const age = Date.now() - Number(ts);
  if (!Number.isFinite(age) || age < TICKET_MIN_AGE_MS || age > TICKET_MAX_AGE_MS) return false;
  return sig === await hmac(env.STATS_SECRET, `ticket|${ts}|${fp}`);
}

async function housekeeping(env) {
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM plugin_view_seen WHERE last_at < ?').bind(now - 2 * 86400000),
    env.DB.prepare("DELETE FROM plugin_rate_limits WHERE substr(bucket, instr(bucket, ':') + 1) < ?").bind(new Date(now - 2 * 3600000).toISOString().slice(0, 13)),
  ]);
}

export async function handlePluginsApi(request, env, ctx) {
  const url = new URL(request.url);
  const m = url.pathname.match(/^\/api\/plugins\/([a-z0-9-]{2,40})\/(stats|view|rate)$/);
  if (!m) return reply(env, request, { error: 'not_found' }, 404);
  const [, plugin, action] = m;
  const known = new Set(String(env.PLUGIN_IDS || 'artforge').split(',').map((s) => s.trim()));
  if (!known.has(plugin)) return reply(env, request, { error: 'unknown_plugin' }, 404);
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(env, request) });
  if (!env.STATS_SECRET) return reply(env, request, { error: 'not_configured' }, 503);

  const fp = await fingerprint(env, request);
  if (action === 'stats') {
    if (request.method !== 'GET') return reply(env, request, { error: 'method' }, 405);
    return reply(env, request, { ...(await stats(env, plugin)), ticket: await ticketFor(env, fp) });
  }

  if (request.method !== 'POST') return reply(env, request, { error: 'method' }, 405);
  // Writes are accepted only from the OBR site pages (browsers always send Origin on cross-site POST).
  if (!allowedOrigins(env).has(request.headers.get('Origin') || '')) return reply(env, request, { error: 'origin' }, 403);
  if (!/^application\/json\b/i.test(request.headers.get('Content-Type') || '')) return reply(env, request, { error: 'content_type' }, 415);
  if (/bot|crawl|spider|slurp|headless|preview/i.test(request.headers.get('User-Agent') || '')) return reply(env, request, { error: 'automated' }, 403);
  let body = {};
  try { body = JSON.parse((await request.text()).slice(0, 2000) || '{}'); } catch { return reply(env, request, { error: 'json' }, 400); }
  if (await limited(env, action, fp)) return reply(env, request, { error: 'rate_limited' }, 429);
  if (Math.random() < 0.02) ctx.waitUntil(housekeeping(env).catch(() => {}));

  if (action === 'view') {
    const now = Date.now();
    const seen = await env.DB.prepare('SELECT last_at FROM plugin_view_seen WHERE plugin = ? AND visitor = ?').bind(plugin, fp).first('last_at');
    if (!seen || now - seen > VIEW_WINDOW_MS) {
      await env.DB.batch([
        env.DB.prepare('INSERT INTO plugin_view_seen (plugin, visitor, last_at) VALUES (?, ?, ?) ON CONFLICT(plugin, visitor) DO UPDATE SET last_at = excluded.last_at').bind(plugin, fp, now),
        env.DB.prepare('INSERT INTO plugin_views (plugin, total) VALUES (?, 1) ON CONFLICT(plugin) DO UPDATE SET total = total + 1').bind(plugin),
      ]);
    }
    return reply(env, request, { ...(await stats(env, plugin)), counted: !seen || now - seen > VIEW_WINDOW_MS });
  }

  // rate
  const stars = Number(body.stars);
  const client = String(body.client || '');
  if (body.website) return reply(env, request, { error: 'automated' }, 400); // honeypot field filled by bots
  if (!Number.isInteger(stars) || stars < 1 || stars > 5) return reply(env, request, { error: 'stars' }, 400);
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(client)) return reply(env, request, { error: 'client' }, 400);
  if (!(await ticketValid(env, body.ticket, fp))) return reply(env, request, { error: 'ticket' }, 400);
  const clientHash = await hmac(env.STATS_SECRET, `client|${client}`);
  const now = Date.now();
  const existing = await env.DB.prepare('SELECT id FROM plugin_ratings WHERE plugin = ? AND (voter = ? OR client = ?) ORDER BY id LIMIT 1').bind(plugin, fp, clientHash).first('id');
  if (existing) {
    await env.DB.prepare('UPDATE OR IGNORE plugin_ratings SET stars = ?, updated_at = ? WHERE id = ?').bind(stars, now, existing).run();
  } else {
    await env.DB.prepare('INSERT OR IGNORE INTO plugin_ratings (plugin, voter, client, stars, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').bind(plugin, fp, clientHash, stars, now, now).run();
  }
  return reply(env, request, { ...(await stats(env, plugin)), yourRating: stars, updated: Boolean(existing) });
}
