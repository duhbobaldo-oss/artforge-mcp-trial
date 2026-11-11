'use strict';

const { parseRgba, rgbaString } = require('./effects');

/**
 * Brush engine shared by the Node exporter and the browser live view.
 * A brush stroke is a list of points rendered as "dabs" stamped along the (optionally smoothed) path.
 * Randomness is seeded, so the preview, the export and every re-render produce the same pixels.
 */

const BRUSH_PRESETS = {
  round: { spacing: 0.08, hardness: 1, flow: 1, shape: 'round', note: 'hard round brush: clean even line' },
  soft: { spacing: 0.08, hardness: 0, flow: 0.22, shape: 'round', note: 'airbrush-like soft dab: shading, glow, smooth colour transitions' },
  flat: { spacing: 0.04, hardness: 1, flow: 1, shape: 'flat', aspect: 0.22, angle: 35, note: 'flat/chisel tip: calligraphic thick-thin, broad fills' },
  rough: { spacing: 0.12, hardness: 0.8, flow: 0.55, shape: 'bristle', jitter: 0.35, note: 'dry bristle: broken textured edges' },
  pencil: { spacing: 0.05, hardness: 1, flow: 0.5, shape: 'grain', note: 'graphite: thin grainy line for sketches' },
  ink: { spacing: 0.04, hardness: 1, flow: 1, shape: 'round', taper: 0.35, velocity: true, note: 'ink pen: pressure/speed varies width, tapered ends' },
  dotted: { spacing: 2.2, hardness: 1, flow: 1, shape: 'round', note: 'separate round dots' },
  dashed: { spacing: 0, hardness: 1, flow: 1, shape: 'dash', note: 'dashed stroke (dash = 3x size, gap = 2x size)' },
  spaced: { spacing: 1.2, hardness: 0.9, flow: 1, shape: 'round', note: 'stamps with visible gaps (beads, stitches)' },
  'soft-edge': { spacing: 0, hardness: 0.35, flow: 1, shape: 'smooth', note: 'even colouring with feathered edges (no build-up)' },
  texture: { spacing: 0.3, hardness: 1, flow: 0.6, shape: 'hatch', jitter: 0.3, note: 'hatching/texture marks: fabric, wood, grass, stone' },
  spray: { spacing: 0.25, hardness: 1, flow: 0.8, shape: 'spray', note: 'scattered speckles: stars, dust, foliage, grit' },
  smudge: { spacing: 0.06, hardness: 0.2, flow: 0.55, shape: 'round', wet: 0.95, pickup: 0.6, note: 'drags and blends the paint already on the canvas (finger blending)' },
  oil: { spacing: 0.08, hardness: 0.85, flow: 0.9, shape: 'bristle', jitter: 0.25, wet: 0.35, pickup: 0.25, colorJitter: 0.06, note: 'loaded bristle brush that mixes with wet paint underneath' },
  watercolor: { spacing: 0, hardness: 0.7, flow: 0.42, shape: 'smooth', edge: 0.45, note: 'transparent wash with a darker pooled edge' },
  chalk: { spacing: 0.1, hardness: 1, flow: 0.75, shape: 'grain', grains: 4.5, colorJitter: 0.05, note: 'dry, textured, broken stroke' },
  charcoal: { spacing: 0.06, hardness: 0.6, flow: 0.55, shape: 'grain', grains: 3.5, note: 'soft dark smeary stroke for sketching and value' },
  marker: { spacing: 0.04, hardness: 0.95, flow: 0.28, shape: 'flat', aspect: 0.55, angle: 0, note: 'translucent marker: overlaps build up darker' },
};

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** mulberry32: tiny deterministic PRNG. */
function rng(seed) {
  let a = (num(seed, 1) >>> 0) || 1;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Catmull-Rom smoothing: returns a denser polyline passing through the input points.
 * amount 0 = untouched polyline, 1 = fully rounded curve.
 */
function smoothPoints(points, amount, closed) {
  const k = Math.max(0, Math.min(1, num(amount, 0)));
  if (k === 0 || points.length < 3) return points.slice();
  const out = [];
  const n = points.length;
  const at = (i) => (closed ? points[(i + n) % n] : points[Math.max(0, Math.min(n - 1, i))]);
  const segments = closed ? n : n - 1;
  for (let i = 0; i < segments; i += 1) {
    const p0 = at(i - 1);
    const p1 = at(i);
    const p2 = at(i + 1);
    const p3 = at(i + 2);
    const len = Math.hypot(p2.x - p1.x, p2.y - p1.y);
    const steps = Math.max(2, Math.min(48, Math.ceil(len / 4)));
    for (let s = 0; s < steps; s += 1) {
      const t = s / steps;
      const t2 = t * t;
      const t3 = t2 * t;
      const cr = (a, b, c, d) => 0.5 * ((2 * b) + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      const lin = (a, b) => a + (b - a) * t;
      const x = lin(p1.x, p2.x) * (1 - k) + cr(p0.x, p1.x, p2.x, p3.x) * k;
      const y = lin(p1.y, p2.y) * (1 - k) + cr(p0.y, p1.y, p2.y, p3.y) * k;
      const p = lin(num(p1.p, 1), num(p2.p, 1));
      out.push({ x, y, p });
    }
  }
  if (!closed) out.push(Object.assign({ p: 1 }, points[n - 1]));
  else out.push(Object.assign({}, out[0]));
  return out;
}

/** Catmull-Rom → cubic Bezier segments (used by draw.freehand smooth and the pen tool). */
function pointsToBezierSegments(points, tension, closed) {
  const t = Math.max(0, Math.min(1, num(tension, 0.5)));
  const n = points.length;
  if (n < 3 || t === 0) {
    return points.map((p, i) => ({ op: i === 0 ? 'M' : 'L', x: p.x, y: p.y }));
  }
  const at = (i) => (closed ? points[(i + n) % n] : points[Math.max(0, Math.min(n - 1, i))]);
  const segs = [{ op: 'M', x: points[0].x, y: points[0].y }];
  const count = closed ? n : n - 1;
  for (let i = 0; i < count; i += 1) {
    const p0 = at(i - 1);
    const p1 = at(i);
    const p2 = at(i + 1);
    const p3 = at(i + 2);
    segs.push({
      op: 'C',
      c1x: p1.x + ((p2.x - p0.x) / 6) * t * 2,
      c1y: p1.y + ((p2.y - p0.y) / 6) * t * 2,
      c2x: p2.x - ((p3.x - p1.x) / 6) * t * 2,
      c2y: p2.y - ((p3.y - p1.y) / 6) * t * 2,
      x: p2.x,
      y: p2.y,
    });
  }
  if (closed) segs.push({ op: 'Z' });
  return segs;
}

function resolveBrush(brush) {
  const input = brush || {};
  const preset = BRUSH_PRESETS[input.preset] ? input.preset : 'round';
  const base = BRUSH_PRESETS[preset];
  return {
    preset,
    shape: base.shape,
    size: Math.max(0.5, num(input.size, 12)),
    spacing: input.spacing === undefined ? base.spacing : Math.max(0, num(input.spacing, base.spacing)),
    hardness: Math.max(0, Math.min(1, input.hardness === undefined ? base.hardness : num(input.hardness, base.hardness))),
    flow: Math.max(0.01, Math.min(1, input.flow === undefined ? base.flow : num(input.flow, base.flow))),
    angle: input.angle === undefined ? num(base.angle, 0) : num(input.angle, 0),
    aspect: Math.max(0.05, Math.min(1, input.aspect === undefined ? num(base.aspect, 1) : num(input.aspect, 1))),
    jitter: Math.max(0, Math.min(1, input.jitter === undefined ? num(base.jitter, 0) : num(input.jitter, 0))),
    taper: Math.max(0, Math.min(0.5, input.taper === undefined ? num(base.taper, 0) : num(input.taper, 0))),
    velocity: input.velocity === undefined ? Boolean(base.velocity) : Boolean(input.velocity),
    seed: num(input.seed, 7),
    // Paint mixing: wet (0..1) mixes each dab with the colour already under it; pickup carries it along.
    wet: Math.max(0, Math.min(1, input.wet === undefined ? num(base.wet, 0) : num(input.wet, 0))),
    pickup: Math.max(0, Math.min(1, input.pickup === undefined ? num(base.pickup, 0.3) : num(input.pickup, 0.3))),
    colorJitter: Math.max(0, Math.min(0.5, input.colorJitter === undefined ? num(base.colorJitter, 0) : num(input.colorJitter, 0))),
    edge: Math.max(0, Math.min(1, input.edge === undefined ? num(base.edge, 0) : num(input.edge, 0))),
    grains: Math.max(0.5, num(input.grains, num(base.grains, 2.5))),
  };
}

function pathLength(points) {
  const cumulative = [0];
  for (let i = 1; i < points.length; i += 1) {
    cumulative.push(cumulative[i - 1] + Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y));
  }
  return cumulative;
}

function sampleAt(points, cumulative, distance) {
  let i = 1;
  while (i < cumulative.length - 1 && cumulative[i] < distance) i += 1;
  const segLen = cumulative[i] - cumulative[i - 1] || 1;
  const t = Math.max(0, Math.min(1, (distance - cumulative[i - 1]) / segLen));
  const a = points[i - 1];
  const b = points[i];
  return {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    p: num(a.p, 1) + (num(b.p, 1) - num(a.p, 1)) * t,
    dir: Math.atan2(b.y - a.y, b.x - a.x),
    speed: segLen,
  };
}

function colorAt(colors, t) {
  if (!Array.isArray(colors) || colors.length === 0) return '#000000';
  if (colors.length === 1) return colors[0];
  const index = Math.min(colors.length - 1, Math.floor(t * colors.length));
  return colors[index];
}

function drawDab(ctx, b, x, y, radius, dir, color, random) {
  switch (b.shape) {
    case 'flat': {
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate((b.angle * Math.PI) / 180);
      ctx.beginPath();
      ctx.ellipse(0, 0, radius, Math.max(0.5, radius * b.aspect), 0, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.restore();
      break;
    }
    case 'bristle': {
      const bristles = Math.max(4, Math.round(radius * 1.2));
      ctx.fillStyle = color;
      for (let i = 0; i < bristles; i += 1) {
        const offset = (i / (bristles - 1) - 0.5) * 2 * radius;
        if (random() < b.jitter * 0.6) continue;
        const nx = x + Math.cos(dir + Math.PI / 2) * offset + (random() - 0.5) * radius * b.jitter;
        const ny = y + Math.sin(dir + Math.PI / 2) * offset + (random() - 0.5) * radius * b.jitter;
        ctx.globalAlpha = Math.max(0.05, Math.min(1, b.flow * (0.5 + random() * 0.5))) * ctx.__baseAlpha;
        ctx.beginPath();
        ctx.arc(nx, ny, Math.max(0.6, radius * 0.16), 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = ctx.__baseAlpha;
      break;
    }
    case 'grain': {
      // Soft medium (charcoal) leaves a faint smear under the particles; particles scale with the tip.
      if (b.hardness < 0.9) {
        const g = ctx.createRadialGradient(x, y, 0, x, y, radius);
        g.addColorStop(0, color);
        g.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.globalAlpha = 0.12 * ctx.__baseAlpha;
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(x, y, radius, 0, Math.PI * 2); ctx.fill();
        ctx.globalAlpha = ctx.__baseAlpha;
      }
      ctx.fillStyle = color;
      const ps = Math.max(1, radius * 0.08);
      const grains = Math.max(3, Math.round(radius * b.grains));
      for (let i = 0; i < grains; i += 1) {
        const a = random() * Math.PI * 2;
        const r = Math.sqrt(random()) * radius;
        ctx.globalAlpha = (0.25 + random() * 0.75) * b.flow * ctx.__baseAlpha;
        ctx.fillRect(x + Math.cos(a) * r, y + Math.sin(a) * r, ps, ps);
      }
      ctx.globalAlpha = ctx.__baseAlpha;
      break;
    }
    case 'hatch': {
      ctx.strokeStyle = color;
      ctx.lineWidth = Math.max(0.6, radius * 0.18);
      ctx.lineCap = 'round';
      const a = (b.angle * Math.PI) / 180 + (random() - 0.5) * b.jitter;
      const len = radius * (0.8 + random() * 0.6);
      ctx.beginPath();
      ctx.moveTo(x - Math.cos(a) * len, y - Math.sin(a) * len);
      ctx.lineTo(x + Math.cos(a) * len, y + Math.sin(a) * len);
      ctx.stroke();
      break;
    }
    case 'spray': {
      ctx.fillStyle = color;
      const drops = Math.max(4, Math.round(radius * 1.5));
      for (let i = 0; i < drops; i += 1) {
        const a = random() * Math.PI * 2;
        const r = Math.sqrt(random()) * radius;
        ctx.beginPath();
        ctx.arc(x + Math.cos(a) * r, y + Math.sin(a) * r, Math.max(0.5, radius * 0.07 * (0.5 + random())), 0, Math.PI * 2);
        ctx.fill();
      }
      break;
    }
    default: {
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      if (b.hardness >= 0.99) {
        ctx.fillStyle = color;
      } else {
        const g = ctx.createRadialGradient(x, y, radius * b.hardness, x, y, radius);
        g.addColorStop(0, color);
        g.addColorStop(1, transparentOf(color));
        ctx.fillStyle = g;
      }
      ctx.fill();
    }
  }
}

/** Same colour at zero alpha (keeps soft dabs from fading through black). */
function transparentOf(color) {
  const value = String(color).trim();
  if (value.startsWith('#')) {
    let hex = value.slice(1);
    if (hex.length === 3 || hex.length === 4) hex = hex.slice(0, 3).split('').map((c) => c + c).join('');
    hex = hex.slice(0, 6);
    return `rgba(${parseInt(hex.slice(0, 2), 16)},${parseInt(hex.slice(2, 4), 16)},${parseInt(hex.slice(4, 6), 16)},0)`;
  }
  const m = value.match(/^rgba?\(([^)]+)\)$/i);
  if (m) {
    const parts = m[1].split(',').map((p) => p.trim());
    return `rgba(${parts[0]},${parts[1]},${parts[2]},0)`;
  }
  return 'rgba(0,0,0,0)';
}

function strokeOnce(ctx, rawPoints, obj, b, colors) {
  const points = smoothPoints(rawPoints, obj.smooth === undefined ? 0.5 : obj.smooth, Boolean(obj.closed));
  if (points.length < 2) return 0;
  const cumulative = pathLength(points);
  const total = cumulative[cumulative.length - 1];
  const random = rng(b.seed);
  const baseAlpha = ctx.globalAlpha;
  ctx.__baseAlpha = baseAlpha;

  if (b.shape === 'dash' || b.shape === 'smooth') {
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i += 1) ctx.lineTo(points[i].x, points[i].y);
    if (obj.closed) ctx.closePath();
    ctx.lineWidth = b.size;
    ctx.lineCap = b.shape === 'dash' ? 'butt' : 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = colors.length > 1 ? linearAlong(ctx, points, colors) : colors[0];
    if (b.shape === 'dash') {
      ctx.setLineDash([b.size * 3, b.size * 2]);
      ctx.stroke();
      ctx.setLineDash([]);
    } else {
      // Feathered edge without dab build-up: blur scales with (1 - hardness).
      const blur = Math.max(0, (1 - b.hardness) * b.size * 0.5);
      if (blur > 0.5 && 'filter' in ctx) ctx.filter = `blur(${blur.toFixed(1)}px)`;
      ctx.globalAlpha = baseAlpha * b.flow;
      ctx.stroke();
      if ('filter' in ctx) ctx.filter = 'none';
      ctx.globalAlpha = baseAlpha;
      if (b.edge > 0) {
        // Watercolor: pigment pools at the wet edge — a thin darker rim along both sides of the wash.
        // The rim uses the stroke's own colours (darkened), softened slightly, so it reads as pooled pigment.
        const darker = colors.map((c) => { const k = parseRgba(c) || { r: 0, g: 0, b: 0, a: 1 }; return rgbaString({ r: k.r * 0.7, g: k.g * 0.7, b: k.b * 0.7, a: 1 }); });
        ctx.globalAlpha = baseAlpha * b.edge;
        ctx.globalCompositeOperation = 'multiply';
        ctx.strokeStyle = darker.length > 1 ? linearAlong(ctx, points, darker) : darker[0];
        ctx.lineWidth = Math.max(1, b.size * 0.05);
        if ('filter' in ctx) ctx.filter = `blur(${Math.max(0.6, b.size * 0.02).toFixed(1)}px)`;
        for (const side of [-1, 1]) {
          ctx.beginPath();
          for (let i = 0; i < points.length; i += 1) {
            const a = points[Math.max(0, i - 1)];
            const c = points[Math.min(points.length - 1, i + 1)];
            const len = Math.hypot(c.x - a.x, c.y - a.y) || 1;
            const nx = (-(c.y - a.y) / len) * b.size * 0.46 * side;
            const ny = ((c.x - a.x) / len) * b.size * 0.46 * side;
            if (i === 0) ctx.moveTo(points[i].x + nx, points[i].y + ny); else ctx.lineTo(points[i].x + nx, points[i].y + ny);
          }
          ctx.stroke();
        }
        if ('filter' in ctx) ctx.filter = 'none';
        ctx.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = baseAlpha;
      }
    }
    return 1;
  }

  const step = Math.max(0.5, b.size * Math.max(0.02, b.spacing));
  let dabs = 0;
  let load = null; // paint carried by a wet brush
  ctx.globalAlpha = baseAlpha * (b.shape === 'round' && b.hardness >= 0.99 ? 1 : b.flow);
  ctx.__baseAlpha = ctx.globalAlpha;
  for (let d = 0; d <= total + 0.001; d += step) {
    const s = sampleAt(points, cumulative, Math.min(d, total));
    let pressure = Math.max(0.05, Math.min(1, s.p));
    if (b.velocity) pressure *= Math.max(0.35, Math.min(1, 1.2 - s.speed / (b.size * 6)));
    if (b.taper > 0 && total > 0) {
      const edge = Math.min(d, total - d) / (total * b.taper);
      if (edge < 1) pressure *= Math.max(0.08, Math.sin((Math.min(1, edge) * Math.PI) / 2));
    }
    const radius = Math.max(0.3, (b.size / 2) * pressure);
    let x = s.x;
    let y = s.y;
    if (b.jitter && b.shape === 'round') {
      x += (random() - 0.5) * b.size * b.jitter;
      y += (random() - 0.5) * b.size * b.jitter;
    }
    let color = colorAt(colors, total ? d / total : 0);
    if (b.colorJitter) color = jitterColor(color, b.colorJitter, random);
    if (b.wet > 0) {
      const under = sampleUnder(ctx, x, y, radius);
      if (under) {
        load = load ? mixRgba(load, under, b.pickup) : under;
        color = rgbaString(mixRgba(parseRgba(color) || under, load, b.wet));
      }
    }
    drawDab(ctx, b, x, y, radius, s.dir, color, random);
    dabs += 1;
    if (dabs > 60000) break;
  }
  ctx.globalAlpha = baseAlpha;
  delete ctx.__baseAlpha;
  return dabs;
}

function mixRgba(a, b, t) {
  return { r: a.r + (b.r - a.r) * t, g: a.g + (b.g - a.g) * t, b: a.b + (b.b - a.b) * t, a: a.a + (b.a - a.a) * t };
}

/** Average colour already painted under a dab (device pixels), or null on empty/transparent canvas. */
function sampleUnder(ctx, x, y, radius) {
  if (typeof ctx.getImageData !== 'function' || typeof ctx.getTransform !== 'function') return null;
  const m = ctx.getTransform();
  const dx = Math.round(m.a * x + m.c * y + m.e);
  const dy = Math.round(m.b * x + m.d * y + m.f);
  const r = Math.max(1, Math.min(6, Math.round(radius * 0.4 * Math.abs(m.a || 1))));
  const sx = Math.max(0, dx - r);
  const sy = Math.max(0, dy - r);
  const w = Math.min(r * 2 + 1, Math.max(0, (ctx.canvas ? ctx.canvas.width : dx + r + 1) - sx));
  const h = Math.min(r * 2 + 1, Math.max(0, (ctx.canvas ? ctx.canvas.height : dy + r + 1) - sy));
  if (w <= 0 || h <= 0) return null;
  const data = ctx.getImageData(sx, sy, w, h).data;
  let R = 0; let G = 0; let B = 0; let A = 0;
  for (let i = 0; i < data.length; i += 4) { const a = data[i + 3] / 255; R += data[i] * a; G += data[i + 1] * a; B += data[i + 2] * a; A += a; }
  if (A < 0.05) return null;
  return { r: R / A, g: G / A, b: B / A, a: 1 };
}

/** Small per-dab variation of lightness and hue: painted strokes are never one flat colour. */
function jitterColor(color, amount, random) {
  const c = parseRgba(color);
  if (!c) return color;
  const k = 1 + (random() - 0.5) * 2 * amount;
  const shift = (random() - 0.5) * 40 * amount;
  return rgbaString({ r: c.r * k + shift, g: c.g * k, b: c.b * k - shift, a: c.a });
}

function linearAlong(ctx, points, colors) {
  const a = points[0];
  const z = points[points.length - 1];
  const g = ctx.createLinearGradient(a.x, a.y, z.x === a.x && z.y === a.y ? z.x + 1 : z.x, z.y);
  colors.forEach((c, i) => g.addColorStop(colors.length === 1 ? 0 : i / (colors.length - 1), c));
  return g;
}

/** Render a brush object (type "brush"). Returns the number of dabs drawn. */
function drawBrushObject(ctx, obj) {
  const b = resolveBrush(obj.brush);
  const colors = Array.isArray(obj.colors) && obj.colors.length ? obj.colors : [obj.color || '#000000'];
  const points = (obj.points || []).map((p) => ({ x: num(p.x, 0), y: num(p.y, 0), p: p.p === undefined ? 1 : num(p.p, 1) }));
  let dabs = strokeOnce(ctx, points, obj, b, colors);
  const sym = obj.symmetry;
  if (sym && (sym.axis === 'vertical' || sym.axis === 'horizontal' || sym.axis === 'both')) {
    const at = num(sym.at, 0);
    const mirrors = [];
    if (sym.axis === 'vertical' || sym.axis === 'both') mirrors.push((p) => ({ x: 2 * at - p.x, y: p.y, p: p.p }));
    if (sym.axis === 'horizontal' || sym.axis === 'both') mirrors.push((p) => ({ x: p.x, y: 2 * num(sym.atY, at) - p.y, p: p.p }));
    if (sym.axis === 'both') mirrors.push((p) => ({ x: 2 * at - p.x, y: 2 * num(sym.atY, at) - p.y, p: p.p }));
    for (const mirror of mirrors) dabs += strokeOnce(ctx, points.map(mirror), obj, b, colors);
  }
  const repeat = obj.repeat;
  if (repeat && num(repeat.count, 0) > 0) {
    const count = Math.min(200, Math.floor(num(repeat.count, 0)));
    for (let i = 1; i <= count; i += 1) {
      const dx = num(repeat.dx, 0) * i;
      const dy = num(repeat.dy, 0) * i;
      dabs += strokeOnce(ctx, points.map((p) => ({ x: p.x + dx, y: p.y + dy, p: p.p })), obj,
        Object.assign({}, b, { seed: b.seed + i }), colors);
    }
  }
  return dabs;
}

function brushBBox(obj) {
  const pts = obj.points || [];
  if (!pts.length) return { x: 0, y: 0, w: 0, h: 0 };
  const pad = num(obj.brush && obj.brush.size, 12) / 2;
  let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
  for (const p of pts) {
    minX = Math.min(minX, num(p.x, 0)); minY = Math.min(minY, num(p.y, 0));
    maxX = Math.max(maxX, num(p.x, 0)); maxY = Math.max(maxY, num(p.y, 0));
  }
  return { x: minX - pad, y: minY - pad, w: maxX - minX + pad * 2, h: maxY - minY + pad * 2 };
}

module.exports = {
  BRUSH_PRESETS,
  resolveBrush,
  smoothPoints,
  pointsToBezierSegments,
  drawBrushObject,
  brushBBox,
  rng,
};
