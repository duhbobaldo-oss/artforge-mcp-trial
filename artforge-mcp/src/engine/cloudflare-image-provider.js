'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { error, compileGenerationSpec } = require('./generation-spec');
const { validatePng } = require('./png-contract');
const MODEL = '@cf/black-forest-labs/flux-2-klein-4b';

// REST adapter for the existing generation coordinator. No Worker deployment or client-selected URL.
class CloudflareImageProvider {
  constructor(options) {
    if (options.freePlanConfirmed !== true || !/^[a-f0-9]{32}$/.test(options.accountId || '')
      || typeof options.credentials !== 'function' || !options.canvasModule) throw error('CLOUDFLARE_DEV_UNCONFIGURED');
    this.id = 'cloudflare-flux2-klein-4b';
    this.accountId = options.accountId;
    this.credentials = options.credentials;
    this.canvas = options.canvasModule;
    this.fetch = options.fetch || globalThis.fetch;
    this.timeoutMs = Math.min(120000, options.timeoutMs || 90000);
    this.limit = options.dailyNeurons === undefined ? 900 : options.dailyNeurons;
    if (!Number.isInteger(this.limit) || this.limit < 1 || this.limit > 900) throw error('CLOUDFLARE_DEV_UNCONFIGURED');
    this.profileHash = crypto.createHash('sha256').update(JSON.stringify({ provider: this.id, account: this.accountId, model: MODEL, maxSize: 1024 })).digest('hex');
    const { DatabaseSync } = require('node:sqlite');
    fs.mkdirSync(options.budgetDir, { recursive: true });
    this.db = new DatabaseSync(path.join(options.budgetDir, this.accountId + '.sqlite'));
    this.db.exec(`PRAGMA busy_timeout=3000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS reservations(id TEXT PRIMARY KEY, day TEXT NOT NULL, neurons INTEGER NOT NULL CHECK(neurons>0));`);
  }
  reserve(key, width, height) {
    if (typeof key !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(key)) throw error('CLOUDFLARE_OPERATION_REQUIRED');
    const day = new Date().toISOString().slice(0, 10);
    const neurons = Math.ceil(Math.ceil(width / 512) * Math.ceil(height / 512) * 26.05);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (this.db.prepare('SELECT id FROM reservations WHERE id=?').get(key)) throw error('CLOUDFLARE_OPERATION_RESERVED');
      const used = this.db.prepare('SELECT COALESCE(SUM(neurons),0) AS n FROM reservations WHERE day=?').get(day).n;
      if (used + neurons > this.limit) throw error('CLOUDFLARE_LOCAL_BUDGET');
      this.db.prepare('INSERT INTO reservations VALUES(?,?,?)').run(key, day, neurons);
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
    return neurons;
  }
  async generate(request, { signal, jobId, referenceImage } = {}) {
    const spec = compileGenerationSpec(request);
    if (spec.width < 256 || spec.height < 256 || spec.width > 1024 || spec.height > 1024) throw error('CLOUDFLARE_DIMENSIONS');
    if (referenceImage) {
      if (referenceImage.mimeType !== 'image/png' || !Buffer.isBuffer(referenceImage.bytes) || referenceImage.bytes.length > 1536 * 1024
        || ![referenceImage.width, referenceImage.height].every(n => Number.isInteger(n) && n > 0 && n < 512)) throw error('INVALID_GENERATION_REFERENCE');
      try { validatePng(referenceImage.bytes, referenceImage); } catch { throw error('INVALID_GENERATION_REFERENCE'); }
    }
    if (signal?.aborted) throw error('GENERATION_CANCELLED');
    let credentials;
    try { credentials = await this.credentials(); } catch { throw error('CLOUDFLARE_AUTH_REQUIRED'); }
    if (!credentials || typeof credentials.token !== 'string' || !credentials.token.trim() || /[\r\n]/.test(credentials.token)) throw error('CLOUDFLARE_AUTH_REQUIRED');
    this.reserve(jobId || spec.operationId, spec.width, spec.height);
    const controller = new AbortController();
    const abort = () => controller.abort(); signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, this.timeoutMs);
    try {
      if (signal?.aborted) controller.abort();
      const form = new FormData();
      form.append('prompt', spec.prompt); form.append('width', String(spec.width)); form.append('height', String(spec.height)); form.append('seed', String(spec.seed));
      if (referenceImage) form.append('input_image_0', new Blob([referenceImage.bytes], { type: 'image/png' }), 'drawing.png');
      const response = await this.fetch(`https://api.cloudflare.com/client/v4/accounts/${this.accountId}/ai/run/${MODEL}`, {
        method: 'POST', headers: { Authorization: 'Bearer ' + credentials.token }, body: form, signal: controller.signal, redirect: 'error',
      });
      // Never include response bodies or credentials in thrown errors. Never retry inference automatically.
      if (!response.ok) throw error([401, 403].includes(response.status) ? 'CLOUDFLARE_AUTH_DENIED' : response.status === 429 ? 'CLOUDFLARE_RATE_LIMIT' : 'CLOUDFLARE_PROVIDER_ERROR');
      let size = 0; const chunks = [];
      if (!response.body) throw error('INVALID_GENERATION_IMAGE');
      for await (const chunk of response.body) { size += chunk.length; if (size > 12 * 1024 * 1024) { controller.abort(); throw error('INVALID_GENERATION_IMAGE'); } chunks.push(chunk); }
      const raw = Buffer.concat(chunks);
      let bytes;
      if ((response.headers.get('content-type') || '').includes('json')) {
        let json; try { json = JSON.parse(raw.toString('utf8')); } catch { throw error('INVALID_GENERATION_IMAGE'); }
        const base64 = json.result?.image || json.image;
        if (json.success === false || typeof base64 !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) throw error('INVALID_GENERATION_IMAGE');
        bytes = Buffer.from(base64, 'base64');
      } else bytes = raw;
      if (bytes.length > 8 * 1024 * 1024) throw error('INVALID_GENERATION_IMAGE');
      // Check dimensions before native decoding. Cloudflare may return JPEG instead of PNG.
      if (bytes.subarray(0, 8).toString('hex') === '89504e470d0a1a0a') {
        try { validatePng(bytes, spec); } catch { throw error('INVALID_GENERATION_IMAGE'); }
      } else {
        const dimensions = jpegDimensions(bytes);
        if (!dimensions || dimensions.width !== spec.width || dimensions.height !== spec.height) throw error('INVALID_GENERATION_IMAGE');
        const image = await this.canvas.loadImage(bytes);
        if (image.width !== spec.width || image.height !== spec.height) throw error('INVALID_GENERATION_IMAGE');
        const canvas = this.canvas.createCanvas(spec.width, spec.height); canvas.getContext('2d').drawImage(image, 0, 0);
        bytes = canvas.toBuffer('image/png'); validatePng(bytes, spec);
      }
      if (controller.signal.aborted) throw error(signal?.aborted ? 'GENERATION_CANCELLED' : 'CLOUDFLARE_TIMEOUT');
      return { bytes, mimeType: 'image/png' };
    } catch (e) {
      if (e.code && /^(CLOUDFLARE_|INVALID_GENERATION_IMAGE|GENERATION_CANCELLED)/.test(e.code)) throw e;
      if (controller.signal.aborted) throw error(signal?.aborted ? 'GENERATION_CANCELLED' : 'CLOUDFLARE_TIMEOUT');
      throw error('CLOUDFLARE_NETWORK_ERROR');
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
  }
  close() { this.db.close(); }
}
function jpegDimensions(bytes) {
  if (bytes.length < 4 || bytes[0] !== 255 || bytes[1] !== 216) return null;
  let i = 2;
  while (i + 4 <= bytes.length) {
    if (bytes[i++] !== 255) return null;
    while (bytes[i] === 255) i++;
    const marker = bytes[i++];
    if (marker === 217 || marker === 218) return null;
    if (marker === 1 || marker >= 208 && marker <= 215) continue;
    if (i + 2 > bytes.length) return null;
    const length = bytes.readUInt16BE(i);
    if (length < 2 || i + length > bytes.length) return null;
    if ([192, 193, 194].includes(marker)) return length >= 8 ? { height: bytes.readUInt16BE(i + 3), width: bytes.readUInt16BE(i + 5) } : null;
    i += length;
  }
  return null;
}
module.exports = { CloudflareImageProvider, MODEL };
