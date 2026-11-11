'use strict';
const path = require('node:path'), fs = require('node:fs');
const { createEngine } = require('../../drawing-tool/src');
const { createServer } = require('../../drawing-tool/src/server/app');
const { createMcpEngine } = require('../src');
const { McpServer } = require('../src/mcp');
const { CloudflareImageProvider } = require('../src/engine/cloudflare-image-provider');
const { wranglerCredentials } = require('../src/engine/wrangler-credentials');

async function main() {
  // Explicit owner gate: no implicit remote inference when ordinary tests or servers run.
  if (process.env.ARTFORGE_CLOUDFLARE_FREE_DEV !== '1') throw Error('DEV_NOT_ENABLED');
  const accountId = process.env.ARTFORGE_CLOUDFLARE_ACCOUNT_ID, cli = process.env.ARTFORGE_WRANGLER_CLI;
  if (!cli || !fs.existsSync(cli)) throw Error('WRANGLER_REQUIRED');
  const root = path.resolve(__dirname, '../../dev-runtime/cloudflare-live-' + Date.now()); fs.mkdirSync(root, { recursive: true });
  const settings = { docsDir: path.join(root, 'documents'), assetsDir: path.join(root, 'assets'), exportsDir: path.join(root, 'exports') };
  const drawing = createEngine(settings), http = createServer(drawing).server;
  const provider = new CloudflareImageProvider({ accountId, freePlanConfirmed: true, credentials: wranglerCredentials(cli),
    canvasModule: require('../../drawing-tool/node_modules/@napi-rs/canvas'), budgetDir: path.resolve(__dirname, '../../dev-runtime/cloudflare-budget') });
  let engine;
  try {
    await new Promise((resolve, reject) => { http.once('error', reject); http.listen(0, '127.0.0.1', resolve); });
    engine = createMcpEngine({ autoStart: false, toolUrl: 'http://127.0.0.1:' + http.address().port, dataDir: path.join(root, 'mcp'), logDir: path.join(root, 'logs'),
      generationJobs: { enabled: true, ownerId: 'cloudflare-dev-owner', provider } });
    const server = new McpServer(engine);
    const spec = { version: 1, operationId: 'first-live-image', prompt: 'A cozy reading room at night, one blue armchair, a wooden side table, warm floor lamp, moonlight through a window, elegant coherent editorial illustration, no text, no lettering', width: 512, height: 512, seed: 7,
      overlays: [{ text: 'ArtForge | تجربة توليد فعلية', x: 20, y: 40, w: 472, h: 45, fontSize: 25, rtl: true, color: '#ffffff' }] };
    const call = (op, params) => server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'artforge_tool_op', arguments: { op, params } } });
    const submitted = await call('generation.jobs.submit', spec); if (submitted.result.isError) throw Error('SUBMIT_FAILED');
    const started = performance.now(); await engine.generationJobs.idle();
    const job = engine.generationJobs.get('cloudflare-dev-owner', submitted.result.structuredContent.jobId);
    if (job.state === 'succeeded') {
      const info = (await createEngine(settings).run('document.info', { documentId: job.result.documentId })).data;
      const preview = await call('generation.jobs.preview', { jobId: job.jobId });
      job.acceptance = { reopened: true, editableTextObjects: info.document.layers.flatMap(l => l.objects).filter(o => o.type === 'text').length,
        mcpImage: !preview.result.isError && preview.result.content.some(c => c.type === 'image'), inspectedVisually: false };
    }
    const evidence = { root, model: '@cf/black-forest-labs/flux-2-klein-4b', source: require('../src/engine/build-info'), elapsedMs: performance.now() - started,
      billingPlanEvidence: 'User screenshot Workers Free current plan, 2026-11-11', estimateNeurons: 27, job };
    fs.writeFileSync(path.join(root, 'evidence.json'), JSON.stringify(evidence, null, 2)); console.log(JSON.stringify(evidence, null, 2));
    if (job.state !== 'succeeded') process.exitCode = 2;
  } finally { await engine?.generationJobs.close(); provider.close(); await new Promise(resolve => http.close(resolve)); }
}
main().catch(() => { console.error('CLOUDFLARE_DEV_SETUP_FAILED'); process.exitCode = 2; });
