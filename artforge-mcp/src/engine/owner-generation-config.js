'use strict';
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
// Optional owner-controlled file. It is never written or enabled by an MCP operation.
function ownerGenerationConfig(dataDir, paths, dependencies = {}) {
  const file = path.join(dataDir, 'owner-generation.json');
  if (!fs.existsSync(file)) return {};
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (cfg.enabled !== true) return {};
  if (cfg.provider !== 'cloudflare-flux2-klein-4b' || cfg.freePlanConfirmed !== true
    || !/^[a-f0-9]{32}$/.test(cfg.accountId || '') || !path.isAbsolute(cfg.wranglerCli || '')
    || !fs.existsSync(cfg.wranglerCli)) throw Error('INVALID_OWNER_GENERATION_CONFIG');
  const Provider = dependencies.Provider || require('./cloudflare-image-provider').CloudflareImageProvider;
  const provider = new Provider({ accountId: cfg.accountId, freePlanConfirmed: true,
    credentials: (dependencies.credentials || require('./wrangler-credentials').wranglerCredentials)(cfg.wranglerCli),
    canvasModule: dependencies.canvas || require('./paths').loadCanvasModule(paths.drawingTool),
    budgetDir: path.join(dataDir, 'cloudflare-budget') });
  return { enabled: true, timeoutMs: 100000, provider: { id: provider.id, supportsReferenceImage: true,
    generate: (input, context) => provider.generate({version:1, prompt:input.prompt, width:input.width, height:input.height, seed:7, operationId:context.operationId},
      {signal:context.signal, referenceImage:input.referenceImage, jobId:'owner_'+crypto.createHash('sha256').update(context.operationId).digest('hex')}) } };
}
module.exports = { ownerGenerationConfig };
