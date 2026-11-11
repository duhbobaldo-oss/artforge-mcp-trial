'use strict';

/**
 * Stylised human figures built from a head-unit canon. The 7.5-head canon is a common drawing
 * convention used here as an engineering default; it is NOT quoted from the indexed books.
 * The books ground only the principle "proportion + balance over the centre of gravity" (figure-drawing p24).
 */

const { darken, lighten, rgba, mix } = require('../color');
const { toon, limbOutline, ellipsePoints, taper } = require('./style');

const SKIN = ['#e8b48f', '#c98e66', '#a8714e', '#f1c7a5', '#8d5a3b'];
const HAIR = ['#2b1d16', '#3d2a1e', '#1a1a1a', '#5a3b22', '#7a5230'];

/** Seated figure in profile; hip at (hx, hy); u = head height; facing 'left' or 'right'. */
function seatedProfile(P, o) {
  const f = o.facing === 'right' ? 1 : -1;
  const u = o.u;
  const L = o.layer;
  const el = o.element || 'person';
  const skin = o.skin || SKIN[0];
  const hair = o.hair || HAIR[0];
  const shirt = o.shirt || '#3b6ea8';
  const pants = o.pants || '#2d3142';
  const shoe = o.shoe || '#1f1f24';
  const H = { x: o.hx, y: o.hy };
  const K = { x: H.x + f * 1.95 * u, y: H.y - 0.05 * u };
  const A = { x: K.x + f * 0.1 * u, y: K.y + 1.85 * u };
  const N = { x: H.x - f * 0.22 * u, y: H.y - 2.55 * u };
  const C = { x: N.x + f * 0.14 * u, y: N.y - 0.66 * u };
  const S = { x: N.x - f * 0.02 * u, y: N.y + 0.32 * u };
  const E = { x: S.x + f * 0.3 * u, y: H.y - 0.62 * u };
  const Hd = { x: E.x + f * 1.0 * u, y: E.y + 0.02 * u };

  const lw = Math.max(1.4, u * 0.03);
  // Light comes from the side the figure faces (the TV / window side), so shading sits on its back.
  const light = { x: f * 0.75, y: -0.65 };
  const ink = (c) => darken(c, 0.55);
  toon(P, L, limbOutline([{ x: H.x - f * 0.1 * u, y: H.y }, { x: (H.x + K.x) / 2, y: (H.y + K.y) / 2 - 0.02 * u }, K], [0.86 * u, 0.74 * u, 0.6 * u]), { fill: pants, shade: 0.25, light, outline: lw, lineColor: ink(pants), note: 'thigh (seated, horizontal on the seat)' }, el);
  toon(P, L, limbOutline([{ x: K.x, y: K.y - 0.1 * u }, { x: (K.x + A.x) / 2, y: (K.y + A.y) / 2 }, A], [0.58 * u, 0.48 * u, 0.4 * u]), { fill: pants, shade: 0.25, light, outline: lw, lineColor: ink(pants), note: 'shin' }, el);
  const toe = { x: A.x + f * 0.8 * u, y: A.y + 0.18 * u };
  toon(P, L, [{ x: A.x - f * 0.22 * u, y: A.y - 0.12 * u }, { x: A.x + f * 0.3 * u, y: A.y - 0.05 * u }, { x: toe.x, y: toe.y - 0.08 * u }, { x: toe.x + f * 0.05 * u, y: toe.y + 0.1 * u }, { x: A.x - f * 0.25 * u, y: A.y + 0.28 * u }],
    { fill: shoe, shade: 0.25, light, outline: lw, lineColor: darken(shoe, 0.6), note: 'shoe' }, el);
  const torso = [
    { x: H.x - f * 0.55 * u, y: H.y + 0.3 * u },
    { x: H.x + f * 0.5 * u, y: H.y + 0.28 * u },
    { x: N.x + f * 0.62 * u, y: N.y + 0.75 * u },
    { x: N.x + f * 0.32 * u, y: N.y + 0.08 * u },
    { x: N.x - f * 0.38 * u, y: N.y + 0.12 * u },
    { x: N.x - f * 0.6 * u, y: N.y + 0.7 * u },
  ];
  toon(P, L, [{ x: N.x - f * 0.12 * u, y: N.y + 0.25 * u }, { x: C.x - f * 0.18 * u, y: C.y + 0.3 * u }, { x: C.x + f * 0.12 * u, y: C.y + 0.42 * u }, { x: N.x + f * 0.18 * u, y: N.y + 0.25 * u }],
    { fill: skin, shade: 0.3, highlight: false, light, outline: lw, lineColor: darken(skin, 0.45), note: 'neck' }, el);
  toon(P, L, torso, { fill: shirt, shade: 0.18, light, outline: lw, lineColor: ink(shirt), note: 'torso (shirt)' }, el);
  taper(P, L, { x: H.x - f * 0.3 * u, y: H.y - 0.25 * u }, { x: H.x + f * 0.25 * u, y: H.y - 0.55 * u }, 0.035 * u, rgba(ink(shirt), 0.35), el, 'shirt fold at the waist', { x: 0, y: 0.05 * u });
  // Profile head: skull, brow, nose, lips and chin as one outline.
  const head = [
    { x: C.x - f * 0.42 * u, y: C.y - 0.05 * u }, { x: C.x - f * 0.3 * u, y: C.y - 0.42 * u }, { x: C.x + f * 0.05 * u, y: C.y - 0.52 * u },
    { x: C.x + f * 0.34 * u, y: C.y - 0.28 * u }, { x: C.x + f * 0.38 * u, y: C.y - 0.1 * u }, { x: C.x + f * 0.5 * u, y: C.y + 0.08 * u },
    { x: C.x + f * 0.4 * u, y: C.y + 0.16 * u }, { x: C.x + f * 0.42 * u, y: C.y + 0.26 * u }, { x: C.x + f * 0.36 * u, y: C.y + 0.4 * u },
    { x: C.x + f * 0.12 * u, y: C.y + 0.48 * u }, { x: C.x - f * 0.18 * u, y: C.y + 0.36 * u },
  ];
  toon(P, L, head, { fill: skin, shade: 0.12, shadeDepth: 0.18, light, outline: lw, lineColor: darken(skin, 0.45), note: 'head (profile)' }, el);
  toon(P, L, ellipsePoints(C.x - f * 0.12 * u, C.y + 0.02 * u, 0.08 * u, 0.13 * u, 12), { fill: skin, shade: 0.3, highlight: false, light, outline: lw, lineColor: darken(skin, 0.45), note: 'ear' }, el);
  toon(P, L, [
    { x: C.x + f * 0.34 * u, y: C.y - 0.26 * u }, { x: C.x + f * 0.1 * u, y: C.y - 0.58 * u }, { x: C.x - f * 0.36 * u, y: C.y - 0.46 * u },
    { x: C.x - f * 0.47 * u, y: C.y + 0.12 * u }, { x: C.x - f * 0.24 * u, y: C.y - 0.02 * u }, { x: C.x + f * 0.14 * u, y: C.y - 0.24 * u },
  ], { fill: hair, shade: 0.14, highlightAlpha: 0.22, light, outline: lw, lineColor: darken(hair, 0.5), note: 'hair' }, el);
  P.blob(L, ellipsePoints(C.x + f * 0.24 * u, C.y - 0.06 * u, 0.06 * u, 0.04 * u, 10), { fill: '#fbf8f2' }, el, 'eye white');
  P.ellipse(L, { x: C.x + f * 0.27 * u - 0.03 * u, y: C.y - 0.09 * u, w: 0.06 * u, h: 0.06 * u, fill: '#2a1d16' }, el, 'iris');
  taper(P, L, { x: C.x + f * 0.17 * u, y: C.y - 0.09 * u }, { x: C.x + f * 0.31 * u, y: C.y - 0.1 * u }, 0.025 * u, darken(hair, 0.2), el, 'upper eyelid', { x: 0, y: -0.03 * u });
  taper(P, L, { x: C.x + f * 0.14 * u, y: C.y - 0.2 * u }, { x: C.x + f * 0.34 * u, y: C.y - 0.2 * u }, 0.04 * u, darken(hair, 0.05), el, 'eyebrow', { x: 0, y: -0.03 * u });
  taper(P, L, { x: C.x + f * 0.32 * u, y: C.y + 0.3 * u }, { x: C.x + f * 0.4 * u, y: C.y + 0.28 * u }, 0.025 * u, mix(skin, '#8a3a3a', 0.5), el, 'lips');
  // Upper arm in the sleeve, forearm resting forward on the armrest, hand.
  toon(P, L, limbOutline([S, { x: (S.x + E.x) / 2, y: (S.y + E.y) / 2 }, E], [0.44 * u, 0.4 * u, 0.36 * u]), { fill: shirt, shade: 0.22, light, outline: lw, lineColor: ink(shirt), note: 'upper arm (sleeve)' }, el);
  toon(P, L, limbOutline([E, { x: (E.x + Hd.x) / 2, y: (E.y + Hd.y) / 2 }, Hd], [0.34 * u, 0.3 * u, 0.26 * u]), { fill: skin, shade: 0.25, light, outline: lw, lineColor: darken(skin, 0.45), note: 'forearm' }, el);
  toon(P, L, ellipsePoints(Hd.x + f * 0.05 * u, Hd.y, 0.2 * u, 0.13 * u, 12), { fill: skin, shade: 0.25, light, outline: lw, lineColor: darken(skin, 0.45), note: 'hand' }, el);
  const result = { hip: H, knee: K, ankle: A, neck: N, head: C, u, facing: f };
  if (o.rim) {
    const rimIdx = [];
    const rim = o.rim;
    rimIdx.push(P.blob(L, [
      { x: C.x + f * 0.35 * u, y: C.y - 0.3 * u }, { x: C.x + f * 0.43 * u, y: C.y }, { x: C.x + f * 0.5 * u, y: C.y + 0.12 * u }, { x: C.x + f * 0.3 * u, y: C.y + 0.42 * u },
    ], { fill: null, stroke: rim.color, strokeWidth: rim.width, blend: 'screen', opacity: rim.alpha }, el, 'rim light on the face edge facing the light', false));
    rimIdx.push(P.blob(L, [torso[3], torso[2], torso[1]], { fill: null, stroke: rim.color, strokeWidth: rim.width, blend: 'screen', opacity: rim.alpha }, el, 'rim light on the chest', false));
    rimIdx.push(P.line(L, { x1: H.x + f * 0.2 * u, y1: H.y - 0.42 * u, x2: K.x, y2: K.y - 0.42 * u, stroke: rim.color, strokeWidth: rim.width, opacity: rim.alpha * 0.8, blend: 'screen' }, el, 'rim light on the thigh'));
    result.rimOps = rimIdx;
  }
  // Balance: when seated the centre of gravity (neck pit) sits over the seat (between hip and back rest).
  result.balance = { centerOfGravityX: N.x, seatFrom: Math.min(H.x - f * 0.6 * u, H.x + f * 0.6 * u), seatTo: Math.max(H.x - f * 0.6 * u, H.x + f * 0.6 * u) };
  return result;
}

module.exports = { seatedProfile, SKIN, HAIR };
