'use strict';

/**
 * Bézier anchor editing on ArtForge path segments ({op: M|L|Q|C|Z}), the operations of a pen tool:
 * list anchors with their handles, move an anchor or a handle, split a segment (add anchor), delete an
 * anchor, convert corner ↔ smooth. Pure functions: they return new segment arrays.
 *
 * Anchor k is the end point of the k-th drawing segment (M, L, Q or C). Its in-handle is the second
 * control point of the segment ending at it; its out-handle is the first control point of the next one.
 * Quadratic segments are raised to cubic when one of their handles is edited (same curve).
 */

const { assert } = require('./errors');

const isDrawing = (seg) => seg.op === 'M' || seg.op === 'L' || seg.op === 'Q' || seg.op === 'C';
const lerp = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
const copy = (segments) => segments.map((s) => Object.assign({}, s));

function anchorSegmentIndexes(segments) {
  const out = [];
  segments.forEach((s, i) => { if (isDrawing(s)) out.push(i); });
  return out;
}

// Start point of the segment at index i (end point of the previous drawing segment).
function startOf(segments, i) {
  for (let j = i - 1; j >= 0; j -= 1) if (isDrawing(segments[j])) return { x: segments[j].x, y: segments[j].y };
  return null;
}

// Start of the subpath that contains segment i (the M it belongs to).
function subpathStart(segments, i) {
  for (let j = i; j >= 0; j -= 1) if (segments[j].op === 'M') return { x: segments[j].x, y: segments[j].y, index: j };
  return null;
}

/** Raise segment i (Q or L) to an equivalent cubic. */
function toCubic(segments, i) {
  const s = segments[i];
  if (s.op === 'C') return;
  const p0 = startOf(segments, i);
  const p3 = { x: s.x, y: s.y };
  if (s.op === 'Q') {
    const q = { x: s.cx, y: s.cy };
    segments[i] = { op: 'C', c1x: p0.x + (2 / 3) * (q.x - p0.x), c1y: p0.y + (2 / 3) * (q.y - p0.y), c2x: p3.x + (2 / 3) * (q.x - p3.x), c2y: p3.y + (2 / 3) * (q.y - p3.y), x: p3.x, y: p3.y };
  } else if (s.op === 'L') {
    segments[i] = { op: 'C', c1x: p0.x, c1y: p0.y, c2x: p3.x, c2y: p3.y, x: p3.x, y: p3.y };
  }
}

function handleType(anchor) {
  if (!anchor.in || !anchor.out) return 'corner';
  const a = Math.atan2(anchor.y - anchor.in.y, anchor.x - anchor.in.x);
  const b = Math.atan2(anchor.out.y - anchor.y, anchor.out.x - anchor.x);
  const zeroIn = Math.hypot(anchor.x - anchor.in.x, anchor.y - anchor.in.y) < 1e-6;
  const zeroOut = Math.hypot(anchor.out.x - anchor.x, anchor.out.y - anchor.y) < 1e-6;
  if (zeroIn || zeroOut) return 'corner';
  let d = Math.abs(a - b) % (2 * Math.PI);
  if (d > Math.PI) d = 2 * Math.PI - d;
  return d < 2 * Math.PI / 180 ? 'smooth' : 'corner';
}

function listAnchors(segments) {
  return anchorSegmentIndexes(segments).map((si, index) => {
    const s = segments[si];
    const next = segments[si + 1];
    const anchor = { index, segment: si, op: s.op, x: s.x, y: s.y, in: null, out: null };
    if (s.op === 'C') anchor.in = { x: s.c2x, y: s.c2y };
    if (s.op === 'Q') anchor.in = { x: s.cx, y: s.cy };
    if (next && next.op === 'C') anchor.out = { x: next.c1x, y: next.c1y };
    if (next && next.op === 'Q') anchor.out = { x: next.cx, y: next.cy };
    anchor.type = handleType(anchor);
    return anchor;
  });
}

function requireAnchor(segments, index) {
  const indexes = anchorSegmentIndexes(segments);
  assert(Number.isInteger(index) && index >= 0 && index < indexes.length, 'INVALID_ANCHOR',
    `anchor index must be between 0 and ${indexes.length - 1}`, { received: index });
  return indexes[index];
}

/**
 * Move an anchor (its handles travel with it) and/or set its handles.
 * change: { x?, y?, in?: {x,y}, out?: {x,y}, keepSmooth?: true } — with keepSmooth a smooth anchor keeps its
 * opposite handle collinear (length kept) when one handle moves, like dragging a smooth point's handle.
 */
function updateAnchor(segments, index, change) {
  const out = copy(segments);
  const si = requireAnchor(out, index);
  const before = listAnchors(segments)[index];
  const next = out[si + 1] && (out[si + 1].op === 'C' || out[si + 1].op === 'Q' || out[si + 1].op === 'L') ? si + 1 : -1;
  if (change.x !== undefined || change.y !== undefined) {
    const dx = (change.x === undefined ? out[si].x : Number(change.x)) - out[si].x;
    const dy = (change.y === undefined ? out[si].y : Number(change.y)) - out[si].y;
    if (out[si].op === 'Q') toCubic(out, si);
    if (next >= 0 && out[next].op === 'Q') toCubic(out, next);
    out[si].x += dx; out[si].y += dy;
    if (out[si].op === 'C') { out[si].c2x += dx; out[si].c2y += dy; }
    if (next >= 0 && out[next].op === 'C') { out[next].c1x += dx; out[next].c1y += dy; }
    // Moving the first anchor of a closed subpath also moves a last point drawn exactly onto it.
    if (out[si].op === 'M') {
      let j = si + 1;
      while (j < out.length && out[j].op !== 'M' && out[j].op !== 'Z') j += 1;
      const last = j - 1;
      if (j < out.length && out[j].op === 'Z' && last > si && segments[last].x === segments[si].x && segments[last].y === segments[si].y) {
        out[last].x += dx; out[last].y += dy;
        if (out[last].op === 'C') { out[last].c2x += dx; out[last].c2y += dy; }
      }
    }
  }
  const keepSmooth = change.keepSmooth !== false && before.type === 'smooth';
  const anchorPt = { x: out[si].x, y: out[si].y };
  const setIn = (h) => { assert(out[si].op !== 'M', 'INVALID_ANCHOR', 'the first anchor of a subpath has no in-handle'); toCubic(out, si); out[si].c2x = Number(h.x); out[si].c2y = Number(h.y); };
  const setOut = (h) => { assert(next >= 0, 'INVALID_ANCHOR', 'this anchor has no following segment for an out-handle'); toCubic(out, next); out[next].c1x = Number(h.x); out[next].c1y = Number(h.y); };
  const mirror = (h, from) => {
    const len = Math.hypot(from.x - anchorPt.x, from.y - anchorPt.y);
    const d = Math.hypot(h.x - anchorPt.x, h.y - anchorPt.y) || 1;
    return { x: anchorPt.x - (h.x - anchorPt.x) / d * len, y: anchorPt.y - (h.y - anchorPt.y) / d * len };
  };
  if (change.in) {
    setIn(change.in);
    if (keepSmooth && !change.out && before.out) setOut(mirror(change.in, { x: before.out.x + (anchorPt.x - before.x), y: before.out.y + (anchorPt.y - before.y) }));
  }
  if (change.out) {
    setOut(change.out);
    if (keepSmooth && !change.in && before.in) setIn(mirror(change.out, { x: before.in.x + (anchorPt.x - before.x), y: before.in.y + (anchorPt.y - before.y) }));
  }
  return out;
}

function splitCubic(p0, c1, c2, p3, t) {
  const a = lerp(p0, c1, t), b = lerp(c1, c2, t), c = lerp(c2, p3, t);
  const d = lerp(a, b, t), e = lerp(b, c, t), f = lerp(d, e, t);
  return [{ op: 'C', c1x: a.x, c1y: a.y, c2x: d.x, c2y: d.y, x: f.x, y: f.y }, { op: 'C', c1x: e.x, c1y: e.y, c2x: c.x, c2y: c.y, x: p3.x, y: p3.y }];
}

/** Add an anchor by splitting the segment at index `segment` (an L, Q, C or the closing Z) at t (0..1). */
function addAnchor(segments, segment, t) {
  const out = copy(segments);
  const tt = t === undefined ? 0.5 : Number(t);
  assert(Number.isFinite(tt) && tt > 0 && tt < 1, 'INVALID_ANCHOR', 't must be between 0 and 1 (exclusive)');
  assert(Number.isInteger(segment) && segment >= 0 && segment < out.length, 'INVALID_ANCHOR', `segment must be between 0 and ${out.length - 1}`);
  const s = out[segment];
  assert(s.op !== 'M', 'INVALID_ANCHOR', 'an M segment only moves the pen; split the segment after it');
  const p0 = startOf(out, segment);
  if (s.op === 'Z') {
    // The closing edge: insert only the new point; Z still closes from it back to the start.
    const start = subpathStart(out, segment);
    out.splice(segment, 0, Object.assign({ op: 'L' }, lerp(p0, start, tt)));
  } else if (s.op === 'L') {
    out.splice(segment, 1, Object.assign({ op: 'L' }, lerp(p0, s, tt)), { op: 'L', x: s.x, y: s.y });
  } else {
    toCubic(out, segment);
    const c = out[segment];
    out.splice(segment, 1, ...splitCubic(p0, { x: c.c1x, y: c.c1y }, { x: c.c2x, y: c.c2y }, { x: c.x, y: c.y }, tt));
  }
  return out;
}

/** Delete anchor `index`; the curve joins its neighbours, keeping their outer handles. */
function deleteAnchor(segments, index) {
  const out = copy(segments);
  const si = requireAnchor(out, index);
  assert(anchorSegmentIndexes(out).length > 2, 'INVALID_ANCHOR', 'a path needs at least two anchors');
  const s = out[si];
  const next = out[si + 1];
  if (s.op === 'M') {
    assert(next && isDrawing(next), 'INVALID_ANCHOR', 'cannot delete the only anchor of a subpath');
    out.splice(si, 2, { op: 'M', x: next.x, y: next.y });
    return out;
  }
  if (!next || !isDrawing(next) || next.op === 'M') { out.splice(si, 1); return out; }
  if (s.op === 'L' && next.op === 'L') { out.splice(si, 1); return out; }
  toCubic(out, si);
  toCubic(out, si + 1);
  const a = out[si];
  const b = out[si + 1];
  out.splice(si, 2, { op: 'C', c1x: a.c1x, c1y: a.c1y, c2x: b.c2x, c2y: b.c2y, x: b.x, y: b.y });
  return out;
}

/** corner: retract both handles onto the anchor. smooth: collinear handles along the neighbours' direction. */
function convertAnchor(segments, index, type) {
  assert(type === 'corner' || type === 'smooth', 'INVALID_ANCHOR', 'type must be corner or smooth', { received: type });
  const out = copy(segments);
  const si = requireAnchor(out, index);
  const anchor = { x: out[si].x, y: out[si].y };
  const hasNext = out[si + 1] && (out[si + 1].op === 'L' || out[si + 1].op === 'Q' || out[si + 1].op === 'C');
  const hasPrev = out[si].op !== 'M';
  if (type === 'corner') {
    if (hasPrev && out[si].op !== 'L') { toCubic(out, si); out[si].c2x = anchor.x; out[si].c2y = anchor.y; }
    if (hasNext && out[si + 1].op !== 'L') { toCubic(out, si + 1); out[si + 1].c1x = anchor.x; out[si + 1].c1y = anchor.y; }
    return out;
  }
  const prev = hasPrev ? startOf(out, si) : null;
  const nextPt = hasNext ? { x: out[si + 1].x, y: out[si + 1].y } : null;
  const a = prev || anchor;
  const b = nextPt || anchor;
  let dx = b.x - a.x;
  let dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  dx /= len; dy /= len;
  if (hasPrev) {
    const l = Math.hypot(anchor.x - prev.x, anchor.y - prev.y) / 3;
    toCubic(out, si);
    out[si].c2x = anchor.x - dx * l; out[si].c2y = anchor.y - dy * l;
  }
  if (hasNext) {
    const l = Math.hypot(nextPt.x - anchor.x, nextPt.y - anchor.y) / 3;
    toCubic(out, si + 1);
    out[si + 1].c1x = anchor.x + dx * l; out[si + 1].c1y = anchor.y + dy * l;
  }
  return out;
}

module.exports = { listAnchors, updateAnchor, addAnchor, deleteAnchor, convertAnchor, toCubic };
