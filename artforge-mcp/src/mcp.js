'use strict';

const http = require('node:http');
const readline = require('node:readline');
const path = require('node:path');
const { buildTools, WIDGET_URI } = require('./tools');

const WIDGET_MIME = 'text/html;profile=mcp-app';
/**
 * عرض الصورة داخل ChatGPT: كتلة image في نتيجة الأداة تصل إلى النموذج فقط ولا تُعرض للمستخدم.
 * العرض يتطلب مورد واجهة مرتبطًا بالأداة؛ يقرأ الصورة من _meta.artforge.previewDataUrl.
 */
const WIDGET_HTML = `<!doctype html><html><head><meta charset="utf-8">
<style>body{margin:0;font-family:system-ui,sans-serif}img{display:block;max-width:100%;height:auto;margin:0 auto}
p{margin:6px 8px;font-size:12px;color:#666}</style></head><body><div id="root"><p>…</p></div>
<script>
(function(){
  var root=document.getElementById('root');
  function pick(m){if(!m)return null;var a=m.artforge||(m._meta&&m._meta.artforge);return a&&a.previewDataUrl?a:null;}
  function render(a){if(!a)return false;root.innerHTML='';var img=new Image();img.alt='ArtForge design';img.src=a.previewDataUrl;root.appendChild(img);
    var e=a.exported||{};if(e.width){var p=document.createElement('p');p.textContent=e.width+'×'+e.height+' '+(e.format||'')+(e.path?' — '+e.path:'');root.appendChild(p);}return true;}
  function fromOpenAI(){var o=window.openai;return !!(o&&render(pick(o.toolResponseMetadata)));}
  if(!fromOpenAI()){window.addEventListener('openai:set_globals',fromOpenAI);}
  window.addEventListener('message',function(ev){var d=ev.data;if(d&&d.method==='ui/notifications/tool-result'&&d.params)render(pick(d.params._meta));});
})();
</script></body></html>`;
const { createLogger } = require('./engine/log');
const { context: traceContext, safeTraceId } = require('./engine/trace-context');
const { Trace, newTraceId } = require('./engine/trace');

const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER_INFO = { name: 'artforge-ai-mcp', version: require('./engine/build-info').version };
const CALL_TIMEOUT_MS = Number(process.env.ARTFORGE_MCP_CALL_TIMEOUT_MS || 120000);
/** حدود الاستجابة: تحمي النفق من الاستجابات الضخمة وتحمي العميل من التسلسل المكسور. */
const MAX_TEXT_FIELD_CHARS = Number(process.env.ARTFORGE_MAX_TEXT_FIELD_CHARS || 6000);
const MAX_IMAGE_B64_CHARS = Number(process.env.ARTFORGE_MAX_IMAGE_B64_CHARS || 300000); // ≈225KB PNG
const MAX_CONTENT_TEXT_CHARS = Number(process.env.ARTFORGE_MAX_CONTENT_TEXT_CHARS || 200000);

/**
 * تعقيم الحمولة: استبدال السلاسل الطويلة (base64، نصوص ضخمة) بمؤشرات قابلة للقراءة
 * مع إبقاء JSON صالحًا دائمًا. هذا هو خط الدفاع ضد استجابة تصل كـ {}.
 */
function sanitizeValue(value, maxField) {
  if (typeof value === 'string') {
    if (value.length <= maxField) return value;
    const crypto = require('node:crypto');
    return {
      omitted: true,
      reason: 'field-too-large',
      chars: value.length,
      sha256: crypto.createHash('sha256').update(value).digest('hex').slice(0, 16),
      head: value.slice(0, 160),
    };
  }
  if (Array.isArray(value)) return value.map((entry) => sanitizeValue(entry, maxField));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, entry] of Object.entries(value)) out[key] = sanitizeValue(entry, maxField);
    return out;
  }
  return value;
}

/**
 * سقف زمني إجباري لكل أداة. بدونه، أي تعليق في الأداة يصل إلى العميل كـ"timeout"
 * ثم تنتهي الجلسة؛ الآن تنتهي بخطأ منظّم ويبقى الخادم حيًّا.
 */
function withTimeout(promise, ms, label) {
  let timer = null;
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`${label} exceeded ${ms}ms; the server stayed alive and returned this error instead of hanging`);
      error.code = 'TOOL_CALL_TIMEOUT';
      reject(error);
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** JSON-RPC 2.0 + MCP message handling, transport independent. */
class McpServer {
  constructor(engine, options) {
    const opts = options || {};
    this.engine = engine;
    this.logger = opts.logger || (engine && engine.logger) || createLogger('mcp', {});
    this.callTimeoutMs = Number(opts.callTimeoutMs || CALL_TIMEOUT_MS);
    this.tools = buildTools(engine);
    this.toolMap = new Map(this.tools.map((tool) => [tool.name, tool]));
    this.initialized = false;
    this.activeCalls = new Map();
    this.traceFile = opts.traceFile
      || (engine && engine.logger && engine.logger.dir ? path.join(engine.logger.dir, 'trace.jsonl') : null);
  }

  listTools() {
    return this.tools.map((tool) => {
      const row = {
        name: tool.name,
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
      };
      if (tool.outputSchema) row.outputSchema = tool.outputSchema;
      if (tool._meta) row._meta = tool._meta;
      return row;
    });
  }

  static error(id, code, message, data) {
    return { jsonrpc: '2.0', id, error: Object.assign({ code, message }, data ? { data } : {}) };
  }

  static ok(id, result) {
    return { jsonrpc: '2.0', id, result };
  }

  /**
   * بناء نتيجة الأداة بما يلتزم بالبروتوكول:
   * - content دائمًا نص JSON صالح (لا يسمح أبدًا بـ {} الفارغة).
   * - structuredContent مضمون ومتطابق مع outputSchema عند إعلانه.
   * - الصور تُحذف بحراسة عند تجاوز حد الحجم مع بيانات وصفية بدلًا منها.
   */
  contentFromResult(result, meta) {
    const hasData = result && Object.prototype.hasOwnProperty.call(result, 'data');
    const rawPayload = hasData ? result.data : result;
    const safePayload = rawPayload === undefined || rawPayload === null ? {} : rawPayload;
    const payload = (typeof safePayload === 'object') ? safePayload : { value: safePayload };
    if (!Array.isArray(payload) && Object.keys(payload).length === 0) {
      const error = new Error('Tool returned an empty result');
      error.code = 'EMPTY_TOOL_RESULT';
      throw error;
    }
    const structured = (result && result.structured !== undefined) ? result.structured : payload;
    if (!structured || typeof structured !== 'object' || Array.isArray(structured)) {
      throw new Error('structuredContent must be an object');
    }
    const text = JSON.stringify(payload, null, 2);
    if (Buffer.byteLength(text, 'utf8') > MAX_CONTENT_TEXT_CHARS) {
      const error = new Error('Tool response exceeds the configured text size limit');
      error.code = 'RESPONSE_TOO_LARGE';
      throw error;
    }

    const content = [{ type: 'text', text }];
    if(result && result.resources) for(const a of result.resources) content.push({type:'resource_link',uri:a.uri,name:a.id,mimeType:a.mimeType,size:a.bytes,description:'Verified export SHA-256 '+a.sha256});
    const imageOmitted = [];
    if (result && Array.isArray(result.images)) {
      for (const image of result.images) {
        if (image && typeof image.data === 'string' && image.data.length > MAX_IMAGE_B64_CHARS) {
          imageOmitted.push({ bytes: Math.round(image.data.length * 3 / 4), reason: 'image-exceeds-response-limit', mimeType: image.mimeType || 'image/png' });
          continue;
        }
        content.push({ type: 'image', data: image.data, mimeType: image.mimeType || 'image/png' });
      }
    }
    if (imageOmitted.length && structured && typeof structured === 'object' && !Array.isArray(structured)) {
      structured.delivery = Object.assign({}, structured.delivery, { code: 'PREVIEW_SIZE_LIMIT', imageDelivered: content.some((item) => item.type === 'image'), imagesOmitted: imageOmitted });
      content[0].text = JSON.stringify(Object.assign({}, payload, { delivery: structured.delivery }), null, 2);
    }

    const out = {
      content,
      isError: false,
      structuredContent: (structured && typeof structured === 'object') ? structured : { value: structured },
    };
    // _meta مخفي عن النموذج ويصل إلى الواجهة فقط (صورة المعاينة للعرض داخل المحادثة).
    out._meta = Object.assign({}, meta || {}, (result && result.meta) || {});
    if (process.env.ARTFORGE_PREVIEW_DATA_URL === 'off' && out._meta.artforge) {
      out._meta.artforge = Object.assign({}, out._meta.artforge);
      delete out._meta.artforge.previewDataUrl;
      out._meta.artforge.previewDataUrlOmitted = 'native-image-delivery';
    }
    return out;
  }

  /** Handle one JSON-RPC message; returns a response object or null for notifications. */
  async handle(message) {
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      return McpServer.error(null, -32600, 'Invalid Request');
    }
    const { id, method, params } = message;
    if(method==='notifications/cancelled') {
      const call=this.activeCalls.get(params?.requestId);
      if(call)call.abort(Object.assign(new Error('Tool call cancelled by client'),{code:'TOOL_CALL_CANCELLED'}));
      return null;
    }
    const isNotification = id === undefined || id === null;

    try {
      if (method === 'initialize') {
        const requested = params && params.protocolVersion;
        const protocolVersion = PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0];
        this.initialized = true;
        return McpServer.ok(id, {
          protocolVersion,
          capabilities: { tools: { listChanged: false }, resources: { listChanged: false } },
          serverInfo: SERVER_INFO,
          instructions:
            'ArtForge AI MCP. For a new design call artforge_create_design once with the user prompt, the exact texts and width/height: '
            + 'it detects the design type (text, poster, card, table, ruled page, interior scene, character, landscape, architecture, reference image), '
            + 'plans, draws, saves, exports, runs pixel QA, verifies text/size/elements and returns the preview image. '
            + 'Pass tables as table={columns, rows} and long structured text as blocks or body; never draw cells, lines or scenes element by element. '
            + 'Report verification issues, QA warnings, design.missing and design.limits to the user. '
            + 'Binding operating skills: read artforge_tool_docs guide="operating-procedure" first (tools, skill and reference map); '
            + 'Before composing a card, ad, banner, poster, logo, magazine, lesson, infographic or vector colour blend, call artforge_tool_docs route="<user request>". Apply the selected briefs and read other relevant guides by ID (guide="list" for all). '
            + 'Palettes, styleguides and the 25 page-grounded book rules are applied inside artforge_create_design and reported in evidence; do not search them before it. '
            + 'Use artforge_tool_op (op "batch" for several edits) only for small follow-up edits; batch returns the updated preview, so export again only when a separate format or scale is requested.',
        });
      }
      if (method === 'notifications/initialized' || method === 'initialized') return null;
      if (method === 'ping') return McpServer.ok(id, {});
      if (method === 'tools/list') return McpServer.ok(id, { tools: this.listTools() });
      if (method === 'resources/list') {
        return McpServer.ok(id, {
          resources: [{ uri: WIDGET_URI, name: 'artforge-preview', title: 'ArtForge design preview', mimeType: WIDGET_MIME }, ...(this.engine.artifacts ? this.engine.artifacts.list().map(a=>({uri:a.uri,name:a.id,title:a.format+' export',mimeType:a.mimeType,size:a.bytes})) : [])],
        });
      }
      if (method === 'resources/templates/list') return McpServer.ok(id, { resourceTemplates: [{uriTemplate:'artforge://artifact/{artifactId}',name:'artforge-export',description:'Bounded persisted export artifact; use an ID returned by artforge_export.'}] });
      if (method === 'resources/read') {
        if(params && /^artforge:\/\/artifact\//.test(params.uri||'')) { const a=this.engine.artifacts.get(params.uri);return McpServer.ok(id,{contents:[{uri:a.record.uri,mimeType:a.record.mimeType,blob:a.bytes.toString('base64'),_meta:{sha256:a.record.sha256,bytes:a.record.bytes}}]}); }
        if (!params || params.uri !== WIDGET_URI) return McpServer.error(id, -32602, `Unknown resource: ${params && params.uri}`);
        return McpServer.ok(id, {
          contents: [{
            uri: WIDGET_URI,
            mimeType: WIDGET_MIME,
            text: WIDGET_HTML,
            _meta: { ui: { prefersBorder: true }, 'openai/widgetPrefersBorder': true },
          }],
        });
      }
      if (method === 'prompts/list') return McpServer.ok(id, { prompts: [] });

      if (method === 'tools/call') {
        const name = params && params.name;
        const tool = this.toolMap.get(name);
        if (!tool) return McpServer.error(id, -32602, `Unknown tool: ${name}`);
        const args = (params && params.arguments) || {};
        const traceId = safeTraceId(params && params._meta && params._meta.traceId) || safeTraceId(args.traceId) || newTraceId();
        const trace = new Trace({
          kind: 'tool-call',
          label: name,
          traceId,
          logFile: this.traceFile,
          inputBytes: Buffer.byteLength(JSON.stringify(args), 'utf8'),
        });
        this.logger.info('tool-call', { id, tool: name, traceId, args: Object.keys(args) });
        try {
          require('./engine/input-contract').validate(args,tool.inputSchema);
          if(this.activeCalls.size>=8)throw Object.assign(new Error('Too many active tool calls; retry when a call finishes'),{code:'TOOL_BUSY'});
          const controller=new AbortController(),deadline=Date.now()+this.callTimeoutMs;
          this.activeCalls.set(id,controller);
          const timer=setTimeout(()=>controller.abort(Object.assign(new Error('Tool deadline exceeded; further commits cancelled'),{code:'TOOL_CALL_TIMEOUT'})),this.callTimeoutMs);
          let result;
          try {result=await traceContext.run({traceId,trace,signal:controller.signal,deadline},()=>Promise.resolve().then(()=>tool.handler(args,{trace,signal:controller.signal})));if(controller.signal.aborted)throw controller.signal.reason;}
          finally {clearTimeout(timer);this.activeCalls.delete(id);}
          const traceSummary = trace.summary();
          const envelope = this.contentFromResult(result, {
            traceId,
            elapsedMs: traceSummary.totalMs,
            spans: traceSummary.spans,
          });
          envelope.isError = false;
          trace.finish('ok', { responseBytes: Buffer.byteLength(JSON.stringify(envelope), 'utf8') });
          this.logger.info('tool-ok', { id, tool: name, traceId, elapsedMs: traceSummary.totalMs });
          return McpServer.ok(id, envelope);
        } catch (error) {
          trace.finish('error', { errorCode: error.code || 'TOOL_ERROR', phase: error.run?.error?.phase || null, error: error.message });
          this.logger.error('tool-error', {
            id,
            tool: name,
            traceId,
            elapsedMs: Trace.elapsed(trace.startedHr),
            code: error.code || 'TOOL_ERROR',
            message: error.message,
          });
          return McpServer.ok(id, {
            content: [{
              type: 'text',
              text: JSON.stringify({
                error: { code: error.code || 'TOOL_ERROR', message: error.message, details: error.details || null },
                run: error.run ? { runId: error.run.runId, phases: error.run.phases } : undefined,
                recoverable: true,
              }, null, 2),
            }],
            structuredContent: {
              success: false,
              error: { code: error.code || 'TOOL_ERROR', message: error.message, details: error.details || null },
              traceId,
            },
            isError: true,
            _meta: { traceId },
          });
        }
      }

      if (isNotification) return null;
      return McpServer.error(id, -32601, `Method not found: ${method}`);
    } catch (error) {
      if (isNotification) return null;
      return McpServer.error(id, -32603, error.message || 'Internal error');
    }
  }
}

/**
 * حراسة العملية: أي خطأ في stdout (EPIPE) كان يقتل الخادم برمز 1 ويقطع الجلسة.
 * الآن يُسجَّل الحدث ويخرج الخادم بهدوء، وتبقى أداة الرسم حيّة للجلسة التالية.
 */
function installProcessGuards(logger, options) {
  const opts = options || {};
  const log = logger || createLogger('mcp', {});
  let closing = false;

  const shutdown = (reason, detail) => {
    if (closing) return;
    closing = true;
    log.warn('shutdown', Object.assign({ reason }, detail || {}));
    if (typeof opts.onShutdown === 'function') {
      try { opts.onShutdown(reason); } catch { /* ignore */ }
    }
    setTimeout(() => process.exit(0), Number(process.env.ARTFORGE_EXIT_DELAY_MS || 50));
  };

  process.stdout.on('error', (error) => {
    log.error('stdout-error', { code: error.code, message: error.message });
    if (error.code === 'EPIPE') shutdown('stdout-epipe');
  });
  process.stdin.on('error', (error) => {
    log.warn('stdin-error', { code: error.code, message: error.message });
  });
  process.on('uncaughtException', (error) => {
    log.error('uncaught-exception', { message: error.message, stack: String(error.stack || '').slice(0, 2000) });
    shutdown('uncaught-exception');
  });
  process.on('unhandledRejection', (reason) => {
    log.error('unhandled-rejection', { message: reason instanceof Error ? reason.message : String(reason) });
  });
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
    process.on(signal, () => shutdown(`signal-${signal}`));
  }
  process.on('exit', (code) => {
    log.info('process-exit', { code });
  });
  return { shutdown, isClosing: () => closing };
}

/** Newline-delimited JSON-RPC over stdio (the transport MCP clients use locally). */
function serveStdio(engine, options) {
  const opts = options || {};
  const logger = (engine && engine.logger) || createLogger('mcp', {});
  installProcessGuards(logger, opts);
  const server = new McpServer(engine, { logger });
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  const write = (payload) => {
    try {
      process.stdout.write(`${JSON.stringify(payload)}\n`);
    } catch (error) {
      logger.error('stdout-write-failed', { code: error.code, message: error.message });
    }
  };
  logger.info('stdio-ready', { pid: process.pid, toolUrl: engine && engine.bridge ? engine.bridge.baseUrl : null });
  rl.on('line', async (line) => {
    const text = line.trim();
    if (!text) return;
    let message;
    try {
      message = JSON.parse(text);
    } catch (error) {
      write(McpServer.error(null, -32700, `Parse error: ${error.message}`));
      return;
    }
    const response = await server.handle(message);
    if (response) write(response);
  });
  rl.on('close', () => {
    logger.info('stdin-closed', { pid: process.pid });
    if (opts.onClose) opts.onClose();
  });
  return server;
}

/** Streamable HTTP transport for remote-style clients (POST JSON-RPC to /mcp). */
function createHttpServer(engine) {
  const logger = (engine && engine.logger) || createLogger('mcp', {});
  const server = new McpServer(engine, { logger });
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Accept, Mcp-Session-Id',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  };

  const httpServer = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors);
      res.end();
      return;
    }
    if (url.pathname === '/health' && req.method === 'GET') {
      const health = await engine.bridge.health();
      res.writeHead(200, Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, cors));
      res.end(JSON.stringify({
        ok: true,
        server: SERVER_INFO,
        drawingTool: { url: engine.bridge.baseUrl, reachable: health.ok },
      }));
      return;
    }
    if (url.pathname !== '/mcp') {
      res.writeHead(404, Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, cors));
      res.end(JSON.stringify({ error: 'POST JSON-RPC messages to /mcp' }));
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(405, Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, cors));
      res.end(JSON.stringify({ error: 'use POST' }));
      return;
    }

    const chunks = [];
    const requestStarted = Date.now();
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('aborted', () => {
      logger.warn('http-client-aborted', { elapsedMs: Date.now() - requestStarted, bytes: chunks.length });
    });
    res.on('close', () => {
      if (!res.writableEnded) {
        logger.warn('http-response-closed-early', { elapsedMs: Date.now() - requestStarted, status: res.statusCode });
      }
    });
    req.on('end', async () => {
      let payload;
      try {
        payload = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      } catch (error) {
        res.writeHead(400, Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, cors));
        res.end(JSON.stringify(McpServer.error(null, -32700, `Parse error: ${error.message}`)));
        return;
      }
      const messages = Array.isArray(payload) ? payload : [payload];
      const responses = [];
      for (const message of messages) {
        const response = await server.handle(message);
        if (response) responses.push(response);
      }
      logger.info('http-response', { elapsedMs: Date.now() - requestStarted, messages: messages.length, bytes: JSON.stringify(responses).length });
      if (!responses.length) {
        res.writeHead(202, cors);
        res.end();
        return;
      }
      res.writeHead(200, Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, cors));
      res.end(JSON.stringify(Array.isArray(payload) ? responses : responses[0]));
    });
    req.on('error', () => {
      try { res.writeHead(500, cors); res.end(); } catch { /* ignore */ }
    });
  });

  // مهلة صريحة بدل قطع Node الصامت بعد 300 ثانية.
  httpServer.requestTimeout = Number(process.env.ARTFORGE_HTTP_REQUEST_TIMEOUT_MS || 300000);
  httpServer.headersTimeout = Number(process.env.ARTFORGE_HTTP_HEADERS_TIMEOUT_MS || 60000);
  httpServer.keepAliveTimeout = Number(process.env.ARTFORGE_HTTP_KEEPALIVE_TIMEOUT_MS || 5000);

  return { httpServer, server };
}

module.exports = {
  McpServer, serveStdio, createHttpServer, installProcessGuards, SERVER_INFO, PROTOCOL_VERSIONS,
};
