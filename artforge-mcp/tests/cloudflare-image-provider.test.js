'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const canvas = require('../../drawing-tool/node_modules/@napi-rs/canvas');
const { CloudflareImageProvider, MODEL } = require('../src/engine/cloudflare-image-provider');
const spec = { version: 1, operationId: 'one', prompt: 'A blue armchair', width: 256, height: 256, seed: 7 };
function setup(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-provider-'));
  const p = new CloudflareImageProvider({ accountId: 'a'.repeat(32), freePlanConfirmed: true, canvasModule: canvas, budgetDir: dir,
    credentials: async () => ({ token: 'test-only-placeholder' }), ...options });
  t.after(() => { p.close(); fs.rmSync(dir, { recursive: true, force: true }); }); return p;
}
function bytes(format = 'image/png', width = 256) { return canvas.createCanvas(width, 256).toBuffer(format); }

test('actual multipart contract fixes destination/model and validates returned PNG', async t => {
  let request; const p = setup(t, { fetch: async (url, options) => { request = { url, options }; return Response.json({ success: true, result: { image: bytes().toString('base64') } }); } });
  const r = await p.generate(spec); assert.equal(r.mimeType, 'image/png');
  assert.equal(request.url, 'https://api.cloudflare.com/client/v4/accounts/' + 'a'.repeat(32) + '/ai/run/' + MODEL);
  assert.equal(request.options.body.get('width'), '256'); assert.equal(request.options.body.get('seed'), '7');
  assert.equal(request.options.headers['Content-Type'], undefined); assert.equal(request.options.redirect, 'error');
  assert.equal(request.options.body.get('prompt'), spec.prompt);
});

test('JPEG responses are checked for dimensions and normalized to the existing PNG contract', async t => {
  const p = setup(t, { fetch: async () => Response.json({ image: bytes('image/jpeg').toString('base64') }) });
  const r = await p.generate(spec); require('../src/engine/png-contract').validatePng(r.bytes, spec);
});

test('auth, rate limit, bad payload and network errors are classified without secrets or retries', async t => {
  for (const mode of [401, 403, 429, 500, 'json', 'dimensions', 'network']) {
    let calls = 0; const p = setup(t, { fetch: async () => { calls++; if (mode === 'network') throw Error('test-only-placeholder internal secret');
      if (typeof mode === 'number') return new Response('test-only-placeholder', { status: mode });
      if (mode === 'json') return Response.json({ image: 'not-base64!!' });
      return Response.json({ image: bytes('image/png', 512).toString('base64') }); } });
    const expected = { 401: 'CLOUDFLARE_AUTH_DENIED', 403: 'CLOUDFLARE_AUTH_DENIED', 429: 'CLOUDFLARE_RATE_LIMIT', 500: 'CLOUDFLARE_PROVIDER_ERROR', json: 'INVALID_GENERATION_IMAGE', dimensions: 'INVALID_GENERATION_IMAGE', network: 'CLOUDFLARE_NETWORK_ERROR' }[mode];
    await assert.rejects(p.generate(spec), e => e.code === expected && !e.message.includes('placeholder')); assert.equal(calls, 1);
  }
});

test('daily reservation persists across provider instances and unknown outcomes never repeat', async t => {
  const p = setup(t, { dailyNeurons: 27, fetch: async () => { throw Error('network'); } });
  await assert.rejects(p.generate(spec), { code: 'CLOUDFLARE_NETWORK_ERROR' });
  await assert.rejects(p.generate(spec), { code: 'CLOUDFLARE_OPERATION_RESERVED' });
  await assert.rejects(p.generate({ ...spec, operationId: 'two' }), { code: 'CLOUDFLARE_LOCAL_BUDGET' });
  assert.equal(p.db.prepare('SELECT COUNT(*) AS n FROM reservations').get().n, 1);
});

test('invalid credentials and dimensions fail before inference', async t => {
  let calls = 0; const p = setup(t, { credentials: async () => { throw Error('missing'); }, fetch: async () => { calls++; } });
  await assert.rejects(p.generate(spec), { code: 'CLOUDFLARE_AUTH_REQUIRED' });
  await assert.rejects(p.generate({ ...spec, width: 2048 }), { code: 'CLOUDFLARE_DIMENSIONS' }); assert.equal(calls, 0);
});

test('cancellation and deadline stop the HTTP transport without retry', async t => {
  const p = setup(t, { timeoutMs: 15, fetch: async (url, options) => new Promise((resolve, reject) => {
    if (options.signal.aborted) reject(Error('stopped')); else options.signal.addEventListener('abort', () => reject(Error('stopped')), { once: true });
  }) });
  await assert.rejects(p.generate(spec), { code: 'CLOUDFLARE_TIMEOUT' });
  const controller = new AbortController(); const r = p.generate({ ...spec, operationId: 'two' }, { signal: controller.signal });
  setTimeout(() => controller.abort(), 5); await assert.rejects(r, { code: 'GENERATION_CANCELLED' });
});
