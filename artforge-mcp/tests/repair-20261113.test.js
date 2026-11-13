'use strict';
// Regressions from the 2026-11-13 usage session: hut/farm/fence understanding, palm trees, generated-image
// delivery and bounded previews.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const canvas = require('../../drawing-tool/node_modules/@napi-rs/canvas');
const { analyzeIntent } = require('../src/engine/intent');
const { boundedPreview } = require('../src/engine/preview');
const { generatedPreview } = require('../src/engine/generated-preview');
const { deliverGenerated } = require('../src/engine/generated-delivery');

const ids = (prompt) => analyzeIntent(prompt, {}).elements.map((e) => e.id).sort();

test('hut/cottage/cabin are houses, timber by default; farm and fence are understood', () => {
  const hut = analyzeIntent('قم برسم كوخ ومزرعة وجبل', {});
  assert.deepEqual(hut.elements.map((e) => e.id).sort(), ['farm', 'house', 'mountains']);
  assert.equal(hut.elements.find((e) => e.id === 'house').defaultMaterial, 'wood');
  assert.deepEqual(ids('cottage in a valley farm with a wooden fence'), ['farm', 'fence', 'house']);
  assert.equal(analyzeIntent('a stone house', {}).elements.find((e) => e.id === 'house').defaultMaterial, undefined);
});

test('"palm trees" requests palms, not also leafy trees', () => {
  assert.deepEqual(ids('glass mansion with palm trees and a sports car'), ['car', 'palms']);
  assert.deepEqual(ids('a house among trees and palm trees'), ['house', 'palms', 'trees']);
  assert.ok(ids('نخيل واشجار').includes('trees'));
});

test('bounded preview keeps shrinking even when a smaller render is not smaller', async () => {
  // Sizes that do not drop with width used to stop the search after two tries and deliver no image.
  const widths = [];
  // Real case: the second, smaller render came out no smaller (anti-aliased gradients), then sizes dropped.
  const sizes = [400000, 410000, 350000, 1000];
  const bridge = { previewPng: async (_id, w) => { widths.push(w); const n = sizes[Math.min(widths.length - 1, sizes.length - 1)]; return { base64: 'A'.repeat(n), bytes: n }; } };
  const out = await boundedPreview(bridge, 'doc_x', 900);
  assert.equal(out.fitsLimit, true);
  assert.equal(widths.length, 4, JSON.stringify(widths));
  assert.ok(widths.every((w, i) => i === 0 || w < widths[i - 1]), JSON.stringify(widths));
});

test('generated photo preview uses JPEG and stays large', async () => {
  // Pixel noise: like a photo, it does not compress as PNG.
  const W = 768; const H = 1024; const c = canvas.createCanvas(W, H); const ctx = c.getContext('2d');
  const img = ctx.createImageData(W, H); const noise = require('node:crypto').randomBytes(img.data.length);
  for (let i = 0; i < img.data.length; i += 1) img.data[i] = i % 4 === 3 ? 255 : noise[i];
  ctx.putImageData(img, 0, 0);
  const bytes = c.toBuffer('image/png');
  assert.ok(bytes.toString('base64').length > 300000, 'fixture is larger than the response limit');
  const out = await generatedPreview({ bytes, width: W, height: H, mimeType: 'image/png' }, canvas);
  assert.equal(out.mimeType, 'image/jpeg');
  assert.ok(out.width >= 480, `preview width ${out.width}`);
  assert.ok(out.bytes.toString('base64').length <= 300000);
});

test('generation delivery writes the full PNG and an editable document', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'af-gen-'));
  const bytes = canvas.createCanvas(64, 32).toBuffer('image/png');
  const calls = [];
  const bridge = { call: async (op) => {
    calls.push(op);
    if (op === 'document.create') return { data: { documentId: 'doc_gen1' } };
    if (op === 'image.add') return { data: { asset: { id: 'asset_1' } } };
    return { data: {} };
  } };
  const generated = { bytes, width: 64, height: 32, sha256: 'x' };
  const out = await deliverGenerated({ projectRoot: root, bridge }, generated, { operationId: 'op-a' });
  assert.equal(fs.readFileSync(out.exported.path).equals(bytes), true);
  assert.equal(out.exported.width, 64);
  assert.equal(out.document.documentId, 'doc_gen1');
  assert.deepEqual(calls, ['document.create', 'image.add', 'draw.image', 'document.save']);
  // Same operationId: the file is rewritten identically and the document is reused, not duplicated.
  const again = await deliverGenerated({ projectRoot: root, bridge }, generated, { operationId: 'op-a' });
  assert.equal(again.document.reused, true);
  assert.equal(calls.filter((c) => c === 'document.create').length, 1);
  // A document failure never loses the file.
  const failing = { call: async () => { throw new Error('tool down'); } };
  const kept = await deliverGenerated({ projectRoot: root, bridge: failing }, generated, { operationId: 'op-b' });
  assert.ok(fs.existsSync(kept.exported.path));
  assert.equal(kept.document.skipped, true);
});
