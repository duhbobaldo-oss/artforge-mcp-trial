'use strict';

/**
 * Pixel (raster) layers: tiled storage and the retouching engine. Node only.
 *
 * Storage: `layer.raster.tiles` maps "tx,ty" → sha256 of a 256×256 PNG tile in `<assets>/tiles/`.
 * Tiles are immutable and content-addressed, so painting writes only the changed tiles and the
 * document (and every undo snapshot) holds just the small map. Coordinates are the layer's own pixels
 * (document units at 1×); the layer transform places them like any other layer content.
 *
 * Tools work on the tile-aligned region a stroke touches, never on the whole layer, then honour the
 * active selection and the transparency lock before writing back.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createCanvas, loadImage } = require('@napi-rs/canvas');
const { assert } = require('./errors');

const TILE = 256;
const MAX_REGION = 8192;
const key = (tx, ty) => `${tx},${ty}`;
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const clamp255 = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);

// ------------------------------------------------------------------ tile store

class TileStore {
  constructor(assetsDir) {
    this.dir = path.join(assetsDir, 'tiles');
    fs.mkdirSync(this.dir, { recursive: true });
    this.cache = new Map();
  }
  pathOf(hash) { return path.join(this.dir, `${hash}.png`); }
  put(buffer) {
    const hash = crypto.createHash('sha256').update(buffer).digest('hex');
    const file = this.pathOf(hash);
    if (!fs.existsSync(file)) fs.writeFileSync(file, buffer);
    return hash;
  }
  async load(hash) {
    if (this.cache.has(hash)) return this.cache.get(hash);
    const file = this.pathOf(hash);
    assert(fs.existsSync(file), 'TILE_MISSING', `pixel tile missing on disk: ${hash}`);
    const image = await loadImage(file);
    if (this.cache.size > 512) this.cache.delete(this.cache.keys().next().value);
    this.cache.set(hash, image);
    return image;
  }
}

const stores = new Map();
function tileStore(ctx) {
  const dir = ctx.assets.dir;
  if (!stores.has(dir)) stores.set(dir, new TileStore(dir));
  return stores.get(dir);
}

/** Images for every tile of a document's pixel layers, keyed "tile:<hash>" for the renderer. */
async function loadTiles(store, doc) {
  const out = {};
  for (const layer of doc.layers) {
    if (!layer.raster) continue;
    for (const hash of Object.values(layer.raster.tiles)) {
      if (out[`tile:${hash}`]) continue;
      try { out[`tile:${hash}`] = await store.load(hash); } catch { /* reported by the renderer */ }
    }
  }
  return out;
}

// ------------------------------------------------------------------ regions

function alignRect(box) {
  const x0 = Math.floor(box.x / TILE) * TILE;
  const y0 = Math.floor(box.y / TILE) * TILE;
  const x1 = Math.ceil((box.x + box.w) / TILE) * TILE;
  const y1 = Math.ceil((box.y + box.h) / TILE) * TILE;
  const rect = { x: x0, y: y0, w: Math.max(TILE, x1 - x0), h: Math.max(TILE, y1 - y0) };
  assert(rect.w <= MAX_REGION && rect.h <= MAX_REGION, 'RASTER_REGION_TOO_LARGE', `an edit may touch at most ${MAX_REGION}×${MAX_REGION} pixels`, { rect });
  return rect;
}

async function readRegion(store, layer, rect) {
  const canvas = createCanvas(rect.w, rect.h);
  const c = canvas.getContext('2d');
  for (const [k, hash] of Object.entries(layer.raster.tiles)) {
    const [tx, ty] = k.split(',').map(Number);
    const x = tx * TILE - rect.x;
    const y = ty * TILE - rect.y;
    if (x >= rect.w || y >= rect.h || x + TILE <= 0 || y + TILE <= 0) continue;
    c.drawImage(await store.load(hash), x, y);
  }
  return canvas;
}

/** Split a region back into tiles; returns the layer's new tile map (unchanged tiles kept). */
function writeRegion(store, layer, rect, canvas) {
  const tiles = Object.assign({}, layer.raster.tiles);
  const c = canvas.getContext('2d');
  for (let ty = rect.y / TILE; ty < (rect.y + rect.h) / TILE; ty += 1) {
    for (let tx = rect.x / TILE; tx < (rect.x + rect.w) / TILE; tx += 1) {
      const sx = tx * TILE - rect.x;
      const sy = ty * TILE - rect.y;
      const data = c.getImageData(sx, sy, TILE, TILE);
      let empty = true;
      for (let i = 3; i < data.data.length; i += 4) if (data.data[i]) { empty = false; break; }
      if (empty) { delete tiles[key(tx, ty)]; continue; }
      const tile = createCanvas(TILE, TILE);
      tile.getContext('2d').putImageData(data, 0, 0);
      tiles[key(tx, ty)] = store.put(tile.toBuffer('image/png'));
    }
  }
  return tiles;
}

// ------------------------------------------------------------------ brush geometry

/** Interpolated dab centres along a polyline (spacing in px), carrying pressure. */
function dabs(points, size, spacing) {
  const step = Math.max(0.5, size * (spacing === undefined ? 0.15 : spacing));
  const out = [];
  if (points.length === 1) return [{ x: points[0].x, y: points[0].y, p: points[0].p === undefined ? 1 : points[0].p }];
  let carry = 0;
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1];
    const b = points[i];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (i === 1) out.push({ x: a.x, y: a.y, p: a.p === undefined ? 1 : a.p });
    let d = step - carry;
    while (d <= len) {
      const t = d / len;
      const pa = a.p === undefined ? 1 : a.p;
      const pb = b.p === undefined ? 1 : b.p;
      out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, p: pa + (pb - pa) * t });
      d += step;
    }
    carry = len - (d - step);
  }
  return out;
}

const profile = (d, r, hardness) => {
  if (d >= r) return 0;
  const inner = r * clamp01(hardness);
  if (d <= inner) return 1;
  const t = (d - inner) / Math.max(1e-6, r - inner);
  return 1 - t * t * (3 - 2 * t);
};

/** Stroke coverage (0..1, max of dab profiles) over a region, for coverage-based retouch tools. */
function strokeCoverage(rect, list, params) {
  const cov = new Float32Array(rect.w * rect.h);
  for (const dab of list) {
    const r = Math.max(0.5, params.size * (params.pressureSize === false ? 1 : dab.p) / 2);
    const x0 = Math.max(0, Math.floor(dab.x - r - rect.x));
    const x1 = Math.min(rect.w - 1, Math.ceil(dab.x + r - rect.x));
    const y0 = Math.max(0, Math.floor(dab.y - r - rect.y));
    const y1 = Math.min(rect.h - 1, Math.ceil(dab.y + r - rect.y));
    for (let y = y0; y <= y1; y += 1) {
      for (let x = x0; x <= x1; x += 1) {
        const v = profile(Math.hypot(x + rect.x + 0.5 - dab.x, y + rect.y + 0.5 - dab.y), r, params.hardness);
        const i = y * rect.w + x;
        if (v > cov[i]) cov[i] = v;
      }
    }
  }
  return cov;
}

function blurred(canvas, sigma) {
  const out = createCanvas(canvas.width, canvas.height);
  const c = out.getContext('2d');
  c.filter = `blur(${Math.max(0.3, sigma).toFixed(2)}px)`;
  c.drawImage(canvas, 0, 0);
  return out;
}

const pixels = (canvas) => canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
const lum = (r, g, b) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;

// Premultiplied mix of two RGBA pixels: a + (b − a)·t, written into out at i.
function mixPremult(out, i, a, ai, b, bi, t) {
  const aa = a[ai + 3] / 255;
  const ba = b[bi + 3] / 255;
  const alpha = aa + (ba - aa) * t;
  for (let k = 0; k < 3; k += 1) {
    const pa = a[ai + k] * aa;
    const pb = b[bi + k] * ba;
    const p = pa + (pb - pa) * t;
    out[i + k] = alpha > 0 ? clamp255(p / alpha) : 0;
  }
  out[i + 3] = clamp255(alpha * 255);
}

// ------------------------------------------------------------------ tools

/**
 * Paint a stroke onto `canvas` (the region). Returns a new canvas. Tool parameters are already in
 * layer pixels. sampleCanvas: optional canvas of the same region to sample from (clone/heal source).
 */
function applyTool(tool, canvas, rect, params, sampleCanvas) {
  const list = dabs(params.points, params.size, params.spacing);
  const out = createCanvas(rect.w, rect.h);
  const oc = out.getContext('2d');
  oc.drawImage(canvas, 0, 0);

  if (tool === 'brush' || tool === 'eraser') {
    // Dabs build up (flow) in a stroke buffer; the buffer then lands once at the stroke opacity.
    const buffer = createCanvas(rect.w, rect.h);
    const bc = buffer.getContext('2d');
    const color = tool === 'eraser' ? '#000000' : params.color;
    for (const dab of list) {
      const r = Math.max(0.5, params.size * (params.pressureSize === false ? 1 : dab.p) / 2);
      const x = dab.x - rect.x;
      const y = dab.y - rect.y;
      const g = bc.createRadialGradient(x, y, Math.min(r * clamp01(params.hardness), r - 0.01), x, y, r);
      const flow = clamp01(params.flow * (params.pressureOpacity ? dab.p : 1));
      g.addColorStop(0, color);
      g.addColorStop(1, 'rgba(0,0,0,0)');
      bc.globalAlpha = flow;
      bc.fillStyle = g;
      bc.beginPath();
      bc.arc(x, y, r, 0, Math.PI * 2);
      bc.fill();
    }
    oc.globalAlpha = clamp01(params.opacity);
    oc.globalCompositeOperation = tool === 'eraser' ? 'destination-out' : (params.blend || 'source-over');
    oc.drawImage(buffer, 0, 0);
    return out;
  }

  const cov = strokeCoverage(rect, list, params);
  const src = pixels(canvas);
  const res = oc.getImageData(0, 0, rect.w, rect.h);
  const s = src.data;
  const d = res.data;
  const strength = clamp01(params.strength === undefined ? (params.opacity === undefined ? 0.5 : params.opacity) : params.strength);

  if (tool === 'dodge' || tool === 'burn') {
    const range = params.range || 'midtones';
    const exposure = clamp01(params.exposure === undefined ? 0.5 : params.exposure);
    for (let i = 0, p = 0; i < cov.length; i += 1, p += 4) {
      if (!cov[i] || !s[p + 3]) continue;
      const L = lum(s[p], s[p + 1], s[p + 2]);
      const w = range === 'shadows' ? (1 - L) * (1 - L) : range === 'highlights' ? L * L : 1 - (2 * L - 1) * (2 * L - 1);
      const a = exposure * cov[i] * w;
      for (let k = 0; k < 3; k += 1) d[p + k] = clamp255(tool === 'dodge' ? s[p + k] + (255 - s[p + k]) * a : s[p + k] * (1 - a));
    }
  } else if (tool === 'sponge') {
    const flow = clamp01(params.flow === undefined ? 0.5 : params.flow);
    const sign = params.mode === 'saturate' ? 1 : -1;
    for (let i = 0, p = 0; i < cov.length; i += 1, p += 4) {
      if (!cov[i] || !s[p + 3]) continue;
      const g = lum(s[p], s[p + 1], s[p + 2]) * 255;
      const a = flow * cov[i];
      for (let k = 0; k < 3; k += 1) d[p + k] = clamp255(s[p + k] + (s[p + k] - g) * a * sign);
    }
  } else if (tool === 'blur' || tool === 'sharpen') {
    const soft = pixels(blurred(canvas, tool === 'blur' ? Math.max(1, params.size / 8) : 1.2)).data;
    for (let i = 0, p = 0; i < cov.length; i += 1, p += 4) {
      if (!cov[i]) continue;
      const t = strength * cov[i];
      if (tool === 'blur') mixPremult(d, p, s, p, soft, p, t);
      else for (let k = 0; k < 3; k += 1) d[p + k] = clamp255(s[p + k] + (s[p + k] - soft[p + k]) * t * 2);
    }
  } else if (tool === 'clone' || tool === 'heal') {
    const sample = pixels(sampleCanvas || canvas).data;
    const ox = Math.round(params.offset.x);
    const oy = Math.round(params.offset.y);
    // Healing keeps the destination's tone (low frequencies) and takes the source's texture.
    const lowT = tool === 'heal' ? pixels(blurred(canvas, Math.max(2, params.size / 4))).data : null;
    const lowS = tool === 'heal' ? pixels(blurred(sampleCanvas || canvas, Math.max(2, params.size / 4))).data : null;
    for (let y = 0; y < rect.h; y += 1) {
      for (let x = 0; x < rect.w; x += 1) {
        const i = y * rect.w + x;
        if (!cov[i]) continue;
        const sx = x + ox;
        const sy = y + oy;
        if (sx < 0 || sy < 0 || sx >= rect.w || sy >= rect.h) continue;
        const p = i * 4;
        const q = (sy * rect.w + sx) * 4;
        const t = strength * cov[i];
        if (tool === 'clone') { mixPremult(d, p, s, p, sample, q, t); continue; }
        if (!s[p + 3] || !sample[q + 3]) continue;
        for (let k = 0; k < 3; k += 1) {
          const healed = clamp255(lowT[p + k] + (sample[q + k] - lowS[q + k]));
          d[p + k] = clamp255(s[p + k] + (healed - s[p + k]) * t);
        }
      }
    }
  } else if (tool === 'smudge') {
    // Carry a patch of colour along the stroke, picking up what it passes over.
    const r = Math.max(1, Math.round(params.size / 2));
    const n = r * 2 + 1;
    let patch = null;
    for (const dab of list) {
      const cx = Math.round(dab.x - rect.x);
      const cy = Math.round(dab.y - rect.y);
      if (!patch) {
        patch = new Float32Array(n * n * 4);
        for (let y = -r; y <= r; y += 1) for (let x = -r; x <= r; x += 1) {
          const px = cx + x; const py = cy + y;
          if (px < 0 || py < 0 || px >= rect.w || py >= rect.h) continue;
          const p = (py * rect.w + px) * 4; const k = ((y + r) * n + (x + r)) * 4;
          for (let c = 0; c < 4; c += 1) patch[k + c] = d[p + c];
        }
        continue;
      }
      for (let y = -r; y <= r; y += 1) for (let x = -r; x <= r; x += 1) {
        const px = cx + x; const py = cy + y;
        if (px < 0 || py < 0 || px >= rect.w || py >= rect.h) continue;
        const w = profile(Math.hypot(x, y), r, params.hardness) * strength;
        if (!w) continue;
        const p = (py * rect.w + px) * 4; const k = ((y + r) * n + (x + r)) * 4;
        const carried = [patch[k], patch[k + 1], patch[k + 2], patch[k + 3]];
        mixPremult(d, p, d, p, carried, 0, w);
        for (let c = 0; c < 4; c += 1) patch[k + c] = d[p + c];
      }
    }
  } else {
    assert(false, 'INVALID_TOOL', `unknown raster tool: ${tool}`);
  }
  oc.putImageData(res, 0, 0);
  return out;
}

/**
 * Keep an edit only where the selection allows (coverage 0..1) and, with a transparency lock, keep the
 * original alpha (paint only where pixels already exist).
 */
function constrain(before, after, coverage, lockAlpha) {
  if (!coverage && !lockAlpha) return after;
  const a = pixels(before);
  const b = pixels(after);
  const out = createCanvas(before.width, before.height);
  const res = out.getContext('2d').createImageData(before.width, before.height);
  for (let i = 0, p = 0; p < res.data.length; i += 1, p += 4) {
    const t = coverage ? coverage[i] : 1;
    mixPremult(res.data, p, a.data, p, b.data, p, t);
    if (lockAlpha) {
      res.data[p + 3] = a.data[p + 3];
      if (!a.data[p + 3]) { res.data[p] = 0; res.data[p + 1] = 0; res.data[p + 2] = 0; }
      else if (b.data[p + 3] && t > 0) for (let k = 0; k < 3; k += 1) res.data[p + k] = clamp255(a.data[p + k] + (b.data[p + k] - a.data[p + k]) * t);
    }
  }
  out.getContext('2d').putImageData(res, 0, 0);
  return out;
}

/** Flood fill (paint bucket) from a seed: tolerance per channel, contiguous or global. */
function floodMask(canvas, seedX, seedY, tolerance, contiguous) {
  const { data, width, height } = pixels(canvas);
  const mask = new Float32Array(width * height);
  if (seedX < 0 || seedY < 0 || seedX >= width || seedY >= height) return mask;
  const s = (seedY * width + seedX) * 4;
  const near = (i) => {
    const p = i * 4;
    return Math.abs(data[p] - data[s]) <= tolerance && Math.abs(data[p + 1] - data[s + 1]) <= tolerance
      && Math.abs(data[p + 2] - data[s + 2]) <= tolerance && Math.abs(data[p + 3] - data[s + 3]) <= tolerance;
  };
  if (!contiguous) { for (let i = 0; i < mask.length; i += 1) if (near(i)) mask[i] = 1; return mask; }
  const stack = [seedY * width + seedX];
  mask[stack[0]] = 1;
  while (stack.length) {
    const i = stack.pop();
    const x = i % width;
    for (const j of [x > 0 ? i - 1 : -1, x < width - 1 ? i + 1 : -1, i >= width ? i - width : -1, i + width < mask.length ? i + width : -1]) {
      if (j >= 0 && !mask[j] && near(j)) { mask[j] = 1; stack.push(j); }
    }
  }
  return mask;
}

module.exports = { TILE, TileStore, tileStore, loadTiles, alignRect, readRegion, writeRegion, dabs, strokeCoverage, applyTool, constrain, floodMask, pixels, mixPremult };
