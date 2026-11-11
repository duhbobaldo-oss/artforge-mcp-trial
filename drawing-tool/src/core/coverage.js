'use strict';

/**
 * Coverage programs: the shared representation of selections and layer masks.
 *
 * A program is an ordered list of steps that builds a coverage map (0 = hidden/unselected, 1 = shown/selected):
 *   { op: 'paint', value: 0..1, shape, feather? }  coverage = coverage·(1−a) + value·a   (a = shape coverage)
 *   { op: 'intersect', shape, feather? }           coverage = coverage·a
 *   { op: 'invert' } | { op: 'feather', radius } | { op: 'grow', radius } | { op: 'shrink', radius } | { op: 'smooth', radius }
 * Painting white (1) adds, painting black (0) removes, so mask brushing and selection add/subtract are the
 * same operation. Programs replay at any resolution and undo with the document history.
 *
 * Shapes are in document coordinates (layer coordinates for a linked layer mask):
 *   all · rect{x,y,w,h,radius?} · ellipse{x,y,w,h} · polygon{points} · path{segments} ·
 *   brush{points,size,hardness} · gradient{from,to,fromValue?,toValue?} · pixels{x,y,w,h,rle}
 * `pixels` carries pixel-derived coverage (colour range, magic wand, layer alpha) run-length encoded, so it
 * decodes synchronously in the browser live view as well as in Node.
 *
 * Shared by the Node exporter and the browser bundle: no Node-only requires.
 */

const { makeCanvas } = require('./effects');
const { distanceFields } = require('./distance');

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

// ------------------------------------------------------------------ run-length codec

function toBase64(bytes) {
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
  let s = '';
  for (let i = 0; i < bytes.length; i += 1) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

function fromBase64(text) {
  if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(text, 'base64'));
  const s = atob(text);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i += 1) out[i] = s.charCodeAt(i);
  return out;
}

/** values: Uint8Array (0..255) of w*h. Runs of (value, varint count). */
function encodeRle(values) {
  const out = [];
  let i = 0;
  while (i < values.length) {
    const v = values[i];
    let n = 1;
    while (i + n < values.length && values[i + n] === v) n += 1;
    out.push(v);
    let c = n;
    while (c >= 0x80) { out.push((c & 0x7f) | 0x80); c >>>= 7; }
    out.push(c);
    i += n;
  }
  return toBase64(Uint8Array.from(out));
}

function decodeRle(text, length) {
  const bytes = fromBase64(text);
  const out = new Uint8Array(length);
  let p = 0;
  let i = 0;
  while (i < bytes.length && p < length) {
    const v = bytes[i++];
    let n = 0;
    let shift = 0;
    let b;
    do { b = bytes[i++]; n |= (b & 0x7f) << shift; shift += 7; } while (b & 0x80);
    out.fill(v, p, Math.min(length, p + n));
    p += n;
  }
  return out;
}

/** Coverage array (0..1, document size) → `pixels` shape cropped to its non-zero bounds (null if empty). */
function pixelsShape(coverage, w, h) {
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) {
    if (coverage[y * w + x] > 0.002) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  }
  if (x1 < 0) return null;
  const cw = x1 - x0 + 1;
  const ch = y1 - y0 + 1;
  const values = new Uint8Array(cw * ch);
  for (let y = 0; y < ch; y += 1) for (let x = 0; x < cw; x += 1) values[y * cw + x] = Math.round(clamp01(coverage[(y + y0) * w + x + x0]) * 255);
  return { type: 'pixels', x: x0, y: y0, w: cw, h: ch, rle: encodeRle(values) };
}

const pixelCache = typeof WeakMap === 'function' ? new WeakMap() : null;
function pixelsCanvas(shape) {
  if (pixelCache && pixelCache.has(shape)) return pixelCache.get(shape);
  const values = decodeRle(shape.rle, shape.w * shape.h);
  const canvas = makeCanvas(shape.w, shape.h);
  const ctx = canvas.getContext('2d');
  const image = ctx.createImageData(shape.w, shape.h);
  for (let i = 0; i < values.length; i += 1) image.data[i * 4 + 3] = values[i];
  ctx.putImageData(image, 0, 0);
  if (pixelCache) pixelCache.set(shape, canvas);
  return canvas;
}

// ------------------------------------------------------------------ rendering

function blurInto(canvas, sigma) {
  if (!(sigma > 0.05)) return canvas;
  const out = makeCanvas(canvas.width, canvas.height);
  const ctx = out.getContext('2d');
  ctx.filter = `blur(${sigma.toFixed(2)}px)`;
  ctx.drawImage(canvas, 0, 0);
  ctx.filter = 'none';
  return out;
}

function readAlpha(canvas) {
  const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
  const alpha = new Float32Array(canvas.width * canvas.height);
  for (let i = 0; i < alpha.length; i += 1) alpha[i] = data[i * 4 + 3] / 255;
  return alpha;
}

function writeAlpha(alpha, w, h) {
  const canvas = makeCanvas(w, h);
  const ctx = canvas.getContext('2d');
  const image = ctx.createImageData(w, h);
  for (let i = 0; i < alpha.length; i += 1) image.data[i * 4 + 3] = Math.round(clamp01(alpha[i]) * 255);
  ctx.putImageData(image, 0, 0);
  return canvas;
}

/** Draw one shape's coverage (alpha) onto a fresh device canvas. `m` maps shape coordinates → device pixels. */
function shapeCanvas(shape, w, h, m, scale) {
  const canvas = makeCanvas(w, h);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#000';
  ctx.strokeStyle = '#000';
  if (shape.type === 'all') { ctx.fillRect(0, 0, w, h); return canvas; }
  ctx.setTransform(m.a, m.b, m.c, m.d, m.e, m.f);
  const R = () => require('./renderer');
  switch (shape.type) {
    case 'rect': R().roundedRectPath(ctx, shape, shape.radius || 0); ctx.fill(); break;
    case 'ellipse': R().ellipsePath(ctx, shape); ctx.fill(); break;
    case 'polygon': if (R().polygonPath(ctx, shape.points, true)) ctx.fill(); break;
    case 'path': if (R().pathFromSegments(ctx, shape.segments, true)) ctx.fill(shape.fillRule || 'nonzero'); break;
    case 'brush': {
      const pts = shape.points || [];
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.lineWidth = Math.max(0.5, Number(shape.size || 10));
      ctx.beginPath();
      pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      if (pts.length === 1) ctx.lineTo(pts[0].x + 0.01, pts[0].y);
      ctx.stroke();
      const hardness = shape.hardness === undefined ? 1 : Number(shape.hardness);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      return blurInto(canvas, (1 - hardness) * Number(shape.size || 10) * scale / 4);
    }
    case 'gradient': {
      // Coverage ramps from fromValue at `from` to toValue at `to` across the whole canvas.
      const g = ctx.createLinearGradient(shape.from.x, shape.from.y, shape.to.x, shape.to.y);
      g.addColorStop(0, `rgba(0,0,0,${clamp01(shape.fromValue === undefined ? 0 : shape.fromValue)})`);
      g.addColorStop(1, `rgba(0,0,0,${clamp01(shape.toValue === undefined ? 1 : shape.toValue)})`);
      const inv = invertMatrix(m);
      ctx.fillStyle = g;
      // Cover the whole device canvas, expressed in shape coordinates.
      const corners = [[0, 0], [w, 0], [0, h], [w, h]].map(([x, y]) => apply(inv, x, y));
      const xs = corners.map((p) => p.x);
      const ys = corners.map((p) => p.y);
      ctx.fillRect(Math.min(...xs) - 1, Math.min(...ys) - 1, Math.max(...xs) - Math.min(...xs) + 2, Math.max(...ys) - Math.min(...ys) + 2);
      break;
    }
    case 'pixels': {
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(pixelsCanvas(shape), shape.x, shape.y, shape.w, shape.h);
      break;
    }
    default: break;
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  return canvas;
}

function invertMatrix(m) {
  const det = m.a * m.d - m.b * m.c || 1;
  return { a: m.d / det, b: -m.b / det, c: -m.c / det, d: m.a / det, e: (m.c * m.f - m.d * m.e) / det, f: (m.b * m.e - m.a * m.f) / det };
}
const apply = (m, x, y) => ({ x: m.a * x + m.c * y + m.e, y: m.b * x + m.d * y + m.f });

function morph(canvas, radius, grow) {
  const w = canvas.width;
  const h = canvas.height;
  const alpha = readAlpha(canvas);
  const { inside, outside } = distanceFields(alpha, w, h);
  const out = new Float32Array(alpha.length);
  for (let i = 0; i < alpha.length; i += 1) {
    out[i] = grow
      ? Math.max(alpha[i], clamp01(radius + 0.5 - outside[i]))
      : (alpha[i] >= 0.5 ? alpha[i] * clamp01(inside[i] - radius + 0.5) : 0);
  }
  return writeAlpha(out, w, h);
}

/**
 * Render a program to a device-size canvas whose alpha is the coverage.
 * m: {a,b,c,d,e,f} shape → device transform; scale: device pixels per document pixel (for radii).
 */
function renderCoverage(steps, w, h, m, scale) {
  let acc = makeCanvas(w, h);
  for (const step of steps || []) {
    const radius = Number(step.radius || 0) * scale;
    switch (step.op) {
      case 'paint':
      case 'intersect': {
        let s = shapeCanvas(step.shape, w, h, m, scale);
        if (step.feather) s = blurInto(s, Number(step.feather) * scale / 2);
        const ctx = acc.getContext('2d');
        ctx.save();
        if (step.op === 'intersect') {
          ctx.globalCompositeOperation = 'destination-in';
          ctx.drawImage(s, 0, 0);
        } else if (step.shape.type === 'gradient') {
          // A gradient sets every pixel to its ramp value (it covers the canvas fully).
          ctx.clearRect(0, 0, w, h);
          ctx.globalAlpha = 1;
          ctx.drawImage(s, 0, 0);
        } else {
          ctx.globalCompositeOperation = 'destination-out';
          ctx.drawImage(s, 0, 0);
          ctx.globalCompositeOperation = 'lighter';
          ctx.globalAlpha = clamp01(step.value === undefined ? 1 : Number(step.value));
          ctx.drawImage(s, 0, 0);
        }
        ctx.restore();
        break;
      }
      case 'invert': {
        const out = makeCanvas(w, h);
        const ctx = out.getContext('2d');
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, w, h);
        ctx.globalCompositeOperation = 'destination-out';
        ctx.drawImage(acc, 0, 0);
        acc = out;
        break;
      }
      case 'feather': acc = blurInto(acc, radius / 2); break;
      case 'grow': acc = morph(acc, radius, true); break;
      case 'shrink': acc = morph(acc, radius, false); break;
      case 'smooth': {
        // Round off jagged edges: blur, then pull the soft edge back to a crisp-but-antialiased one.
        const soft = readAlpha(blurInto(acc, radius / 2));
        for (let i = 0; i < soft.length; i += 1) soft[i] = clamp01((soft[i] - 0.5) * 4 + 0.5);
        acc = writeAlpha(soft, w, h);
        break;
      }
      default: break;
    }
  }
  return acc;
}

/** Mask settings applied to a rendered coverage: feather, invert, density (100% = full effect). */
function finishMask(canvas, mask, scale) {
  let acc = mask.feather ? blurInto(canvas, Number(mask.feather) * scale / 2) : canvas;
  const w = acc.width;
  const h = acc.height;
  if (mask.invert) {
    const out = makeCanvas(w, h);
    const ctx = out.getContext('2d');
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, w, h);
    ctx.globalCompositeOperation = 'destination-out';
    ctx.drawImage(acc, 0, 0);
    acc = out;
  }
  const density = mask.density === undefined ? 1 : clamp01(Number(mask.density));
  if (density < 1) {
    // Lower density lets hidden areas show through: m' = (1 − density) + density · m.
    const out = makeCanvas(w, h);
    const ctx = out.getContext('2d');
    ctx.fillStyle = '#000';
    ctx.globalAlpha = 1 - density;
    ctx.fillRect(0, 0, w, h);
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = density;
    ctx.drawImage(acc, 0, 0);
    acc = out;
  }
  return acc;
}

module.exports = { encodeRle, decodeRle, pixelsShape, renderCoverage, finishMask, readAlpha, shapeCanvas, invertMatrix };
