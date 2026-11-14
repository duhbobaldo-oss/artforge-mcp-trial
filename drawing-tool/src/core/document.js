'use strict';

const { assert } = require('./errors');
const { makeId } = require('./ids');
const { normalizePaint, normalizeColor, BLEND_MODES } = require('./paint');
const { normalizeAnimation, createAnimation } = require('./animation');
const { normalizeFont, isRtlText } = require('./text');
const { BRUSH_PRESETS } = require('./brush');
const { normalizeLayerFilter, normalizeEffects } = require('./effects');
const { normalizeLights } = require('./lighting');

const SCHEMA = 'artforge.document';
const VERSION = 1;
const MAX_DIMENSION = 8192;
// Layer compositing semantics. 'v2': a layer composites as one unit (pass-through group for normal
// layers, isolated group for blended/filtered layers), so layer opacity does not accumulate where its
// objects overlap. 'legacy': historical per-object alpha/blend, kept for documents saved before v2.
const COMPOSITING_MODES = ['v2', 'legacy'];

function normalizeCompositing(value, fallback) {
  const mode = value === undefined ? fallback : value;
  assert(COMPOSITING_MODES.includes(mode), 'INVALID_COMPOSITING',
    `canvas.compositing must be ${COMPOSITING_MODES.join(' or ')}`, { received: value, allowed: COMPOSITING_MODES });
  return mode;
}

function number(value, field, options) {
  const opts = options || {};
  const n = Number(value);
  assert(Number.isFinite(n), 'INVALID_NUMBER', `${field} must be a finite number`, { received: value });
  if (opts.min !== undefined) assert(n >= opts.min, 'INVALID_NUMBER', `${field} must be >= ${opts.min}`, { received: value });
  if (opts.max !== undefined) assert(n <= opts.max, 'INVALID_NUMBER', `${field} must be <= ${opts.max}`, { received: value });
  return n;
}

function normalizeShadow(shadow, field) {
  if (!shadow) return undefined;
  return {
    color: shadow.color ? normalizeColor(shadow.color, `${field}.color`) : 'rgba(0,0,0,0.35)',
    blur: number(shadow.blur === undefined ? 12 : shadow.blur, `${field}.blur`, { min: 0, max: 200 }),
    offsetX: number(shadow.offsetX === undefined ? 0 : shadow.offsetX, `${field}.offsetX`, { min: -500, max: 500 }),
    offsetY: number(shadow.offsetY === undefined ? 4 : shadow.offsetY, `${field}.offsetY`, { min: -500, max: 500 }),
  };
}

/**
 * Clip region for one object: the object only paints inside it. Used for cel shading and highlights
 * that must stay inside a limb, a face or a garment.
 * { type: 'path', segments, closed? } | { type: 'rect', x, y, w, h, radius? } | { type: 'ellipse', x, y, w, h }
 */
function normalizeClip(clip, label) {
  assert(clip && typeof clip === 'object', 'INVALID_CLIP', `${label} must be an object`);
  const type = clip.type || (clip.segments ? 'path' : 'rect');
  assert(['path', 'rect', 'ellipse'].includes(type), 'INVALID_CLIP', `${label}.type must be path, rect or ellipse`, { received: clip.type });
  if (type === 'path') {
    assert(Array.isArray(clip.segments) && clip.segments.length >= 2, 'INVALID_CLIP', `${label}.segments needs at least two segments`);
    return {
      type,
      segments: clip.segments.map((s, i) => {
        const op = String(s.op || '').toUpperCase();
        assert(['M', 'L', 'Q', 'C', 'Z'].includes(op), 'INVALID_CLIP', `${label}.segments[${i}].op must be M, L, Q, C or Z`);
        const out = { op };
        for (const k of ['x', 'y', 'cx', 'cy', 'c1x', 'c1y', 'c2x', 'c2y']) if (s[k] !== undefined) out[k] = number(s[k], `${label}.segments[${i}].${k}`);
        return out;
      }),
    };
  }
  const out = { type, x: number(clip.x, `${label}.x`), y: number(clip.y, `${label}.y`), w: number(clip.w, `${label}.w`, { min: 0 }), h: number(clip.h, `${label}.h`, { min: 0 }) };
  if (type === 'rect' && clip.radius !== undefined) out.radius = clip.radius;
  return out;
}

function normalizeCommon(input, label) {
  const out = {
    id: input.id || makeId('obj'),
    type: input.type,
    name: input.name ? String(input.name) : undefined,
    opacity: input.opacity === undefined ? 1 : number(input.opacity, `${label}.opacity`, { min: 0, max: 1 }),
    rotation: input.rotation === undefined ? 0 : number(input.rotation, `${label}.rotation`, { min: -3600, max: 3600 }),
    blend: input.blend || 'source-over',
    shadow: normalizeShadow(input.shadow, `${label}.shadow`),
  };
  if (input.blur !== undefined && Number(input.blur) !== 0) {
    out.blur = number(input.blur, `${label}.blur`, { min: 0, max: 200 });
  }
  if (input.clip) out.clip = normalizeClip(input.clip, `${label}.clip`);
  assert(BLEND_MODES.includes(out.blend), 'INVALID_BLEND',
    `${label}.blend must be a supported Canvas blend mode`, { received: out.blend });
  return out;
}

function normalizeStroke(input, label) {
  const out = {};
  if (input.stroke !== undefined && input.stroke !== null) out.stroke = normalizePaint(input.stroke, `${label}.stroke`);
  if (input.strokeWidth !== undefined) out.strokeWidth = number(input.strokeWidth, `${label}.strokeWidth`, { min: 0, max: 400 });
  if (input.dash !== undefined) {
    assert(Array.isArray(input.dash), 'INVALID_DASH', `${label}.dash must be an array of numbers`);
    out.dash = input.dash.map((d, i) => number(d, `${label}.dash[${i}]`, { min: 0, max: 1000 }));
  }
  // The renderer strokes shapes with these; they used to be dropped here, so shapes could not get
  // round/square caps or round/bevel joins.
  if (input.lineCap !== undefined) {
    assert(['butt', 'round', 'square'].includes(input.lineCap), 'INVALID_CAP', `${label}.lineCap must be butt, round or square`, { received: input.lineCap });
    out.lineCap = input.lineCap;
  }
  if (input.lineJoin !== undefined) {
    assert(['miter', 'round', 'bevel'].includes(input.lineJoin), 'INVALID_JOIN', `${label}.lineJoin must be miter, round or bevel`, { received: input.lineJoin });
    out.lineJoin = input.lineJoin;
  }
  return out;
}

function normalizeObject(input, label) {
  assert(input && typeof input === 'object', 'INVALID_OBJECT', `${label} must be an object`);
  assert(typeof input.type === 'string', 'INVALID_OBJECT', `${label}.type is required`, {
    allowed: ['rect', 'ellipse', 'line', 'polygon', 'path', 'text', 'image', 'brush'],
  });
  const L = label || 'object';
  const common = normalizeCommon(input, L);
  const objectLabel = `${L}(${common.type})`;
  switch (input.type) {
    case 'rect': {
      const obj = Object.assign(common, {
        x: number(input.x, `${objectLabel}.x`),
        y: number(input.y, `${objectLabel}.y`),
        w: number(input.w, `${objectLabel}.w`, { min: 0.01, max: 100000 }),
        h: number(input.h, `${objectLabel}.h`, { min: 0.01, max: 100000 }),
        radius: input.radius === undefined ? 0 : input.radius,
        fill: normalizePaint(input.fill === undefined ? '#000000' : input.fill, `${objectLabel}.fill`),
      });
      return Object.assign(obj, normalizeStroke(input, objectLabel));
    }
    case 'ellipse': {
      const obj = Object.assign(common, {
        x: number(input.x, `${objectLabel}.x`),
        y: number(input.y, `${objectLabel}.y`),
        w: number(input.w, `${objectLabel}.w`, { min: 0.01, max: 100000 }),
        h: number(input.h, `${objectLabel}.h`, { min: 0.01, max: 100000 }),
        fill: normalizePaint(input.fill === undefined ? '#000000' : input.fill, `${objectLabel}.fill`),
      });
      return Object.assign(obj, normalizeStroke(input, objectLabel));
    }
    case 'line': {
      const stroke = input.stroke === undefined ? '#000000' : normalizePaint(input.stroke, `${objectLabel}.stroke`);
      const obj = Object.assign(common, {
        x1: number(input.x1, `${objectLabel}.x1`),
        y1: number(input.y1, `${objectLabel}.y1`),
        x2: number(input.x2, `${objectLabel}.x2`),
        y2: number(input.y2, `${objectLabel}.y2`),
        stroke,
        strokeWidth: input.strokeWidth === undefined ? 2 : number(input.strokeWidth, `${objectLabel}.strokeWidth`, { min: 0.1, max: 400 }),
        cap: input.cap || 'round',
        arrow: input.arrow === undefined ? 'none' : input.arrow,
      });
      assert(['none', 'start', 'end', 'both'].includes(obj.arrow), 'INVALID_ARROW',
        `${objectLabel}.arrow must be none, start, end or both`, { received: input.arrow });
      assert(['butt', 'round', 'square'].includes(obj.cap), 'INVALID_CAP',
        `${objectLabel}.cap must be butt, round or square`, { received: input.cap });
      if (input.dash !== undefined) obj.dash = normalizeStroke(input, objectLabel).dash;
      if (input.arrowSize !== undefined) obj.arrowSize = number(input.arrowSize, `${objectLabel}.arrowSize`, { min: 1, max: 200 });
      return obj;
    }
    case 'network': {
      // Vector network: vertices + handles in `points`, edges between vertices, filled regions (faces).
      const net = require('./shapes').normalizeNetwork(input, objectLabel);
      const obj = Object.assign(common, {
        points: net.points,
        edges: net.edges,
        regions: net.regions.map((r, i) => ({ path: r.path, fill: normalizePaint(r.fill === undefined ? '#38bdf8' : r.fill, `${objectLabel}.regions[${i}].fill`) })),
        fill: null,
      });
      const stroke = normalizeStroke(Object.assign({ stroke: '#0b1220', strokeWidth: 2 }, input), objectLabel);
      if (!stroke.lineCap) stroke.lineCap = 'round';
      if (!stroke.lineJoin) stroke.lineJoin = 'round';
      return Object.assign(obj, stroke);
    }
    case 'polygon': {
      assert(Array.isArray(input.points) && input.points.length >= 2, 'INVALID_POINTS',
        `${objectLabel}.points needs at least two {x,y} points`);
      const obj = Object.assign(common, {
        points: input.points.map((p, i) => ({
          x: number(p.x, `${objectLabel}.points[${i}].x`),
          y: number(p.y, `${objectLabel}.points[${i}].y`),
        })),
        closed: input.closed === undefined ? true : Boolean(input.closed),
        fill: normalizePaint(input.fill === undefined ? '#000000' : input.fill, `${objectLabel}.fill`),
      });
      return Object.assign(obj, normalizeStroke(input, objectLabel));
    }
    case 'path': {
      assert(Array.isArray(input.segments) && input.segments.length >= 2, 'INVALID_PATH',
        `${objectLabel}.segments needs at least two segments`);
      const segments = input.segments.map((seg, i) => {
        const op = String(seg.op || '').toUpperCase();
        assert(['M', 'L', 'Q', 'C', 'Z'].includes(op), 'INVALID_PATH',
          `${objectLabel}.segments[${i}].op must be one of M, L, Q, C, Z`, { received: seg.op });
        if (op === 'Z') return { op };
        const point = {
          op,
          x: number(seg.x, `${objectLabel}.segments[${i}].x`),
          y: number(seg.y, `${objectLabel}.segments[${i}].y`),
        };
        if (op === 'Q') {
          point.cx = number(seg.cx, `${objectLabel}.segments[${i}].cx`);
          point.cy = number(seg.cy, `${objectLabel}.segments[${i}].cy`);
        }
        if (op === 'C') {
          point.c1x = number(seg.c1x, `${objectLabel}.segments[${i}].c1x`);
          point.c1y = number(seg.c1y, `${objectLabel}.segments[${i}].c1y`);
          point.c2x = number(seg.c2x, `${objectLabel}.segments[${i}].c2x`);
          point.c2y = number(seg.c2y, `${objectLabel}.segments[${i}].c2y`);
        }
        return point;
      });
      const obj = Object.assign(common, {
        segments,
        closed: input.closed === undefined ? false : Boolean(input.closed),
        fill: normalizePaint(input.fill === undefined ? null : input.fill, `${objectLabel}.fill`),
      });
      // Parametric shape (polygon, star, arc, spiral, smoothed rect): the parameters travel with the path.
      if (input.shape) obj.shape = require('./shapes').normalizeShapeSpec(input.shape, `${objectLabel}.shape`);
      return Object.assign(obj, normalizeStroke(input, objectLabel));
    }
    case 'text': {
      const text = input.text === undefined ? '' : String(input.text);
      assert(text.length <= 20000, 'INVALID_TEXT', `${objectLabel}.text must be at most 20000 characters`);
      const font = normalizeFont(input.font, `${objectLabel}.font`);
      const align = input.align || (isRtlText(text) ? 'right' : 'left');
      assert(['left', 'center', 'right'].includes(align), 'INVALID_ALIGN',
        `${objectLabel}.align must be left, center or right`, { received: input.align });
      const obj = Object.assign(common, {
        x: number(input.x, `${objectLabel}.x`),
        y: number(input.y, `${objectLabel}.y`),
        text,
        font,
        align,
        rtl: input.rtl === undefined ? isRtlText(text) : Boolean(input.rtl),
        fill: normalizePaint(input.fill === undefined ? '#000000' : input.fill, `${objectLabel}.fill`),
      });
      if (input.maxWidth !== undefined) obj.maxWidth = number(input.maxWidth, `${objectLabel}.maxWidth`, { min: 1, max: 20000 });
      if (input.baseline !== undefined) {
        assert(['top', 'alphabetic'].includes(input.baseline), 'INVALID_BASELINE',
          `${objectLabel}.baseline must be "top" or "alphabetic"`, { received: input.baseline });
        if (input.baseline === 'alphabetic') obj.baseline = 'alphabetic';
      }
      const runs = normalizeRuns(input.runs, text, `${objectLabel}.runs`);
      if (runs) obj.runs = runs;
      return Object.assign(obj, normalizeStroke(input, objectLabel));
    }
    case 'brush': {
      assert(Array.isArray(input.points) && input.points.length >= 2, 'INVALID_POINTS',
        `${objectLabel}.points needs at least two {x,y[,p]} points`);
      assert(input.points.length <= 20000, 'INVALID_POINTS', `${objectLabel}.points must be at most 20000`);
      const brush = Object.assign({}, input.brush || {});
      const preset = brush.preset || 'round';
      assert(Object.prototype.hasOwnProperty.call(BRUSH_PRESETS, preset), 'INVALID_BRUSH',
        `${objectLabel}.brush.preset is not supported`, { received: preset, allowed: Object.keys(BRUSH_PRESETS) });
      brush.preset = preset;
      for (const key of ['size', 'spacing', 'hardness', 'flow', 'angle', 'aspect', 'jitter', 'taper', 'seed']) {
        if (brush[key] !== undefined) brush[key] = number(brush[key], `${objectLabel}.brush.${key}`, { min: key === 'angle' ? -3600 : 0, max: key === 'seed' ? 1e9 : (key === 'angle' ? 3600 : 2000) });
      }
      const colors = Array.isArray(input.colors) && input.colors.length
        ? input.colors.map((c, i) => normalizeColor(c, `${objectLabel}.colors[${i}]`))
        : undefined;
      const obj = Object.assign(common, {
        points: input.points.map((p, i) => {
          const point = { x: number(p.x, `${objectLabel}.points[${i}].x`), y: number(p.y, `${objectLabel}.points[${i}].y`) };
          if (p.p !== undefined) point.p = number(p.p, `${objectLabel}.points[${i}].p`, { min: 0, max: 1 });
          return point;
        }),
        brush,
        color: normalizeColor(input.color === undefined ? '#000000' : input.color, `${objectLabel}.color`),
        smooth: input.smooth === undefined ? 0.5 : number(input.smooth, `${objectLabel}.smooth`, { min: 0, max: 1 }),
        closed: Boolean(input.closed),
      });
      if (colors) obj.colors = colors;
      if (input.symmetry) obj.symmetry = { axis: String(input.symmetry.axis || 'vertical'), at: Number(input.symmetry.at) || 0, atY: input.symmetry.atY === undefined ? undefined : Number(input.symmetry.atY) };
      if (input.repeat) obj.repeat = { count: Math.min(200, Math.max(0, Math.floor(Number(input.repeat.count) || 0))), dx: Number(input.repeat.dx) || 0, dy: Number(input.repeat.dy) || 0 };
      return obj;
    }
    case 'image': {
      assert(typeof input.assetId === 'string' && input.assetId.length > 0, 'INVALID_ASSET',
        `${objectLabel}.assetId is required: create it with image.add first`);
      const fit = input.fit || 'fill';
      assert(['fill', 'contain', 'cover'].includes(fit), 'INVALID_FIT',
        `${objectLabel}.fit must be fill, contain or cover`, { received: input.fit });
      return Object.assign(common, {
        x: number(input.x, `${objectLabel}.x`),
        y: number(input.y, `${objectLabel}.y`),
        w: number(input.w, `${objectLabel}.w`, { min: 1, max: 100000 }),
        h: number(input.h, `${objectLabel}.h`, { min: 1, max: 100000 }),
        assetId: input.assetId,
        fit,
        flipX: Boolean(input.flipX),
        flipY: Boolean(input.flipY),
        radius: input.radius === undefined ? 0 : input.radius,
      });
    }
    default:
      assert(false, 'INVALID_OBJECT_TYPE', `${objectLabel}.type is not supported`, {
        received: input.type,
        allowed: ['rect', 'ellipse', 'line', 'polygon', 'path', 'text', 'image', 'brush'],
      });
      return null;
  }
}

function normalizeTransform(transform, label) {
  const t = transform || {};
  return {
    x: t.x === undefined ? 0 : number(t.x, `${label}.x`),
    y: t.y === undefined ? 0 : number(t.y, `${label}.y`),
    rotation: t.rotation === undefined ? 0 : number(t.rotation, `${label}.rotation`, { min: -3600, max: 3600 }),
    scaleX: t.scaleX === undefined ? 1 : number(t.scaleX, `${label}.scaleX`, { min: -100, max: 100 }),
    scaleY: t.scaleY === undefined ? 1 : number(t.scaleY, `${label}.scaleY`, { min: -100, max: 100 }),
    pivotX: t.pivotX === undefined ? 0 : number(t.pivotX, `${label}.pivotX`),
    pivotY: t.pivotY === undefined ? 0 : number(t.pivotY, `${label}.pivotY`),
  };
}

// Partial locks (Photoshop-style). `locked` (lock all) stays separate and blocks every edit.
//  position: objects cannot be moved, resized, rotated or aligned, and the layer transform is fixed.
//  content:  objects cannot be added, deleted, restyled or reshaped, but can still be moved.
//  alpha:    pixel tools keep each pixel's transparency (paint only where pixels already exist).
const LOCK_KINDS = ['position', 'content', 'alpha'];

// Pixel layer storage: tile key "tx,ty" → sha256 of an immutable 256×256 PNG tile (see raster.js).
function normalizeRaster(input, label) {
  if (input === undefined || input === null) return undefined;
  assert(typeof input === 'object' && input.tiles && typeof input.tiles === 'object', 'INVALID_RASTER', `${label}.raster must be {tiles:{"tx,ty": sha256}}`);
  const tiles = {};
  const entries = Object.entries(input.tiles);
  assert(entries.length <= 20000, 'INVALID_RASTER', `${label}.raster has too many tiles`);
  for (const [k, hash] of entries) {
    assert(/^-?\d{1,4},-?\d{1,4}$/.test(k) && /^[0-9a-f]{64}$/.test(hash), 'INVALID_RASTER', `${label}.raster tile ${k} is invalid`);
    tiles[k] = hash;
  }
  return { tileSize: 256, tiles };
}
function normalizeLocks(locks, label) {
  if (locks === undefined || locks === null) return undefined;
  assert(typeof locks === 'object' && !Array.isArray(locks), 'INVALID_LOCKS', `${label}.locks must be an object like {position:true}`);
  const unknown = Object.keys(locks).filter((k) => !LOCK_KINDS.includes(k));
  assert(!unknown.length, 'INVALID_LOCKS', `${label}.locks supports ${LOCK_KINDS.join(', ')}`, { unknown });
  const out = {};
  for (const k of LOCK_KINDS) if (locks[k]) out[k] = true;
  return Object.keys(out).length ? out : undefined;
}

// Layer masks (raster: a paintable coverage program; vector: editable paths). Groups can carry them too.
function applyMasks(layer, input, label) {
  const schema = require('./masks-schema');
  const mask = schema.normalizeMask(input.mask, `${label}.mask`);
  if (mask) layer.mask = mask;
  const vectorMask = schema.normalizeVectorMask(input.vectorMask, `${label}.vectorMask`);
  if (vectorMask) layer.vectorMask = vectorMask;
}

// Editor aids saved with the document (never rendered into exports).
function normalizeGuides(list) {
  if (list === undefined || list === null) return undefined;
  assert(Array.isArray(list) && list.length <= 500, 'INVALID_GUIDE', 'canvas.guides must be an array of at most 500 guides');
  const out = list.map((g, i) => {
    assert(g && ['horizontal', 'vertical'].includes(g.orientation), 'INVALID_GUIDE', `canvas.guides[${i}].orientation must be horizontal or vertical`);
    return { id: typeof g.id === 'string' && g.id ? g.id : makeId('guide'), orientation: g.orientation, position: number(g.position, `canvas.guides[${i}].position`, { min: -100000, max: 100000 }) };
  });
  return out.length ? out : undefined;
}

function normalizeGrid(grid) {
  if (grid === undefined || grid === null || grid === false) return undefined;
  assert(typeof grid === 'object', 'INVALID_GRID', 'canvas.grid must be {size, subdivisions, visible}');
  return {
    size: number(grid.size === undefined ? 20 : grid.size, 'canvas.grid.size', { min: 1, max: 1000 }),
    subdivisions: Math.round(number(grid.subdivisions === undefined ? 4 : grid.subdivisions, 'canvas.grid.subdivisions', { min: 1, max: 20 })),
    visible: grid.visible !== false,
  };
}

// Text runs: per-range font fields, fill and underline inside one text object (UTF-16 offsets, end exclusive).
const RUN_FONT_KEYS = ['family', 'size', 'weight', 'style'];
function normalizeRuns(input, text, label) {
  if (input === undefined || input === null) return undefined;
  assert(Array.isArray(input) && input.length <= 500, 'INVALID_RUNS', `${label} must be an array of at most 500 {start, end, font?, fill?, underline?}`);
  const out = [];
  input.forEach((r, i) => {
    const f = `${label}[${i}]`;
    assert(r && typeof r === 'object', 'INVALID_RUNS', `${f} must be an object`);
    const start = Number(r.start); const end = Number(r.end);
    assert(Number.isInteger(start) && Number.isInteger(end) && start >= 0 && end > start && end <= text.length, 'INVALID_RUNS',
      `${f} needs whole-number start < end within the text (length ${text.length})`, { start: r.start, end: r.end });
    const unknown = Object.keys(r).filter((k) => !['start', 'end', 'font', 'fill', 'underline'].includes(k));
    assert(!unknown.length, 'INVALID_RUNS', `${f} does not support ${unknown.join(', ')}`, { allowed: ['start', 'end', 'font', 'fill', 'underline'] });
    const run = { start, end };
    if (r.font !== undefined) {
      assert(r.font && typeof r.font === 'object', 'INVALID_RUNS', `${f}.font must be an object`);
      const extra = Object.keys(r.font).filter((k) => !RUN_FONT_KEYS.includes(k));
      assert(!extra.length, 'INVALID_RUNS', `${f}.font may set ${RUN_FONT_KEYS.join(', ')} (lineHeight and letterSpacing belong to the whole text)`, { received: extra });
      const full = normalizeFont(Object.assign({ family: 'Tahoma', size: 32 }, r.font), `${f}.font`);
      const font = {};
      for (const k of RUN_FONT_KEYS) if (r.font[k] !== undefined) font[k] = full[k];
      if (Object.keys(font).length) run.font = font;
    }
    if (r.fill !== undefined) run.fill = normalizePaint(r.fill, `${f}.fill`);
    if (r.underline) run.underline = true;
    if (run.font || run.fill !== undefined || run.underline) out.push(run);
  });
  out.sort((a, b) => a.start - b.start);
  for (let i = 1; i < out.length; i += 1) {
    assert(out[i].start >= out[i - 1].end, 'INVALID_RUNS', `${label}: runs must not overlap`, { first: [out[i - 1].start, out[i - 1].end], second: [out[i].start, out[i].end] });
  }
  return out.length ? out : undefined;
}

// Blend If ("Blending Options"): this layer shows only where its own value and the value below fall in
// [black0, black1, white1, white0] ramps (split sliders = soft transition). Default ranges are omitted.
const BLEND_IF_CHANNELS = ['gray', 'red', 'green', 'blue'];
function normalizeBlendIf(input, label) {
  if (input === undefined || input === null) return undefined;
  assert(typeof input === 'object' && !Array.isArray(input), 'INVALID_BLEND_IF', `${label}.blendIf must be {channel, this, underlying}`);
  const channel = input.channel || 'gray';
  assert(BLEND_IF_CHANNELS.includes(channel), 'INVALID_BLEND_IF', `${label}.blendIf.channel must be ${BLEND_IF_CHANNELS.join(', ')}`, { received: channel });
  const range = (v, f) => {
    if (v === undefined) return [0, 0, 255, 255];
    assert(Array.isArray(v) && v.length === 4, 'INVALID_BLEND_IF', `${f} must be [black0, black1, white1, white0] in 0..255`);
    const r = v.map((x, i) => number(x, `${f}[${i}]`, { min: 0, max: 255 }));
    assert(r[0] <= r[1] && r[1] <= r[2] && r[2] <= r[3], 'INVALID_BLEND_IF', `${f} must be ordered black0 <= black1 <= white1 <= white0`, { received: v });
    return r;
  };
  const out = { channel, this: range(input.this, `${label}.blendIf.this`), underlying: range(input.underlying, `${label}.blendIf.underlying`) };
  const isDefault = (r) => r[0] === 0 && r[1] === 0 && r[2] === 255 && r[3] === 255;
  return isDefault(out.this) && isDefault(out.underlying) ? undefined : out;
}

// Adjustment layer: recolours everything below it (or only its clipping base), through its own mask
// and opacity. It holds no objects or pixels.
function normalizeAdjustmentLayer(input, label) {
  const blend = input.blend || 'source-over';
  assert(BLEND_MODES.includes(blend), 'INVALID_BLEND', `${label}.blend is not supported`, { received: blend });
  assert(!Array.isArray(input.objects) || input.objects.length === 0, 'GROUP_HAS_OBJECTS', `${label} is an adjustment layer: it holds no objects`);
  const layer = {
    id: input.id || makeId('adj'),
    type: 'adjustment',
    name: input.name ? String(input.name) : 'Adjustment',
    visible: input.visible === undefined ? true : Boolean(input.visible),
    locked: Boolean(input.locked),
    opacity: input.opacity === undefined ? 1 : number(input.opacity, `${label}.opacity`, { min: 0, max: 1 }),
    blend,
    adjustment: require('./adjustments-schema').normalizeAdjustment(input.adjustment, `${label}.adjustment`),
    objects: [],
  };
  const parentId = normalizeParentId(input, label);
  if (parentId) layer.parentId = parentId;
  const locks = normalizeLocks(input.locks, label);
  if (locks) layer.locks = locks;
  applyMasks(layer, input, label);
  if (input.clipped) layer.clipped = true;
  return layer;
}

function normalizeParentId(input, label) {
  if (input.parentId === undefined || input.parentId === null || input.parentId === '') return undefined;
  assert(typeof input.parentId === 'string', 'INVALID_PARENT', `${label}.parentId must be a group id`, { received: input.parentId });
  return input.parentId;
}

// A group holds no objects of its own; its children are the layers whose parentId names it.
// blend 'pass-through' (default) composites children straight into what is below; any other blend
// (including 'source-over' = Normal) isolates the group first, as in Photoshop.
function normalizeGroup(input, label) {
  const blend = input.blend || 'pass-through';
  assert(blend === 'pass-through' || BLEND_MODES.includes(blend), 'INVALID_BLEND', `${label}.blend is not supported`,
    { received: blend, allowed: ['pass-through'].concat(BLEND_MODES) });
  assert(!Array.isArray(input.objects) || input.objects.length === 0, 'GROUP_HAS_OBJECTS',
    `${label} is a group: put objects in a layer inside it`);
  const t = input.transform || {};
  const identity = ['x', 'y', 'rotation', 'pivotX', 'pivotY'].every((k) => !Number(t[k] || 0))
    && ['scaleX', 'scaleY'].every((k) => t[k] === undefined || Number(t[k]) === 1);
  const unsupported = [];
  if (input.filter && Object.keys(input.filter).length) unsupported.push('filter');
  if (!identity) unsupported.push('transform');
  if (Array.isArray(input.lights) && input.lights.length) unsupported.push('lights');
  if (input.fillOpacity !== undefined && Number(input.fillOpacity) !== 1) unsupported.push('fillOpacity');
  if (input.blendIf) unsupported.push('blendIf');
  if (input.clipped) unsupported.push('clipped');
  assert(!unsupported.length, 'GROUP_FIELD_UNSUPPORTED',
    `${label}: groups do not support ${unsupported.join(', ')} yet; set them on the layers inside`, { fields: unsupported });
  const group = {
    id: input.id || makeId('group'),
    type: 'group',
    name: input.name ? String(input.name) : 'Group',
    visible: input.visible === undefined ? true : Boolean(input.visible),
    locked: Boolean(input.locked),
    opacity: input.opacity === undefined ? 1 : number(input.opacity, `${label}.opacity`, { min: 0, max: 1 }),
    blend,
    objects: [],
  };
  const parentId = normalizeParentId(input, label);
  if (parentId) group.parentId = parentId;
  const locks = normalizeLocks(input.locks, label);
  if (locks) group.locks = locks;
  applyMasks(group, input, label);
  // Layer styles on a group act on the group's composited result (the group is isolated to style it).
  const effects = require('./layer-styles-schema').normalizeEffectList(input.effects, label);
  if (effects) group.effects = effects;
  return group;
}

function normalizeLayer(input, index) {
  const label = `layer[${index}]`;
  assert(input && typeof input === 'object', 'INVALID_LAYER', `${label} must be an object`);
  assert(input.type === undefined || input.type === 'layer' || input.type === 'group' || input.type === 'adjustment', 'INVALID_LAYER',
    `${label}.type must be "layer", "group" or "adjustment"`, { received: input.type });
  if (input.type === 'group') return normalizeGroup(input, label);
  if (input.type === 'adjustment') return normalizeAdjustmentLayer(input, label);
  const blend = input.blend || 'source-over';
  assert(BLEND_MODES.includes(blend), 'INVALID_BLEND', `${label}.blend is not supported`, { received: blend });
  const objects = Array.isArray(input.objects) ? input.objects : [];
  const parentId = normalizeParentId(input, label);
  const layer = {
    id: input.id || makeId('layer'),
    name: input.name ? String(input.name) : `Layer ${index + 1}`,
    visible: input.visible === undefined ? true : Boolean(input.visible),
    locked: Boolean(input.locked),
    opacity: input.opacity === undefined ? 1 : number(input.opacity, `${label}.opacity`, { min: 0, max: 1 }),
    blend,
    transform: normalizeTransform(input.transform, `${label}.transform`),
    filter: normalizeLayerFilter(input.filter, label),
    lights: normalizeLights(input.lights, `${label}.lights`),
    objects: objects.map((obj, i) => normalizeObject(obj, `${label}.objects[${i}]`)),
  };
  if (parentId) layer.parentId = parentId;
  const locks = normalizeLocks(input.locks, label);
  if (locks) layer.locks = locks;
  // Layer styles (live effects) and fill opacity: content opacity that leaves the effects untouched.
  const effects = require('./layer-styles-schema').normalizeEffectList(input.effects, label);
  if (effects) layer.effects = effects;
  if (input.fillOpacity !== undefined) {
    const fill = number(input.fillOpacity, `${label}.fillOpacity`, { min: 0, max: 1 });
    if (fill !== 1) layer.fillOpacity = fill;
  }
  applyMasks(layer, input, label);
  const raster = normalizeRaster(input.raster, label);
  if (raster) layer.raster = raster;
  // Smart filters: an editable stack applied to the content before masks and effects.
  const filters = require('./adjustments-schema').normalizeFilterList(input.filters, label);
  if (filters) layer.filters = filters;
  const filterMask = require('./masks-schema').normalizeMask(input.filterMask, `${label}.filterMask`);
  if (filterMask) layer.filterMask = filterMask;
  // Clipping mask: this layer shows only where the nearest unclipped layer below it (its base) has content.
  if (input.clipped) layer.clipped = true;
  const blendIf = normalizeBlendIf(input.blendIf, label);
  if (blendIf) layer.blendIf = blendIf;
  return layer;
}

/** Validate group links, require v2 compositing for groups, and put layers in canonical tree order. */
function finalizeLayerTree(doc) {
  const tree = require('./layer-tree');
  if (doc.layers.some((l) => (l.effects && l.effects.length) || l.fillOpacity !== undefined || l.blendIf)) {
    assert(doc.canvas.compositing === 'v2', 'EFFECTS_REQUIRE_V2',
      'layer effects, fill opacity and Blend If need canvas.compositing "v2"; switch with document.update {canvas:{compositing:"v2"}}');
  }
  if (doc.layers.some((l) => l.type === 'adjustment' || l.filters || l.filterMask)) {
    assert(doc.canvas.compositing === 'v2', 'ADJUSTMENTS_REQUIRE_V2',
      'adjustment layers and smart filters need canvas.compositing "v2"; switch with document.update {canvas:{compositing:"v2"}}');
  }
  if (doc.layers.some((l) => l.raster)) {
    assert(doc.canvas.compositing === 'v2', 'RASTER_REQUIRES_V2',
      'pixel layers need canvas.compositing "v2"; switch with document.update {canvas:{compositing:"v2"}}');
  }
  if (doc.layers.some((l) => l.mask || l.vectorMask || l.clipped)) {
    assert(doc.canvas.compositing === 'v2', 'MASKS_REQUIRE_V2',
      'layer masks and clipping need canvas.compositing "v2"; switch with document.update {canvas:{compositing:"v2"}}');
  }
  if (!doc.layers.some((l) => l.type === 'group' || l.parentId)) return doc;
  assert(doc.canvas.compositing === 'v2', 'GROUPS_REQUIRE_V2',
    'layer groups need canvas.compositing "v2"; switch with document.update {canvas:{compositing:"v2"}}');
  tree.validateTree(doc.layers);
  tree.canonicalize(doc.layers);
  return doc;
}

function normalizeBackground(background) {
  const bg = background || { type: 'solid', color: '#ffffff' };
  if (bg.type === 'none') return { type: 'none' };
  if (bg.type === 'gradient') {
    assert(bg.gradient, 'INVALID_BACKGROUND', 'canvas.background.gradient is required when type is "gradient"');
    return { type: 'gradient', gradient: normalizePaint(bg.gradient, 'canvas.background.gradient') };
  }
  const type = bg.type || 'solid';
  assert(type === 'solid', 'INVALID_BACKGROUND', 'canvas.background.type must be solid, gradient or none', { received: type });
  return { type: 'solid', color: normalizeColor(bg.color || '#ffffff', 'canvas.background.color') };
}

function createDocument(input) {
  const options = input || {};
  assert(options.id === undefined || /^[A-Za-z0-9_-]{1,160}$/.test(options.id),'INVALID_DOCUMENT_ID','Document id must be a safe identifier');
  const width = number(options.width === undefined ? 1200 : options.width, 'canvas.width', { min: 1, max: MAX_DIMENSION });
  const height = number(options.height === undefined ? 800 : options.height, 'canvas.height', { min: 1, max: MAX_DIMENSION });
  const now = new Date().toISOString();
  const doc = {
    schema: SCHEMA,
    version: VERSION,
    id: options.id || makeId('doc'),
    name: options.name ? String(options.name) : 'Untitled design',
    canvas: {
      width: Math.round(width),
      height: Math.round(height),
      background: normalizeBackground(options.background),
      dpi: options.dpi === undefined ? 72 : number(options.dpi, 'canvas.dpi', { min: 1, max: 1200 }),
      effects: normalizeEffects(options.effects, 'canvas.effects'),
      lights: normalizeLights(options.lights, 'canvas.lights'),
      compositing: normalizeCompositing(options.compositing, 'v2'),
    },
    layers: [],
    animation: createAnimation(options.animationDuration),
    meta: {
      createdAt: now,
      modifiedAt: now,
      createdBy: options.createdBy || 'artforge-drawing-tool',
      locale: options.locale || 'ar',
      notes: options.notes ? String(options.notes) : undefined,
    },
  };
  // Shared light for layer effects that use it (Photoshop's Global Light); default 120° / 30°.
  const globalLight = require('./layer-styles-schema').normalizeGlobalLight(options.globalLight);
  if (globalLight) doc.canvas.globalLight = globalLight;
  const guides = normalizeGuides(options.guides);
  if (guides) doc.canvas.guides = guides;
  const grid = normalizeGrid(options.grid);
  if (grid) doc.canvas.grid = grid;
  // Working colour space: how the document's RGB numbers are meant (sRGB unless stated).
  if (options.colorProfile !== undefined && options.colorProfile !== 'srgb') doc.canvas.colorProfile = require('./color-profiles').requireProfile(options.colorProfile) && options.colorProfile;
  const layers = Array.isArray(options.layers) && options.layers.length ? options.layers : [{ name: 'Layer 1', objects: [] }];
  doc.layers = layers.map((layer, index) => normalizeLayer(layer, index));
  return finalizeLayerTree(doc);
}

function normalizeDocument(input) {
  assert(input && typeof input === 'object', 'INVALID_DOCUMENT', 'document must be an object');
  assert(input.schema === SCHEMA || input.schema === undefined, 'INVALID_DOCUMENT',
    `document.schema must be "${SCHEMA}"`, { received: input.schema });
  assert(input.version === undefined || input.version === VERSION, 'UNSUPPORTED_VERSION',
    `document.version must be ${VERSION}`, { received: input.version });
  const base = createDocument({
    id: input.id,
    name: input.name,
    width: input.canvas && input.canvas.width,
    height: input.canvas && input.canvas.height,
    background: input.canvas && input.canvas.background,
    dpi: input.canvas && input.canvas.dpi,
    effects: input.canvas && input.canvas.effects,
    lights: input.canvas && input.canvas.lights,
    globalLight: input.canvas && input.canvas.globalLight,
    guides: input.canvas && input.canvas.guides,
    colorProfile: input.canvas && input.canvas.colorProfile,
    grid: input.canvas && input.canvas.grid,
    // A stored document without the field predates v2 compositing: keep its original appearance.
    compositing: normalizeCompositing(input.canvas && input.canvas.compositing, 'legacy'),
    locale: input.meta && input.meta.locale,
    layers: input.layers,
  });
  base.animation = input.animation ? normalizeAnimation(input.animation) : createAnimation();
  if (input.meta) {
    base.meta = Object.assign({}, base.meta, {
      createdAt: input.meta.createdAt || base.meta.createdAt,
      modifiedAt: input.meta.modifiedAt || base.meta.modifiedAt,
      notes: input.meta.notes,
      createdBy: input.meta.createdBy || base.meta.createdBy,
    });
  }
  return base;
}

function touch(doc) {
  doc.meta.modifiedAt = new Date().toISOString();
  return doc;
}

function findLayer(doc, layerId) {
  return doc.layers.find((layer) => layer.id === layerId) || null;
}

function findObject(doc, objectId) {
  for (let li = 0; li < doc.layers.length; li += 1) {
    const layer = doc.layers[li];
    const oi = layer.objects.findIndex((object) => object.id === objectId);
    if (oi >= 0) return { layer, layerIndex: li, object: layer.objects[oi], objectIndex: oi };
  }
  return null;
}

function documentStats(doc) {
  const objects = doc.layers.reduce((sum, layer) => sum + layer.objects.length, 0);
  return {
    id: doc.id,
    name: doc.name,
    width: doc.canvas.width,
    height: doc.canvas.height,
    layers: doc.layers.length,
    objects,
    animated: Boolean(doc.animation && doc.animation.enabled),
    modifiedAt: doc.meta.modifiedAt,
  };
}

module.exports = { normalizeBlendIf,
  normalizeEffects,
  normalizeCompositing,
  normalizeLocks,
  normalizeGuides,
  normalizeGrid,
  LOCK_KINDS,
  COMPOSITING_MODES,
  finalizeLayerTree,
  SCHEMA,
  VERSION,
  MAX_DIMENSION,
  createDocument,
  normalizeDocument,
  normalizeLayer,
  normalizeObject,
  normalizeBackground,
  normalizeTransform,
  touch,
  findLayer,
  findObject,
  documentStats,
  number,
};
