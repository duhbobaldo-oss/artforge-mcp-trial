'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
let paletteCache = null;
const { URL } = require('node:url');
const { buildCoreBundle } = require('./bundle');
const { OpError } = require('../core/errors');
const { renderPreview } = require('../core/exporter');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ttf': 'font/ttf',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const MAX_BODY_BYTES = 8 * 1024 * 1024;

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  });
  res.end(body);
}

function sendFile(res, filePath, options) {
  const opts = options || {};
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    sendJson(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: `not found: ${path.basename(filePath)}` } });
    return;
  }
  if (!stat.isFile()) {
    sendJson(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: 'not a file' } });
    return;
  }
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
    'Content-Length': stat.size,
    'Cache-Control': opts.cache || 'no-cache',
    'Access-Control-Allow-Origin': '*',
  });
  fs.createReadStream(filePath).pipe(res);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new OpError('BODY_TOO_LARGE', `request body exceeds ${MAX_BODY_BYTES} bytes`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(new OpError('INVALID_JSON', `request body is not valid JSON: ${error.message}`));
      }
    });
    req.on('error', reject);
  });
}

function safeJoin(baseDir, requestPath) {
  const decoded = decodeURIComponent(requestPath).replace(/^[/\\]+/, '');
  const resolved = path.resolve(baseDir, decoded);
  const base = path.resolve(baseDir);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) return null;
  return resolved;
}

/**
 * ArtForge HTTP server: REST operations API, live event stream, static editor UI
 * and authoritative engine previews.
 */
function createServer(engine) {
  const uiDir = path.join(engine.ctx.root, 'src', 'ui');
  const coreDir = path.join(engine.ctx.root, 'src', 'core');
  const clients = new Set();
  const log = [];

  const record = (entry) => {
    log.push(Object.assign({ at: new Date().toISOString() }, entry));
    if (log.length > 300) log.shift();
    const payload = `data: ${JSON.stringify(entry)}\n\n`;
    for (const client of clients) {
      if (client.docId && entry.documentId && client.docId !== entry.documentId) continue;
      try { client.res.write(payload); } catch { clients.delete(client); }
    }
  };

  engine.store.on('change', (event) => {
    record({ type: 'document-change', documentId: event.docId, op: event.op, revision: event.revision });
  });

  const execute = async (op, params) => {
    try {
      const result = await engine.run(op, params || {});
      record({
        type: 'operation',
        op,
        ok: true,
        documentId: result.data && result.data.documentId,
        revision: result.data && result.data.revision,
        durationMs: result.durationMs,
      });
      return result;
    } catch (error) {
      const normalized = error instanceof OpError
        ? error.toJSON()
        : { code: 'INTERNAL_ERROR', message: error.message, details: null };
      record({ type: 'operation', op, ok: false, error: normalized.code, message: normalized.message });
      const wrapped = new Error(normalized.message);
      wrapped.artforge = normalized;
      throw wrapped;
    }
  };

  const server = http.createServer(async (req, res) => {
    const traceId = req.headers['x-artforge-trace-id'];
    if (typeof traceId === 'string' && /^[a-zA-Z0-9_-]{1,96}$/.test(traceId)) res.setHeader('X-ArtForge-Trace-Id', traceId);
    const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
    const pathname = url.pathname;
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      });
      return res.end();
    }

    try {
      if (pathname === '/api/health') {
        return sendJson(res, 200, {
          ok: true,
          name: 'artforge-drawing-tool',
          version: engine.version,
          uptime: Math.round(process.uptime()),
        });
      }
      if (pathname === '/api/capabilities') return sendJson(res, 200, await execute('system.capabilities', {}));
      const materialMatch=/^\/api\/materials\/(mat-img-[a-f0-9]{64})$/.exec(pathname);
      if(materialMatch && req.method==='GET') {
        const item=require('../core/material-assets').getMaterialAssets(engine.ctx).read(materialMatch[1]);
        res.writeHead(200,{'Content-Type':item.mime,'Content-Length':item.buffer.length,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});return res.end(item.buffer);
      }
      if (pathname === '/api/stats') return sendJson(res, 200, await execute('system.stats', {}));
      if (pathname === '/api/ops') {
        return sendJson(res, 200, { ok: true, op: 'system.ops', data: { operations: engine.listOps() } });
      }
      if (pathname === '/api/palettes') {
        // Colour library for the editor's picker: the reference palettes extracted from the project's
        // Color_Scheme images (artforge-mcp/data/references.index.json). Colours only; read-only.
        if (!paletteCache) {
          const file = path.join(engine.ctx.root, '..', 'artforge-mcp', 'data', 'references.index.json');
          let list = [];
          try {
            const index = JSON.parse(fs.readFileSync(file, 'utf8'));
            list = (index.palettes || []).map((p) => ({ id: p.id, name: String(p.file || p.id).replace(/\.[a-z]+$/i, ''), colors: (p.colors || []).map((c) => (typeof c === 'string' ? c : c.hex)).filter((c) => /^#[0-9a-f]{6}$/i.test(String(c))) }))
              .filter((p) => p.colors.length);
          } catch { list = []; }
          paletteCache = list;
        }
        return sendJson(res, 200, { ok: true, op: 'palette.list', data: { palettes: paletteCache } });
      }
      if (pathname === '/api/fonts') {
        return sendJson(res, 200, await execute('font.list', {
          arabicOnly: url.searchParams.get('arabicOnly') === '1',
          limit: 600,
        }));
      }
      if (pathname === '/api/log') {
        return sendJson(res, 200, { ok: true, op: 'system.log', data: { entries: log.slice(-120).reverse() } });
      }
      if (pathname === '/api/documents' && req.method === 'GET') {
        return sendJson(res, 200, await execute('document.list', {}));
      }
      const docMatch = /^\/api\/documents\/([^/]+)$/.exec(pathname);
      if (docMatch && req.method === 'GET') {
        return sendJson(res, 200, await execute('document.info', { documentId: docMatch[1] }));
      }
      const previewMatch = /^\/api\/documents\/([^/]+)\/preview\.png$/.exec(pathname);
      if (previewMatch) {
        const info = await execute('document.info', { documentId: previewMatch[1] });
        const images = Object.assign(await engine.assets.loadForDocument(info.data.document),await require('../core/material-assets').getMaterialAssets(engine.ctx).resolveImages(info.data.document));
        const preview = renderPreview(info.data.document, {
          images,
          maxWidth: Number(url.searchParams.get('maxWidth') || 1000),
          time: Number(url.searchParams.get('time') || 0),
          applyAnimation: url.searchParams.get('static') !== '1',
        });
        res.writeHead(200, {
          'Content-Type': 'image/png',
          'Content-Length': preview.buffer.length,
          'Cache-Control': 'no-store',
          'Access-Control-Allow-Origin': '*',
          'X-ArtForge-Revision': String(info.data.revision),
          'X-ArtForge-Sha256': preview.sha256,
        });
        return res.end(preview.buffer);
      }
      if (pathname === '/api/events') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
          'Access-Control-Allow-Origin': '*',
        });
        res.write(`data: ${JSON.stringify({ type: 'hello', at: new Date().toISOString() })}\n\n`);
        const client = { res, docId: url.searchParams.get('documentId') };
        clients.add(client);
        req.on('close', () => clients.delete(client));
        return undefined;
      }
      if (pathname === '/api/op' && req.method === 'POST') {
        const body = await readBody(req);
        const controller=new AbortController();
        const deadline=Math.min(Date.now()+120000,Number(req.headers['x-artforge-deadline'])||Date.now()+120000);
        const timer=setTimeout(()=>controller.abort(),Math.max(1,deadline-Date.now()));
        res.once('close',()=>{if(!res.writableEnded)controller.abort();});
        try { return sendJson(res,200,await require('../core/operation-context').context.run({signal:controller.signal,deadline},()=>execute(body.op,body.params||{}))); }
        finally {clearTimeout(timer);}
      }
      if (pathname === '/api/batch' && req.method === 'POST') {
        const body = await readBody(req);
        require('../core/input-contract').inspect(body);
        if (!Array.isArray(body.ops) || body.ops.length>2000) return sendJson(res,400,{ok:false,error:{code:'INVALID_BATCH',message:'ops must be an array of at most2000 operations'}});
        const controller=new AbortController(),deadline=Math.min(Date.now()+120000,Number(req.headers['x-artforge-deadline'])||Date.now()+120000);
        const timer=setTimeout(()=>controller.abort(),Math.max(1,deadline-Date.now()));res.once('close',()=>{if(!res.writableEnded)controller.abort();});
        try{return await require('../core/operation-context').context.run({signal:controller.signal,deadline},async()=>{
          // atomic:true is all-or-nothing, so it runs as the batch op (rollback on failure) rather than step by step.
          if(body.atomic===true){try{const result=await execute('batch',{ops:body.ops,atomic:true,expectedRevisions:body.expectedRevisions});return sendJson(res,200,{ok:true,atomic:true,results:result.data.results.map(r=>({ok:true,op:r.op,data:r.data}))});}
            catch(error){if(controller.signal.aborted)throw error;return sendJson(res,200,{ok:false,atomic:true,rolledBack:true,results:[],error:error.artforge||{code:error.code||'INTERNAL_ERROR',message:error.message,details:error.details}});}}
          const results=[];
          for(const item of body.ops){await new Promise(resolve=>setImmediate(resolve));require('../core/operation-context').checkpoint();
            try{const result=await execute(item.op,item.params||{});results.push({ok:true,op:item.op,data:result.data});}
            catch(error){if(controller.signal.aborted)throw error;results.push({ok:false,op:item.op,error:error.artforge||{code:error.code||'INTERNAL_ERROR',message:error.message}});if(body.stopOnError!==false)break;}
          }
          return sendJson(res,200,{ok:results.every(r=>r.ok),results});
        });}finally{clearTimeout(timer);}
      }
      if (pathname === '/core.bundle.js') {
        res.writeHead(200, {
          'Content-Type': 'text/javascript; charset=utf-8',
          'Cache-Control': 'no-store',
          'Access-Control-Allow-Origin': '*',
        });
        return res.end(buildCoreBundle(coreDir));
      }

      if (req.method === 'GET') {
        if (pathname === '/' || pathname === '/index.html') return sendFile(res, path.join(uiDir, 'index.html'));
        if (pathname.startsWith('/ui/')) {
          const target = safeJoin(uiDir, pathname.slice(4));
          if (!target) return sendJson(res, 403, { ok: false, error: { code: 'FORBIDDEN', message: 'invalid path' } });
          return sendFile(res, target);
        }
        if (pathname.startsWith('/fonts/')) {
          const target = safeJoin(path.join(engine.ctx.root, 'fonts'), pathname.slice(7));
          if (!target || !target.toLowerCase().endsWith('.ttf')) {
            return sendJson(res, 403, { ok: false, error: { code: 'FORBIDDEN', message: 'only bundled .ttf fonts are served' } });
          }
          return sendFile(res, target, { cache: 'public, max-age=86400' });
        }
        if (pathname.startsWith('/assets/')) {
          const target = safeJoin(engine.ctx.assetsDir, pathname.slice(8));
          if (!target) return sendJson(res, 403, { ok: false, error: { code: 'FORBIDDEN', message: 'invalid path' } });
          return sendFile(res, target, { cache: 'public, max-age=3600' });
        }
        if (pathname.startsWith('/exports/')) {
          const target = safeJoin(engine.ctx.exportsDir, pathname.slice(9));
          if (!target) return sendJson(res, 403, { ok: false, error: { code: 'FORBIDDEN', message: 'invalid path' } });
          return sendFile(res, target, { cache: 'no-cache' });
        }
      }

      return sendJson(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: `no route for ${req.method} ${pathname}` } });
    } catch (error) {
      const artforge = error.artforge || { code: /^[A-Z_]{3,60}$/.test(error.code||'') ? error.code : 'INTERNAL_ERROR', message: error.message, details: error.details || null };
      const notFound = ['NOT_FOUND', 'FILE_NOT_FOUND', 'DOCUMENT_NOT_FOUND', 'OBJECT_NOT_FOUND', 'LAYER_NOT_FOUND'].includes(artforge.code);
      const status = notFound ? 404 : (artforge.code === 'INTERNAL_ERROR' ? 500 : 400);
      return sendJson(res, status, { ok: false, error: artforge });
    }
  });

  server.on('close', () => {
    for (const client of clients) {
      try { client.res.end(); } catch { /* already closed */ }
    }
    clients.clear();
  });

  return { server, clients, log };
}

module.exports = { createServer };

