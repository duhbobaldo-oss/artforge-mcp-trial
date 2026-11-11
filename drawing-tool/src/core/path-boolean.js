'use strict';

/**
 * Exact Boolean path operations and stroke outlining with Skia PathOps (@napi-rs/canvas Path2D).
 * Curves stay curves (no polygon flattening); holes and self-intersections follow Skia's resolution.
 * Node only (not part of the browser bundle).
 */

const { Path2D, PathOp, StrokeCap, StrokeJoin } = require('@napi-rs/canvas');
const { assert } = require('./errors');

const K = 0.5522847498307936; // cubic approximation of a quarter circle
const OPS = { union: PathOp.Union, subtract: PathOp.Difference, intersect: PathOp.Intersect, exclude: PathOp.Xor };

function ellipseSegments(x, y, w, h) {
  const rx = w / 2, ry = h / 2, cx = x + rx, cy = y + ry, ox = rx * K, oy = ry * K;
  return [
    { op: 'M', x: cx + rx, y: cy },
    { op: 'C', c1x: cx + rx, c1y: cy + oy, c2x: cx + ox, c2y: cy + ry, x: cx, y: cy + ry },
    { op: 'C', c1x: cx - ox, c1y: cy + ry, c2x: cx - rx, c2y: cy + oy, x: cx - rx, y: cy },
    { op: 'C', c1x: cx - rx, c1y: cy - oy, c2x: cx - ox, c2y: cy - ry, x: cx, y: cy - ry },
    { op: 'C', c1x: cx + ox, c1y: cy - ry, c2x: cx + rx, c2y: cy - oy, x: cx + rx, y: cy },
    { op: 'Z' },
  ];
}

function rectSegments(x, y, w, h, radius) {
  const r = Math.min(Math.max(0, Number(Array.isArray(radius) ? radius[0] : radius) || 0), Math.abs(w) / 2, Math.abs(h) / 2);
  if (!r) return [{ op: 'M', x, y }, { op: 'L', x: x + w, y }, { op: 'L', x: x + w, y: y + h }, { op: 'L', x, y: y + h }, { op: 'Z' }];
  const o = r * (1 - K);
  return [
    { op: 'M', x: x + r, y },
    { op: 'L', x: x + w - r, y },
    { op: 'C', c1x: x + w - o, c1y: y, c2x: x + w, c2y: y + o, x: x + w, y: y + r },
    { op: 'L', x: x + w, y: y + h - r },
    { op: 'C', c1x: x + w, c1y: y + h - o, c2x: x + w - o, c2y: y + h, x: x + w - r, y: y + h },
    { op: 'L', x: x + r, y: y + h },
    { op: 'C', c1x: x + o, c1y: y + h, c2x: x, c2y: y + h - o, x, y: y + h - r },
    { op: 'L', x, y: y + r },
    { op: 'C', c1x: x, c1y: y + o, c2x: x + o, c2y: y, x: x + r, y },
    { op: 'Z' },
  ];
}

/** An object's outline as path segments in its own coordinates (before rotation). */
function objectSegments(object) {
  switch (object.type) {
    case 'rect': return rectSegments(object.x, object.y, object.w, object.h, object.radius);
    case 'ellipse': return ellipseSegments(object.x, object.y, object.w, object.h);
    case 'polygon': return object.points.map((p, i) => ({ op: i ? 'L' : 'M', x: p.x, y: p.y })).concat(object.closed === false ? [] : [{ op: 'Z' }]);
    case 'path': {
      const segs = object.segments.map((s) => Object.assign({}, s));
      if (object.closed && segs[segs.length - 1].op !== 'Z') segs.push({ op: 'Z' });
      return segs;
    }
    default:
      assert(false, 'UNSUPPORTED_SHAPE', `object type "${object.type}" has no fillable outline for path operations (use rect, ellipse, polygon or path; text outlines come later)`, { type: object.type });
      return null;
  }
}

function toPath2D(segments) {
  const p = new Path2D();
  for (const s of segments) {
    if (s.op === 'M') p.moveTo(s.x, s.y);
    else if (s.op === 'L') p.lineTo(s.x, s.y);
    else if (s.op === 'Q') p.quadraticCurveTo(s.cx, s.cy, s.x, s.y);
    else if (s.op === 'C') p.bezierCurveTo(s.c1x, s.c1y, s.c2x, s.c2y, s.x, s.y);
    else if (s.op === 'Z') p.closePath();
  }
  return p;
}

/** Parse Skia's absolute SVG path output (M, L, Q, C, Z) back into ArtForge segments. */
function fromSvg(d) {
  const tokens = String(d).match(/[MLQCZmlqcz]|-?\d*\.?\d+(?:e[-+]?\d+)?/g) || [];
  const out = [];
  let i = 0;
  let cmd = null;
  const n = () => Number(tokens[i++]);
  while (i < tokens.length) {
    if (/[A-Za-z]/.test(tokens[i])) cmd = tokens[i++];
    assert(cmd && cmd === cmd.toUpperCase(), 'PATH_PARSE', `unexpected path command ${cmd}`);
    if (cmd === 'Z') { out.push({ op: 'Z' }); continue; }
    if (cmd === 'M' || cmd === 'L') out.push({ op: cmd, x: n(), y: n() });
    else if (cmd === 'Q') out.push({ op: 'Q', cx: n(), cy: n(), x: n(), y: n() });
    else if (cmd === 'C') out.push({ op: 'C', c1x: n(), c1y: n(), c2x: n(), c2y: n(), x: n(), y: n() });
    if (cmd === 'M') cmd = 'L'; // implicit lineto after moveto
  }
  return out.map((s) => {
    const r = { op: s.op };
    for (const k of Object.keys(s)) if (k !== 'op') r[k] = Math.round(s[k] * 1000) / 1000;
    return r;
  });
}

/**
 * Combine outlines. items: [{ segments, matrix }] where matrix maps the item into a shared space.
 * op: union | subtract (first minus the rest) | intersect | exclude. `toTarget` maps the result back.
 */
function combine(items, op, toTarget) {
  assert(OPS[op] !== undefined, 'INVALID_PATH_OP', 'op must be union, subtract, intersect or exclude', { received: op });
  assert(items.length >= 2, 'INVALID_PATH_OP', 'path operations need at least two shapes');
  const paths = items.map((item) => toPath2D(item.segments).transform(item.matrix));
  const result = paths[0];
  for (const p of paths.slice(1)) result.op(p, OPS[op]);
  result.asWinding();
  if (toTarget) result.transform(toTarget);
  return fromSvg(result.toSVGString());
}

/** Outline a stroke into a fillable shape (caps, joins and miter limit as drawn). */
function outlineStroke(segments, matrix, style, toTarget) {
  const p = toPath2D(segments).transform(matrix);
  // Dashes first (as drawn: on/off lengths from the object's dash array), then the stroke outline.
  if (Array.isArray(style.dash) && style.dash.length >= 2) p.dash(Number(style.dash[0]), Number(style.dash[1]), 0);
  const cap = { butt: StrokeCap.Butt, round: StrokeCap.Round, square: StrokeCap.Square }[style.cap || 'butt'];
  const join = { miter: StrokeJoin.Miter, round: StrokeJoin.Round, bevel: StrokeJoin.Bevel }[style.join || 'miter'];
  assert(cap !== undefined && join !== undefined, 'INVALID_PATH_OP', 'cap must be butt/round/square and join miter/round/bevel');
  p.stroke({ width: style.width, cap, join, miterLimit: style.miterLimit || 10 });
  p.simplify();
  p.asWinding();
  if (toTarget) p.transform(toTarget);
  return fromSvg(p.toSVGString());
}

module.exports = { objectSegments, combine, outlineStroke, fromSvg, ellipseSegments, rectSegments };
