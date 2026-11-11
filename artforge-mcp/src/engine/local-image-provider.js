'use strict';

const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const { error } = require('./generation-spec');

// Owner-configured executable, script and model directory. MCP cannot select a path, URL or executable.
class LocalImageProvider {
  constructor(options) {
    this.id = 'local-flux2-klein-4b';
    this.python = options.python || 'python';
    this.script = path.resolve(options.script || path.join(__dirname, '../../../generation-worker/worker.py'));
    this.modelDir = path.resolve(options.modelDir);
    this.profileHash = options.profileHash;
    if (!/^[a-f0-9]{64}$/.test(this.profileHash || '') || !fs.statSync(this.modelDir).isDirectory()) throw error('GENERATION_MODEL_UNAVAILABLE');
  }
  generate(spec, { signal } = {}) {
    if (signal?.aborted) return Promise.reject(error('GENERATION_CANCELLED'));
    return new Promise((resolve, reject) => {
      const child = spawn(this.python, ['-I', this.script, '--model-dir', this.modelDir], {
        windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', HF_HUB_DISABLE_TELEMETRY: '1' },
      });
      let output = [], size = 0, overflow = false, spawnFailed = false;
      const abort = () => child.kill('SIGKILL');
      signal?.addEventListener('abort', abort, { once: true });
      child.stdout.on('data', bytes => {
        size += bytes.length;
        if (size > 12 * 1024 * 1024) { overflow = true; abort(); } else output.push(bytes);
      });
      // Never forward raw model logs (paths, prompt text, environment) into MCP responses.
      child.stderr.on('data', () => {});
      child.on('error', () => { spawnFailed = true; });
      child.stdin.on('error', () => {});
      child.on('close', code => {
        signal?.removeEventListener('abort', abort);
        if (signal?.aborted) return reject(error('GENERATION_CANCELLED'));
        if (spawnFailed) return reject(error('GENERATION_WORKER_UNAVAILABLE'));
        if (overflow) return reject(error('INVALID_GENERATION_IMAGE'));
        try {
          const result = JSON.parse(Buffer.concat(output).toString('utf8'));
          if (code !== 0 || result.error) throw error(result.error === 'GENERATION_MODEL_UNAVAILABLE' ? result.error : 'GENERATION_WORKER_UNAVAILABLE');
          if (result.mimeType !== 'image/png' || typeof result.base64 !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(result.base64)) throw error('INVALID_GENERATION_IMAGE');
          resolve({ bytes: Buffer.from(result.base64, 'base64'), mimeType: 'image/png' });
        } catch (e) { reject(e.code ? e : error('GENERATION_WORKER_UNAVAILABLE')); }
      });
      child.stdin.end(JSON.stringify({ version: 1, prompt: spec.prompt, width: spec.width, height: spec.height, seed: spec.seed }));
      // Close the listener-registration race; next job starts only after the process actually exits.
      if (signal?.aborted) abort();
    });
  }
}
module.exports = { LocalImageProvider };
