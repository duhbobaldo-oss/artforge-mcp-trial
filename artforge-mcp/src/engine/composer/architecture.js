'use strict';

/**
 * Two-point perspective geometry used by the city composer: building boxes whose horizontal edges recede
 * to VP-left / VP-right on the horizon, a homography to map facade details onto each face so their spacing
 * foreshortens correctly, and a numeric check that every edge really meets its vanishing point.
 */

/** Line through a and b, evaluated at x. */
function atX(a, b, x) {
  return a.y + ((b.y - a.y) * (x - a.x)) / (b.x - a.x);
}

/** Homography mapping the unit square (u,v) to quad [p00, p10, p11, p01]. */
function homography(q) {
  const [p0, p1, p2, p3] = q;
  const dx1 = p1.x - p2.x; const dx2 = p3.x - p2.x; const dx3 = p0.x - p1.x + p2.x - p3.x;
  const dy1 = p1.y - p2.y; const dy2 = p3.y - p2.y; const dy3 = p0.y - p1.y + p2.y - p3.y;
  const den = dx1 * dy2 - dx2 * dy1;
  const g = (dx3 * dy2 - dx2 * dy3) / den;
  const h = (dx1 * dy3 - dx3 * dy1) / den;
  const a = p1.x - p0.x + g * p1.x; const b = p3.x - p0.x + h * p3.x; const c = p0.x;
  const d = p1.y - p0.y + g * p1.y; const e = p3.y - p0.y + h * p3.y; const f = p0.y;
  return (u, v) => {
    const w = g * u + h * v + 1;
    return { x: (a * u + b * v + c) / w, y: (d * u + e * v + f) / w };
  };
}

function box(P, o) {
  // Building block with its near vertical corner at x=cx, from yTop to yBase (base may be below eye level).
  const { vpL, vpR, cx, yTop, yBase, xLeft, xRight } = o;
  const corner = { top: { x: cx, y: yTop }, base: { x: cx, y: yBase } };
  const left = { top: { x: xLeft, y: atX(corner.top, vpL, xLeft) }, base: { x: xLeft, y: atX(corner.base, vpL, xLeft) } };
  const right = { top: { x: xRight, y: atX(corner.top, vpR, xRight) }, base: { x: xRight, y: atX(corner.base, vpR, xRight) } };
  return {
    leftFace: [left.top, corner.top, corner.base, left.base],
    rightFace: [corner.top, right.top, right.base, corner.base],
    corner,
    left,
    right,
  };
}

/** Numeric check: top and base edges of every face extend to their vanishing point (±1px). */
function verifyConvergence(faces, vpL, vpR) {
  let worst = 0;
  for (const f of faces) {
    for (const [a, b, vp] of [[f.left.top, f.corner.top, vpL], [f.left.base, f.corner.base, vpL], [f.corner.top, f.right.top, vpR], [f.corner.base, f.right.base, vpR]]) {
      const yAtVp = atX(a, b, vp.x);
      worst = Math.max(worst, Math.abs(yAtVp - vp.y));
    }
  }
  return { maxVanishingErrorPx: Number(worst.toFixed(3)) };
}

module.exports = { homography, box, verifyConvergence };
