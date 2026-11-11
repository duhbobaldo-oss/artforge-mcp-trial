'use strict';

/**
 * Palette-card reading. The reference images are palette cards: the palette is the set of FLAT swatches, not the
 * card's paper, photo or lettering. A global colour histogram returns the paper and text (Color1 → #f1ebdd), so:
 *   1. keep only flat pixels (equal to their neighbours 2px away) — swatches survive, text/photos/gradients don't;
 *   2. cluster them in OKLab (perceptual), drop tiny clusters;
 *   3. the cluster that owns the image border is the card background (kept, marked role "background").
 * describePalette() turns the swatches into a mood descriptor (pastel, neon, earthy, luxury…) used for selection.
 */

function srgbToLinear(c) {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

function rgbToOklab(r, g, b) {
  const lr = srgbToLinear(r);
  const lg = srgbToLinear(g);
  const lb = srgbToLinear(b);
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  return {
    L: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  };
}

function hexToRgb(hex) {
  const v = String(hex).replace('#', '');
  return { r: parseInt(v.slice(0, 2), 16), g: parseInt(v.slice(2, 4), 16), b: parseInt(v.slice(4, 6), 16) };
}

function hexToOklab(hex) {
  const { r, g, b } = hexToRgb(hex);
  return rgbToOklab(r, g, b);
}

/** Perceptual distance (OKLab ΔE; ~0.02 just noticeable, >0.1 clearly different). */
function deltaE(p, q) {
  return Math.hypot(p.L - q.L, p.a - q.a, p.b - q.b);
}

function lch(lab) {
  const C = Math.hypot(lab.a, lab.b);
  let h = (Math.atan2(lab.b, lab.a) * 180) / Math.PI;
  if (h < 0) h += 360;
  return { L: lab.L, C, h };
}

const toHex = (r, g, b) => `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;

/**
 * @param {Uint8ClampedArray} data RGBA pixels  @param {number} w  @param {number} h
 * @returns {{swatches: Array<{hex, share, role, L, C, h}>, collection: boolean, flatShare: number}}
 */
function extractSwatches(data, w, h, options) {
  const opts = options || {};
  const tol = opts.tolerance || 10;
  const at = (x, y) => (y * w + x) * 4;
  const flat = (x, y) => {
    const i = at(x, y);
    for (const [dx, dy] of [[2, 0], [-2, 0], [0, 2], [0, -2]]) {
      const j = at(x + dx, y + dy);
      if (Math.abs(data[i] - data[j]) > tol || Math.abs(data[i + 1] - data[j + 1]) > tol || Math.abs(data[i + 2] - data[j + 2]) > tol) return false;
    }
    return true;
  };
  // Quantised OKLab buckets of flat pixels (fast), then greedy perceptual clustering, largest first.
  const buckets = new Map();
  let flatCount = 0;
  const border = Math.max(2, Math.round(Math.min(w, h) * 0.03));
  for (let y = 2; y < h - 2; y += 1) {
    for (let x = 2; x < w - 2; x += 1) {
      if (!flat(x, y)) continue;
      flatCount += 1;
      const i = at(x, y);
      const lab = rgbToOklab(data[i], data[i + 1], data[i + 2]);
      const key = `${Math.round(lab.L * 40)}|${Math.round(lab.a * 60)}|${Math.round(lab.b * 60)}`;
      const k = buckets.get(key) || { r: 0, g: 0, b: 0, n: 0, edge: 0 };
      k.r += data[i]; k.g += data[i + 1]; k.b += data[i + 2]; k.n += 1;
      if (x < border || y < border || x >= w - border || y >= h - border) k.edge += 1;
      buckets.set(key, k);
    }
  }
  const clusters = [];
  for (const k of Array.from(buckets.values()).sort((p, q) => q.n - p.n)) {
    const lab = rgbToOklab(k.r / k.n, k.g / k.n, k.b / k.n);
    const home = clusters.find((c) => deltaE(c.lab, lab) < (opts.merge || 0.05));
    if (home) {
      home.r += k.r; home.g += k.g; home.b += k.b; home.n += k.n; home.edge += k.edge;
    } else {
      clusters.push({ r: k.r, g: k.g, b: k.b, n: k.n, edge: k.edge, lab });
    }
  }
  const minShare = opts.minShare || 0.006;
  const kept = clusters.filter((c) => c.n / Math.max(1, flatCount) >= minShare);
  const edgeTotal = kept.reduce((s, c) => s + c.edge, 0) || 1;
  const bg = kept.slice().sort((p, q) => q.edge - p.edge)[0];
  // A card background is neutral, near-white or near-black; a saturated half of a split card is a swatch.
  const bgLch = bg ? lch(rgbToOklab(bg.r / bg.n, bg.g / bg.n, bg.b / bg.n)) : null;
  const backgroundId = bg && bg.edge / edgeTotal > 0.35 && (bgLch.C < 0.05 || bgLch.L > 0.9 || bgLch.L < 0.22) ? bg : null;
  const swatches = kept.map((c) => {
    const r = c.r / c.n; const g = c.g / c.n; const b = c.b / c.n;
    const l = lch(rgbToOklab(r, g, b));
    return { hex: toHex(r, g, b), share: Number((c.n / flatCount).toFixed(4)), role: c === backgroundId ? 'background' : 'swatch', L: Number(l.L.toFixed(3)), C: Number(l.C.toFixed(3)), h: Math.round(l.h) };
  });
  // Swatches first (largest first), the card background last; at most 10.
  swatches.sort((p, q) => (p.role === q.role ? q.share - p.share : p.role === 'background' ? 1 : -1));
  const chromatic = swatches.filter((s) => s.role === 'swatch');
  return {
    swatches: swatches.slice(0, 10),
    // Combination charts (many small palettes on one sheet) are not one palette: selection treats them as weak.
    collection: chromatic.length > 12,
    flatShare: Number((flatCount / Math.max(1, (w - 4) * (h - 4))).toFixed(4)),
  };
}

/** Mood descriptor from the swatches: numbers plus tags the selector matches against the request. */
function describePalette(swatches) {
  const sw = swatches.filter((s) => s.role !== 'background');
  const list = sw.length ? sw : swatches;
  if (!list.length) return { lightness: 0.5, chroma: 0, warmth: 0, tags: [] };
  const wsum = list.reduce((s, c) => s + c.share, 0) || 1;
  const avg = (f) => list.reduce((s, c) => s + f(c) * c.share, 0) / wsum;
  const lightness = avg((c) => c.L);
  const chroma = avg((c) => c.C);
  const isWarm = (c) => c.C > 0.03 && (c.h < 100 || c.h > 330);
  const isCool = (c) => c.C > 0.03 && c.h >= 160 && c.h <= 300;
  const warmth = avg((c) => (isWarm(c) ? 1 : isCool(c) ? -1 : 0));
  const share = (f) => list.filter(f).reduce((s, c) => s + c.share, 0) / wsum;
  const hueShare = (lo, hi, minC) => share((c) => c.C > (minC || 0.04) && (lo <= hi ? c.h >= lo && c.h <= hi : c.h >= lo || c.h <= hi));
  // OKLab hue angles: red ~29, orange ~55, gold ~85, yellow ~110, green ~142, cyan ~195, blue ~264, purple ~305, magenta ~330.
  const count = (f) => list.filter(f).length;
  const darkPresence = share((c) => c.L < 0.3) + (swatches.some((s) => s.role === 'background' && s.L < 0.3) ? 0.3 : 0);
  const tags = [];
  // Pastel: the chromatic swatches themselves are light and soft, and nothing strong dominates.
  const chromaticSw = list.filter((c) => c.C > 0.02);
  if (chromaticSw.length >= 2 && count((c) => c.C > 0.02 && c.L > 0.72 && c.C < 0.12) >= Math.max(2, chromaticSw.length * 0.6) && share((c) => c.C > 0.13) < 0.12) tags.push('pastel', 'soft');
  // OKLab chroma tops out near 0.15 for cyan, ~0.3 for magenta: "bright" is C > 0.14 at high lightness.
  if (count((c) => c.C > 0.14 && c.L > 0.6) >= 2 && darkPresence > 0.15) tags.push('neon');
  if (count((c) => c.C > 0.14) >= 2 || chroma > 0.14) tags.push('vivid');
  if (chroma < 0.06 && count((c) => c.C > 0.12) < 2) tags.push('muted');
  if (chroma < 0.025) tags.push('monochrome');
  if (lightness < 0.42) tags.push('dark');
  if (lightness > 0.7) tags.push('light');
  if (warmth > 0.35) tags.push('warm');
  if (warmth < -0.35) tags.push('cool');
  if (hueShare(40, 110, 0.025) > 0.35 && chroma < 0.12) tags.push('earthy');
  if (hueShare(70, 105, 0.07) > 0.12 && darkPresence > 0.2) tags.push('luxury');
  if (hueShare(120, 170) > 0.25) tags.push('nature', 'green');
  if (hueShare(195, 275) > 0.25) tags.push('ocean', 'blue');
  if (hueShare(40, 75, 0.08) > 0.12 && hueShare(330, 40, 0.06) + hueShare(75, 115, 0.08) > 0.1) tags.push('sunset');
  if (hueShare(285, 335) > 0.25) tags.push('purple');
  if (hueShare(10, 40, 0.08) > 0.2) tags.push('red');
  if (hueShare(335, 10, 0.06) > 0.2) tags.push('pink');
  return { lightness: Number(lightness.toFixed(3)), chroma: Number(chroma.toFixed(3)), warmth: Number(warmth.toFixed(2)), tags };
}

function oklchToHex(L, C, h) {
  const a = C * Math.cos((h * Math.PI) / 180);
  const b = C * Math.sin((h * Math.PI) / 180);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const lin = [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s];
  const enc = (v) => { const c = Math.max(0, Math.min(1, v)); return 255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055); };
  return toHex(enc(lin[0]), enc(lin[1]), enc(lin[2]));
}

/**
 * Derive a colour LAYER from a reference palette when the request's mood is one the library card does not have
 * (e.g. "pastel" but the chosen card is saturated). Hues and their order are kept — the result is still the
 * reference's colour scheme — only lightness/chroma are moved in OKLab (perceptually even):
 *   pastel  light (L 0.8–0.93) and soft (C ≤ 0.085)       dark  deep (L 0.18–0.42), chroma kept
 *   muted   chroma × 0.45                                   vivid chroma × 1.35 (gamut-clipped)
 */
function deriveLayer(hexes, mode) {
  const sw = hexes.map((hex) => lch(hexToOklab(hex)));
  const order = sw.map((c, i) => [c.L, i]).sort((p, q) => p[0] - q[0]).map(([, i]) => i);
  const rank = new Map(order.map((i, k) => [i, order.length > 1 ? k / (order.length - 1) : 0.5]));
  return sw.map((c, i) => {
    const t = rank.get(i);
    if (mode === 'pastel') return oklchToHex(0.8 + 0.13 * t, Math.min(c.C, 0.085) * (c.C < 0.02 ? 1 : 0.9), c.h);
    if (mode === 'dark') return oklchToHex(0.18 + 0.24 * t, c.C, c.h);
    if (mode === 'muted') return oklchToHex(c.L, c.C * 0.45, c.h);
    if (mode === 'vivid') return oklchToHex(c.L, Math.min(0.3, c.C * 1.35), c.h);
    return hexes[i];
  });
}

/**
 * Pull a natural colour toward the closest reference swatch (OKLab ΔE): close swatches are taken almost fully,
 * far ones only tint it — so a sky/tree/skin stays believable while sharing the reference's colour scheme.
 * scale (0..1) lowers the pull for large atmospheric areas (sky).
 */
function harmonizeDetail(natural, swatchHexes, scale) {
  if (!swatchHexes || !swatchHexes.length) return { color: natural, swatch: null, weight: 0, deltaE: null };
  const lab = hexToOklab(natural);
  const n = lch(lab);
  let best = swatchHexes[0]; let d = Infinity;
  for (const hex of swatchHexes) {
    const s = lch(hexToOklab(hex));
    // Closeness counts hue for chromatic colours: green and red at equal lightness are NOT close.
    const dh = n.C > 0.04 && s.C > 0.04 ? Math.abs(((s.h - n.h + 540) % 360) - 180) : 0;
    const dd = deltaE(hexToOklab(hex), lab) + (dh > 60 ? 0.25 : 0);
    if (dd < d) { d = dd; best = hex; }
  }
  const w = (d < 0.12 ? 0.85 : d < 0.2 ? 0.6 : d < 0.3 ? 0.35 : 0.1) * (scale === undefined ? 1 : scale);
  // Mix in OKLCh: lightness and chroma move by w; the hue moves only toward a swatch within 60° (never through grey).
  const s = lch(hexToOklab(best));
  const dh = ((s.h - n.h + 540) % 360) - 180;
  const hue = n.C < 0.02 ? s.h : s.C < 0.02 || Math.abs(dh) > 60 ? n.h : n.h + dh * w;
  const color = oklchToHex(n.L + (s.L - n.L) * w, n.C + (s.C - n.C) * w, (hue + 360) % 360);
  return { color, swatch: best, weight: Number(w.toFixed(2)), deltaE: Number(d.toFixed(3)) };
}

function harmonize(natural, swatchHexes, scale) {
  return harmonizeDetail(natural, swatchHexes, scale).color;
}

module.exports = { harmonize, harmonizeDetail, extractSwatches, describePalette, deriveLayer, oklchToHex, hexToOklab, rgbToOklab, deltaE, lch };
