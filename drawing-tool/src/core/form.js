'use strict';

/**
 * draw.form: one operation that draws a FINISHED form instead of a flat shape:
 *   base (shadow tone) → lit face shifted toward the light and clipped inside → soft highlight →
 *   optional texture (pattern) and gloss streak → outline in a deeper shade of the same colour.
 * Shapes: rect (with radius), ellipse, polygon (straight) or path (smooth curve through points).
 */

const { assert } = require('./errors');
const { parseRgba, rgbaString, mixOklab } = require('./effects');
const { pointsToBezierSegments } = require('./brush');

const shade = (c, k) => { const p = parseRgba(c); return p ? rgbaString({ r: p.r * (1 - k), g: p.g * (1 - k), b: p.b * (1 - k), a: p.a }) : c; };
const tint = (c, k) => { const p = parseRgba(c); return p ? rgbaString({ r: p.r + (255 - p.r) * k, g: p.g + (255 - p.g) * k, b: p.b + (255 - p.b) * k, a: p.a }) : c; };

function geometry(params) {
  const shape = params.shape || (params.points ? 'path' : 'rect');
  if (shape === 'rect' || shape === 'ellipse') {
    for (const k of ['x', 'y', 'w', 'h']) assert(Number.isFinite(Number(params[k])), 'INVALID_FORM', `draw.form ${shape} needs ${k}`);
    const box = { x: Number(params.x), y: Number(params.y), w: Number(params.w), h: Number(params.h) };
    return { shape, box, clip: shape === 'rect' ? { type: 'rect', x: box.x, y: box.y, w: box.w, h: box.h, radius: params.radius || 0 } : { type: 'ellipse', x: box.x, y: box.y, w: box.w, h: box.h } };
  }
  assert(Array.isArray(params.points) && params.points.length >= 3, 'INVALID_FORM', 'draw.form polygon/path needs at least 3 points');
  const pts = params.points.map((p) => ({ x: Number(p.x), y: Number(p.y) }));
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const box = { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
  const segments = shape === 'polygon'
    ? pts.map((p, i) => ({ op: i ? 'L' : 'M', x: p.x, y: p.y }))
    : pointsToBezierSegments(pts, params.smooth === undefined ? 1 : Number(params.smooth), true).filter((s) => s.op !== 'Z');
  return { shape, box, segments, clip: { type: 'path', segments } };
}

/** Same outline, moved by (dx, dy): used for the lit face and the highlight. */
function moved(geo, dx, dy, k, params) {
  const c = { x: geo.box.x + geo.box.w / 2, y: geo.box.y + geo.box.h / 2 };
  const map = (x, y) => ({ x: c.x + (x - c.x) * k + dx, y: c.y + (y - c.y) * k + dy });
  if (geo.shape === 'rect' || geo.shape === 'ellipse') {
    const p = map(geo.box.x, geo.box.y);
    return { type: geo.shape, x: p.x, y: p.y, w: geo.box.w * k, h: geo.box.h * k, radius: geo.shape === 'rect' ? (params.radius || 0) : undefined };
  }
  return { type: 'path', closed: true, segments: geo.segments.map((s) => {
    const o = { op: s.op };
    for (const [kx, ky] of [['x', 'y'], ['c1x', 'c1y'], ['c2x', 'c2y'], ['cx', 'cy']]) {
      if (s[kx] !== undefined) { const p = map(s[kx], s[ky]); o[kx] = p.x; o[ky] = p.y; }
    }
    return o;
  }) };
}

function buildForm(params) {
  assert(params.fill, 'INVALID_FORM', 'draw.form needs fill (the base colour of the form)');
  const geo = geometry(params);
  const fill = String(params.fill);
  const angle = ((params.lightAngle === undefined ? 225 : Number(params.lightAngle)) * Math.PI) / 180; // 225° = upper left
  const L = { x: Math.cos(angle), y: Math.sin(angle) };
  const minor = Math.max(1, Math.min(geo.box.w, geo.box.h));
  const band = (params.shade === undefined ? 0.2 : Number(params.shade)) * minor * 1.5;
  const name = params.name || 'form';
  const shadowTone = mixOklab(shade(fill, params.shadeDepth === undefined ? 0.28 : Number(params.shadeDepth)), '#2a3a6a', 0.08);
  const objects = [];
  objects.push(Object.assign(moved(geo, 0, 0, 1, params), { name: `${name}:shadow`, fill: shadowTone }));
  // soft (0..1, default 0.35): blurs the light/shadow boundary — 0 gives a crisp cel edge, 1 a fully rounded form.
  const soft = params.soft === undefined ? 0.35 : Math.max(0, Math.min(1, Number(params.soft)));
  const lit = Object.assign(moved(geo, L.x * band, L.y * band, 1, params), { name: `${name}:lit`, fill, clip: geo.clip });
  if (soft > 0) lit.blur = Math.max(0.5, minor * 0.12 * soft);
  objects.push(lit);
  if (params.highlight !== false) {
    objects.push(Object.assign(moved(geo, L.x * minor * 0.32, L.y * minor * 0.32, 0.42, params), {
      name: `${name}:highlight`, fill: rgbaString(Object.assign(parseRgba(mixOklab(tint(fill, 0.3), '#fff2d8', 0.15)), { a: params.highlightAlpha === undefined ? 0.4 : Number(params.highlightAlpha) })),
      clip: geo.clip, blur: Math.max(1, minor * 0.08),
    }));
  }
  if (params.texture) {
    objects.push(Object.assign(moved(geo, 0, 0, 1, params), { name: `${name}:texture`, fill: Object.assign({ type: 'pattern' }, params.texture), opacity: params.texture.opacity === undefined ? 0.5 : Number(params.texture.opacity), blend: params.texture.blend || 'multiply' }));
  }
  if (params.gloss) {
    // Specular streak (glass, metal, glossy plastic): a thin bright band across the form, clipped inside.
    const g = geo.box;
    objects.push({ type: 'polygon', name: `${name}:gloss`, points: [{ x: g.x + g.w * 0.15, y: g.y + g.h }, { x: g.x + g.w * 0.32, y: g.y + g.h }, { x: g.x + g.w * 0.62, y: g.y }, { x: g.x + g.w * 0.45, y: g.y }], fill: `rgba(255,255,255,${Number(params.gloss) || 0.25})`, clip: geo.clip });
  }
  if (params.outline !== 0) {
    objects.push(Object.assign(moved(geo, 0, 0, 1, params), { name: `${name}:outline`, fill: null, stroke: params.lineColor || shade(fill, 0.55), strokeWidth: params.outline === undefined ? Math.max(1.2, minor * 0.015) : Number(params.outline), opacity: 0.85 }));
  }
  return objects;
}

module.exports = { buildForm };
