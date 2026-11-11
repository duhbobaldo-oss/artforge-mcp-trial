'use strict';

const { createHash, timingSafeEqual } = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { createEngine } = require('./drawing-tool/src');
const { createServer: drawingServer } = require('./drawing-tool/src/server/app');
const { createMcpEngine } = require('./artforge-mcp/src');
const { McpServer } = require('./artforge-mcp/src/mcp');
const { DRAW_OPS } = require('./artforge-mcp/src/engine/scene-spec');

const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT || 4273);
const tokenFile = process.env.ARTFORGE_DEMO_TOKEN_FILE;
const token = tokenFile ? fs.readFileSync(tokenFile, 'utf8').trim() : '';
const limit = 1_600_000;
const localHost = host === '127.0.0.1' || host === '::1';
if ((tokenFile || !localHost) && !/^[A-Za-z0-9_-]{32,128}$/.test(token)) {
  throw new Error('Configure a fresh demo token file before binding to a public interface.');
}
const digest = value => createHash('sha256').update(value).digest();
const authorization = token ? digest(`Bearer ${token}`) : null;
const deniedKeys = new Set(['__proto__', 'constructor', 'prototype', 'path', 'file', 'url', 'src', 'outPath', 'assetId', 'referenceImage']);
const readOps = new Set(['document.info', 'document.preview', 'generation.status']);
const rasterFormats = new Set(['png', 'jpeg', 'webp']);
const quietLogger = { info() {}, warn() {}, error() {}, debug() {} };

function validDimension(value) {
  return Number.isInteger(value) && value >= 1 && value <= 1600;
}

function boundedPlan(plan) {
  if (![plan.canvas?.width, plan.canvas?.height].every(validDimension)) {
    throw new Error('Trial designs are limited to 1600 pixels on each axis.');
  }
  return plan;
}

function inspect(value, depth = 0) {
  if (depth > 20) return false;
  if (!value || typeof value !== 'object') return true;
  return Object.entries(value).every(([key, child]) => !deniedKeys.has(key)
    && (key !== 'documentId' || (typeof child === 'string' && /^doc_[a-z0-9]+$/i.test(child)))
    && inspect(child, depth + 1));
}

function permittedCall({ name, arguments: args = {} } = {}) {
  if (!args || Array.isArray(args) || typeof args !== 'object' || !inspect(args)) return false;
  if (args.format !== undefined && !rasterFormats.has(args.format)) return false;
  if ([args.width, args.height].some(value => value !== undefined && !validDimension(value))) return false;
  if (args.scale !== undefined && (!Number.isFinite(args.scale) || args.scale < 0.1 || args.scale > 2)) return false;
  if (name !== 'artforge_tool_op') return true;
  if (args.op === 'design.plan') return permittedCall({ name: 'artforge_plan_design', arguments: args.params || {} });
  if (args.op === 'batch') {
    const ops = args.ops || args.params?.ops;
    return Array.isArray(ops) && ops.length <= 200 && ops.every(entry => DRAW_OPS.has(entry?.op));
  }
  return !args.ops && !args.params?.ops && (DRAW_OPS.has(args.op) || readOps.has(args.op));
}

function scrub(result) {
  const prefix = __dirname.replaceAll('\\', '/');
  function clean(value) {
    if (typeof value === 'string') return value.replaceAll(__dirname, '[demo]').replaceAll(prefix, '[demo]');
    if (Array.isArray(value)) return value.map(clean);
    if (!value || typeof value !== 'object') return value;
    if (value.type === 'text' && typeof value.text === 'string') {
      try { return { ...value, text: JSON.stringify(clean(JSON.parse(value.text)), null, 2) }; }
      catch { return { ...value, text: clean(value.text) }; }
    }
    return Object.fromEntries(Object.entries(value).filter(([key]) => !['path', 'indexPath', 'codeRoot', 'logDir', 'logFile'].includes(key)).map(([key, item]) => [key, clean(item)]));
  }
  return clean(result);
}

function reply(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(data === undefined ? undefined : JSON.stringify(data));
}

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
}

async function main() {
  const { server: drawing } = drawingServer(createEngine({ root: path.join(__dirname, 'drawing-tool') }));
  await listen(drawing, 0, '127.0.0.1');
  const engine = createMcpEngine({ projectRoot: __dirname, autoStart: false, logger: quietLogger, toolUrl: `http://127.0.0.1:${drawing.address().port}` });
  const { plan, planAsync } = engine;
  engine.plan = input => boundedPlan(plan(input));
  engine.planAsync = async input => boundedPlan(await planAsync(input));
  const mcp = new McpServer(engine, { logger: quietLogger });
  const rawTool = mcp.tools.find(tool => tool.name === 'artforge_tool_op');
  rawTool.description = 'Draw or edit a demo document with the documented primitive operations, optionally in a batch. Read document info or preview. Host-file operations and custom providers are unavailable.';
  const exportTool = mcp.tools.find(tool => tool.name === 'artforge_export');
  exportTool.description = 'Export a demo document to PNG, JPEG or WebP and return a preview.';
  exportTool.inputSchema.properties.format.enum = [...rasterFormats];
  let busy = false;

  const app = http.createServer(async (req, res) => {
    if (req.url === '/health' && req.method === 'GET') return reply(res, 200, { ok: true });
    if (req.url !== '/mcp') return reply(res, 404, { error: 'Not found' });
    if (req.headers.origin) return reply(res, 403, { error: 'Browser cross-origin access is unavailable' });
    if (authorization && !timingSafeEqual(digest(req.headers.authorization || ''), authorization)) {
      res.setHeader('WWW-Authenticate', 'Bearer');
      return reply(res, 401, { error: 'Authorization required' });
    }
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return reply(res, 405, { error: 'Use POST' });
    }
    if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) return reply(res, 415, { error: 'Use application/json' });
    if (Number(req.headers['content-length']) > limit) return reply(res, 413, { error: 'Request exceeds demo limit' });
    if (busy) return reply(res, 429, { error: 'One request at a time per trial instance' });
    busy = true;
    try {
      const chunks = [];
      let bytes = 0;
      for await (const chunk of req.iterator({ destroyOnReturn: false })) {
        bytes += chunk.length;
        if (bytes > limit) {
          res.setHeader('Connection', 'close');
          return reply(res, 413, { error: 'Request exceeds demo limit' });
        }
        chunks.push(chunk);
      }
      let message;
      try { message = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { return reply(res, 400, McpServer.error(null, -32700, 'Invalid JSON')); }
      if (!message || typeof message !== 'object' || Array.isArray(message)) return reply(res, 400, McpServer.error(null, -32600, 'Expected one JSON-RPC message'));
      if (message.method === 'tools/call' && !permittedCall(message.params)) {
        return reply(res, 200, McpServer.error(message.id, -32602, 'This operation or parameter is unavailable in the customer trial.'));
      }
      const result = await mcp.handle(message);
      return result ? reply(res, 200, scrub(result)) : reply(res, 202);
    } catch {
      if (!res.destroyed) reply(res, 500, { error: 'Demo request failed' });
    } finally { busy = false; }
  });
  app.requestTimeout = 20_000;
  app.headersTimeout = 10_000;
  await listen(app, port, host);
  process.stdout.write(`ArtForge customer trial listening on port ${app.address().port}\n`);
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => app.close(() => drawing.close()));
}

main().catch(() => { process.stderr.write('ArtForge customer trial failed to start.\n'); process.exit(1); });
