'use strict';
const fs = require('node:fs'), path = require('node:path');
const { createEngine } = require('../../drawing-tool/src');
const { createServer } = require('../../drawing-tool/src/server/app');
const { createMcpEngine } = require('../src');
const { serveStdio } = require('../src/mcp');
const { CloudflareImageProvider } = require('../src/engine/cloudflare-image-provider');
const { wranglerCredentials } = require('../src/engine/wrangler-credentials');

// Persistent local DEV MCP entry. Owns its renderer; never connects to production 4173.
async function main() {
  if (process.env.ARTFORGE_CLOUDFLARE_FREE_DEV !== '1') throw Error('CLOUDFLARE_DEV_DISABLED');
  const cli = process.env.ARTFORGE_WRANGLER_CLI;
  if (!cli || !fs.existsSync(cli)) throw Error('WRANGLER_REQUIRED');
  const root = path.resolve(__dirname, '../../dev-runtime/cloudflare-service'); fs.mkdirSync(root, { recursive: true });
  const drawing = createEngine({ docsDir: path.join(root, 'documents'), assetsDir: path.join(root, 'assets'), exportsDir: path.join(root, 'exports') });
  const http = createServer(drawing).server;
  const provider = new CloudflareImageProvider({ accountId: process.env.ARTFORGE_CLOUDFLARE_ACCOUNT_ID, freePlanConfirmed: true,
    credentials: wranglerCredentials(cli), canvasModule: require('../../drawing-tool/node_modules/@napi-rs/canvas'),
    budgetDir: path.resolve(__dirname, '../../dev-runtime/cloudflare-budget') });
  let engine, stopping;
  const stop = () => stopping ||= (async () => {
    await engine?.generationJobs.close(); provider.close();
    await new Promise(resolve => http.close(resolve));
  })();
  try {
    await new Promise((resolve, reject) => { http.once('error', reject); http.listen(0, '127.0.0.1', resolve); });
    const dataDir = path.join(root, 'mcp'); fs.mkdirSync(dataDir, { recursive: true });
    const index = path.join(dataDir, 'references.index.json');
    if (!fs.existsSync(index)) fs.copyFileSync(path.resolve(__dirname, '../data/references.index.json'), index);
    engine = createMcpEngine({ autoStart: false, toolUrl: 'http://127.0.0.1:' + http.address().port, dataDir, logDir: path.join(root, 'logs'),
      generationJobs: { enabled: true, ownerId: 'cloudflare-dev-owner', provider } });
    serveStdio(engine, { onClose: stop, onShutdown: stop });
  } catch (e) { await stop(); throw e; }
}
main().catch(() => { console.error('CLOUDFLARE_DEV_SETUP_FAILED'); process.exitCode = 2; });
