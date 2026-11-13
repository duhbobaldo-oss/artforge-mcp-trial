'use strict';
// Regressions from the 2026-11-13 usage session (Python cover, valley cottage, ELITE ESTATES covers).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createEngine } = require('../src/index');

function makeEngine() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'artforge-repair-'));
  return createEngine({ root: path.join(__dirname, '..'), docsDir: path.join(root, 'documents'), assetsDir: path.join(root, 'assets'),
    exportsDir: path.join(root, 'exports'), workspaceRoot: root });
}

test('stroke-only shapes are outlines, not black discs (glasses, rings, badge borders)', async () => {
  const engine = makeEngine();
  const id = (await engine.run('document.create', { width: 200, height: 100 })).data.documentId;
  const ring = (await engine.run('draw.ellipse', { documentId: id, x: 10, y: 10, w: 60, h: 60, stroke: '#ffffff', strokeWidth: 4 })).data.object;
  const box = (await engine.run('draw.rect', { documentId: id, x: 80, y: 10, w: 60, h: 40, stroke: '#ffffff', strokeWidth: 4 })).data.object;
  const tri = (await engine.run('draw.polygon', { documentId: id, points: [{ x: 150, y: 10 }, { x: 190, y: 10 }, { x: 170, y: 50 }], stroke: '#ff0000' })).data.object;
  assert.equal(ring.fill, null);
  assert.equal(box.fill, null);
  assert.equal(tri.fill, null);
  // Unchanged: a shape with neither fill nor stroke keeps the historical black fill; explicit fills are kept.
  assert.equal((await engine.run('draw.rect', { documentId: id, x: 0, y: 0, w: 5, h: 5 })).data.object.fill, '#000000');
  assert.equal((await engine.run('draw.ellipse', { documentId: id, x: 0, y: 0, w: 5, h: 5, fill: '#123456', stroke: '#fff' })).data.object.fill, '#123456');
});

test('draw.stroke curve/outline: even body, matching border placed under the fill', async () => {
  const engine = makeEngine();
  const id = (await engine.run('document.create', { width: 400, height: 300 })).data.documentId;
  const points = [{ x: 40, y: 250 }, { x: 120, y: 220 }, { x: 220, y: 230 }, { x: 300, y: 180 }, { x: 330, y: 100 }, { x: 300, y: 50 }];
  const res = (await engine.run('draw.stroke', { documentId: id, points, size: 56, thinning: 0, taperStart: 0, taperEnd: 0,
    color: '#FFD23F', outline: { color: '#14213D', width: 6 } })).data;
  assert.ok(res.outlineObjectId, 'outline object created');
  assert.ok(res.metrics.minWidth > 50, `constant width without taper: ${JSON.stringify(res.metrics)}`);
  assert.ok(res.metrics.samples > 100, 'dense sampling on a 6-point curve');
  const objects = (await engine.run('document.info', { documentId: id })).data.document.layers.flatMap((l) => l.objects);
  const iOutline = objects.findIndex((o) => o.id === res.outlineObjectId);
  const iFill = objects.findIndex((o) => o.id === res.objectId);
  assert.ok(iOutline >= 0 && iOutline < iFill, 'outline painted first');
  assert.equal(objects[iOutline].fill, '#14213D');
  // Without curve/outline the legacy behaviour (speed taper, coarse sampling) is unchanged.
  const legacy = (await engine.run('draw.stroke', { documentId: id, points, size: 56, color: '#000' })).data;
  assert.equal(legacy.outlineObjectId, undefined);
  assert.ok(legacy.metrics.samples < res.metrics.samples);
});
