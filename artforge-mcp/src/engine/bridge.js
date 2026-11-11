'use strict';

const { context: traceContext } = require('./trace-context');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { createLogger } = require('./log');

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function envFlag(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  return /^(1|true|yes|on)$/i.test(String(value));
}

/** fetch with a hard deadline; the bridge must never hang a caller forever. */
async function fetchWithTimeout(url, init, timeoutMs, label) {
  const controller = new AbortController();
  const active = traceContext.getStore();
  if(active?.signal?.aborted) throw active.signal.reason;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  try {
    const headers = new Headers((init || {}).headers);
    if (active) headers.set('X-ArtForge-Trace-Id', active.traceId);
    if(active?.deadline)headers.set('X-ArtForge-Deadline',String(active.deadline));
    const signal=active?.signal?AbortSignal.any([active.signal,controller.signal]):controller.signal;
    const response = await fetch(url, Object.assign({}, init || {}, { headers, signal }));
    // The deadline covers the body as well as the response headers.
    const bytes = await response.arrayBuffer();
    const buffered = new Response(bytes, { status: response.status, statusText: response.statusText, headers: response.headers });
    const elapsedMs = Date.now() - started;
    if (active) active.trace.event('drawing-http', { operation: label || 'request', elapsedMs, status: response.status, responseBytes: bytes.byteLength });
    return { response: buffered, elapsedMs };
  } catch (error) {
    if(active?.signal?.aborted)throw active.signal.reason;
    const aborted = error.name === 'AbortError';
    const wrapped = new Error(aborted
      ? `${label || 'request'} timed out after ${timeoutMs}ms (${url})`
      : `${label || 'request'} failed: ${error.message} (${url})`);
    wrapped.code = aborted ? 'TOOL_TIMEOUT' : 'TOOL_UNREACHABLE';
    wrapped.cause = error.message;
    throw wrapped;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Bridge to the ArtForge drawing tool (POST /api/op).
 *
 * تشغيليًا: الجسر لا يملك عمر الأداة. إن كانت الأداة خدمة مستقلة (المسار الموصى به)
 * فالجسر يتصل بها فقط. التشغيل التلقائي متاح، لكنه لا يقتل الأداة عند خروج خادم MCP،
 * لأن ربط عمر الأداة بعمر الجلسة كان يُسقط كل شيء عند أول انقطاع.
 */
class ToolBridge {
  constructor(options) {
    const opts = options || {};
    this.baseUrl = (opts.baseUrl || process.env.ARTFORGE_TOOL_URL || 'http://127.0.0.1:4173').replace(/\/+$/, '');
    this.entryPath = opts.entryPath;
    this.autoStart = opts.autoStart !== undefined
      ? opts.autoStart
      : envFlag(process.env.ARTFORGE_TOOL_AUTOSTART, true);
    this.startTimeoutMs = Number(opts.startTimeoutMs || process.env.ARTFORGE_TOOL_START_TIMEOUT_MS || 25000);
    this.requestTimeoutMs = Number(opts.requestTimeoutMs || process.env.ARTFORGE_TOOL_TIMEOUT_MS || 20000);
    this.killToolOnExit = envFlag(process.env.ARTFORGE_KILL_TOOL_ON_EXIT, false);
    this.log = opts.logger || createLogger('bridge', { dir: opts.logDir });
    this.child = null;
    this.childPid = null;
    this.ensurePromise = null;
    this.lastStartError = null;
    this.healthyUntil = 0;
    this.healthTtlMs = opts.healthTtlMs === undefined ? 1000 : Math.max(0, Number(opts.healthTtlMs));
    this.metrics = { healthRequests: 0, operationRequests: 0 };

    if (this.killToolOnExit) {
      process.on('exit', () => {
        try { if (this.child && !this.child.killed) this.child.kill(); } catch { /* ignore */ }
      });
    }
  }

  async health(timeoutMs) {
    this.metrics.healthRequests += 1;
    try {
      const { response } = await fetchWithTimeout(
        `${this.baseUrl}/api/health`,
        { method: 'GET' },
        timeoutMs || 2000,
        'health',
      );
      if (!response.ok) { this.healthyUntil = 0; return { ok: false, status: response.status }; }
      const result = Object.assign({ ok: true }, await response.json());
      this.healthyUntil = result.ok ? Date.now() + this.healthTtlMs : 0;
      return result;
    } catch (error) {
      this.healthyUntil = 0;
      return { ok: false, error: error.message, code: error.code || null };
    }
  }

  /**
   * Start the tool once. Concurrent callers share one promise, so simultaneous
   * tool calls can no longer race into two competing servers on the same port.
   */
  async ensure(timeoutMs) {
    if (Date.now() < this.healthyUntil) return { started: false, cached: true };
    const current = await this.health();
    if (current.ok) return { started: false, health: current };
    if (this.ensurePromise) return this.ensurePromise;
    this.ensurePromise = this.#start(timeoutMs).finally(() => { this.ensurePromise = null; });
    return this.ensurePromise;
  }

  async #start(timeoutMs) {
    if (!this.autoStart) {
      const error = new Error(
        `drawing tool is not reachable at ${this.baseUrl} and autoStart is disabled. `
        + 'Start it with ops/start-drawing-tool.ps1 (or set ARTFORGE_TOOL_AUTOSTART=1).',
      );
      error.code = 'TOOL_UNAVAILABLE';
      this.log.error('tool-unavailable', { baseUrl: this.baseUrl });
      throw error;
    }

    const port = Number(new URL(this.baseUrl).port || 4173);
    const outFile = path.join(this.log.dir, 'drawing-tool.log');
    let out = null;
    try {
      out = fs.openSync(outFile, 'a');
      fs.writeSync(out, `\n=== spawn ${new Date().toISOString()} port=${port} entry=${this.entryPath} ===\n`);
    } catch { out = null; }

    this.log.info('tool-spawn', { entryPath: this.entryPath, port, outFile });
    this.child = spawn(process.execPath, [this.entryPath, 'serve', '--port', String(port)], {
      detached: true,
      stdio: ['ignore', out === null ? 'ignore' : out, out === null ? 'ignore' : out],
      windowsHide: true,
      env: Object.assign({}, process.env, { ARTFORGE_PORT: String(port) }),
    });
    this.childPid = this.child.pid;
    this.child.unref();
    if (out !== null) { try { fs.closeSync(out); } catch { /* ignore */ } }
    this.child.on('error', (error) => {
      this.lastStartError = error.message;
      this.log.error('tool-spawn-error', { message: error.message });
    });
    this.child.on('exit', (code, signal) => {
      this.log.warn('tool-exited', { pid: this.childPid, code, signal });
    });

    const deadline = Date.now() + (timeoutMs || this.startTimeoutMs);
    while (Date.now() < deadline) {
      await delay(250);
      const health = await this.health();
      if (health.ok) {
        this.log.info('tool-ready', { pid: this.childPid });
        return { started: true, health };
      }
    }
    const error = new Error(
      `drawing tool did not start within ${timeoutMs || this.startTimeoutMs}ms at ${this.baseUrl}`
      + `${this.lastStartError ? ` (${this.lastStartError})` : ''}. See ${outFile}`,
    );
    error.code = 'TOOL_START_TIMEOUT';
    this.log.error('tool-start-timeout', { baseUrl: this.baseUrl, logFile: outFile });
    throw error;
  }

  async call(op, params, timeoutMs) {
    const active=traceContext.getStore();
    if(active?.signal?.aborted)throw active.signal.reason;
    await this.ensure();
    this.metrics.operationRequests += 1;
    const { response, elapsedMs } = await fetchWithTimeout(
      `${this.baseUrl}/api/op`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ op, params: params || {} }),
      },
      timeoutMs || this.requestTimeoutMs,
      `op ${op}`,
    ).catch((error) => { this.healthyUntil = 0; throw error; });
    let json;
    try {
      json = await response.json();
    } catch (error) {
      const wrapped = new Error(`op ${op} returned a non-JSON response (${response.status})`);
      wrapped.code = 'TOOL_BAD_RESPONSE';
      wrapped.op = op;
      throw wrapped;
    }
    if (!json || typeof json !== 'object' || typeof json.ok !== 'boolean' || (!json.ok && (!json.error || typeof json.error.code !== 'string'))) {
      this.healthyUntil = 0;
      const error = new Error(`op ${op} returned an invalid response envelope`); error.code = 'TOOL_BAD_RESPONSE'; throw error;
    }
    if (!response.ok || !json.ok) {
      const detail = json.error || { code: 'TOOL_HTTP_ERROR', message: `HTTP ${response.status}` };
      const error = new Error(`${detail.code}: ${detail.message}`);
      error.code = detail.code;
      error.details = detail.details;
      error.op = op;
      throw error;
    }
    return Object.assign({}, json, { elapsedMs });
  }

  /** Authoritative PNG preview rendered by the tool's Node/Skia renderer. */
  async previewPng(documentId, maxWidth) {
    await this.ensure();
    const width = Math.max(120, Math.min(1600, Number(maxWidth) || 900));
    const { response } = await fetchWithTimeout(
      `${this.baseUrl}/api/documents/${encodeURIComponent(documentId)}/preview.png?maxWidth=${width}&static=1`,
      { method: 'GET' },
      this.requestTimeoutMs,
      'preview.png',
    );
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`preview failed (${response.status}): ${text.slice(0, 200)}`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    return {
      buffer,
      base64: buffer.toString('base64'),
      revision: response.headers.get('x-artforge-revision'),
      sha256: response.headers.get('x-artforge-sha256'),
      bytes: buffer.length,
    };
  }

  async capabilities() {
    await this.ensure();
    const { response } = await fetchWithTimeout(`${this.baseUrl}/api/capabilities`, { method: 'GET' }, this.requestTimeoutMs, 'capabilities');
    const json = await response.json();
    if (!json.ok) throw new Error(json.error ? json.error.message : 'capabilities failed');
    return json.data;
  }

  async documents() {
    await this.ensure();
    const { response } = await fetchWithTimeout(`${this.baseUrl}/api/documents`, { method: 'GET' }, this.requestTimeoutMs, 'documents');
    const json = await response.json();
    if (!json.ok) throw new Error('cannot list documents');
    return json.data.documents;
  }
}

module.exports = { ToolBridge, fetchWithTimeout };
