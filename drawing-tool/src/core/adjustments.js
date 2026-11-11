'use strict';

/**
 * Non-destructive colour adjustments and smart filters (shared by Node and the browser live view).
 *
 * Adjustments map pixel values (LUTs where a channel depends only on itself, per-pixel otherwise).
 * Filters are spatial (blurs, sharpening, noise, pixelate) and work on canvases. Everything is computed
 * at render time from parameters; nothing is baked into the document.
 * These are behavioural approximations of the Photoshop adjustments of the same name, not Adobe's code.
 */

const { makeCanvas } = require('./effects');

const clamp255 = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const lum = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b); const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, l];
}
function hslToRgb(h, s, l) {
  h = ((h % 360) + 360) % 360 / 360;
  if (!s) return [l * 255, l * 255, l * 255];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const f = (t) => { t = (t + 1) % 1; return t < 1 / 6 ? p + (q - p) * 6 * t : t < 1 / 2 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p; };
  return [f(h + 1 / 3) * 255, f(h) * 255, f(h - 1 / 3) * 255];
}

/** Monotone cubic (Fritsch–Carlson) curve through points [[x,y],…] (0..255) as a 256-entry LUT. */
function curveLut(points) {
  // Natural cubic spline through the points (second derivative 0 at both ends), as Photoshop's Curves draws it.
  const pts = (points && points.length >= 2 ? points : [[0, 0], [255, 255]]).map(([x, y]) => [Number(x), Number(y)]).sort((a, b) => a[0] - b[0]);
  const n = pts.length;
  const xs = pts.map((p) => p[0]); const ys = pts.map((p) => p[1]);
  const y2 = new Float64Array(n); const u = new Float64Array(n);
  for (let i = 1; i < n - 1; i += 1) {
    const sig = (xs[i] - xs[i - 1]) / ((xs[i + 1] - xs[i - 1]) || 1e-6);
    const p = sig * y2[i - 1] + 2;
    y2[i] = (sig - 1) / p;
    const d = (ys[i + 1] - ys[i]) / ((xs[i + 1] - xs[i]) || 1e-6) - (ys[i] - ys[i - 1]) / ((xs[i] - xs[i - 1]) || 1e-6);
    u[i] = (6 * d / ((xs[i + 1] - xs[i - 1]) || 1e-6) - sig * u[i - 1]) / p;
  }
  for (let k = n - 2; k >= 0; k -= 1) y2[k] = y2[k] * y2[k + 1] + u[k];
  const lut = new Uint8ClampedArray(256);
  for (let x = 0; x < 256; x += 1) {
    if (x <= xs[0]) { lut[x] = ys[0]; continue; }
    if (x >= xs[n - 1]) { lut[x] = ys[n - 1]; continue; }
    let i = 0;
    while (x > xs[i + 1]) i += 1;
    const h = (xs[i + 1] - xs[i]) || 1e-6;
    const a = (xs[i + 1] - x) / h; const b = (x - xs[i]) / h;
    lut[x] = Math.round(a * ys[i] + b * ys[i + 1] + ((a * a * a - a) * y2[i] + (b * b * b - b) * y2[i + 1]) * h * h / 6);
  }
  return lut;
}

function levelsLut(l) {
  const lut = new Uint8ClampedArray(256);
  const inB = l.inBlack === undefined ? 0 : l.inBlack; const inW = l.inWhite === undefined ? 255 : l.inWhite;
  const gamma = l.gamma === undefined ? 1 : l.gamma;
  const outB = l.outBlack === undefined ? 0 : l.outBlack; const outW = l.outWhite === undefined ? 255 : l.outWhite;
  for (let x = 0; x < 256; x += 1) {
    const t = clamp01((x - inB) / Math.max(1, inW - inB));
    lut[x] = outB + (outW - outB) * Math.pow(t, 1 / gamma);
  }
  return lut;
}

const identity = () => { const l = new Uint8ClampedArray(256); for (let i = 0; i < 256; i += 1) l[i] = i; return l; };
const compose = (a, b) => { const l = new Uint8ClampedArray(256); for (let i = 0; i < 256; i += 1) l[i] = b[a[i]]; return l; };

// Per-channel LUT pair [master, r, g, b] for curves/levels.
function channelLuts(adj, make) {
  const master = adj.rgb ? make(adj.rgb) : identity();
  return ['r', 'g', 'b'].map((c) => (adj[c] ? compose(master, make(adj[c])) : master));
}

const toLinear = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
const toSrgb = (v) => 255 * (v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055);

// Black & White: hue-sector weights (Photoshop's defaults: reds 40, yellows 60, greens 40, cyans 60, blues 20, magentas 80).
function bwWeight(h, a) {
  const w = [a.reds, a.yellows, a.greens, a.cyans, a.blues, a.magentas].map((v, i) => (v === undefined ? [40, 60, 40, 60, 20, 80][i] : v) / 100);
  const pos = (((h % 360) + 360) % 360) / 60;
  const i = Math.floor(pos) % 6; const t = pos - Math.floor(pos);
  return w[i] + (w[(i + 1) % 6] - w[i]) * t;
}

/** Apply a colour adjustment to ImageData in place. */
function adjustImageData(image, adj) {
  const d = image.data;
  const kind = adj.kind;
  if (kind === 'curves' || kind === 'levels') {
    const [lr, lg, lb] = channelLuts(adj, kind === 'curves' ? curveLut : levelsLut);
    for (let p = 0; p < d.length; p += 4) { d[p] = lr[d[p]]; d[p + 1] = lg[d[p + 1]]; d[p + 2] = lb[d[p + 2]]; }
    return image;
  }
  if (kind === 'brightnessContrast') {
    const b = (adj.brightness || 0) * 150;
    const c = adj.contrast || 0;
    const f = c >= 0 ? 1 / Math.max(0.01, 1 - c) : 1 + c;
    const lut = new Uint8ClampedArray(256);
    for (let x = 0; x < 256; x += 1) lut[x] = clamp255((x + b - 127.5) * f + 127.5);
    for (let p = 0; p < d.length; p += 4) { d[p] = lut[d[p]]; d[p + 1] = lut[d[p + 1]]; d[p + 2] = lut[d[p + 2]]; }
    return image;
  }
  if (kind === 'exposure') {
    const k = Math.pow(2, adj.exposure || 0); const off = adj.offset || 0; const g = adj.gamma || 1;
    const lut = new Uint8ClampedArray(256);
    for (let x = 0; x < 256; x += 1) lut[x] = clamp255(toSrgb(Math.pow(clamp01(toLinear(x) * k + off), 1 / g)));
    for (let p = 0; p < d.length; p += 4) { d[p] = lut[d[p]]; d[p + 1] = lut[d[p + 1]]; d[p + 2] = lut[d[p + 2]]; }
    return image;
  }
  if (kind === 'invert') { for (let p = 0; p < d.length; p += 4) { d[p] = 255 - d[p]; d[p + 1] = 255 - d[p + 1]; d[p + 2] = 255 - d[p + 2]; } return image; }
  if (kind === 'posterize') {
    const n = Math.max(2, Math.round(adj.levels || 4));
    // Photoshop's definition: n equal input bands, each mapped to an evenly spaced output level.
    const lut = new Uint8ClampedArray(256);
    for (let x = 0; x < 256; x += 1) lut[x] = Math.round(Math.min(n - 1, Math.floor(x * n / 256)) * 255 / (n - 1));
    for (let p = 0; p < d.length; p += 4) { d[p] = lut[d[p]]; d[p + 1] = lut[d[p + 1]]; d[p + 2] = lut[d[p + 2]]; }
    return image;
  }
  if (kind === 'threshold') {
    const t = adj.level === undefined ? 128 : adj.level;
    for (let p = 0; p < d.length; p += 4) { const v = lum(d[p], d[p + 1], d[p + 2]) >= t ? 255 : 0; d[p] = v; d[p + 1] = v; d[p + 2] = v; }
    return image;
  }
  if (kind === 'gradientMap') {
    const lut = gradientLut(adj.stops);
    for (let p = 0; p < d.length; p += 4) { const i = Math.round(lum(d[p], d[p + 1], d[p + 2])) * 3; d[p] = lut[i]; d[p + 1] = lut[i + 1]; d[p + 2] = lut[i + 2]; }
    return image;
  }
  for (let p = 0; p < d.length; p += 4) {
    let r = d[p]; let g = d[p + 1]; let b = d[p + 2];
    if (kind === 'hueSaturation') {
      let [h, s, l] = rgbToHsl(r, g, b);
      if (adj.colorize) { h = adj.colorize.hue || 0; s = clamp01(adj.colorize.saturation === undefined ? 0.25 : adj.colorize.saturation); }
      else { h += adj.hue || 0; s = clamp01(s * (1 + (adj.saturation || 0))); }
      [r, g, b] = hslToRgb(h, s, l);
      // Lightness as Photoshop applies it: each channel moves toward white (L > 0) or black (L < 0).
      const L = adj.lightness || 0;
      if (L > 0) { r += (255 - r) * L; g += (255 - g) * L; b += (255 - b) * L; } else if (L < 0) { r *= 1 + L; g *= 1 + L; b *= 1 + L; }
    } else if (kind === 'vibrance') {
      let [h, s, l] = rgbToHsl(r, g, b);
      const v = adj.vibrance || 0;
      s = clamp01(s * (1 + v * (1 - s)) * (1 + (adj.saturation || 0)));
      [r, g, b] = hslToRgb(h, s, l);
    } else if (kind === 'colorBalance') {
      const L = lum(r, g, b) / 255;
      const w = { shadows: (1 - L) * (1 - L), midtones: 1 - (2 * L - 1) * (2 * L - 1), highlights: L * L };
      const shift = [0, 0, 0];
      for (const range of ['shadows', 'midtones', 'highlights']) {
        const v = adj[range] || [0, 0, 0];
        for (let k = 0; k < 3; k += 1) shift[k] += (v[k] || 0) / 100 * 0.5 * 255 * w[range];
      }
      const before = lum(r, g, b);
      r = clamp255(r + shift[0]); g = clamp255(g + shift[1]); b = clamp255(b + shift[2]);
      if (adj.preserveLuminosity !== false) { const after = lum(r, g, b) || 1; const k = before / after; r *= k; g *= k; b *= k; }
    } else if (kind === 'blackWhite') {
      const [h] = rgbToHsl(r, g, b);
      const chroma = Math.max(r, g, b) - Math.min(r, g, b);
      const v = clamp255(lum(r, g, b) + chroma * (bwWeight(h, adj) - 0.5));
      r = v; g = v; b = v;
      if (adj.tint) { const t = rgbOf(adj.tint.color); const a = clamp01(adj.tint.amount === undefined ? 0.3 : adj.tint.amount); r = v + (v * t[0] / 255 - v) * a; g = v + (v * t[1] / 255 - v) * a; b = v + (v * t[2] / 255 - v) * a; }
    } else if (kind === 'photoFilter') {
      const c = rgbOf(adj.color || '#ec8a00'); const k = clamp01(adj.density === undefined ? 0.25 : adj.density);
      const before = lum(r, g, b);
      r = r + (r * c[0] / 255 - r) * k + (c[0] - r) * k * 0.25; g = g + (g * c[1] / 255 - g) * k + (c[1] - g) * k * 0.25; b = b + (b * c[2] / 255 - b) * k + (c[2] - b) * k * 0.25;
      if (adj.preserveLuminosity !== false) { const after = lum(r, g, b) || 1; const s = before / after; r *= s; g *= s; b *= s; }
    }
    d[p] = clamp255(r); d[p + 1] = clamp255(g); d[p + 2] = clamp255(b);
  }
  return image;
}

let probe = null;
function rgbOf(color) {
  if (!probe) probe = makeCanvas(1, 1).getContext('2d');
  probe.clearRect(0, 0, 1, 1);
  probe.fillStyle = color;
  probe.fillRect(0, 0, 1, 1);
  const p = probe.getImageData(0, 0, 1, 1).data;
  return [p[0], p[1], p[2]];
}

function gradientLut(stops) {
  const c = makeCanvas(256, 1).getContext('2d');
  const g = c.createLinearGradient(0, 0, 256, 0);
  for (const s of stops || [{ offset: 0, color: '#000000' }, { offset: 1, color: '#ffffff' }]) g.addColorStop(s.offset, s.color);
  c.fillStyle = g;
  c.fillRect(0, 0, 256, 1);
  const data = c.getImageData(0, 0, 256, 1).data;
  const lut = new Uint8ClampedArray(256 * 3);
  for (let i = 0; i < 256; i += 1) { lut[i * 3] = data[i * 4]; lut[i * 3 + 1] = data[i * 4 + 1]; lut[i * 3 + 2] = data[i * 4 + 2]; }
  return lut;
}

/** Adjusted copy of a canvas. */
function adjustCanvas(canvas, adj) {
  const out = makeCanvas(canvas.width, canvas.height);
  const c = out.getContext('2d');
  const image = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
  c.putImageData(adjustImageData(image, adj), 0, 0);
  return out;
}

// ------------------------------------------------------------------ smart filters (spatial)

function drawBlurred(canvas, sigma) {
  const out = makeCanvas(canvas.width, canvas.height);
  const c = out.getContext('2d');
  c.filter = `blur(${Math.max(0, sigma).toFixed(2)}px)`;
  c.drawImage(canvas, 0, 0);
  c.filter = 'none';
  return out;
}

function seeded(seed) { let s = (seed >>> 0) || 1; return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return ((s >>> 0) % 100000) / 100000; }; }

/** One smart filter applied to a canvas (device pixels; `scale` = device px per document px). */
function applyFilter(canvas, f, scale) {
  const W = canvas.width; const H = canvas.height;
  switch (f.type) {
    case 'gaussianBlur': return drawBlurred(canvas, (f.radius || 4) * scale / 2);
    case 'motionBlur': {
      const out = makeCanvas(W, H); const c = out.getContext('2d');
      const dist = (f.distance || 20) * scale; const a = (f.angle || 0) * Math.PI / 180;
      const n = Math.max(2, Math.min(64, Math.ceil(dist / 2)));
      for (let i = 0; i < n; i += 1) {
        const t = i / (n - 1) - 0.5;
        c.globalAlpha = 1 / (i + 1);
        c.drawImage(canvas, Math.cos(a) * dist * t, -Math.sin(a) * dist * t);
      }
      return out;
    }
    case 'radialBlur': {
      const out = makeCanvas(W, H); const c = out.getContext('2d');
      const cx = W * (f.centerX === undefined ? 0.5 : f.centerX); const cy = H * (f.centerY === undefined ? 0.5 : f.centerY);
      const amount = (f.amount === undefined ? 10 : f.amount) / 100; const n = 24;
      for (let i = 0; i < n; i += 1) {
        const t = i / (n - 1) - 0.5;
        c.save(); c.globalAlpha = 1 / (i + 1); c.translate(cx, cy);
        if (f.mode === 'zoom') c.scale(1 + amount * t * 0.5, 1 + amount * t * 0.5); else c.rotate(amount * t * 0.5);
        c.translate(-cx, -cy); c.drawImage(canvas, 0, 0); c.restore();
      }
      return out;
    }
    case 'unsharpMask':
    case 'sharpen':
    case 'highPass': {
      const radius = f.type === 'sharpen' ? 1 : (f.radius || 2);
      const soft = drawBlurred(canvas, radius * scale / 2).getContext('2d').getImageData(0, 0, W, H).data;
      const image = canvas.getContext('2d').getImageData(0, 0, W, H);
      const d = image.data;
      const amount = f.type === 'sharpen' ? 1 : (f.amount === undefined ? 1 : f.amount);
      const threshold = f.threshold || 0;
      // Sharpening also acts on transparency (soft layer edges get crisper, as in Photoshop); high pass keeps alpha.
      const channels = f.type === 'highPass' ? 3 : 4;
      for (let p = 0; p < d.length; p += 4) {
        for (let k = 0; k < channels; k += 1) {
          const diff = d[p + k] - soft[p + k];
          if (f.type === 'highPass') d[p + k] = clamp255(128 + diff);
          else if (Math.abs(diff) >= threshold) d[p + k] = clamp255(d[p + k] + diff * amount);
        }
      }
      const out = makeCanvas(W, H); out.getContext('2d').putImageData(image, 0, 0); return out;
    }
    case 'addNoise': {
      const image = canvas.getContext('2d').getImageData(0, 0, W, H); const d = image.data;
      const rnd = seeded(f.seed || 7); const amt = (f.amount === undefined ? 0.1 : f.amount) * 255;
      for (let p = 0; p < d.length; p += 4) {
        if (!d[p + 3]) continue;
        const mono = (rnd() - 0.5) * 2 * amt;
        for (let k = 0; k < 3; k += 1) d[p + k] = clamp255(d[p + k] + (f.monochrome === false ? (rnd() - 0.5) * 2 * amt : mono));
      }
      const out = makeCanvas(W, H); out.getContext('2d').putImageData(image, 0, 0); return out;
    }
    case 'pixelate': {
      const cell = Math.max(2, Math.round((f.cellSize || 10) * scale));
      const small = makeCanvas(Math.ceil(W / cell), Math.ceil(H / cell));
      const sc = small.getContext('2d'); sc.imageSmoothingEnabled = true; sc.drawImage(canvas, 0, 0, small.width, small.height);
      const out = makeCanvas(W, H); const c = out.getContext('2d'); c.imageSmoothingEnabled = false;
      c.drawImage(small, 0, 0, small.width * cell, small.height * cell);
      return out;
    }
    case 'adjustment': return adjustCanvas(canvas, f.adjustment);
    default: return canvas;
  }
}

/**
 * Run a smart filter stack: each enabled filter applies to the previous result and lands with its own
 * opacity and blend; the optional filter mask (coverage canvas) limits the stack's effect.
 */
function applyFilterStack(canvas, filters, scale, maskCanvas) {
  let current = canvas;
  for (const f of filters) {
    if (f.enabled === false) continue;
    const filtered = applyFilter(current, f, scale);
    const next = makeCanvas(canvas.width, canvas.height);
    const c = next.getContext('2d');
    c.drawImage(current, 0, 0);
    const partial = (f.opacity !== undefined && f.opacity < 1) || (f.blend && f.blend !== 'source-over');
    if (partial) {
      // Filtered result lands on the previous one with the filter's own opacity and blend.
      c.globalAlpha = clamp01(f.opacity === undefined ? 1 : f.opacity);
      c.globalCompositeOperation = f.blend || 'source-over';
      c.drawImage(filtered, 0, 0);
      current = next;
    } else {
      current = filtered; // full-strength filter replaces the previous result (alpha included, never squared)
    }
  }
  if (!maskCanvas || current === canvas) return current;
  // Filter mask: original where the mask is black, filtered where it is white.
  const keep = makeCanvas(canvas.width, canvas.height);
  const kc = keep.getContext('2d');
  kc.drawImage(current, 0, 0);
  kc.globalCompositeOperation = 'destination-in';
  kc.drawImage(maskCanvas, 0, 0);
  const base = makeCanvas(canvas.width, canvas.height);
  const bc = base.getContext('2d');
  bc.drawImage(canvas, 0, 0);
  bc.globalCompositeOperation = 'destination-out';
  bc.drawImage(maskCanvas, 0, 0);
  bc.globalCompositeOperation = 'lighter';
  bc.drawImage(keep, 0, 0);
  return base;
}

module.exports = { adjustImageData, adjustCanvas, applyFilter, applyFilterStack, curveLut, levelsLut, rgbToHsl, hslToRgb };
