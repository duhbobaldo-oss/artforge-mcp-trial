'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const { createMcpEngine } = require('../src');
const { serveStdio } = require('../src/mcp');
const { LocalImageProvider } = require('../src/engine/local-image-provider');

// Owner-only DEV entry. No HTTP listener, production defaults, paid API, or model download.
function main() {
  const modelDir = process.env.ARTFORGE_LOCAL_MODEL_DIR;
  const script = path.resolve(__dirname, '../../generation-worker/worker.py');
  const probe = spawnSync(process.env.ARTFORGE_PYTHON || 'python', ['-I', script, '--model-dir', modelDir || path.resolve(__dirname, '../../models/not-configured'), '--probe'],
    { windowsHide: true, shell: false, encoding: 'utf8', timeout: 30000, maxBuffer: 65536,
      env: { ...process.env, HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', HF_HUB_DISABLE_TELEMETRY: '1' } });
  let readiness;
  try { readiness = JSON.parse(probe.stdout); } catch { readiness = { ready: false, error: 'GENERATION_WORKER_UNAVAILABLE' }; }
  if (process.argv.includes('--probe')) { console.log(JSON.stringify(readiness)); process.exitCode = readiness.ready ? 0 : 2; return; }
  if (process.env.ARTFORGE_GENERATION_DEV !== '1' || !readiness.ready || !modelDir) throw Error('GENERATION_DEV_NOT_READY');
  const url = new URL(process.env.ARTFORGE_TOOL_URL || 'http://invalid');
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.port === '4173' || url.username || url.password) throw Error('GENERATION_DEV_TOOL_REQUIRED');
  const provider = new LocalImageProvider({ python: process.env.ARTFORGE_PYTHON || 'python', modelDir,
    profileHash: process.env.ARTFORGE_LOCAL_MODEL_PROFILE_SHA256 });
  const runtime = path.resolve(__dirname, '../../dev-runtime/generation');
  fs.mkdirSync(runtime, { recursive: true });
  const engine = createMcpEngine({ autoStart: false, toolUrl: url.origin, dataDir: path.join(runtime, 'mcp'), logDir: path.join(runtime, 'logs'),
    generationJobs: { enabled: true, ownerId: 'local-dev-owner', provider } });
  serveStdio(engine, { onClose: () => engine.generationJobs.close(), onShutdown: () => engine.generationJobs.close() });
}
try { main(); } catch { console.error('GENERATION_DEV_NOT_READY'); process.exitCode = 2; }
