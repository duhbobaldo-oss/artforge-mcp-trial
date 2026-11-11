'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { GenerationJobs } = require('../src/engine/generation-jobs');
const { compileGenerationSpec } = require('../src/engine/generation-spec');
const { createCanvas } = require('../../drawing-tool/node_modules/@napi-rs/canvas');
const { createMcpEngine } = require('../src');
const { McpServer } = require('../src/mcp');
const { createEngine } = require('../../drawing-tool/src');
const { LocalImageProvider } = require('../src/engine/local-image-provider');
const { createServer } = require('../../drawing-tool/src/server/app');
const spec = { version: 1, operationId: 'one', prompt: 'A deep navy sky', width: 256, height: 256, seed: 7 };
function png(input) { const c = createCanvas(input.width, input.height); c.getContext('2d').fillRect(0, 0, input.width, input.height); return c.toBuffer('image/png'); }
const provider = () => ({ id: 'local-test-fixture', profileHash: 'a'.repeat(64), generate: async input => ({ bytes: png(input), mimeType: 'image/png' }) });
function cleanup(t, close) { (t.generationClosers ||= []).push(close); }
function temp(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'artforge-jobs-')); t.after(async () => { for (const close of t.generationClosers || []) await close(); fs.rmSync(dir, { recursive: true, force: true }); }); return dir; }
function setup(t, options = {}) { const dir = temp(t); const jobs = new GenerationJobs({ dir, enabled: true, provider: provider(), deliver: async () => ({ documentId: 'test-doc' }), ...options }); cleanup(t, () => jobs.close()); return { jobs, dir }; }

test('strict contract rejects unsupported controls, owner injection and malformed boundaries', () => {
  assert.equal(compileGenerationSpec(spec).seed, 7);
  for (const patch of [{ owner: 'other' }, { model: 'remote' }, { references: [] }, { width: 255 }, { height: 4096 }, { seed: -1 }, { seed: true }, { overlays: {} }, { overlays: null }, { operationId: 123 }, { prompt: '' }]) assert.throws(() => compileGenerationSpec({ ...spec, ...patch }), { code: 'INVALID_GENERATION_SPEC' });
  assert.throws(() => compileGenerationSpec({ ...spec, overlays: [{ text: 'س', x: 0, y: 0, w: 300, h: 20, fontSize: 20, rtl: true, color: '#ffffff' }] }), { code: 'INVALID_GENERATION_SPEC' });
});

test('disabled jobs create no store and reject before provider invocation', t => {
  const dir = path.join(temp(t), 'absent'); const jobs = new GenerationJobs({ dir });
  assert.equal(fs.existsSync(dir), false); assert.throws(() => jobs.submit('a', spec), { code: 'GENERATION_DISABLED' });
});

test('durable idempotency survives coordinator restart and result is read from SQLite', async t => {
  let calls = 0; const p = provider(); const generate = p.generate; p.generate = async s => { calls++; return generate(s); };
  const { jobs, dir } = setup(t, { provider: p });
  const first = jobs.submit('alice', spec); assert.equal(jobs.submit('alice', spec).jobId, first.jobId);
  await jobs.idle(); assert.equal(jobs.get('alice', first.jobId).state, 'succeeded'); await jobs.close();
  const reopened = new GenerationJobs({ dir, enabled: true, provider: p, deliver: async () => ({}) }); cleanup(t, () => reopened.close());
  assert.equal(reopened.submit('alice', spec).jobId, first.jobId); await reopened.idle(); assert.equal(calls, 1);
  assert.ok(reopened.image('alice', first.jobId).bytes.length > 50);
  assert.throws(() => reopened.submit('alice', { ...spec, seed: 8 }), { code: 'GENERATION_OPERATION_CONFLICT' });
});

test('tenant scope applies to read, PNG, cancel and removal; provider profile binds idempotency', async t => {
  const { jobs } = setup(t); const first = jobs.submit('alice', spec); await jobs.idle();
  for (const method of ['get', 'image', 'cancel', 'remove']) assert.throws(() => jobs[method]('bob', first.jobId), { code: 'GENERATION_JOB_NOT_FOUND' });
  assert.deepEqual(jobs.list('bob'), []); assert.throws(() => jobs.get(null, first.jobId), { code: 'GENERATION_OWNER_REQUIRED' });
  jobs.provider.profileHash = 'b'.repeat(64); assert.throws(() => jobs.submit('alice', spec), { code: 'GENERATION_OPERATION_CONFLICT' });
});

test('bounded queue and owner quota do not evict receipts or run duplicate work', async t => {
  const { jobs } = setup(t, { maxPending: 1, maxJobs: 1 }); const first = jobs.submit('a', spec);
  assert.throws(() => jobs.submit('b', { ...spec, operationId: 'two' }), { code: 'GENERATION_QUOTA' });
  await jobs.idle(); assert.throws(() => jobs.submit('a', { ...spec, operationId: 'two' }), { code: 'GENERATION_QUOTA' });
  jobs.remove('a', first.jobId); assert.equal(jobs.get('a', first.jobId).error, 'GENERATION_REMOVED');
  assert.equal(jobs.submit('a', spec).jobId, first.jobId); assert.throws(() => jobs.image('a', first.jobId), { code: 'GENERATION_NOT_READY' });
});

test('queued cancellation prevents inference; active work blocks removal', async t => {
  let calls = 0; const p = provider(); p.generate = async () => { calls++; };
  const { jobs } = setup(t, { provider: p }); const j = jobs.submit('a', spec);
  assert.throws(() => jobs.remove('a', j.jobId), { code: 'GENERATION_JOB_ACTIVE' });
  jobs.cancel('a', j.jobId); await jobs.idle(); assert.equal(calls, 0); assert.equal(jobs.get('a', j.jobId).state, 'cancelled');
});

test('cancel running worker waits for settlement and serializes next job', async t => {
  let active = 0, peak = 0, started;
  const began = new Promise(resolve => { started = resolve; });
  const p = provider(); p.generate = async (s, { signal }) => {
    active++; peak = Math.max(peak, active); started();
    await new Promise(resolve => { const timer = setTimeout(resolve, 35); signal.addEventListener('abort', () => { clearTimeout(timer); setTimeout(resolve, 20); }, { once: true }); });
    active--; return { bytes: png(s), mimeType: 'image/png' };
  };
  const { jobs } = setup(t, { provider: p }); const j = jobs.submit('a', spec); jobs.submit('a', { ...spec, operationId: 'two' });
  await began; jobs.cancel('a', j.jobId); await jobs.idle(); assert.equal(peak, 1); assert.equal(active, 0); assert.equal(jobs.get('a', j.jobId).state, 'cancelled');
});

test('timeout and malformed output produce durable redacted errors, never delivery', async t => {
  let deliveries = 0;
  for (const mode of ['bad', 'slow', 'throw']) {
    const p = provider(); p.generate = async (s, { signal }) => {
      if (mode === 'slow') await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
      if (mode === 'throw') throw Error('secret-internal-path');
      return { bytes: Buffer.from('bad'), mimeType: 'image/png' };
    };
    const { jobs } = setup(t, { provider: p, timeoutMs: 20, deliver: async () => { deliveries++; } });
    const j = jobs.submit('a', spec); await jobs.idle();
    assert.equal(jobs.get('a', j.jobId).error, { bad: 'INVALID_GENERATION_IMAGE', slow: 'GENERATION_TIMEOUT', throw: 'GENERATION_JOB_FAILED' }[mode]);
    assert.ok(!JSON.stringify(jobs.get('a', j.jobId)).includes('secret'));
  }
  assert.equal(deliveries, 0);
});

test('exclusive coordinator and interrupted state never silently regenerate', async t => {
  const { jobs, dir } = setup(t);
  assert.throws(() => new GenerationJobs({ dir, enabled: true, provider: provider(), deliver: async () => ({}) }), { code: 'GENERATION_STORE_LOCKED' });
  assert.throws(() => require('../src/engine/generation-recovery').recoverGenerationLock(dir), { code: 'GENERATION_STORE_LOCKED' });
  const j = jobs.submit('a', spec); await jobs.idle();
  jobs.db.prepare("UPDATE jobs SET state='running' WHERE id=?").run(j.jobId); await jobs.close();
  const next = new GenerationJobs({ dir, enabled: true, provider: provider(), deliver: async () => ({}) }); cleanup(t, () => next.close());
  assert.equal(next.get('a', j.jobId).error, 'GENERATION_INTERRUPTED'); assert.equal(next.submit('a', spec).state, 'failed');
});

test('MCP submit → real Skia document → editable Arabic → save/export → reopen after restart', async t => {
  const dir = temp(t), drawing = path.resolve(__dirname, '../../drawing-tool');
  function renderer() { return createEngine({ root: drawing, docsDir: path.join(dir, 'docs'), assetsDir: path.join(dir, 'assets'), exportsDir: path.join(dir, 'exports') }); }
  let draw = renderer();
  let diagnostic;
  const http = createServer(draw).server;
  await new Promise((resolve, reject) => { http.once('error', reject); http.listen(0, '127.0.0.1', resolve); });
  cleanup(t, () => new Promise(resolve => http.close(resolve)));
  const engine = createMcpEngine({ dataDir: path.join(dir, 'mcp'), logDir: path.join(dir, 'logs'), autoStart: false,
    toolUrl: 'http://127.0.0.1:' + http.address().port,
    artifactRoots: [path.join(dir, 'exports')],
    generationJobs: { enabled: true, ownerId: 'alice', provider: provider(), onError: detail => { diagnostic = detail; } } });
  cleanup(t, () => engine.generationJobs.close());
  const server = new McpServer(engine);
  const call = (op, params) => server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'artforge_tool_op', arguments: { op, params } } });
  const input = { ...spec, overlays: [{ text: 'مرحبا بالعالم', x: 10, y: 25, w: 230, h: 50, fontSize: 24, rtl: true, color: '#ffffff' }] };
  const response = await call('generation.jobs.submit', input); assert.equal(response.result.isError, false, JSON.stringify(response));
  const j = response.result.structuredContent; await engine.generationJobs.idle();
  const state = engine.generationJobs.get('alice', j.jobId); assert.equal(state.state, 'succeeded', JSON.stringify({ state, diagnostic }));
  const info = (await draw.run('document.info', { documentId: state.result.documentId })).data;
  const objects = info.document.layers.flatMap(l => l.objects); assert.ok(objects.some(o => o.type === 'image'));
  assert.ok(objects.some(o => o.type === 'text' && o.text === 'مرحبا بالعالم' && o.rtl));
  assert.equal(objects.find(o => o.type === 'text').x, 240, 'box left edge is converted to right-aligned renderer anchor');
  const { loadImage } = require('../../drawing-tool/node_modules/@napi-rs/canvas');
  const finalImage = await loadImage(state.result.export.path), surface = createCanvas(256, 256);
  const ctx = surface.getContext('2d'); ctx.drawImage(finalImage, 0, 0); const pixels = ctx.getImageData(0, 0, 256, 256).data;
  const textXs = []; for (let y = 0; y < 120; y++) for (let x = 0; x < 256; x++) { const i = (y * 256 + x) * 4; if (pixels[i] > 200 && pixels[i + 1] > 200 && pixels[i + 2] > 200) textXs.push(x); }
  assert.ok(textXs.length > 100, 'actual Arabic glyph pixels must be present');
  assert.ok(Math.min(...textXs) >= 10 && Math.max(...textXs) <= 240, 'rendered Arabic must remain inside the specified overlay box');
  assert.ok(fs.readdirSync(path.join(dir, 'exports')).some(f => f.endsWith('.png')));
  draw = renderer(); const reloaded = (await draw.run('document.info', { documentId: state.result.documentId })).data;
  assert.equal(reloaded.document.id, state.result.documentId);
  const preview = await call('generation.jobs.preview', { jobId: j.jobId }); assert.ok(preview.result.content.some(c => c.type === 'image'));
  const denied = await call('generation.jobs.get', { jobId: j.jobId, owner: 'bob' }); assert.equal(denied.result.isError, true);
  const legacy = await call('generation.generate', spec); assert.equal(legacy.result.structuredContent.error.code, 'GENERATION_DISABLED');
});

test('real Python worker fails closed with no local model; no network or weights requested', async t => {
  const dir = temp(t); const p = new LocalImageProvider({ modelDir: dir, profileHash: 'a'.repeat(64) });
  await assert.rejects(p.generate(spec), { code: 'GENERATION_MODEL_UNAVAILABLE' });
});

test('Python subprocess transport returns a validated PNG and cancellation waits for process exit', async t => {
  const dir = temp(t); const p = new LocalImageProvider({ modelDir: dir, profileHash: 'a'.repeat(64), script: path.join(__dirname, 'fixtures/image-worker.py') });
  const image = await p.generate(spec); require('../src/engine/png-contract').validatePng(image.bytes, spec);
  const controller = new AbortController(); const start = performance.now();
  const pending = p.generate({ ...spec, prompt: 'wait' }, { signal: controller.signal });
  setTimeout(() => controller.abort(), 100); await assert.rejects(pending, { code: 'GENERATION_CANCELLED' });
  assert.ok(performance.now() - start < 5000, '30 second process must be terminated, not detached');
});

test('queued work survives shutdown and runs once after reopen', async t => {
  let calls = 0; const p = provider(); const generate = p.generate; p.generate = s => { calls++; return generate(s); };
  const { jobs, dir } = setup(t, { provider: p }); const j = jobs.submit('a', spec); await jobs.close(); assert.equal(calls, 0);
  const next = new GenerationJobs({ dir, enabled: true, provider: p, deliver: async () => ({}) }); cleanup(t, () => next.close());
  await next.idle(); assert.equal(next.get('a', j.jobId).state, 'succeeded'); assert.equal(calls, 1);
});

test('future database version is rejected without downgrading or losing prior state', async t => {
  const dir = temp(t), file = path.join(dir, 'jobs.sqlite'); const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(file); db.exec('PRAGMA user_version=99; CREATE TABLE valuable(value TEXT); INSERT INTO valuable VALUES(\'preserved\')'); db.close();
  assert.throws(() => new GenerationJobs({ dir, enabled: true, provider: provider(), deliver: async () => ({}) }), { code: 'GENERATION_SCHEMA_UNSUPPORTED' });
  const check = new DatabaseSync(file); assert.equal(check.prepare('PRAGMA user_version').get().user_version, 99); assert.equal(check.prepare('SELECT value FROM valuable').get().value, 'preserved'); check.close();
});

test('owner recovery removes only a dead process lock and preserves job database', async t => {
  const { jobs, dir } = setup(t); const j = jobs.submit('a', spec); await jobs.idle(); await jobs.close();
  const { spawnSync } = require('node:child_process'); const exited = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8', windowsHide: true });
  assert.equal(exited.status, 0); fs.writeFileSync(path.join(dir, 'coordinator.lock'), exited.stdout);
  assert.equal(require('../src/engine/generation-recovery').recoverGenerationLock(dir).databasePreserved, true);
  const next = new GenerationJobs({ dir, enabled: true, provider: provider(), deliver: async () => ({}) }); cleanup(t, () => next.close());
  assert.equal(next.get('a', j.jobId).state, 'succeeded');
});

test('process guard waits for async GPU owner shutdown before exiting', async t => {
  const dir = temp(t), marker = path.join(dir, 'closed'); const { spawn } = require('node:child_process');
  const code = `const {installProcessGuards}=require(${JSON.stringify(path.resolve(__dirname, '../src/mcp'))}); installProcessGuards({info(){},warn(){},error(){}},{onShutdown:async()=>{await new Promise(r=>setTimeout(r,100));require('node:fs').writeFileSync(${JSON.stringify(marker)},'closed')}}).shutdown('test');`;
  const child = spawn(process.execPath, ['-e', code], { windowsHide: true, stdio: 'ignore' });
  const exit = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  assert.equal(exit, 0); assert.equal(fs.readFileSync(marker, 'utf8'), 'closed');
});
