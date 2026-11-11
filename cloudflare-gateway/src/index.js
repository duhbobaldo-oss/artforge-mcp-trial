// ArtForge AI MCP gateway (Cloudflare Worker, Free plan).
// - OAuth 2.1 for ChatGPT / Claude / Claude Code through @cloudflare/workers-oauth-provider
//   (PRM, RFC 8414 metadata, CIMD, DCR, PKCE S256, resource-bound tokens, RFC 9207 iss).
// - Public, free OAuth consent; each connection receives an isolated identity.
// - /mcp is proxied to the unchanged customer-trial engine (Render) with the engine's own token.
// - Per-user isolation: documents/plans/artifacts created through the gateway belong to their creator.
// - initialize / tools/list / resources/list are answered from a snapshot so connecting does not wait
//   for a sleeping Render instance.
import { OAuthProvider, AuthorizationError, CimdFetchError, OAuthError } from '@cloudflare/workers-oauth-provider';
import snapshot from './snapshot.json';
import { consentPage, messagePage, landingPage } from './pages.js';
import { handlePluginsApi } from './plugins-api.js';
import { GENERATION_TOOL, handleGeneration, generationCapabilities } from './image-generation.js';

const SCOPE = 'artforge';
const MAX_BODY = 1_600_000; // same limit as the trial server
const ID_KEYS = { documentId: 'doc', planId: 'plan', artifactId: 'artifact' };
const CLAIM_TOOLS = new Set(['artforge_create_design', 'artforge_execute_design', 'artforge_plan_design']);

const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), {
  status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers },
});
const rpcResult = (id, result) => json({ jsonrpc: '2.0', id, result });
const rpcError = (id, code, message) => json({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
const toolError = (id, code, ar, en) => rpcResult(id, {
  content: [{ type: 'text', text: `${ar}\n${en}` }],
  structuredContent: { error: { code, message: en } },
  isError: true,
});

function collectIds(value, out = [], depth = 0) {
  if (!value || typeof value !== 'object' || depth > 12) return out;
  for (const [key, child] of Object.entries(value)) {
    if (ID_KEYS[key] && typeof child === 'string') out.push({ kind: ID_KEYS[key], id: child });
    else if (child && typeof child === 'object') collectIds(child, out, depth + 1);
  }
  return out;
}

function resultData(result) {
  if (result?.structuredContent && typeof result.structuredContent === 'object') return result.structuredContent;
  const text = result?.content?.find?.((c) => c.type === 'text')?.text;
  try { return text ? JSON.parse(text) : null; } catch { return null; }
}

// ---------------------------------------------------------------- engine (Render) proxy
async function callEngine(env, message) {
  const deadline = Date.now() + Number(env.ENGINE_TIMEOUT_MS || 110000);
  let attempt = 0;
  while (true) {
    attempt += 1;
    let response;
    try {
      response = await fetch(`${env.ORIGIN_URL}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${env.ORIGIN_TOKEN}` },
        body: JSON.stringify(message),
        signal: AbortSignal.timeout(Math.max(1000, deadline - Date.now())),
      });
    } catch {
      return { unavailable: true };
    }
    // The trial engine serves one request at a time and answers 429 otherwise: wait and retry.
    if (response.status === 429 && Date.now() + 1500 < deadline && attempt < 40) {
      await response.body?.cancel();
      await new Promise((r) => setTimeout(r, 1000));
      continue;
    }
    if (response.status === 202) return { empty: true };
    const type = response.headers.get('Content-Type') || '';
    if (!response.ok || !type.includes('application/json')) {
      await response.body?.cancel();
      return { unavailable: true, status: response.status };
    }
    return { body: await response.json() };
  }
}

const WAKING = ['ArtForge يستيقظ على الاستضافة المجانية. قد يستغرق ذلك عدة دقائق؛ أعد المحاولة بعد قليل.',
  'ArtForge is waking up on free hosting. This can take several minutes; please retry shortly.'];

async function ownerOf(env, kind, id) {
  return (await env.DB.prepare('SELECT user_id FROM ownership WHERE kind = ? AND id = ?').bind(kind, id).first('user_id')) || null;
}

async function claim(env, userId, ids) {
  if (!ids.length) return;
  const now = Date.now();
  await env.DB.batch(ids.map(({ kind, id }) => env.DB.prepare('INSERT OR IGNORE INTO ownership (kind, id, user_id, created_at) VALUES (?, ?, ?, ?)').bind(kind, id, userId, now)));
}

async function ownedSet(env, userId, kind) {
  const rows = await env.DB.prepare('SELECT id FROM ownership WHERE user_id = ? AND kind = ?').bind(userId, kind).all();
  return new Set(rows.results.map((r) => r.id));
}

async function scopeStatus(env, userId, body) {
  const data = resultData(body.result);
  if (!data) return body;
  const docs = await ownedSet(env, userId, 'doc');
  const scoped = {
    references: data.references,
    drawingTool: { reachable: Boolean(data.drawingTool?.reachable) },
    documents: (data.documents || []).filter((d) => docs.has(d?.id || d?.documentId)),
    latestRuns: (data.latestRuns || []).filter((r) => docs.has(r?.documentId)),
  };
  return { ...body, result: { content: [{ type: 'text', text: JSON.stringify(scoped, null, 2) }], structuredContent: scoped, isError: false } };
}

async function scopeArtifacts(env, userId, body) {
  const data = resultData(body.result);
  if (!data || !Array.isArray(data.artifacts)) return body;
  const mine = await ownedSet(env, userId, 'artifact');
  const scoped = { ...data, artifacts: data.artifacts.filter((a) => mine.has(a?.id)) };
  return { ...body, result: { ...body.result, content: [{ type: 'text', text: JSON.stringify(scoped, null, 2) }], structuredContent: scoped } };
}

const McpHandler = {
  async fetch(request, env, ctx) {
    if (request.method !== 'POST') return json({ error: 'Use POST' }, 405, { Allow: 'POST' });
    const userId = ctx.props?.userId;
    if (!userId) return json({ error: 'unauthorized' }, 401);
    // Connection deactivation takes effect immediately, including for existing tokens.
    const active = await env.DB.prepare('SELECT 1 AS ok FROM gateway_users WHERE user_id = ? AND disabled = 0 LIMIT 1')
      .bind(userId).first('ok');
    if (!active) {
      return json({ error: 'access_revoked', error_description: 'ArtForge access for this account is disabled.' }, 403,
        { 'WWW-Authenticate': 'Bearer error="insufficient_scope", error_description="access disabled"' });
    }
    if (Number(request.headers.get('Content-Length') || 0) > MAX_BODY) return json({ error: 'Request exceeds limit' }, 413);
    const raw = await request.text();
    if (raw.length > MAX_BODY) return json({ error: 'Request exceeds limit' }, 413);
    let message;
    try { message = JSON.parse(raw); } catch { return rpcError(null, -32700, 'Invalid JSON'); }
    if (!message || typeof message !== 'object' || Array.isArray(message)) return rpcError(null, -32600, 'Expected one JSON-RPC message');
    const { id, method, params } = message;

    if (id === undefined || id === null) return new Response(null, { status: 202 }); // notifications
    if (method === 'ping') return rpcResult(id, {});
    if (method === 'initialize') {
      ctx.waitUntil(fetch(`${env.ORIGIN_URL}/health`).catch(() => {})); // start waking the engine early
      const requested = params?.protocolVersion;
      const protocolVersion = snapshot.protocolVersions.includes(requested) ? requested : snapshot.protocolVersions[0];
      return rpcResult(id, { ...snapshot.initialize, protocolVersion, instructions: `${snapshot.initialize.instructions || ''}\nFor neural image generation use artforge_generate_image: submit once with a stable operationId, then poll get with jobId. The same workflow is available through artforge_tool_op generation.jobs.submit/get for cached clients. Generator: FLUX.2 Klein 4B on Cloudflare Workers AI; public output is a 256-512px raster with daily quotas.` });
    }
    if (method === 'tools/list') return rpcResult(id, { ...snapshot.toolsList, tools: [...snapshot.toolsList.tools, ...(env.IMAGE_GENERATION_ENABLED === '1' ? [GENERATION_TOOL] : [])] });
    if (method === 'prompts/list') return rpcResult(id, { prompts: [] });
    if (method === 'resources/templates/list') return rpcResult(id, snapshot.resourceTemplates);
    if (method === 'resources/list') {
      const mine = await ownedSet(env, userId, 'artifact');
      const engine = await callEngine(env, message);
      const listed = engine.body?.result?.resources || snapshot.resourcesList.resources;
      return rpcResult(id, { resources: listed.filter((r) => !/^artforge:\/\/artifact\//.test(r.uri) || mine.has(String(r.uri).replace('artforge://artifact/', ''))) });
    }
    if (method === 'resources/read') {
      const uri = String(params?.uri || '');
      if (uri === snapshot.widget?.uri) return rpcResult(id, snapshot.widget.read);
      if (/^artforge:\/\/artifact\//.test(uri) && await ownerOf(env, 'artifact', uri.replace('artforge://artifact/', '')) !== userId) {
        return rpcError(id, -32602, `Unknown resource: ${uri}`);
      }
    }

    if (method === 'tools/call') {
      if (params?.name === GENERATION_TOOL.name) return rpcResult(id, await handleGeneration(env, ctx, userId, params.arguments));
      if (params?.name === 'artforge_tool_op' && String(params.arguments?.op || '').startsWith('generation.jobs.')) {
        const action = params.arguments.op.slice('generation.jobs.'.length), p = { ...(params.arguments.params || {}) };
        if (action === 'submit') { if(p.version!==1 || (p.overlays && (!Array.isArray(p.overlays)||p.overlays.length))) return toolError(id,'GENERATION_OVERLAYS_UNSUPPORTED','المسار العام يولّد صورة نقطية مستقلة.','Public generation returns an independent raster image.'); delete p.version;delete p.overlays; }
        return rpcResult(id, await handleGeneration(env, ctx, userId, { ...p, action: action === 'preview' ? 'get' : action }));
      }
      for (const { kind, id: resourceId } of collectIds(params?.arguments)) {
        if (await ownerOf(env, kind, resourceId) !== userId) {
          return toolError(id, 'NOT_FOUND', 'العنصر المطلوب غير موجود أو لا يخصّك. أنشئ تصميمًا جديدًا.', `${kind} not found for this account. Create a new design.`);
        }
      }
    }

    const engine = await callEngine(env, message);
    if (engine.empty) return new Response(null, { status: 202 });
    if (engine.unavailable) {
      return method === 'tools/call' ? toolError(id, 'ENGINE_WAKING', ...WAKING) : rpcError(id, -32603, WAKING[1]);
    }
    let body = engine.body;
    if (method === 'tools/call' && body?.result && !body.result.isError) {
      const name = params?.name;
      if (name === 'artforge_capabilities') {
        const data = resultData(body.result); if(data) { data.generativeImages = { ...generationCapabilities(), enabled:env.IMAGE_GENERATION_ENABLED==='1' }; body.result.structuredContent=data; body.result.content=[{type:'text',text:JSON.stringify(data)}]; }
      }
      const isPlanOp = name === 'artforge_tool_op' && params?.arguments?.op === 'design.plan';
      if (CLAIM_TOOLS.has(name) || isPlanOp) {
        const data = resultData(body.result);
        const ids = collectIds(data).filter((x) => x.kind !== 'artifact');
        await claim(env, userId, ids);
      }
      if (name === 'artforge_status') body = await scopeStatus(env, userId, body);
      if (name === 'artforge_artifacts' && params?.arguments?.action === 'list') body = await scopeArtifacts(env, userId, body);
    }
    return json(body);
  },
};

// ---------------------------------------------------------------- authorization UI
function html(body, status = 200, headers = new Headers()) {
  headers.set('Content-Type', 'text/html; charset=utf-8');
  headers.set('Cache-Control', 'no-store');
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Referrer-Policy', 'no-referrer');
  if (!headers.has('Content-Security-Policy')) headers.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'");
  if (!headers.has('X-Frame-Options')) headers.set('X-Frame-Options', 'DENY');
  return new Response(body, { status, headers });
}

async function showConsent(env, oauth, request, error) {
  const getRequest = new Request(request.url, { method: 'GET', headers: request.headers });
  const oauthRequest = await oauth.parseAuthRequest(getRequest);
  const details = await oauth.describeConsent(oauthRequest);
  const consent = await oauth.beginConsent(oauthRequest);
  return html(consentPage(details, consent.handle, { error, siteUrl: env.SITE_URL }), error ? 400 : 200, consent.headers);
}

const AuthApp = {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/health') return json({ ok: true });
    if (url.pathname.startsWith('/api/plugins/')) return handlePluginsApi(request, env, ctx);
    if (url.pathname === '/') return html(landingPage({ mcpUrl: `${env.PUBLIC_ORIGIN}/mcp`, siteUrl: env.SITE_URL }));
    if (url.pathname !== '/authorize') return json({ error: 'Not found' }, 404);
    const oauth = env.OAUTH_PROVIDER;
    try {
      if (request.method === 'GET') return await showConsent(env, oauth, request);
      if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
      const form = await request.formData();
      const handle = String(form.get('handle') || '');
      if (form.get('decision') !== 'approve') {
        const denied = await oauth.denyConsent(request, handle);
        return new Response(null, { status: 302, headers: denied.headers });
      }
      const approved = await oauth.approveConsent(request, handle, { scope: [SCOPE] });
      const userId = `usr_${crypto.randomUUID().replaceAll('-', '')}`;
      await env.DB.prepare('INSERT INTO gateway_users (user_id, initial_client_id, created_at) VALUES (?, ?, ?)')
        .bind(userId, approved.request.clientId, Date.now()).run();
      const { redirectTo } = await oauth.completeAuthorization({
        request: approved.request,
        userId,
        metadata: { via: 'public' },
        scope: [SCOPE],
        props: { userId },
      });
      approved.headers.set('Location', redirectTo);
      return new Response(null, { status: 302, headers: approved.headers });
    } catch (error) {
      if (error instanceof AuthorizationError && error.redirectTo) return Response.redirect(error.redirectTo, 302);
      if (error instanceof AuthorizationError || error instanceof CimdFetchError) {
        return html(messagePage('تعذّر إكمال الربط', 'انتهت صلاحية الطلب أو لم يمكن التحقق من التطبيق. ابدأ الربط مجددًا من ChatGPT أو Claude.'), 400);
      }
      throw error;
    }
  },
};

// ---------------------------------------------------------------- provider (built lazily: options depend on env)
let provider;
function getProvider(env) {
  if (!provider) {
    provider = new OAuthProvider({
      apiRoute: '/mcp',
      apiHandler: McpHandler,
      defaultHandler: AuthApp,
      authorizeEndpoint: '/authorize',
      tokenEndpoint: '/token',
      clientRegistrationEndpoint: '/register',
      scopesSupported: [SCOPE],
      requiredScopes: [SCOPE],
      clientIdMetadataDocumentEnabled: true,
      accessTokenTTL: Number(env.ACCESS_TOKEN_TTL || 28800),
      resourceMetadata: {
        resource: `${env.PUBLIC_ORIGIN}/mcp`,
        authorization_servers: [env.PUBLIC_ORIGIN],
        bearer_methods_supported: ['header'],
        resource_name: 'ArtForge AI MCP (OBR Group)',
      },
      // KV (the library's store) is eventually consistent; D1 is not. Enforce in D1 that an authorization
      // code is exchanged once, and that deactivated connections cannot refresh tokens.
      tokenExchangeCallback: async ({ grantType, grantId, userId, env: e }) => {
        if (grantType === 'authorization_code') {
          const r = await e.DB.prepare('INSERT OR IGNORE INTO code_exchanges (grant_id, user_id, exchanged_at) VALUES (?, ?, ?)').bind(grantId, userId, Date.now()).run();
          if (!r.meta.changes) throw new OAuthError('invalid_grant', { description: 'Authorization code has already been used.' });
        } else if (grantType === 'refresh_token') {
          const active = await e.DB.prepare('SELECT 1 AS ok FROM gateway_users WHERE user_id = ? AND disabled = 0 LIMIT 1').bind(userId).first('ok');
          if (!active) throw new OAuthError('invalid_grant', { description: 'Access for this account is disabled.' });
        }
        return undefined;
      },
      onError: ({ code, internal }) => { console.warn('oauth', code, internal?.reason || ''); },
    });
  }
  return provider;
}

export default {
  fetch(request, env, ctx) { return getProvider(env).fetch(request, env, ctx); },
  async scheduled(_event, env, ctx) {
    // Optional keep-warm (enable a cron trigger only with the owner's approval).
    if (env.KEEP_WARM === '1') ctx.waitUntil(fetch(`${env.ORIGIN_URL}/health`).catch(() => {}));
    ctx.waitUntil(getProvider(env).purgeExpiredData(env, { batchSize: 100 }).catch(() => {}));
  },
};
