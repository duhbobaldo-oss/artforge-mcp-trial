'use strict';

const { darken, lighten, rgba } = require('../color');

/** Desktop still life. Shared oblique projection keeps page edges and ruled lines coherent. */
function composeStillLife(P, ctx) {
  const { W, H } = P;
  const want = (id) => ctx.intent.elements.some((e) => e.id === id);
  const wood = ctx.palette.wood;
  const pt = (x, y) => ({ x: x * W, y: y * H });
  const poly = (layer, points, params, el) => P.poly(layer, points.map(([x, y]) => pt(x, y)), params, el);
  const line = (layer, a, b, params, el) => P.line(layer, { x1: a.x, y1: a.y, x2: b.x, y2: b.y, ...params }, el);
  const gradient = (a, b) => ({ type: 'linear', angle: 90, stops: [{ offset: 0, color: a }, { offset: 1, color: b }] });
  P.layer('surface', 'سطح المكتب');
  P.layer('contact', 'ظلال التلامس');
  P.layer('objects', 'الدفتر والأقلام');
  P.rect('surface', { x: 0, y: 0, w: W, h: H, fill: gradient(lighten(wood, 0.28), darken(wood, 0.16)) }, 'desk');
  for (let i = 0; i < 8; i += 1) {
    const y = H * i / 8;
    P.rect('surface', { x: 0, y, w: W, h: H / 8, fill: rgba(i % 2 ? '#ffffff' : '#000000', 0.035) }, 'desk');
    P.line('surface', { x1: 0, y1: y, x2: W, y2: y, stroke: rgba(darken(wood, 0.6), 0.25), strokeWidth: 1 }, 'desk');
  }
  for (let i = 0; i < 65; i += 1) {
    const y = P.rand(0, H);
    P.blob('surface', [pt(-0.05, y / H), pt(0.2, (y + P.rand(-8, 8)) / H), pt(0.65, (y + P.rand(-5, 5)) / H), pt(1.05, y / H)], { stroke: rgba(i % 3 ? darken(wood, 0.5) : lighten(wood, 0.6), P.rand(0.06, 0.16)), strokeWidth: P.rand(0.5, 1.5), fill: null }, 'desk', 'wood grain', false);
  }
  if (want('notebook')) {
    P.soft('contact', W * 0.49, H * 0.59, W * 0.67, H * 0.54, 'rgba(25,15,10,0.32)', W * 0.018, 'notebook', 'soft cast shadow, away from upper-left light');
    poly('objects', [[0.17, 0.3], [0.69, 0.24], [0.82, 0.7], [0.29, 0.79]], { fill: darken(ctx.roles.accent, 0.3), stroke: darken(wood, 0.6), strokeWidth: 2 }, 'notebook');
    for (let i = 4; i >= 0; i -= 1) {
      const d = i * 0.002;
      poly('objects', [[0.18, 0.29 + d], [0.685, 0.235 + d], [0.8, 0.69 + d], [0.295, 0.775 + d]], { fill: i % 2 ? '#d1c9b7' : '#eee6d4', stroke: '#b4aa96', strokeWidth: 0.6 }, 'notebook');
    }
    // Both pages share the same spine; page rules are transformed through that same projection.
    const left = [pt(0.18, 0.285), pt(0.43, 0.285), pt(0.545, 0.7), pt(0.295, 0.765)];
    const right = [pt(0.43, 0.285), pt(0.685, 0.23), pt(0.8, 0.685), pt(0.545, 0.7)];
    P.poly('objects', left, { fill: gradient('#fffdf4', '#e8e1d1') }, 'notebook');
    P.poly('objects', right, { fill: gradient('#fcf9ee', '#f0eada') }, 'notebook');
    const at = (q, u, v) => ({ x: (1-v)*((1-u)*q[0].x+u*q[1].x)+v*((1-u)*q[3].x+u*q[2].x), y: (1-v)*((1-u)*q[0].y+u*q[1].y)+v*((1-u)*q[3].y+u*q[2].y) });
    for (const page of [left, right]) {
      for (let row = 0; row < 16; row += 1) {
        const v = 0.12 + row * 0.05;
        line('objects', at(page, 0.08, v), at(page, 0.92, v), { stroke: 'rgba(85,123,152,0.23)', strokeWidth: Math.max(0.5, W / 1800) }, 'notebook');
      }
    }
    line('objects', left[1], left[2], { stroke: 'rgba(70,54,30,0.3)', strokeWidth: W * 0.007, blur: W * 0.004 }, 'notebook');
    line('objects', left[1], left[2], { stroke: '#b7aa91', strokeWidth: 1 }, 'notebook');
    poly('objects', [[0.438, 0.30], [0.447, 0.30], [0.565, 0.76], [0.552, 0.75]], { fill: darken(ctx.roles.accent, 0.1) }, 'notebook');
  }
  if (want('pen')) {
    const count = ctx.intent.elements.find((e) => e.id === 'pen').count || 2;
    if (count > 5) { const error = new Error('Desktop pen layout supports at most five distinct pens'); error.code = 'ELEMENT_COUNT_OVERFLOW'; throw error; }
    for (let i = 0; i < count; i += 1) {
      const start = P.ops.length;
      const a = pt(0.77 + i * 0.035, 0.26 + i * 0.055);
      const b = pt(0.86 + i * 0.025, 0.56 + i * 0.055);
      const width = W * 0.011;
      line('contact', { x: a.x + W * 0.008, y: a.y + H * 0.012 }, { x: b.x + W * 0.008, y: b.y + H * 0.012 }, { stroke: 'rgba(0,0,0,0.3)', strokeWidth: width * 1.3, blur: width * 0.6 }, 'pen');
      line('objects', a, b, { stroke: i ? '#27313c' : ctx.roles.accent, strokeWidth: width, cap: 'round' }, 'pen');
      line('objects', { x: a.x - width * 0.2, y: a.y }, { x: b.x - width * 0.2, y: b.y }, { stroke: 'rgba(255,255,255,0.45)', strokeWidth: width * 0.18 }, 'pen');
      const tip = { x: b.x + W * 0.009, y: b.y + H * 0.025 };
      P.poly('objects', [{ x: b.x - width * 0.5, y: b.y }, { x: b.x + width * 0.5, y: b.y }, tip], { fill: '#d6b88a', stroke: '#65503b', strokeWidth: 0.5 }, 'pen');
      line('objects', tip, { x: tip.x + W * 0.002, y: tip.y + H * 0.005 }, { stroke: '#292724', strokeWidth: 2 }, 'pen');
      // Explicit instance grouping: a pen consists of several primitives, not six pens.
      const indexes = P.elements.get('pen');
      const instanceOps = indexes.filter((index) => index >= start);
      P.elements.set(`pen_${i + 1}`, instanceOps);
      P.elements.set('pen', indexes.filter((index) => index < start));
      for (const index of instanceOps) P.ops[index].element = `pen_${i + 1}`;
    }
  }
  return { mode: 'procedural-still-life', perspective: { type: 'shared-oblique-page-projection' }, lighting: { source: 'upper-left', shadows: 'lower-right' }, visualReview: 'required' };
}

module.exports = { composeStillLife };
