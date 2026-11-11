'use strict';

/**
 * Plan builder used by every composer: records drawing-tool operations with their layer alias,
 * the visual element they belong to, and a note. Indexes are returned so evidence can point at ops.
 */

function rng(seed) {
  let a = (Number(seed) >>> 0) || 1;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seedFrom(text) {
  let h = 2166136261;
  for (const ch of String(text)) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Catmull-Rom through points → cubic Bezier path segments (closed or open). */
function smoothSegments(points, closed, tension) {
  const t = tension === undefined ? 1 : tension;
  const n = points.length;
  const at = (i) => (closed ? points[(i + n) % n] : points[Math.max(0, Math.min(n - 1, i))]);
  const segs = [{ op: 'M', x: r2(points[0].x), y: r2(points[0].y) }];
  const count = closed ? n : n - 1;
  for (let i = 0; i < count; i += 1) {
    const p0 = at(i - 1); const p1 = at(i); const p2 = at(i + 1); const p3 = at(i + 2);
    segs.push({
      op: 'C',
      c1x: r2(p1.x + ((p2.x - p0.x) / 6) * t), c1y: r2(p1.y + ((p2.y - p0.y) / 6) * t),
      c2x: r2(p2.x - ((p3.x - p1.x) / 6) * t), c2y: r2(p2.y - ((p3.y - p1.y) / 6) * t),
      x: r2(p2.x), y: r2(p2.y),
    });
  }
  return segs;
}

function r2(v) {
  return Math.round(v * 100) / 100;
}

class PlanBuilder {
  constructor(options) {
    this.W = options.width;
    this.H = options.height;
    this.ops = [];
    this.random = rng(options.seed || 1);
    this.ev = options.evidence;
    this.elements = new Map();
  }

  layer(alias, name, extra) {
    return this.push({ op: 'layer.add', alias, note: `layer: ${name}`, params: Object.assign({ name }, extra || {}) });
  }

  push(entry) {
    this.ops.push(entry);
    const index = this.ops.length - 1;
    if (entry.element) {
      const list = this.elements.get(entry.element) || [];
      list.push(index);
      this.elements.set(entry.element, list);
    }
    return index;
  }

  draw(op, layer, params, element, note) {
    return this.push({ op, note: note || element || op, element: element || null, params: Object.assign({ layer }, params) });
  }

  rect(layer, p, el, note) { return this.draw('draw.rect', layer, p, el, note); }
  ellipse(layer, p, el, note) { return this.draw('draw.ellipse', layer, p, el, note); }
  line(layer, p, el, note) { return this.draw('draw.line', layer, p, el, note); }
  text(layer, p, el, note) { return this.draw('draw.text', layer, p, el, note); }
  brush(layer, p, el, note) { return this.draw('draw.brush', layer, p, el, note); }

  poly(layer, points, p, el, note) {
    return this.draw('draw.polygon', layer, Object.assign({ points: points.map((q) => ({ x: r2(q.x), y: r2(q.y) })) }, p), el, note);
  }

  /** Smooth closed/open organic shape through points (Bezier). */
  blob(layer, points, p, el, note, closed) {
    const isClosed = closed !== false;
    return this.draw('draw.path', layer, Object.assign({ segments: smoothSegments(points, isClosed), closed: isClosed }, p), el, note);
  }

  grad(layer, p, el, note) { return this.draw('draw.gradient', layer, p, el, note); }

  /** Soft blurred ellipse: contact shadows, glows, light pools. */
  soft(layer, cx, cy, w, h, fill, blur, el, note, extra) {
    return this.ellipse(layer, Object.assign({ x: r2(cx - w / 2), y: r2(cy - h / 2), w: r2(w), h: r2(h), fill, blur }, extra || {}), el, note);
  }

  rand(min, max) {
    return min + (max - min) * this.random();
  }

  pick(list) {
    return list[Math.floor(this.random() * list.length) % list.length];
  }
}

module.exports = { PlanBuilder, rng, seedFrom, smoothSegments, r2 };
