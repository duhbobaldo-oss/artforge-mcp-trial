'use strict';

const crypto = require('node:crypto');
const fail = code => Object.assign(new Error(code), { code });
const delivered = result => ({ ...result, bytes: Buffer.from(result.bytes), source: { ...result.source } });

// No provider SDK, HTTP client, credential store, or automatic engine selection lives here.
// Providers are injected by the application owner, never registered by an MCP request.
class GenerativeImageAdapter {
  constructor(options = {}) {
    this.enabled = options.enabled === true;
    this.provider = options.provider || null;
    if (this.provider && !/^[A-Za-z0-9_-]{1,64}$/.test(this.provider.id || '')) throw fail('INVALID_GENERATION_PROVIDER');
    this.validatePng = options.validatePng;
    this.timeoutMs = Math.max(1, Math.min(120000, options.timeoutMs || 30000));
    this.receipts = new Map();
  }

  status() {
    return { enabled: this.enabled, configured: Boolean(this.provider), provider: this.provider ? this.provider.id : null,
      automaticRouting: false, retries: 0, idempotency: 'process-local; maximum 32 receipts; no cross-restart guarantee' };
  }

  async generate(request, { signal } = {}) {
    if (!this.enabled) throw fail('GENERATION_DISABLED');
    if (!this.provider || typeof this.provider.generate !== 'function' || typeof this.validatePng !== 'function') throw fail('GENERATION_UNCONFIGURED');
    if (!request || typeof request.prompt !== 'string' || !request.prompt.trim() || request.prompt.length > 6000
      || !/^[A-Za-z0-9_-]{1,96}$/.test(request.operationId || '')
      || !Number.isInteger(request.width) || !Number.isInteger(request.height)
      || request.width < 1 || request.height < 1 || request.width > 4096 || request.height > 4096) throw fail('INVALID_GENERATION_REQUEST');
    if (signal?.aborted) throw fail('GENERATION_CANCELLED');
    const input = Object.freeze({ prompt: request.prompt, width: request.width, height: request.height });
    const fingerprint = crypto.createHash('sha256').update(JSON.stringify(input)).digest('hex');
    const existing = this.receipts.get(request.operationId);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw fail('GENERATION_OPERATION_CONFLICT');
      return delivered(await existing.promise);
    }
    // Fail closed rather than evicting a receipt and accidentally repeating a provider side effect.
    if (this.receipts.size >= 32) throw fail('GENERATION_RECEIPT_LIMIT');
    const promise = this.execute(input, request.operationId, signal);
    this.receipts.set(request.operationId, { fingerprint, promise });
    return delivered(await promise);
  }

  async execute(input, operationId, signal) {
    const controller = new AbortController();
    let timer;
    let cancel;
    const stopped = new Promise((resolve, reject) => {
      cancel = () => { controller.abort(); reject(fail('GENERATION_CANCELLED')); };
      signal?.addEventListener('abort', cancel, { once: true });
      timer = setTimeout(() => { controller.abort(); reject(fail('GENERATION_TIMEOUT')); }, this.timeoutMs);
    });
    try {
      return await Promise.race([stopped, (async () => {
        let result;
        try { result = await this.provider.generate(input, { operationId, signal: controller.signal }); }
        catch { throw fail('GENERATION_PROVIDER_ERROR'); }
        if (controller.signal.aborted) throw fail('GENERATION_CANCELLED');
        const bytes = result?.bytes;
        if (result?.mimeType !== 'image/png' || !Buffer.isBuffer(bytes) || bytes.length < 33 || bytes.length > 8 * 1024 * 1024
          || bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a'
          || bytes.toString('ascii', 12, 16) !== 'IHDR'
          || bytes.readUInt32BE(16) !== input.width || bytes.readUInt32BE(20) !== input.height) throw fail('INVALID_GENERATION_IMAGE');
        try { await this.validatePng(bytes, input); } catch { throw fail('INVALID_GENERATION_IMAGE'); }
        return { bytes: Buffer.from(bytes), mimeType: 'image/png', width: input.width, height: input.height,
          sha256: crypto.createHash('sha256').update(bytes).digest('hex'), source: { kind: 'generative-provider', provider: this.provider.id } };
      })()]);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
    }
  }
}

module.exports = { GenerativeImageAdapter };
