'use strict';

/**
 * City scene (architecture): depth is built in planes, the way illustrators build it —
 *   sky → far skyline (heavily hazed) → mid skyline → hero tower + flanking blocks → curved glass podium
 *   → plaza with perspective paving → trees and walking people in front.
 * Geometry is two-point perspective (homography-mapped facades); colour depth follows atmospheric
 * perspective (Color and Light p176): every plane further back is mixed further toward the sky.
 */

const { mix, darken, lighten, rgba } = require('../color');
const { homography, box, verifyConvergence } = require('./architecture');
const { toon, toonRect, limbOutline, ellipsePoints, organic, taper } = require('./style');
const { smoothSegments } = require('./builder');

const SKIN = ['#e0a982', '#c98e66', '#a8714e', '#f1c7a5', '#8d5a3b'];
const HAIR = ['#2b1d16', '#1a1a1a', '#5a3b22', '#3d2a1e'];

function quadPoly(map, u0, v0, u1, v1) {
  return [map(u0, v0), map(u1, v0), map(u1, v1), map(u0, v1)];
}

/** Glass curtain wall on one face: sky reflection gradient, reflection bands, mullion grid, floor lines. */
function glassFace(P, layer, face, o) {
  const map = homography([face[0], face[1], face[2], face[3]]);
  const clip = { type: 'path', segments: face.map((p, i) => ({ op: i ? 'L' : 'M', x: p.x, y: p.y })) };
  P.poly(layer, face, { fill: { type: 'linear', angle: 90, smooth: true, stops: [{ offset: 0, color: lighten(o.glass, 0.28) }, { offset: 0.55, color: o.glass }, { offset: 1, color: darken(o.glass, 0.25) }] } }, o.el, `${o.name}: glass (sky reflection gradient)`);
  // Reflection bands: the sky and neighbouring buildings mirrored as soft diagonal sheets.
  for (const [a, b, alpha] of [[0.05, 0.22, 0.18], [0.3, 0.38, 0.1], [0.62, 0.8, 0.14]]) {
    P.poly(layer, [map(a, 1), map(b, 1), map(b + 0.25, 0), map(a + 0.25, 0)], { fill: rgba('#ffffff', alpha * (o.lit ? 1.2 : 0.7)), clip, blur: 2 }, o.el, `${o.name}: reflection band`);
  }
  P.poly(layer, [map(0, 0.55), map(1, 0.5), map(1, 1), map(0, 1)], { fill: rgba(darken(o.glass, 0.5), 0.18), clip }, o.el, `${o.name}: city reflected in the lower glass`);
  const ink = o.mullion;
  for (let i = 1; i < o.cols; i += 1) {
    const a = map(i / o.cols, 0); const b = map(i / o.cols, 1);
    P.line(layer, { x1: a.x, y1: a.y, x2: b.x, y2: b.y, stroke: ink, strokeWidth: o.mullionWidth, cap: 'butt' }, o.el, `${o.name}: vertical mullion`);
  }
  for (let j = 1; j < o.rows; j += 1) {
    const a = map(0, j / o.rows); const b = map(1, j / o.rows);
    P.line(layer, { x1: a.x, y1: a.y, x2: b.x, y2: b.y, stroke: rgba(ink, 0.8), strokeWidth: o.mullionWidth * 0.8, cap: 'butt' }, o.el, `${o.name}: floor transom (recedes to its vanishing point)`);
  }
  P.poly(layer, face, { fill: null, stroke: darken(o.glass, 0.55), strokeWidth: 1.5 }, o.el, `${o.name}: outline`);
  return map;
}

/** Masonry face with punched windows (stone/brick blocks). */
function stoneFace(P, layer, face, o) {
  const map = homography([face[0], face[1], face[2], face[3]]);
  P.poly(layer, face, { fill: { type: 'linear', angle: 90, stops: [{ offset: 0, color: lighten(o.stone, 0.06) }, { offset: 1, color: darken(o.stone, 0.08) }] }, stroke: darken(o.stone, 0.5), strokeWidth: 1.4 }, o.el, `${o.name}: masonry face`);
  for (let r = 0; r < o.rows; r += 1) {
    for (let c = 0; c < o.cols; c += 1) {
      const u0 = (c + 0.2) / o.cols; const u1 = (c + 0.8) / o.cols;
      const v0 = 0.05 + (r + 0.22) * (0.9 / o.rows); const v1 = 0.05 + (r + 0.78) * (0.9 / o.rows);
      const q = quadPoly(map, u0, v0, u1, v1);
      P.poly(layer, q, { fill: { type: 'linear', angle: 90, stops: [{ offset: 0, color: lighten(o.glass, 0.15) }, { offset: 1, color: darken(o.glass, 0.2) }] }, stroke: darken(o.stone, 0.45), strokeWidth: 1 }, o.el, `${o.name}: punched window`);
      const s0 = map(u0 - 0.02, v1 + 0.01); const s1 = map(u1 + 0.02, v1 + 0.01);
      P.line(layer, { x1: s0.x, y1: s0.y, x2: s1.x, y2: s1.y, stroke: lighten(o.stone, 0.3), strokeWidth: 2, cap: 'butt' }, o.el, `${o.name}: sill`);
    }
  }
  return map;
}

/** Walking person in profile (facing f = ±1), feet at footY, eyes on the horizon. */
function walker(P, layer, o) {
  const f = o.facing;
  const u = o.height / 7;
  const fy = o.footY;
  const cx = o.cx;
  const y = (k) => fy - k * u;
  const lw = Math.max(1, u * 0.035);
  const ink = (c) => darken(c, 0.55);
  const skin = o.skin; const top = o.top; const pants = o.pants; const shoe = o.shoe; const hair = o.hair;
  const light = { x: -0.7, y: -0.7 };
  const hip = { x: cx, y: y(3.55) };
  const front = { knee: { x: cx + f * 0.42 * u, y: y(1.92) }, ankle: { x: cx + f * 0.82 * u, y: y(0.3) } };
  const back = { knee: { x: cx - f * 0.22 * u, y: y(1.95) }, ankle: { x: cx - f * 0.7 * u, y: y(0.42) } };
  const neck = { x: cx + f * 0.1 * u, y: y(5.95) };
  const shoulder = { x: cx + f * 0.04 * u, y: y(5.65) };
  P.soft(layer, cx, fy, u * 1.9, u * 0.22, 'rgba(0,0,0,0.28)', 3, 'shadows', 'walker contact shadow');
  // Far arm and far leg first (darker: they are in the body's own shadow).
  toon(P, layer, limbOutline([shoulder, { x: cx + f * 0.36 * u, y: y(4.7) }, { x: cx + f * 0.62 * u, y: y(3.95) }], [0.36 * u, 0.3 * u, 0.24 * u]), { fill: darken(top, 0.18), shade: 0.2, highlight: false, light, outline: lw, lineColor: ink(top), note: 'far arm' }, o.el);
  toon(P, layer, limbOutline([hip, back.knee, back.ankle], [0.6 * u, 0.44 * u, 0.36 * u]), { fill: darken(pants, 0.18), shade: 0.2, highlight: false, light, outline: lw, lineColor: ink(pants), note: 'far leg (pushing off)' }, o.el);
  toon(P, layer, [{ x: back.ankle.x - f * 0.25 * u, y: back.ankle.y + 0.05 * u }, { x: back.ankle.x + f * 0.32 * u, y: back.ankle.y + 0.18 * u }, { x: back.ankle.x + f * 0.36 * u, y: back.ankle.y + 0.36 * u }, { x: back.ankle.x - f * 0.22 * u, y: back.ankle.y + 0.32 * u }],
    { fill: darken(shoe, 0.15), shade: 0.2, highlight: false, light, outline: lw, lineColor: darken(shoe, 0.6), note: 'far shoe (heel lifted)' }, o.el);
  if (o.backpack) {
    const bp = o.backpack;
    toon(P, layer, [{ x: cx - f * 0.3 * u, y: y(5.6) }, { x: cx - f * 0.95 * u, y: y(5.45) }, { x: cx - f * 1.02 * u, y: y(4.1) }, { x: cx - f * 0.35 * u, y: y(3.95) }], { fill: bp, shade: 0.22, light, outline: lw, lineColor: ink(bp), note: 'backpack' }, o.el);
    P.line(layer, { x1: cx - f * 0.92 * u, y1: y(4.9), x2: cx - f * 0.4 * u, y2: y(4.85), stroke: darken(bp, 0.35), strokeWidth: lw * 1.5, cap: 'round' }, o.el, 'backpack pocket seam');
  }
  // Torso (jacket/shirt) leaning slightly forward into the walk.
  toon(P, layer, [{ x: neck.x - f * 0.2 * u, y: neck.y + 0.1 * u }, { x: neck.x + f * 0.28 * u, y: neck.y + 0.15 * u }, { x: cx + f * 0.42 * u, y: y(4.9) }, { x: cx + f * 0.36 * u, y: y(3.6) }, { x: cx - f * 0.36 * u, y: y(3.6) }, { x: cx - f * 0.4 * u, y: y(5.1) }],
    { fill: top, shade: 0.2, light, outline: lw, lineColor: ink(top), note: 'jacket' }, o.el);
  if (o.backpack) P.line(layer, { x1: cx - f * 0.05 * u, y1: y(5.75), x2: cx - f * 0.12 * u, y2: y(4.4), stroke: darken(o.backpack, 0.3), strokeWidth: u * 0.08, cap: 'round' }, o.el, 'backpack strap');
  toon(P, layer, limbOutline([hip, front.knee, front.ankle], [0.62 * u, 0.46 * u, 0.38 * u]), { fill: pants, shade: 0.2, light, outline: lw, lineColor: ink(pants), note: 'near leg (stepping)' }, o.el);
  toon(P, layer, [{ x: front.ankle.x - f * 0.22 * u, y: front.ankle.y - 0.06 * u }, { x: front.ankle.x + f * 0.42 * u, y: front.ankle.y + 0.08 * u }, { x: front.ankle.x + f * 0.44 * u, y: front.ankle.y + 0.3 * u }, { x: front.ankle.x - f * 0.24 * u, y: front.ankle.y + 0.3 * u }],
    { fill: shoe, shade: 0.2, highlight: false, light, outline: lw, lineColor: darken(shoe, 0.6), note: 'near shoe' }, o.el);
  // Near arm swings back (opposite to the stepping leg), hand holding a phone when asked.
  const wrist = { x: cx - f * 0.48 * u, y: y(3.85) };
  toon(P, layer, limbOutline([shoulder, { x: cx - f * 0.24 * u, y: y(4.75) }, wrist], [0.38 * u, 0.32 * u, 0.26 * u]), { fill: top, shade: 0.2, light, outline: lw, lineColor: ink(top), note: 'near arm (sleeve)' }, o.el);
  toon(P, layer, ellipsePoints(wrist.x, wrist.y + 0.12 * u, 0.13 * u, 0.15 * u, 10), { fill: skin, shade: 0.2, highlight: false, light, outline: lw, lineColor: darken(skin, 0.45), note: 'hand' }, o.el);
  // Head in profile with hair; neck.
  toon(P, layer, [{ x: neck.x - f * 0.1 * u, y: neck.y + 0.1 * u }, { x: neck.x - f * 0.08 * u, y: neck.y - 0.3 * u }, { x: neck.x + f * 0.14 * u, y: neck.y - 0.3 * u }, { x: neck.x + f * 0.14 * u, y: neck.y + 0.1 * u }], { fill: skin, shade: 0.3, highlight: false, light, outline: lw, lineColor: darken(skin, 0.45), note: 'neck' }, o.el);
  const C = { x: neck.x + f * 0.1 * u, y: y(6.5) };
  toon(P, layer, [
    { x: C.x - f * 0.38 * u, y: C.y - 0.02 * u }, { x: C.x - f * 0.28 * u, y: C.y - 0.42 * u }, { x: C.x + f * 0.06 * u, y: C.y - 0.5 * u }, { x: C.x + f * 0.33 * u, y: C.y - 0.24 * u },
    { x: C.x + f * 0.37 * u, y: C.y - 0.05 * u }, { x: C.x + f * 0.46 * u, y: C.y + 0.1 * u }, { x: C.x + f * 0.37 * u, y: C.y + 0.18 * u }, { x: C.x + f * 0.36 * u, y: C.y + 0.36 * u },
    { x: C.x + f * 0.1 * u, y: C.y + 0.46 * u }, { x: C.x - f * 0.2 * u, y: C.y + 0.32 * u },
  ], { fill: skin, shade: 0.12, light, outline: lw, lineColor: darken(skin, 0.45), note: 'head (profile)' }, o.el);
  const longHair = o.longHair;
  toon(P, layer, longHair
    ? [{ x: C.x + f * 0.3 * u, y: C.y - 0.3 * u }, { x: C.x + f * 0.05 * u, y: C.y - 0.58 * u }, { x: C.x - f * 0.42 * u, y: C.y - 0.4 * u }, { x: C.x - f * 0.55 * u, y: C.y + 0.7 * u }, { x: C.x - f * 0.28 * u, y: C.y + 0.75 * u }, { x: C.x - f * 0.2 * u, y: C.y }, { x: C.x + f * 0.12 * u, y: C.y - 0.22 * u }]
    : [{ x: C.x + f * 0.32 * u, y: C.y - 0.28 * u }, { x: C.x + f * 0.05 * u, y: C.y - 0.58 * u }, { x: C.x - f * 0.38 * u, y: C.y - 0.42 * u }, { x: C.x - f * 0.44 * u, y: C.y + 0.08 * u }, { x: C.x - f * 0.22 * u, y: C.y - 0.04 * u }, { x: C.x + f * 0.12 * u, y: C.y - 0.24 * u }],
  { fill: hair, shade: 0.12, highlightAlpha: 0.2, light, outline: lw, lineColor: darken(hair, 0.5), note: 'hair' }, o.el);
  P.ellipse(layer, { x: C.x + f * 0.24 * u - 0.03 * u, y: C.y - 0.08 * u, w: 0.06 * u, h: 0.06 * u, fill: '#1b1b1f' }, o.el, 'eye');
  taper(P, layer, { x: C.x + f * 0.14 * u, y: C.y - 0.2 * u }, { x: C.x + f * 0.33 * u, y: C.y - 0.2 * u }, 0.04 * u, darken(hair, 0.05), o.el, 'eyebrow', { x: 0, y: -0.02 * u });
}

/** Stylised street tree: tall rounded canopy lit from the left, visible branches, slim trunk. */
function streetTree(P, layer, x, groundY, h, leaf, el) {
  const w = h * 0.42;
  const trunkTop = groundY - h * 0.62;
  P.soft(layer, x + w * 0.1, groundY, w * 0.9, h * 0.05, 'rgba(0,0,0,0.22)', 4, 'shadows', 'tree shadow');
  toonRect(P, layer, { x: x - h * 0.012, y: trunkTop, w: h * 0.024, h: groundY - trunkTop }, { fill: '#5a4636', shade: 0.4, edge: false, outline: 1, note: 'trunk' }, el);
  const canopy = [];
  for (let i = 0; i < 16; i += 1) {
    const t = (i / 16) * Math.PI * 2;
    const k = 1 + (P.random() - 0.5) * 0.08;
    // Teardrop: narrower and pointed at the top, full at the bottom.
    const rx = w / 2 * (Math.sin(t) > 0 ? 1 : 0.85);
    canopy.push({ x: x + Math.cos(t) * rx * k, y: groundY - h * 0.6 + Math.sin(t) * h * 0.38 * k - (Math.sin(t) < 0 ? h * 0.06 * Math.abs(Math.sin(t)) : 0) });
  }
  toon(P, layer, canopy, { fill: leaf, shade: 0.32, highlightAmount: 0.18, highlightAlpha: 0.3, outline: Math.max(1, h * 0.006), note: 'canopy' }, el);
  for (const [dx, dy, ex, ey] of [[0, 0.38, -0.12, 0.55], [0, 0.42, 0.13, 0.6], [0, 0.5, -0.05, 0.75], [0, 0.48, 0.1, 0.7]]) {
    taper(P, layer, { x: x + dx * w, y: groundY - h * dy }, { x: x + ex * w * 2, y: groundY - h * ey }, h * 0.012, rgba(darken(leaf, 0.5), 0.75), el, 'branch inside the canopy');
  }
}

function composeCity(P, ctx) {
  const { W, H } = P;
  const { intent, palette, ev } = ctx;
  const lighting = intent.lighting || 'neutral';
  const night = lighting === 'night';
  const horizonY = H * 0.8;
  const vpL = { x: -W * 0.85, y: horizonY };
  const vpR = { x: W * 1.95, y: horizonY };
  const atmo = ev.on('atmospheric-perspective') ? ev.rules.get('atmospheric-perspective').params : { farMixToSky: 0, midMixToSky: 0, nearMixToSky: 0 };
  const skyTop = night ? '#0b1430' : '#4f7fb5';
  const skyLow = night ? '#2a3a66' : '#c8dbec';
  const hazeC = mix(skyLow, '#ffffff', 0.2);
  const stone = night ? darken('#d8c4a2', 0.5) : mix(palette.facade || '#d8c4a2', '#d6bf98', 0.6);
  const glassBase = night ? '#1b2a4d' : '#3d6c9e';
  const mullion = night ? '#0b1020' : '#1f3550';

  P.layer('sky', 'السماء');
  P.layer('far', 'المدينة البعيدة');
  P.layer('mid', 'المدينة الوسطى');
  P.layer('hero', 'المبنى الرئيسي');
  P.layer('ground', 'الساحة');
  P.layer('front', 'الأشجار والناس');

  P.draw('draw.rect', 'sky', { x: 0, y: 0, w: W, h: horizonY + 4, fill: { type: 'linear', angle: 90, smooth: true, easing: 'ease-in-out', stops: [{ offset: 0, color: skyTop }, { offset: 1, color: skyLow }] } }, 'sky', 'sky (OKLab gradient)');
  if (!night) {
    for (const [cx, cy, s] of [[0.1, 0.1, 1], [0.27, 0.27, 0.7], [0.72, 0.12, 0.9]]) {
      const lobes = [[-0.05, 0.004, 0.03], [-0.01, -0.012, 0.042], [0.035, -0.002, 0.034], [0.07, 0.008, 0.022]].map(([dx, dy, r]) => ({ x: W * (cx + dx * s), y: H * cy + W * dy * s, r: W * r * s }));
      const bottom = H * cy + W * 0.02 * s;
      const left = Math.min(...lobes.map((l) => l.x - l.r)); const right = Math.max(...lobes.map((l) => l.x + l.r));
      const pts = [];
      for (let i = 0; i <= 14; i += 1) {
        const x = left + ((right - left) * i) / 14;
        let top = bottom;
        for (const l of lobes) if (Math.abs(x - l.x) < l.r) top = Math.min(top, l.y - Math.sqrt(l.r * l.r - (x - l.x) ** 2));
        pts.push({ x, y: Math.min(top, bottom - 3) });
      }
      pts.push({ x: right, y: bottom }, { x: left, y: bottom });
      toon(P, 'sky', pts, { fill: '#f7fafc', shade: 0.08, shadeDepth: 0.05, soft: 1, highlight: false, outline: 0, light: { x: -0.2, y: -1 }, note: 'cloud' }, 'clouds');
    }
  }

  // Far and mid skylines: flat masses with faint window grids, each plane hazier than the one in front.
  const skylineIds = [];
  for (const [layer, depth, count, hmin, hmax, k] of [['far', 'far', 14, 0.25, 0.55, atmo.farMixToSky || 0.55], ['mid', 'mid', 9, 0.3, 0.62, atmo.midMixToSky || 0.3]]) {
    let x = -W * 0.02;
    const base = night ? '#1a2444' : (depth === 'far' ? '#7f97b3' : '#6c86a6');
    const c = mix(base, hazeC, k);
    while (x < W) {
      const bw = W * P.rand(0.06, 0.12);
      const bh = H * P.rand(hmin, hmax);
      if (x > W * 0.3 && x < W * 0.7 && depth === 'mid') { x += bw * 0.6; continue; }
      const top = horizonY - bh;
      skylineIds.push(P.rect(layer, { x, y: top, w: bw, h: bh + 2, fill: { type: 'linear', angle: 0, stops: [{ offset: 0, color: lighten(c, 0.06) }, { offset: 1, color: darken(c, 0.06) }] } }, 'skyline', `${depth} building`));
      P.rect(layer, { x: x + bw * 0.12, y: top + bh * 0.06, w: bw * 0.76, h: bh * 0.9, fill: { type: 'pattern', kind: 'tiles', color: rgba(night ? '#ffd27a' : '#ffffff', depth === 'far' ? 0.12 : 0.2), scale: Math.max(3, bw * 0.06), weight: 1 } }, 'skyline', `${depth} building window grid`);
      if (P.random() < 0.3) P.rect(layer, { x: x + bw * 0.3, y: top - bh * 0.06, w: bw * 0.4, h: bh * 0.06, fill: darken(c, 0.04) }, 'skyline', `${depth} rooftop structure`);
      x += bw + W * P.rand(0.0, 0.015);
    }
  }
  if (ev.on('atmospheric-perspective')) ev.record('atmospheric-perspective', `Three depth planes: far skyline mixed ${Math.round((atmo.farMixToSky || 0.55) * 100)}% toward the haze colour, mid ${Math.round((atmo.midMixToSky || 0.3) * 100)}%, hero building at full value.`, skylineIds.slice(0, 6), 'skyline');

  // Hero tower (glass) with stone corner pilasters, flanked by a lower stone block.
  const tower = box(P, { vpL, vpR, cx: W * 0.47, yTop: H * 0.04, yBase: horizonY + H * 0.02, xLeft: W * 0.33, xRight: W * 0.62 });
  const wing = box(P, { vpL, vpR, cx: W * 0.67, yTop: H * 0.24, yBase: horizonY + H * 0.03, xLeft: W * 0.6, xRight: W * 0.76 });
  const wingL = box(P, { vpL, vpR, cx: W * 0.3, yTop: H * 0.2, yBase: horizonY + H * 0.03, xLeft: W * 0.22, xRight: W * 0.36 });
  stoneFace(P, 'hero', wingL.leftFace, { stone: darken(stone, 0.05), glass: glassBase, rows: 9, cols: 3, el: 'building', name: 'left wing' });
  stoneFace(P, 'hero', wingL.rightFace, { stone: darken(stone, 0.22), glass: darken(glassBase, 0.1), rows: 9, cols: 2, el: 'building', name: 'left wing side' });
  stoneFace(P, 'hero', wing.leftFace, { stone: darken(stone, 0.04), glass: glassBase, rows: 8, cols: 2, el: 'building', name: 'right wing' });
  stoneFace(P, 'hero', wing.rightFace, { stone: darken(stone, 0.2), glass: darken(glassBase, 0.12), rows: 8, cols: 4, el: 'building', name: 'right wing side' });
  glassFace(P, 'hero', tower.leftFace, { glass: lighten(glassBase, 0.05), cols: 8, rows: 26, mullion, mullionWidth: 1.4, lit: true, el: 'tower', name: 'tower lit face' });
  glassFace(P, 'hero', tower.rightFace, { glass: darken(glassBase, 0.18), cols: 6, rows: 26, mullion, mullionWidth: 1.4, lit: false, el: 'tower', name: 'tower shaded face' });
  for (const [face, u0, u1, k] of [[tower.leftFace, 0, 0.06, 0], [tower.leftFace, 0.94, 1, 0], [tower.rightFace, 0, 0.07, 0.2]]) {
    const map = homography([face[0], face[1], face[2], face[3]]);
    P.poly('hero', quadPoly(map, u0, 0, u1, 1), { fill: { type: 'linear', angle: 0, stops: [{ offset: 0, color: lighten(stone, 0.12 - k) }, { offset: 1, color: darken(stone, 0.1 + k) }] }, stroke: darken(stone, 0.5), strokeWidth: 1.2 }, 'tower', 'stone corner pilaster');
  }
  {
    const map = homography([tower.leftFace[0], tower.leftFace[1], tower.leftFace[2], tower.leftFace[3]]);
    const mapR = homography([tower.rightFace[0], tower.rightFace[1], tower.rightFace[2], tower.rightFace[3]]);
    P.poly('hero', quadPoly(map, 0, 0, 1, 0.02), { fill: lighten(stone, 0.15), stroke: darken(stone, 0.5), strokeWidth: 1.2 }, 'tower', 'roof crown band');
    P.poly('hero', quadPoly(mapR, 0, 0, 1, 0.02), { fill: darken(stone, 0.12), stroke: darken(stone, 0.5), strokeWidth: 1.2 }, 'tower', 'roof crown band');
  }

  // Curved glass podium at the base of the tower (a cylinder segment: mullions crowd toward its sides).
  const pc = { x: W * 0.47, yTop: H * 0.58, yBase: horizonY + H * 0.03, r: W * 0.17 };
  const bulge = H * 0.035;
  const arc = (yy, sign) => { const pts = []; for (let i = 0; i <= 24; i += 1) { const t = -Math.PI / 2 + (i / 24) * Math.PI; pts.push({ x: pc.x + Math.sin(t) * pc.r, y: yy + Math.cos(t) * bulge * sign }); } return pts; };
  const topArc = arc(pc.yTop, 1);
  const baseArc = arc(pc.yBase, 1);
  const podium = topArc.concat(baseArc.slice().reverse());
  const podClip = { type: 'path', segments: podium.map((p, i) => ({ op: i ? 'L' : 'M', x: p.x, y: p.y })) };
  P.poly('hero', podium, { fill: { type: 'linear', angle: 0, smooth: true, stops: [{ offset: 0, color: lighten(glassBase, 0.25) }, { offset: 0.45, color: glassBase }, { offset: 1, color: darken(glassBase, 0.35) }] } }, 'building', 'curved glass podium (cylinder shading)');
  P.poly('hero', [{ x: pc.x - pc.r * 0.7, y: pc.yBase + bulge }, { x: pc.x - pc.r * 0.45, y: pc.yBase + bulge }, { x: pc.x - pc.r * 0.05, y: pc.yTop }, { x: pc.x - pc.r * 0.3, y: pc.yTop }], { fill: rgba('#ffffff', 0.18), clip: podClip, blur: 3 }, 'building', 'podium reflection band');
  for (let i = 1; i < 18; i += 1) {
    const t = -Math.PI / 2 + (i / 18) * Math.PI;
    const x = pc.x + Math.sin(t) * pc.r;
    P.line('hero', { x1: x, y1: pc.yTop + Math.cos(t) * bulge, x2: x, y2: pc.yBase + Math.cos(t) * bulge, stroke: mullion, strokeWidth: 1.4, cap: 'butt' }, 'building', 'podium mullion (closer together toward the sides)');
  }
  for (const frac of [0.33, 0.66]) {
    const yy = pc.yTop + (pc.yBase - pc.yTop) * frac;
    P.draw('draw.path', 'hero', { segments: smoothSegments(arc(yy, 1), false), closed: false, fill: null, stroke: mullion, strokeWidth: 1.6 }, 'building', 'podium transom (follows the curve)');
  }
  P.draw('draw.path', 'hero', { segments: smoothSegments(arc(pc.yTop, 1), false), closed: false, fill: null, stroke: lighten(stone, 0.2), strokeWidth: H * 0.012 }, 'building', 'podium roof slab edge');
  const canopyY = pc.yTop + (pc.yBase - pc.yTop) * 0.62;
  P.draw('draw.path', 'hero', { segments: smoothSegments(arc(canopyY, 1.3).slice(6, 19), false), closed: false, fill: null, stroke: '#2f3238', strokeWidth: H * 0.012 }, 'building', 'entrance canopy');
  for (const dx of [-0.18, -0.06, 0.06, 0.18]) {
    toonRect(P, 'hero', { x: pc.x + dx * pc.r * 2 - H * 0.007, y: canopyY + bulge, w: H * 0.014, h: pc.yBase - canopyY }, { fill: lighten(stone, 0.05), shade: 0.3, edge: false, outline: 1, note: 'entrance column' }, 'building');
  }
  P.poly('hero', podium, { fill: null, stroke: darken(glassBase, 0.6), strokeWidth: 1.6 }, 'building', 'podium outline');

  // Plaza: warm paving with joints converging to the right vanishing point; planting strips.
  P.draw('draw.rect', 'ground', { x: 0, y: horizonY + H * 0.025, w: W, h: H - horizonY, fill: { type: 'linear', angle: 90, smooth: true, stops: [{ offset: 0, color: night ? '#3a3a44' : '#d9cbb3' }, { offset: 1, color: night ? '#2a2a32' : '#cbb898' }] } }, 'road', 'plaza paving');
  // Paving slabs in two-point perspective: one family of joints runs to each vanishing point.
  const plaza = { type: 'rect', x: 0, y: horizonY + H * 0.025, w: W, h: H };
  for (const vp of [vpL, vpR]) {
    for (let i = -14; i <= 14; i += 1) {
      const x0 = W / 2 + i * W * 0.11;
      const t = 3;
      P.line('ground', { x1: vp.x + (x0 - vp.x) * t, y1: vp.y + (H - vp.y) * t, x2: vp.x, y2: vp.y, stroke: rgba('#8a7a62', 0.28), strokeWidth: 1, cap: 'butt', clip: plaza }, 'road', 'paving joint (to its vanishing point)');
    }
  }
  for (const [x0, x1] of [[0, W * 0.2], [W * 0.82, W]]) {
    P.rect('ground', { x: x0, y: horizonY + H * 0.02, w: x1 - x0, h: H * 0.035, fill: night ? '#22332a' : '#5f8a5a' }, 'grass', 'planting strip');
    for (let b = 0; b < 4; b += 1) {
      const bx = x0 + (x1 - x0) * (b + 0.5) / 4;
      toon(P, 'ground', organic(P, bx, horizonY + H * 0.02, (x1 - x0) / 7, H * 0.03, 0.15, 14), { fill: night ? '#2b4a36' : '#4f8a58', shade: 0.3, outline: 1, note: 'shrub' }, 'grass');
    }
  }

  // Trees (depth-scaled) and walkers with their eyes on the horizon.
  const leaf = night ? '#2b4a36' : mix(palette.foliage || '#3f7d4a', '#3f7a52', 0.5);
  for (const [x, gy, h] of [[W * 0.07, H * 0.94, H * 0.55], [W * 0.93, H * 0.93, H * 0.5], [W * 0.23, horizonY + H * 0.05, H * 0.28], [W * 0.8, horizonY + H * 0.045, H * 0.26]]) {
    streetTree(P, 'front', x, gy, h, leaf, 'trees');
  }
  const outfits = [['#8a5a3b', '#2d3142', '#2a2a30', '#3d4a5a'], ['#e0a95a', '#3a3a48', '#f2f0ea', null], ['#3b6ea8', '#2b2f3a', '#5a3b22', '#2f3b55'], ['#c4c9d4', '#2d3142', '#2a2a30', '#4a5a6a'], ['#e8b04a', '#1f2f5a', '#8a5a3b', '#8a5a3b']];
  const walkers = [[0.16, 0.985, 1], [0.32, 0.965, 1], [0.66, 0.975, -1], [0.75, 0.99, 1], [0.84, 0.985, -1]];
  walkers.forEach(([fx, fy, facing], i) => {
    const footY = H * fy;
    const height = (footY - horizonY) / (6.5 / 7);
    const [top, pants, shoe, bag] = outfits[i % outfits.length];
    walker(P, 'front', { cx: W * fx, footY, height, facing, top, pants, shoe, backpack: bag, skin: SKIN[i % SKIN.length], hair: HAIR[i % HAIR.length], longHair: i % 2 === 1, el: 'person' });
  });
  ev.record('figure-proportion-balance', 'Walkers built in 7 head units, mid-stride (opposite arm and leg forward), eyes on the horizon so their size follows perspective.', (P.elements.get('person') || []).slice(0, 4), 'person');

  // Finishing (engine post effects): haze along the horizon, gentle grade, grain against banding.
  ctx.effects = night
    ? [{ type: 'grade', contrast: 1.06, saturation: 0.95 }, { type: 'bloom', radius: 16, amount: 0.55 }, { type: 'vignette', amount: 0.3 }, { type: 'grain', amount: 0.12 }]
    : [{ type: 'haze', color: hazeC, from: 0.45, to: 0.85, amount: 0.22 }, { type: 'grade', contrast: 1.05, saturation: 0.95, warmth: 0.06 }, { type: 'grain', amount: 0.1 }];

  return {
    perspective: { type: 'two-point', horizonY: Math.round(horizonY), vpLeft: { x: Math.round(vpL.x), y: Math.round(vpL.y) }, vpRight: { x: Math.round(vpR.x), y: Math.round(vpR.y) } },
    depthPlanes: ['sky', 'far skyline', 'mid skyline', 'hero tower + wings + curved podium', 'plaza', 'trees + people'],
    peopleEyeLevel: 'eyes on the horizon line',
    checks: verifyConvergence([tower, wing, wingL], vpL, vpR),
    lighting,
    requested: intent.elements.map((e) => e.id),
  };
}

module.exports = { composeCity, walker, streetTree };
