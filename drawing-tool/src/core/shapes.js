'use strict';

/**
 * Parametric shapes: polygon, star, arc (pie / donut / partial ellipse), spiral and a rectangle with corner
 * smoothing (squircle). Each shape is stored as an ordinary `path` object whose `shape` field keeps the
 * parameters, so every renderer and exporter (PNG, SVG, PDF, PSD) draws it unchanged, and `shape.update`
 * can regenerate it when a parameter is edited.
 *
 * Shared by the engine (Node) and the editor (browser bundle) for live previews: no Node-only requires.
 * Behaviour follows the documented, observable behaviour of design tools (clean-room; no third-party code):
 *   polygon: first vertex at the top, vertices on the ellipse of the box;
 *   star: `points` tips, inner vertices at `ratio` of the outer radius;
 *   arc: `start` angle (deg, clockwise from 3 o'clock), `sweep` (deg), `ratio` = inner radius (0 = pie);
 *   corner smoothing: 0 = circular corners, 1 = the smoothest squircle; the curvature transition begins
 *   (1 + smoothing) × radius from the corner.
 */

const { assert } = require('./errors');

const KINDS = ['polygon', 'star', 'arc', 'spiral', 'rect'];
const DEG = Math.PI / 180;
const r2 = (v) => Math.round(v * 100) / 100;
const finite = (v, field, min, max, fallback) => {
  const n = v === undefined ? fallback : Number(v);
  assert(Number.isFinite(n) && n >= min && n <= max, 'INVALID_SHAPE', `${field} must be between ${min} and ${max}`, { received: v });
  return n;
};

/** Validate and complete a shape spec: { kind, box:{x,y,w,h}, ...params } with defaults written in. */
function normalizeShapeSpec(input, field) {
  const f = field || 'shape';
  assert(input && typeof input === 'object', 'INVALID_SHAPE', `${f} must be an object`);
  assert(KINDS.includes(input.kind), 'INVALID_SHAPE', `${f}.kind must be one of ${KINDS.join(', ')}`, { received: input.kind });
  const b = input.box || {};
  const out = {
    kind: input.kind,
    box: { x: finite(b.x, `${f}.box.x`, -1e6, 1e6, 0), y: finite(b.y, `${f}.box.y`, -1e6, 1e6, 0), w: finite(b.w, `${f}.box.w`, 0.5, 1e5, 100), h: finite(b.h, `${f}.box.h`, 0.5, 1e5, 100) },
  };
  switch (input.kind) {
    case 'polygon':
      out.sides = Math.round(finite(input.sides, `${f}.sides`, 3, 60, 3));
      out.cornerRadius = finite(input.cornerRadius, `${f}.cornerRadius`, 0, 1e4, 0);
      break;
    case 'star':
      out.points = Math.round(finite(input.points, `${f}.points`, 3, 60, 5));
      out.ratio = finite(input.ratio, `${f}.ratio`, 0.05, 0.99, 0.382);
      out.cornerRadius = finite(input.cornerRadius, `${f}.cornerRadius`, 0, 1e4, 0);
      break;
    case 'arc':
      out.start = finite(input.start, `${f}.start`, -720, 720, 0);
      out.sweep = finite(input.sweep, `${f}.sweep`, 0.5, 360, 270);
      out.ratio = finite(input.ratio, `${f}.ratio`, 0, 0.99, 0);
      break;
    case 'spiral':
      out.turns = finite(input.turns, `${f}.turns`, 0.25, 40, 4);
      out.growth = input.growth === undefined ? 'archimedean' : input.growth;
      assert(['archimedean', 'logarithmic'].includes(out.growth), 'INVALID_SHAPE', `${f}.growth must be archimedean or logarithmic`);
      out.direction = input.direction === undefined ? 'cw' : input.direction;
      assert(['cw', 'ccw'].includes(out.direction), 'INVALID_SHAPE', `${f}.direction must be cw or ccw`);
      out.innerRatio = finite(input.innerRatio, `${f}.innerRatio`, 0, 0.9, 0.05);
      break;
    case 'rect': {
      const radius = input.radius === undefined ? 0 : input.radius;
      out.radius = Array.isArray(radius)
        ? (assert(radius.length === 4, 'INVALID_SHAPE', `${f}.radius must be a number or [tl, tr, br, bl]`), radius.map((v, i) => finite(v, `${f}.radius[${i}]`, 0, 1e4, 0)))
        : finite(radius, `${f}.radius`, 0, 1e4, 0);
      out.smoothing = finite(input.smoothing, `${f}.smoothing`, 0, 1, 0.6);
      break;
    }
    default: break;
  }
  return out;
}

// ------------------------------------------------------------------ helpers

const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y });
const add = (a, b) => ({ x: a.x + b.x, y: a.y + b.y });
const mul = (a, k) => ({ x: a.x * k, y: a.y * k });
const len = (a) => Math.hypot(a.x, a.y);
const unit = (a) => { const l = len(a) || 1; return { x: a.x / l, y: a.y / l }; };
const M = (p) => ({ op: 'M', x: r2(p.x), y: r2(p.y) });
const L = (p) => ({ op: 'L', x: r2(p.x), y: r2(p.y) });
const Q = (c, p) => ({ op: 'Q', cx: r2(c.x), cy: r2(c.y), x: r2(p.x), y: r2(p.y) });
const C = (c1, c2, p) => ({ op: 'C', c1x: r2(c1.x), c1y: r2(c1.y), c2x: r2(c2.x), c2y: r2(c2.y), x: r2(p.x), y: r2(p.y) });
const Z = () => ({ op: 'Z' });

/** Cubic Bézier pieces (≤ 90° each) of an elliptical arc; angles in radians, screen orientation (y down). */
function arcCubics(cx, cy, rx, ry, a0, a1) {
  const out = [];
  const n = Math.max(1, Math.ceil(Math.abs(a1 - a0) / (Math.PI / 2) - 1e-9));
  const step = (a1 - a0) / n;
  const k = (4 / 3) * Math.tan(step / 4);
  for (let i = 0; i < n; i += 1) {
    const s = a0 + step * i; const e = s + step;
    const p0 = { x: cx + rx * Math.cos(s), y: cy + ry * Math.sin(s) };
    const p3 = { x: cx + rx * Math.cos(e), y: cy + ry * Math.sin(e) };
    out.push(C({ x: p0.x - k * rx * Math.sin(s), y: p0.y + k * ry * Math.cos(s) }, { x: p3.x + k * rx * Math.sin(e), y: p3.y - k * ry * Math.cos(e) }, p3));
  }
  return out;
}

/** Closed polygon through `pts` with every corner rounded by `radius` (fillet, limited by half of each edge). */
function roundedPolygon(pts, radius) {
  if (!(radius > 0)) return [M(pts[0]), ...pts.slice(1).map(L), Z()];
  const segs = [];
  const n = pts.length;
  for (let i = 0; i < n; i += 1) {
    const prev = pts[(i - 1 + n) % n]; const v = pts[i]; const next = pts[(i + 1) % n];
    const a = unit(sub(prev, v)); const b = unit(sub(next, v));
    const cos = Math.max(-1, Math.min(1, a.x * b.x + a.y * b.y));
    const half = Math.acos(cos) / 2;
    const d = Math.min(radius / Math.tan(half || 1e-6), len(sub(prev, v)) / 2, len(sub(next, v)) / 2);
    const p1 = add(v, mul(a, d)); const p2 = add(v, mul(b, d));
    segs.push(i === 0 ? M(p1) : L(p1));
    // Cubic with handles at 0.5523 toward the vertex: a close circular fillet for any angle.
    segs.push(C(add(p1, mul(sub(v, p1), 0.5523)), add(p2, mul(sub(v, p2), 0.5523)), p2));
  }
  segs.push(Z());
  return segs;
}

// ------------------------------------------------------------------ generators

function polygon(s) {
  const { x, y, w, h } = s.box;
  const cx = x + w / 2; const cy = y + h / 2;
  const pts = [];
  for (let i = 0; i < s.sides; i += 1) {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / s.sides;
    pts.push({ x: cx + (w / 2) * Math.cos(a), y: cy + (h / 2) * Math.sin(a) });
  }
  return roundedPolygon(pts, s.cornerRadius);
}

function star(s) {
  const { x, y, w, h } = s.box;
  const cx = x + w / 2; const cy = y + h / 2;
  const pts = [];
  for (let i = 0; i < s.points * 2; i += 1) {
    const a = -Math.PI / 2 + (i * Math.PI) / s.points;
    const k = i % 2 ? s.ratio : 1;
    pts.push({ x: cx + (w / 2) * k * Math.cos(a), y: cy + (h / 2) * k * Math.sin(a) });
  }
  return roundedPolygon(pts, s.cornerRadius);
}

function arc(s) {
  const { x, y, w, h } = s.box;
  const cx = x + w / 2; const cy = y + h / 2; const rx = w / 2; const ry = h / 2;
  const a0 = s.start * DEG; const a1 = (s.start + s.sweep) * DEG;
  const full = s.sweep >= 359.999;
  const outerStart = { x: cx + rx * Math.cos(a0), y: cy + ry * Math.sin(a0) };
  const segs = [M(outerStart), ...arcCubics(cx, cy, rx, ry, a0, a1)];
  if (s.ratio > 0) {
    const irx = rx * s.ratio; const iry = ry * s.ratio;
    const innerEnd = { x: cx + irx * Math.cos(a1), y: cy + iry * Math.sin(a1) };
    if (full) { segs.push(Z(), M(innerEnd)); } else segs.push(L(innerEnd));
    segs.push(...arcCubics(cx, cy, irx, iry, a1, a0));
  } else if (!full) segs.push(L({ x: cx, y: cy }));
  segs.push(Z());
  return segs;
}

/** Catmull-Rom through points → cubic Béziers (open). */
function smoothOpen(pts) {
  const segs = [M(pts[0])];
  for (let i = 0; i < pts.length - 1; i += 1) {
    const p0 = pts[Math.max(0, i - 1)]; const p1 = pts[i]; const p2 = pts[i + 1]; const p3 = pts[Math.min(pts.length - 1, i + 2)];
    segs.push(C(add(p1, mul(sub(p2, p0), 1 / 6)), sub(p2, mul(sub(p3, p1), 1 / 6)), p2));
  }
  return segs;
}

function spiral(s) {
  const { x, y, w, h } = s.box;
  const cx = x + w / 2; const cy = y + h / 2;
  const total = s.turns * 2 * Math.PI;
  const n = Math.max(12, Math.ceil(s.turns * 24));
  const sign = s.direction === 'ccw' ? -1 : 1;
  const pts = [];
  for (let i = 0; i <= n; i += 1) {
    const t = i / n;
    // Radius as a fraction of the box: archimedean grows evenly per turn, logarithmic by a constant ratio.
    const k = s.growth === 'logarithmic'
      ? s.innerRatio + (1 - s.innerRatio) * ((Math.exp(3 * t) - 1) / (Math.exp(3) - 1))
      : s.innerRatio + (1 - s.innerRatio) * t;
    const a = -Math.PI / 2 + sign * total * t;
    pts.push({ x: cx + (w / 2) * k * Math.cos(a), y: cy + (h / 2) * k * Math.sin(a) });
  }
  return smoothOpen(pts);
}

/**
 * Rectangle with smoothed corners. Per corner (in the corner's frame: `back` along the incoming edge,
 * `down` along the outgoing edge): the curve starts p = (1+s)·r from the corner, eases in with a cubic,
 * follows a circular arc of (90°·(1−s)), and eases out symmetrically. s = 0 gives an ordinary rounded corner.
 */
function cornerParams(r, s, budget) {
  let smoothing = s;
  let p = (1 + smoothing) * r;
  if (p > budget) { smoothing = Math.max(0, Math.min(smoothing, budget / r - 1)); p = Math.min(p, budget); }
  const arcMeasure = 90 * (1 - smoothing);
  const arcSection = Math.sin((arcMeasure / 2) * DEG) * r * Math.SQRT2;
  const alpha = (90 - arcMeasure) / 2;
  const p3p4 = r * Math.tan((alpha / 2) * DEG);
  const beta = 45 * smoothing;
  const c = p3p4 * Math.cos(beta * DEG);
  const d = c * Math.tan(beta * DEG);
  const b = (p - arcSection - c - d) / 3;
  const a = 2 * b;
  return { a, b, c, d, p, r, arcMeasure };
}

function squircle(s) {
  const { x, y, w, h } = s.box;
  const radii = Array.isArray(s.radius) ? s.radius : [s.radius, s.radius, s.radius, s.radius];
  const budget = Math.min(w, h) / 2;
  // Corners clockwise from top-right: corner point, incoming direction u, outgoing direction v.
  const corners = [
    { at: { x: x + w, y }, u: { x: 1, y: 0 }, v: { x: 0, y: 1 }, r: radii[1] },
    { at: { x: x + w, y: y + h }, u: { x: 0, y: 1 }, v: { x: -1, y: 0 }, r: radii[2] },
    { at: { x, y: y + h }, u: { x: -1, y: 0 }, v: { x: 0, y: -1 }, r: radii[3] },
    { at: { x, y }, u: { x: 0, y: -1 }, v: { x: 1, y: 0 }, r: radii[0] },
  ];
  const segs = [];
  corners.forEach((k, i) => {
    const r = Math.min(Math.max(0, k.r), budget);
    const P = (back, down) => ({ x: k.at.x - k.u.x * back + k.v.x * down, y: k.at.y - k.u.y * back + k.v.y * down });
    if (!(r > 0)) { segs.push(i === 0 ? M(k.at) : L(k.at)); return; }
    const q = cornerParams(r, s.smoothing, budget);
    const start = P(q.p, 0);
    segs.push(i === 0 ? M(start) : L(start));
    const e1 = P(q.p - q.a - q.b - q.c, q.d);
    segs.push(C(P(q.p - q.a, 0), P(q.p - q.a - q.b, 0), e1));
    const e2 = P(q.d, q.p - q.a - q.b - q.c);
    if (q.arcMeasure > 0.01) {
      const center = P(r, r);
      const a0 = Math.atan2(e1.y - center.y, e1.x - center.x);
      let a1 = Math.atan2(e2.y - center.y, e2.x - center.x);
      while (a1 - a0 > Math.PI) a1 -= 2 * Math.PI;
      while (a1 - a0 < -Math.PI) a1 += 2 * Math.PI;
      segs.push(...arcCubics(center.x, center.y, r, r, a0, a1));
    }
    segs.push(C(P(0, q.p - q.a - q.b), P(0, q.p - q.a), P(0, q.p)));
  });
  segs.push(Z());
  return segs;
}

/** Path segments for a normalised spec. */
function shapeSegments(spec) {
  switch (spec.kind) {
    case 'polygon': return polygon(spec);
    case 'star': return star(spec);
    case 'arc': return arc(spec);
    case 'spiral': return spiral(spec);
    case 'rect': return squircle(spec);
    default: throw new Error(`unknown shape ${spec.kind}`);
  }
}

/** Closed shapes get a fill; a spiral is an open line. */
const isClosedShape = (kind) => kind !== 'spiral';

/** Axis-aligned bounds of path segments (anchors and control points). */
function segmentsBox(segments) {
  let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
  for (const s of segments) for (const [kx, ky] of [['x', 'y'], ['cx', 'cy'], ['c1x', 'c1y'], ['c2x', 'c2y']]) {
    if (Number.isFinite(s[kx]) && Number.isFinite(s[ky])) { x0 = Math.min(x0, s[kx]); y0 = Math.min(y0, s[ky]); x1 = Math.max(x1, s[kx]); y1 = Math.max(y1, s[ky]); }
  }
  return x1 < x0 ? null : { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

// ------------------------------------------------------------------ vector networks
//
// A network (type "network") is a graph, not a single chain: any number of edges may meet at a vertex.
//   points:  [{x, y, ctrl?}]  vertices AND curve handles (ctrl: true). Keeping handles in `points` means
//            every existing move / scale / rotate of point-based objects applies to networks unchanged.
//   edges:   [{a, b, c1?, c2?}]  vertex indices; c1/c2 index the handles leaving a / arriving at b.
//   regions: [{path: [[edgeIndex, reversed], ...], fill}]  closed faces of the graph that carry a fill.

function edgeCurve(net, edgeIndex, reversed) {
  const e = net.edges[edgeIndex];
  const P = net.points;
  const a = P[e.a]; const b = P[e.b];
  const c1 = e.c1 !== undefined ? P[e.c1] : null; const c2 = e.c2 !== undefined ? P[e.c2] : null;
  if (!reversed) return { from: a, to: b, c1, c2 };
  return { from: b, to: a, c1: c2, c2: c1 };
}
const curveSeg = (k) => (k.c1 || k.c2 ? C(k.c1 || k.from, k.c2 || k.to, k.to) : L(k.to));

/** Stroke geometry: every edge as its own sub-path. */
function networkEdgeSegments(net) {
  const segs = [];
  net.edges.forEach((e, i) => { const k = edgeCurve(net, i, false); segs.push(M(k.from), curveSeg(k)); });
  return segs;
}

/** A filled region as one closed path following its edges. */
function networkRegionSegments(net, region) {
  const segs = [];
  region.path.forEach(([edgeIndex, reversed], i) => {
    const k = edgeCurve(net, edgeIndex, reversed);
    if (i === 0) segs.push(M(k.from));
    segs.push(curveSeg(k));
  });
  segs.push(Z());
  return segs;
}

function sampleCurve(k, n) {
  const out = [];
  for (let i = 1; i <= n; i += 1) {
    const t = i / n; const u = 1 - t;
    if (k.c1 || k.c2) {
      const p1 = k.c1 || k.from; const p2 = k.c2 || k.to;
      out.push({ x: u * u * u * k.from.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * k.to.x, y: u * u * u * k.from.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * k.to.y });
    } else out.push({ x: k.from.x + (k.to.x - k.from.x) * t, y: k.from.y + (k.to.y - k.from.y) * t });
  }
  return out;
}
const polyArea = (pts) => pts.reduce((s, p, i) => { const q = pts[(i + 1) % pts.length]; return s + p.x * q.y - q.x * p.y; }, 0) / 2;
function pointInPolygon(x, y, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i, i += 1) {
    const a = pts[i]; const b = pts[j];
    if ((a.y > y) !== (b.y > y) && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y || 1e-12) + a.x) inside = !inside;
  }
  return inside;
}

/**
 * Bounded faces of the network (planar half-edge traversal; edges leave a vertex along their tangent).
 * Returns [{path: [[edge, reversed]...], polygon, area}]; the unbounded outer face is dropped.
 */
function networkFaces(net) {
  const half = [];
  net.edges.forEach((e, i) => {
    if (e.a === e.b) return;
    for (const rev of [false, true]) {
      const k = edgeCurve(net, i, rev);
      const dir = k.c1 && (k.c1.x !== k.from.x || k.c1.y !== k.from.y) ? k.c1 : k.to;
      half.push({ edge: i, rev, from: rev ? e.b : e.a, to: rev ? e.a : e.b, angle: Math.atan2(dir.y - k.from.y, dir.x - k.from.x) });
    }
  });
  const around = new Map();
  half.forEach((h, idx) => { if (!around.has(h.from)) around.set(h.from, []); around.get(h.from).push(idx); });
  for (const list of around.values()) list.sort((p, q) => half[p].angle - half[q].angle);
  const twinOf = (idx) => (half[idx].rev ? idx - 1 : idx + 1);
  const used = new Set();
  const faces = [];
  half.forEach((h0, start) => {
    if (used.has(start)) return;
    const path = []; let cur = start; let guard = 0;
    while (!used.has(cur) && guard < half.length + 2) {
      used.add(cur); guard += 1;
      path.push(cur);
      const list = around.get(half[cur].to);
      const pos = list.indexOf(twinOf(cur));
      cur = list[(pos - 1 + list.length) % list.length];
    }
    const polygon = [];
    for (const idx of path) polygon.push(...sampleCurve(edgeCurve(net, half[idx].edge, half[idx].rev), 12));
    faces.push({ path: path.map((idx) => [half[idx].edge, half[idx].rev]), polygon, area: polyArea(polygon) });
  });
  if (!faces.length) return [];
  // The face with the largest |area| is the outside; the bounded faces have the opposite orientation.
  const outerSign = Math.sign(faces.reduce((m, f) => (Math.abs(f.area) > Math.abs(m.area) ? f : m)).area);
  return faces.filter((f) => Math.sign(f.area) !== outerSign && Math.abs(f.area) > 1e-6);
}

/** The smallest bounded face of the network that contains (x, y), or null. */
function networkFaceAt(net, x, y) {
  const hits = networkFaces(net).filter((f) => pointInPolygon(x, y, f.polygon));
  if (!hits.length) return null;
  return hits.reduce((m, f) => (Math.abs(f.area) < Math.abs(m.area) ? f : m));
}

/** Validate a network object's geometry fields (used by document normalisation). */
function normalizeNetwork(input, field) {
  const f = field || 'network';
  assert(Array.isArray(input.points) && input.points.length >= 2, 'INVALID_NETWORK', `${f}.points needs at least two points`);
  const points = input.points.map((p, i) => {
    assert(p && Number.isFinite(Number(p.x)) && Number.isFinite(Number(p.y)), 'INVALID_NETWORK', `${f}.points[${i}] must be {x, y}`);
    const out = { x: Number(p.x), y: Number(p.y) };
    if (p.ctrl) out.ctrl = true;
    return out;
  });
  const idx = (v, label, wantCtrl) => {
    const n = Number(v);
    assert(Number.isInteger(n) && n >= 0 && n < points.length, 'INVALID_NETWORK', `${label} must index ${f}.points`, { received: v });
    assert(Boolean(points[n].ctrl) === wantCtrl, 'INVALID_NETWORK', `${label} must point to a ${wantCtrl ? 'handle (ctrl)' : 'vertex'}`);
    return n;
  };
  assert(Array.isArray(input.edges) && input.edges.length >= 1 && input.edges.length <= 5000, 'INVALID_NETWORK', `${f}.edges needs 1 to 5000 edges`);
  const edges = input.edges.map((e, i) => {
    const out = { a: idx(e.a, `${f}.edges[${i}].a`, false), b: idx(e.b, `${f}.edges[${i}].b`, false) };
    assert(out.a !== out.b, 'INVALID_NETWORK', `${f}.edges[${i}] joins a vertex to itself`);
    if (e.c1 !== undefined && e.c1 !== null) out.c1 = idx(e.c1, `${f}.edges[${i}].c1`, true);
    if (e.c2 !== undefined && e.c2 !== null) out.c2 = idx(e.c2, `${f}.edges[${i}].c2`, true);
    return out;
  });
  const regions = (input.regions || []).map((r, i) => {
    assert(r && Array.isArray(r.path) && r.path.length >= 2, 'INVALID_NETWORK', `${f}.regions[${i}].path needs at least two [edge, reversed] steps`);
    const path = r.path.map((step, k) => {
      const n = Number(step[0]);
      assert(Number.isInteger(n) && n >= 0 && n < edges.length, 'INVALID_NETWORK', `${f}.regions[${i}].path[${k}] must index an edge`);
      return [n, Boolean(step[1])];
    });
    for (let k = 0; k < path.length; k += 1) {
      const end = path[k][1] ? edges[path[k][0]].a : edges[path[k][0]].b;
      const next = path[(k + 1) % path.length];
      const start = next[1] ? edges[next[0]].b : edges[next[0]].a;
      assert(end === start, 'INVALID_NETWORK', `${f}.regions[${i}] is not a closed chain of edges`);
    }
    return { path, fill: r.fill };
  });
  return { points, edges, regions };
}

module.exports = { KINDS, normalizeShapeSpec, shapeSegments, isClosedShape, segmentsBox, arcCubics,
  normalizeNetwork, networkEdgeSegments, networkRegionSegments, networkFaces, networkFaceAt, edgeCurve };
