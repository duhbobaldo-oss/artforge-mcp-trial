'use strict';

/**
 * Illustration style kit: turns an outline into a finished form instead of a flat shape.
 *   base tone → cel shadow (clipped inside, on the side away from the light) → soft highlight (lit side)
 *   → outline in a deeper shade of the same colour.
 * Light comes from the upper left by default (matches the key-light rule used by the composers).
 */

const { smoothSegments, r2 } = require('./builder');
const { mix, darken, lighten, rgba } = require('../color');

const LIGHT = { x: -0.62, y: -0.78 };

function bounds(points) {
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

function shift(points, dx, dy) {
  return points.map((p) => ({ x: p.x + dx, y: p.y + dy }));
}

function scaleAbout(points, k, c) {
  return points.map((p) => ({ x: c.x + (p.x - c.x) * k, y: c.y + (p.y - c.y) * k }));
}

/** Shadow tone: darker, slightly cooler (sky fill in the shadows). */
function shadowOf(color, depth) {
  return mix(darken(color, depth === undefined ? 0.28 : depth), '#2a3a6a', 0.08);
}

/** Highlight tone: lighter, slightly warmer (warm key light). */
function lightOf(color, amount) {
  return mix(lighten(color, amount === undefined ? 0.2 : amount), '#fff2d8', 0.15);
}

/**
 * Draw one shaded, outlined form through `points` (closed smooth outline).
 * opts: { fill, shade (0..1 depth of the shadow band), highlight (bool), outline (px or 0), light {x,y}, note }
 */
function toon(P, layer, points, opts, element) {
  const o = opts || {};
  const fill = o.fill;
  const light = o.light || LIGHT;
  const b = bounds(points);
  const size = Math.max(b.w, b.h);
  // Shading is measured across the form (its short side): on a long arm or leg the lit band must stay on it.
  const minor = Math.max(1, Math.min(b.w, b.h));
  const clip = { type: 'path', segments: smoothSegments(points, true) };
  const ids = [];
  const note = o.note || element || 'form';
  // 1) whole form in the shadow tone, 2) lit part = same form shifted toward the light, clipped inside.
  ids.push(P.blob(layer, points, { fill: shadowOf(fill, o.shadeDepth) }, element, `${note}: shadow tone`));
  const band = (o.shade === undefined ? 0.22 : o.shade) * minor * 1.5;
  // soft (default 0.3) blurs the light/shadow boundary so forms turn smoothly instead of a hard cartoon edge.
  const soft = o.soft === undefined ? 0.3 : o.soft;
  ids.push(P.blob(layer, shift(points, light.x * band, light.y * band), Object.assign({ fill, clip }, soft > 0 ? { blur: Math.max(0.5, minor * 0.12 * soft) } : {}), element, `${note}: lit side`));
  if (o.highlight !== false) {
    const c = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
    const hi = shift(scaleAbout(points, 0.42, c), light.x * minor * 0.32, light.y * minor * 0.32);
    ids.push(P.blob(layer, hi, { fill: rgba(lightOf(fill, o.highlightAmount), o.highlightAlpha === undefined ? 0.38 : o.highlightAlpha), clip, blur: Math.max(1, minor * 0.08) }, element, `${note}: highlight`));
  }
  if (o.outline !== 0) {
    const w = o.outline === undefined ? Math.max(1.4, size * 0.012) : o.outline;
    ids.push(P.blob(layer, points, { fill: null, stroke: o.lineColor || darken(fill, 0.55), strokeWidth: w, opacity: o.lineOpacity === undefined ? 0.85 : o.lineOpacity }, element, `${note}: outline`));
  }
  return { ids, clip, bounds: b };
}

/**
 * Rectangular form (cabinet, shelf, book, frame, window part) with the same finish as toon():
 * shadow tone, lit part shifted toward the light and clipped to the box, top-edge highlight, outline.
 */
function toonRect(P, layer, box, opts, element) {
  const o = opts || {};
  const light = o.light || LIGHT;
  const radius = o.radius || 0;
  const clip = { type: 'rect', x: box.x, y: box.y, w: box.w, h: box.h, radius };
  const minor = Math.max(1, Math.min(box.w, box.h));
  const band = (o.shade === undefined ? 0.12 : o.shade) * minor;
  const note = o.note || element || 'panel';
  const ids = [];
  ids.push(P.rect(layer, { x: box.x, y: box.y, w: box.w, h: box.h, radius, fill: shadowOf(o.fill, o.shadeDepth === undefined ? 0.22 : o.shadeDepth) }, element, `${note}: shadow tone`));
  ids.push(P.rect(layer, { x: box.x + light.x * band, y: box.y + light.y * band, w: box.w, h: box.h, radius, fill: o.fill, clip }, element, `${note}: lit face`));
  if (o.edge !== false) {
    const t = Math.max(1, Math.min(box.h * 0.12, minor * 0.08));
    ids.push(P.rect(layer, { x: box.x, y: box.y, w: box.w, h: t, fill: rgba(lightOf(o.fill, 0.35), 0.7), clip }, element, `${note}: lit top edge`));
  }
  if (o.outline !== 0) {
    ids.push(P.rect(layer, { x: box.x, y: box.y, w: box.w, h: box.h, radius, fill: null, stroke: o.lineColor || darken(o.fill, 0.55), strokeWidth: o.outline === undefined ? Math.max(1.2, minor * 0.02) : o.outline, opacity: 0.85 }, element, `${note}: outline`));
  }
  return { ids, clip };
}

/** Tapered limb outline through joints (closed points), widths per joint; rounded ends. */
function limbOutline(joints, widths) {
  const left = [];
  const right = [];
  joints.forEach((p, i) => {
    const a = joints[Math.max(0, i - 1)];
    const b = joints[Math.min(joints.length - 1, i + 1)];
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const nx = -(b.y - a.y) / len;
    const ny = (b.x - a.x) / len;
    left.push({ x: p.x + nx * widths[i] / 2, y: p.y + ny * widths[i] / 2 });
    right.push({ x: p.x - nx * widths[i] / 2, y: p.y - ny * widths[i] / 2 });
  });
  const n = joints.length;
  const end = joints[n - 1];
  const pre = joints[n - 2];
  const dE = Math.hypot(end.x - pre.x, end.y - pre.y) || 1;
  const tip = { x: end.x + ((end.x - pre.x) / dE) * widths[n - 1] * 0.45, y: end.y + ((end.y - pre.y) / dE) * widths[n - 1] * 0.45 };
  const start = joints[0];
  const dS = Math.hypot(joints[1].x - start.x, joints[1].y - start.y) || 1;
  const root = { x: start.x - ((joints[1].x - start.x) / dS) * widths[0] * 0.4, y: start.y - ((joints[1].y - start.y) / dS) * widths[0] * 0.4 };
  return [root, ...left, tip, ...right.reverse()];
}

/** Ellipse as outline points (so it can be toon-shaded and used as a clip). */
function ellipsePoints(cx, cy, rx, ry, n, rot) {
  const pts = [];
  const count = n || 16;
  const a0 = rot || 0;
  for (let i = 0; i < count; i += 1) {
    const t = (i / count) * Math.PI * 2;
    const x = Math.cos(t) * rx;
    const y = Math.sin(t) * ry;
    pts.push({ x: cx + x * Math.cos(a0) - y * Math.sin(a0), y: cy + x * Math.sin(a0) + y * Math.cos(a0) });
  }
  return pts;
}

/** Organic blob: ellipse with seeded radial noise (foliage, bushes, clouds, rocks). */
function organic(P, cx, cy, rx, ry, rough, n) {
  const count = n || 14;
  const pts = [];
  for (let i = 0; i < count; i += 1) {
    const t = (i / count) * Math.PI * 2;
    const k = 1 + (P.random() - 0.5) * 2 * (rough || 0.12);
    pts.push({ x: cx + Math.cos(t) * rx * k, y: cy + Math.sin(t) * ry * k });
  }
  return pts;
}

/** A thin tapered stroke (eyebrow, crease, fold, grass blade) as a filled shape. */
function taper(P, layer, a, b, width, fill, element, note, bend) {
  const mid = { x: (a.x + b.x) / 2 + (bend ? bend.x : 0), y: (a.y + b.y) / 2 + (bend ? bend.y : 0) };
  const pts = limbOutline([a, mid, b], [width * 0.35, width, width * 0.2]);
  return P.blob(layer, pts, { fill }, element, note);
}

module.exports = { toon, toonRect, limbOutline, ellipsePoints, organic, taper, shadowOf, lightOf, bounds, shift, LIGHT, r2 };
