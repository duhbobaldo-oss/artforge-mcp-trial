'use strict';

// End-to-end smoke test: starts server.js on a free local port and drives it over MCP JSON-RPC.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');

const root = path.join(__dirname, '..');
let child;
let base;
let nextId = 1;

async function rpc(method, params, headers = {}) {
  const res = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params }),
  });
  return { status: res.status, body: res.status === 202 ? null : await res.json() };
}

function payload(result) {
  const text = result.content.find(item => item.type === 'text');
  return text ? JSON.parse(text.text) : {};
}

test.before(async () => {
  child = spawn(process.execPath, ['server.js'], { cwd: root, env: { ...process.env, HOST: '127.0.0.1', PORT: '0', ARTFORGE_DEMO_TOKEN_FILE: '' } });
  base = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not start in 30 s')), 30_000);
    child.stdout.on('data', chunk => {
      const match = /listening on port (\d+)/.exec(String(chunk));
      if (match) { clearTimeout(timer); resolve(`http://127.0.0.1:${match[1]}`); }
    });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`server exited with ${code}`)); });
  });
});

test.after(() => { if (child) child.kill(); });

test('health endpoint answers', async () => {
  const res = await fetch(`${base}/health`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
});

test('public reference adapter can consume the shipped renderer MCP without new endpoints',async()=>{
 const made=await rpc('tools/call',{name:'artforge_create_design',arguments:{prompt:'بطاقة بسيطة',headline:'مرجع',width:800,height:500,preview:false}});
 assert.equal(made.body.result.isError,false);const documentId=payload(made.body.result).documentId;
 const {resolveGenerationReference}=await import('../cloudflare-gateway/src/generation-reference.js');
 const env={ORIGIN_URL:base,ORIGIN_TOKEN:'test-only-placeholder',DB:{prepare(){return{bind(id){assert.equal(id,documentId);return this;},async first(){return'alice';}}}}};
 const ref=await resolveGenerationReference(env,'alice',documentId);
 assert.ok(ref.width<512&&ref.height<512);assert.equal(ref.documentId,documentId);assert.match(ref.sha256,/^[a-f0-9]{64}$/);
});

test('MCP initialize and tools/list', async () => {
  const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '1' } });
  assert.equal(init.status, 200);
  assert.equal(init.body.result.serverInfo.name, 'artforge-ai-mcp');
  const list = await rpc('tools/list', {});
  const names = list.body.result.tools.map(tool => tool.name);
  for (const name of ['artforge_create_design', 'artforge_tool_op', 'artforge_export']) assert.ok(names.includes(name), name);
});

test('creates an Arabic design, edits it and exports a PNG', { timeout: 90_000 }, async () => {
  const created = await rpc('tools/call', { name: 'artforge_create_design', arguments: { prompt: 'بطاقة ترحيب بسيطة', headline: 'مرحبًا بالعربية', width: 800, height: 500, preview: false } });
  assert.equal(created.status, 200);
  assert.ok(!created.body.error, JSON.stringify(created.body.error));
  const result = payload(created.body.result);
  const documentId = result.documentId || result.document?.documentId || result.execution?.documentId;
  assert.match(String(documentId), /^doc_/, JSON.stringify(result).slice(0, 400));
  const drawn = await rpc('tools/call', { name: 'artforge_tool_op', arguments: { op: 'batch', ops: [
    { op: 'draw.rect', params: { documentId, x: 40, y: 40, w: 200, h: 60, radius: 12, fill: '#F1B652' } },
    { op: 'draw.text', params: { documentId, x: 140, y: 80, text: 'تجربة', font: { family: 'Tajawal', size: 28, weight: 700 }, align: 'center', fill: '#121D30' } },
  ] } });
  assert.ok(!drawn.body.error && !drawn.body.result.isError, JSON.stringify(drawn.body).slice(0, 400));
  const exported = await rpc('tools/call', { name: 'artforge_export', arguments: { documentId, format: 'png', preview: true } });
  assert.ok(!exported.body.error && !exported.body.result.isError, JSON.stringify(exported.body).slice(0, 400));
  const image = exported.body.result.content.find(item => item.type === 'image');
  assert.ok(image, 'export returns an image preview');
  assert.equal(Buffer.from(image.data, 'base64').subarray(1, 4).toString(), 'PNG');
});

test('trial restrictions are enforced', async () => {
  const pdf = await rpc('tools/call', { name: 'artforge_export', arguments: { documentId: 'doc_x', format: 'pdf' } });
  assert.equal(pdf.body.error.code, -32602);
  const hostFile = await rpc('tools/call', { name: 'artforge_tool_op', arguments: { op: 'image.add', params: { path: '/etc/passwd' } } });
  assert.equal(hostFile.body.error.code, -32602);
  const big = await rpc('tools/call', { name: 'artforge_create_design', arguments: { prompt: 'poster', width: 4000, height: 4000 } });
  assert.equal(big.body.error.code, -32602);
  const crossOrigin = await rpc('tools/list', {}, { origin: 'https://example.com' });
  assert.equal(crossOrigin.status, 403);
});
