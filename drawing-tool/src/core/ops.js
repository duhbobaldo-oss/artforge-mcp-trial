'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { assert, OpError } = require('./errors');
const { makeId } = require('./ids');
const { normalizeObject, normalizeLayer, normalizeBackground, normalizeTransform, findObject, findLayer, documentStats, touch } = require('./document');
const { normalizeAnimation, normalizeTrack, ANIMATABLE } = require('./animation');
const { listFonts, describeFonts, resolveFamily, hasArabicGlyphs } = require('./fonts');
const { normalizePaint, BLEND_MODES } = require('./paint');
const { layoutText, fontString, normalizeFont } = require('./text');
const { bboxOf } = require('./renderer');
const { exportImage, exportFrames, renderPreview } = require('./exporter');
const { layoutTable, layoutFlow, ruledPaperObjects } = require('./layout');
const { qaCheck, analyzeImage } = require('./qa');
const { BRUSH_PRESETS, pointsToBezierSegments } = require('./brush');
const { createCanvas } = require('@napi-rs/canvas');
const tree = require('./layer-tree');

const VERSION = '1.0.0';

function requireDoc(ctx, documentId) {
  assert(typeof documentId === 'string' && documentId.length > 0, 'MISSING_DOCUMENT_ID', 'documentId is required');
  return ctx.store.get(documentId);
}

function requireLayer(doc, layerId) {
  const layer = findLayer(doc, layerId);
  assert(layer, 'LAYER_NOT_FOUND', `layer not found: ${layerId}`, { known: doc.layers.map((l) => l.id) });
  return layer;
}

function requireObject(doc, objectId) {
  const found = findObject(doc, objectId);
  assert(found, 'OBJECT_NOT_FOUND', `object not found: ${objectId}`, {
    known: doc.layers.flatMap((layer) => layer.objects.map((object) => object.id)),
  });
  return found;
}

// A layer that can hold objects: groups only organise layers.
function requireDrawable(doc, layer) {
  assert(!tree.isGroup(layer), 'LAYER_IS_GROUP', `"${layer.name}" is a group; draw into a layer inside it`,
    { layerId: layer.id, children: tree.childrenOf(doc.layers, layer.id).map((l) => l.id) });
  assert(layer.type !== 'adjustment', 'LAYER_IS_ADJUSTMENT', `"${layer.name}" is an adjustment layer; it holds no objects`, { layerId: layer.id });
  return layer;
}

function targetLayer(ctx, doc, layerId) {
  if (layerId) return requireDrawable(doc, requireLayer(doc, layerId));
  const drawable = doc.layers.filter((l) => !tree.isGroup(l) && l.type !== 'adjustment');
  assert(drawable.length > 0, 'NO_LAYER', 'document has no drawable layers; add one with layer.add');
  // Topmost drawable layer in paint order (doc.layers is kept bottom → top).
  return drawable[drawable.length - 1];
}

// Lock check for one kind of edit on a layer, including locks inherited from its groups.
//  'content'  — add/delete/restyle/reshape objects; 'position' — move/resize/rotate/align objects or
//  change the layer transform; 'all' — anything else that changes the layer (opacity, blend, filter…).
// `locked` (lock all) blocks every kind; `locks.position` / `locks.content` block only their kind.
function assertEditable(doc, layer, kind) {
  const chain = [layer].concat(tree.ancestors(doc.layers, layer));
  const blocker = chain.find((l) => l.locked || (kind !== 'all' && l.locks && l.locks[kind]));
  if (!blocker) return;
  const how = blocker.locked ? 'locked' : `${kind}-locked`;
  assert(false, 'LAYER_LOCKED', blocker === layer ? `layer "${layer.name}" is ${how}`
    : `layer "${layer.name}" is inside ${how} group "${blocker.name}"`,
    { layerId: layer.id, lockedBy: blocker.id, lock: blocker.locked ? 'all' : kind, edit: kind });
}

const assertUnlocked = (doc, layer) => assertEditable(doc, layer, 'all');

// object.update patch keys that only place the object; every other key changes what it is.
const POSITION_KEYS = new Set(['x', 'y', 'w', 'h', 'x1', 'y1', 'x2', 'y2', 'rotation']);

function effectiveLocks(doc, layer) {
  const chain = [layer].concat(tree.ancestors(doc.layers, layer));
  return {
    all: chain.some((l) => l.locked),
    position: chain.some((l) => l.locked || (l.locks && l.locks.position)),
    content: chain.some((l) => l.locked || (l.locks && l.locks.content)),
  };
}

function requireGroupsAllowed(doc) {
  assert(doc.canvas.compositing === 'v2', 'GROUPS_REQUIRE_V2',
    'layer groups need canvas.compositing "v2"; switch with document.update {canvas:{compositing:"v2"}}');
}

const schema = () => require('./layer-styles-schema');

function requireStylesAllowed(doc, layer) {
  if (layer && !(layer.effects && layer.effects.length) && layer.fillOpacity === undefined && !layer.blendIf) return;
  assert(doc.canvas.compositing === 'v2', 'EFFECTS_REQUIRE_V2',
    'layer effects and fill opacity need canvas.compositing "v2"; switch with document.update {canvas:{compositing:"v2"}}');
}

// A layer or group that can carry effects, editable under its locks.
function requireStyledLayer(doc, layerId) {
  const layer = requireLayer(doc, layerId);
  assert(layer.type !== 'adjustment', 'LAYER_IS_ADJUSTMENT', 'adjustment layers do not take effects');
  requireStylesAllowed(doc);
  assertEditable(doc, layer, 'all');
  return layer;
}

const masks = () => require('./masks-schema');
const coverageLib = () => require('./coverage');
const IDENTITY = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

function requireMasksAllowed(doc) {
  assert(doc.canvas.compositing === 'v2', 'MASKS_REQUIRE_V2',
    'layer masks and clipping need canvas.compositing "v2"; switch with document.update {canvas:{compositing:"v2"}}');
}

// Document → layer coordinates for a layer's transform (a linked mask lives in layer coordinates).
function layerMatrix(layer) {
  const m = measureCtx();
  m.setTransform(1, 0, 0, 1, 0, 0);
  require('./renderer').applyLayerTransform(m, layer);
  const t = m.getTransform();
  return { a: t.a, b: t.b, c: t.c, d: t.d, e: t.e, f: t.f };
}
const isIdentity = (m) => Math.abs(m.a - 1) < 1e-9 && Math.abs(m.d - 1) < 1e-9 && !m.b && !m.c && !m.e && !m.f;

/** Coverage (Float32, document size) of a program rendered through matrix `m` (document pixels). */
function programCoverage(doc, steps, m) {
  const { renderCoverage, readAlpha } = coverageLib();
  return readAlpha(renderCoverage(steps, doc.canvas.width, doc.canvas.height, m || IDENTITY, 1));
}

function coverageStats(coverage, w, h) {
  let area = 0, x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) {
    const v = coverage[y * w + x];
    if (v <= 0.002) continue;
    area += v;
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  return x1 < 0 ? { empty: true, area: 0, bounds: null }
    : { empty: false, area: Math.round(area), bounds: { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 } };
}

// RGBA pixels (document resolution) of the composite or of one layer alone.
async function samplePixels(ctx, doc, layerId) {
  let source = doc;
  if (layerId) {
    const layer = requireLayer(doc, layerId);
    requireDrawable(doc, layer);
    source = Object.assign({}, doc, {
      canvas: Object.assign({}, doc.canvas, { background: { type: 'none' }, effects: [] }),
      layers: [Object.assign({}, layer, { parentId: undefined, clipped: undefined })],
    });
  }
  const { renderToCanvas } = require('./exporter');
  const { ctx: c } = renderToCanvas(source, { images: await loadImages(ctx, source), applyAnimation: false });
  return c.getImageData(0, 0, doc.canvas.width, doc.canvas.height).data;
}

/**
 * Turn a selection/mask shape request into a stored shape. Pixel-derived shapes (colour range, magic
 * wand, layer transparency) are sampled now and stored as run-length `pixels` (as Photoshop bakes them).
 */
async function resolveShape(ctx, doc, input, field) {
  const W = doc.canvas.width;
  const H = doc.canvas.height;
  const type = input && input.type;
  if (type === 'layerAlpha') {
    const layer = requireLayer(doc, input.layerId);
    requireDrawable(doc, layer);
    // The layer's own pixels: no effects, mask, fill or opacity (Photoshop's "select layer transparency").
    const bare = Object.assign({}, layer, { effects: undefined, mask: undefined, vectorMask: undefined, fillOpacity: undefined,
      opacity: 1, blend: 'source-over', filter: undefined, parentId: undefined, clipped: undefined });
    const alone = Object.assign({}, doc, { canvas: Object.assign({}, doc.canvas, { background: { type: 'none' }, effects: [] }), layers: [bare] });
    const px = await samplePixels(ctx, alone, null);
    const cov = new Float32Array(W * H);
    for (let i = 0; i < cov.length; i += 1) cov[i] = px[i * 4 + 3] / 255;
    return coverageLib().pixelsShape(cov, W, H) || { type: 'rect', x: 0, y: 0, w: 0, h: 0 };
  }
  if (type === 'colorRange') {
    const target = require('./paint').hexToRgb(require('./paint').normalizeColor(input.color, `${field}.color`));
    assert(target, 'INVALID_MASK', `${field}.color must be a #hex or rgb() colour`);
    const fuzziness = input.fuzziness === undefined ? 40 : Number(input.fuzziness);
    assert(Number.isFinite(fuzziness) && fuzziness >= 0 && fuzziness <= 200, 'INVALID_MASK', `${field}.fuzziness must be between 0 and 200`);
    const px = await samplePixels(ctx, doc, input.layerId);
    const cov = new Float32Array(W * H);
    for (let i = 0; i < cov.length; i += 1) {
      if (!px[i * 4 + 3]) continue;
      const d = Math.hypot(px[i * 4] - target.r, px[i * 4 + 1] - target.g, px[i * 4 + 2] - target.b);
      // Fully selected within half the fuzziness, fading to unselected at the full fuzziness.
      cov[i] = d <= fuzziness / 2 ? 1 : fuzziness > 0 ? Math.max(0, (fuzziness - d) / (fuzziness / 2)) : 0;
      cov[i] *= px[i * 4 + 3] / 255;
    }
    return coverageLib().pixelsShape(cov, W, H) || { type: 'rect', x: 0, y: 0, w: 0, h: 0 };
  }
  if (type === 'magicWand') {
    const x = Math.floor(Number(input.x));
    const y = Math.floor(Number(input.y));
    assert(x >= 0 && y >= 0 && x < W && y < H, 'INVALID_MASK', `${field}.x/y must be inside the canvas`);
    const tolerance = input.tolerance === undefined ? 32 : Number(input.tolerance);
    assert(Number.isFinite(tolerance) && tolerance >= 0 && tolerance <= 255, 'INVALID_MASK', `${field}.tolerance must be between 0 and 255`);
    const px = await samplePixels(ctx, doc, input.layerId);
    const seed = (y * W + x) * 4;
    const near = (i) => Math.abs(px[i * 4] - px[seed]) <= tolerance && Math.abs(px[i * 4 + 1] - px[seed + 1]) <= tolerance
      && Math.abs(px[i * 4 + 2] - px[seed + 2]) <= tolerance && Math.abs(px[i * 4 + 3] - px[seed + 3]) <= tolerance;
    const cov = new Float32Array(W * H);
    if (input.contiguous === false) {
      for (let i = 0; i < cov.length; i += 1) if (near(i)) cov[i] = 1;
    } else {
      // 4-connected flood fill from the clicked pixel.
      const stack = [y * W + x];
      cov[y * W + x] = 1;
      while (stack.length) {
        const i = stack.pop();
        const cx = i % W;
        const cy = (i - cx) / W;
        for (const j of [cx > 0 ? i - 1 : -1, cx < W - 1 ? i + 1 : -1, cy > 0 ? i - W : -1, cy < H - 1 ? i + W : -1]) {
          if (j >= 0 && !cov[j] && near(j)) { cov[j] = 1; stack.push(j); }
        }
      }
    }
    return coverageLib().pixelsShape(cov, W, H) || { type: 'rect', x: 0, y: 0, w: 0, h: 0 };
  }
  return masks().normalizeShape(input, field);
}

function selectionCoverageOrFail(ctx, doc) {
  const steps = ctx.store.getSelection(doc.id);
  assert(steps && steps.length, 'NO_SELECTION', 'there is no active selection; make one with selection.set');
  return steps;
}

/** The active selection as a mask program in `layer`'s coordinates (exact for untransformed layers). */
function selectionAsMaskProgram(ctx, doc, layer, linked) {
  const steps = selectionCoverageOrFail(ctx, doc);
  const m = linked === false ? IDENTITY : layerMatrix(layer);
  if (isIdentity(m)) return JSON.parse(JSON.stringify(steps));
  // Transformed layer: sample the selection on the layer's own pixel grid (document → layer).
  const cov = programCoverage(doc, steps, coverageLib().invertMatrix(m));
  const shape = coverageLib().pixelsShape(cov, doc.canvas.width, doc.canvas.height);
  return shape ? [{ op: 'paint', value: 1, shape }] : [];
}

function requireMaskTarget(doc, layerId) {
  const layer = requireLayer(doc, layerId);
  requireMasksAllowed(doc);
  assertEditable(doc, layer, 'content');
  return layer;
}

const maskKey = (kind) => {
  const k = kind === undefined ? 'raster' : kind;
  assert(k === 'raster' || k === 'vector', 'INVALID_MASK', 'kind must be raster or vector', { received: kind });
  return k === 'raster' ? 'mask' : 'vectorMask';
};

function requireEffect(layer, effectId) {
  const index = (layer.effects || []).findIndex((e) => e.id === effectId);
  assert(index >= 0, 'EFFECT_NOT_FOUND', `effect not found: ${effectId}`, { known: (layer.effects || []).map((e) => ({ id: e.id, type: e.type })) });
  return index;
}

// Optional destination parent: undefined = keep/root, null or '' = root, otherwise a group id.
function resolveParent(doc, parentId) {
  if (parentId === undefined || parentId === null || parentId === '') return null;
  const parent = requireLayer(doc, parentId);
  assert(tree.isGroup(parent), 'INVALID_PARENT', `"${parent.name}" is not a group`, { parentId });
  requireGroupsAllowed(doc);
  return parent;
}

function layerSummary(doc, layer) {
  const out = {
    index: doc.layers.indexOf(layer),
    id: layer.id,
    type: tree.isGroup(layer) ? 'group' : 'layer',
    name: layer.name,
    parentId: layer.parentId || null,
    depth: tree.ancestors(doc.layers, layer).length,
    siblingIndex: tree.siblingIndex(doc.layers, layer),
    visible: layer.visible,
    effectiveVisible: tree.effectiveVisible(doc.layers, layer),
    locked: layer.locked,
    locks: layer.locks || {},
    effectiveLocked: tree.effectiveLocked(doc.layers, layer),
    effectiveLocks: effectiveLocks(doc, layer),
    opacity: layer.opacity,
    blend: layer.blend,
    objects: layer.objects.length,
  };
  if (tree.isGroup(layer)) out.children = tree.childrenOf(doc.layers, layer.id).map((l) => l.id);
  const maskInfo = (m, kind) => m && { kind, enabled: m.enabled, invert: m.invert, density: m.density, feather: m.feather, linked: m.linked,
    steps: m.program ? m.program.length : undefined, shapes: m.shapes ? m.shapes.length : undefined };
  if (layer.mask) out.mask = maskInfo(layer.mask, 'raster');
  if (layer.vectorMask) out.vectorMask = maskInfo(layer.vectorMask, 'vector');
  if (layer.clipped) out.clipped = true;
  if (layer.raster) out.raster = { tiles: Object.keys(layer.raster.tiles).length };
  if (layer.type === 'adjustment') { out.type = 'adjustment'; out.adjustment = layer.adjustment.kind; }
  if (layer.filters) out.filters = layer.filters.map((f) => f.type);
  return out;
}

// Deep copy of a layer or group subtree with fresh layer and object ids, parent links remapped.
function cloneSubtree(doc, root, name) {
  const ids = new Map();
  const members = [root].concat(doc.layers.filter((l) => tree.descendantIds(doc.layers, root.id).has(l.id)));
  const copies = members.map((layer) => {
    const copy = JSON.parse(JSON.stringify(layer));
    copy.id = makeId(tree.isGroup(layer) ? 'group' : 'layer');
    ids.set(layer.id, copy.id);
    copy.objects = copy.objects.map((object) => Object.assign({}, object, { id: makeId('obj') }));
    return copy;
  });
  for (const copy of copies.slice(1)) copy.parentId = ids.get(copy.parentId);
  copies[0].name = name ? String(name) : `${root.name} copy`;
  return copies;
}

function measureCtx() {
  const canvas = createCanvas(8, 8);
  return canvas.getContext('2d');
}

async function respond(ctx, doc, op, extra) {
  const payload = Object.assign({
    documentId: doc.id,
    stats: documentStats(doc),
    revision: ctx.store.revision(doc.id),
    op,
  }, extra || {});
  return payload;
}

function withHistory(ctx, doc) {
  if (ctx.journal) ctx.journal.capture(doc.id);
  // Inside a batch, each document gets ONE undo snapshot for the whole batch. A snapshot per operation
  // serialised the growing document every time (quadratic: ~3 ms/op on a 1,400-op building).
  if (ctx.batchHistory) {
    if (ctx.batchHistory.has(doc.id)) return doc;
    ctx.batchHistory.add(doc.id);
  }
  ctx.store.pushHistory(doc.id, ctx.opName);
  return doc;
}

async function loadImages(ctx, doc) {
  return Object.assign(await ctx.assets.loadForDocument(doc),await require('./material-assets').getMaterialAssets(ctx).resolveImages(doc));
}

const OPS = {};

// ---------------------------------------------------------------- documents

OPS['document.create'] = async (params, ctx) => {
  const doc = ctx.store.create({
    name: params.name,
    width: params.width,
    height: params.height,
    background: params.background,
    effects: params.effects,
    lights: params.lights,
    dpi: params.dpi,
    locale: params.locale,
    notes: params.notes,
    createdBy: params.createdBy || 'artforge-api',
    animationDuration: params.animationDuration,
    compositing: params.compositing,
    colorProfile: params.colorProfile,
  });
  return respond(ctx, doc, 'document.create', { document: doc });
};

OPS['document.info'] = async (params, ctx) => {
  const doc = requireDoc(ctx, params.documentId);
  return respond(ctx, doc, 'document.info', {
    document: doc,
    history: ctx.store.historyState(doc.id),
  });
};

OPS['document.list'] = async (params, ctx) => ({ documents: ctx.store.list() });

OPS['document.update'] = async (params, ctx) => {
  const doc = requireDoc(ctx, params.documentId);
  const changes = [];
  withHistory(ctx, doc);
  if (params.name !== undefined) {
    doc.name = String(params.name);
    changes.push('name');
  }
  if (params.canvas) {
    if (params.canvas.width !== undefined) {
      const width = Number(params.canvas.width);
      assert(Number.isFinite(width) && width >= 1 && width <= 8192, 'INVALID_NUMBER',
        'canvas.width must be between 1 and 8192', { received: params.canvas.width });
      doc.canvas.width = Math.round(width);
      changes.push('canvas.width');
    }
    if (params.canvas.height !== undefined) {
      const height = Number(params.canvas.height);
      assert(Number.isFinite(height) && height >= 1 && height <= 8192, 'INVALID_NUMBER',
        'canvas.height must be between 1 and 8192', { received: params.canvas.height });
      doc.canvas.height = Math.round(height);
      changes.push('canvas.height');
    }
    if (params.canvas.effects !== undefined) {
      doc.canvas.effects = require('./effects').normalizeEffects(params.canvas.effects, 'canvas.effects');
      changes.push('canvas.effects');
    }
    if (params.canvas.background !== undefined) {
      doc.canvas.background = normalizeBackground(params.canvas.background);
      changes.push('canvas.background');
    }
    if (params.canvas.colorProfile !== undefined) {
      // Assign (not convert): the same RGB numbers are now read in this colour space.
      require('./color-profiles').requireProfile(params.canvas.colorProfile);
      if (params.canvas.colorProfile === 'srgb') delete doc.canvas.colorProfile; else doc.canvas.colorProfile = params.canvas.colorProfile;
      changes.push('canvas.colorProfile');
    }
    if (params.canvas.grid !== undefined) {
      const grid = require('./document').normalizeGrid(params.canvas.grid);
      if (grid) doc.canvas.grid = grid; else delete doc.canvas.grid;
      changes.push('canvas.grid');
    }
    if (params.canvas.globalLight !== undefined) {
      // Shared light: every effect with useGlobalLight follows it (shadows, inner shadows, bevels).
      const light = schema().normalizeGlobalLight(Object.assign({}, doc.canvas.globalLight || schema().LIGHT, params.canvas.globalLight || {}));
      doc.canvas.globalLight = light;
      changes.push('canvas.globalLight');
    }
    if (params.canvas.compositing !== undefined) {
      // Explicit opt-in/out: switching a legacy document to 'v2' can change how translucent or
      // blended layers with overlapping objects look; undo restores the previous mode.
      const mode = require('./document').normalizeCompositing(params.canvas.compositing, 'v2');
      assert(mode === 'v2' || !doc.layers.some((l) => tree.isGroup(l) || l.parentId), 'GROUPS_REQUIRE_V2',
        'this document has layer groups, which need "v2" compositing; ungroup them first');
      assert(mode === 'v2' || !doc.layers.some((l) => (l.effects && l.effects.length) || l.fillOpacity !== undefined), 'EFFECTS_REQUIRE_V2',
        'this document has layer effects or fill opacity, which need "v2" compositing; remove them first');
      assert(mode === 'v2' || !doc.layers.some((l) => l.mask || l.vectorMask || l.clipped), 'MASKS_REQUIRE_V2',
        'this document has layer masks or clipping, which need "v2" compositing; remove them first');
      doc.canvas.compositing = mode;
      changes.push('canvas.compositing');
    }
  }
  if (params.notes !== undefined) {
    doc.meta.notes = String(params.notes);
    changes.push('meta.notes');
  }
  touch(doc);
  ctx.store.emitChange(doc.id, 'document.update');
  return respond(ctx, doc, 'document.update', { changes, document: doc });
};

OPS['document.save'] = async (params, ctx) => {
  const doc = requireDoc(ctx, params.documentId);
  const saved = ctx.store.save(doc.id, { path: params.path });
  return respond(ctx, doc, 'document.save', saved);
};

OPS['document.open'] = async (params, ctx) => {
  const opened = ctx.store.open(params.path, { replace: Boolean(params.replace) });
  return {
    op: 'document.open',
    documentId: opened.document.id,
    document: opened.document,
    stats: opened.stats,
    sourcePath: opened.sourcePath,
    revision: ctx.store.revision(opened.document.id),
  };
};

OPS['document.import'] = async (params, ctx) => {
  assert(params.document && typeof params.document === 'object', 'INVALID_DESIGN_FILE',
    'document must be a parsed ArtForge design object');
  const opened = ctx.store.openDocument(params.document, { replace: Boolean(params.replace) });
  return {
    op: 'document.import',
    documentId: opened.document.id,
    document: opened.document,
    stats: opened.stats,
    revision: ctx.store.revision(opened.document.id),
  };
};

OPS['document.duplicate'] = async (params, ctx) => {
  const source = requireDoc(ctx, params.documentId);
  const copy = JSON.parse(JSON.stringify(source));
  copy.id = makeId('doc');
  copy.name = params.name ? String(params.name) : `${source.name} copy`;
  copy.meta.createdAt = new Date().toISOString();
  copy.meta.modifiedAt = copy.meta.createdAt;
  ctx.store.documents.set(copy.id, copy);
  ctx.store.revisions.set(copy.id, 1);
  ctx.store.history.set(copy.id, { past: [], future: [] });
  ctx.store.emitChange(copy.id, 'document.duplicate');
  return { op: 'document.duplicate', documentId: copy.id, sourceDocumentId: source.id, stats: documentStats(copy) };
};

OPS['document.delete'] = async (params, ctx) => {
  const doc = requireDoc(ctx, params.documentId);
  return Object.assign({ op: 'document.delete' }, ctx.store.remove(doc.id));
};

OPS['document.preview'] = async (params, ctx) => {
  const doc = requireDoc(ctx, params.documentId);
  const images = await loadImages(ctx, doc);
  const preview = renderPreview(doc, {
    images,
    maxWidth: params.maxWidth || 900,
    time: params.time || 0,
    applyAnimation: params.static ? false : true,
  });
  return respond(ctx, doc, 'document.preview', {
    width: preview.width,
    height: preview.height,
    scale: preview.scale,
    sha256: preview.sha256,
    fromCache: preview.fromCache === true,
    warnings: preview.warnings,
    base64: preview.base64,
    dataUrl: `data:image/png;base64,${preview.base64}`,
  });
};

// ----------------------------------------------------------------- history

OPS['history.undo'] = async (params, ctx) => {
  const doc = requireDoc(ctx, params.documentId);
  const restored = ctx.store.undo(doc.id);
  return respond(ctx, restored, 'history.undo', { document: restored, history: ctx.store.historyState(doc.id) });
};

OPS['history.redo'] = async (params, ctx) => {
  const doc = requireDoc(ctx, params.documentId);
  const restored = ctx.store.redo(doc.id);
  return respond(ctx, restored, 'history.redo', { document: restored, history: ctx.store.historyState(doc.id) });
};

OPS['history.state'] = async (params, ctx) => {
  const doc = requireDoc(ctx, params.documentId);
  return { op: 'history.state', documentId: doc.id, history: ctx.store.historyState(doc.id) };
};

// ------------------------------------------------------------------ layers

OPS['layer.add'] = async (params, ctx) => {
  const doc = requireDoc(ctx, params.documentId);
  withHistory(ctx, doc);
  const layer = normalizeLayer({
    name: params.name,
    visible: params.visible,
    locked: params.locked,
    opacity: params.opacity,
    blend: params.blend,
    transform: params.transform,
    filter: params.filter,
    lights: params.lights,
    locks: params.locks,
    effects: params.effects,
    fillOpacity: params.fillOpacity,
    clipped: params.clipped,
    blendIf: params.blendIf,
    objects: [],
  }, doc.layers.length);
  requireStylesAllowed(doc, layer);
  if (layer.clipped) requireMasksAllowed(doc);
  // index is the position among the destination's layers (0 = bottom); without groups that is the
  // same as the document-wide index used before groups existed.
  const parent = resolveParent(doc, params.parentId);
  const index = tree.insertAt(doc.layers, layer, parent && parent.id, params.index === undefined ? undefined : Number(params.index));
  touch(doc);
  ctx.store.emitChange(doc.id, 'layer.add');
  return respond(ctx, doc, 'layer.add', { layer, layerId: layer.id, index });
};

OPS['layer.list'] = async (params, ctx) => {
  const doc = requireDoc(ctx, params.documentId);
  return {
    op: 'layer.list',
    documentId: doc.id,
    layers: doc.layers.map((layer) => layerSummary(doc, layer)),
  };
};

OPS['layer.update'] = async (params, ctx) => {
  const doc = requireDoc(ctx, params.documentId);
  const layer = requireLayer(doc, params.layerId);
  if (tree.isGroup(layer)) {
    const unsupported = ['filter', 'lights', 'transform', 'fillOpacity', 'clipped', 'blendIf'].filter((k) => params[k] !== undefined);
    assert(!unsupported.length, 'GROUP_FIELD_UNSUPPORTED',
      `groups do not support ${unsupported.join(', ')} yet; set them on the layers inside`, { fields: unsupported });
  }
  // Name, visibility and the locks themselves stay editable on a locked layer (as in Photoshop's
  // layers panel). Another change is refused only if the layer's locks forbid it both before and
  // after this call: one call can unlock-and-edit or edit-and-lock; locks inherited from groups hold.
  const nextLocks = params.locks === undefined ? layer.locks
    : require('./document').normalizeLocks(Object.assign({}, layer.locks || {}, params.locks), 'layer');
  const probe = Object.assign({}, layer, {
    locked: params.locked === undefined ? layer.locked : Boolean(params.locked), locks: nextLocks });
  const probeDoc = { layers: doc.layers.map((l) => (l === layer ? probe : l)) };
  const allowedBeforeOrAfter = (kind) => {
    try { assertEditable(doc, layer, kind); } catch (before) { assertEditable(probeDoc, probe, kind); }
  };
  if (params.transform !== undefined) allowedBeforeOrAfter('position');
  if (['opacity', 'blend', 'filter', 'lights', 'effects', 'fillOpacity', 'clipped', 'blendIf'].some((k) => params[k] !== undefined)) allowedBeforeOrAfter('all');
  const nextBlendIf = params.blendIf === undefined || params.blendIf === null ? undefined : require('./document').normalizeBlendIf(params.blendIf, 'layer');
  if (nextBlendIf) requireStylesAllowed(doc);
  if (params.clipped) requireMasksAllowed(doc);
  const nextEffects = params.effects === undefined ? undefined : schema().normalizeEffectList(params.effects, 'layer');
  if (params.fillOpacity !== undefined) {
    const fill = Number(params.fillOpacity);
    assert(Number.isFinite(fill) && fill >= 0 && fill <= 1, 'INVALID_NUMBER', 'fillOpacity must be between 0 and 1', { received: params.fillOpacity });
  }
  if ((nextEffects && nextEffects.length) || (params.fillOpacity !== undefined && Number(params.fillOpacity) < 1)) requireStylesAllowed(doc);
  withHistory(ctx, doc);
  const changes = [];
  if (params.name !== undefined) { layer.name = String(params.name); changes.push('name'); }
  if (params.visible !== undefined) { layer.visible = Boolean(params.visible); changes.push('visible'); }
  if (params.locked !== undefined) { layer.locked = Boolean(params.locked); changes.push('locked'); }
  if (params.locks !== undefined) {
    if (nextLocks) layer.locks = nextLocks; else delete layer.locks;
    changes.push('locks');
  }
  if (params.effects !== undefined) {
    if (nextEffects) layer.effects = nextEffects; else delete layer.effects;
    changes.push('effects');
  }
  if (params.fillOpacity !== undefined) {
    if (Number(params.fillOpacity) === 1) delete layer.fillOpacity; else layer.fillOpacity = Number(params.fillOpacity);
    changes.push('fillOpacity');
  }
  if (params.clipped !== undefined) {
    if (params.clipped) layer.clipped = true; else delete layer.clipped;
    changes.push('clipped');
  }
  if (params.blendIf !== undefined) {
    if (nextBlendIf) layer.blendIf = nextBlendIf; else delete layer.blendIf;
    changes.push('blendIf');
  }
  if (params.opacity !== undefined) {
    const opacity = Number(params.opacity);
    assert(Number.isFinite(opacity) && opacity >= 0 && opacity <= 1, 'INVALID_NUMBER',
      'opacity must be between 0 and 1', { received: params.opacity });
    layer.opacity = opacity;
    changes.push('opacity');
  }
  if (params.blend !== undefined) {
    layer.blend = normalizeLayer(Object.assign({}, layer, { blend: params.blend }), 0).blend;
    changes.push('blend');
  }
  if (params.filter !== undefined) {
    layer.filter = require('./effects').normalizeLayerFilter(params.filter, 'layer');
    changes.push('filter');
  }
  if (params.lights !== undefined) {
    layer.lights = require('./lighting').normalizeLights(params.lights, 'layer.lights');
    changes.push('lights');
  }
  if (params.transform !== undefined) {
    layer.transform = normalizeTransform(Object.assign({}, layer.transform, params.transform), 'layer.transform');
    changes.push('transform');
  }
  touch(doc);
  ctx.store.emitChange(doc.id, 'layer.update');
  return respond(ctx, doc, 'layer.update', { layer, changes });
};

OPS['layer.move'] = async (params, ctx) => {
  const doc = requireDoc(ctx, params.documentId);
  const layer = requireLayer(doc, params.layerId);
  // parentId: omitted = stay in the current parent; null/'' = document root; otherwise a group id.
  const parent = params.parentId === undefined ? (tree.parentOf(doc.layers, layer)) : resolveParent(doc, params.parentId);
  const parentId = parent ? parent.id : null;
  assert(parentId !== layer.id && !tree.descendantIds(doc.layers, layer.id).has(parentId), 'GROUP_CYCLE',
    'a group cannot be moved inside itself', { layerId: layer.id, parentId });
  const from = tree.siblingIndex(doc.layers, layer);
  const fromParentId = layer.parentId || null;
  // Index among the destination's other layers (0 = bottom). Without groups this is the same range
  // as the document-wide index (0 … layers − 1) used before groups existed.
  const destinationCount = tree.childrenOf(doc.layers, parentId).filter((l) => l !== layer).length;
  const to = Number(params.index);
  assert(Number.isInteger(to) && to >= 0 && to <= destinationCount, 'INVALID_INDEX',
    `index must be between 0 and ${destinationCount} among the destination's layers`, { received: params.index });
  // Rehearse on a copy so a depth violation is refused before anything changes.
  const rehearsal = doc.layers.map((l) => Object.assign({}, l));
  const moved = rehearsal.find((l) => l.id === layer.id);
  rehearsal.splice(rehearsal.indexOf(moved), 1);
  tree.insertAt(rehearsal, moved, parentId, to);
  tree.validateTree(rehearsal);
  withHistory(ctx, doc);
  doc.layers.splice(doc.layers.indexOf(layer), 1);
  tree.insertAt(doc.layers, layer, parentId, to);
  touch(doc);
  ctx.store.emitChange(doc.id, 'layer.move');
  return respond(ctx, doc, 'layer.move', { layerId: layer.id, from, to, fromParentId, parentId });
};

OPS['layer.delete'] = async (params, ctx) => {
  const doc = requireDoc(ctx, params.documentId);
  const layer = requireLayer(doc, params.layerId);
  // Deleting a group deletes everything inside it (as in Photoshop); use group.ungroup to keep the contents.
  const removed = new Set([layer.id, ...tree.descendantIds(doc.layers, layer.id)]);
  assert(doc.layers.some((l) => !removed.has(l.id) && !tree.isGroup(l)), 'LAST_LAYER',
    'a document must keep at least one drawable layer');
  withHistory(ctx, doc);
  doc.layers.splice(0, doc.layers.length, ...doc.layers.filter((l) => !removed.has(l.id)));
  touch(doc);
  ctx.store.emitChange(doc.id, 'layer.delete');
  return respond(ctx, doc, 'layer.delete', { removed: layer.id, removedIds: [...removed] });
};

OPS['layer.duplicate'] = async (params, ctx) => {
  const doc = requireDoc(ctx, params.documentId);
  const layer = requireLayer(doc, params.layerId);
  withHistory(ctx, doc);
  const copies = cloneSubtree(doc, layer, params.name);
  const copy = copies[0];
  // Copies of descendants go in first (as children of the copied group), then the copy itself is
  // placed directly above the original among its siblings.
  for (const child of copies.slice(1)) doc.layers.push(child);
  const index = tree.insertAt(doc.layers, copy, layer.parentId || null, tree.siblingIndex(doc.layers, layer) + 1);
  touch(doc);
  ctx.store.emitChange(doc.id, 'layer.duplicate');
  return respond(ctx, doc, 'layer.duplicate', { layer: copy, layerId: copy.id, index });
};

// ------------------------------------------------------------------ groups

// Put `group` into `layers`: around `ids` (siblings, kept in order, group takes the topmost one's place)
// or, with no ids, as an empty group at `index` in `parentId`. Works on any layers array so it can be
// rehearsed on a copy before the document changes.
function placeGroup(layers, group, ids, parentId, index) {
  if (!ids.length) return tree.insertAt(layers, group, parentId, index);
  const members = layers.filter((l) => ids.includes(l.id));
  const top = members[members.length - 1];
  const position = tree.siblingIndex(layers, top) + 1;
  tree.insertAt(layers, group, parentId, position);
  for (const member of members) member.parentId = group.id;
  tree.canonicalize(layers);
  return tree.siblingIndex(layers, group);
}

OPS['group.create'] = async (params, ctx) => {
  const doc = requireDoc(ctx, params.documentId);
  requireGroupsAllowed(doc);
  const ids = Array.isArray(params.layerIds) ? [...new Set(params.layerIds.map(String))] : [];
  assert(params.layerIds === undefined || Array.isArray(params.layerIds), 'INVALID_LAYER_IDS', 'layerIds must be an array of layer ids');
  const members = ids.map((id) => requireLayer(doc, id));
  let parentId = params.parentId === undefined ? undefined : (resolveParent(doc, params.parentId) || { id: null }).id;
  if (members.length) {
    const parents = new Set(members.map((l) => l.parentId || null));
    assert(parents.size === 1, 'LAYERS_NOT_SIBLINGS', 'layerIds must all be in the same group (or all at the root)',
      { parents: [...parents] });
    const shared = [...parents][0];
    assert(parentId === undefined || parentId === shared, 'INVALID_PARENT',
      'parentId must match the parent of layerIds (layers are grouped where they are)', { parentId, actual: shared });
    parentId = shared;
    assert(params.index === undefined, 'INVALID_INDEX', 'index is not used with layerIds: the group takes the place of the topmost layer');
  }
  const group = normalizeLayer({ type: 'group', name: params.name, opacity: params.opacity, blend: params.blend,
    visible: params.visible, locked: params.locked, locks: params.locks }, doc.layers.length);
  const index = params.index === undefined ? undefined : Number(params.index);
  // Rehearse on copies: nesting limits are checked before anything changes.
  const rehearsal = doc.layers.map((l) => Object.assign({}, l));
  placeGroup(rehearsal, Object.assign({}, group), ids, parentId || null, index);
  tree.validateTree(rehearsal);
  withHistory(ctx, doc);
  const position = placeGroup(doc.layers, group, ids, parentId || null, index);
  touch(doc);
  ctx.store.emitChange(doc.id, 'group.create');
  return respond(ctx, doc, 'group.create', { group, groupId: group.id, childIds: ids, parentId: parentId || null, index: position });
};

OPS['group.ungroup'] = async (params, ctx) => {
  const doc = requireDoc(ctx, params.documentId);
  const group = requireLayer(doc, params.groupId);
  assert(tree.isGroup(group), 'NOT_A_GROUP', `"${group.name}" is not a group`, { groupId: group.id });
  assertUnlocked(doc, group);
  const children = tree.childrenOf(doc.layers, group.id);
  // The group's own opacity, blend and visibility apply to nothing once it is gone (Photoshop does
  // the same); report them so a caller can tell the picture may change.
  const discarded = {};
  if (group.opacity < 1) discarded.opacity = group.opacity;
  if (group.blend !== 'pass-through') discarded.blend = group.blend;
  if (group.visible === false) discarded.visible = false;
  withHistory(ctx, doc);
  for (const child of children) {
    if (group.parentId) child.parentId = group.parentId; else delete child.parentId;
  }
  // Children already sit directly below the group entry, so removing it leaves them in its place.
  doc.layers.splice(doc.layers.indexOf(group), 1);
  tree.canonicalize(doc.layers);
  touch(doc);
  ctx.store.emitChange(doc.id, 'group.ungroup');
  return respond(ctx, doc, 'group.ungroup', {
    removed: group.id, childIds: children.map((l) => l.id), parentId: group.parentId || null,
    discarded, appearanceMayChange: Object.keys(discarded).length > 0,
  });
};

// ------------------------------------------------------------ layer styles

OPS['effect.list'] = async () => ({
  op: 'effect.list',
  types: schema().TYPES.map((type) => ({ type, defaults: schema().DEFAULTS[type] })),
  presets: schema().PRESETS,
  order: require('./layer-styles').ORDER,
  globalLightDefault: schema().LIGHT,
});

OPS['effect.add'] = async (params, ctx) => {
  const doc = requireDoc(ctx, params.documentId);
  const layer = requireStyledLayer(doc, params.layerId);
  const effect = schema().normalizeEffect(params.effect, 'effect');
  const list = (layer.effects || []).slice();
  assert(!list.some((e) => e.id === effect.id), 'INVALID_EFFECT', `effect id already used on this layer: ${effect.id}`);
  const index = params.index === undefined ? list.length : Number(params.index);
  assert(Number.isInteger(index) && index >= 0 && index <= list.length, 'INVALID_INDEX', `index must be between 0 and ${list.length}`, { received: params.index });
  list.splice(index, 0, effect);
  const next = schema().normalizeEffectList(list, 'layer');
  withHistory(ctx, doc);
  layer.effects = next;
  touch(doc);
  ctx.store.emitChange(doc.id, 'effect.add');
  return respond(ctx, doc, 'effect.add', { layerId: layer.id, effectId: effect.id, effect, index, effects: layer.effects });
};

OPS['effect.update'] = async (params, ctx) => {
  const doc = requireDoc(ctx, params.documentId);
  const layer = requireStyledLayer(doc, params.layerId);
  const index = requireEffect(layer, params.effectId);
  assert(params.patch && typeof params.patch === 'object', 'INVALID_PATCH', 'patch is required');
  const current = layer.effects[index];
  assert(params.patch.type === undefined || params.patch.type === current.type, 'INVALID_PATCH', 'an effect cannot change type; remove it and add another');
  const effect = schema().normalizeEffect(Object.assign({}, current, params.patch, { id: current.id, type: current.type }), 'effect');
  withHistory(ctx, doc);
  layer.effects[index] = effect;
  touch(doc);
  ctx.store.emitChange(doc.id, 'effect.update');
  return respond(ctx, doc, 'effect.update', { layerId: layer.id, effectId: effect.id, effect, changes: Object.keys(params.patch) });
};

OPS['effect.remove'] = async (params, ctx) => {
  const doc = requireDoc(ctx, params.documentId);
  const layer = requireStyledLayer(doc, params.layerId);
  const index = requireEffect(layer, params.effectId);
  withHistory(ctx, doc);
  const [removed] = layer.effects.splice(index, 1);
  if (!layer.effects.length) delete layer.effects;
  touch(doc);
  ctx.store.emitChange(doc.id, 'effect.remove');
  return respond(ctx, doc, 'effect.remove', { layerId: layer.id, removed: removed.id });
};

OPS['effect.move'] = async (params, ctx) => {
  const doc = requireDoc(ctx, params.documentId);
  const layer = requireStyledLayer(doc, params.layerId);
  const from = requireEffect(layer, params.effectId);
  const to = Number(params.index);
  assert(Number.isInteger(to) && to >= 0 && to < layer.effects.length, 'INVALID_INDEX', `index must be between 0 and ${layer.effects.length - 1}`, { received: params.index });
  withHistory(ctx, doc);
  const [effect] = layer.effects.splice(from, 1);
  layer.effects.splice(to, 0, effect);
  touch(doc);
  ctx.store.emitChange(doc.id, 'effect.move');
  // Paint order is fixed by type; list order decides only among effects of the same type.
  return respond(ctx, doc, 'effect.move', { layerId: layer.id, effectId: effect.id, from, to });
};

OPS['effect.applyPreset'] = async (params, ctx) => {
  const doc = requireDoc(ctx, params.documentId);
  const layer = requireStyledLayer(doc, params.layerId);
  const mode = params.mode || 'replace';
  assert(['replace', 'append'].includes(mode), 'INVALID_PRESET', 'mode must be replace or append', { received: params.mode });
  const added = schema().presetEffects(params.preset, params.color, 'preset');
  const next = schema().normalizeEffectList((mode === 'append' ? (layer.effects || []) : []).concat(added), 'layer');
  withHistory(ctx, doc);
  layer.effects = next;
  touch(doc);
  ctx.store.emitChange(doc.id, 'effect.applyPreset');
  return respond(ctx, doc, 'effect.applyPreset', { layerId: layer.id, preset: params.preset, effectIds: added.map((e) => e.id), effects: layer.effects });
};

// ------------------------------------------------------- selections and masks

async function selectionResponse(ctx, doc, op, extra) {
  const steps = ctx.store.getSelection(doc.id);
  const stats = steps ? coverageStats(programCoverage(doc, steps), doc.canvas.width, doc.canvas.height) : { empty: true, area: 0, bounds: null };
  return Object.assign({ op, documentId: doc.id, selection: Object.assign({ steps: steps ? steps.length : 0 }, stats) }, extra || {});
}

OPS['selection.set'] = async (params, ctx) => {
  const doc = requireDoc(ctx, params.documentId);
  const mode = params.mode || 'replace';
  assert(['replace', 'add', 'subtract', 'intersect'].includes(mode), 'INVALID_MASK', 'mode must be replace, add, subtract or intersect', { received: params.mode });
  const shape = await resolveShape(ctx, doc, params.shape, 'shape');
  const step = mode === 'intersect' ? { op: 'intersect', shape } : { op: 'paint', value: mode === 'subtract' ? 0 : 1, shape };
  if (params.feather !== undefined) step.feather = params.feather;
  const current = ctx.store.getSelection(doc.id) || [];
  const next = masks().normalizeProgram(mode === 'replace' ? [step] : current.concat([step]), 'selection');
  ctx.store.setSelection(doc.id, next);
  return selectionResponse(ctx, doc, 'selection.set', { mode, shapeType: shape.type });
};

OPS['selection.modify'] = async (params, ctx) => {
  const doc = requireDoc(ctx, params.documentId);
  const steps = selectionCoverageOrFail(ctx, doc);
  const step = masks().normalizeStep(params.modify === 'invert' ? { op: 'invert' } : { op: params.modify, radius: params.radius }, 'modify');
  assert(step.op !== 'paint' && step.op !== 'intersect', 'INVALID_MASK', 'modify must be invert, feather, grow, shrink or smooth');
  ctx.store.setSelection(doc.id, masks().normalizeProgram(steps.concat([step]), 'selection'));
  return selectionResponse(ctx, doc, 'selection.modify', { modify: step.op });
};

OPS['selection.info'] = async (params, ctx) => {
  const doc = requireDoc(ctx, params.documentId);
  return selectionResponse(ctx, doc, 'selection.info', { program: ctx.store.getSelection(doc.id) || [] });
};

OPS['selection.clear'] = async (params, ctx) => {
  const doc = requireDoc(ctx, params.documentId);
  ctx.store.setSelection(doc.id, null);
  return selectionResponse(ctx, doc, 'selection.clear');
};

OPS['mask.create'] = async (params, ctx) => {
  const doc = requireDoc(ctx, params.documentId);
  const layer = requireMaskTarget(doc, params.layerId);
  const key = maskKey(params.kind);
  assert(!layer[key], 'MASK_EXISTS', `layer "${layer.name}" already has a ${params.kind || 'raster'} mask; use mask.update, mask.paint or mask.delete`);
  const settings = { enabled: params.enabled, invert: params.invert, density: params.density, feather: params.feather, linked: params.linked };
  let mask;
  if (key === 'mask') {
    const from = params.from || 'reveal';
    assert(['reveal', 'hide', 'selection'].includes(from), 'INVALID_MASK', 'from must be reveal, hide or selection', { received: params.from });
    const program = from === 'selection' ? selectionAsMaskProgram(ctx, doc, layer, params.linked)
      : [{ op: 'paint', value: from === 'reveal' ? 1 : 0, shape: { type: 'all' } }];
    mask = masks().normalizeMask(Object.assign(settings, { program }), 'mask');
  } else {
    mask = masks().normalizeVectorMask(Object.assign(settings, { shapes: params.shapes }), 'vectorMask');
  }
  withHistory(ctx, doc);
  layer[key] = mask;
  touch(doc);
  ctx.store.emitChange(doc.id, 'mask.create');
  return respond(ctx, doc, 'mask.create', { layerId: layer.id, kind: key === 'mask' ? 'raster' : 'vector', mask });
};

OPS['mask.paint'] = async (params, ctx) => {
  const doc = requireDoc(ctx, params.documentId);
  const layer = requireMaskTarget(doc, params.layerId);
  assert(layer.mask, 'NO_MASK', `layer "${layer.name}" has no raster mask; create one with mask.create`);
  assert(params.value !== undefined, 'INVALID_MASK', 'value is required: 0 hides (black), 1 reveals (white), between is grey');
  let shape;
  if (params.shape && params.shape.type === 'selection') {
    // Fill the selection with `value`: sample it on the mask's grid (layer coordinates when linked).
    const m = layer.mask.linked === false ? IDENTITY : layerMatrix(layer);
    const cov = programCoverage(doc, selectionCoverageOrFail(ctx, doc), isIdentity(m) ? IDENTITY : coverageLib().invertMatrix(m));
    shape = coverageLib().pixelsShape(cov, doc.canvas.width, doc.canvas.height);
  } else {
    shape = await resolveShape(ctx, doc, params.shape, 'shape');
  }
  const added = shape ? [{ op: 'paint', value: params.value, shape, feather: params.feather }] : [];
  const program = masks().normalizeProgram(layer.mask.program.concat(added), 'mask.program');
  withHistory(ctx, doc);
  layer.mask.program = program;
  touch(doc);
  ctx.store.emitChange(doc.id, 'mask.paint');
  return respond(ctx, doc, 'mask.paint', { layerId: layer.id, steps: program.length });
};

OPS['mask.update'] = async (params, ctx) => {
  const doc = requireDoc(ctx, params.documentId);
  const layer = requireMaskTarget(doc, params.layerId);
  const key = maskKey(params.kind);
  assert(layer[key], 'NO_MASK', `layer "${layer.name}" has no ${params.kind || 'raster'} mask`);
  const patch = {};
  for (const k of ['enabled', 'invert', 'density', 'feather', 'linked']) if (params[k] !== undefined) patch[k] = params[k];
  if (key === 'mask' && params.program !== undefined) patch.program = params.program;
  if (key === 'vectorMask' && params.shapes !== undefined) patch.shapes = params.shapes;
  const merged = Object.assign({}, layer[key], patch);
  const next = key === 'mask' ? masks().normalizeMask(merged, 'mask') : masks().normalizeVectorMask(merged, 'vectorMask');
  withHistory(ctx, doc);
  layer[key] = next;
  touch(doc);
  ctx.store.emitChange(doc.id, 'mask.update');
  return respond(ctx, doc, 'mask.update', { layerId: layer.id, kind: key === 'mask' ? 'raster' : 'vector', changes: Object.keys(patch), mask: next });
};

OPS['mask.delete'] = async (params, ctx) => {
  const doc = requireDoc(ctx, params.documentId);
  const layer = requireMaskTarget(doc, params.layerId);
  const key = maskKey(params.kind);
  assert(layer[key], 'NO_MASK', `layer "${layer.name}" has no ${params.kind || 'raster'} mask`);
  withHistory(ctx, doc);
  delete layer[key];
  touch(doc);
  ctx.store.emitChange(doc.id, 'mask.delete');
  return respond(ctx, doc, 'mask.delete', { layerId: layer.id, kind: key === 'mask' ? 'raster' : 'vector' });
};

/**
 * Destructive by request: bake the layer's masks into its content. The layer's objects become one image
 * (at `scale` × document resolution) with the masks applied; effects, opacity, blend and filter stay live.
 * Undo restores the objects and masks; the image asset is kept on disk.
 */
OPS['mask.apply'] = async (params, ctx) => {
  const doc = requireDoc(ctx, params.documentId);
  const layer = requireMaskTarget(doc, params.layerId);
  requireDrawable(doc, layer);
  assert(layer.mask || layer.vectorMask, 'NO_MASK', `layer "${layer.name}" has no mask to apply`);
  const scale = params.scale === undefined ? 1 : Number(params.scale);
  assert(Number.isFinite(scale) && scale >= 1 && scale <= 4, 'INVALID_SCALE', 'scale must be between 1 and 4');
  const bare = Object.assign({}, layer, { effects: undefined, fillOpacity: undefined, filter: undefined, opacity: 1, blend: 'source-over', parentId: undefined, clipped: undefined });
  const single = Object.assign({}, doc, { canvas: Object.assign({}, doc.canvas, { background: { type: 'none' }, effects: [] }), layers: [bare] });
  const { renderToCanvas } = require('./exporter');
  const { canvas } = renderToCanvas(single, { images: await loadImages(ctx, single), applyAnimation: false, scale });
  const asset = await ctx.assets.addFromDataUrl(`data:image/png;base64,${canvas.toBuffer('image/png').toString('base64')}`, { name: `mask-applied:${layer.name}` });
  withHistory(ctx, doc);
  layer.objects = [normalizeObject({ type: 'image', assetId: asset.id, x: 0, y: 0, w: doc.canvas.width, h: doc.canvas.height, name: `${layer.name} (mask applied)` }, 'object')];
  layer.transform = normalizeTransform({}, 'layer.transform');
  delete layer.mask;
  delete layer.vectorMask;
  touch(doc);
  ctx.store.emitChange(doc.id, 'mask.apply');
  return respond(ctx, doc, 'mask.apply', { layerId: layer.id, assetId: asset.id, objectId: layer.objects[0].id, scale, destructive: true });
};

// --------------------------------------------------------- paths and geometry

const pathEdit = () => require('./path-edit');
const pathBool = () => require('./path-boolean');

const mul = (m, n) => ({
  a: m.a * n.a + m.c * n.b, b: m.b * n.a + m.d * n.b,
  c: m.a * n.c + m.c * n.d, d: m.b * n.c + m.d * n.d,
  e: m.a * n.e + m.c * n.f + m.e, f: m.b * n.e + m.d * n.f + m.f,
});

// Object space → document space: the layer transform, then the object's own rotation about its box centre.
function objectMatrix(doc, found) {
  const layerM = layerMatrix(found.layer);
  const deg = Number(found.object.rotation || 0);
  if (!deg || found.object.type === 'text') return layerM;
  const box = bboxOf(Object.assign({}, found.object, { rotation: 0 }), measureCtx());
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  const r = deg * Math.PI / 180;
  const rot = { a: Math.cos(r), b: Math.sin(r), c: -Math.sin(r), d: Math.cos(r), e: 0, f: 0 };
  const about = mul(mul({ a: 1, b: 0, c: 0, d: 1, e: cx, f: cy }, rot), { a: 1, b: 0, c: 0, d: 1, e: -cx, f: -cy });
  return mul(layerM, about);
}

function requirePathObject(doc, objectId) {
  const found = requireObject(doc, objectId);
  assert(found.object.type === 'path', 'NOT_A_PATH', `object ${objectId} is a ${found.object.type}; anchor editing works on path objects (convert shapes with path.boolean or draw.path)`);
  assertEditable(doc, found.layer, 'content');
  return found;
}

function replaceSegments(ctx, doc, found, segments, op) {
  // Editing anchors detaches a parametric shape: it becomes a plain vector path.
  const next = normalizeObject(Object.assign({}, found.object, { segments, shape: undefined }), 'object');
  withHistory(ctx, doc);
  found.layer.objects[found.objectIndex] = next;
  touch(doc);
  ctx.store.emitChange(doc.id, op);
  return respond(ctx, doc, op, { objectId: next.id, anchors: pathEdit().listAnchors(next.segments) });
}

OPS['path.anchors'] = async (params, ctx) => {
  const doc = requireDoc(ctx, params.documentId);
  const found = requireObject(doc, params.objectId);
  assert(found.object.type === 'path', 'NOT_A_PATH', `object ${params.objectId} is a ${found.object.type}, not a path`);
  return { op: 'path.anchors', documentId: doc.id, objectId: found.object.id, anchors: pathEdit().listAnchors(found.object.segments) };
};

OPS['path.updateAnchor'] = async (params, ctx) => {
  const doc = requireDoc(ctx, params.documentId);
  const found = requirePathObject(doc, params.objectId);
  const segments = pathEdit().updateAnchor(found.object.segments, Number(params.index),
    { x: params.x, y: params.y, in: params.in, out: params.out, keepSmooth: params.keepSmooth });
  return replaceSegments(ctx, doc, found, segments, 'path.updateAnchor');
};

OPS['path.addAnchor'] = async (params, ctx) => {
  const doc = requireDoc(ctx, params.documentId);
  const found = requirePathObject(doc, params.objectId);
  return replaceSegments(ctx, doc, found, pathEdit().addAnchor(found.object.segments, Number(params.segment), params.t), 'path.addAnchor');
};

OPS['path.deleteAnchor'] = async (params, ctx) => {
  const doc = requireDoc(ctx, params.documentId);
  const found = requirePathObject(doc, params.objectId);
  return replaceSegments(ctx, doc, found, pathEdit().deleteAnchor(found.object.segments, Number(params.index)), 'path.deleteAnchor');
};

OPS['path.convertAnchor'] = async (params, ctx) => {
  const doc = requireDoc(ctx, params.documentId);
  const found = requirePathObject(doc, params.objectId);
  return replaceSegments(ctx, doc, found, pathEdit().convertAnchor(found.object.segments, Number(params.index), params.type), 'path.convertAnchor');
};

// Style of the new path: everything except geometry, taken from the source object.
const GEOMETRY_KEYS = ['shape', 'x', 'y', 'w', 'h', 'radius', 'points', 'segments', 'closed', 'rotation', 'x1', 'y1', 'x2', 'y2', 'text', 'font', 'align', 'maxWidth', 'lineHeight', 'rtl', 'baseline', 'assetId', 'fit', 'flipX', 'flipY', 'arrow', 'clip'];
function styleOf(object) {
  const out = {};
  for (const [k, v] of Object.entries(object)) if (!GEOMETRY_KEYS.includes(k) && k !== 'id' && k !== 'type') out[k] = v;
  return out;
}

/**
 * Boolean shape building (Photoshop/Illustrator Pathfinder): union, subtract (first minus the rest),
 * intersect, exclude. Exact on curves (Skia PathOps). The result is one path in the first object's layer
 * and z-position with its style; sources are removed unless keepOriginals.
 */
OPS['path.boolean'] = async (params, ctx) => {
  const doc = requireDoc(ctx, params.documentId);
  assert(Array.isArray(params.objectIds) && params.objectIds.length >= 2, 'INVALID_OBJECT_IDS', 'objectIds needs at least two shapes');
  const founds = params.objectIds.map((id) => requireObject(doc, id));
  assert(new Set(founds.map((f) => f.object.id)).size === founds.length, 'INVALID_OBJECT_IDS', 'objectIds must be distinct');
  for (const f of founds) assertEditable(doc, f.layer, 'content');
  const target = founds[0];
  requireDrawable(doc, target.layer);
  const items = founds.map((f) => ({ segments: pathBool().objectSegments(f.object), matrix: objectMatrix(doc, f) }));
  const toTarget = coverageLib().invertMatrix(layerMatrix(target.layer));
  const segments = pathBool().combine(items, params.op, toTarget);
  assert(segments.length >= 2, 'EMPTY_RESULT', `the ${params.op} of these shapes is empty`, { op: params.op });
  const result = normalizeObject(Object.assign(styleOf(target.object), { type: 'path', segments, closed: true, name: params.name || `${params.op} of ${founds.length} shapes` }), 'object');
  withHistory(ctx, doc);
  const index = target.layer.objects.indexOf(target.object);
  target.layer.objects.splice(index, 0, result);
  if (!params.keepOriginals) {
    const remove = new Set(founds.map((f) => f.object.id));
    for (const layer of doc.layers) layer.objects = layer.objects.filter((o) => !remove.has(o.id));
  }
  touch(doc);
  ctx.store.emitChange(doc.id, 'path.boolean');
  return respond(ctx, doc, 'path.boolean', { objectId: result.id, layerId: target.layer.id, op: params.op, removed: params.keepOriginals ? [] : founds.map((f) => f.object.id), segments: segments.length });
};

/** Convert a rect, ellipse or polygon into an equivalent editable path (same look, same id, same style). */
OPS['path.fromShape'] = async (params, ctx) => {
  const doc = requireDoc(ctx, params.documentId);
  const found = requireObject(doc, params.objectId);
  assertEditable(doc, found.layer, 'content');
  const o = found.object;
  if (o.type === 'path') return respond(ctx, doc, 'path.fromShape', { objectId: o.id, converted: false, anchors: pathEdit().listAnchors(o.segments) });
  assert(['rect', 'ellipse', 'polygon'].includes(o.type), 'UNSUPPORTED_SHAPE', `a ${o.type} cannot become a path here (rect, ellipse or polygon)`);
  const segments = pathBool().objectSegments(o);
  const next = normalizeObject(Object.assign(styleOf(o), { id: o.id, type: 'path', segments, closed: o.type !== 'polygon' || o.closed !== false, rotation: o.rotation }), 'object');
  withHistory(ctx, doc);
  found.layer.objects[found.objectIndex] = next;
  touch(doc);
  ctx.store.emitChange(doc.id, 'path.fromShape');
  return respond(ctx, doc, 'path.fromShape', { objectId: next.id, converted: true, anchors: pathEdit().listAnchors(next.segments) });
};

/** Turn an object's stroke into a filled shape (caps, joins, dashes as drawn); the stroke is moved there. */
OPS['path.outlineStroke'] = async (params, ctx) => {
  const doc = requireDoc(ctx, params.documentId);
  const found = requireObject(doc, params.objectId);
  assertEditable(doc, found.layer, 'content');
  const o = found.object;
  assert(o.stroke && Number(o.strokeWidth) > 0, 'NO_STROKE', `object ${o.id} has no stroke to outline`);
  const segments = o.type === 'line'
    ? [{ op: 'M', x: o.x1, y: o.y1 }, { op: 'L', x: o.x2, y: o.y2 }]
    : pathBool().objectSegments(o);
  const outlined = pathBool().outlineStroke(segments, objectMatrix(doc, found),
    // Same cap/join as drawn: lines use `cap` (default round), shapes `lineCap`/`lineJoin` (default butt/miter).
    { width: Number(o.strokeWidth), cap: o.type === 'line' ? (o.cap || 'round') : (o.lineCap || 'butt'), join: o.lineJoin || 'miter', dash: o.dash },
    coverageLib().invertMatrix(layerMatrix(found.layer)));
  const style = styleOf(o);
  delete style.stroke; delete style.strokeWidth; delete style.dash; delete style.lineCap; delete style.lineJoin; delete style.cap;
  const shape = normalizeObject(Object.assign(style, { type: 'path', segments: outlined, closed: true, fill: o.stroke, name: `${o.name || o.type} stroke` }), 'object');
  withHistory(ctx, doc);
  const index = found.layer.objects.indexOf(o);
  const keepsFill = o.fill && o.type !== 'line';
  if (keepsFill) found.layer.objects[index] = normalizeObject(Object.assign({}, o, { stroke: null, strokeWidth: 0 }), 'object');
  else found.layer.objects.splice(index, 1);
  found.layer.objects.splice(keepsFill ? index + 1 : index, 0, shape);
  touch(doc);
  ctx.store.emitChange(doc.id, 'path.outlineStroke');
  return respond(ctx, doc, 'path.outlineStroke', { objectId: shape.id, sourceKept: Boolean(keepsFill) });
};

/** Equal spacing along an axis: between centres, or equal gaps between boxes. First and last stay put. */
OPS['object.distribute'] = async (params, ctx) => {
  const doc = requireDoc(ctx, params.documentId);
  assert(Array.isArray(params.objectIds) && params.objectIds.length >= 3, 'INVALID_OBJECT_IDS', 'distribute needs at least three objects');
  const axis = params.axis || 'horizontal';
  const mode = params.mode || 'gaps';
  assert(['horizontal', 'vertical'].includes(axis), 'INVALID_ALIGN', 'axis must be horizontal or vertical');
  assert(['gaps', 'centers'].includes(mode), 'INVALID_ALIGN', 'mode must be gaps or centers');
  const measure = measureCtx();
  const items = params.objectIds.map((id) => {
    const found = requireObject(doc, id);
    assertEditable(doc, found.layer, 'position');
    return { found, box: bboxOf(found.object, measure) };
  });
  const pos = (b) => (axis === 'horizontal' ? b.x : b.y);
  const size = (b) => (axis === 'horizontal' ? b.w : b.h);
  items.sort((a, b) => pos(a.box) + size(a.box) / 2 - (pos(b.box) + size(b.box) / 2));
  const first = items[0].box;
  const last = items[items.length - 1].box;
  const moves = [];
  if (mode === 'centers') {
    const c0 = pos(first) + size(first) / 2;
    const step = (pos(last) + size(last) / 2 - c0) / (items.length - 1);
    items.forEach((item, i) => moves.push(c0 + step * i - (pos(item.box) + size(item.box) / 2)));
  } else {
    const total = items.reduce((sum, item) => sum + size(item.box), 0);
    const gap = (pos(last) + size(last) - pos(first) - total) / (items.length - 1);
    let cursor = pos(first);
    items.forEach((item) => { moves.push(cursor - pos(item.box)); cursor += size(item.box) + gap; });
  }
  withHistory(ctx, doc);
  items.forEach((item, i) => {
    const { found } = item;
    const o = found.layer.objects[found.layer.objects.indexOf(found.object)];
    const dx = axis === 'horizontal' ? moves[i] : 0;
    const dy = axis === 'vertical' ? moves[i] : 0;
    found.layer.objects[found.layer.objects.indexOf(o)] = normalizeObject(Object.assign({}, o, translatePatch(o, dx, dy), { id: o.id, type: o.type }), 'object');
  });
  touch(doc);
  ctx.store.emitChange(doc.id, 'object.distribute');
  return respond(ctx, doc, 'object.distribute', { axis, mode, order: items.map((i) => i.found.object.id) });
};

// Scale (sx, sy) and translate an object's geometry about a pivot point, in its layer's coordinates.
function scaleObject(o, sx, sy, px, py, scaleStrokes) {
  const X = (x) => px + (x - px) * sx;
  const Y = (y) => py + (y - py) * sy;
  const out = Object.assign({}, o);
  if (o.x !== undefined) { out.x = X(o.x); out.y = Y(o.y); }
  if (o.w !== undefined) out.w = o.w * sx;
  if (o.h !== undefined) out.h = o.h * sy;
  if (o.radius !== undefined) out.radius = Array.isArray(o.radius) ? o.radius.map((r) => r * Math.sqrt(sx * sy)) : o.radius * Math.sqrt(sx * sy);
  if (o.x1 !== undefined) Object.assign(out, { x1: X(o.x1), y1: Y(o.y1), x2: X(o.x2), y2: Y(o.y2) });
  if (o.points) out.points = o.points.map((p) => Object.assign({}, p, { x: X(p.x), y: Y(p.y) }));
  if (o.segments) {
    out.segments = o.segments.map((seg) => {
      const c = Object.assign({}, seg);
      ['x', 'cx', 'c1x', 'c2x'].forEach((k) => { if (c[k] !== undefined) c[k] = X(c[k]); });
      ['y', 'cy', 'c1y', 'c2y'].forEach((k) => { if (c[k] !== undefined) c[k] = Y(c[k]); });
      return c;
    });
  }
  const uniform = Math.sqrt(sx * sy);
  if (o.font) out.font = Object.assign({}, o.font, { size: o.font.size * uniform });
  if (o.maxWidth !== undefined) out.maxWidth = o.maxWidth * sx;
  if (o.brush && o.brush.size) out.brush = Object.assign({}, o.brush, { size: o.brush.size * uniform });
  if (scaleStrokes !== false && o.strokeWidth !== undefined) out.strokeWidth = o.strokeWidth * uniform;
  return out;
}

/**
 * Transform several objects as one selection about a pivot (default: the selection's centre):
 * dx/dy move, scale or scaleX/scaleY resize, rotation (degrees, added) turns every object about the pivot.
 * Coordinates are each object's layer coordinates.
 */
async function transformAboutPivot(params, ctx) {
  const doc = requireDoc(ctx, params.documentId);
  const ids = params.objectIds || [params.objectId];
  assert(Array.isArray(ids) && ids.length >= 1 && ids.every((id) => typeof id === 'string'), 'INVALID_OBJECT_IDS', 'objectIds must be a non-empty array');
  const measure = measureCtx();
  const founds = ids.map((id) => requireObject(doc, id));
  for (const f of founds) assertEditable(doc, f.layer, 'position');
  const boxes = founds.map((f) => bboxOf(f.object, measure));
  const x0 = Math.min(...boxes.map((b) => b.x));
  const y0 = Math.min(...boxes.map((b) => b.y));
  const x1 = Math.max(...boxes.map((b) => b.x + b.w));
  const y1 = Math.max(...boxes.map((b) => b.y + b.h));
  const named = { center: [0.5, 0.5], topLeft: [0, 0], top: [0.5, 0], topRight: [1, 0], left: [0, 0.5], right: [1, 0.5], bottomLeft: [0, 1], bottom: [0.5, 1], bottomRight: [1, 1] };
  let pivot;
  if (params.pivot === undefined || typeof params.pivot === 'string') {
    const k = named[params.pivot || 'center'];
    assert(k, 'INVALID_PIVOT', `pivot must be {x,y} or one of ${Object.keys(named).join(', ')}`);
    pivot = { x: x0 + (x1 - x0) * k[0], y: y0 + (y1 - y0) * k[1] };
  } else {
    pivot = { x: Number(params.pivot.x), y: Number(params.pivot.y) };
    assert(Number.isFinite(pivot.x) && Number.isFinite(pivot.y), 'INVALID_PIVOT', 'pivot.x and pivot.y must be numbers');
  }
  const sx = Number(params.scaleX !== undefined ? params.scaleX : params.scale !== undefined ? params.scale : 1);
  const sy = Number(params.scaleY !== undefined ? params.scaleY : params.scale !== undefined ? params.scale : 1);
  assert(Number.isFinite(sx) && Number.isFinite(sy) && sx > 0 && sy > 0 && sx <= 50 && sy <= 50, 'INVALID_SCALE', 'scale factors must be greater than 0 and at most 50');
  const rotation = Number(params.rotation || 0);
  assert(Number.isFinite(rotation), 'INVALID_NUMBER', 'rotation must be a number in degrees');
  const dx = Number(params.dx || 0);
  const dy = Number(params.dy || 0);
  withHistory(ctx, doc);
  const results = founds.map((f) => {
    let o = scaleObject(f.object, sx, sy, pivot.x, pivot.y, params.scaleStrokes);
    if (rotation) {
      // Rigid turn: the object's centre orbits the pivot and the object turns by the same angle.
      const b = bboxOf(Object.assign({}, o, { rotation: 0 }), measure);
      const c = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
      const r = rotation * Math.PI / 180;
      const nx = pivot.x + (c.x - pivot.x) * Math.cos(r) - (c.y - pivot.y) * Math.sin(r);
      const ny = pivot.y + (c.x - pivot.x) * Math.sin(r) + (c.y - pivot.y) * Math.cos(r);
      o = Object.assign({}, o, translatePatch(o, nx - c.x, ny - c.y));
      o.rotation = Number(o.rotation || 0) + rotation;
    }
    if (dx || dy) o = Object.assign({}, o, translatePatch(o, dx, dy));
    const next = normalizeObject(Object.assign(o, { id: f.object.id, type: f.object.type }), 'object');
    f.layer.objects[f.layer.objects.indexOf(f.object)] = next;
    return { objectId: next.id, box: bboxOf(next, measure) };
  });
  touch(doc);
  ctx.store.emitChange(doc.id, 'object.transform');
  return respond(ctx, doc, 'object.transform', { objects: results, pivot, scaleX: sx, scaleY: sy, rotation, dx, dy });
}

// Shift a coverage shape by (dx, dy) (used when the canvas origin moves).
function translateShape(shape, dx, dy) {
  const s = JSON.parse(JSON.stringify(shape));
  if (s.x !== undefined) { s.x += dx; s.y += dy; }
  if (s.points) s.points = s.points.map((p) => ({ x: p.x + dx, y: p.y + dy }));
  if (s.segments) s.segments = s.segments.map((seg) => { const c = Object.assign({}, seg); ['x', 'cx', 'c1x', 'c2x'].forEach((k) => { if (c[k] !== undefined) c[k] += dx; }); ['y', 'cy', 'c1y', 'c2y'].forEach((k) => { if (c[k] !== undefined) c[k] += dy; }); return c; });
  if (s.from) { s.from = { x: s.from.x + dx, y: s.from.y + dy }; s.to = { x: s.to.x + dx, y: s.to.y + dy }; }
  return s;
}
const translateProgram = (steps, dx, dy) => steps.map((st) => (st.shape ? Object.assign({}, st, { shape: translateShape(st.shape, dx, dy) }) : st));

/**
 * Non-destructive crop: the canvas becomes the rectangle {x, y, width, height} (may extend beyond the
 * current canvas). Nothing is deleted: content outside stays and returns if the canvas grows again.
 * Everything placed in document coordinates moves with the new origin (layers, unlinked/group masks,
 * guides, the selection).
 */
OPS['document.crop'] = async (params, ctx) => {
  const doc = requireDoc(ctx, params.documentId);
  const x = Number(params.x || 0);
  const y = Number(params.y || 0);
  const width = Math.round(Number(params.width));
  const height = Math.round(Number(params.height));
  assert([x, y].every(Number.isFinite), 'INVALID_NUMBER', 'x and y must be numbers');
  assert(Number.isFinite(width) && Number.isFinite(height) && width >= 1 && height >= 1 && width <= 8192 && height <= 8192,
    'INVALID_NUMBER', 'width and height must be between 1 and 8192');
  for (const layer of doc.layers) assertEditable(doc, layer, 'position');
  withHistory(ctx, doc);
  const dx = -x;
  const dy = -y;
  for (const layer of doc.layers) {
    if (!tree.isGroup(layer)) layer.transform = normalizeTransform(Object.assign({}, layer.transform, { x: Number(layer.transform.x || 0) + dx, y: Number(layer.transform.y || 0) + dy }), 'layer.transform');
    const docSpace = (mask) => mask && (tree.isGroup(layer) || mask.linked === false);
    if (docSpace(layer.mask)) layer.mask.program = translateProgram(layer.mask.program, dx, dy);
    if (docSpace(layer.vectorMask)) layer.vectorMask.shapes = layer.vectorMask.shapes.map((sh) => translateShape(sh, dx, dy));
  }
  if (doc.canvas.guides) {
    doc.canvas.guides = doc.canvas.guides.map((g) => Object.assign({}, g, { position: g.position + (g.orientation === 'vertical' ? dx : dy) }));
  }
  const selection = ctx.store.getSelection(doc.id);
  if (selection) ctx.store.setSelection(doc.id, translateProgram(selection, dx, dy));
  doc.canvas.width = width;
  doc.canvas.height = height;
  touch(doc);
  ctx.store.emitChange(doc.id, 'document.crop');
  return respond(ctx, doc, 'document.crop', { width, height, shifted: { x: dx, y: dy } });
};

// Guides (editor aids saved with the document, never rendered into exports).
function normalizeGuide(input) {
  assert(input && ['horizontal', 'vertical'].includes(input.orientation), 'INVALID_GUIDE', 'orientation must be horizontal or vertical');
  const position = Number(input.position);
  assert(Number.isFinite(position) && Math.abs(position) <= 100000, 'INVALID_GUIDE', 'position must be a number (px)');
  return { id: typeof input.id === 'string' && input.id ? input.id : makeId('guide'), orientation: input.orientation, position };
}

OPS['guide.add'] = async (params, ctx) => {
  const doc = requireDoc(ctx, params.documentId);
  const guide = normalizeGuide(params);
  assert((doc.canvas.guides || []).length < 500, 'INVALID_GUIDE', 'at most 500 guides');
  withHistory(ctx, doc);
  doc.canvas.guides = (doc.canvas.guides || []).concat([guide]);
  touch(doc);
  ctx.store.emitChange(doc.id, 'guide.add');
  return respond(ctx, doc, 'guide.add', { guide, guideId: guide.id, guides: doc.canvas.guides });
};

OPS['guide.remove'] = async (params, ctx) => {
  const doc = requireDoc(ctx, params.documentId);
  const guides = doc.canvas.guides || [];
  assert(guides.some((g) => g.id === params.guideId), 'GUIDE_NOT_FOUND', `guide not found: ${params.guideId}`, { known: guides.map((g) => g.id) });
  withHistory(ctx, doc);
  doc.canvas.guides = guides.filter((g) => g.id !== params.guideId);
  if (!doc.canvas.guides.length) delete doc.canvas.guides;
  touch(doc);
  ctx.store.emitChange(doc.id, 'guide.remove');
  return respond(ctx, doc, 'guide.remove', { removed: params.guideId });
};

OPS['guide.update'] = async (params, ctx) => {
  const doc = requireDoc(ctx, params.documentId);
  const guides = doc.canvas.guides || [];
  const index = guides.findIndex((g) => g.id === params.guideId);
  assert(index >= 0, 'GUIDE_NOT_FOUND', `guide not found: ${params.guideId}`, { known: guides.map((g) => g.id) });
  const guide = normalizeGuide(Object.assign({}, guides[index], { position: params.position === undefined ? guides[index].position : params.position }));
  withHistory(ctx, doc);
  doc.canvas.guides = guides.map((g, i) => (i === index ? guide : g));
  touch(doc);
  ctx.store.emitChange(doc.id, 'guide.update');
  return respond(ctx, doc, 'guide.update', { guide });
};

/** Go back (steps < 0) or forward (steps > 0) several history steps at once (History panel). */
OPS['history.jump'] = async (params, ctx) => {
  const doc = requireDoc(ctx, params.documentId);
  const steps = Number(params.steps);
  assert(Number.isInteger(steps) && steps !== 0, 'INVALID_NUMBER', 'steps must be a non-zero integer (negative = undo, positive = redo)');
  const state = ctx.store.historyState(doc.id);
  assert(steps < 0 ? -steps <= state.undoDepth : steps <= state.redoDepth, 'INVALID_NUMBER',
    `can go back ${state.undoDepth} and forward ${state.redoDepth} steps`, { undoDepth: state.undoDepth, redoDepth: state.redoDepth });
  for (let i = 0; i < Math.abs(steps); i += 1) {
    if (steps < 0) ctx.store.undo(doc.id); else ctx.store.redo(doc.id);
  }
  const current = ctx.store.get(doc.id);
  return respond(ctx, current, 'history.jump', { steps, history: ctx.store.historyState(doc.id) });
};

OPS['guide.clear'] = async (params, ctx) => {
  const doc = requireDoc(ctx, params.documentId);
  withHistory(ctx, doc);
  delete doc.canvas.guides;
  touch(doc);
  ctx.store.emitChange(doc.id, 'guide.clear');
  return respond(ctx, doc, 'guide.clear', {});
};

// ------------------------------------------------------------ pixel layers

const rasterLib = () => require('./raster');
const RASTER_TOOLS = ['brush', 'eraser', 'clone', 'heal', 'dodge', 'burn', 'sponge', 'smudge', 'blur', 'sharpen'];

function requireRasterLayer(doc, layerId) {
  const layer = requireLayer(doc, layerId);
  assert(layer.raster, 'NOT_A_PIXEL_LAYER', `layer "${layer.name}" has no pixels; create one with raster.create or convert it with raster.rasterize`, { layerId: layer.id });
  assertEditable(doc, layer, 'content');
  return layer;
}

const finite = (v, field, min, max) => {
  const n = Number(v);
  assert(Number.isFinite(n) && (min === undefined || n >= min) && (max === undefined || n <= max), 'INVALID_NUMBER',
    `${field} must be a number${min !== undefined ? ` between ${min} and ${max}` : ''}`, { received: v });
  return n;
};

// Document points → the layer's pixel coordinates.
function toLayerPoints(layer, points) {
  assert(Array.isArray(points) && points.length >= 1 && points.length <= 20000, 'INVALID_POINTS', 'points must be 1 to 20000 {x, y, p?} in document coordinates');
  const inv = coverageLib().invertMatrix(layerMatrix(layer));
  return points.map((pt, i) => {
    const x = finite(pt.x, `points[${i}].x`);
    const y = finite(pt.y, `points[${i}].y`);
    const out = { x: inv.a * x + inv.c * y + inv.e, y: inv.b * x + inv.d * y + inv.f };
    if (pt.p !== undefined) out.p = finite(pt.p, `points[${i}].p`, 0, 1);
    return out;
  });
}

// The canvas rectangle expressed in a layer's pixel coordinates (bounding box).
function canvasInLayer(doc, layer) {
  const inv = coverageLib().invertMatrix(layerMatrix(layer));
  const pts = [[0, 0], [doc.canvas.width, 0], [0, doc.canvas.height], [doc.canvas.width, doc.canvas.height]]
    .map(([x, y]) => ({ x: inv.a * x + inv.c * y + inv.e, y: inv.b * x + inv.d * y + inv.f }));
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
}

// Active selection as per-pixel coverage of a region (layer pixels), or null when nothing is selected.
function selectionForRegion(ctx, doc, layer, rect, use) {
  const steps = use === false ? null : ctx.store.getSelection(doc.id);
  if (!steps || !steps.length) return null;
  const toRegion = mul({ a: 1, b: 0, c: 0, d: 1, e: -rect.x, f: -rect.y }, coverageLib().invertMatrix(layerMatrix(layer)));
  const { renderCoverage, readAlpha } = coverageLib();
  return readAlpha(renderCoverage(steps, rect.w, rect.h, toRegion, 1));
}

async function commitRaster(ctx, doc, layer, rect, before, after, params, op, extra) {
  const constrained = rasterLib().constrain(before, after, selectionForRegion(ctx, doc, layer, rect, params.useSelection),
    Boolean(layer.locks && layer.locks.alpha) || tree.ancestors(doc.layers, layer).some((g) => g.locks && g.locks.alpha));
  const tiles = rasterLib().writeRegion(rasterLib().tileStore(ctx), layer, rect, constrained);
  withHistory(ctx, doc);
  layer.raster = { tileSize: 256, tiles };
  touch(doc);
  ctx.store.emitChange(doc.id, op);
  return respond(ctx, doc, op, Object.assign({ layerId: layer.id, tiles: Object.keys(tiles).length, region: rect }, extra || {}));
}

const retouch = () => require('./retouch');

// Disc coverage (soft 1.5px edge) for a spot at (cx, cy) radius r, in region pixels; returns {cov, box}.
function spotCoverage(rect, cx, cy, r) {
  const cov = new Float32Array(rect.w * rect.h);
  const x0 = Math.max(0, Math.floor(cx - r - 2)); const x1 = Math.min(rect.w, Math.ceil(cx + r + 2));
  const y0 = Math.max(0, Math.floor(cy - r - 2)); const y1 = Math.min(rect.h, Math.ceil(cy + r + 2));
  for (let y = y0; y < y1; y += 1) for (let x = x0; x < x1; x += 1) {
    const t = (r + 0.5 - Math.hypot(x + 0.5 - cx, y + 0.5 - cy)) / 1.5;
    if (t > 0) cov[y * rect.w + x] = t > 1 ? 1 : t;
  }
  return { cov, box: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } };
}

/**
 * Spot healing brush: each spot is replaced from the best-matching nearby area (proximity match on the
 * surrounding ring) and blended in the gradient domain, so the spot's own colour does not survive.
 */
OPS['raster.spotHeal'] = async (params, ctx) => {
  const doc = requireDoc(ctx, params.documentId);
  const layer = requireRasterLayer(doc, params.layerId);
  const points = toLayerPoints(layer, params.points);
  assert(points.length <= 200, 'INVALID_POINTS', 'spot healing takes at most 200 spots per call');
  const size = finite(params.size === undefined ? 20 : params.size, 'size', 2, 400);
  const reachPx = size * 2.6 + Math.max(3, size * 0.35) + 4;
  const box = { x: Math.min(...points.map((q) => q.x)) - reachPx, y: Math.min(...points.map((q) => q.y)) - reachPx };
  box.w = Math.max(...points.map((q) => q.x)) + reachPx - box.x;
  box.h = Math.max(...points.map((q) => q.y)) + reachPx - box.y;
  const rect = rasterLib().alignRect(box);
  const before = await rasterLib().readRegion(rasterLib().tileStore(ctx), layer, rect);
  let canvas = before;
  const spots = [];
  for (const pt of points) {
    const { cov, box: spotBox } = spotCoverage(rect, pt.x - rect.x, pt.y - rect.y, size / 2);
    const best = retouch().bestOffset(canvas, cov, spotBox);
    if (!best) { spots.push({ x: pt.x, y: pt.y, healed: false, reason: 'no clean source nearby (edge of the pixels?)' }); continue; }
    canvas = retouch().heal(canvas, cov, best.x, best.y);
    spots.push({ x: pt.x, y: pt.y, healed: true, source: { x: pt.x + best.x, y: pt.y + best.y } });
  }
  return commitRaster(ctx, doc, layer, rect, before, canvas, { useSelection: params.useSelection }, 'raster.spotHeal', { spots });
};

/**
 * Patch tool: heal the selection from a source area. offset {x, y} (document pixels) points from the
 * selection to the source; without it the best-matching nearby area is chosen.
 */
OPS['raster.patch'] = async (params, ctx) => {
  const doc = requireDoc(ctx, params.documentId);
  const layer = requireRasterLayer(doc, params.layerId);
  assert(ctx.store.getSelection(doc.id) && ctx.store.getSelection(doc.id).length, 'NO_SELECTION', 'the patch tool heals the selection: make one first (selection.set)');
  const whole = rasterLib().alignRect(canvasInLayer(doc, layer));
  const full = selectionForRegion(ctx, doc, layer, whole, true);
  let x0 = whole.w; let y0 = whole.h; let x1 = -1; let y1 = -1;
  for (let y = 0; y < whole.h; y += 1) for (let x = 0; x < whole.w; x += 1) if (full[y * whole.w + x] > 0.004) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  assert(x1 >= 0, 'NO_SELECTION', 'the selection is empty');
  const sel = { x: whole.x + x0, y: whole.y + y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
  let offset = null;
  if (params.offset !== undefined) {
    const inv = coverageLib().invertMatrix(layerMatrix(layer));
    const ox = finite(params.offset.x, 'offset.x'); const oy = finite(params.offset.y, 'offset.y');
    offset = { x: inv.a * ox + inv.c * oy, y: inv.b * ox + inv.d * oy };
  }
  const size = Math.max(sel.w, sel.h);
  const grow = offset ? Math.max(Math.abs(offset.x), Math.abs(offset.y)) + 4 : size * 2.6 + Math.max(3, size * 0.35) + 4;
  const rect = rasterLib().alignRect({ x: sel.x - grow, y: sel.y - grow, w: sel.w + grow * 2, h: sel.h + grow * 2 });
  const cov = selectionForRegion(ctx, doc, layer, rect, true);
  const before = await rasterLib().readRegion(rasterLib().tileStore(ctx), layer, rect);
  if (!offset) {
    offset = retouch().bestOffset(before, cov, { x: sel.x - rect.x, y: sel.y - rect.y, w: sel.w, h: sel.h });
    assert(offset, 'NO_SOURCE', 'no clean source area of the same size was found next to the selection; pass offset {x, y}');
  }
  const after = retouch().heal(before, cov, offset.x, offset.y);
  return commitRaster(ctx, doc, layer, rect, before, after, { useSelection: false }, 'raster.patch', { offset: { x: Math.round(offset.x), y: Math.round(offset.y) }, selection: sel });
};

/**
 * Free transform of a pixel layer's pixels (destructive, like Photoshop on a normal layer):
 * mode perspective/distort (corners), skew (angles), warp (preset + bend) or mesh (rows × cols grid).
 */
OPS['raster.transform'] = async (params, ctx) => {
  const doc = requireDoc(ctx, params.documentId);
  const layer = requireRasterLayer(doc, params.layerId);
  assertEditable(doc, layer, 'all');
  const mode = params.mode || 'warp';
  assert(['perspective', 'distort', 'skew', 'warp', 'mesh'].includes(mode), 'INVALID_TRANSFORM', 'mode must be perspective, distort, skew, warp or mesh', { received: params.mode });
  const keys = Object.keys(layer.raster.tiles);
  assert(keys.length, 'EMPTY_LAYER', `layer "${layer.name}" has no pixels to transform`);
  const store = rasterLib().tileStore(ctx);
  const T = rasterLib().TILE;
  const txs = keys.map((k) => Number(k.split(',')[0])); const tys = keys.map((k) => Number(k.split(',')[1]));
  const all = { x: Math.min(...txs) * T, y: Math.min(...tys) * T, w: (Math.max(...txs) - Math.min(...txs) + 1) * T, h: (Math.max(...tys) - Math.min(...tys) + 1) * T };
  const source = await rasterLib().readRegion(store, layer, all);
  const crop = cropToAlpha(source);
  assert(crop, 'EMPTY_LAYER', `layer "${layer.name}" has no pixels to transform`);
  const box = { x: all.x + crop.x, y: all.y + crop.y, w: crop.canvas.width, h: crop.canvas.height };
  const R = retouch();
  let map;
  if (mode === 'perspective' || mode === 'distort') {
    assert(Array.isArray(params.corners) && params.corners.length === 4, 'INVALID_TRANSFORM', 'corners must be 4 points [top-left, top-right, bottom-right, bottom-left] in document pixels');
    const q = toLayerPoints(layer, params.corners.map((p) => (Array.isArray(p) ? { x: p[0], y: p[1] } : p))).map((p) => [p.x, p.y]);
    map = R.squareToQuad(q);
  } else if (mode === 'skew') {
    const ax = Math.tan(finite(params.skewX === undefined ? 0 : params.skewX, 'skewX', -80, 80) * Math.PI / 180);
    const ay = Math.tan(finite(params.skewY === undefined ? 0 : params.skewY, 'skewY', -80, 80) * Math.PI / 180);
    const cx = box.x + box.w / 2; const cy = box.y + box.h / 2;
    map = (u, v) => { const x = box.x + u * box.w - cx; const y = box.y + v * box.h - cy; return [cx + x + ax * y, cy + y + ay * x]; };
  } else if (mode === 'warp') {
    const preset = params.preset || 'arc';
    assert(R.WARP_PRESETS.includes(preset), 'INVALID_TRANSFORM', `preset must be one of ${R.WARP_PRESETS.join(', ')}`, { received: params.preset });
    map = R.presetMap(preset, finite(params.bend === undefined ? 0.5 : params.bend, 'bend', -1, 1), box);
  } else {
    const rows = finite(params.rows, 'rows', 1, 16); const cols = finite(params.cols, 'cols', 1, 16);
    assert(Number.isInteger(rows) && Number.isInteger(cols), 'INVALID_TRANSFORM', 'rows and cols must be whole numbers');
    assert(Array.isArray(params.points) && params.points.length === (rows + 1) * (cols + 1), 'INVALID_TRANSFORM',
      `points must hold (rows+1)×(cols+1) = ${(rows + 1) * (cols + 1)} grid points, row by row, in document pixels`);
    map = R.meshMap(rows, cols, toLayerPoints(layer, params.points.map((p) => (Array.isArray(p) ? { x: p[0], y: p[1] } : p))).map((p) => [p.x, p.y]));
  }
  const out = R.warp(source, { x: all.x, y: all.y }, box, map, params.grid === undefined ? 32 : finite(params.grid, 'grid', 4, 96));
  const rect = rasterLib().alignRect({ x: out.x, y: out.y, w: out.canvas.width, h: out.canvas.height });
  const placed = createCanvas(rect.w, rect.h);
  placed.getContext('2d').drawImage(out.canvas, out.x - rect.x, out.y - rect.y);
  const tiles = rasterLib().writeRegion(store, { raster: { tiles: {} } }, rect, placed);
  withHistory(ctx, doc);
  layer.raster = { tileSize: 256, tiles };
  touch(doc);
  ctx.store.emitChange(doc.id, 'raster.transform');
  return respond(ctx, doc, 'raster.transform', { layerId: layer.id, mode, from: box, to: { x: out.x, y: out.y, w: out.canvas.width, h: out.canvas.height }, tiles: Object.keys(tiles).length });
};

/** New pixel layer (optionally filled with a colour over the canvas). */
OPS['raster.create'] = async (params, ctx) => {
  const doc = requireDoc(ctx, params.documentId);
  requireMasksAllowed(doc);
  const layer = normalizeLayer({ name: params.name || 'Pixel layer', opacity: params.opacity, blend: params.blend, raster: { tiles: {} }, objects: [] }, doc.layers.length);
  const parent = resolveParent(doc, params.parentId);
  let tiles = {};
  if (params.fill !== undefined) {
    const color = require('./paint').normalizeColor(params.fill, 'fill');
    const rect = rasterLib().alignRect({ x: 0, y: 0, w: doc.canvas.width, h: doc.canvas.height });
    const canvas = createCanvas(rect.w, rect.h);
    const c = canvas.getContext('2d');
    c.fillStyle = color;
    c.fillRect(-rect.x, -rect.y, doc.canvas.width, doc.canvas.height);
    tiles = rasterLib().writeRegion(rasterLib().tileStore(ctx), layer, rect, canvas);
  }
  layer.raster.tiles = tiles;
  withHistory(ctx, doc);
  const index = tree.insertAt(doc.layers, layer, parent && parent.id, params.index === undefined ? undefined : Number(params.index));
  touch(doc);
  ctx.store.emitChange(doc.id, 'raster.create');
  return respond(ctx, doc, 'raster.create', { layer, layerId: layer.id, index });
};

/** Destructive by request: turn a layer's shapes and text into pixels (effects, mask and opacity stay live). */
OPS['raster.rasterize'] = async (params, ctx) => {
  const doc = requireDoc(ctx, params.documentId);
  requireMasksAllowed(doc);
  const layer = requireLayer(doc, params.layerId);
  requireDrawable(doc, layer);
  assertEditable(doc, layer, 'content');
  const measure = measureCtx();
  const boxes = [canvasInLayer(doc, layer)].concat(layer.objects.map((o) => {
    const b = bboxOf(o, measure);
    const pad = 4 + Number(o.strokeWidth || 0) + (o.shadow ? Number(o.shadow.blur || 0) * 2 + Math.abs(Number(o.shadow.offsetX || 0)) + Math.abs(Number(o.shadow.offsetY || 0)) : 0) + Number(o.blur || 0) * 3;
    return { x: b.x - pad, y: b.y - pad, w: b.w + pad * 2, h: b.h + pad * 2 };
  }));
  const x0 = Math.min(...boxes.map((b) => b.x)); const y0 = Math.min(...boxes.map((b) => b.y));
  const x1 = Math.max(...boxes.map((b) => b.x + b.w)); const y1 = Math.max(...boxes.map((b) => b.y + b.h));
  const rect = rasterLib().alignRect({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
  const store = rasterLib().tileStore(ctx);
  const canvas = layer.raster ? await rasterLib().readRegion(store, layer, rect) : createCanvas(rect.w, rect.h);
  const c = canvas.getContext('2d');
  c.translate(-rect.x, -rect.y);
  const images = await loadImages(ctx, doc);
  const { drawObject } = require('./renderer');
  for (const object of layer.objects) drawObject(c, object, null, images, () => {}, { lights: [...(doc.canvas.lights || []), ...(layer.lights || [])], layerId: layer.id, width: doc.canvas.width, height: doc.canvas.height });
  const tiles = rasterLib().writeRegion(store, Object.assign({}, layer, { raster: layer.raster || { tiles: {} } }), rect, canvas);
  withHistory(ctx, doc);
  const converted = layer.objects.length;
  layer.objects = [];
  layer.raster = { tileSize: 256, tiles };
  touch(doc);
  ctx.store.emitChange(doc.id, 'raster.rasterize');
  return respond(ctx, doc, 'raster.rasterize', { layerId: layer.id, converted, tiles: Object.keys(tiles).length, destructive: true });
};

/**
 * Paint on a pixel layer with a retouching tool. Points are in document coordinates (pressure p 0..1).
 *  brush/eraser: size, hardness, opacity, flow, spacing, color, blend, pressureSize, pressureOpacity
 *  clone/heal: source {x, y} = the point sampled for the first stroke point (aligned), size, hardness, strength
 *  dodge/burn: exposure, range (shadows|midtones|highlights) · sponge: mode (saturate|desaturate), flow
 *  smudge/blur/sharpen: strength
 */
OPS['raster.paint'] = async (params, ctx) => {
  const doc = requireDoc(ctx, params.documentId);
  const layer = requireRasterLayer(doc, params.layerId);
  const tool = params.tool || 'brush';
  assert(RASTER_TOOLS.includes(tool), 'INVALID_TOOL', `tool must be one of ${RASTER_TOOLS.join(', ')}`, { received: params.tool });
  const points = toLayerPoints(layer, params.points);
  const size = finite(params.size === undefined ? 20 : params.size, 'size', 1, 2000);
  const p = {
    points, size,
    hardness: finite(params.hardness === undefined ? (tool === 'brush' || tool === 'eraser' ? 0.8 : 0.5) : params.hardness, 'hardness', 0, 1),
    opacity: finite(params.opacity === undefined ? 1 : params.opacity, 'opacity', 0, 1),
    flow: finite(params.flow === undefined ? (tool === 'sponge' ? 0.5 : 1) : params.flow, 'flow', 0, 1),
    spacing: finite(params.spacing === undefined ? 0.15 : params.spacing, 'spacing', 0.01, 5),
    strength: params.strength === undefined ? undefined : finite(params.strength, 'strength', 0, 1),
    exposure: params.exposure === undefined ? undefined : finite(params.exposure, 'exposure', 0, 1),
    range: params.range || 'midtones',
    mode: params.mode || 'desaturate',
    pressureSize: params.pressureSize !== false,
    pressureOpacity: Boolean(params.pressureOpacity),
    blend: params.blend || 'source-over',
    useSelection: params.useSelection,
  };
  assert(['shadows', 'midtones', 'highlights'].includes(p.range), 'INVALID_TOOL', 'range must be shadows, midtones or highlights');
  assert(['saturate', 'desaturate'].includes(p.mode), 'INVALID_TOOL', 'mode must be saturate or desaturate');
  assert(BLEND_MODES.includes(p.blend), 'INVALID_BLEND', 'blend is not supported', { received: p.blend });
  if (tool === 'brush') p.color = require('./paint').normalizeColor(params.color || '#000000', 'color');
  const r = size / 2 + 2;
  let box = { x: Math.min(...points.map((q) => q.x)) - r, y: Math.min(...points.map((q) => q.y)) - r };
  box.w = Math.max(...points.map((q) => q.x)) + r - box.x;
  box.h = Math.max(...points.map((q) => q.y)) + r - box.y;
  if (tool === 'clone' || tool === 'heal') {
    assert(params.source && params.source.x !== undefined, 'INVALID_TOOL', `${tool} needs source {x, y}: the point to copy from for the first stroke point`);
    const src = toLayerPoints(layer, [params.source])[0];
    p.offset = { x: src.x - points[0].x, y: src.y - points[0].y };
    const shifted = { x: box.x + p.offset.x, y: box.y + p.offset.y, w: box.w, h: box.h };
    const x0 = Math.min(box.x, shifted.x); const y0 = Math.min(box.y, shifted.y);
    box = { x: x0, y: y0, w: Math.max(box.x + box.w, shifted.x + shifted.w) - x0, h: Math.max(box.y + box.h, shifted.y + shifted.h) - y0 };
  }
  if (tool === 'blur' || tool === 'smudge') box = { x: box.x - size, y: box.y - size, w: box.w + size * 2, h: box.h + size * 2 };
  const rect = rasterLib().alignRect(box);
  const store = rasterLib().tileStore(ctx);
  const before = await rasterLib().readRegion(store, layer, rect);
  const withPressure = Object.assign({}, p, { points: points.map((q) => ({ x: q.x, y: q.y, p: q.p === undefined ? 1 : q.p })) });
  const after = rasterLib().applyTool(tool, before, rect, withPressure, null);
  return commitRaster(ctx, doc, layer, rect, before, after, p, 'raster.paint', { tool });
};

/** Paint bucket (from a seed point, tolerance, contiguous) or fill the whole selection/canvas with a colour. */
OPS['raster.fill'] = async (params, ctx) => {
  const doc = requireDoc(ctx, params.documentId);
  const layer = requireRasterLayer(doc, params.layerId);
  const color = require('./paint').normalizeColor(params.color || '#000000', 'color');
  const opacity = finite(params.opacity === undefined ? 1 : params.opacity, 'opacity', 0, 1);
  const blend = params.blend || 'source-over';
  assert(BLEND_MODES.includes(blend), 'INVALID_BLEND', 'blend is not supported');
  const rect = rasterLib().alignRect(canvasInLayer(doc, layer));
  const store = rasterLib().tileStore(ctx);
  const before = await rasterLib().readRegion(store, layer, rect);
  const fill = createCanvas(rect.w, rect.h);
  const fc = fill.getContext('2d');
  fc.fillStyle = color;
  fc.fillRect(0, 0, rect.w, rect.h);
  let seeded = null;
  if (params.x !== undefined || params.y !== undefined) {
    const seed = toLayerPoints(layer, [{ x: params.x, y: params.y }])[0];
    const tolerance = finite(params.tolerance === undefined ? 32 : params.tolerance, 'tolerance', 0, 255);
    const mask = rasterLib().floodMask(before, Math.floor(seed.x - rect.x), Math.floor(seed.y - rect.y), tolerance, params.contiguous !== false);
    const image = fc.getImageData(0, 0, rect.w, rect.h);
    for (let i = 0; i < mask.length; i += 1) image.data[i * 4 + 3] = Math.round(image.data[i * 4 + 3] * mask[i]);
    fc.putImageData(image, 0, 0);
    seeded = mask.reduce((a, v) => a + (v > 0 ? 1 : 0), 0);
  }
  const after = createCanvas(rect.w, rect.h);
  const ac = after.getContext('2d');
  ac.drawImage(before, 0, 0);
  ac.globalAlpha = opacity;
  ac.globalCompositeOperation = blend;
  ac.drawImage(fill, 0, 0);
  return commitRaster(ctx, doc, layer, rect, before, after, params, 'raster.fill', seeded === null ? {} : { filledPixels: seeded });
};

/** Gradient tool on a pixel layer: from → to in document coordinates, stops [{offset, color}], linear or radial. */
OPS['raster.gradient'] = async (params, ctx) => {
  const doc = requireDoc(ctx, params.documentId);
  const layer = requireRasterLayer(doc, params.layerId);
  const [from, to] = toLayerPoints(layer, [params.from, params.to]);
  const type = params.type || 'linear';
  assert(['linear', 'radial'].includes(type), 'INVALID_GRADIENT', 'type must be linear or radial');
  assert(Array.isArray(params.stops) && params.stops.length >= 2, 'INVALID_GRADIENT', 'stops needs at least two {offset, color}');
  const stops = params.stops.map((st, i) => ({ offset: finite(st.offset, `stops[${i}].offset`, 0, 1), color: require('./paint').normalizeColor(st.color, `stops[${i}].color`) }));
  const opacity = finite(params.opacity === undefined ? 1 : params.opacity, 'opacity', 0, 1);
  const rect = rasterLib().alignRect(canvasInLayer(doc, layer));
  const before = await rasterLib().readRegion(rasterLib().tileStore(ctx), layer, rect);
  const after = createCanvas(rect.w, rect.h);
  const ac = after.getContext('2d');
  ac.drawImage(before, 0, 0);
  const g = type === 'linear'
    ? ac.createLinearGradient(from.x - rect.x, from.y - rect.y, to.x - rect.x, to.y - rect.y)
    : ac.createRadialGradient(from.x - rect.x, from.y - rect.y, 0, from.x - rect.x, from.y - rect.y, Math.max(1, Math.hypot(to.x - from.x, to.y - from.y)));
  for (const st of stops) g.addColorStop(st.offset, st.color);
  ac.globalAlpha = opacity;
  ac.globalCompositeOperation = params.blend || 'source-over';
  ac.fillStyle = g;
  ac.fillRect(0, 0, rect.w, rect.h);
  return commitRaster(ctx, doc, layer, rect, before, after, params, 'raster.gradient');
};

/** Delete pixels: inside the selection, or the whole layer when nothing is selected. */
OPS['raster.clear'] = async (params, ctx) => {
  const doc = requireDoc(ctx, params.documentId);
  const layer = requireRasterLayer(doc, params.layerId);
  const steps = params.useSelection === false ? null : ctx.store.getSelection(doc.id);
  if (!steps || !steps.length) {
    withHistory(ctx, doc);
    layer.raster = { tileSize: 256, tiles: {} };
    touch(doc);
    ctx.store.emitChange(doc.id, 'raster.clear');
    return respond(ctx, doc, 'raster.clear', { layerId: layer.id, tiles: 0 });
  }
  const rect = rasterLib().alignRect(canvasInLayer(doc, layer));
  const before = await rasterLib().readRegion(rasterLib().tileStore(ctx), layer, rect);
  const after = createCanvas(rect.w, rect.h);
  return commitRaster(ctx, doc, layer, rect, before, after, Object.assign({}, params, { useSelection: true }), 'raster.clear');
};

// ------------------------------------------------- adjustments and smart filters

const adjSchema = () => require('./adjustments-schema');

/**
 * Adjustment layer (Curves, Levels, Hue/Saturation, …): recolours everything below it, or only its
 * clipping base when clipped. from:"selection" limits it with a mask made from the selection.
 */
OPS['adjustment.add'] = async (params, ctx) => {
  const doc = requireDoc(ctx, params.documentId);
  requireMasksAllowed(doc);
  const input = { type: 'adjustment', name: params.name, opacity: params.opacity, blend: params.blend, clipped: params.clipped,
    adjustment: params.adjustment || { kind: params.kind } };
  const layer = normalizeLayer(input, doc.layers.length);
  const parent = resolveParent(doc, params.parentId);
  if (params.from === 'selection') layer.mask = masks().normalizeMask({ program: selectionAsMaskProgram(ctx, doc, layer) }, 'mask');
  withHistory(ctx, doc);
  const index = tree.insertAt(doc.layers, layer, parent && parent.id, params.index === undefined ? undefined : Number(params.index));
  touch(doc);
  ctx.store.emitChange(doc.id, 'adjustment.add');
  return respond(ctx, doc, 'adjustment.add', { layer, layerId: layer.id, index });
};

OPS['adjustment.update'] = async (params, ctx) => {
  const doc = requireDoc(ctx, params.documentId);
  const layer = requireLayer(doc, params.layerId);
  assert(layer.type === 'adjustment', 'NOT_AN_ADJUSTMENT', `layer "${layer.name}" is not an adjustment layer`);
  assertEditable(doc, layer, 'all');
  assert(params.adjustment && typeof params.adjustment === 'object', 'INVALID_ADJUSTMENT', 'adjustment is required (a patch of its settings, or a new kind)');
  const kindChanged = params.adjustment.kind && params.adjustment.kind !== layer.adjustment.kind;
  const next = adjSchema().normalizeAdjustment(kindChanged ? params.adjustment : Object.assign({}, layer.adjustment, params.adjustment), 'adjustment');
  withHistory(ctx, doc);
  layer.adjustment = next;
  touch(doc);
  ctx.store.emitChange(doc.id, 'adjustment.update');
  return respond(ctx, doc, 'adjustment.update', { layerId: layer.id, adjustment: next });
};

function requireFilterLayer(doc, layerId) {
  const layer = requireLayer(doc, layerId);
  requireDrawable(doc, layer);
  requireMasksAllowed(doc);
  assertEditable(doc, layer, 'all');
  return layer;
}
function requireFilter(layer, filterId) {
  const index = (layer.filters || []).findIndex((f) => f.id === filterId);
  assert(index >= 0, 'FILTER_NOT_FOUND', `smart filter not found: ${filterId}`, { known: (layer.filters || []).map((f) => ({ id: f.id, type: f.type })) });
  return index;
}

OPS['filter.add'] = async (params, ctx) => {
  const doc = requireDoc(ctx, params.documentId);
  const layer = requireFilterLayer(doc, params.layerId);
  const filter = adjSchema().normalizeFilter(params.filter, 'filter');
  const list = (layer.filters || []).slice();
  const index = params.index === undefined ? list.length : Number(params.index);
  assert(Number.isInteger(index) && index >= 0 && index <= list.length, 'INVALID_INDEX', `index must be between 0 and ${list.length}`);
  list.splice(index, 0, filter);
  const next = adjSchema().normalizeFilterList(list, 'layer');
  withHistory(ctx, doc);
  layer.filters = next;
  touch(doc);
  ctx.store.emitChange(doc.id, 'filter.add');
  return respond(ctx, doc, 'filter.add', { layerId: layer.id, filterId: filter.id, filter, filters: layer.filters });
};

OPS['filter.update'] = async (params, ctx) => {
  const doc = requireDoc(ctx, params.documentId);
  const layer = requireFilterLayer(doc, params.layerId);
  const index = requireFilter(layer, params.filterId);
  assert(params.patch && typeof params.patch === 'object', 'INVALID_PATCH', 'patch is required');
  const current = layer.filters[index];
  assert(params.patch.type === undefined || params.patch.type === current.type, 'INVALID_PATCH', 'a filter cannot change type; remove it and add another');
  const next = adjSchema().normalizeFilter(Object.assign({}, current, params.patch, { id: current.id, type: current.type }), 'filter');
  withHistory(ctx, doc);
  layer.filters[index] = next;
  touch(doc);
  ctx.store.emitChange(doc.id, 'filter.update');
  return respond(ctx, doc, 'filter.update', { layerId: layer.id, filter: next });
};

OPS['filter.remove'] = async (params, ctx) => {
  const doc = requireDoc(ctx, params.documentId);
  const layer = requireFilterLayer(doc, params.layerId);
  const index = requireFilter(layer, params.filterId);
  withHistory(ctx, doc);
  layer.filters.splice(index, 1);
  if (!layer.filters.length) delete layer.filters;
  touch(doc);
  ctx.store.emitChange(doc.id, 'filter.remove');
  return respond(ctx, doc, 'filter.remove', { layerId: layer.id, removed: params.filterId });
};

OPS['filter.move'] = async (params, ctx) => {
  const doc = requireDoc(ctx, params.documentId);
  const layer = requireFilterLayer(doc, params.layerId);
  const from = requireFilter(layer, params.filterId);
  const to = Number(params.index);
  assert(Number.isInteger(to) && to >= 0 && to < layer.filters.length, 'INVALID_INDEX', `index must be between 0 and ${layer.filters.length - 1}`);
  withHistory(ctx, doc);
  const [f] = layer.filters.splice(from, 1);
  layer.filters.splice(to, 0, f);
  touch(doc);
  ctx.store.emitChange(doc.id, 'filter.move');
  return respond(ctx, doc, 'filter.move', { layerId: layer.id, filterId: f.id, from, to });
};

/** Smart filter mask: limit the whole filter stack to the selection (from:"selection") or remove it (from:"none"). */
OPS['filter.mask'] = async (params, ctx) => {
  const doc = requireDoc(ctx, params.documentId);
  const layer = requireFilterLayer(doc, params.layerId);
  const from = params.from || 'selection';
  assert(['selection', 'none'].includes(from), 'INVALID_MASK', 'from must be selection or none');
  const next = from === 'none' ? undefined : masks().normalizeMask({ program: selectionAsMaskProgram(ctx, doc, layer), invert: params.invert, feather: params.feather }, 'filterMask');
  withHistory(ctx, doc);
  if (next) layer.filterMask = next; else delete layer.filterMask;
  touch(doc);
  ctx.store.emitChange(doc.id, 'filter.mask');
  return respond(ctx, doc, 'filter.mask', { layerId: layer.id, masked: Boolean(next) });
};

/** Replace an embedded image everywhere it is used; transforms, masks, filters and effects stay live. */
OPS['smart.replace'] = async (params, ctx) => {
  const doc = requireDoc(ctx, params.documentId);
  assert(typeof params.assetId === 'string', 'INVALID_ASSET', 'assetId (the image to replace) is required');
  let replacement = params.newAssetId;
  if (!replacement && params.dataUrl) replacement = (await ctx.assets.addFromDataUrl(params.dataUrl, { name: params.name || 'smart-replace' })).id;
  assert(replacement, 'INVALID_ASSET', 'provide newAssetId or dataUrl');
  ctx.assets.get(replacement);
  const hits = [];
  for (const layer of doc.layers) for (const o of layer.objects) if (o.type === 'image' && o.assetId === params.assetId) hits.push({ layer, o });
  assert(hits.length, 'ASSET_NOT_USED', `no image in this document uses ${params.assetId}`);
  for (const { layer } of hits) assertEditable(doc, layer, 'content');
  withHistory(ctx, doc);
  for (const { o } of hits) o.assetId = replacement;
  touch(doc);
  ctx.store.emitChange(doc.id, 'smart.replace');
  return respond(ctx, doc, 'smart.replace', { replaced: hits.length, assetId: replacement, objectIds: hits.map((h) => h.o.id) });
};

// ----------------------------------------------------------------- objects

async function addObject(ctx, doc, params, objectInput) {
  const layer = targetLayer(ctx, doc, params.layerId);
  assertEditable(doc, layer, 'content');
  withHistory(ctx, doc);
  const object = normalizeObject(objectInput, 'object');
  if (params.index === undefined) layer.objects.push(object);
  else {
    const index = Number(params.index);
    assert(Number.isInteger(index) && index >= 0 && index <= layer.objects.length, 'INVALID_INDEX',
      `index must be between 0 and ${layer.objects.length}`, { received: params.index });
    layer.objects.splice(index, 0, object);
  }
  touch(doc);
  ctx.store.emitChange(doc.id, `object.add:${object.type}`);
  return respond(ctx, doc, `object.add:${object.type}`, {
    object,
    objectId: object.id,
    layerId: layer.id,
  });
}

/** Add many objects as ONE undo step (used by the layout operations). */
async function addObjects(ctx, doc, params, inputs) {
  const layer = targetLayer(ctx, doc, params.layerId);
  assertEditable(doc, layer, 'content');
  const normalized = inputs.map((input, i) => normalizeObject(input, `objects[${i}]`));
  withHistory(ctx, doc);
  layer.objects.push(...normalized);
  touch(doc);
  ctx.store.emitChange(doc.id, `objects.add:${normalized.length}`);
  return { layer, objectIds: normalized.map((o) => o.id) };
}

// ------------------------------------------------------------------ parametric shapes and vector fill

const shapesLib = () => require('./shapes');

/** Shape spec from op params: kind + box (x, y, w, h) + the kind's parameters. */
function shapeSpecFrom(params, base) {
  const spec = Object.assign({}, base || {}, params.shape || {});
  for (const k of ['kind', 'sides', 'points', 'ratio', 'cornerRadius', 'start', 'sweep', 'turns', 'growth', 'direction', 'innerRatio', 'radius', 'smoothing']) {
    if (params[k] !== undefined) spec[k] = params[k];
  }
  if (params.x !== undefined || params.w !== undefined) spec.box = { x: params.x, y: params.y, w: params.w, h: params.h };
  return shapesLib().normalizeShapeSpec(spec, 'shape');
}

/**
 * Polygon, star, arc (pie/donut), spiral, or a rectangle with corner smoothing, stored as an editable path.
 * Closed shapes are filled; the spiral is a stroked line.
 */
OPS['draw.shape'] = async (params, ctx) => {
  const doc = requireDoc(ctx, params.documentId);
  const spec = shapeSpecFrom(params);
  const closed = shapesLib().isClosedShape(spec.kind);
  const input = {
    type: 'path', shape: spec, segments: shapesLib().shapeSegments(spec), closed,
    fill: closed ? (params.fill === undefined ? '#38bdf8' : params.fill) : null,
    stroke: params.stroke !== undefined ? params.stroke : (closed ? undefined : (params.fill || '#0b1220')),
    strokeWidth: params.strokeWidth !== undefined ? params.strokeWidth : (closed ? undefined : 3),
    lineCap: closed ? undefined : 'round', lineJoin: 'round',
    name: params.name || spec.kind, opacity: params.opacity, rotation: params.rotation,
  };
  return addObject(ctx, doc, params, input);
};

/**
 * Change a parametric shape's parameters (sides, points, ratio, corner radius, arc angles, turns, smoothing…).
 * The current position/size is read from the path itself, so moves and resizes are kept.
 */
OPS['shape.update'] = async (params, ctx) => {
  const doc = requireDoc(ctx, params.documentId);
  const found = requireObject(doc, params.objectId);
  assert(found.object.type === 'path' && found.object.shape, 'NOT_A_SHAPE', 'shape.update needs a parametric shape (made with draw.shape or shape.convert); edited vectors keep their anchors');
  assertEditable(doc, found.layer, 'content');
  const S = shapesLib();
  const old = found.object.shape;
  // Map the stored box through whatever move/resize was applied to the path since it was generated.
  const was = S.segmentsBox(S.shapeSegments(old)); const now = S.segmentsBox(found.object.segments);
  let box = old.box;
  if (was && now && was.w > 0 && was.h > 0) {
    const sx = now.w / was.w; const sy = now.h / was.h;
    box = { x: now.x + (old.box.x - was.x) * sx, y: now.y + (old.box.y - was.y) * sy, w: old.box.w * sx, h: old.box.h * sy };
  }
  const patchParams = Object.assign({}, params.params || {});
  if (params.kind && params.kind !== old.kind) patchParams.kind = params.kind;
  const spec = S.normalizeShapeSpec(Object.assign({}, old, patchParams, { box }), 'shape');
  const next = normalizeObject(Object.assign({}, found.object, { shape: spec, segments: S.shapeSegments(spec), closed: S.isClosedShape(spec.kind) }), 'object');
  withHistory(ctx, doc);
  found.layer.objects[found.objectIndex] = next;
  touch(doc);
  ctx.store.emitChange(doc.id, 'shape.update');
  return respond(ctx, doc, 'shape.update', { objectId: next.id, shape: spec });
};

/** Turn a rect or ellipse into a parametric shape in place (same id, order and style): rect → smoothed corners, ellipse → arc. */
OPS['shape.convert'] = async (params, ctx) => {
  const doc = requireDoc(ctx, params.documentId);
  const found = requireObject(doc, params.objectId);
  const o = found.object;
  assert(o.type === 'rect' || o.type === 'ellipse', 'NOT_CONVERTIBLE', 'shape.convert turns a rect (corner smoothing) or an ellipse (arc) into a parametric shape');
  assertEditable(doc, found.layer, 'content');
  const box = { x: o.x, y: o.y, w: o.w, h: o.h };
  const spec = o.type === 'rect'
    ? shapesLib().normalizeShapeSpec({ kind: 'rect', box, radius: params.radius !== undefined ? params.radius : o.radius || 0, smoothing: params.smoothing }, 'shape')
    : shapesLib().normalizeShapeSpec({ kind: 'arc', box, start: params.start, sweep: params.sweep === undefined ? 360 : params.sweep, ratio: params.ratio }, 'shape');
  const style = {};
  for (const k of Object.keys(o)) if (!['x', 'y', 'w', 'h', 'radius', 'type'].includes(k)) style[k] = o[k];
  const next = normalizeObject(Object.assign(style, { type: 'path', shape: spec, segments: shapesLib().shapeSegments(spec), closed: true }), 'object');
  withHistory(ctx, doc);
  found.layer.objects[found.objectIndex] = next;
  touch(doc);
  ctx.store.emitChange(doc.id, 'shape.convert');
  return respond(ctx, doc, 'shape.convert', { objectId: next.id, shape: spec });
};

/**
 * Paint bucket for vectors: fill the empty region enclosed by the drawn lines/shapes around (x, y) with a new
 * filled path placed under the existing objects of the layer. Fails when the region is open to the canvas edge.
 */
OPS['vector.fill'] = async (params, ctx) => {
  const doc = requireDoc(ctx, params.documentId);
  const x = Number(params.x); const y = Number(params.y);
  assert(Number.isFinite(x) && Number.isFinite(y), 'INVALID_POINT', 'x and y (document pixels) are required');
  const W = doc.canvas.width; const H = doc.canvas.height;
  assert(x >= 0 && y >= 0 && x < W && y < H, 'INVALID_POINT', 'the point is outside the canvas');
  const scale = Math.min(1, 2048 / Math.max(W, H));
  const bare = Object.assign({}, doc, { canvas: Object.assign({}, doc.canvas, { background: { type: 'none' }, effects: [] }) });
  const { renderToCanvas } = require('./exporter');
  const { canvas } = renderToCanvas(bare, { images: await loadImages(ctx, bare), applyAnimation: false, scale });
  const w = canvas.width; const h = canvas.height;
  const data = canvas.getContext('2d').getImageData(0, 0, w, h).data;
  const sx = Math.min(w - 1, Math.floor(x * scale)); const sy = Math.min(h - 1, Math.floor(y * scale));
  const blocked = (i) => data[i * 4 + 3] >= 128;
  assert(!blocked(sy * w + sx), 'NOT_EMPTY', 'click inside an empty area enclosed by lines or shapes (this point is already painted)');
  const mask = new Uint8Array(w * h);
  const stack = [sy * w + sx];
  mask[stack[0]] = 1;
  let open = false; let count = 0;
  while (stack.length) {
    const i = stack.pop(); count += 1;
    const px = i % w; const py = (i - px) / w;
    if (px === 0 || py === 0 || px === w - 1 || py === h - 1) open = true;
    for (const j of [px > 0 ? i - 1 : -1, px < w - 1 ? i + 1 : -1, py > 0 ? i - w : -1, py < h - 1 ? i + w : -1]) {
      if (j >= 0 && !mask[j] && !blocked(j)) { mask[j] = 1; stack.push(j); }
    }
  }
  assert(!open, 'REGION_NOT_CLOSED', 'this area is not enclosed: it leaks to the canvas edge. Close the shape first (or use a fill on a closed path)', { pixels: count });
  // Grow by 1.5px so the fill tucks under the boundary strokes (no hairline gap), then trace the outline.
  const grown = new Uint8Array(mask);
  const grow = Math.max(1, Math.round(1.5 * scale));
  for (let i = 0; i < mask.length; i += 1) {
    if (!mask[i]) continue;
    const px = i % w; const py = (i - px) / w;
    for (let dy = -grow; dy <= grow; dy += 1) for (let dx = -grow; dx <= grow; dx += 1) {
      const nx = px + dx; const ny = py + dy;
      if (nx >= 0 && ny >= 0 && nx < w && ny < h) grown[ny * w + nx] = 1;
    }
  }
  const outline = traceOutline(grown, w, h).map((p) => ({ x: p.x / scale, y: p.y / scale }));
  const pts = simplifyPolyline(outline, 0.6 / scale);
  assert(pts.length >= 3, 'REGION_TOO_SMALL', 'the enclosed area is too small to fill');
  const segments = pts.map((p, i) => ({ op: i ? 'L' : 'M', x: Math.round(p.x * 100) / 100, y: Math.round(p.y * 100) / 100 })).concat([{ op: 'Z' }]);
  const layer = targetLayer(ctx, doc, params.layerId);
  return addObject(ctx, doc, Object.assign({}, params, { layerId: layer.id, index: params.index === undefined ? 0 : params.index }),
    { type: 'path', segments, closed: true, fill: params.fill === undefined ? '#38bdf8' : params.fill, name: 'fill region' });
};

/** Outer boundary of the 1-pixels (Moore neighbour tracing), as pixel-corner points. */
function traceOutline(mask, w, h) {
  let start = -1;
  for (let i = 0; i < mask.length; i += 1) if (mask[i]) { start = i; break; }
  if (start < 0) return [];
  const at = (x, y) => x >= 0 && y >= 0 && x < w && y < h && mask[y * w + x] === 1;
  const dirs = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
  const sx = start % w; const sy = (start - sx) / w;
  let cx = sx; let cy = sy; let back = 6; // came from above (scan order)
  const out = [{ x: cx + 0.5, y: cy + 0.5 }];
  for (let guard = 0; guard < w * h * 4; guard += 1) {
    let found = false;
    for (let k = 0; k < 8; k += 1) {
      const d = (back + 1 + k) % 8;
      const nx = cx + dirs[d][0]; const ny = cy + dirs[d][1];
      if (at(nx, ny)) { back = (d + 4) % 8; cx = nx; cy = ny; found = true; break; }
    }
    if (!found || (cx === sx && cy === sy)) break;
    out.push({ x: cx + 0.5, y: cy + 0.5 });
  }
  return out;
}

/** Ramer–Douglas–Peucker on a closed outline. */
function simplifyPolyline(points, epsilon) {
  if (points.length < 4) return points;
  const rdp = (pts) => {
    if (pts.length < 3) return pts;
    const a = pts[0]; const b = pts[pts.length - 1];
    const dx = b.x - a.x; const dy = b.y - a.y; const l = Math.hypot(dx, dy) || 1;
    let max = 0; let idx = 0;
    for (let i = 1; i < pts.length - 1; i += 1) {
      const d = Math.abs(dy * pts[i].x - dx * pts[i].y + b.x * a.y - b.y * a.x) / l;
      if (d > max) { max = d; idx = i; }
    }
    if (max <= epsilon) return [a, b];
    return rdp(pts.slice(0, idx + 1)).slice(0, -1).concat(rdp(pts.slice(idx)));
  };
  const half = Math.floor(points.length / 2);
  return rdp(points.slice(0, half + 1)).slice(0, -1).concat(rdp(points.slice(half).concat([points[0]])).slice(0, -1));
}

/**
 * Fill (or clear) the face of a vector network that contains (x, y): the closed region bounded by its edges,
 * however they branch. fill:null removes that region's fill.
 */
OPS['network.fill'] = async (params, ctx) => {
  const doc = requireDoc(ctx, params.documentId);
  const found = requireObject(doc, params.objectId);
  assert(found.object.type === 'network', 'NOT_A_NETWORK', 'network.fill needs a vector network object');
  assertEditable(doc, found.layer, 'content');
  const face = shapesLib().networkFaceAt(found.object, Number(params.x), Number(params.y));
  assert(face, 'REGION_NOT_CLOSED', 'no closed region of this network contains the point');
  const key = (path) => path.map(([e]) => e).sort((a, b) => a - b).join(',');
  const regions = (found.object.regions || []).filter((r) => key(r.path) !== key(face.path));
  if (params.fill !== null) regions.push({ path: face.path, fill: params.fill === undefined ? '#38bdf8' : params.fill });
  const next = normalizeObject(Object.assign({}, found.object, { regions }), 'object');
  withHistory(ctx, doc);
  found.layer.objects[found.objectIndex] = next;
  touch(doc);
  ctx.store.emitChange(doc.id, 'network.fill');
  return respond(ctx, doc, 'network.fill', { objectId: next.id, regions: next.regions.length, filled: params.fill !== null });
};

OPS['object.add'] = async (params, ctx) => {
  const doc = requireDoc(ctx, params.documentId);
  assert(params.object && typeof params.object === 'object', 'INVALID_OBJECT', 'object is required');
  return addObject(ctx, doc, params, params.object);
};

const DRAW_OPS = {
  'draw.rect': 'rect',
  'draw.ellipse': 'ellipse',
  'draw.line': 'line',
  'draw.polygon': 'polygon',
  'draw.path': 'path',
  'draw.text': 'text',
  'draw.image': 'image',
  'draw.freehand': 'path',
  'draw.network': 'network',
};

for (const [opName, type] of Object.entries(DRAW_OPS)) {
  OPS[opName] = async (params, ctx) => {
    const doc = requireDoc(ctx, params.documentId);
    const input = Object.assign({}, params, { type });
    delete input.documentId;
    delete input.layerId;
    delete input.index;
    if (opName === 'draw.freehand') {
      assert(Array.isArray(params.points) && params.points.length >= 2, 'INVALID_POINTS',
        'draw.freehand needs at least two points');
      const smooth = params.smooth === undefined ? 0 : Math.max(0, Math.min(1, Number(params.smooth) || 0));
      const points = params.points.map((point) => ({ x: Number(point.x), y: Number(point.y) }));
      Object.assign(input, {
        // smooth > 0 turns the polyline into Catmull-Rom cubic Beziers through the same points.
        segments: smooth > 0 ? pointsToBezierSegments(points, smooth, Boolean(params.closed)).filter((s) => s.op !== 'Z')
          : points.map((point, i) => ({ op: i === 0 ? 'M' : 'L', x: point.x, y: point.y })),
        closed: Boolean(params.closed),
        fill: params.fill === undefined ? null : params.fill,
        stroke: params.stroke === undefined ? '#000000' : params.stroke,
        strokeWidth: params.strokeWidth === undefined ? 4 : params.strokeWidth,
        lineJoin: 'round',
        lineCap: 'round',
      });
      delete input.points;
      delete input.smooth;
    }
    return addObject(ctx, doc, params, input);
  };
}

OPS['draw.brush'] = async (params, ctx) => {
  const doc = requireDoc(ctx, params.documentId);
  const input = Object.assign({}, params, { type: 'brush' });
  delete input.documentId;
  delete input.layerId;
  delete input.index;
  return addObject(ctx, doc, params, input);
};

/** Organic vector stroke: one smooth, pressure-tapered filled path (editable, exportable as vector). */
OPS['draw.stroke'] = async (params, ctx) => {
  const doc = requireDoc(ctx, params.documentId);
  const built = require('./organic-brush').strokeObject(params);
  let outlineObjectId;
  let fillParams = params;
  if (built.outlineObject) {
    // The outline goes directly under the fill, at the same place in the layer.
    outlineObjectId = (await addObject(ctx, doc, params, built.outlineObject)).objectId;
    if (params.index !== undefined) fillParams = Object.assign({}, params, { index: Number(params.index) + 1 });
  }
  const res = await addObject(ctx, doc, fillParams, built.object);
  return Object.assign(res, { metrics: built.metrics }, outlineObjectId ? { outlineObjectId } : {});
};

OPS['draw.form'] = async (params, ctx) => {
  const doc = requireDoc(ctx, params.documentId);
  const objects = require('./form').buildForm(params);
  const added = await addObjects(ctx, doc, params, objects);
  return respond(ctx, doc, 'draw.form', { layerId: added.layer.id, objectIds: added.objectIds, parts: objects.map((o) => o.name) });
};

OPS['brush.presets'] = async () => ({
  op: 'brush.presets',
  presets: Object.entries(BRUSH_PRESETS).map(([name, p]) => Object.assign({ name }, p)),
  parameters: ['size', 'spacing', 'hardness', 'flow', 'angle', 'aspect', 'jitter', 'taper', 'seed', 'smooth (object)', 'points[].p pressure 0..1', 'colors[] along stroke', 'symmetry {axis, at}', 'repeat {count, dx, dy}', 'blend', 'blur', 'opacity'],
});

OPS['layout.table'] = async (params, ctx) => {
  const doc = requireDoc(ctx, params.documentId);
  const spec = Object.assign({}, params);
  if (spec.x === undefined) spec.x = Math.round(doc.canvas.width * 0.06);
  if (spec.y === undefined) spec.y = Math.round(doc.canvas.height * 0.08);
  if (spec.width === undefined) spec.width = doc.canvas.width - spec.x * 2;
  const result = layoutTable(measureCtx(), spec);
  const added = await addObjects(ctx, doc, params, result.objects);
  return respond(ctx, doc, 'layout.table', {
    layerId: added.layer.id, objectIds: added.objectIds, height: Number(result.height.toFixed(1)),
    headerHeight: Number(result.headerHeight.toFixed(1)), rowsDrawn: result.rowsDrawn, nextRow: result.nextRow,
    columns: result.columns, rtl: result.rtl, warnings: result.warnings,
  });
};

OPS['layout.flow'] = async (params, ctx) => {
  const doc = requireDoc(ctx, params.documentId);
  const spec = Object.assign({}, params);
  const margin = Math.round(doc.canvas.width * 0.08);
  if (spec.x === undefined) spec.x = margin;
  if (spec.y === undefined) spec.y = margin;
  if (spec.width === undefined) spec.width = doc.canvas.width - spec.x * 2;
  if (spec.height === undefined) spec.height = doc.canvas.height - spec.y - margin;
  const result = layoutFlow(measureCtx(), spec);
  let rulesLayer = null;
  if (spec.ruled && params.rulesLayerId) {
    const paper = ruledPaperObjects(Object.assign({ x: spec.x, y: spec.y, width: spec.width, height: spec.height, rtl: result.rtl }, spec.ruled));
    rulesLayer = await addObjects(ctx, doc, { layerId: params.rulesLayerId }, paper.objects);
  }
  const added = result.objects.length ? await addObjects(ctx, doc, params, result.objects) : { layer: targetLayer(ctx, doc, params.layerId), objectIds: [] };
  return respond(ctx, doc, 'layout.flow', {
    layerId: added.layer.id, objectIds: added.objectIds, rulesObjectIds: rulesLayer ? rulesLayer.objectIds : [],
    cursor: result.cursor, done: result.cursor === null, rtl: result.rtl, pitch: result.pitch,
    rules: result.rules.map((y) => Number(y.toFixed(2))),
    lines: result.placed.filter((p) => p.text !== undefined).map((p) => ({ block: p.block, line: p.line, baseline: Number(p.baseline.toFixed(2)), rule: p.rule === null ? null : Number(p.rule.toFixed(2)), size: p.size, ascent: Number(p.ascent.toFixed(2)), descent: Number(p.descent.toFixed(2)), text: p.text })),
    tables: result.placed.filter((p) => p.table),
    warnings: result.warnings,
  });
};

OPS['draw.ruledPaper'] = async (params, ctx) => {
  const doc = requireDoc(ctx, params.documentId);
  const spec = Object.assign({ x: 0, y: 0, width: doc.canvas.width, height: doc.canvas.height }, params);
  const paper = ruledPaperObjects(spec);
  const added = await addObjects(ctx, doc, params, paper.objects);
  return respond(ctx, doc, 'draw.ruledPaper', { layerId: added.layer.id, objectIds: added.objectIds, rules: paper.rules, spacing: paper.spacing });
};

OPS['draw.gradient'] = async (params, ctx) => {
  const doc = requireDoc(ctx, params.documentId);
  const input = {
    type: 'rect',
    x: params.x,
    y: params.y,
    w: params.w,
    h: params.h,
    radius: params.radius,
    opacity: params.opacity,
    rotation: params.rotation,
    shadow: params.shadow,
    fill: normalizePaint({
      type: ['radial', 'conic'].includes(params.gradientType) ? params.gradientType : 'linear',
      angle: params.angle === undefined ? (params.gradientType === 'conic' ? 0 : 90) : params.angle,
      cx: params.cx,
      cy: params.cy,
      r: params.r,
      stops: params.stops,
    }, 'stops'),
    blend: params.blend,
    blur: params.blur,
  };
  return addObject(ctx, doc, params, input);
};

OPS['object.update'] = async (params, ctx) => {
  const doc = requireDoc(ctx, params.documentId);
  const found = requireObject(doc, params.objectId);
  assert(params.patch && typeof params.patch === 'object', 'INVALID_PATCH', 'patch is required');
  const patchKeys = Object.keys(params.patch);
  if (patchKeys.some((k) => POSITION_KEYS.has(k))) assertEditable(doc, found.layer, 'position');
  if (patchKeys.some((k) => !POSITION_KEYS.has(k))) assertEditable(doc, found.layer, 'content');
  if (!patchKeys.length) assertEditable(doc, found.layer, 'content');
  withHistory(ctx, doc);
  const merged = Object.assign({}, found.object, params.patch, { id: found.object.id, type: found.object.type });
  // New text without new runs: keep the runs that still fit (clipped to the new length).
  if (merged.type === 'text' && params.patch.text !== undefined && params.patch.runs === undefined && Array.isArray(found.object.runs)) {
    const length = String(params.patch.text).length;
    merged.runs = found.object.runs.filter((r) => r.start < length).map((r) => Object.assign({}, r, { end: Math.min(r.end, length) }));
  }
  const normalized = normalizeObject(merged, 'object');
  found.layer.objects[found.objectIndex] = normalized;
  touch(doc);
  ctx.store.emitChange(doc.id, 'object.update');
  return respond(ctx, doc, 'object.update', {
    object: normalized,
    objectId: normalized.id,
    layerId: found.layer.id,
    changed: Object.keys(params.patch),
  });
};

/**
 * dx/dy move every geometry a type actually uses: x/y for boxes and text, points for polygons/brushes/freehand,
 * segments (with control points) for paths, both ends for lines. A clip moves with its object.
 * Shifting only x/y left point-based objects in place while the call reported success.
 */
function translatePatch(object, dx, dy) {
  const patch = {};
  const shiftSeg = (seg) => {
    const copy = Object.assign({}, seg);
    ['x', 'cx', 'c1x', 'c2x'].forEach((key) => { if (copy[key] !== undefined) copy[key] += dx; });
    ['y', 'cy', 'c1y', 'c2y'].forEach((key) => { if (copy[key] !== undefined) copy[key] += dy; });
    return copy;
  };
  if (Array.isArray(object.points)) patch.points = object.points.map((p) => Object.assign({}, p, { x: p.x + dx, y: p.y + dy }));
  if (Array.isArray(object.segments)) patch.segments = object.segments.map(shiftSeg);
  if (object.x1 !== undefined) Object.assign(patch, { x1: object.x1 + dx, y1: object.y1 + dy, x2: object.x2 + dx, y2: object.y2 + dy });
  if (object.x !== undefined || (!patch.points && !patch.segments && object.x1 === undefined)) {
    patch.x = (object.x === undefined ? 0 : object.x) + dx;
    patch.y = (object.y === undefined ? 0 : object.y) + dy;
  }
  if (object.clip) {
    const clip = Object.assign({}, object.clip);
    if (Array.isArray(clip.segments)) clip.segments = clip.segments.map(shiftSeg);
    if (clip.x !== undefined) clip.x += dx;
    if (clip.y !== undefined) clip.y += dy;
    patch.clip = clip;
  }
  return patch;
}

OPS['object.transform'] = async (params, ctx) => {
  if (params.objectIds !== undefined || params.pivot !== undefined) return transformAboutPivot(params, ctx);
  const doc = requireDoc(ctx, params.documentId);
  const found = requireObject(doc, params.objectId);
  assertEditable(doc, found.layer, 'position');
  const measure = measureCtx();
  withHistory(ctx, doc);
  const previousBox = bboxOf(found.object, measure);
  const object = found.object;
  const patch = {};
  if (params.dx !== undefined || params.dy !== undefined) Object.assign(patch, translatePatch(object, Number(params.dx || 0), Number(params.dy || 0)));
  if (params.x !== undefined) patch.x = Number(params.x);
  if (params.y !== undefined) patch.y = Number(params.y);
  if (params.width !== undefined) patch.w = Number(params.width);
  if (params.height !== undefined) patch.h = Number(params.height);
  if (params.scale !== undefined) {
    const scale = Number(params.scale);
    assert(Number.isFinite(scale) && scale > 0 && scale <= 50, 'INVALID_SCALE',
      'scale must be greater than 0 and at most 50', { received: params.scale });
    if (object.w !== undefined) patch.w = object.w * scale;
    if (object.h !== undefined) patch.h = object.h * scale;
    if (object.font) patch.font = Object.assign({}, object.font, { size: object.font.size * scale });
    if (object.points) patch.points = object.points.map((p) => ({ x: p.x * scale, y: p.y * scale }));
    if (object.segments) {
      patch.segments = object.segments.map((seg) => {
        const copy = Object.assign({}, seg);
        ['x', 'cx', 'c1x', 'c2x'].forEach((key) => { if (copy[key] !== undefined) copy[key] *= scale; });
        ['y', 'cy', 'c1y', 'c2y'].forEach((key) => { if (copy[key] !== undefined) copy[key] *= scale; });
        return copy;
      });
    }
    if (object.strokeWidth !== undefined) patch.strokeWidth = object.strokeWidth * scale;
  }
  if (params.rotation !== undefined) {
    const rotation = Number(params.rotation);
    assert(Number.isFinite(rotation), 'INVALID_NUMBER', 'rotation must be a number in degrees');
    patch.rotation = params.rotationMode === 'delta' ? (object.rotation || 0) + rotation : rotation;
  }
  const merged = Object.assign({}, object, patch, { id: object.id, type: object.type });
  found.layer.objects[found.objectIndex] = normalizeObject(merged, 'object');
  touch(doc);
  ctx.store.emitChange(doc.id, 'object.transform');
  return respond(ctx, doc, 'object.transform', {
    object: found.layer.objects[found.objectIndex],
    objectId: object.id,
    previousBox,
    box: bboxOf(found.layer.objects[found.objectIndex], measure),
  });
};

function applyAlignment(doc, ids, mode, target, measure) {
  for (const id of ids) {
    const found = requireObject(doc, id);
    const object = found.object;
    const box = bboxOf(object, measure);
    let dx = 0;
    let dy = 0;
    if (mode === 'left') dx = target.x - box.x;
    if (mode === 'right') dx = target.x + target.w - (box.x + box.w);
    if (mode === 'center') dx = target.x + target.w / 2 - (box.x + box.w / 2);
    if (mode === 'top') dy = target.y - box.y;
    if (mode === 'bottom') dy = target.y + target.h - (box.y + box.h);
    if (mode === 'middle') dy = target.y + target.h / 2 - (box.y + box.h / 2);
    found.layer.objects[found.objectIndex] = normalizeObject(
      Object.assign({}, object, translatePatch(object, dx, dy), { id: object.id, type: object.type }),
      'object',
    );
  }
}

OPS['object.align'] = async (params, ctx) => {
  const doc = requireDoc(ctx, params.documentId);
  assert(Array.isArray(params.objectIds) && params.objectIds.length, 'INVALID_OBJECT_IDS',
    'objectIds must be a non-empty array');
  assert(['left', 'center', 'right', 'top', 'middle', 'bottom'].includes(params.align), 'INVALID_ALIGN',
    'align must be left, center, right, top, middle or bottom', { received: params.align });
  for (const id of params.objectIds) assertEditable(doc, requireObject(doc, id).layer, 'position');
  const measure = measureCtx();
  withHistory(ctx, doc);
  let target = { x: 0, y: 0, w: doc.canvas.width, h: doc.canvas.height };
  if (params.relativeTo === 'selection') {
    const boxes = params.objectIds.map((id) => bboxOf(requireObject(doc, id).object, measure));
    const minX = Math.min.apply(null, boxes.map((b) => b.x));
    const maxX = Math.max.apply(null, boxes.map((b) => b.x + b.w));
    const minY = Math.min.apply(null, boxes.map((b) => b.y));
    const maxY = Math.max.apply(null, boxes.map((b) => b.y + b.h));
    target = { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  }
  applyAlignment(doc, params.objectIds, params.align, target, measure);
  touch(doc);
  ctx.store.emitChange(doc.id, 'object.align');
  return respond(ctx, doc, 'object.align', { aligned: params.objectIds, align: params.align });
};

OPS['object.delete'] = async (params, ctx) => {
  const doc = requireDoc(ctx, params.documentId);
  const found = requireObject(doc, params.objectId);
  assertEditable(doc, found.layer, 'content');
  withHistory(ctx, doc);
  found.layer.objects.splice(found.objectIndex, 1);
  touch(doc);
  ctx.store.emitChange(doc.id, 'object.delete');
  return respond(ctx, doc, 'object.delete', { removed: found.object.id, layerId: found.layer.id });
};

OPS['object.duplicate'] = async (params, ctx) => {
  const doc = requireDoc(ctx, params.documentId);
  const found = requireObject(doc, params.objectId);
  assertEditable(doc, found.layer, 'content');
  const dx = Number(params.dx === undefined ? 24 : params.dx);
  const dy = Number(params.dy === undefined ? 24 : params.dy);
  withHistory(ctx, doc);
  const copy = JSON.parse(JSON.stringify(found.object));
  copy.id = makeId('obj');
  if (copy.x !== undefined) copy.x += dx;
  if (copy.y !== undefined) copy.y += dy;
  if (copy.x1 !== undefined) { copy.x1 += dx; copy.y1 += dy; }
  if (copy.x2 !== undefined) { copy.x2 += dx; copy.y2 += dy; }
  if (copy.points) copy.points = copy.points.map((p) => ({ x: p.x + dx, y: p.y + dy }));
  if (copy.segments) {
    copy.segments = copy.segments.map((seg) => {
      const next = Object.assign({}, seg);
      ['x', 'cx', 'c1x', 'c2x'].forEach((key) => { if (next[key] !== undefined) next[key] += dx; });
      ['y', 'cy', 'c1y', 'c2y'].forEach((key) => { if (next[key] !== undefined) next[key] += dy; });
      return next;
    });
  }
  found.layer.objects.push(copy);
  touch(doc);
  ctx.store.emitChange(doc.id, 'object.duplicate');
  return respond(ctx, doc, 'object.duplicate', { object: copy, objectId: copy.id, layerId: found.layer.id });
};

OPS['object.list'] = async (params, ctx) => {
  const doc = requireDoc(ctx, params.documentId);
  const measure = measureCtx();
  const objects = [];
  doc.layers.forEach((layer, layerIndex) => {
    layer.objects.forEach((object, index) => {
      objects.push({
        id: object.id,
        type: object.type,
        name: object.name || null,
        layerId: layer.id,
        layerIndex,
        index,
        box: bboxOf(object, measure),
        opacity: object.opacity,
        rotation: object.rotation,
      });
    });
  });
  return { op: 'object.list', documentId: doc.id, count: objects.length, objects };
};

OPS['object.measure'] = async (params, ctx) => {
  const doc = requireDoc(ctx, params.documentId);
  const measure = measureCtx();
  const ids = Array.isArray(params.objectIds) && params.objectIds.length
    ? params.objectIds
    : doc.layers.flatMap((layer) => layer.objects.map((object) => object.id));
  return {
    op: 'object.measure',
    documentId: doc.id,
    boxes: ids.map((id) => {
      const found = requireObject(doc, id);
      return { objectId: id, type: found.object.type, box: bboxOf(found.object, measure) };
    }),
  };
};

OPS['object.move'] = async (params, ctx) => {
  const doc = requireDoc(ctx, params.documentId);
  const found = requireObject(doc, params.objectId);
  const destination = params.targetLayerId ? requireDrawable(doc, requireLayer(doc, params.targetLayerId)) : found.layer;
  assertEditable(doc, found.layer, 'content');
  if (destination !== found.layer) assertEditable(doc, destination, 'content');
  withHistory(ctx, doc);
  const [object] = found.layer.objects.splice(found.objectIndex, 1);
  const index = params.index === undefined ? destination.objects.length : Number(params.index);
  assert(Number.isInteger(index) && index >= 0 && index <= destination.objects.length, 'INVALID_INDEX',
    `index must be between 0 and ${destination.objects.length}`, { received: params.index });
  destination.objects.splice(index, 0, object);
  touch(doc);
  ctx.store.emitChange(doc.id, 'object.move');
  return respond(ctx, doc, 'object.move', { objectId: object.id, layerId: destination.id, index });
};

// ------------------------------------------------------ text, fonts, colours

/**
 * Style a range of a text object (Photoshop's character panel on a selection): font fields, fill and
 * underline merge into the runs over [start, end); clear:true removes run styling there.
 */
OPS['text.style'] = async (params, ctx) => {
  const doc = requireDoc(ctx, params.documentId);
  const found = requireObject(doc, params.objectId);
  assert(found.object.type === 'text', 'NOT_TEXT', 'text.style needs a text object');
  assertEditable(doc, found.layer, 'content');
  const text = found.object.text;
  const start = params.start === undefined ? 0 : Number(params.start);
  const end = params.end === undefined ? text.length : Number(params.end);
  assert(Number.isInteger(start) && Number.isInteger(end) && start >= 0 && end > start && end <= text.length, 'INVALID_RUNS',
    `start/end must be whole numbers with start < end <= ${text.length}`, { start: params.start, end: params.end });
  const style = params.style || {};
  assert(params.clear || (typeof style === 'object' && (style.font || style.fill !== undefined || style.underline !== undefined)), 'INVALID_RUNS', 'style {font?, fill?, underline?} or clear:true is required');
  const runs = found.object.runs || [];
  const cuts = [...new Set([0, text.length, start, end].concat(...runs.map((r) => [r.start, r.end])))].sort((a, b) => a - b);
  const segments = [];
  for (let i = 0; i < cuts.length - 1; i += 1) {
    const a = cuts[i]; const b = cuts[i + 1];
    const old = runs.find((r) => r.start <= a && r.end >= b);
    let seg = old ? { font: old.font, fill: old.fill, underline: old.underline } : {};
    if (a >= start && b <= end) {
      if (params.clear) seg = {};
      else {
        seg = Object.assign({}, seg);
        if (style.font) seg.font = Object.assign({}, seg.font || {}, style.font);
        if (style.fill !== undefined) seg.fill = style.fill;
        if (style.underline !== undefined) seg.underline = Boolean(style.underline);
      }
    }
    segments.push(Object.assign({ start: a, end: b }, seg));
  }
  const merged = [];
  const key = (s) => JSON.stringify([s.font || null, s.fill === undefined ? null : s.fill, Boolean(s.underline)]);
  for (const s of segments) {
    const last = merged[merged.length - 1];
    if (last && last.end === s.start && key(last) === key(s)) last.end = s.end; else merged.push(s);
  }
  const next = merged.filter((s) => s.font || s.fill !== undefined || s.underline).map((s) => {
    const r = { start: s.start, end: s.end };
    if (s.font) r.font = s.font;
    if (s.fill !== undefined) r.fill = s.fill;
    if (s.underline) r.underline = true;
    return r;
  });
  const normalized = normalizeObject(Object.assign({}, found.object, { runs: next }), 'object');
  withHistory(ctx, doc);
  found.layer.objects[found.objectIndex] = normalized;
  touch(doc);
  ctx.store.emitChange(doc.id, 'text.style');
  return respond(ctx, doc, 'text.style', { objectId: normalized.id, layerId: found.layer.id, runs: normalized.runs || [] });
};

OPS['text.measure'] = async (params, ctx) => {
  assert(params.text !== undefined, 'INVALID_TEXT', 'text is required');
  const measure = measureCtx();
  const font = normalizeFont(params.font);
  measure.font = fontString(font);
  const layout = layoutText(measure, {
    text: params.text,
    font,
    maxWidth: params.maxWidth,
    align: params.align,
    rtl: params.rtl,
  });
  return {
    op: 'text.measure',
    font,
    lines: layout.lines.map((line) => ({ text: line.text, width: Number(line.width.toFixed(2)) })),
    contentWidth: Number(layout.contentWidth.toFixed(2)),
    contentHeight: Number(layout.contentHeight.toFixed(2)),
    lineHeight: Number(layout.lineHeight.toFixed(2)),
    align: layout.align,
    rtl: layout.rtl,
    ascent: Number(layout.ascent.toFixed(2)),
    descent: Number(layout.descent.toFixed(2)),
    overflowWords: layout.overflowWords,
  };
};

OPS['font.list'] = async (params, ctx) => {
  const fonts = listFonts(ctx.fontsDir);
  const filtered = params.arabicOnly ? fonts.filter((font) => font.arabic) : fonts;
  return {
    op: 'font.list',
    total: filtered.length,
    arabicCapable: fonts.filter((font) => font.arabic).length,
    arabicFamilies: new Set(fonts.filter((font) => font.arabic).map((font) => font.family)).size,
    uniqueFamilies: new Set(fonts.map((font) => font.family)).size,
    fonts: filtered.slice(0, params.limit || 400),
  };
};

OPS['font.resolve'] = async (params, ctx) => {
  const resolved = resolveFamily(params.family, ctx.fontsDir);
  return {
    op: 'font.resolve',
    requested: params.family || null,
    resolved,
    arabic: resolved ? hasArabicGlyphs(resolved) : false,
  };
};

OPS['color.palette'] = async (params, ctx) => {
  if (params.assetId) {
    return { op: 'color.palette', source: 'asset', assetId: params.assetId, colors: await ctx.assets.palette(params.assetId, params.count) };
  }
  assert(params.path, 'INVALID_PATH', 'provide assetId or path');
  const asset = await ctx.assets.addFromFile(params.path, { name: `palette:${path.basename(params.path)}` });
  return { op: 'color.palette', source: 'file', assetId: asset.id, path: asset.name, colors: await ctx.assets.palette(asset.id, params.count) };
};

OPS['color.gradient'] = async (params, ctx) => {
  const gradient = normalizePaint({
    type: params.gradientType === 'radial' ? 'radial' : 'linear',
    stops: params.stops,
    angle: params.angle === undefined ? 90 : params.angle,
  }, 'stops');
  const stopList = gradient.stops.map((s) => `${s.color} ${Math.round(s.offset * 100)}%`).join(', ');
  return {
    op: 'color.gradient',
    gradient,
    css: gradient.type === 'linear' ? `linear-gradient(${gradient.angle}deg, ${stopList})` : `radial-gradient(${stopList})`,
  };
};

// ------------------------------------------------------------------- images

OPS['image.add'] = async (params, ctx) => {
  if (params.dataUrl) {
    return { op: 'image.add', asset: await ctx.assets.addFromDataUrl(params.dataUrl, { name: params.name }) };
  }
  assert(params.path, 'INVALID_PATH', 'provide path or dataUrl');
  return { op: 'image.add', asset: await ctx.assets.addFromFile(params.path, { name: params.name }) };
};

OPS['image.analyze'] = async (params, ctx) => {
  let assetId = params.assetId;
  if (!assetId) {
    assert(params.path, 'INVALID_PATH', 'provide assetId or path');
    assetId = (await ctx.assets.addFromFile(params.path, { name: `reference:${path.basename(params.path)}` })).id;
  }
  const image = await ctx.assets.load(assetId);
  const analysis = await analyzeImage(image);
  return Object.assign({ op: 'image.analyze', assetId, colors: await ctx.assets.palette(assetId, params.count || 6) }, analysis);
};

OPS['qa.check'] = async (params, ctx) => {
  const doc = requireDoc(ctx, params.documentId);
  const images = await loadImages(ctx, doc);
  return Object.assign({ op: 'qa.check', documentId: doc.id }, qaCheck(doc, images, { ruled: params.ruled, palette: Array.isArray(params.palette) ? params.palette.slice(0, 24).map(String) : undefined }));
};

OPS['qa.visibility'] = async (params, ctx) => {
  const doc = requireDoc(ctx, params.documentId);
  assert(Array.isArray(params.groups) && params.groups.length, 'INVALID_GROUPS', 'groups must be a non-empty array of {id, objectIds[]}');
  const images = await loadImages(ctx, doc);
  return Object.assign({ op: 'qa.visibility', documentId: doc.id }, require('./qa').visibility(doc, images, params.groups, { scale: params.scale, threshold: params.threshold }));
};

OPS['image.list'] = async (params, ctx) => ({
  op: 'image.list',
  assets: ctx.assets.list().map((asset) => ({
    id: asset.id,
    name: asset.name,
    bytes: asset.bytes,
    sha256: asset.sha256,
    url: `/assets/${asset.file}`,
  })),
});

OPS['image.remove'] = async (params, ctx) => {
  assert(params.assetId, 'INVALID_ASSET', 'assetId is required');
  const registry=require('./material-assets').getMaterialAssets(ctx);registry.assertAssetRemovable(params.assetId);
  const result=ctx.assets.remove(params.assetId);registry.onAssetRemoved(params.assetId);
  return Object.assign({ op: 'image.remove' }, result);
};

// ---------------------------------------------------------------- animation

OPS['animation.set'] = async (params, ctx) => {
  const doc = requireDoc(ctx, params.documentId);
  withHistory(ctx, doc);
  doc.animation = normalizeAnimation({
    enabled: params.enabled === undefined ? doc.animation.enabled : params.enabled,
    duration: params.duration === undefined ? doc.animation.duration : params.duration,
    fps: params.fps === undefined ? doc.animation.fps : params.fps,
    loop: params.loop === undefined ? doc.animation.loop : params.loop,
    tracks: doc.animation.tracks,
  });
  touch(doc);
  ctx.store.emitChange(doc.id, 'animation.set');
  return respond(ctx, doc, 'animation.set', { animation: doc.animation });
};

OPS['animation.addTrack'] = async (params, ctx) => {
  const doc = requireDoc(ctx, params.documentId);
  requireObject(doc, params.targetId);
  withHistory(ctx, doc);
  const track = normalizeTrack({
    targetId: params.targetId,
    property: params.property,
    keyframes: params.keyframes,
  }, doc.animation.tracks.length);
  doc.animation.tracks.push(track);
  doc.animation.enabled = true;
  touch(doc);
  ctx.store.emitChange(doc.id, 'animation.addTrack');
  return respond(ctx, doc, 'animation.addTrack', { track, animation: doc.animation });
};

OPS['animation.addKey'] = async (params, ctx) => {
  const doc = requireDoc(ctx, params.documentId);
  const found = requireObject(doc, params.targetId);
  assert(ANIMATABLE.includes(params.property), 'INVALID_ANIMATION',
    `property must be one of: ${ANIMATABLE.join(', ')}`, { received: params.property });
  withHistory(ctx, doc);
  let track = doc.animation.tracks.find((item) => item.targetId === params.targetId && item.property === params.property);
  const time = Number(params.time === undefined ? 0 : params.time);
  assert(Number.isFinite(time) && time >= 0, 'INVALID_ANIMATION', 'time must be a number >= 0');
  const value = Number(params.value);
  assert(Number.isFinite(value), 'INVALID_ANIMATION', 'value must be a number');
  if (!track) {
    const base = params.baseValue === undefined ? Number(found.object[params.property] || 0) : Number(params.baseValue);
    track = normalizeTrack({
      targetId: params.targetId,
      property: params.property,
      keyframes: [
        { t: 0, value: base, easing: 'easeInOut' },
        { t: time > 0 ? time : doc.animation.duration, value, easing: 'easeInOut' },
      ],
    }, doc.animation.tracks.length);
    doc.animation.tracks.push(track);
  } else {
    track.keyframes = track.keyframes
      .filter((keyframe) => keyframe.t !== time)
      .concat([{ t: time, value, easing: params.easing || 'easeInOut' }])
      .sort((a, b) => a.t - b.t);
  }
  doc.animation.enabled = true;
  touch(doc);
  ctx.store.emitChange(doc.id, 'animation.addKey');
  return respond(ctx, doc, 'animation.addKey', { track, animation: doc.animation });
};

OPS['animation.removeTrack'] = async (params, ctx) => {  const doc = requireDoc(ctx, params.documentId);
  const index = doc.animation.tracks.findIndex((track) => track.id === params.trackId);
  assert(index >= 0, 'TRACK_NOT_FOUND', `animation track not found: ${params.trackId}`);
  withHistory(ctx, doc);
  doc.animation.tracks.splice(index, 1);
  touch(doc);
  ctx.store.emitChange(doc.id, 'animation.removeTrack');
  return respond(ctx, doc, 'animation.removeTrack', { removed: params.trackId });
};

OPS['animation.clear'] = async (params, ctx) => {
  const doc = requireDoc(ctx, params.documentId);
  withHistory(ctx, doc);
  doc.animation.tracks = [];
  doc.animation.enabled = false;
  touch(doc);
  ctx.store.emitChange(doc.id, 'animation.clear');
  return respond(ctx, doc, 'animation.clear', { animation: doc.animation });
};

OPS['animation.info'] = async (params, ctx) => {
  const doc = requireDoc(ctx, params.documentId);
  return {
    op: 'animation.info',
    documentId: doc.id,
    animation: doc.animation,
    trackCount: doc.animation.tracks.length,
    supportedProperties: ANIMATABLE,
  };
};

OPS['animation.frame'] = async (params, ctx) => {
  const doc = requireDoc(ctx, params.documentId);
  const images = await loadImages(ctx, doc);
  const time = Number(params.time || 0);
  const preview = renderPreview(doc, { images, maxWidth: params.maxWidth || 900, time });
  return respond(ctx, doc, 'animation.frame', {
    time,
    width: preview.width,
    height: preview.height,
    sha256: preview.sha256,
    dataUrl: `data:image/png;base64,${preview.base64}`,
    base64: preview.base64,
  });
};

// ------------------------------------------------------------------- export

function sanitize(name) {
  return String(name || 'design').replace(/[^\p{L}\p{N}_-]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'design';
}

OPS['export.image'] = async (params, ctx) => {
  const doc = requireDoc(ctx, params.documentId);
  const images = await loadImages(ctx, doc);
  const format = String(params.format || 'png').toLowerCase().replace('jpg', 'jpeg');
  const extension = format === 'jpeg' ? 'jpg' : format;
  const outPath = params.outPath
    ? path.resolve(ctx.workspaceRoot, params.outPath)
    : path.join(ctx.exportsDir, `${sanitize(doc.name)}-${Date.now()}.${extension}`);
  const result = exportImage(doc, {
    format,
    convertTo: params.convertTo,
    icc: params.icc,
    quality: params.quality,
    scale: params.scale,
    time: params.time,
    applyAnimation: params.static ? false : true,
    outPath,
    images,
  });
  return respond(ctx, doc, 'export.image', result);
};

/** Editable SVG: vectors and text stay editable; only what SVG cannot express is rasterised per object. */
OPS['export.svg'] = async (params, ctx) => {
  const doc = requireDoc(ctx, params.documentId);
  const images = await loadImages(ctx, doc);
  const result = require('./svg-exporter').exportSvg(doc, { images });
  const out = { op: 'export.svg', documentId: doc.id, bytes: Buffer.byteLength(result.svg), vectorObjects: result.vectorObjects, textObjects: result.textObjects, rasterized: result.rasterized, warnings: result.warnings };
  if (params.outPath) {
    const outPath = path.resolve(ctx.workspaceRoot, params.outPath);
    assert(/\.svg$/i.test(outPath), 'INVALID_PATH', 'outPath must end with .svg');
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, result.svg, 'utf8');
    out.path = outPath;
  }
  if (params.inline !== false && !params.outPath) out.svg = result.svg;
  return out;
};

OPS['export.pdf'] = async (params, ctx) => {
  const doc = requireDoc(ctx, params.documentId);
  const outPath = params.outPath ? path.resolve(ctx.workspaceRoot, params.outPath) : path.join(ctx.exportsDir, doc.id + '.pdf');
  assert(/\.pdf$/i.test(outPath), 'INVALID_PATH', 'outPath must end with .pdf');
  const images = await loadImages(ctx, doc);
  const result = await require('./pdf-exporter').exportPdf(doc, { images });
  require('./operation-context').checkpoint();
  fs.mkdirSync(path.dirname(outPath), { recursive: true }); fs.writeFileSync(outPath, result.buffer);
  return { op:'export.pdf', documentId:doc.id, path:outPath, bytes:result.buffer.length, backend:result.backend, statsBasis:result.statsBasis, svgSourceStats:result.svgSourceStats, pdfObservedStats:result.pdfObservedStats, rasterizationCandidates:result.rasterizationCandidates, vectorObjects:result.vectorObjects, textObjects:result.textObjects, rasterized:result.rasterized, warnings:result.warnings };
};

OPS['export.bundle'] = async (params, ctx) => {
  const doc = requireDoc(ctx, params.documentId);
  const result = require('./project-bundle').exportBundle(doc, ctx);
  const outPath = params.outPath ? path.resolve(ctx.workspaceRoot, params.outPath) : path.join(ctx.exportsDir, doc.id + '.artforge.zip');
  assert(/\.zip$/i.test(outPath), 'INVALID_PATH', 'Bundle output must end with .zip');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, result.buffer);
  return { op:'export.bundle',documentId:doc.id,path:outPath,bytes:result.buffer.length,manifest:result.manifest };
};

/** Alpha bounds of a canvas → cropped {canvas, x, y} (null when fully transparent). */
function cropToAlpha(canvas) {
  const w = canvas.width; const h = canvas.height;
  const data = canvas.getContext('2d').getImageData(0, 0, w, h).data;
  let x0 = w; let y0 = h; let x1 = -1; let y1 = -1;
  for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) {
    if (data[(y * w + x) * 4 + 3]) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  }
  if (x1 < 0) return null;
  const out = createCanvas(x1 - x0 + 1, y1 - y0 + 1);
  out.getContext('2d').drawImage(canvas, -x0, -y0);
  return { canvas: out, x: x0, y: y0 };
}

/**
 * Photoshop PSD (RGB 8-bit) with declared limits: pixel layers, groups, names, opacity, blend, visibility,
 * clipping, simple native adjustments, merged composite and ICC profile. The `report` lists every loss.
 */
OPS['export.psd'] = async (params, ctx) => {
  const doc = requireDoc(ctx, params.documentId);
  const images = await loadImages(ctx, doc);
  const { renderToCanvas } = require('./exporter');
  const blank = Object.assign({}, doc.canvas, { background: { type: 'none' }, effects: [] });
  const composite = renderToCanvas(doc, { images, applyAnimation: false }).canvas;
  const layerPixels = (layer) => {
    const single = Object.assign({}, doc, { canvas: blank, layers: [Object.assign({}, layer, { opacity: 1, blend: 'source-over', visible: true, parentId: undefined, clipped: undefined })] });
    return cropToAlpha(renderToCanvas(single, { images, applyAnimation: false }).canvas);
  };
  let background = null;
  if (doc.canvas.background && doc.canvas.background.type !== 'none') {
    const bgDoc = Object.assign({}, doc, { canvas: Object.assign({}, doc.canvas, { effects: [] }), layers: [] });
    background = { canvas: renderToCanvas(bgDoc, { images, applyAnimation: false }).canvas, x: 0, y: 0 };
  }
  const profile = doc.canvas.colorProfile || 'srgb';
  const { buffer, report } = require('./psd').writePsd(doc, { composite, layerPixels, background, iccProfile: require('./color-profiles').iccProfile(profile) });
  require('./operation-context').checkpoint();
  const outPath = params.outPath ? path.resolve(ctx.workspaceRoot, params.outPath) : path.join(ctx.exportsDir, `${sanitize(doc.name)}-${Date.now()}.psd`);
  assert(/\.psd$/i.test(outPath), 'INVALID_PATH', 'outPath must end with .psd');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, buffer);
  const losses = report.filter((r) => r.loss);
  return { op: 'export.psd', documentId: doc.id, path: outPath, bytes: buffer.length, width: doc.canvas.width, height: doc.canvas.height,
    colorProfile: profile, layers: report.length, lossless: losses.length === 0, report };
};

const PSD_MAX_BYTES = 256 * 1024 * 1024;

/** Open a PSD (RGB 8-bit) as a new document: pixel layers, groups, masks, clipping, simple adjustments; report lists losses. */
OPS['document.importPsd'] = async (params, ctx) => {
  let buffer;
  if (typeof params.base64 === 'string') {
    assert(params.base64.length <= Math.ceil(PSD_MAX_BYTES / 3) * 4 && /^[A-Za-z0-9+/]*={0,2}$/.test(params.base64), 'INVALID_PSD', 'base64 must be a PSD of at most 256 MB');
    buffer = Buffer.from(params.base64, 'base64');
  } else {
    assert(typeof params.path === 'string', 'INVALID_PSD', 'provide path (a .psd file) or base64');
    const file = path.resolve(ctx.workspaceRoot, params.path);
    assert(/\.psd$/i.test(file) && fs.existsSync(file), 'INVALID_PSD', `PSD file not found: ${file}`);
    assert(fs.statSync(file).size <= PSD_MAX_BYTES, 'INVALID_PSD', 'PSD is larger than 256 MB');
    buffer = fs.readFileSync(file);
  }
  const psd = require('./psd').readPsd(buffer);
  const report = psd.report.slice();
  const colors = require('./color-profiles');
  let colorProfile = 'srgb';
  if (psd.icc) {
    const id = colors.identifyProfile(psd.icc);
    if (id.name) colorProfile = id.name;
    else report.push({ name: 'document', loss: `embedded ICC profile "${id.label || 'unknown'}" is not supported; pixels kept as they are and tagged sRGB` });
  }
  const W = psd.width; const H = psd.height;
  const doc = ctx.store.create({ name: params.name || 'Imported PSD', width: W, height: H, background: { type: 'none' }, compositing: 'v2', colorProfile, createdBy: 'artforge-psd-import' });
  const store = rasterLib().tileStore(ctx);
  const groups = new Map();
  const groupFor = (psdId) => { if (!groups.has(psdId)) groups.set(psdId, normalizeLayer({ type: 'group', name: 'Group' }, 0)); return groups.get(psdId); };
  const layers = [];
  const paintTiles = (layer, item) => {
    const x0 = Math.max(0, item.x); const y0 = Math.max(0, item.y);
    const x1 = Math.min(W, item.x + item.width); const y1 = Math.min(H, item.y + item.height);
    if (x0 !== item.x || y0 !== item.y || x1 !== item.x + item.width || y1 !== item.y + item.height) report.push({ name: item.name, loss: 'pixels outside the canvas were cropped' });
    if (x1 <= x0 || y1 <= y0) return {};
    const rect = rasterLib().alignRect({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
    const canvas = createCanvas(rect.w, rect.h);
    const c = canvas.getContext('2d');
    const img = c.createImageData(item.width, item.height);
    img.data.set(item.rgba);
    c.putImageData(img, item.x - rect.x, item.y - rect.y);
    return rasterLib().writeRegion(store, layer, rect, canvas);
  };
  const maskFrom = (m) => {
    const values = new Uint8Array(m.width * m.height);
    if (m.defaultColor) for (let i = 0; i < values.length; i += 1) values[i] = 255 - m.values[i]; else values.set(m.values.subarray(0, values.length));
    const shape = { type: 'pixels', x: m.x, y: m.y, w: m.width, h: m.height, rle: coverageLib().encodeRle(values) };
    const program = m.defaultColor
      ? [{ op: 'paint', value: 1, shape: { type: 'all' } }, { op: 'paint', value: 0, shape }]
      : [{ op: 'paint', value: 0, shape: { type: 'all' } }, { op: 'paint', value: 1, shape }];
    return masks().normalizeMask({ program, enabled: !m.disabled }, 'mask');
  };
  const source = psd.layers.length ? psd.layers : [{ kind: 'pixels', name: 'Background', opacity: 1, visible: true, blend: 'source-over', x: 0, y: 0, width: W, height: H, rgba: psd.merged || Buffer.alloc(W * H * 4), parent: null }];
  if (!psd.layers.length) report.push({ name: 'Background', loss: psd.merged ? 'no layers in the file; the merged image was imported as one pixel layer' : 'no image data found' });
  for (const item of source) {
    const parentId = item.parent ? groupFor(item.parent).id : undefined;
    let layer;
    if (item.kind === 'group') {
      layer = groupFor(item.id);
      Object.assign(layer, { name: item.name || 'Group', opacity: item.opacity, blend: item.blend, visible: item.visible });
    } else if (item.kind === 'adjustment') {
      layer = normalizeLayer({ type: 'adjustment', name: item.name, opacity: item.opacity, blend: item.blend, visible: item.visible, clipped: item.clipped, adjustment: item.adjustment }, 0);
    } else {
      layer = normalizeLayer({ name: item.name || 'Layer', opacity: item.opacity, blend: item.blend, visible: item.visible, clipped: item.clipped, raster: { tiles: {} }, objects: [] }, 0);
      layer.raster.tiles = paintTiles(layer, item);
      if (item.mask && item.mask.width > 0 && item.mask.height > 0) layer.mask = maskFrom(item.mask);
    }
    if (parentId) layer.parentId = parentId; else delete layer.parentId;
    if (!item.clipped) delete layer.clipped;
    layers.push(layer);
  }
  tree.validateTree(layers);
  doc.layers = layers;
  touch(doc);
  ctx.store.emitChange(doc.id, 'document.importPsd');
  return respond(ctx, doc, 'document.importPsd', { documentId: doc.id, width: W, height: H, colorProfile, layers: layers.length,
    groups: layers.filter((l) => tree.isGroup(l)).length, lossless: report.length === 0, report });
};

OPS['project.import'] = async (params, ctx) => {
  assert(typeof params.base64 === 'string' && params.base64.length <= 44739244 && /^[A-Za-z0-9+/]*={0,2}$/.test(params.base64), 'INVALID_BUNDLE', 'A bounded base64 project archive is required');
  return Object.assign({ op:'project.import' }, await require('./project-bundle').importBundle(Buffer.from(params.base64, 'base64'), ctx, params));
};

OPS['material.catalog'] = async () => ({ op:'material.catalog',materials:require('./material').materialCatalog() });
for(const action of ['register','read','search','revoke','restore','remove','bindings']) OPS['material.'+action]=async(params,ctx)=>{
  const registry=require('./material-assets').getMaterialAssets(ctx);
  const result=await registry[action](action==='register'?params:action==='search'?(params.query||''):params.id,params);
  if(action==='read'){const {buffer,asset,...metadata}=result;return {op:'material.read',material:metadata,url:'/api/materials/'+metadata.id};}
  return {op:'material.'+action,result};
};

OPS['export.frames'] = async (params, ctx) => {
  const doc = requireDoc(ctx, params.documentId);
  const images = await loadImages(ctx, doc);
  const outDir = params.outDir
    ? path.resolve(ctx.workspaceRoot, params.outDir)
    : path.join(ctx.exportsDir, `${sanitize(doc.name)}-frames-${Date.now()}`);
  const result = exportFrames(doc, { outDir, scale: params.scale, fps: params.fps, images });
  return respond(ctx, doc, 'export.frames', result);
};

OPS['export.preview'] = async (params, ctx) => {
  const doc = requireDoc(ctx, params.documentId);
  const images = await loadImages(ctx, doc);
  const preview = renderPreview(doc, {
    images,
    maxWidth: params.maxWidth || 900,
    time: params.time || 0,
    applyAnimation: params.static ? false : true,
  });
  return respond(ctx, doc, 'export.preview', {
    width: preview.width,
    height: preview.height,
    scale: preview.scale,
    sha256: preview.sha256,
    dataUrl: `data:image/png;base64,${preview.base64}`,
    warnings: preview.warnings,
  });
};

// ------------------------------------------------------------------- system

OPS['system.capabilities'] = async (params, ctx) => {
  const fonts = describeFonts(ctx.fontsDir);
  return {
    op: 'system.capabilities',
    name: 'ArtForge Drawing & Design Tool',
    version: VERSION,
    engine: {
      runtime: `Node ${process.version}`,
      renderer: '@napi-rs/canvas (Skia + HarfBuzz shaping)',
      shaping: 'HarfBuzz (Arabic joining + bidi runs)',
    },
    limits: {
      maxCanvas: 8192,
      maxExportPixels: 16384,
      maxAssetBytes: 25 * 1024 * 1024,
      supportedImageFormats: ['.png', '.jpg', '.jpeg', '.webp'],
      supportedExportFormats: ['png', 'jpeg', 'webp', 'svg', ...(require('./pdf-exporter').browserPath() ? ['pdf'] : [])],
    },
    fonts: {
      total: fonts.total,
      uniqueFamilies: fonts.uniqueFamilies,
      arabicCapable: fonts.arabicCapable,
      arabicFamilies: fonts.arabicFamilies,
      bundledArabic: fonts.bundledArabic,
      systemArabic: fonts.systemArabic.slice(0, 40),
    },
    objectTypes: ['rect', 'ellipse', 'line', 'polygon', 'path', 'text', 'image'],
    blendModes: BLEND_MODES,
    animationProperties: ANIMATABLE,
    operations: listOps(),
    features: {
      arabicRtl: true,
      layers: true,
      gradients: true,
      animation: true,
      undoRedo: true,
      saveOpen: true,
      exportImages: true,
      livePreview: true,
      systemFonts: true,
      bundledFonts: true,
    },
  };
};

OPS['system.stats'] = async (params, ctx) => {
  const memory = process.memoryUsage();
  const documents = ctx.store.list();
  const assets = ctx.assets.list();
  return {
    op: 'system.stats',
    uptimeSeconds: Math.round(process.uptime()),
    node: process.version,
    platform: process.platform,
    memory: {
      rssMb: Number((memory.rss / 1048576).toFixed(1)),
      heapUsedMb: Number((memory.heapUsed / 1048576).toFixed(1)),
      externalMb: Number((memory.external / 1048576).toFixed(1)),
    },
    documents: documents.length,
    assets: assets.length,
    assetBytes: assets.reduce((sum, asset) => sum + asset.bytes, 0),
    cpuCount: os.cpus().length,
  };
};

// -------------------------------------------------------------------- runner

const OP_DESCRIPTIONS = {
  'document.create': 'Create a new design document (canvas size, background, name).',
  'document.info': 'Return the full document model plus undo/redo state.',
  'document.list': 'List stored documents with layer/object counts.',
  'document.update': 'Rename a document or change canvas size/background.',
  'document.save': 'Save the design as a re-openable .artforge.json file.',
  'document.open': 'Open a saved .artforge.json design into the editor.',
  'document.import': 'Import a parsed ArtForge design object (browser file upload).',
  'document.duplicate': 'Duplicate a document with a new id.',
  'document.delete': 'Delete a document from the store and disk.',
  'document.preview': 'Render an authoritative PNG preview (base64) with the real engine.',
  'batch': 'Run many operations in one request (one undo step per document); atomic:true rolls everything back if any op fails; expectedRevisions refuses the batch if a document changed meanwhile.',
  'history.undo': 'Undo the last mutating operation.',
  'history.redo': 'Redo the last undone operation.',
  'history.state': 'Report undo/redo availability.',
  'layer.add': 'Add a layer (name, opacity, blend, transform), optionally inside a group (parentId).',
  'layer.list': 'List layers in paint order with type, parentId, depth and effective visibility/lock.',
  'layer.update': 'Update layer name, visibility, lock (locked = all; locks {position, content}), opacity, fillOpacity, blend, transform or effects.',
  'layer.move': 'Reorder a layer among its siblings, or move it into/out of a group (parentId).',
  'layer.delete': 'Delete a layer (at least one must remain).',
  'layer.duplicate': 'Duplicate a layer (or a group with everything inside it) with new ids.',
  'effect.list': 'List layer effect types with their defaults, presets (gold, chrome, glass, neon, emboss, extruded) and paint order.',
  'effect.add': 'Add a live layer effect (dropShadow, innerShadow, outerGlow, innerGlow, stroke, bevel, colorOverlay, gradientOverlay, patternOverlay, extrude).',
  'effect.update': 'Change parameters of a layer effect (patch); the layer re-renders from its live content.',
  'effect.remove': 'Remove a layer effect.',
  'effect.move': 'Reorder a layer effect among effects of the same type.',
  'effect.applyPreset': 'Apply an editable effect preset (gold, chrome, glass, neon, emboss, extruded) to a layer, optionally tinted by color.',
  'selection.set': 'Make or combine a selection (replace/add/subtract/intersect): rect, ellipse, polygon (lasso), path, all, layerAlpha, colorRange, magicWand.',
  'selection.modify': 'Modify the selection: invert, feather, grow, shrink or smooth (radius in px).',
  'selection.info': 'Report the active selection: bounds, area and its steps.',
  'selection.clear': 'Deselect.',
  'mask.create': 'Add a layer mask: raster (reveal, hide or from the selection) or vector (shapes); groups accept masks.',
  'mask.paint': 'Paint a raster layer mask: value 0 hides, 1 reveals; shape brush, rect, ellipse, polygon, path, gradient, all or selection.',
  'mask.update': 'Change a mask: enabled, invert, density, feather, linked, or replace its program/shapes.',
  'mask.delete': 'Remove a layer mask (non-destructive: the layer content is unchanged).',
  'mask.apply': 'Destructive: bake the masks into the layer content as one image (undoable; effects stay live).',
  'path.anchors': 'List a path object\'s anchors with their in/out handles and corner/smooth type.',
  'path.updateAnchor': 'Move an anchor (its handles follow) or set its in/out handles; smooth anchors keep collinear handles.',
  'path.addAnchor': 'Add an anchor by splitting a path segment at t (curve shape unchanged).',
  'path.deleteAnchor': 'Delete an anchor; neighbouring segments join keeping their outer handles.',
  'path.convertAnchor': 'Convert an anchor to corner (handles retracted) or smooth (collinear handles).',
  'path.boolean': 'Combine shapes exactly (curves kept): union, subtract (first minus the rest), intersect or exclude, into one path.',
  'path.fromShape': 'Convert a rect, ellipse or polygon into an equivalent editable path (anchors and handles).',
  'path.outlineStroke': 'Turn an object\'s stroke into a filled path shape (caps and joins as drawn).',
  'object.distribute': 'Distribute three or more objects evenly (equal gaps or equal centre spacing) horizontally or vertically.',
  'document.crop': 'Non-destructive crop or canvas resize to {x, y, width, height}; content outside is kept, not deleted.',
  'guide.add': 'Add a horizontal or vertical guide (saved with the document, never exported).',
  'guide.remove': 'Remove a guide.',
  'guide.update': 'Move a guide to a new position.',
  'history.jump': 'Undo (steps < 0) or redo (steps > 0) several steps at once.',
  'guide.clear': 'Remove all guides.',
  'raster.create': 'Add a pixel layer (tiled), optionally filled with a colour.',
  'raster.rasterize': 'Destructive: turn a layer\'s shapes and text into pixels (effects, mask, opacity stay live).',
  'raster.paint': 'Paint on a pixel layer: brush, eraser, clone, heal, dodge, burn, sponge, smudge, blur, sharpen (pressure, selection and transparency lock respected).',
  'raster.fill': 'Paint bucket on a pixel layer (seed point, tolerance, contiguous) or fill the selection/canvas.',
  'raster.gradient': 'Draw a linear or radial gradient on a pixel layer (inside the selection if any).',
  'raster.clear': 'Delete pixels in the selection, or the whole pixel layer.',
  'adjustment.add': 'Add an adjustment layer: curves, levels, brightnessContrast, exposure, hueSaturation, vibrance, colorBalance, blackWhite, photoFilter, gradientMap, invert, posterize, threshold.',
  'adjustment.update': 'Change an adjustment layer\'s settings (patch) or kind.',
  'filter.add': 'Add a smart filter to a layer (gaussianBlur, motionBlur, radialBlur, unsharpMask, sharpen, highPass, addNoise, pixelate, adjustment); stays editable.',
  'filter.update': 'Change a smart filter (patch: values, opacity, blend, enabled).',
  'filter.remove': 'Remove a smart filter.',
  'filter.move': 'Reorder a smart filter in the layer\'s stack.',
  'filter.mask': 'Limit a layer\'s smart filters to the selection (filter mask), or remove that mask.',
  'smart.replace': 'Replace an embedded image everywhere it is used, keeping transforms, masks, filters and effects.',
  'group.create': 'Create a layer group, empty or around sibling layers (layerIds); blend pass-through by default.',
  'group.ungroup': 'Remove a group and keep its layers in place (the group opacity/blend no longer applies).',
  'object.add': 'Add any raw object (rect, ellipse, line, polygon, path, text, image).',
  'object.update': 'Patch an existing object (validated re-normalisation).',
  'object.transform': 'Move, resize, scale or rotate an object.',
  'object.align': 'Align objects to canvas or to the selection bounds.',
  'object.delete': 'Delete an object.',
  'object.duplicate': 'Duplicate an object with an offset.',
  'object.list': 'List objects with computed bounding boxes.',
  'object.measure': 'Measure bounding boxes for specific objects.',
  'object.move': 'Move an object to another layer or index.',
  'draw.rect': 'Draw a rectangle (rounded corners, fill, stroke, shadow, rotation).',
  'draw.ellipse': 'Draw an ellipse or circle.',
  'draw.line': 'Draw a line with caps, dash and arrow heads.',
  'draw.polygon': 'Draw a polygon from points.',
  'draw.path': 'Draw a Bezier/line path from segments.',
  'draw.freehand': 'Draw a freehand polyline from points.',
  'draw.text': 'Draw RTL/LTR text with Arabic shaping, wrap, stroke and shadow.',
  'draw.image': 'Place an image asset with fill/contain/cover fit and rounding.',
  'draw.gradient': 'Draw a rectangle filled with a linear, radial or conic gradient.',
  'draw.brush': 'Paint a brush stroke (round, soft, flat, rough, pencil, ink, dotted, dashed, spaced, soft-edge, texture, spray) with pressure, smoothing, symmetry and repeat.',
  'brush.presets': 'List brush presets and their parameters.',
  'draw.form': 'Draw a finished, shaded form in one call (rect/ellipse/polygon/smooth path): shadow side from lightAngle, highlight, optional texture and gloss, outline.',
  batch: 'Run a list of operations in one request ({ops:[{op, params}]}); stops at the first failure and reports its index.',
  'image.analyze': 'Analyse a reference image: dominant colours, 3x3 brightness/detail grid, calmest region for text, balance.',
  'draw.stroke': 'Organic vector stroke: smoothed, pressure/speed-tapered line as one filled path (points[{x,y,p?}], size, thinning, smoothing, taperStart, taperEnd, color; curve:true = smooth even-width spline body; outline:{color,width} = matching border).',
  'export.pdf': 'Export vector PDF through local Chromium from the editable SVG; embeds bundled Arabic fonts, preserves vectors; unavailable without a local browser.',
  'export.svg': 'Export an editable SVG: shapes, gradients, clips and Arabic text stay vector/text; only brush stamps, images, patterns and arrows are rasterised per object.',
  'qa.visibility': 'Pixel visibility of object groups: share of each group box that visibly changes when the group is removed (hidden under later layers or same colour as the background = low).',
  'qa.check': 'Measure the rendered design: clipped text, overflowing words, estimated contrast, text overlaps, ruled-paper baseline alignment and (with palette[]) reference-palette adherence (pixels).',
  'layout.table': 'Lay out a professional table from structured data (header, zebra rows, totals, merged cells, number/currency/percent formats, auto column widths, RTL, pagination).',
  'layout.flow': 'Flow headings, paragraphs, numbered/bullet lists and tables into a box with real measurement, optional ruled-paper baseline snapping and a continuation cursor for multi-page output.',
  'draw.ruledPaper': 'Draw ruled paper: evenly spaced horizontal rules and a margin line.',
  'text.measure': 'Measure text layout (lines, widths, height, alignment, RTL).',
  'font.list': 'List bundled and installed system fonts with Arabic coverage.',
  'font.resolve': 'Resolve a font family name and report Arabic coverage.',
  'color.palette': 'Extract a dominant-colour palette from an image file or asset.',
  'color.gradient': 'Normalise gradient stops and return matching CSS.',
  'image.add': 'Register an image asset from a file path or data URL.',
  'image.list': 'List registered image assets.',
  'image.remove': 'Remove an image asset.',
  'animation.set': 'Enable/configure the animation timeline (duration, fps, loop).',
  'animation.addTrack': 'Add a keyframe track for an object property.',
  'animation.addKey': 'Add or replace one keyframe on a property track.',
  'animation.removeTrack': 'Remove a keyframe track.',
  'animation.clear': 'Remove all tracks and disable animation.',
  'animation.info': 'Report animation settings and tracks.',
  'animation.frame': 'Render one animation frame at a given time (base64 PNG).',
  'export.image': 'Export the design to PNG/JPEG/WebP on disk.',
  'draw.shape': 'Draw a parametric shape as an editable path: kind polygon (sides), star (points, ratio), arc (start, sweep, ratio: pie/donut), spiral (turns, growth, direction) or rect (radius, smoothing: squircle corners); cornerRadius rounds polygon/star corners.',
  'shape.update': 'Change a parametric shape\'s parameters (sides, points, ratio, cornerRadius, start, sweep, turns, radius, smoothing…); position and size are kept.',
  'shape.convert': 'Turn a rect into a smoothed-corner shape or an ellipse into an arc, in place.',
  'draw.network': 'Draw a vector network: points (vertices, plus curve handles with ctrl:true), edges [{a, b, c1?, c2?}] that may branch from any vertex, optional regions [{path:[[edge, reversed]...], fill}]; stroke/strokeWidth.',
  'network.fill': 'Fill (or clear with fill:null) the closed face of a vector network that contains (x, y).',
  'vector.fill': 'Paint bucket for vectors: fill the empty area enclosed by lines/shapes at (x, y) with a new filled path under the layer\'s objects.',
  'text.style': 'Style part of a text (start, end): font family/size/weight/style, fill, underline; clear:true removes it. Arabic letters stay joined across style changes.',
  'raster.spotHeal': 'Spot healing brush on a pixel layer: each spot (points, size) is rebuilt from the best nearby area and blended seamlessly.',
  'raster.patch': 'Patch tool: heal the selection from a source area (offset {x, y}, or found automatically).',
  'raster.transform': 'Free-transform a pixel layer: perspective/distort (corners), skew (skewX/skewY), warp (preset arc, arch, bulge, flag, wave, fisheye, rise, squeeze, twist + bend) or mesh (rows, cols, points).',
  'export.psd': 'Export a Photoshop PSD (RGB 8-bit): pixel layers, groups, names, opacity, blend, visibility, clipping, simple native adjustments, ICC; the report lists what was baked or lost.',
  'document.importPsd': 'Open a Photoshop PSD (RGB 8-bit) as a new document: pixel layers, groups, masks, clipping, simple adjustments; the report lists what could not be kept.',
  'export.frames': 'Export the animation as a numbered PNG frame sequence.',
  'export.preview': 'Return a PNG preview without writing to disk.',
  'system.capabilities': 'Report engine, fonts, limits, blend modes and every operation.',
  'system.stats': 'Report runtime memory, uptime and store usage.',
};

function listOps() {
  return Object.keys(OPS).sort().map((name) => ({ name, description: OP_DESCRIPTIONS[name] || '' }));
}

// Ops whose effects leave the in-memory document store (files on disk, the asset/material stores,
// undo stacks) cannot be rolled back, so an atomic batch refuses them before running anything.
const ATOMIC_UNSAFE = new Set([
  'document.delete', 'document.save', 'document.open', 'document.import', 'project.import',
  'image.add', 'image.remove', 'material.register', 'material.remove', 'material.restore', 'material.revoke',
  'history.undo', 'history.redo', 'history.jump', 'mask.apply', 'smart.replace',
  'export.image', 'export.frames', 'export.svg', 'export.pdf', 'export.bundle', 'export.psd', 'document.importPsd',
]);

/** Compare a document's current revision with what the caller last saw (optimistic concurrency). */
function checkRevision(ctx, documentId, expected) {
  if (expected === undefined) return;
  assert(typeof documentId === 'string' && documentId, 'MISSING_DOCUMENT_ID', 'expectedRevision needs documentId');
  if (!ctx.store.has(documentId)) return; // the handler reports DOCUMENT_NOT_FOUND
  const actual = ctx.store.revision(documentId);
  assert(Number.isInteger(Number(expected)), 'INVALID_REVISION', 'expectedRevision must be an integer', { received: expected });
  assert(Number(expected) === actual, 'REVISION_CONFLICT',
    `document ${documentId} is at revision ${actual}, not ${expected}: it changed since you read it; reload and retry`,
    { documentId, expected: Number(expected), actual });
}

// Records each document's state before an atomic batch first touches it, and documents the batch
// creates, so a failure can restore everything exactly (content and undo/redo stacks).
function createJournal(store) {
  const existing = new Set(store.documentIds());
  const captured = new Map();
  return {
    capture(docId) {
      if (!docId || captured.has(docId) || !existing.has(docId) || !store.has(docId)) return;
      captured.set(docId, store.captureState(docId));
    },
    rollback() {
      const discarded = store.documentIds().filter((id) => !existing.has(id));
      for (const id of discarded) store.discard(id);
      for (const [id, state] of captured) store.restoreState(id, state);
      return { restored: [...captured.keys()], discarded };
    },
  };
}

/**
 * Run many operations in ONE request, sequentially, with one undo snapshot per document.
 * Default: stops at the first failure; earlier operations stay applied (details.completed).
 * atomic:true: all or nothing. On failure every touched document, its undo/redo stacks and any document
 * the batch created are put back, so nothing of the batch remains (details.rolledBack).
 * expectedRevisions {documentId: revision}: refuse the whole batch if a document changed meanwhile.
 */
OPS.batch = async (params, ctx) => {
  assert(Array.isArray(params.ops) && params.ops.length > 0, 'INVALID_BATCH', 'ops must be a non-empty array of {op, params}');
  assert(params.ops.length <= 2000, 'INVALID_BATCH', 'a batch may contain at most 2000 operations');
  assert(params.atomic === undefined || typeof params.atomic === 'boolean', 'INVALID_BATCH', 'atomic must be true or false');
  const atomic = params.atomic === true;
  if (atomic) {
    const unsafe = params.ops.map((item, index) => ({ index, op: item && item.op })).filter((item) => ATOMIC_UNSAFE.has(item.op));
    assert(!unsafe.length, 'ATOMIC_UNSUPPORTED_OP',
      `an atomic batch cannot contain ${[...new Set(unsafe.map((u) => u.op))].join(', ')} (effects outside the document cannot be undone); run them after the batch`,
      { ops: unsafe });
  }
  if (params.expectedRevisions !== undefined) {
    assert(params.expectedRevisions && typeof params.expectedRevisions === 'object' && !Array.isArray(params.expectedRevisions),
      'INVALID_REVISION', 'expectedRevisions must be an object {documentId: revision}');
    for (const [documentId, expected] of Object.entries(params.expectedRevisions)) checkRevision(ctx, documentId, expected);
  }
  const results = [];
  const journal = atomic ? createJournal(ctx.store) : null;
  const batchCtx = Object.assign({}, ctx, { batchHistory: new Set(), journal, opName: 'batch' });
  for (let i = 0; i < params.ops.length; i += 1) {
    const item = params.ops[i] || {};
    try {
      await new Promise(resolve=>setImmediate(resolve));
      require('./operation-context').checkpoint();
      assert(item.op !== 'batch', 'INVALID_BATCH', 'nested batches are not allowed');
      if (journal && item.params) journal.capture(item.params.documentId);
      results.push(await runOp(item.op, item.params || {}, batchCtx));
    } catch (error) {
      const rollback = journal ? journal.rollback() : null;
      if (error && typeof error === 'object') {
        error.details = Object.assign({}, error.details || {}, {
          batchIndex: i, op: item.op, completed: rollback ? 0 : i, atomic, rolledBack: Boolean(rollback),
        }, rollback ? { restoredDocuments: rollback.restored, discardedDocuments: rollback.discarded } : {});
      }
      throw error;
    }
  }
  return { op: 'batch', count: results.length, results, atomic };
};

async function runOp(name, params, ctx) {
  require('./input-contract').inspect(params);
  require('./operation-context').checkpoint();
  const handler = OPS[name];
  if (!handler) {
    throw new OpError('UNKNOWN_OP', `unknown operation: ${name}`, { available: Object.keys(OPS).sort() });
  }
  if (params && params.expectedRevision !== undefined) checkRevision(ctx, params.documentId, params.expectedRevision);
  // The op name labels the undo step it creates (inside a batch the whole batch is one step).
  const opCtx = ctx.opName ? ctx : Object.assign({}, ctx, { opName: name });
  const started = process.hrtime.bigint();
  const data = await handler(params || {}, opCtx);
  require('./operation-context').checkpoint();
  const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
  return { ok: true, op: name, durationMs: Number(durationMs.toFixed(2)), data };
}

module.exports = {
  OPS,
  OP_DESCRIPTIONS,
  VERSION,
  listOps,
  runOp,
};
