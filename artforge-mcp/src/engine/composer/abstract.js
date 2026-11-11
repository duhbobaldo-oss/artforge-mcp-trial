'use strict';

/**
 * Abstract / decorative art, drawn ONLY from the selected reference palette's swatches (no mixing toward
 * fixed colours): this is where the colour reference is applied literally.
 *   geometric  Bauhaus relief: discs, half-discs, arcs, hairlines, cut panels with paper drop shadows
 *   clay       soft 3D "clay UI": rounded tiles, pills, spheres, layered waves with large soft shadows
 *   fluid      flowing ribbons with gradient + highlight edge, smoke wisps, glossy spheres, speckles
 *   splash     glossy paint splashes with spikes and droplets over a split light/dark ground
 * Composition rules (dominance, odd accents, rhythm, value contrast) are recorded as evidence.
 */

const { mix, darken, lighten, rgba } = require('../color');
const { hexToOklab, lch } = require('../swatches');

const TAU = Math.PI * 2;
const r2 = (v) => Math.round(v * 100) / 100;

/** Palette swatches → roles: ground, ink, accents ordered by chroma. Every role is an actual swatch. */
function paletteRoles(colors, wantDark) {
  const sw = colors.map((hex) => Object.assign({ hex }, lch(hexToOklab(hex))));
  const byL = sw.slice().sort((a, b) => a.L - b.L);
  const darkGround = wantDark === undefined ? (sw.reduce((s, c) => s + c.L, 0) / sw.length) < 0.45 : wantDark;
  const neutral = sw.filter((c) => c.C < 0.05);
  const ground = darkGround
    ? (neutral.filter((c) => c.L < 0.3).sort((a, b) => a.L - b.L)[0] || byL[0])
    : (neutral.filter((c) => c.L > 0.82).sort((a, b) => b.L - a.L)[0] || byL[byL.length - 1]);
  const ink = darkGround ? byL[byL.length - 1] : byL[0];
  let accents = sw.filter((c) => c !== ground && c !== ink && c.C > 0.035).sort((a, b) => b.C - a.C);
  if (accents.length < 3) accents = accents.concat(sw.filter((c) => c !== ground && !accents.includes(c)).sort((a, b) => Math.abs(b.L - ground.L) - Math.abs(a.L - ground.L)));
  if (!accents.length) accents = [ink];
  return { ground: ground.hex, ink: ink.hex, accents: accents.map((c) => c.hex), darkGround, all: sw.map((c) => c.hex) };
}

const circlePts = (cx, cy, r, a0, a1, n) => {
  const pts = [];
  const steps = n || Math.max(12, Math.round(Math.abs(a1 - a0) * r / 8));
  for (let i = 0; i <= steps; i += 1) { const a = a0 + ((a1 - a0) * i) / steps; pts.push({ x: r2(cx + Math.cos(a) * r), y: r2(cy + Math.sin(a) * r) }); }
  return pts;
};
const pathOf = (pts, closed) => ({ segments: pts.map((p, i) => ({ op: i ? 'L' : 'M', x: p.x, y: p.y })).concat(closed ? [{ op: 'Z' }] : []), closed: !!closed });

/** Disc with a gentle lit-from-upper-left gradient (paper relief). */
function disc(P, layer, cx, cy, r, color, shadow, note) {
  return P.ellipse(layer, { x: r2(cx - r), y: r2(cy - r), w: r2(2 * r), h: r2(2 * r), fill: { type: 'radial', cx: 0.35, cy: 0.3, r: 0.85, smooth: true, stops: [{ offset: 0, color: lighten(color, 0.08) }, { offset: 1, color: darken(color, 0.1) }] }, shadow }, 'shapes', note);
}

function shadowFor(roles, k) {
  return { color: rgba(darken(roles.ground, roles.darkGround ? 0.6 : 0.45), roles.darkGround ? 0.5 : 0.28), blur: 14 * k, offsetX: 5 * k, offsetY: 9 * k };
}

// ------------------------------------------------------------------ geometric (Bauhaus relief)
function geometric(P, W, H, roles, ev) {
  const u = Math.min(W, H);
  const sh = shadowFor(roles, u / 1000);
  const [a1, a2, a3, a4] = [0, 1, 2, 3].map((i) => roles.accents[i % roles.accents.length]);
  const gold = roles.accents.find((c) => { const l = lch(hexToOklab(c)); return l.h > 60 && l.h < 110 && l.C > 0.06; }) || a3;
  const jx = () => P.rand(-0.03, 0.03) * W;
  // Dominant form (the largest mass, low in the frame) → secondary forms → small accents (odd count) → hairlines.
  const big = { x: W * 0.4 + jx(), y: H * 0.74, r: u * 0.2 };
  disc(P, 'main', big.x, big.y, big.r, a1, sh, 'dominant disc (largest mass anchors the composition)');
  const half = { x: W * 0.55 + jx(), y: H * 0.2, r: u * 0.17 };
  P.draw('draw.path', 'main', Object.assign(pathOf(circlePts(half.x, half.y, half.r, -Math.PI / 2, Math.PI / 2), true), { fill: a2, shadow: sh }), 'shapes', 'half disc (rhythm: a circle cut by the vertical axis)');
  disc(P, 'main', half.x - half.r * 0.25, half.y + half.r * 0.05, half.r * 0.48, gold, sh, 'small disc overlapping the half disc (overlap = depth)');
  const mid = { x: W * 0.64 + jx(), y: H * 0.5, r: u * 0.15 };
  disc(P, 'main', mid.x, mid.y, mid.r, a3, sh, 'secondary disc');
  disc(P, 'main', mid.x + mid.r * 0.1, mid.y + mid.r * 0.25, mid.r * 0.78, a4, sh, 'stacked disc (value step)');
  disc(P, 'main', W * 0.42 + jx(), H * 0.4, u * 0.085, a2, sh, 'accent disc');
  // Cut panel: rectangle with a quarter-circle bite (Bauhaus).
  // The bite is centred on the panel's top-left corner: bottom edge → left edge up to the arc → arc → right edge.
  const px = W * 0.66; const py = H * 0.52; const pw = W * 0.2; const ph = H * 0.2;
  P.poly('main', [{ x: px + pw, y: py + ph }, { x: px, y: py + ph }].concat(circlePts(px, py, pw, Math.PI / 2, 0, 24)), { fill: roles.accents[roles.accents.length > 4 ? 4 : 0], shadow: sh }, 'shapes', 'cut panel (rectangle with a concave quarter-circle bite)');
  // Hairlines: vertical and horizontal structure, two weights; arcs as open strokes.
  const lineW = Math.max(2, u * 0.004);
  for (const [x1, y1, x2, y2, c, wgt] of [
    [W * 0.2, H * 0.12, W * 0.2, H * 0.45, roles.ink, 1], [W * 0.08, H * 0.48, W * 0.52, H * 0.48, roles.ink, 1],
    [W * 0.48, H * 0.45, W * 0.48, H * 0.86, roles.ink, 1.4], [W * 0.62, H * 0.3, W * 0.62, H * 0.95, gold, 1],
    [W * 0.15, H * 0.8, W * 0.38, H * 0.8, lighten(roles.ground, 0.4), 1.6], [W * 0.5, H * 0.79, W * 0.85, H * 0.79, gold, 0.8],
  ]) P.line('lines', { x1: r2(x1 + jx() * 0.3), y1: r2(y1), x2: r2(x2 + jx() * 0.3), y2: r2(y2), stroke: c, strokeWidth: r2(lineW * wgt), cap: 'butt', shadow: { color: rgba(roles.ink, 0.18), blur: 4, offsetX: 2, offsetY: 3 } }, 'lines', 'hairline (structure and rhythm)');
  for (const [cx, cy, r, a0, a1c, c] of [
    [half.x - half.r * 0.15, half.y, half.r * 1.25, Math.PI * 0.55, Math.PI * 1.45, gold],
    [mid.x - mid.r * 0.3, mid.y - mid.r * 0.2, mid.r * 1.3, -Math.PI * 0.95, -Math.PI * 0.25, gold],
    [big.x + big.r * 0.1, big.y, big.r * 1.15, Math.PI * 0.35, Math.PI * 0.95, gold],
  ]) P.draw('draw.path', 'lines', Object.assign(pathOf(circlePts(cx, cy, r, a0, a1c)), { fill: null, stroke: c, strokeWidth: r2(lineW * 1.6), cap: 'round' }), 'lines', 'arc (curved counter-rhythm to the straight hairlines)');
  for (const [i, c] of [gold, a1, roles.ink].entries()) disc(P, 'main', W * 0.22, H * (0.53 + i * 0.045), u * 0.022, c, { color: rgba(roles.ink, 0.2), blur: 4, offsetX: 2, offsetY: 3 }, 'small dot (odd-numbered accent column)');
  ev.record('dominance-and-rhythm', 'One dominant disc low in the frame, secondary discs stepping up, an odd number of small accents, straight hairlines against curved arcs.', [], 'shapes');
}

// ------------------------------------------------------------------ clay (soft 3D UI board)
function clay(P, W, H, roles, ev) {
  const u = Math.min(W, H);
  const k = u / 1000;
  const base = roles.ground;
  const soft = (alpha) => ({ color: rgba(darken(base, roles.darkGround ? 0.7 : 0.4), alpha), blur: 34 * k, offsetX: 0, offsetY: 16 * k });
  const acc = (i) => roles.accents[((i % roles.accents.length) + roles.accents.length) % roles.accents.length];
  // Two-column masonry that FILLS the board: tile heights are weights normalised to the column height.
  const g = W * 0.05; const colW = (W - 3 * g) / 2;
  const kinds = [['waves', 'bars', 'spheres'], ['toggles', 'donut', 'waves', 'dots']];
  const tiles = [];
  kinds.forEach((col, ci) => {
    const weights = col.map((kind) => ({ waves: 1.25, bars: 1.1, spheres: 0.7, toggles: 0.9, donut: 1.35, dots: 0.65 }[kind] * P.rand(0.9, 1.1)));
    const sum = weights.reduce((s, w) => s + w, 0);
    const avail = H - g * (col.length + 1);
    let y = g;
    col.forEach((kind, i) => {
      const h = (avail * weights[i]) / sum;
      tiles.push({ kind, x: g + ci * (colW + g), y, w: colW, h, c: (ci + i) % 3 === 0 ? lighten(base, roles.darkGround ? 0.08 : 0.025) : acc(ci * 3 + i) });
      y += h + g;
    });
  });
  for (const [i, t] of tiles.entries()) {
    const rad = Math.min(t.w, t.h) * 0.12;
    P.rect('main', { x: r2(t.x), y: r2(t.y), w: r2(t.w), h: r2(t.h), radius: r2(rad), fill: { type: 'linear', angle: 90, smooth: true, stops: [{ offset: 0, color: lighten(t.c, 0.1) }, { offset: 1, color: darken(t.c, 0.05) }] }, shadow: soft(0.45) }, 'tiles', 'clay tile (soft drop shadow, top-lit gradient)');
    P.rect('main', { x: r2(t.x + 2), y: r2(t.y + 2), w: r2(t.w - 4), h: r2(t.h * 0.4), radius: r2(rad), fill: { type: 'linear', angle: 90, stops: [{ offset: 0, color: rgba('#ffffff', 0.32) }, { offset: 1, color: rgba('#ffffff', 0) }] } }, 'tiles', 'tile top sheen');
    const clip = { type: 'rect', x: t.x, y: t.y, w: t.w, h: t.h, radius: rad };
    const inner = { x: t.x + t.w * 0.1, y: t.y + t.h * 0.14, w: t.w * 0.8, h: t.h * 0.74 };
    if (t.kind === 'waves') {
      [acc(i), acc(i + 1), acc(i + 2)].forEach((c, j) => {
        const yy = t.y + t.h * (0.42 + j * 0.17);
        P.blob('main', [{ x: t.x - 20, y: yy }, { x: t.x + t.w * 0.3, y: yy - t.h * 0.18 }, { x: t.x + t.w * 0.65, y: yy + t.h * 0.05 }, { x: t.x + t.w + 20, y: yy - t.h * 0.12 }, { x: t.x + t.w + 20, y: t.y + t.h + 20 }, { x: t.x - 20, y: t.y + t.h + 20 }], { fill: { type: 'linear', angle: 90, smooth: true, stops: [{ offset: 0, color: lighten(c, 0.12) }, { offset: 1, color: darken(c, 0.08) }] }, clip, shadow: { color: rgba(darken(c, 0.5), 0.35), blur: 18 * k, offsetX: 0, offsetY: -6 * k } }, 'waves', 'clay wave layer (shadow cast upward onto the layer behind)', true);
      });
    } else if (t.kind === 'bars') {
      // Pill columns (a clay bar chart): rounded caps, each a palette colour, lit from the left.
      const n = 5; const bw = inner.w / (n * 1.35);
      for (let j = 0; j < n; j += 1) {
        const bh = inner.h * P.rand(0.55, 1);
        const bx = inner.x + j * bw * 1.35 + bw * 0.17;
        const c = acc(i + j);
        P.rect('main', { x: r2(bx), y: r2(inner.y + inner.h - bh), w: r2(bw), h: r2(bh), radius: r2(bw / 2), fill: { type: 'linear', angle: 0, smooth: true, stops: [{ offset: 0, color: lighten(c, 0.22) }, { offset: 0.55, color: c }, { offset: 1, color: darken(c, 0.15) }] }, shadow: soft(0.3) }, 'tiles', 'clay pill column (bar chart)');
      }
      P.rect('main', { x: r2(inner.x), y: r2(inner.y + inner.h + 4), w: r2(inner.w), h: r2(Math.max(4, t.h * 0.03)), radius: 3, fill: darken(t.c, 0.12) }, 'tiles', 'chart base ledge');
    } else if (t.kind === 'toggles') {
      const ph = Math.min(inner.h / 3.2, 70 * k + 20);
      for (let j = 0; j < 3; j += 1) {
        const py = inner.y + j * ph * 1.3;
        const on = j % 2 === 0;
        const pc = on ? acc(i + j) : lighten(base, 0.05);
        P.rect('main', { x: r2(inner.x), y: r2(py), w: r2(inner.w), h: r2(ph), radius: r2(ph / 2), fill: { type: 'linear', angle: 90, stops: [{ offset: 0, color: lighten(pc, 0.12) }, { offset: 1, color: darken(pc, 0.06) }] }, shadow: soft(0.3) }, 'tiles', 'clay toggle track');
        sphere(P, on ? inner.x + inner.w - ph * 0.55 : inner.x + ph * 0.55, py + ph / 2, ph * 0.38, on ? lighten(base, 0.12) : acc(i + j + 1), roles, 'toggle knob (sphere)');
      }
    } else if (t.kind === 'donut') {
      // A big clay donut cradling a sphere (the centrepiece of the board).
      const cx = t.x + t.w / 2; const cy = t.y + t.h * 0.55; const R = Math.min(t.w, t.h) * 0.36;
      P.soft('main', cx, cy + R * 0.9, R * 2.2, R * 0.5, rgba(darken(base, 0.6), 0.3), R * 0.2, 'spheres', 'donut contact shadow');
      P.ellipse('main', { x: r2(cx - R), y: r2(cy - R), w: r2(2 * R), h: r2(2 * R), fill: { type: 'conic', angle: 200, cx: 0.5, cy: 0.5, smooth: true, stops: [{ offset: 0, color: acc(i) }, { offset: 0.5, color: acc(i + 1) }, { offset: 1, color: acc(i) }] }, shadow: soft(0.4) }, 'spheres', 'clay donut ring (two palette colours meeting)');
      P.ellipse('main', { x: r2(cx - R), y: r2(cy - R), w: r2(2 * R), h: r2(2 * R), fill: { type: 'radial', cx: 0.38, cy: 0.32, r: 0.75, stops: [{ offset: 0, color: rgba('#ffffff', 0.35) }, { offset: 0.6, color: rgba('#ffffff', 0) }, { offset: 1, color: rgba('#000000', 0.18) }] } }, 'spheres', 'donut volume shading');
      sphere(P, cx + R * 0.05, cy + R * 0.02, R * 0.58, acc(i + 2), roles, 'sphere resting in the donut');
    } else if (t.kind === 'dots') {
      const n = 4;
      for (let j = 0; j < n; j += 1) sphere(P, inner.x + inner.w * ((j + 0.5) / n), inner.y + inner.h * 0.55, Math.min(inner.w / (n * 2.6), inner.h * 0.3), acc(i + j), roles, 'clay button (sphere)');
    } else {
      const n = 3;
      for (let j = 0; j < n; j += 1) sphere(P, t.x + t.w * (0.25 + j * 0.25), t.y + t.h * 0.55, Math.min(t.w, t.h) * 0.12, acc(i + j), roles, 'clay sphere (specular highlight, soft contact shadow)');
    }
  }
  ev.record('soft-light-form', `Clay board: ${tiles.length} tiles filling a two-column rhythm; every tile, pill, donut and sphere lit from above with large soft shadows.`, [], 'tiles');
}

/** Glossy sphere: radial body, specular dot, soft contact shadow. */
function sphere(P, cx, cy, r, color, roles, note) {
  P.soft('main', cx, cy + r * 0.95, r * 1.8, r * 0.45, rgba(darken(roles.ground, 0.6), 0.35), r * 0.25, 'spheres', 'contact shadow');
  P.ellipse('main', { x: r2(cx - r), y: r2(cy - r), w: r2(2 * r), h: r2(2 * r), fill: { type: 'radial', cx: 0.36, cy: 0.32, r: 0.9, smooth: true, stops: [{ offset: 0, color: lighten(color, 0.35) }, { offset: 0.45, color }, { offset: 1, color: darken(color, 0.35) }] } }, 'spheres', note || 'sphere');
  P.soft('main', cx - r * 0.35, cy - r * 0.4, r * 0.45, r * 0.3, rgba('#ffffff', 0.75), r * 0.08, 'spheres', 'specular highlight');
}

// ------------------------------------------------------------------ fluid (ribbons, smoke, spheres)
function ribbonPts(P, W, H, t0) {
  const pts = [];
  const n = 6;
  let x = W * P.rand(-0.1, 0.4);
  let y = H * (t0 - 0.1);
  for (let i = 0; i < n; i += 1) {
    pts.push({ x, y });
    x += W * P.rand(0.05, 0.28) * (i % 2 ? -0.6 : 1);
    y += H * P.rand(0.12, 0.22);
  }
  return pts;
}

function catmull(pts, steps) {
  const out = [];
  for (let i = 0; i < pts.length - 1; i += 1) {
    const p0 = pts[Math.max(0, i - 1)]; const p1 = pts[i]; const p2 = pts[i + 1]; const p3 = pts[Math.min(pts.length - 1, i + 2)];
    for (let s = 0; s < steps; s += 1) {
      const t = s / steps; const t2 = t * t; const t3 = t2 * t;
      out.push({
        x: 0.5 * ((2 * p1.x) + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
        y: 0.5 * ((2 * p1.y) + (-p0.y + p2.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3),
      });
    }
  }
  out.push(pts[pts.length - 1]);
  return out;
}

function fluid(P, W, H, roles, ev) {
  const u = Math.min(W, H);
  const cols = roles.accents;
  // Smoke volume first: large blurred colour clouds along the main diagonal (depth behind the ribbons).
  for (let i = 0; i < 9; i += 1) {
    const t = i / 8;
    const cx = W * (0.25 + 0.5 * t + P.rand(-0.15, 0.15)); const cy = H * (0.9 - 0.8 * t + P.rand(-0.08, 0.08));
    const ew = u * P.rand(0.6, 1.0); const eh = u * P.rand(0.45, 0.8); const cc = cols[i % cols.length];
    P.ellipse('ground', { x: r2(cx - ew / 2), y: r2(cy - eh / 2), w: r2(ew), h: r2(eh), fill: { type: 'radial', cx: 0.5, cy: 0.5, r: 0.5, smooth: true, stops: [{ offset: 0, color: rgba(cc, 0.34) }, { offset: 1, color: rgba(cc, 0) }] } }, 'smoke', 'smoke volume (soft colour cloud)');
  }
  const count = 11;
  for (let i = 0; i < count; i += 1) {
    const c1 = cols[i % cols.length]; const c2 = cols[(i + 1) % cols.length];
    // Ribbons gather along one rising S-flow (bottom-left → top-right) so they read as one moving mass.
    const pts = [];
    const phase = P.rand(0, Math.PI * 2);
    for (let j = 0; j <= 5; j += 1) {
      const s = j / 5;
      pts.push({ x: W * (0.15 + 0.7 * s + 0.18 * Math.sin(s * 5 + phase) + P.rand(-0.06, 0.06)), y: H * (1.02 - 1.04 * s + P.rand(-0.04, 0.04)) });
    }
    const center = catmull(pts, 14);
    const maxW = u * P.rand(0.07, 0.17);
    const left = []; const right = []; const fold = [];
    for (let j = 0; j < center.length; j += 1) {
      const a = center[Math.max(0, j - 1)]; const b = center[Math.min(center.length - 1, j + 1)];
      const dx = b.x - a.x; const dy = b.y - a.y; const len = Math.hypot(dx, dy) || 1;
      const t = j / (center.length - 1);
      // Width swells and pinches along the ribbon (a twisting silk sheet), tapering at both ends.
      const w = maxW * Math.sin(Math.PI * t) * (0.4 + 0.6 * Math.abs(Math.sin(t * 7 + i)));
      left.push({ x: r2(center[j].x - (dy / len) * w), y: r2(center[j].y + (dx / len) * w) });
      right.unshift({ x: r2(center[j].x + (dy / len) * w * 0.5), y: r2(center[j].y - (dx / len) * w * 0.5) });
      fold.push({ x: r2(center[j].x - (dy / len) * w * 0.45), y: r2(center[j].y + (dx / len) * w * 0.45) });
    }
    P.draw('draw.path', 'main', Object.assign(pathOf(left.concat(right), true), { fill: { type: 'linear', angle: P.rand(30, 150), smooth: true, stops: [{ offset: 0, color: lighten(c1, 0.25) }, { offset: 0.45, color: c1 }, { offset: 1, color: darken(c2, 0.1) }] }, opacity: r2(P.rand(0.6, 0.9)), shadow: { color: rgba(darken(c1, 0.6), 0.28), blur: 22, offsetX: 4, offsetY: 10 } }), 'ribbons', 'silk ribbon (swelling width, gradient between two palette colours, cast shadow)');
    P.draw('draw.path', 'main', Object.assign(pathOf(left), { fill: null, stroke: rgba(lighten(c1, 0.55), 0.75), strokeWidth: r2(Math.max(1.5, u * 0.003)), cap: 'round' }), 'ribbons', 'lit edge of the ribbon');
    P.draw('draw.path', 'main', Object.assign(pathOf(fold), { fill: null, stroke: rgba(lighten(c1, 0.35), 0.3), strokeWidth: r2(Math.max(1, u * 0.0018)), cap: 'round' }), 'ribbons', 'inner fold line (silk crease)');
    for (let w = 0; w < 2; w += 1) {
      const off = P.rand(-1, 1) * maxW * 1.8;
      P.draw('draw.path', 'fx', Object.assign(pathOf(center.map((p) => ({ x: r2(p.x + off), y: r2(p.y - off * 0.4) }))), { fill: null, stroke: rgba(w ? c2 : lighten(c1, 0.3), 0.3), strokeWidth: r2(Math.max(1, u * 0.0016)), cap: 'round' }), 'smoke', 'smoke wisp following the flow');
    }
  }
  const ballCount = 5;
  for (let i = 0; i < ballCount; i += 1) {
    sphere(P, P.rand(0.1, 0.9) * W, P.rand(0.08, 0.92) * H, u * P.rand(0.02, 0.05), cols[(i + 2) % cols.length], roles, 'glossy sphere (counterpoint to the ribbons)');
  }
  for (let i = 0; i < 70; i += 1) {
    const r = u * P.rand(0.002, 0.006);
    P.ellipse('fx', { x: r2(P.rand(0, W)), y: r2(P.rand(0, H)), w: r2(r * 2), h: r2(r * 2), fill: rgba(P.pick([roles.ink].concat(cols.slice(0, 3))), 0.8) }, 'speckles', 'speckle');
  }
  ev.record('rhythm-flow', `${count} silk ribbons and smoke volumes rise along one S-flow (directional rhythm), counterpointed by ${ballCount} spheres; colours are the reference swatches only.`, [], 'ribbons');
}

// ------------------------------------------------------------------ splash (glossy paint)
function splash(P, W, H, roles, ev) {
  const u = Math.min(W, H);
  // Split ground: light paper on the left, dark band on the right with a dry-brush edge.
  const dark = roles.darkGround ? roles.ground : roles.ink;
  const edge = W * 0.55;
  P.rect('ground', { x: r2(edge), y: 0, w: r2(W - edge), h: H, fill: dark }, 'ground', 'dark half of the split ground');
  P.brush('ground', { points: [{ x: edge, y: -10 }, { x: edge + 6, y: H * 0.5 }, { x: edge - 4, y: H + 10 }], color: dark, brush: { preset: 'rough', size: 40, seed: 7 }, smooth: 0.6 }, 'ground', 'dry-brush edge between the two halves');
  const chromatic = roles.accents.filter((c) => c !== dark && lch(hexToOklab(c)).C > 0.05);
  const cols = chromatic.length >= 2 ? chromatic : roles.accents.filter((c) => c !== dark);
  const n = 6;
  for (let i = 0; i < n; i += 1) {
    const c = cols[i % cols.length];
    const t = (i + 0.5) / n;
    // Each splash is a SHEET thrown in one direction: an elongated body whose leading edge breaks into curved
    // fingers that end in droplets (crown splash), plus a thin trailing tail.
    const cx = W * (0.48 + 0.2 * Math.sin(t * Math.PI * 2.2 + 0.4)) + P.rand(-0.04, 0.04) * W;
    const cy = H * (0.07 + t * 0.86);
    const dir = (i % 2 ? Math.PI * 0.15 : Math.PI * 0.85) + P.rand(-0.35, 0.35);
    const R = u * P.rand(0.13, 0.19);
    const ux = Math.cos(dir); const uy = Math.sin(dir); const vx = -uy; const vy = ux;
    const at = (a, b) => ({ x: cx + ux * a + vx * b, y: cy + uy * a + vy * b });
    const sh = { color: rgba('#000000', 0.35), blur: 18, offsetX: 6, offsetY: 12 };
    // Fan: from a narrow back point the sheet widens to a wobbling leading rim (±0.6 rad around the throw).
    const back = at(-R * 0.9, 0);
    const rim = [];
    for (let k = 0; k <= 12; k += 1) {
      const a = dir + (k / 12 - 0.5) * 1.2;
      const rr = R * 1.8 * (1 + 0.09 * Math.sin(k * 2.3 + i) + P.rand(-0.05, 0.05));
      rim.push({ x: back.x + Math.cos(a) * rr, y: back.y + Math.sin(a) * rr, a });
    }
    const side = (sgn) => at(-R * 0.35, sgn * R * 0.38);
    // Rounded back: the sheet's tail end is a soft curve, never a spike.
    const backArc = [at(-R * 0.55, R * 0.3), at(-R * 0.95, R * 0.12), at(-R * 1.0, -R * 0.08), at(-R * 0.6, -R * 0.3)];
    P.blob('main', backArc.concat([side(-1)]).concat(rim.map((p) => ({ x: p.x, y: p.y }))).concat([side(1)]), { fill: { type: 'radial', cx: 0.35, cy: 0.35, r: 0.85, smooth: true, stops: [{ offset: 0, color: lighten(c, 0.25) }, { offset: 0.5, color: c }, { offset: 1, color: darken(c, 0.3) }] }, shadow: sh }, 'splash', 'paint sheet (fan thrown in one direction, glossy)', true);
    // Rim shading: the thick lip of the sheet is darker just inside its edge.
    P.blob('main', rim.map((p) => ({ x: back.x + (p.x - back.x) * 0.93, y: back.y + (p.y - back.y) * 0.93 })), { fill: null, stroke: rgba(darken(c, 0.35), 0.28), strokeWidth: r2(Math.max(2, R * 0.05)), cap: 'round' }, 'splash', 'thick rim of the sheet (darker lip)', false);
    // Fingers grow out of the rim: curved, tapering, each ending in a droplet wider than the finger.
    for (let k = 1; k < rim.length - 1; k += P.rand(1, 2.4) > 1.7 ? 2 : 1) {
      const p = rim[k];
      if (P.rand(0, 1) < 0.25) continue;
      const L = R * P.rand(0.35, 1.1);
      const bend = P.rand(-0.45, 0.45);
      const w0 = R * P.rand(0.06, 0.11);
      const nx = -Math.sin(p.a); const ny = Math.cos(p.a);
      const mid = { x: p.x + Math.cos(p.a + bend * 0.5) * L * 0.5, y: p.y + Math.sin(p.a + bend * 0.5) * L * 0.5 };
      const tip = { x: p.x + Math.cos(p.a + bend) * L, y: p.y + Math.sin(p.a + bend) * L };
      P.blob('main', [{ x: p.x - Math.cos(p.a) * w0 + nx * w0 * 1.6, y: p.y - Math.sin(p.a) * w0 + ny * w0 * 1.6 }, { x: mid.x + nx * w0 * 0.45, y: mid.y + ny * w0 * 0.45 }, tip, { x: mid.x - nx * w0 * 0.45, y: mid.y - ny * w0 * 0.45 }, { x: p.x - Math.cos(p.a) * w0 - nx * w0 * 1.6, y: p.y - Math.sin(p.a) * w0 - ny * w0 * 1.6 }], { fill: c, shadow: sh }, 'splash', 'splash finger (curved, tapering out of the rim)', true);
      const dr = w0 * P.rand(1.1, 1.6);
      P.ellipse('main', { x: r2(tip.x - dr), y: r2(tip.y - dr), w: r2(dr * 2), h: r2(dr * 2), fill: { type: 'radial', cx: 0.33, cy: 0.3, r: 0.9, stops: [{ offset: 0, color: lighten(c, 0.4) }, { offset: 0.5, color: c }, { offset: 1, color: darken(c, 0.25) }] }, shadow: sh }, 'splash', 'droplet at the finger tip (wider than the finger)');
    }
    P.blob('main', [at(-R * 0.2, -R * 0.15), at(R * 0.5, -R * 0.55), at(R * 1.2, -R * 0.45), at(R * 0.6, -R * 0.2)], { fill: rgba('#ffffff', 0.16) }, 'splash', 'broad soft gloss band (reflected sky)', true);
    // Gloss: curved white streaks following the sheet.
    for (let k = 0; k < 3; k += 1) {
      const p0 = at(R * P.rand(-0.6, 0.2), -R * P.rand(0.1, 0.45)); const p1 = at(R * P.rand(0.4, 0.95), -R * P.rand(0.05, 0.35));
      P.draw('draw.path', 'main', { segments: [{ op: 'M', x: r2(p0.x), y: r2(p0.y) }, { op: 'Q', cx: r2((p0.x + p1.x) / 2 + vx * R * 0.12), cy: r2((p0.y + p1.y) / 2 + vy * R * 0.12), x: r2(p1.x), y: r2(p1.y) }], closed: false, fill: null, stroke: rgba('#ffffff', 0.5 - k * 0.12), strokeWidth: r2(Math.max(2, R * (0.05 - k * 0.012))), cap: 'round', blur: 0.8 }, 'splash', 'specular gloss streak (wet paint)');
    }
  }
  for (let i = 0; i < 70; i += 1) {
    const r = u * P.rand(0.003, 0.011);
    P.ellipse('fx', { x: r2(P.rand(0, W)), y: r2(P.rand(0, H)), w: r2(r * 2), h: r2(r * 2), fill: P.pick(cols) }, 'speckles', 'flying droplet');
  }
  ev.record('value-contrast', 'Paint sheets thrown across a light/dark split: every colour is seen against high and low values; fingers, droplets, tails and gloss streaks give the paint motion and thickness.', [], 'splash');
}

const STYLES = { geometric, clay, fluid, splash };
const { composeOrnamental } = require('./ornamental');

function composeAbstract(P, ctx) {
  const { intent, ev, input, roles } = ctx;
  const W = P.W; const H = P.H;
  // Ornamental pictures have their own structure engine (eye path, curve vocabulary, value study).
  if (intent.abstractStyle === 'ornamental') return composeOrnamental(P, ctx);
  const style = STYLES[intent.abstractStyle] ? intent.abstractStyle : 'geometric';
  // Splash always shows a light half against a dark half, so its ground is the palette's light end.
  const pr = paletteRoles(roles.colors.length >= 2 ? roles.colors : ['#f1ebdd', '#124d5d', '#c47044', '#292c38'], style === 'splash' ? false : intent.lighting === 'night' ? true : undefined);
  // A palette with no light colour still needs paper for the light half: a tint of its lightest swatch.
  if (style === 'splash' && lch(hexToOklab(pr.ground)).L < 0.8) pr.ground = lighten(pr.ground, 0.8);
  P.layer('ground', 'ground');
  P.layer('main', 'forms');
  P.layer('lines', 'lines');
  P.layer('fx', 'details');
  // Ground: the palette's ground swatch with a soft central lift (studio light on paper).
  P.rect('ground', { x: 0, y: 0, w: W, h: H, fill: { type: 'radial', cx: 0.45, cy: 0.4, r: 0.9, smooth: true, stops: [{ offset: 0, color: lighten(pr.ground, pr.darkGround ? 0.06 : 0.03) }, { offset: 1, color: darken(pr.ground, pr.darkGround ? 0.1 : 0.06) }] } }, 'ground', `ground from the palette swatch ${pr.ground}`);
  if (style === 'clay' || style === 'geometric') P.rect('ground', { x: 0, y: 0, w: W, h: H, fill: { type: 'pattern', kind: 'paper', color: rgba(darken(pr.ground, 0.3), 0.5), scale: 1 }, opacity: 0.25, blend: 'multiply' }, 'ground', 'paper texture');
  STYLES[style](P, W, H, pr, ev);
  ctx.effects = [{ type: 'grade', contrast: 1.04, saturation: 1.02 }, { type: 'vignette', amount: pr.darkGround ? 0.3 : 0.16 }, { type: 'grain', amount: 0.08 }];
  ev.record('limited-palette', `Abstract (${style}) drawn strictly from the reference swatches: ground ${pr.ground}, ink ${pr.ink}, accents ${pr.accents.slice(0, 5).join(' ')}.`, [], 'palette');
  return { style, paletteRoles: pr, requested: (intent.elements || []).map((e) => e.id), seedNote: input.seed ? 'seed from input' : 'seed from prompt' };
}

module.exports = { composeAbstract, paletteRoles, ABSTRACT_STYLES: Object.keys(STYLES).concat(['ornamental']) };
