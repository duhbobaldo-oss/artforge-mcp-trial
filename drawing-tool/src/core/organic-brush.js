'use strict';

/**
 * Organic vector stroke (plan item 1): a hand-drawn line as ONE filled outline, not a row of raster stamps.
 *
 * points → streamline smoothing → arc-length resampling → width from pressure (given p, or simulated from speed)
 * → tapered ends → left/right offset outline with round caps → Douglas-Peucker simplification → smooth closed
 * Bézier path (the existing pointsToBezierSegments). The result is an ordinary `path` object: editable, undoable,
 * transformable and exportable to SVG/PDF as a vector.
 */

const { assert } = require('./errors');
const { pointsToBezierSegments } = require('./brush');

const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

function streamline(points, amount) {
  if (amount <= 0) return points.map((p) => Object.assign({}, p));
  const out = [Object.assign({}, points[0])];
  for (let i = 1; i < points.length; i += 1) {
    const prev = out[out.length - 1];
    const t = 1 - amount * 0.85;
    out.push({ x: prev.x + (points[i].x - prev.x) * t, y: prev.y + (points[i].y - prev.y) * t, p: points[i].p });
  }
  out[out.length - 1] = Object.assign({}, points[points.length - 1]); // the stroke still ends where the hand ended
  return out;
}

/** Catmull-Rom centreline through sparse control points, sampled about every `step` px (curve mode). */
function spline(points, step) {
  if (points.length < 3) return points.map((p) => Object.assign({}, p));
  const out = [];
  for (let i = 0; i < points.length - 1; i += 1) {
    const p0 = points[Math.max(0, i - 1)]; const p1 = points[i]; const p2 = points[i + 1]; const p3 = points[Math.min(points.length - 1, i + 2)];
    const n = Math.max(1, Math.ceil(Math.hypot(p2.x - p1.x, p2.y - p1.y) / step));
    for (let k = 0; k < n; k += 1) {
      const t = k / n; const t2 = t * t; const t3 = t2 * t;
      const at = (a, b, c, d) => 0.5 * ((2 * b) + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      out.push({ x: at(p0.x, p1.x, p2.x, p3.x), y: at(p0.y, p1.y, p2.y, p3.y),
        p: p1.p === undefined || p2.p === undefined ? undefined : p1.p + (p2.p - p1.p) * t });
    }
  }
  out.push(Object.assign({}, points[points.length - 1]));
  return out;
}

function resample(points, spacing) {
  const out = [Object.assign({ d: 0 }, points[0])];
  let carried = 0; let total = 0;
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1]; const b = points[i];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (!len) continue;
    let t = spacing - carried;
    while (t <= len) {
      const k = t / len;
      out.push({ x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k, p: a.p === undefined || b.p === undefined ? undefined : a.p + (b.p - a.p) * k, d: total + t });
      t += spacing;
    }
    carried = len - (t - spacing);
    total += len;
  }
  const last = points[points.length - 1];
  if (Math.hypot(last.x - out[out.length - 1].x, last.y - out[out.length - 1].y) > spacing * 0.25) out.push(Object.assign({ d: total }, last));
  return { points: out, length: total };
}

function simplify(pts, tol) {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length); keep[0] = 1; keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop();
    const a = pts[s]; const b = pts[e];
    const L = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    let best = -1; let dmax = 0;
    for (let i = s + 1; i < e; i += 1) {
      const d = Math.abs((b.x - a.x) * (a.y - pts[i].y) - (a.x - pts[i].x) * (b.y - a.y)) / L;
      if (d > dmax) { dmax = d; best = i; }
    }
    if (dmax > tol && best > 0) { keep[best] = 1; stack.push([s, best], [best, e]); }
  }
  return pts.filter((_, i) => keep[i]);
}

/** Outline polygon + metrics for a stroke. */
function strokeOutline(input, extra = 0) {
  assert(Array.isArray(input.points) && input.points.length >= 2, 'INVALID_POINTS', 'points needs at least two {x,y[,p]} points');
  assert(input.points.length <= 20000, 'INVALID_POINTS', 'points must be at most 20000');
  const pts = input.points.map((p, i) => {
    assert(Number.isFinite(Number(p.x)) && Number.isFinite(Number(p.y)), 'INVALID_POINTS', `points[${i}] needs numeric x and y`);
    return { x: Number(p.x), y: Number(p.y), p: p.p === undefined ? undefined : clamp(num(p.p, 0.5), 0, 1) };
  });
  const size = clamp(num(input.size, 8), 0.5, 400);
  const thinning = clamp(num(input.thinning, 0.6), 0, 1); // how much pressure narrows the line
  const smoothing = clamp(num(input.smoothing, 0.5), 0, 1);
  const taperStart = clamp(num(input.taperStart, 0.15), 0, 0.5);
  const taperEnd = clamp(num(input.taperEnd, 0.2), 0, 0.5);
  // Curve mode (curve:true, implied by outline): a spline through the control points sampled densely, so a thick
  // body drawn from a handful of points is smooth and of even width. Without it a 68px stroke was sampled every
  // 17px and came out lumpy, and a second, wider stroke did not follow the same centreline.
  const curve = input.curve === true || Boolean(input.outline);
  const spacing = curve ? Math.max(1, Math.min(size / 4, 3)) : Math.max(0.5, size / 4);
  const { points, length } = resample(curve ? spline(pts, Math.max(2, Math.min(size / 6, 4))) : streamline(pts, smoothing), spacing);
  const hasPressure = pts.some((p) => p.p !== undefined);
  // Simulated pressure: fast segments are thinner, as with a real pen.
  let prevP = 0.5;
  const widths = points.map((p, i) => {
    let pressure;
    if (hasPressure && p.p !== undefined) pressure = p.p;
    else {
      const q = points[Math.max(0, i - 1)];
      const speed = Math.hypot(p.x - q.x, p.y - q.y) / spacing;
      pressure = prevP + (clamp(1.15 - speed * 0.35, 0.2, 1) - prevP) * 0.3;
      prevP = pressure;
    }
    let w = size * (1 - thinning * (1 - pressure));
    const ease = (t) => Math.sin((clamp(t, 0, 1) * Math.PI) / 2);
    if (taperStart > 0 && length > 0) w *= Math.max(0.05, ease(p.d / (length * taperStart)));
    if (taperEnd > 0 && length > 0) w *= Math.max(0.05, ease((length - p.d) / (length * taperEnd)));
    return Math.max(0.25, w / 2) + extra;
  });
  const left = []; const right = [];
  for (let i = 0; i < points.length; i += 1) {
    const a = points[Math.max(0, i - 1)]; const b = points[Math.min(points.length - 1, i + 1)];
    let nx = -(b.y - a.y); let ny = b.x - a.x;
    const n = Math.hypot(nx, ny) || 1; nx /= n; ny /= n;
    left.push({ x: points[i].x + nx * widths[i], y: points[i].y + ny * widths[i] });
    right.push({ x: points[i].x - nx * widths[i], y: points[i].y - ny * widths[i] });
  }
  const cap = (center, from, r, steps) => {
    const a0 = Math.atan2(from.y - center.y, from.x - center.x);
    return Array.from({ length: steps - 1 }, (_, k) => {
      const a = a0 - (Math.PI * (k + 1)) / steps;
      return { x: center.x + Math.cos(a) * r, y: center.y + Math.sin(a) * r };
    });
  };
  const capSteps = (r) => (curve ? Math.max(8, Math.ceil(r / 2)) : 6);
  const last = points.length - 1;
  const outline = left
    .concat(cap(points[last], left[last], widths[last], capSteps(widths[last])))
    .concat(right.slice().reverse())
    .concat(cap(points[0], right[0], widths[0], capSteps(widths[0])));
  const simplified = simplify(outline, curve ? 0.2 : Math.max(0.15, size * 0.02));
  return { outline: simplified, length: Math.round(length * 10) / 10, samples: points.length, maxWidth: Math.round(Math.max(...widths) * 20) / 10, minWidth: Math.round(Math.min(...widths) * 20) / 10 };
}

/** Object input for addObject: a closed, filled, smooth path. */
function strokeObject(params) {
  const res = strokeOutline(params);
  const r2 = (v) => Math.round(v * 100) / 100;
  const toSegments = (outline) => pointsToBezierSegments(outline.map((p) => ({ x: r2(p.x), y: r2(p.y) })), 0.5, true);
  const segments = toSegments(res.outline);
  let outlineObject;
  if (params.outline !== undefined && params.outline !== null) {
    const o = params.outline;
    assert(typeof o === 'object' && typeof o.color === 'string' && o.color, 'INVALID_OUTLINE', 'outline needs {color, width?}');
    const width = clamp(num(o.width, 4), 0.5, 100);
    // Same centreline, half-width + outline width everywhere, so the border is even along the body and round the tip.
    outlineObject = { type: 'path', name: 'organic-stroke-outline', segments: toSegments(strokeOutline(params, width).outline), closed: true,
      fill: o.color, stroke: null, opacity: params.opacity, blend: params.blend };
  }
  return {
    outlineObject,
    object: {
      type: 'path',
      name: params.name || 'organic-stroke',
      segments,
      closed: true,
      fill: params.color || params.fill || '#111111',
      stroke: null,
      opacity: params.opacity,
      blend: params.blend,
      blur: params.blur,
    },
    metrics: { length: res.length, samples: res.samples, outlinePoints: res.outline.length, maxWidth: res.maxWidth, minWidth: res.minWidth },
  };
}

module.exports = { strokeOutline, strokeObject };
