'use strict';

/**
 * Ornament-flow engine: plans a decorative composition as STRUCTURE first, then renders it as a one-hue value
 * study or in colour from the same geometry.
 *
 * Why it exists: a hand-drawn ornamental bloom tends to become a fan. Every petal leaves one point and ends in the
 * same bend. Ornamental references are built differently:
 *   1. an eye path (a zig-zag spine) carries the eye across the canvas; masses sit on it, not around one point;
 *   2. a curve vocabulary: C, S, J (hook) and near-straight centrelines, broad plumes, slim blades, paisley
 *      commas, spiral wave curls, tendrils with beads and branching sprays;
 *   3. a weight hierarchy: few heavy masses, more medium shapes, many small ones that branch off their parents;
 *   4. a detail-density field: dots, veins and inner bands gather at the focal point and one secondary accent,
 *      while other zones stay calm;
 *   5. readable overlaps: each shape takes the value that best separates it from the shapes it covers, or gets a rim.
 *
 * reviewOrnament() measures those five properties on the plan's geometry (no pixels needed), so the same gates
 * judge the value study and the colour pass. planRadialFan() builds the naive "fan" for comparison and tests.
 */

const { oklchToHex } = require('./swatches');

const TAU = Math.PI * 2;
const r2 = (v) => Math.round(v * 100) / 100;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const wrap = (a) => { let x = a; while (x > Math.PI) x -= TAU; while (x < -Math.PI) x += TAU; return x; };

function rng(seed) {
  let a = (Number(seed) >>> 0) || 1;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return { next, rand: (lo, hi) => lo + (hi - lo) * next(), pick: (list) => list[Math.floor(next() * list.length) % list.length] };
}

// ────────────────────────────────────────────────────────────────── spine (eye path)
function catmull(points, per) {
  const out = [];
  const at = (i) => points[clamp(i, 0, points.length - 1)];
  for (let i = 0; i < points.length - 1; i += 1) {
    const p0 = at(i - 1); const p1 = at(i); const p2 = at(i + 1); const p3 = at(i + 2);
    for (let k = 0; k < per; k += 1) {
      const t = k / per; const t2 = t * t; const t3 = t2 * t;
      out.push({
        x: 0.5 * (2 * p1.x + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
        y: 0.5 * (2 * p1.y + (-p0.y + p2.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3),
      });
    }
  }
  out.push(points[points.length - 1]);
  return out;
}

function makeSpine(control, W, H) {
  const ctrl = control.map(([x, y]) => ({ x: x * W, y: y * H }));
  const pts = catmull(ctrl, 40);
  let L = 0;
  pts.forEach((p, i) => { if (i) L += Math.hypot(p.x - pts[i - 1].x, p.y - pts[i - 1].y); p.s = L; });
  pts.forEach((p) => { p.t = p.s / L; });
  const at = (t) => {
    const tt = clamp(t, 0, 1);
    let i = 1;
    while (i < pts.length - 1 && pts[i].t < tt) i += 1;
    const a = pts[i - 1]; const b = pts[i];
    const f = b.t > a.t ? (tt - a.t) / (b.t - a.t) : 0;
    return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, angle: Math.atan2(b.y - a.y, b.x - a.x), t: tt };
  };
  const nearest = (p) => {
    let best = null;
    for (let i = 0; i < pts.length; i += 2) {
      const d = Math.hypot(pts[i].x - p.x, pts[i].y - p.y);
      if (!best || d < best.d) best = { d, t: pts[i].t };
    }
    return Object.assign(at(best.t), { d: best.d });
  };
  return { control: ctrl, pts, length: L, at, nearest };
}

// ────────────────────────────────────────────────────────────────── curve vocabulary
/** Heading θ(s) = θ0 + A·s + B·s² + C·s³, s∈[0,1]. The curvature profile defines the family. */
const FAMILIES = {
  C: (b) => ({ A: b, B: 0, C: 0 }),
  S: (b) => ({ A: 2 * b, B: -2.6 * b, C: 0 }),
  J: (b) => ({ A: 0.25 * b, B: 0, C: 1.4 * b }),
  straight: (b) => ({ A: 0.2 * Math.sign(b || 1), B: 0, C: 0 }),
};

function centerline(base, theta0, len, family, bend, n) {
  const steps = n || 24;
  const k = FAMILIES[family](bend);
  const pts = [{ x: base.x, y: base.y }];
  let x = base.x; let y = base.y;
  for (let i = 0; i < steps; i += 1) {
    const s = (i + 0.5) / steps;
    const th = theta0 + k.A * s + k.B * s * s + k.C * s * s * s;
    x += Math.cos(th) * (len / steps); y += Math.sin(th) * (len / steps);
    pts.push({ x, y });
  }
  return pts;
}

/** Width profiles (0..1 along the centreline → 0..1 of the maximum width). */
const PROFILES = {
  plume: (t) => Math.pow(Math.sin(Math.PI * Math.pow(t, 0.75)), 0.85),
  blade: (t) => Math.sin(Math.PI * t) * (1 - 0.35 * t),
  comma: (t) => (t < 0.28 ? Math.sqrt(Math.max(0, 1 - Math.pow((0.28 - t) / 0.28, 2))) : Math.pow((1 - t) / 0.72, 1.35)),
  curl: (t) => (t < 0.08 ? 0.6 + 5 * t : 1) * Math.pow(1 - 0.85 * t, 1.1),
  tendril: (t) => 1 - 0.85 * t,
  petal: (t) => Math.pow(Math.sin(Math.PI * t), 0.7),
  bud: (t) => Math.pow(Math.sin(Math.PI * t), 0.6) * (1 - 0.25 * t),
};

function outline(center, profile, maxW, asym, scallop) {
  const left = []; const right = [];
  const n = center.length;
  for (let i = 0; i < n; i += 1) {
    const a = center[Math.max(0, i - 1)]; const b = center[Math.min(n - 1, i + 1)];
    const dx = b.x - a.x; const dy = b.y - a.y; const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len; const ny = dx / len;
    const t = i / (n - 1);
    const w = maxW * PROFILES[profile](t);
    let wl = w * (1 + (asym || 0)); let wr = w * (1 - (asym || 0)) * 0.9;
    if (scallop && t > 0.12 && t < 0.94) {
      const k = 1 + scallop.amp * Math.abs(Math.sin(scallop.n * Math.PI * t));
      if (scallop.side === 'right') wr *= k; else wl *= k;
    }
    left.push({ x: center[i].x + nx * wl, y: center[i].y + ny * wl });
    right.unshift({ x: center[i].x - nx * wr, y: center[i].y - ny * wr });
  }
  return left.concat(right);
}

// ────────────────────────────────────────────────────────────────── polygon helpers
function area(poly) {
  let s = 0;
  for (let i = 0; i < poly.length; i += 1) { const a = poly[i]; const b = poly[(i + 1) % poly.length]; s += a.x * b.y - b.x * a.y; }
  return Math.abs(s) / 2;
}
function centroid(poly) {
  const c = poly.reduce((acc, p) => ({ x: acc.x + p.x, y: acc.y + p.y }), { x: 0, y: 0 });
  return { x: c.x / poly.length, y: c.y / poly.length };
}
function bbox(poly) {
  let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
  for (const p of poly) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
  return { x0, y0, x1, y1 };
}
function inside(p, poly) {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i, i += 1) {
    const a = poly[i]; const b = poly[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) c = !c;
  }
  return c;
}
function overlaps(A, B) {
  const a = A.box; const b = B.box;
  if (a.x1 < b.x0 || b.x1 < a.x0 || a.y1 < b.y0 || b.y1 < a.y0) return false;
  const step = (poly) => Math.max(1, Math.floor(poly.length / 14));
  for (let i = 0; i < A.poly.length; i += step(A.poly)) if (inside(A.poly[i], B.poly)) return true;
  for (let i = 0; i < B.poly.length; i += step(B.poly)) if (inside(B.poly[i], A.poly)) return true;
  return inside(A.center ? A.center[Math.floor(A.center.length / 2)] : centroid(A.poly), B.poly);
}
function circle(cx, cy, r, n) {
  const pts = [];
  const k = n || 14;
  for (let i = 0; i < k; i += 1) { const a = (i / k) * TAU; pts.push({ x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r }); }
  return pts;
}

// ────────────────────────────────────────────────────────────────── plan model
const LEAFY = new Set(['plume', 'blade', 'comma', 'petal']);
const MASSIVE = new Set(['plume', 'blade', 'comma', 'petal', 'curl', 'bud', 'body']);

class Plan {
  constructor(W, H, seed, subject) {
    this.W = W; this.H = H; this.u = Math.min(W, H); this.seed = seed; this.subject = subject;
    this.R = rng(seed);
    this.elements = [];
    this.z = 0;
  }

  finish(el) {
    el.id = `orn${this.elements.length}`;
    el.z = this.z += 1;
    el.box = bbox(el.poly);
    el.area = area(el.poly);
    el.centroid = centroid(el.poly);
    this.elements.push(el);
    return el;
  }

  /** Leafy or banded shape built from a centreline family and a width profile. */
  shape(kind, o) {
    // Shapes stay inside the canvas (a margin of 2% of the short side) unless they are meant to bleed (waves).
    let len = o.len;
    let center = centerline(o.base, o.theta, len, o.family, o.bend, o.steps || 24);
    const m = this.u * 0.02;
    const out = (pts) => pts.some((q) => q.x < m || q.y < m || q.x > this.W - m || q.y > this.H - m);
    for (let k = 0; k < 6 && o.fit !== false && out(center); k += 1) { len *= 0.85; center = centerline(o.base, o.theta, len, o.family, o.bend, o.steps || 24); }
    // "outer" = the convex side: for a positive (clockwise) bend that is the right-hand offset.
    const scallop = o.scallop ? Object.assign({}, o.scallop, { side: o.scallop.side === 'outer' ? (o.bend > 0 ? 'right' : 'left') : o.scallop.side }) : null;
    const poly = outline(center, o.profile || kind, o.width, o.asym || 0, scallop);
    return this.finish({ kind, role: o.role, group: o.group, hue: o.hue, family: o.family, bend: o.bend, base: { x: o.base.x, y: o.base.y }, theta: o.theta, len, width: o.width, center, poly, parent: o.parent || null, t: o.t, valueHint: o.value, edgeDots: o.edgeDots || false });
  }

  dot(x, y, r, o) {
    return this.finish({ kind: 'dot', role: 'detail', group: o.group, hue: o.hue, poly: circle(x, y, r, 10), r, parent: o.parent || null, dotOf: o.dotOf || 'detail' });
  }

  vein(parent, from, to) {
    const c = parent.center;
    const a = Math.floor(from * (c.length - 1)); const b = Math.floor(to * (c.length - 1));
    const line = c.slice(a, b + 1);
    return this.finish({ kind: 'vein', role: 'detail', group: parent.group, hue: parent.hue, center: line, poly: line.concat(line.slice().reverse()), parent: parent.id, strokeWidth: Math.max(1, parent.width * 0.06) });
  }

  band(parent) {
    const poly = outline(parent.center.slice(2, parent.center.length - 3), parent.kind === 'curl' ? 'curl' : (PROFILES[parent.kind] ? parent.kind : 'plume'), parent.width * 0.5, 0, null);
    return this.finish({ kind: 'band', role: 'detail', group: parent.group, hue: parent.hue, poly, parent: parent.id });
  }

  tendril(base, theta, len, bend, o) {
    const fam = o.family || 'J';
    const center = centerline(base, theta, len, fam, bend, 28);
    const poly = outline(center, 'tendril', Math.max(1.2, this.u * 0.0032), 0, null);
    const el = this.finish({ kind: 'tendril', role: 'small', group: o.group, hue: o.hue, family: fam, bend, base, theta, len, width: this.u * 0.003, center, poly, parent: o.parent || null });
    const tip = center[center.length - 1];
    this.dot(tip.x, tip.y, this.u * this.R.rand(0.006, 0.012), { group: o.group, hue: o.beadHue || o.hue, parent: el.id, dotOf: 'bead' });
    return el;
  }

  spray(base, theta, len, branches, o) {
    const stem = this.tendril(base, theta, len, this.R.rand(-0.6, 0.6), { group: o.group, hue: o.hue, family: 'C', beadHue: o.beadHue });
    for (let i = 0; i < branches; i += 1) {
      const at = stem.center[Math.floor(stem.center.length * (0.35 + 0.55 * (i / Math.max(1, branches))))];
      const side = i % 2 ? 1 : -1;
      const b = this.tendril(at, theta + side * this.R.rand(0.5, 1.0), len * this.R.rand(0.25, 0.45), side * this.R.rand(0.3, 1.2), { group: o.group, hue: o.hue, family: 'C', parent: stem.id, beadHue: o.beadHue });
      b.role = 'detail'; b.sprayBranch = true;
    }
    stem.role = 'detail'; stem.spray = true;
    return stem;
  }

  cloudBand(y, x0, x1, r, o) {
    const pts = [];
    const n = Math.max(3, Math.round((x1 - x0) / (r * 1.4)));
    for (let i = 0; i <= n; i += 1) {
      const cx = x0 + ((x1 - x0) * i) / n; const rr = r * (0.75 + 0.5 * this.R.next());
      for (let k = 0; k <= 6; k += 1) { const a = Math.PI + (k / 6) * Math.PI; pts.push({ x: cx + Math.cos(a) * rr, y: y + Math.sin(a) * rr * 0.8 }); }
    }
    pts.push({ x: x1 + r, y: y + r * 1.6 }, { x: x0 - r, y: y + r * 1.6 });
    return this.finish({ kind: 'cloud', role: 'ground', group: 'ground', hue: o.hue, poly: pts, groundValue: o.value });
  }

  /** Two staggered scalloped rows: calm, large forms that keep a corner quiet without leaving it blank. */
  cloudRows(y, x0, x1, r, hue) {
    this.cloudBand(y, x0, x1, r * 1.25, { hue, value: 0.9 });
    this.cloudBand(y + r * 0.9, x0 + r, x1 - r, r, { hue, value: 0.94 });
  }

  halo(cx, cy, r) {
    this.finish({ kind: 'cloud', role: 'ground', group: 'ground', hue: 'halo', poly: circle(cx, cy, r, 48), groundValue: 0.96 });
  }
}

/** Detail-density field: one strong focal zone and one secondary accent; everything else is calm. */
function densityField(focal, accent, u) {
  return (p) => Math.max(Math.exp(-((p.x - focal.x) ** 2 + (p.y - focal.y) ** 2) / (2 * (0.2 * u) ** 2)), 0.75 * Math.exp(-((p.x - accent.x) ** 2 + (p.y - accent.y) ** 2) / (2 * (0.13 * u) ** 2)));
}

// ────────────────────────────────────────────────────────────────── subjects
const WARM_RAMP = ['crimson', 'pink', 'magenta', 'orange', 'purple', 'pink', 'gold', 'crimson', 'purple'];
const balancedFamilies = (R, n, mix) => {
  const pool = [];
  for (let i = 0; i < n; i += 1) pool.push(mix[i % mix.length]);
  for (let i = pool.length - 1; i > 0; i -= 1) { const j = Math.floor(R.next() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
  return pool;
};

function children(plan, parent, count, group, hueFor) {
  const R = plan.R;
  for (let c = 0; c < count; c += 1) {
    const at = parent.center[Math.floor(parent.center.length * R.rand(0.3, 0.75))];
    const a = parent.center[Math.max(0, parent.center.indexOf(at) - 1)];
    const tangent = Math.atan2(at.y - a.y, at.x - a.x);
    const side = c % 2 ? 1 : -1;
    plan.shape(R.pick(['blade', 'comma', 'blade', 'plume']), {
      base: at, theta: tangent + side * R.rand(0.45, 1.05), len: parent.len * R.rand(0.28, 0.5), width: parent.width * R.rand(0.35, 0.55),
      family: R.pick(['C', 'S', 'J', 'C']), bend: side * R.rand(0.6, 1.4), asym: R.rand(-0.3, 0.3), role: 'small', group, hue: hueFor(c), parent: parent.id,
    });
  }
}

function addDetails(plan, density) {
  const R = plan.R;
  for (const el of plan.elements.slice()) {
    if (!['plume', 'comma', 'curl', 'body'].includes(el.kind) || !['heavy', 'medium'].includes(el.role)) continue;
    const d = density(el.centroid);
    if (el.kind === 'curl') {
      // Foam caps ride the outer edge of every wave (structure), their count follows the density.
      const half = Math.floor(el.poly.length / 2);
      const edge = el.bend > 0 ? el.poly.slice(half).reverse() : el.poly.slice(0, half);
      const n = Math.round(5 + 9 * d);
      for (let i = 0; i < n; i += 1) { const p = edge[Math.floor(((i + 0.5) / n) * edge.length * 0.85)]; plan.dot(p.x, p.y, plan.u * R.rand(0.008, 0.016), { group: el.group, hue: 'foam', parent: el.id, dotOf: 'foam' }); }
      if (d > 0.2) for (let k = 0; k < 2; k += 1) plan.vein(el, 0.08 + 0.1 * k, 0.75 - 0.1 * k);
      continue;
    }
    if (d < 0.22) continue; // calm zone: the shape stays a quiet silhouette
    plan.band(el);
    plan.vein(el, 0.12, 0.88);
    const dots = Math.round(4 + 10 * d);
    for (let i = 0; i < dots; i += 1) {
      const t = 0.18 + 0.7 * (i / dots);
      const p = el.center[Math.floor(t * (el.center.length - 1))];
      const q = el.center[Math.min(el.center.length - 1, Math.floor(t * (el.center.length - 1)) + 1)];
      const nx = -(q.y - p.y); const ny = q.x - p.x; const nl = Math.hypot(nx, ny) || 1;
      const off = el.width * 0.55 * PROFILES[el.kind === 'body' ? 'comma' : el.kind](t);
      plan.dot(p.x + (nx / nl) * off, p.y + (ny / nl) * off, Math.max(1.2, el.width * 0.09 * (1 - 0.6 * t)), { group: el.group, hue: el.hue, parent: el.id });
    }
  }
}

/** Wave crest: a solid curl bleeding off the canvas edge, lighter stripes riding inside it, foam on its outer edge. */
function waveCrest(plan, o) {
  const crest = plan.shape('curl', { base: o.base, theta: o.theta, len: o.len, width: o.width, family: 'J', bend: o.bend, role: o.role, group: 'wave', hue: o.hue, steps: 34, fit: false, scallop: { amp: 0.1, n: 9, side: 'outer' } });
  const sg = Math.sign(o.bend);
  [[0.32, 0.92, 0.88], [-0.38, 0.86, 0.72], [0.62, 0.8, 0.95]].slice(0, o.stripes || 3).forEach(([k, lf, v]) => {
    const nx = -Math.sin(o.theta) * sg; const ny = Math.cos(o.theta) * sg;
    plan.shape('curl', { base: { x: o.base.x + nx * o.width * k, y: o.base.y + ny * o.width * k }, theta: o.theta, len: o.len * lf, width: o.width * 0.16, family: 'J', bend: o.bend * (1 + 0.15 * Math.abs(k)), role: 'small', group: 'wave', hue: k < 0 ? 'teal' : 'foam', steps: 30, fit: false, value: v, parent: crest.id });
  });
  return crest;
}

function planBloom(plan, opts) {
  const { W, H, u, R } = plan;
  const spine = makeSpine([[0.06, 0.86], [0.2, 0.32], [0.47, 0.44], [0.68, 0.7], [0.95, 0.5]], W, H);
  const fT = spine.nearest({ x: 0.47 * W, y: 0.44 * H }).t;
  const focal = spine.at(fT); const accent = spine.at(0.86);
  plan.spine = spine; plan.focal = focal; plan.accent = accent;
  const density = densityField(focal, accent, u);
  plan.density = density;

  // Ground: scalloped cloud rows in the calm corners (large, low-contrast forms only).
  plan.cloudRows(H * 0.12, W * 0.6, W * 1.04, u * 0.045, 'cloud');
  plan.cloudRows(H * 1.0, -W * 0.04, W * 0.42, u * 0.05, 'cloud');

  // Wave counter-mass at the start of the eye path: a tall crest that curls toward the bloom, two echoes.
  if (opts.waves !== false) {
    waveCrest(plan, { base: { x: W * 0.1, y: H + u * 0.02 }, theta: -Math.PI / 2 + 0.12, len: u * 0.78, bend: 3.3, width: u * 0.075, role: 'heavy', hue: 'blue' });
    waveCrest(plan, { base: { x: W * 0.27, y: H + u * 0.04 }, theta: -Math.PI / 2 + 0.2, len: u * 0.42, bend: 3.0, width: u * 0.045, role: 'medium', hue: 'teal', stripes: 2 });
    waveCrest(plan, { base: { x: W * 0.84, y: H + u * 0.03 }, theta: -Math.PI / 2 - 0.2, len: u * 0.34, bend: -3.0, width: u * 0.042, role: 'medium', hue: 'lilac', stripes: 2 });
  }

  // Heavy plumes: four masses, each with its own origin, family and side — one rises, one runs against the flow.
  const at = (t, off) => { const s = spine.at(t); return { x: s.x - Math.sin(s.angle) * off * u, y: s.y + Math.cos(s.angle) * off * u, angle: s.angle }; };
  const heavyEls = [
    Object.assign(at(fT + 0.04, 0.03), { dTheta: 0.1, len: 0.5, w: 0.09, family: 'S', bend: 0.7, hue: 'crimson' }),
    Object.assign(at(fT + 0.18, -0.05), { dTheta: 0.45, len: 0.48, w: 0.08, family: 'C', bend: -0.75, hue: 'orange' }),
    { x: focal.x - u * 0.03, y: focal.y - u * 0.02, abs: -Math.PI / 2 + 0.35, len: 0.42, w: 0.1, family: 'J', bend: -1.1, hue: 'pink' },
    { x: focal.x - u * 0.06, y: focal.y + u * 0.01, abs: Math.PI + 0.35, len: 0.38, w: 0.075, family: 'S', bend: 0.8, hue: 'lilac' },
  ].map((h) => plan.shape('plume', { base: { x: h.x, y: h.y }, theta: (h.abs !== undefined ? h.abs : h.angle + h.dTheta) + R.rand(-0.08, 0.08), len: u * h.len, width: u * h.w, family: h.family, bend: h.bend, asym: 0.35, role: 'heavy', group: 'plume', hue: h.hue, scallop: { amp: 0.16, n: 6 } }));

  // Medium shapes: origins spread along the spine on alternating sides; four counter-curves, two risers.
  const fams = balancedFamilies(R, 16, ['C', 'S', 'J', 'C', 'S', 'straight', 'J', 'S']);
  const mediums = [];
  for (let i = 0; i < 16; i += 1) {
    const kind = i < 4 ? 'counter' : i < 6 ? 'riser' : 'flow';
    const t = kind === 'counter' ? fT - 0.14 + 0.06 * i : kind === 'riser' ? fT + 0.02 * (i - 4) : fT - 0.02 + (0.9 - fT) * ((i - 6) / 9);
    const side = i % 2 ? 1 : -1;
    const b = at(t + R.rand(-0.015, 0.015), R.rand(0.02, 0.07) * side);
    const theta = kind === 'counter' ? b.angle + Math.PI + side * R.rand(0.2, 0.55) : kind === 'riser' ? -Math.PI / 4 + (i - 4) * 0.35 + R.rand(-0.1, 0.1) : b.angle + side * R.rand(0.25, 0.85);
    const fam = fams[i];
    mediums.push(plan.shape(R.pick(['plume', 'comma', 'plume', 'blade']), {
      base: b, theta, len: u * R.rand(0.18, 0.34), width: u * R.rand(0.04, 0.065), family: fam, bend: (fam === 'straight' ? 0.2 : R.rand(0.6, 1.5)) * (R.next() < 0.5 ? -1 : 1),
      asym: R.rand(-0.35, 0.35), role: 'medium', group: 'plume', hue: kind === 'counter' ? R.pick(['lilac', 'teal', 'purple', 'pink']) : WARM_RAMP[(i + 2) % WARM_RAMP.length],
      scallop: R.next() < 0.45 ? { amp: 0.14, n: 5 } : null,
    }));
  }

  // Small shapes branch off their parents (threads and leaves); green is a rare accent.
  heavyEls.concat(mediums).forEach((p, i) => children(plan, p, p.role === 'heavy' ? 3 : 1 + (i % 2), 'plume', (c) => ((i + c) % 7 === 3 ? 'green' : WARM_RAMP[(i + c + 4) % WARM_RAMP.length])));

  // Tendrils: curls with beads from plume tips and from the path, opposite bends.
  heavyEls.concat(mediums.slice(0, 8)).forEach((p, i) => {
    const tip = p.center[p.center.length - 1]; const prev = p.center[p.center.length - 2];
    plan.tendril(tip, Math.atan2(tip.y - prev.y, tip.x - prev.x), u * R.rand(0.08, 0.16), (i % 2 ? 1 : -1) * R.rand(2.4, 4.4), { group: 'plume', hue: i % 2 ? 'purple' : 'crimson', beadHue: 'orange', parent: p.id });
  });
  for (let i = 0; i < 4; i += 1) {
    const s = spine.at(0.25 + 0.12 * i);
    plan.tendril({ x: s.x, y: s.y }, s.angle + Math.PI + (i - 1) * 0.6, u * R.rand(0.1, 0.18), (i % 2 ? -1 : 1) * R.rand(2.6, 4), { group: 'plume', hue: 'orange', beadHue: 'orange' });
  }
  plan.spray({ x: accent.x, y: accent.y }, accent.angle - 0.9, u * 0.15, 5, { group: 'plume', hue: 'orange', beadHue: 'teal' });
  plan.spray({ x: accent.x - u * 0.04, y: accent.y + u * 0.03 }, accent.angle + 0.4, u * 0.12, 3, { group: 'plume', hue: 'purple', beadHue: 'pink' });
  addDetails(plan, density);

  // Bloom last (on top): a lotus cup of unequal petals around a light gold bud, stamen sprays above.
  [[-1.25, 0.1], [-0.7, 0.13], [-0.15, 0.12], [0.45, 0.13], [1.05, 0.1]].forEach(([a, l], i) => plan.shape('petal', { base: { x: focal.x, y: focal.y + u * 0.045 }, theta: -Math.PI / 2 + a, len: u * l, width: u * 0.042, family: 'C', bend: -a * 0.7, role: 'small', group: 'bloom', hue: i % 2 ? 'gold' : 'orange' }));
  plan.shape('bud', { base: { x: focal.x, y: focal.y + u * 0.05 }, theta: -Math.PI / 2, len: u * 0.12, width: u * 0.055, family: 'C', bend: 0.05, role: 'focal', group: 'bloom', hue: 'gold' });
  for (let i = 0; i < 3; i += 1) plan.spray({ x: focal.x + u * 0.01 * (i - 1), y: focal.y - u * 0.06 }, -Math.PI / 2 + (i - 1) * 0.55, u * R.rand(0.1, 0.15), 4, { group: 'bloom', hue: 'gold', beadHue: 'teal' });
}

function planPhoenix(plan) {
  const { W, H, u, R } = plan;
  const P = (x, y) => ({ x: x * W, y: y * H });
  const spine = makeSpine([[0.6, 0.14], [0.42, 0.3], [0.46, 0.46], [0.52, 0.6], [0.3, 0.78], [0.32, 0.92], [0.62, 0.95]], W, H);
  const head = P(0.6, 0.15); const chest = P(0.45, 0.4); const root = P(0.5, 0.58);
  const focal = head; const accent = spine.at(0.88);
  plan.spine = spine; plan.focal = focal; plan.accent = accent;
  const density = densityField(focal, accent, u);
  plan.density = density;
  plan.halo(head.x + u * 0.05, head.y + u * 0.05, u * 0.2);
  plan.cloudRows(H * 0.99, -W * 0.04, W * 0.7, u * 0.06, 'cloud');
  plan.cloudRows(H * 0.52, W * 0.0, W * 0.24, u * 0.04, 'cloud');
  const dir = (a, b) => Math.atan2(b.y - a.y, b.x - a.x);
  const dist = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);
  const tipTendril = (p, i) => {
    const tip = p.center[p.center.length - 1]; const prev = p.center[p.center.length - 2];
    plan.tendril(tip, Math.atan2(tip.y - prev.y, tip.x - prev.x), u * R.rand(0.07, 0.13), (i % 2 ? 1 : -1) * R.rand(2.4, 4.2), { group: p.group, hue: 'crimson', beadHue: 'orange', parent: p.id });
  };

  // 1. Raised wing (furthest back): feathers rooted at different points along the shoulder, opening up-right.
  const wing = [[0.05, -0.95, 0.44, 0.07, 'S', 0.6, 'pink', 'heavy'], [0.25, -0.68, 0.4, 0.065, 'C', -0.8, 'magenta', 'heavy'], [0.45, -0.42, 0.34, 0.055, 'J', 1.2, 'purple', 'medium'], [0.65, -0.15, 0.27, 0.045, 'S', -0.7, 'crimson', 'medium']]
    .map(([f, th, l, w, fam, b, hue, role]) => plan.shape('plume', { base: { x: chest.x + (root.x - chest.x) * f + u * 0.07, y: chest.y + (root.y - chest.y) * f - u * 0.01 }, theta: th + R.rand(-0.06, 0.06), len: u * l, width: u * w, family: fam, bend: b, asym: 0.3, role, group: 'wing', hue, scallop: { amp: 0.16, n: 6 } }));
  wing.forEach((p, i) => children(plan, p, p.role === 'heavy' ? 2 : 1, 'wing', (c) => ['gold', 'pink', 'orange', 'purple', 'teal'][(i + c) % 5]));
  wing.forEach(tipTendril);

  // 2. Tail: seven long plumes from a spread root, sweeping down-left and hooking right with mixed families.
  const fams = balancedFamilies(R, 7, ['J', 'S', 'C', 'J', 'S', 'C', 'J']);
  const tail = [];
  for (let i = 0; i < 7; i += 1) {
    const f = fams[i];
    tail.push(plan.shape(i % 3 === 1 ? 'blade' : 'plume', {
      base: { x: root.x - u * 0.012 * i, y: root.y + u * 0.01 * i }, theta: 2.35 + 0.09 * i + R.rand(-0.05, 0.05), len: u * R.rand(0.4, 0.58), width: u * R.rand(0.035, 0.065), family: f,
      bend: f === 'J' ? -R.rand(1.2, 1.8) : f === 'S' ? -R.rand(0.6, 1.0) : -R.rand(0.5, 0.9), asym: R.rand(-0.3, 0.3), role: i < 2 ? 'heavy' : 'medium', group: 'tail', hue: ['purple', 'blue', 'orange', 'magenta', 'teal', 'pink', 'lilac'][i],
      scallop: i % 2 ? null : { amp: 0.12, n: 7 },
    }));
  }
  tail.forEach((p, i) => children(plan, p, p.role === 'heavy' ? 2 : 1, 'tail', (c) => ['gold', 'pink', 'orange', 'purple', 'teal'][(i + c + 2) % 5]));
  tail.forEach((p) => {
    for (let k = 0; k < 4; k += 1) { const q = p.center[Math.floor(p.center.length * (0.76 + 0.05 * k))]; plan.dot(q.x, q.y, Math.max(1.2, p.width * 0.2), { group: 'tail', hue: 'cream', parent: p.id }); }
  });
  tail.slice(0, 5).forEach(tipTendril);
  plan.spray({ x: accent.x, y: accent.y - u * 0.02 }, -0.4, u * 0.12, 4, { group: 'tail', hue: 'orange', beadHue: 'teal' });

  // 3. Body (round chest), then neck and head on top: the silhouette the eye reads first.
  const body = plan.shape('comma', { base: chest, theta: dir(chest, root), len: dist(chest, root) * 1.1, width: u * 0.11, family: 'S', bend: 0.35, asym: 0.15, role: 'heavy', group: 'body', hue: 'orange' });
  body.kind = 'body';
  plan.shape('comma', { base: head, theta: dir(head, chest) + 0.15, len: dist(head, chest) * 1.08, width: u * 0.062, family: 'S', bend: -0.6, role: 'heavy', group: 'body', hue: 'crimson' });
  // 4. Crest (behind the beak, in front of the halo): unequal shapes, mixed families, and a spray.
  [[-1.9, 0.12, 'J', 1.5, 'comma', 'magenta'], [-1.4, 0.18, 'S', -0.9, 'plume', 'gold'], [-0.9, 0.22, 'C', 0.9, 'plume', 'purple'], [-0.45, 0.15, 'J', -1.4, 'comma', 'teal']]
    .forEach(([th, l, fam, b, kind, hue], i) => plan.shape(kind, { base: { x: head.x + u * 0.03, y: head.y - u * 0.015 }, theta: th, len: u * l, width: u * (0.025 + 0.006 * i), family: fam, bend: b, role: 'medium', group: 'crest', hue }));
  plan.spray({ x: head.x + u * 0.04, y: head.y - u * 0.03 }, -0.7, u * 0.15, 5, { group: 'crest', hue: 'teal', beadHue: 'teal' });
  addDetails(plan, density);
  plan.shape('blade', { base: { x: head.x - u * 0.03, y: head.y + u * 0.006 }, theta: Math.PI - 0.25, len: u * 0.085, width: u * 0.022, family: 'C', bend: -0.4, role: 'small', group: 'body', hue: 'gold' });
  plan.dot(head.x - u * 0.004, head.y - u * 0.01, u * 0.009, { group: 'body', hue: 'eye', dotOf: 'eye' });
}

// ────────────────────────────────────────────────────────────────── values (one-hue study) and colours
const ROLE_VALUES = {
  heavy: [0.42, 0.32, 0.54, 0.66, 0.26],
  medium: [0.6, 0.48, 0.72, 0.38, 0.82],
  small: [0.74, 0.56, 0.86, 0.44, 0.32],
  focal: [0.9, 0.82],
};
/** Lowest value a hue keeps its identity at: dark yellow is olive, dark orange is brown. */
const VALUE_FLOOR = { gold: 0.7, orange: 0.62, cream: 0.82, green: 0.5, teal: 0.42, pink: 0.55, lilac: 0.55, foam: 0.85 };

/** Back to front: each shape takes the value that best separates it from what it covers; else it gets a rim. */
function assignValues(plan) {
  const placed = [];
  for (const el of plan.elements) {
    if (el.role === 'ground') { el.value = el.groundValue || 0.89; continue; }
    if (el.role === 'detail') {
      const parent = plan.elements.find((p) => p.id === el.parent);
      const base = parent && Number.isFinite(parent.value) ? parent.value : 0.5;
      el.value = el.dotOf === 'foam' ? 0.96 : el.dotOf === 'eye' ? 0.12 : el.kind === 'band' ? clamp(base + (base < 0.6 ? 0.2 : -0.18), 0.1, 0.95) : clamp(base + (base < 0.55 ? 0.3 : -0.3), 0.08, 0.96);
      if (el.dotOf !== 'eye') el.value = Math.max(el.value, VALUE_FLOOR[el.hue] || 0);
      continue;
    }
    const under = placed.filter((p) => overlaps(el, p));
    const floor = VALUE_FLOOR[el.hue] || 0.2;
    let cands = Number.isFinite(el.valueHint) ? [el.valueHint] : (ROLE_VALUES[el.role] || ROLE_VALUES.small).filter((v) => v >= floor);
    if (!cands.length) cands = [Math.min(0.92, floor + 0.08), Math.min(0.95, floor + 0.2)];
    let best = cands[0]; let bestScore = -Infinity;
    cands.forEach((v, i) => {
      const sep = under.length ? Math.min(...under.map((p) => Math.abs(p.value - v))) : 0.5;
      const score = Math.min(sep, 0.3) - i * 0.015;
      if (score > bestScore) { bestScore = score; best = v; }
    });
    el.value = best;
    el.under = under.map((p) => p.id);
    el.rim = under.length > 0 && Math.min(...under.map((p) => Math.abs(p.value - best))) < 0.14;
    placed.push(el);
  }
}

const HUES = { halo: 95, crimson: 12, pink: 352, magenta: 335, purple: 305, lilac: 290, orange: 52, gold: 82, green: 140, teal: 195, blue: 255, cream: 90, foam: 220, cloud: 330, eye: 260 };

function toGamut(L, C, h) {
  let c = C;
  const ok = (cc) => {
    const a = cc * Math.cos((h * Math.PI) / 180); const b = cc * Math.sin((h * Math.PI) / 180);
    const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3; const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3; const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
    const rgb = [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s];
    return rgb.every((v) => v >= -0.0005 && v <= 1.0005);
  };
  while (c > 0 && !ok(c)) c -= 0.005;
  return oklchToHex(L, Math.max(0, c), h);
}

/** Value (0..1, OKLab L) → colour of the element's hue, chroma concentrated where detail density is high. */
function colourOf(el, v, density, hueMap) {
  if (el.hue === 'foam' || el.hue === 'cream') return toGamut(clamp(v, 0.05, 0.98), 0.02, HUES[el.hue]);
  const h = hueMap && hueMap[el.hue] !== undefined ? hueMap[el.hue] : HUES[el.hue] !== undefined ? HUES[el.hue] : 0;
  const d = density ? density(el.centroid || { x: 0, y: 0 }) : 0.5;
  const C = el.hue === 'halo' ? 0.06 : el.role === 'ground' ? 0.025 : 0.09 + 0.11 * d + (el.role === 'heavy' ? 0.02 : 0);
  return toGamut(clamp(v, 0.05, 0.98), C, h);
}
const grey = (v) => oklchToHex(clamp(v, 0.02, 0.99), 0, 0);

// ────────────────────────────────────────────────────────────────── review (structure gates, geometry only)
function classifyCurve(center) {
  if (!center || center.length < 4) return 'straight';
  const turns = [];
  for (let i = 2; i < center.length; i += 1) {
    const a = Math.atan2(center[i - 1].y - center[i - 2].y, center[i - 1].x - center[i - 2].x);
    const b = Math.atan2(center[i].y - center[i - 1].y, center[i].x - center[i - 1].x);
    turns.push(wrap(b - a));
  }
  const abs = turns.reduce((s, t) => s + Math.abs(t), 0);
  if (abs < 0.35) return 'straight';
  const pos = turns.filter((t) => t > 0).reduce((s, t) => s + t, 0);
  const neg = -turns.filter((t) => t < 0).reduce((s, t) => s + t, 0);
  if (Math.min(pos, neg) > 0.22 * abs) return 'S';
  const late = turns.slice(Math.floor(turns.length * 0.65)).reduce((s, t) => s + Math.abs(t), 0);
  if (late > 0.6 * abs) return 'J';
  return 'C';
}
function terminalTurn(center) {
  const n = center.length; const k = Math.max(2, Math.floor(n * 0.3));
  const a = Math.atan2(center[n - k].y - center[n - k - 1].y, center[n - k].x - center[n - k - 1].x);
  const b = Math.atan2(center[n - 1].y - center[n - 2].y, center[n - 1].x - center[n - 2].x);
  return wrap(b - a);
}
const mean = (xs) => xs.reduce((s, x) => s + x, 0) / (xs.length || 1);
const cv = (xs) => { const m = mean(xs); return m ? Math.sqrt(mean(xs.map((x) => (x - m) ** 2))) / m : 0; };

const GATES = {
  eyePathReversals: { min: 2, fix: 'اجعل مسار العين متعرجًا: انعطافان على الأقل بدل خط أو قوس واحد.' },
  eyePathCoverage: { min: 0.7, fix: 'وزّع الكتل الثقيلة والمتوسطة على طول المسار كله، لا حول نقطة واحدة.' },
  originConcentration: { max: 0.35, fix: 'شكل مروحي: أكثر البتلات تخرج من نقطة واحدة. انقل القواعد على طول المسار وفرّع الصغيرة من الكبيرة.' },
  terminalVariety: { min: 0.4, fix: 'نهايات المنحنيات متشابهة: نوّع مقدار الانعطاف في الطرف واتجاهه.' },
  curveFamilies: { min: 3, fix: 'استخدم ثلاث عائلات منحنيات على الأقل (C وS وJ وشبه مستقيم)، كل منها 10% أو أكثر.' },
  bendBalance: { min: 0.25, fix: 'الانحناءات كلها إلى جهة واحدة: اقلب ربعها على الأقل.' },
  sizeVariety: { min: 0.7, fix: 'الأحجام متقاربة: كتل ثقيلة قليلة، متوسطة أكثر، صغيرة كثيرة.' },
  heavyShare: { min: 0.22, max: 0.7, fix: 'أكبر ثلاث كتل يجب أن تحمل ربع المساحة إلى ثلثيها.' },
  hierarchyCounts: { min: 1, fix: 'العدد يجب أن يزيد من الثقيل إلى المتوسط إلى الصغير.' },
  detailContrast: { min: 2, fix: 'التفاصيل موزعة بالتساوي: ركّزها عند البؤرة ونقطة ثانوية واحدة.' },
  quietShare: { min: 0.25, fix: 'لا توجد مناطق هادئة: اترك ربع اللوحة على الأقل بلا تفاصيل دقيقة.' },
  overlapReadable: { min: 0.9, fix: 'تداخل غير مقروء: أعطِ الشكل الأمامي قيمة مختلفة بـ0.12 أو حافة.' },
  interlace: { min: 10, fix: 'لا يوجد تشابك كافٍ: مرّر أشكالًا فوق أشكال (10 تداخلات على الأقل).' },
  valueRange: { min: 0.5, fix: 'مدى القيم ضيق: الدراسة بلون واحد تحتاج فرق 0.5 بين أفتح وأغمق كتلة.' },
};

function reviewOrnament(plan) {
  const u = plan.u;
  const body = plan.elements.filter((e) => e.role !== 'ground' && e.role !== 'detail');
  const leafy = body.filter((e) => LEAFY.has(e.kind));
  const massive = body.filter((e) => MASSIVE.has(e.kind));
  const curves = body.filter((e) => e.center && e.kind !== 'bud');
  const metrics = {};

  // 1. Eye path.
  const sp = plan.spine.pts;
  let rev = 0; let dirX = 0; let dirY = 0; let lastX = sp[0].x; let lastY = sp[0].y;
  for (const p of sp) {
    const dx = p.x - lastX; const dy = p.y - lastY;
    if (Math.abs(dx) > 0.03 * u) { const s = Math.sign(dx); if (dirX && s !== dirX) rev += 1; dirX = s; lastX = p.x; }
    if (Math.abs(dy) > 0.03 * u) { const s = Math.sign(dy); if (dirY && s !== dirY) rev += 1; dirY = s; lastY = p.y; }
  }
  metrics.eyePathReversals = rev;
  const bins = new Array(10).fill(false);
  // A mass covers the stretch of path its centreline actually lies on (a long tail plume covers several bins).
  for (const e of body.filter((x) => ['heavy', 'medium', 'focal'].includes(x.role))) {
    for (const q of (e.center || [e.centroid]).filter((_, i) => i % 3 === 0)) {
      const n = plan.spine.nearest(q);
      if (n.d < 0.15 * u) bins[Math.min(9, Math.floor(n.t * 10))] = true;
    }
  }
  metrics.eyePathCoverage = bins.filter(Boolean).length / 10;

  // 2. Fan detection: concentration of origins, and similarity of terminal bends.
  const bases = leafy.map((e) => e.base);
  metrics.originConcentration = bases.length ? Math.max(...bases.map((b) => bases.filter((c) => Math.hypot(c.x - b.x, c.y - b.y) < 0.08 * u).length)) / bases.length : 1;
  const terms = leafy.map((e) => terminalTurn(e.center));
  metrics.terminalVariety = Number(cv(terms.map(Math.abs)).toFixed(3));

  // 3. Curve families (classified from geometry, not from the generator labels).
  const fam = {};
  curves.forEach((e) => { const f = classifyCurve(e.center); fam[f] = (fam[f] || 0) + 1; });
  metrics.curveFamilyCounts = fam;
  metrics.curveFamilies = Object.values(fam).filter((n) => n / curves.length >= 0.1).length;
  const signs = leafy.map((e) => Math.sign(e.bend || 0)).filter(Boolean);
  metrics.bendBalance = signs.length ? Math.min(signs.filter((s) => s > 0).length, signs.filter((s) => s < 0).length) / signs.length : 0;

  // 4. Weight hierarchy.
  const areas = massive.map((e) => e.area).sort((a, b) => b - a);
  metrics.sizeVariety = Number(cv(areas).toFixed(3));
  metrics.heavyShare = Number((areas.slice(0, 3).reduce((s, a) => s + a, 0) / (areas.reduce((s, a) => s + a, 0) || 1)).toFixed(3));
  const cnt = (r) => body.filter((e) => e.role === r && e.kind !== 'tendril').length;
  metrics.roleCounts = { heavy: cnt('heavy'), medium: cnt('medium'), small: cnt('small') };
  metrics.hierarchyCounts = metrics.roleCounts.heavy < metrics.roleCounts.medium && metrics.roleCounts.medium < metrics.roleCounts.small ? 1 : 0;

  // 5. Detail density: a 4×4 grid of fine-detail markers.
  const grid = new Array(16).fill(0);
  plan.elements.filter((e) => e.role === 'detail').forEach((e) => {
    const gx = clamp(Math.floor((e.centroid.x / plan.W) * 4), 0, 3); const gy = clamp(Math.floor((e.centroid.y / plan.H) * 4), 0, 3);
    grid[gy * 4 + gx] += 1;
  });
  const gmax = Math.max(...grid);
  metrics.detailGrid = grid;
  metrics.detailContrast = Number((gmax / (mean(grid) || 1)).toFixed(2));
  metrics.quietShare = grid.filter((g) => g <= 0.1 * gmax).length / 16;

  // 6. Overlap readability (interlace that the value study can actually show).
  let pairs = 0; let readable = 0;
  body.forEach((e, i) => {
    for (let j = 0; j < i; j += 1) {
      if (!overlaps(e, body[j])) continue;
      pairs += 1;
      if (Math.abs(e.value - body[j].value) >= 0.12 || e.rim) readable += 1;
    }
  });
  metrics.interlace = pairs;
  metrics.overlapReadable = pairs ? Number((readable / pairs).toFixed(3)) : 1;
  const vals = massive.map((e) => e.value);
  metrics.valueRange = Number((Math.max(...vals) - Math.min(...vals)).toFixed(2));

  const gates = Object.entries(GATES).map(([id, g]) => {
    const value = metrics[id];
    const ok = (g.min === undefined || value >= g.min) && (g.max === undefined || value <= g.max);
    return { id, value: typeof value === 'number' ? Number(value.toFixed(3)) : value, min: g.min, max: g.max, ok, fix: ok ? undefined : g.fix };
  });
  const passed = gates.filter((g) => g.ok).length;
  return { version: 1, ok: passed === gates.length, score: Number((passed / gates.length).toFixed(2)), gates, metrics, counts: { shapes: body.length, details: plan.elements.length - body.length } };
}

// ────────────────────────────────────────────────────────────────── public API
const SUBJECTS = { bloom: planBloom, phoenix: planPhoenix };

function planOrnament(options) {
  const o = options || {};
  const W = Number(o.width) || 1500; const H = Number(o.height) || 1000;
  const subject = SUBJECTS[o.subject] ? o.subject : 'bloom';
  const plan = new Plan(W, H, Number(o.seed) || 7, subject);
  SUBJECTS[subject](plan, o);
  assignValues(plan);
  return plan;
}

/** The naive radial bloom (every petal from one centre, one bend, one value): the failure the review must catch. */
function planRadialFan(options) {
  const o = options || {};
  const W = Number(o.width) || 1500; const H = Number(o.height) || 1000;
  const plan = new Plan(W, H, 3, 'fan');
  const c = { x: W * 0.5, y: H * 0.5 };
  plan.spine = makeSpine([[0.2, 0.5], [0.5, 0.5], [0.8, 0.5]], W, H);
  plan.focal = c; plan.accent = c; plan.density = densityField(c, c, plan.u);
  for (let i = 0; i < 24; i += 1) plan.shape('plume', { base: c, theta: (i / 24) * TAU, len: plan.u * 0.36, width: plan.u * 0.06, family: 'C', bend: 0.7, role: i < 2 ? 'heavy' : i < 8 ? 'medium' : 'small', group: 'plume', hue: 'pink' });
  for (let i = 0; i < 40; i += 1) { const a = (i / 40) * TAU; plan.dot(c.x + Math.cos(a) * plan.u * 0.25, c.y + Math.sin(a) * plan.u * 0.25, 4, { group: 'plume', hue: 'gold' }); }
  plan.elements.forEach((e) => { e.value = e.role === 'detail' ? 0.9 : 0.5; e.rim = false; });
  return plan;
}

/**
 * Emits drawing operations through a composer PlanBuilder.
 * pass "value": one hue (neutral greys) — the composition must read here before colour is trusted.
 * pass "color": same geometry and values, hue and chroma added (chroma rises with detail density).
 */
function renderOrnament(P, plan, options) {
  const o = options || {};
  const pass = o.pass === 'value' ? 'value' : 'color';
  const ids = Object.assign({ bloom: 'shapes', plume: 'shapes', wave: 'waves', ground: 'shapes', body: 'shapes', crest: 'shapes', wing: 'shapes', tail: 'shapes' }, o.elementIds || {});
  const u = plan.u;
  const fill = (el, v) => (pass === 'value' ? grey(v) : colourOf(el, v, plan.density, o.hueMap));
  const bgTop = pass === 'value' ? grey(0.97) : toGamut(0.97, 0.02, 330);
  const bgBottom = pass === 'value' ? grey(0.92) : toGamut(0.93, 0.03, 220);
  P.layer('orn-ground', 'ground');
  P.layer('orn-main', pass === 'value' ? 'value study' : 'ornament');
  P.rect('orn-ground', { x: 0, y: 0, w: plan.W, h: plan.H, fill: { type: 'linear', angle: 90, smooth: true, stops: [{ offset: 0, color: bgTop }, { offset: 1, color: bgBottom }] } }, ids.ground, 'calm ground');
  let ops = 1;
  for (const el of plan.elements) {
    const element = ids[el.group] || 'shapes';
    const v = el.value;
    const step = 2;
    const pts = el.poly.filter((_, i) => i % step === 0 || el.poly.length < 30);
    if (el.kind === 'dot') {
      P.ellipse('orn-main', { x: r2(el.centroid.x - el.r), y: r2(el.centroid.y - el.r), w: r2(el.r * 2), h: r2(el.r * 2), fill: fill(el, v) }, element, `${el.dotOf} dot`);
    } else if (el.kind === 'vein') {
      P.blob('orn-main', el.center.filter((_, i) => i % 2 === 0), { fill: null, stroke: fill(el, v), strokeWidth: r2(el.strokeWidth), cap: 'round', opacity: 0.85 }, element, 'vein (detail zone)', false);
    } else if (el.kind === 'cloud') {
      P.blob('orn-ground', el.poly, { fill: pass === 'value' ? grey(0.88) : colourOf(el, 0.9, null, o.hueMap), opacity: 0.8 }, ids.ground, 'calm scalloped cloud band');
    } else {
      const params = { fill: fill(el, v) };
      if (pass === 'color' && MASSIVE.has(el.kind) && el.center) {
        const a = el.center[0]; const b = el.center[el.center.length - 1];
        const angle = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
        params.fill = { type: 'linear', angle: r2(angle), smooth: true, stops: [{ offset: 0, color: colourOf(el, clamp(v - 0.05, 0.05, 0.95), plan.density, o.hueMap) }, { offset: 0.6, color: colourOf(el, v, plan.density, o.hueMap) }, { offset: 1, color: colourOf(el, clamp(v + 0.14, 0.05, 0.97), plan.density, o.hueMap) }] };
      }
      if (el.rim) { params.stroke = pass === 'value' ? grey(v > 0.5 ? v - 0.35 : v + 0.35) : colourOf(el, v > 0.5 ? v - 0.35 : v + 0.35, plan.density, o.hueMap); params.strokeWidth = r2(Math.max(1.2, u * 0.0022)); }
      P.blob('orn-main', pts, params, element, `${el.role} ${el.kind}${el.family ? ` (${el.family})` : ''}`, true);
    }
    ops += 1;
  }
  return { ops, pass };
}

module.exports = { planOrnament, planRadialFan, reviewOrnament, renderOrnament, classifyCurve, GATES, SUBJECTS: Object.keys(SUBJECTS) };
