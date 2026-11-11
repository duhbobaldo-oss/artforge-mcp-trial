'use strict';

/**
 * Exact Euclidean distance fields of a layer's alpha (Felzenszwalb & Huttenlocher, linear time).
 * Layer styles measure edges with these instead of blur-and-threshold, so a 3 px stroke is 3 px,
 * spread/choke grow or shrink a shape by true distances, and the bevel height map follows the shape.
 *
 * Distances are to the shape boundary (not pixel centres), with anti-aliased edge pixels placed by
 * their coverage, so results are accurate to roughly half a pixel.
 */

const INF = 1e20;

// 1-D squared distance transform of f[0..n) into d (lower envelope of parabolas).
function edt1d(f, n, d, v, z) {
  let k = 0;
  v[0] = 0;
  z[0] = -INF;
  z[1] = INF;
  for (let q = 1; q < n; q += 1) {
    let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) {
      k -= 1;
      s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    k += 1;
    v[k] = q;
    z[k] = s;
    z[k + 1] = INF;
  }
  k = 0;
  for (let q = 0; q < n; q += 1) {
    while (z[k + 1] < q) k += 1;
    const dq = q - v[k];
    d[q] = dq * dq + f[v[k]];
  }
}

/** Squared distance from every pixel to the nearest pixel where `feature(i)` is true. */
function squaredDistance(w, h, feature) {
  const grid = new Float64Array(w * h);
  for (let i = 0; i < grid.length; i += 1) grid[i] = feature(i) ? 0 : INF;
  const n = Math.max(w, h);
  const f = new Float64Array(n);
  const d = new Float64Array(n);
  const v = new Int32Array(n);
  const z = new Float64Array(n + 1);
  for (let x = 0; x < w; x += 1) {
    for (let y = 0; y < h; y += 1) f[y] = grid[y * w + x];
    edt1d(f, h, d, v, z);
    for (let y = 0; y < h; y += 1) grid[y * w + x] = d[y];
  }
  for (let y = 0; y < h; y += 1) {
    const row = y * w;
    for (let x = 0; x < w; x += 1) f[x] = grid[row + x];
    edt1d(f, w, d, v, z);
    for (let x = 0; x < w; x += 1) grid[row + x] = d[x];
  }
  return grid;
}

/**
 * alpha: Float32Array of coverage 0..1 (length w*h).
 * Returns { outside, inside }: distance from each pixel centre to the shape boundary, measured
 * outward for pixels outside the shape (0 inside) and inward for pixels inside it (0 outside).
 */
function distanceFields(alpha, w, h) {
  const inShape = (i) => alpha[i] >= 0.5;
  const toInside = squaredDistance(w, h, inShape);
  const toOutside = squaredDistance(w, h, (i) => !inShape(i));
  const outside = new Float32Array(w * h);
  const inside = new Float32Array(w * h);
  for (let i = 0; i < alpha.length; i += 1) {
    const a = alpha[i];
    if (a >= 0.5) {
      // Partly covered edge pixel: the boundary crosses it; otherwise it is half a pixel beyond the
      // centre of the nearest outside pixel's shared edge.
      inside[i] = a < 1 ? a - 0.5 : Math.sqrt(toOutside[i]) - 0.5;
    } else {
      outside[i] = a > 0 ? 0.5 - a : Math.sqrt(toInside[i]) - 0.5;
    }
  }
  return { outside, inside };
}

module.exports = { distanceFields, squaredDistance };
