'use strict';

/**
 * Engine-level finishing: texture paints, perceptual (OKLab) gradients, per-layer filters and
 * whole-image post effects (haze, colour grading, bloom, vignette, grain, paper).
 * Shared by the Node exporter and the browser live view; no Node-only APIs here.
 */

const { assert } = require('./errors');

// ------------------------------------------------------------------ canvases

/** Offscreen canvas: Node registers a factory (exporter), browsers use OffscreenCanvas or <canvas>. */
function makeCanvas(w, h) {
  const width = Math.max(1, Math.round(w));
  const height = Math.max(1, Math.round(h));
  if (typeof globalThis.__artforgeCreateCanvas === 'function') return globalThis.__artforgeCreateCanvas(width, height);
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(width, height);
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  return c;
}

function rng(seed) {
  let a = (Number(seed) >>> 0) || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------- colour math

function parseRgba(color) {
  const v = String(color || '').trim();
  if (v === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
  if (v.startsWith('#')) {
    let h = v.slice(1);
    if (h.length === 3 || h.length === 4) h = h.split('').map((c) => c + c).join('');
    return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16), a: h.length >= 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1 };
  }
  const m = /^rgba?\(([^)]+)\)$/i.exec(v);
  if (m) {
    const p = m[1].split(',').map((s) => parseFloat(s));
    return { r: p[0] || 0, g: p[1] || 0, b: p[2] || 0, a: p[3] === undefined ? 1 : p[3] };
  }
  return null;
}

function rgbaString(c) {
  const k = (n) => Math.max(0, Math.min(255, Math.round(n)));
  return `rgba(${k(c.r)},${k(c.g)},${k(c.b)},${Number(Math.max(0, Math.min(1, c.a)).toFixed(4))})`;
}

const toLinear = (c) => { const v = c / 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
const toSrgb = (v) => 255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.max(0, v) ** (1 / 2.4) - 0.055);

function toOklab({ r, g, b }) {
  const R = toLinear(r); const G = toLinear(g); const B = toLinear(b);
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  return { L: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, A: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, B: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s };
}

function fromOklab({ L, A, B }) {
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
  return {
    r: toSrgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    g: toSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    b: toSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  };
}

/** Interpolate two colours in OKLab (perceptually even, no grey/muddy middle). */
function mixOklab(c1, c2, t) {
  const a = parseRgba(c1);
  const b = parseRgba(c2);
  if (!a || !b) return t < 0.5 ? c1 : c2;
  const A = toOklab(a);
  const B = toOklab(b);
  const rgb = fromOklab({ L: A.L + (B.L - A.L) * t, A: A.A + (B.A - A.A) * t, B: A.B + (B.B - A.B) * t });
  return rgbaString(Object.assign(rgb, { a: a.a + (b.a - a.a) * t }));
}

/**
 * smooth gradients: insert perceptual stops between the given stops (and optional easing),
 * so long gradients stay clean and even instead of banding or greying in the middle.
 */
function smoothStops(stops, easing) {
  if (stops.length < 2) return stops;
  const ease = easing === 'ease-in-out' ? (t) => t * t * (3 - 2 * t) : easing === 'ease-out' ? (t) => 1 - (1 - t) * (1 - t) : easing === 'ease-in' ? (t) => t * t : (t) => t;
  const out = [];
  for (let i = 0; i < stops.length - 1; i += 1) {
    const a = stops[i];
    const b = stops[i + 1];
    const n = 8;
    for (let k = 0; k < n; k += 1) {
      const t = k / n;
      out.push({ offset: a.offset + (b.offset - a.offset) * t, color: mixOklab(a.color, b.color, ease(t)) });
    }
  }
  out.push(stops[stops.length - 1]);
  return out;
}

// ------------------------------------------------------------------- patterns

const PATTERNS = ['hatch', 'crosshatch', 'dots', 'stripes', 'grain', 'paper', 'brick', 'tiles', 'wood', 'noise'];

function normalizePattern(p, field) {
  assert(PATTERNS.includes(p.kind), 'INVALID_PATTERN', `${field}.kind must be one of ${PATTERNS.join(', ')}`, { received: p.kind });
  return {
    type: 'pattern',
    kind: p.kind,
    color: String(p.color || 'rgba(0,0,0,0.35)'),
    background: p.background ? String(p.background) : null,
    scale: Math.max(1, Math.min(400, Number(p.scale) || 10)),
    angle: Number(p.angle) || 0,
    weight: Math.max(0.2, Math.min(50, Number(p.weight) || 1.2)),
    seed: Number(p.seed) || 7,
  };
}

const tileCache = new Map();

function patternTile(p) {
  const key = JSON.stringify(p);
  if (tileCache.has(key)) return tileCache.get(key);
  const s = p.scale;
  const size = ['grain', 'paper', 'noise'].includes(p.kind) ? 128 : (p.kind === 'brick' || p.kind === 'tiles' ? Math.round(s * 4) : Math.round(s * 2));
  const c = makeCanvas(size, size);
  const t = c.getContext('2d');
  if (p.background) { t.fillStyle = p.background; t.fillRect(0, 0, size, size); }
  t.strokeStyle = p.color;
  t.fillStyle = p.color;
  t.lineWidth = p.weight;
  const random = rng(p.seed);
  switch (p.kind) {
    case 'hatch':
    case 'stripes':
      for (let y = 0; y <= size; y += s) { t.beginPath(); t.moveTo(0, y + 0.5); t.lineTo(size, y + 0.5); if (p.kind === 'stripes') t.lineWidth = s / 2; t.stroke(); }
      break;
    case 'crosshatch':
      for (let y = 0; y <= size; y += s) { t.beginPath(); t.moveTo(0, y + 0.5); t.lineTo(size, y + 0.5); t.stroke(); }
      for (let x = 0; x <= size; x += s) { t.beginPath(); t.moveTo(x + 0.5, 0); t.lineTo(x + 0.5, size); t.stroke(); }
      break;
    case 'dots':
      for (let y = s / 2; y < size; y += s) for (let x = s / 2; x < size; x += s) { t.beginPath(); t.arc(x, y, p.weight, 0, Math.PI * 2); t.fill(); }
      break;
    case 'brick': {
      const bh = s; const bw = s * 2;
      for (let row = 0, y = 0; y < size; row += 1, y += bh) {
        t.beginPath(); t.moveTo(0, y + 0.5); t.lineTo(size, y + 0.5); t.stroke();
        for (let x = (row % 2) * s; x < size; x += bw) { t.beginPath(); t.moveTo(x + 0.5, y); t.lineTo(x + 0.5, y + bh); t.stroke(); }
      }
      break;
    }
    case 'tiles':
      for (let y = 0; y < size; y += s * 2) for (let x = 0; x < size; x += s * 2) t.strokeRect(x + 0.5, y + 0.5, s * 2, s * 2);
      break;
    case 'wood':
      for (let y = 0; y < size; y += s * 0.7) {
        t.beginPath();
        for (let x = 0; x <= size; x += 4) t.lineTo(x, y + Math.sin((x / size) * Math.PI * 2 + y) * s * 0.15);
        t.globalAlpha = 0.4 + random() * 0.6;
        t.stroke();
      }
      t.globalAlpha = 1;
      break;
    default: {
      // grain / paper / noise: seeded speckle; paper adds soft fibres.
      const n = p.kind === 'noise' ? 2400 : 1600;
      for (let i = 0; i < n; i += 1) {
        t.globalAlpha = random() * (p.kind === 'grain' ? 0.6 : 0.35);
        t.fillRect(random() * size, random() * size, 1, 1);
      }
      if (p.kind === 'paper') {
        for (let i = 0; i < 40; i += 1) {
          const x = random() * size; const y = random() * size; const a = random() * Math.PI;
          t.globalAlpha = 0.15;
          t.beginPath(); t.moveTo(x, y); t.lineTo(x + Math.cos(a) * 12, y + Math.sin(a) * 12); t.stroke();
        }
      }
      t.globalAlpha = 1;
    }
  }
  if (tileCache.size > 200) tileCache.clear();
  tileCache.set(key, c);
  return c;
}

/**
 * Fill the current path with a pattern. The pattern itself is rotated (pattern.setTransform), never the
 * context: rotating the context would also move the current path, and with it the object's outline.
 */
function fillPattern(ctx, p, bbox) {
  const pattern = ctx.createPattern(patternTile(p), 'repeat');
  const a = (p.angle * Math.PI) / 180;
  if (a && typeof pattern.setTransform === 'function') {
    const cx = bbox.x + bbox.w / 2;
    const cy = bbox.y + bbox.h / 2;
    const cos = Math.cos(a);
    const sin = Math.sin(a);
    // rotate about the shape centre: T(c) · R(a) · T(-c)
    pattern.setTransform({ a: cos, b: sin, c: -sin, d: cos, e: cx - cos * cx + sin * cy, f: cy - sin * cx - cos * cy });
  }
  ctx.fillStyle = pattern;
  ctx.fill();
}

// ------------------------------------------------------------- layer filters

const FILTER_KEYS = { blur: 'px', brightness: '', contrast: '', saturate: '', grayscale: '', sepia: '', hueRotate: 'deg', invert: '' };

function normalizeLayerFilter(f, label) {
  if (!f) return undefined;
  assert(typeof f === 'object', 'INVALID_FILTER', `${label}.filter must be an object like {blur: 4, saturate: 0.8}`);
  const out = {};
  for (const [k, unit] of Object.entries(FILTER_KEYS)) {
    if (f[k] === undefined) continue;
    const n = Number(f[k]);
    assert(Number.isFinite(n), 'INVALID_FILTER', `${label}.filter.${k} must be a number`);
    out[k] = n;
    void unit;
  }
  return Object.keys(out).length ? out : undefined;
}

function filterString(f) {
  return Object.entries(f).map(([k, v]) => (k === 'hueRotate' ? `hue-rotate(${v}deg)` : `${k}(${v}${FILTER_KEYS[k]})`)).join(' ');
}

// ------------------------------------------------------------- post effects

const EFFECTS = ['haze', 'grade', 'bloom', 'vignette', 'grain', 'paper', 'tint'];

function normalizeEffects(list, label) {
  if (!list) return [];
  assert(Array.isArray(list), 'INVALID_EFFECTS', `${label} must be an array of {type, ...}`);
  return list.map((e, i) => {
    assert(e && EFFECTS.includes(e.type), 'INVALID_EFFECTS', `${label}[${i}].type must be one of ${EFFECTS.join(', ')}`, { received: e && e.type });
    const out = { type: e.type };
    for (const [k, v] of Object.entries(e)) if (k !== 'type') out[k] = typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean' ? v : undefined;
    return out;
  });
}

/**
 * Whole-image finishing, applied after every layer (in canvas pixel space).
 *  haze     {color, from 0..1 (top), to 0..1, amount}   atmospheric depth toward the horizon band
 *  grade    {contrast, saturation, brightness, warmth}  colour grading (warmth -1..1)
 *  bloom    {radius, amount, threshold}                 light bleeding from areas brighter than threshold
 *  vignette {amount, softness}                          darkened corners focus the eye
 *  tint     {color, amount, blend}                      unify the palette
 *  grain    {amount, seed}                              film grain against digital banding
 *  paper    {amount, scale}                             printed/paper texture
 */
function applyEffects(ctx, effects, W, H) {
  if (!effects || !effects.length) return;
  for (const e of effects) {
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const w = ctx.canvas.width;
    const h = ctx.canvas.height;
    switch (e.type) {
      case 'haze': {
        const from = Number(e.from === undefined ? 0.35 : e.from) * h;
        const to = Number(e.to === undefined ? 0.75 : e.to) * h;
        const color = parseRgba(e.color || '#cfe0ee') || { r: 207, g: 224, b: 238 };
        const amount = Number(e.amount === undefined ? 0.35 : e.amount);
        const g = ctx.createLinearGradient(0, from, 0, to);
        g.addColorStop(0, rgbaString(Object.assign({}, color, { a: 0 })));
        g.addColorStop(0.5, rgbaString(Object.assign({}, color, { a: amount })));
        g.addColorStop(1, rgbaString(Object.assign({}, color, { a: 0 })));
        ctx.fillStyle = g;
        ctx.fillRect(0, from, w, to - from);
        break;
      }
      case 'grade': {
        const copy = makeCanvas(w, h);
        copy.getContext('2d').drawImage(ctx.canvas, 0, 0);
        const parts = [];
        if (e.contrast !== undefined) parts.push(`contrast(${Number(e.contrast)})`);
        if (e.saturation !== undefined) parts.push(`saturate(${Number(e.saturation)})`);
        if (e.brightness !== undefined) parts.push(`brightness(${Number(e.brightness)})`);
        if (parts.length) {
          ctx.clearRect(0, 0, w, h);
          ctx.filter = parts.join(' ');
          ctx.drawImage(copy, 0, 0);
          ctx.filter = 'none';
        }
        const warmth = Number(e.warmth || 0);
        if (warmth) {
          ctx.globalCompositeOperation = 'soft-light';
          ctx.fillStyle = warmth > 0 ? `rgba(255,170,90,${Math.min(0.6, warmth)})` : `rgba(90,140,255,${Math.min(0.6, -warmth)})`;
          ctx.fillRect(0, 0, w, h);
        }
        break;
      }
      case 'bloom': {
        // Only highlights above `threshold` (luminance 0..1) bleed; mid-tones stay untouched so the frame is not washed out.
        // The bright pass runs on a quarter-size copy (cheap), then is blurred back up to full size.
        const radius = Number(e.radius || 18) * (w / Math.max(1, W));
        const threshold = Number(e.threshold === undefined ? 0.68 : e.threshold);
        const sw = Math.max(1, Math.round(w / 4));
        const sh = Math.max(1, Math.round(h / 4));
        const small = makeCanvas(sw, sh);
        const sc = small.getContext('2d');
        sc.drawImage(ctx.canvas, 0, 0, sw, sh);
        const img = sc.getImageData(0, 0, sw, sh);
        const d = img.data;
        for (let i = 0; i < d.length; i += 4) {
          const lum = (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255;
          const k = Math.max(0, Math.min(1, (lum - threshold) / Math.max(0.01, 1 - threshold)));
          d[i + 3] = Math.round(255 * k * k);
        }
        sc.putImageData(img, 0, 0);
        const copy = makeCanvas(w, h);
        const cc = copy.getContext('2d');
        cc.filter = `blur(${radius}px)`;
        cc.drawImage(small, 0, 0, w, h);
        ctx.globalCompositeOperation = 'screen';
        ctx.globalAlpha = Number(e.amount === undefined ? 0.25 : e.amount);
        ctx.drawImage(copy, 0, 0);
        break;
      }
      case 'vignette': {
        const amount = Number(e.amount === undefined ? 0.35 : e.amount);
        const soft = Number(e.softness === undefined ? 0.6 : e.softness);
        const g = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * (0.5 - soft * 0.3), w / 2, h / 2, Math.hypot(w, h) / 2);
        g.addColorStop(0, 'rgba(0,0,0,0)');
        g.addColorStop(1, `rgba(0,0,0,${amount})`);
        ctx.globalCompositeOperation = 'multiply';
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, w, h);
        break;
      }
      case 'tint': {
        ctx.globalCompositeOperation = e.blend || 'soft-light';
        ctx.globalAlpha = Number(e.amount === undefined ? 0.2 : e.amount);
        ctx.fillStyle = e.color || '#ffd9a0';
        ctx.fillRect(0, 0, w, h);
        break;
      }
      case 'grain':
      case 'paper': {
        const tile = patternTile({ type: 'pattern', kind: e.type, color: '#000000', background: null, scale: Number(e.scale || 10), angle: 0, weight: 1, seed: Number(e.seed || 11) });
        ctx.globalCompositeOperation = 'overlay';
        ctx.globalAlpha = Number(e.amount === undefined ? (e.type === 'grain' ? 0.18 : 0.12) : e.amount);
        ctx.fillStyle = ctx.createPattern(tile, 'repeat');
        ctx.fillRect(0, 0, w, h);
        break;
      }
      default:
        break;
    }
    ctx.restore();
  }
}

module.exports = {
  makeCanvas, rng, parseRgba, rgbaString, mixOklab, smoothStops, toOklab, fromOklab,
  PATTERNS, normalizePattern, patternTile, fillPattern,
  normalizeLayerFilter, filterString, EFFECTS, normalizeEffects, applyEffects,
};
