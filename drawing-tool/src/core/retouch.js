'use strict';

/**
 * Advanced pixel retouching and geometry (P8), Node side:
 *   heal()        gradient-domain healing: source texture + a smooth membrane that matches the destination
 *                 at the region's border (Laplace solve), so the blemish's own tone does not survive.
 *   bestOffset()  proximity match: the nearby source whose surrounding ring looks most like the target's.
 *   warp()        re-map a pixel region through a mapping (perspective / skew / mesh warp / presets),
 *                 drawn as a dense mesh of affine triangles.
 */

const { createCanvas } = require('@napi-rs/canvas');

const clamp255 = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);

/**
 * Heal `canvas` inside coverage `cov` (0..1 per pixel, region size) from the pixels at +offset.
 * Returns a new canvas. Pixels whose source falls outside the region are left as they are.
 */
function heal(canvas, cov, ox, oy) {
  const w = canvas.width; const h = canvas.height;
  const ctx = canvas.getContext('2d');
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  const src = new Float32Array(w * h * 4);
  const inside = new Uint8Array(w * h);
  const dx = Math.round(ox); const dy = Math.round(oy);
  for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) {
    const i = y * w + x;
    const sx = x + dx; const sy = y + dy;
    if (cov[i] > 0 && sx >= 0 && sy >= 0 && sx < w && sy < h) {
      inside[i] = 1;
      const q = (sy * w + sx) * 4;
      for (let k = 0; k < 4; k += 1) src[i * 4 + k] = d[q + k];
    }
  }
  // Grow the solve region by 1px so the border condition sits just outside the selection.
  const region = new Uint8Array(inside);
  // D = destination − source, known on the border ring, solved (∇²D = 0) inside.
  const D = new Float32Array(w * h * 4);
  const known = new Uint8Array(w * h);
  for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) {
    const i = y * w + x;
    if (region[i]) continue;
    const touches = (x > 0 && region[i - 1]) || (x < w - 1 && region[i + 1]) || (y > 0 && region[i - w]) || (y < h - 1 && region[i + w]);
    if (!touches) continue;
    // Border pixel: its source is the pixel at +offset (also outside the hole in practice).
    const sx = Math.min(w - 1, Math.max(0, x + dx)); const sy = Math.min(h - 1, Math.max(0, y + dy));
    const q = (sy * w + sx) * 4;
    known[i] = 1;
    for (let k = 0; k < 4; k += 1) D[i * 4 + k] = d[i * 4 + k] - d[q + k];
  }
  pullPush(D, known, region, w, h);
  sor(D, region, w, h, 120);
  const out = createCanvas(w, h);
  const res = out.getContext('2d').createImageData(w, h);
  res.data.set(d);
  for (let i = 0; i < w * h; i += 1) {
    if (!region[i]) continue;
    const t = cov[i] > 1 ? 1 : cov[i];
    for (let k = 0; k < 4; k += 1) {
      const healed = clamp255(src[i * 4 + k] + D[i * 4 + k]);
      res.data[i * 4 + k] = clamp255(d[i * 4 + k] + (healed - d[i * 4 + k]) * t);
    }
  }
  out.getContext('2d').putImageData(res, 0, 0);
  return out;
}

// Coarse-to-fine initial guess for the membrane: averages of known values, pushed back down.
function pullPush(D, known, region, w, h) {
  const levels = [{ w, h, v: D, wt: Float32Array.from(known) }];
  while (levels[levels.length - 1].w > 1 || levels[levels.length - 1].h > 1) {
    const L = levels[levels.length - 1];
    const nw = Math.max(1, Math.ceil(L.w / 2)); const nh = Math.max(1, Math.ceil(L.h / 2));
    const v = new Float32Array(nw * nh * 4); const wt = new Float32Array(nw * nh);
    for (let y = 0; y < L.h; y += 1) for (let x = 0; x < L.w; x += 1) {
      const i = y * L.w + x; const a = L.wt[i];
      if (!a) continue;
      const j = (y >> 1) * nw + (x >> 1);
      wt[j] += a;
      for (let k = 0; k < 4; k += 1) v[j * 4 + k] += L.v[i * 4 + k] * a;
    }
    for (let j = 0; j < nw * nh; j += 1) if (wt[j]) { for (let k = 0; k < 4; k += 1) v[j * 4 + k] /= wt[j]; wt[j] = Math.min(1, wt[j]); }
    levels.push({ w: nw, h: nh, v, wt });
  }
  for (let l = levels.length - 2; l >= 0; l -= 1) {
    const L = levels[l]; const U = levels[l + 1];
    for (let y = 0; y < L.h; y += 1) for (let x = 0; x < L.w; x += 1) {
      const i = y * L.w + x;
      const a = L.wt[i];
      if (a >= 1) continue;
      const j = (y >> 1) * U.w + (x >> 1);
      for (let k = 0; k < 4; k += 1) L.v[i * 4 + k] = L.v[i * 4 + k] * a + U.v[j * 4 + k] * (1 - a);
      if (l > 0) L.wt[i] = 1;
    }
  }
  // Level 0 shares D; only region pixels were unknown, others keep their known/zero values.
  for (let i = 0; i < w * h; i += 1) if (!region[i] && !known[i]) for (let k = 0; k < 4; k += 1) D[i * 4 + k] = 0;
}

// Successive over-relaxation of ∇²D = 0 on region pixels (neighbours outside the region are fixed).
function sor(D, region, w, h, iterations) {
  const omega = 1.85;
  const idx = [];
  for (let i = 0; i < w * h; i += 1) if (region[i]) idx.push(i);
  for (let it = 0; it < iterations; it += 1) {
    for (const i of idx) {
      const x = i % w;
      const nb = [x > 0 ? i - 1 : i, x < w - 1 ? i + 1 : i, i >= w ? i - w : i, i + w < w * h ? i + w : i];
      for (let k = 0; k < 4; k += 1) {
        const avg = (D[nb[0] * 4 + k] + D[nb[1] * 4 + k] + D[nb[2] * 4 + k] + D[nb[3] * 4 + k]) / 4;
        D[i * 4 + k] += omega * (avg - D[i * 4 + k]);
      }
    }
  }
}

/**
 * Choose a source offset for healing the region `cov` (bbox `box` in region pixels): candidates around
 * the region; score = colour difference of the ring just outside the region vs the ring around the
 * candidate, skipping candidates that overlap the region or leave the canvas or are transparent.
 */
function bestOffset(canvas, cov, box) {
  const w = canvas.width; const h = canvas.height;
  const d = canvas.getContext('2d').getImageData(0, 0, w, h).data;
  const size = Math.max(box.w, box.h);
  const ring = [];
  const margin = Math.max(3, Math.round(size * 0.35));
  for (let y = Math.max(0, box.y - margin); y < Math.min(h, box.y + box.h + margin); y += 1) {
    for (let x = Math.max(0, box.x - margin); x < Math.min(w, box.x + box.w + margin); x += 1) {
      const i = y * w + x;
      if (cov[i] > 0) continue;
      ring.push(i);
    }
  }
  let best = null;
  for (const k of [1.15, 1.6, 2.2]) {
    for (let a = 0; a < 16; a += 1) {
      const ox = Math.round(Math.cos((a / 16) * Math.PI * 2) * size * k);
      const oy = Math.round(Math.sin((a / 16) * Math.PI * 2) * size * k);
      if (box.x + ox - margin < 0 || box.y + oy - margin < 0 || box.x + box.w + ox + margin > w || box.y + box.h + oy + margin > h) continue;
      let ok = true;
      for (let y = box.y; y < box.y + box.h && ok; y += 1) for (let x = box.x; x < box.x + box.w; x += 1) {
        const i = y * w + x;
        if (!cov[i]) continue;
        const j = (y + oy) * w + (x + ox);
        if (cov[j] > 0 || d[j * 4 + 3] < 250) { ok = false; break; }
      }
      if (!ok) continue;
      let score = 0;
      for (const i of ring) {
        const x = i % w; const y = (i - x) / w;
        const j = ((y + oy) * w + (x + ox)) * 4; const p = i * 4;
        if (cov[j / 4] > 0) { score += 3 * 255 * 255; continue; }
        for (let c = 0; c < 3; c += 1) { const e = d[p + c] - d[j + c]; score += e * e; }
      }
      // Prefer nearer sources slightly on ties.
      score *= 1 + (k - 1.15) * 0.05;
      if (!best || score < best.score) best = { x: ox, y: oy, score };
    }
  }
  return best;
}

/**
 * Warp a source canvas (origin `srcOrigin` in layer pixels) whose content box is `box` (layer pixels):
 * `map(u, v)` → [x, y] in layer pixels for normalised box coordinates (it may be asked slightly outside
 * 0..1). Inverse mapping: the mapped mesh is rasterised so each destination pixel centre takes its
 * source position from exactly one triangle, then samples the source bilinearly (premultiplied). The
 * mesh reaches 2px beyond the content, so edges are anti-aliased by the sampling and never doubled.
 * Returns {canvas, x, y} covering the destination's bounds.
 */
function warp(source, srcOrigin, box, map, grid) {
  const n = grid || 32;
  const pad = 2;
  const u0 = -pad / Math.max(1, box.w); const u1 = 1 + pad / Math.max(1, box.w);
  const v0 = -pad / Math.max(1, box.h); const v1 = 1 + pad / Math.max(1, box.h);
  const U = (i) => u0 + (u1 - u0) * (i / n);
  const V = (j) => v0 + (v1 - v0) * (j / n);
  const pts = [];
  for (let j = 0; j <= n; j += 1) for (let i = 0; i <= n; i += 1) pts.push(map(U(i), V(j)));
  let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
  for (const p of pts) { if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0]; if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1]; }
  x0 = Math.floor(x0); y0 = Math.floor(y0); x1 = Math.ceil(x1); y1 = Math.ceil(y1);
  const W = Math.max(1, x1 - x0); const H = Math.max(1, y1 - y0);
  // Source position (in source-canvas pixels) for every destination pixel; NaN = not covered.
  const su = new Float32Array(W * H).fill(NaN);
  const sv = new Float32Array(W * H);
  const srcX = (i) => box.x - srcOrigin.x + U(i) * box.w;
  const srcY = (j) => box.y - srcOrigin.y + V(j) * box.h;
  const tri = (a, b, c, sa, sb, sc) => {
    const den = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]);
    if (Math.abs(den) < 1e-12) return;
    const minX = Math.max(0, Math.floor(Math.min(a[0], b[0], c[0]) - x0)); const maxX = Math.min(W - 1, Math.ceil(Math.max(a[0], b[0], c[0]) - x0));
    const minY = Math.max(0, Math.floor(Math.min(a[1], b[1], c[1]) - y0)); const maxY = Math.min(H - 1, Math.ceil(Math.max(a[1], b[1], c[1]) - y0));
    for (let y = minY; y <= maxY; y += 1) {
      const py = y + y0 + 0.5;
      for (let x = minX; x <= maxX; x += 1) {
        const k = y * W + x;
        if (su[k] === su[k]) continue; // already covered (not NaN)
        const px = x + x0 + 0.5;
        const l1 = ((b[1] - c[1]) * (px - c[0]) + (c[0] - b[0]) * (py - c[1])) / den;
        const l2 = ((c[1] - a[1]) * (px - c[0]) + (a[0] - c[0]) * (py - c[1])) / den;
        const l3 = 1 - l1 - l2;
        if (l1 < -1e-7 || l2 < -1e-7 || l3 < -1e-7) continue;
        su[k] = l1 * sa[0] + l2 * sb[0] + l3 * sc[0];
        sv[k] = l1 * sa[1] + l2 * sb[1] + l3 * sc[1];
      }
    }
  };
  for (let j = 0; j < n; j += 1) for (let i = 0; i < n; i += 1) {
    const d00 = pts[j * (n + 1) + i]; const d10 = pts[j * (n + 1) + i + 1];
    const d01 = pts[(j + 1) * (n + 1) + i]; const d11 = pts[(j + 1) * (n + 1) + i + 1];
    const s00 = [srcX(i), srcY(j)]; const s10 = [srcX(i + 1), srcY(j)]; const s01 = [srcX(i), srcY(j + 1)]; const s11 = [srcX(i + 1), srcY(j + 1)];
    tri(d00, d10, d11, s00, s10, s11);
    tri(d00, d11, d01, s00, s11, s01);
  }
  const sw = source.width; const sh = source.height;
  const sd = source.getContext('2d').getImageData(0, 0, sw, sh).data;
  const out = createCanvas(W, H);
  const oc = out.getContext('2d');
  const img = oc.createImageData(W, H);
  const od = img.data;
  const acc = [0, 0, 0, 0];
  for (let k = 0; k < W * H; k += 1) {
    const fx = su[k];
    if (fx !== fx) continue;
    const gx = fx - 0.5; const gy = sv[k] - 0.5;
    const ix = Math.floor(gx); const iy = Math.floor(gy);
    const tx = gx - ix; const ty = gy - iy;
    acc[0] = 0; acc[1] = 0; acc[2] = 0; acc[3] = 0;
    for (let q = 0; q < 4; q += 1) {
      const xx = ix + (q & 1); const yy = iy + (q >> 1);
      if (xx < 0 || yy < 0 || xx >= sw || yy >= sh) continue;
      const wgt = ((q & 1) ? tx : 1 - tx) * ((q >> 1) ? ty : 1 - ty);
      const p = (yy * sw + xx) * 4;
      const a = sd[p + 3] * wgt;
      acc[0] += sd[p] * a; acc[1] += sd[p + 1] * a; acc[2] += sd[p + 2] * a; acc[3] += a;
    }
    if (acc[3] <= 0) continue;
    const o = k * 4;
    od[o] = clamp255(Math.round(acc[0] / acc[3])); od[o + 1] = clamp255(Math.round(acc[1] / acc[3])); od[o + 2] = clamp255(Math.round(acc[2] / acc[3]));
    od[o + 3] = clamp255(Math.round(acc[3]));
  }
  oc.putImageData(img, 0, 0);
  return { canvas: out, x: x0, y: y0 };
}

/** Homography taking the unit square corners (0,0),(1,0),(1,1),(0,1) to the quad q (4 [x,y]). */
function squareToQuad(q) {
  const [[x0, y0], [x1, y1], [x2, y2], [x3, y3]] = q;
  const dx1 = x1 - x2; const dx2 = x3 - x2; const dy1 = y1 - y2; const dy2 = y3 - y2;
  const sx = x0 - x1 + x2 - x3; const sy = y0 - y1 + y2 - y3;
  let g = 0; let hh = 0;
  if (Math.abs(sx) > 1e-12 || Math.abs(sy) > 1e-12) {
    const den = dx1 * dy2 - dx2 * dy1;
    g = (sx * dy2 - dx2 * sy) / den; hh = (dx1 * sy - sx * dy1) / den;
  }
  const a = x1 - x0 + g * x1; const b = x3 - x0 + hh * x3; const c = x0;
  const d = y1 - y0 + g * y1; const e = y3 - y0 + hh * y3; const f = y0;
  return (u, v) => { const z = g * u + hh * v + 1; return [(a * u + b * v + c) / z, (d * u + e * v + f) / z]; };
}

// Warp presets (Photoshop's Warp styles), bend −1..1, on box (layer pixels).
const WARP_PRESETS = ['arc', 'arch', 'bulge', 'flag', 'wave', 'fisheye', 'rise', 'squeeze', 'twist'];
function presetMap(name, bend, box) {
  const b = bend; const { x, y, w, h } = box;
  return (u, v) => {
    let px = x + u * w; let py = y + v * h;
    const cu = 2 * u - 1; const cv = 2 * v - 1;
    switch (name) {
      case 'arc': py -= b * 0.5 * h * (1 - cu * cu) * (1 - 0.5 * v); break;
      case 'arch': py -= b * 0.5 * h * (1 - cu * cu); break;
      case 'bulge': px += b * 0.25 * w * cu * (1 - cv * cv); py += b * 0.25 * h * cv * (1 - cu * cu); break;
      case 'flag': py += b * 0.15 * h * Math.sin(Math.PI * 2 * u); break;
      case 'wave': py += b * 0.15 * h * Math.sin(Math.PI * 2 * u + v * Math.PI); px += b * 0.04 * w * Math.sin(Math.PI * 2 * v); break;
      case 'fisheye': { const r2 = Math.min(1, cu * cu + cv * cv); const k = 1 + b * 0.35 * (1 - r2); px = x + (0.5 + 0.5 * cu * k) * w; py = y + (0.5 + 0.5 * cv * k) * h; break; }
      case 'rise': py -= b * 0.3 * h * Math.sin(Math.PI * (u - 0.5)); break;
      case 'squeeze': px -= b * 0.25 * w * cu * (1 - cv * cv); break;
      case 'twist': { const r = Math.min(1, Math.hypot(cu, cv)); const ang = b * Math.PI * 0.5 * (1 - r); const cx = x + w / 2; const cy = y + h / 2; const ox = px - cx; const oy = py - cy; px = cx + ox * Math.cos(ang) - oy * Math.sin(ang); py = cy + ox * Math.sin(ang) + oy * Math.cos(ang); break; }
      default: break;
    }
    return [px, py];
  };
}

/** Bilinear interpolation of a user mesh: points row-major, (rows+1)×(cols+1), in layer pixels. */
function meshMap(rows, cols, points) {
  return (u, v) => {
    // Cells are clamped, s/t may run slightly past 0..1: the mesh extrapolates just outside its edge.
    const fx = u * cols; const fy = v * rows;
    const i = Math.min(cols - 1, Math.max(0, Math.floor(fx))); const j = Math.min(rows - 1, Math.max(0, Math.floor(fy)));
    const s = fx - i; const t = fy - j;
    const P = (a, b) => points[b * (cols + 1) + a];
    const p00 = P(i, j); const p10 = P(i + 1, j); const p01 = P(i, j + 1); const p11 = P(i + 1, j + 1);
    return [
      (1 - s) * (1 - t) * p00[0] + s * (1 - t) * p10[0] + (1 - s) * t * p01[0] + s * t * p11[0],
      (1 - s) * (1 - t) * p00[1] + s * (1 - t) * p10[1] + (1 - s) * t * p01[1] + s * t * p11[1],
    ];
  };
}

module.exports = { heal, bestOffset, warp, squareToQuad, presetMap, meshMap, WARP_PRESETS };
