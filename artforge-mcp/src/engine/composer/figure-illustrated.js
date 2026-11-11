'use strict';

/**
 * Illustrated standing figure (front view). Built from body landmarks in head units (7 heads, an
 * illustration convention — not quoted from the books) and drawn with the style kit: every form has a
 * shadow side, a highlight and an outline; the face has eyes (white, iris, pupil, catch-light, lid),
 * eyebrows, a shaded nose, lips and cheeks; clothes have collars, buttons, sleeves, creases and soles.
 */

const { toon, limbOutline, ellipsePoints, taper, shadowOf, lightOf } = require('./style');
const { mix, darken, lighten, rgba } = require('../color');

function standingIllustrated(P, o) {
  const L = o.layer;
  const el = o.element || 'person';
  const heads = 7;
  const u = o.height / heads;
  const cx = o.cx;
  const fy = o.footY;
  const y = (k) => fy - k * u;
  const female = o.gender === 'female';
  const skin = o.skin || '#e0a982';
  const hair = o.hair || '#2b1d16';
  const shirt = o.shirt || '#2f6fb0';
  const pants = o.pants || '#5a4a3a';
  const shoe = o.shoe || '#2a2a30';
  const eyes = o.eyes || '#5a3b22';
  const line = (c) => darken(c, 0.55);
  const lw = Math.max(1.4, u * 0.03);
  const sh = female ? 0.82 : 0.95;

  // Weight on the figure's right leg (viewer's left): balanced over that ankle.
  const support = { hip: { x: cx - 0.34 * u, y: y(3.62) }, knee: { x: cx - 0.3 * u, y: y(2.0) }, ankle: { x: cx - 0.25 * u, y: y(0.32) } };
  const free = { hip: { x: cx + 0.34 * u, y: y(3.58) }, knee: { x: cx + 0.4 * u, y: y(2.02) }, ankle: { x: cx + 0.47 * u, y: y(0.34) } };

  if (o.hairLength === 'long') {
    toon(P, L, [
      { x: cx - 0.46 * u, y: y(6.6) }, { x: cx, y: y(7.08) }, { x: cx + 0.46 * u, y: y(6.6) },
      { x: cx + 0.56 * u, y: y(5.55) }, { x: cx, y: y(5.75) }, { x: cx - 0.56 * u, y: y(5.55) },
    ], { fill: darken(hair, 0.1), shade: 0.12, outline: lw, note: 'long hair (back)' }, el);
  }

  // Legs (trousers), then shoes.
  for (const leg of [free, support]) {
    toon(P, L, limbOutline([leg.hip, leg.knee, leg.ankle], [0.7 * u, 0.5 * u, 0.42 * u]), { fill: pants, shade: 0.28, outline: lw, note: 'trouser leg' }, el);
    taper(P, L, { x: leg.knee.x - 0.06 * u, y: leg.knee.y - 0.12 * u }, { x: leg.knee.x + 0.1 * u, y: leg.knee.y + 0.05 * u }, 0.03 * u, rgba(line(pants), 0.5), el, 'knee fold', { x: 0, y: 0.04 * u });
    taper(P, L, { x: leg.hip.x + 0.05 * u, y: leg.hip.y + 0.4 * u }, { x: leg.ankle.x + 0.02 * u, y: leg.ankle.y - 0.2 * u }, 0.018 * u, rgba(lighten(pants, 0.2), 0.45), el, 'trouser crease');
  }
  for (const leg of [free, support]) {
    const s = { x: leg.ankle.x, y: fy - 0.1 * u };
    const shoePts = [
      { x: s.x - 0.26 * u, y: s.y + 0.07 * u }, { x: s.x - 0.26 * u, y: s.y - 0.1 * u }, { x: s.x - 0.12 * u, y: s.y - 0.24 * u },
      { x: s.x + 0.12 * u, y: s.y - 0.24 * u }, { x: s.x + 0.28 * u, y: s.y - 0.08 * u }, { x: s.x + 0.3 * u, y: s.y + 0.07 * u },
    ];
    toon(P, L, shoePts, { fill: shoe, shade: 0.25, outline: lw, lineColor: darken(shoe, 0.6), note: 'shoe' }, el);
    P.rect(L, { x: s.x - 0.27 * u, y: s.y + 0.03 * u, w: 0.58 * u, h: 0.07 * u, radius: 0.03 * u, fill: shoe === '#f2f0ea' ? '#c9c5bb' : lighten(shoe, 0.55) }, el, 'shoe sole');
    for (let k = 0; k < 3; k += 1) P.line(L, { x1: s.x - 0.07 * u, y1: s.y - (0.16 - k * 0.045) * u, x2: s.x + 0.08 * u, y2: s.y - (0.16 - k * 0.045) * u, stroke: darken(shoe, 0.35), strokeWidth: Math.max(1, 0.018 * u), cap: 'round' }, el, 'lace');
  }

  // Arms (skin) behind the torso; sleeves drawn after the torso.
  const arms = [-1, 1].map((s) => ({
    s,
    shoulder: { x: cx + s * (sh - 0.12) * u, y: y(5.52) },
    elbow: { x: cx + s * (sh + 0.06) * u, y: y(4.45) },
    wrist: { x: cx + s * (sh + 0.02) * u, y: y(3.58) },
  }));
  for (const a of arms) {
    toon(P, L, limbOutline([a.shoulder, a.elbow, a.wrist], [0.34 * u, 0.28 * u, 0.22 * u]), { fill: skin, shade: 0.3, outline: lw, lineColor: darken(skin, 0.45), note: 'arm' }, el);
    const hand = { x: a.wrist.x, y: y(3.36) };
    toon(P, L, ellipsePoints(hand.x, hand.y, 0.13 * u, 0.2 * u, 14), { fill: skin, shade: 0.3, outline: lw, lineColor: darken(skin, 0.45), note: 'hand' }, el);
    toon(P, L, ellipsePoints(hand.x - a.s * 0.11 * u, hand.y - 0.06 * u, 0.05 * u, 0.1 * u, 10, a.s * 0.4), { fill: skin, shade: 0.25, highlight: false, outline: lw * 0.8, lineColor: darken(skin, 0.45), note: 'thumb' }, el);
    for (let f = 0; f < 3; f += 1) P.line(L, { x1: hand.x - 0.07 * u + f * 0.06 * u, y1: hand.y + 0.08 * u, x2: hand.x - 0.07 * u + f * 0.06 * u, y2: hand.y + 0.18 * u, stroke: rgba(darken(skin, 0.4), 0.6), strokeWidth: Math.max(1, 0.012 * u), cap: 'round' }, el, 'finger line');
  }

  // Neck, then shirt over its base.
  toon(P, L, [{ x: cx - 0.15 * u, y: y(6.12) }, { x: cx + 0.15 * u, y: y(6.12) }, { x: cx + 0.17 * u, y: y(5.6) }, { x: cx - 0.17 * u, y: y(5.6) }], { fill: skin, shade: 0.35, highlight: false, outline: lw, lineColor: darken(skin, 0.45), note: 'neck' }, el);
  const torso = [
    { x: cx - 0.2 * u, y: y(5.8) }, { x: cx - sh * u, y: y(5.6) }, { x: cx - (sh - 0.02) * u, y: y(5.35) }, { x: cx - (sh - 0.16) * u, y: y(5.0) },
    { x: cx - 0.66 * u, y: y(4.35) }, { x: cx - 0.74 * u, y: y(3.75) }, { x: cx, y: y(3.68) }, { x: cx + 0.74 * u, y: y(3.75) },
    { x: cx + 0.66 * u, y: y(4.35) }, { x: cx + (sh - 0.16) * u, y: y(5.0) }, { x: cx + (sh - 0.02) * u, y: y(5.35) }, { x: cx + sh * u, y: y(5.6) },
    { x: cx + 0.2 * u, y: y(5.8) }, { x: cx, y: y(5.5) },
  ];
  toon(P, L, torso, { fill: shirt, shade: 0.16, outline: lw, note: 'shirt' }, el);
  for (const a of arms) {
    const mid = { x: (a.shoulder.x + a.elbow.x) / 2, y: (a.shoulder.y + a.elbow.y) / 2 };
    const end = { x: a.shoulder.x + (a.elbow.x - a.shoulder.x) * 0.62, y: a.shoulder.y + (a.elbow.y - a.shoulder.y) * 0.62 };
    toon(P, L, limbOutline([{ x: a.shoulder.x - a.s * 0.02 * u, y: a.shoulder.y - 0.04 * u }, mid, end], [0.4 * u, 0.37 * u, 0.35 * u]), { fill: shirt, shade: 0.22, highlightAlpha: 0.25, outline: lw, note: 'sleeve' }, el);
    P.line(L, { x1: end.x - 0.2 * u, y1: end.y + 0.01 * u, x2: end.x + 0.2 * u, y2: end.y - 0.02 * u, stroke: rgba(line(shirt), 0.55), strokeWidth: lw, cap: 'round' }, el, 'sleeve hem');
  }
  // Collar, placket, buttons, folds.
  for (const s of [-1, 1]) {
    toon(P, L, [{ x: cx + s * 0.02 * u, y: y(5.5) }, { x: cx + s * 0.22 * u, y: y(5.82) }, { x: cx + s * 0.34 * u, y: y(5.66) }, { x: cx + s * 0.2 * u, y: y(5.42) }],
      { fill: lighten(shirt, 0.08), shade: 0.25, highlight: false, outline: lw, note: 'collar' }, el);
  }
  P.line(L, { x1: cx, y1: y(5.48), x2: cx, y2: y(3.72), stroke: rgba(line(shirt), 0.45), strokeWidth: Math.max(1, 0.02 * u), cap: 'round' }, el, 'button placket');
  for (let b = 0; b < 4; b += 1) P.ellipse(L, { x: cx - 0.035 * u, y: y(5.3 - b * 0.42) - 0.035 * u, w: 0.07 * u, h: 0.07 * u, fill: lightOf(shirt, 0.45), stroke: line(shirt), strokeWidth: Math.max(0.8, 0.01 * u) }, el, 'button');
  taper(P, L, { x: cx - 0.55 * u, y: y(4.6) }, { x: cx - 0.2 * u, y: y(4.25) }, 0.03 * u, rgba(line(shirt), 0.35), el, 'shirt fold', { x: 0.02 * u, y: 0.06 * u });
  taper(P, L, { x: cx + 0.5 * u, y: y(4.75) }, { x: cx + 0.22 * u, y: y(4.3) }, 0.03 * u, rgba(line(shirt), 0.35), el, 'shirt fold', { x: -0.02 * u, y: 0.06 * u });

  // Head.
  const hc = { x: cx, y: y(6.5) };
  for (const s of [-1, 1]) {
    toon(P, L, ellipsePoints(cx + s * 0.37 * u, y(6.45), 0.065 * u, 0.11 * u, 12), { fill: skin, shade: 0.3, highlight: false, outline: lw, lineColor: darken(skin, 0.45), note: 'ear' }, el);
  }
  const face = [
    { x: cx, y: y(7.0) }, { x: cx + 0.3 * u, y: y(6.92) }, { x: cx + 0.37 * u, y: y(6.62) }, { x: cx + 0.35 * u, y: y(6.38) },
    { x: cx + 0.27 * u, y: y(6.16) }, { x: cx + 0.12 * u, y: y(6.0) }, { x: cx, y: y(5.97) }, { x: cx - 0.12 * u, y: y(6.0) },
    { x: cx - 0.27 * u, y: y(6.16) }, { x: cx - 0.35 * u, y: y(6.38) }, { x: cx - 0.37 * u, y: y(6.62) }, { x: cx - 0.3 * u, y: y(6.92) },
  ];
  const head = toon(P, L, face, { fill: skin, shade: 0.12, shadeDepth: 0.18, highlightAmount: 0.12, outline: lw, lineColor: darken(skin, 0.45), note: 'face' }, el);
  for (const s of [-1, 1]) {
    const ex = cx + s * 0.15 * u;
    const ey = y(6.47);
    P.blob(L, ellipsePoints(ex, ey, 0.085 * u, 0.048 * u, 12), { fill: '#fbf8f2' }, el, 'eye white');
    P.ellipse(L, { x: ex - 0.045 * u, y: ey - 0.045 * u, w: 0.09 * u, h: 0.09 * u, fill: eyes, clip: { type: 'ellipse', x: ex - 0.085 * u, y: ey - 0.048 * u, w: 0.17 * u, h: 0.096 * u } }, el, 'iris');
    P.ellipse(L, { x: ex - 0.022 * u, y: ey - 0.022 * u, w: 0.044 * u, h: 0.044 * u, fill: '#141418' }, el, 'pupil');
    P.ellipse(L, { x: ex - 0.03 * u, y: ey - 0.034 * u, w: 0.022 * u, h: 0.022 * u, fill: '#ffffff' }, el, 'catch-light');
    taper(P, L, { x: ex - 0.1 * u, y: ey + 0.005 * u }, { x: ex + 0.1 * u, y: ey - 0.002 * u }, 0.028 * u, darken(hair, 0.2), el, 'upper eyelid', { x: 0, y: -0.055 * u });
    taper(P, L, { x: cx + s * 0.06 * u, y: y(6.6) }, { x: cx + s * 0.25 * u, y: y(6.63) }, 0.045 * u, darken(hair, 0.05), el, 'eyebrow', { x: 0, y: -0.03 * u });
    P.ellipse(L, { x: cx + s * 0.22 * u - 0.07 * u, y: y(6.3) - 0.035 * u, w: 0.14 * u, h: 0.07 * u, fill: rgba('#e36b6b', o.smile ? 0.3 : 0.18), blur: Math.max(1, 0.02 * u) }, el, 'cheek');
  }
  taper(P, L, { x: cx + 0.015 * u, y: y(6.47) }, { x: cx + 0.04 * u, y: y(6.32) }, 0.035 * u, rgba(shadowOf(skin, 0.3), 0.8), el, 'nose shadow side');
  for (const s of [-1, 1]) P.ellipse(L, { x: cx + s * 0.035 * u - 0.016 * u, y: y(6.3) - 0.008 * u, w: 0.032 * u, h: 0.016 * u, fill: rgba(darken(skin, 0.5), 0.7) }, el, 'nostril');
  if (o.smile) {
    const mouth = [{ x: cx - 0.13 * u, y: y(6.2) }, { x: cx, y: y(6.18) }, { x: cx + 0.13 * u, y: y(6.2) }, { x: cx + 0.05 * u, y: y(6.11) }, { x: cx, y: y(6.095) }, { x: cx - 0.05 * u, y: y(6.11) }];
    P.blob(L, mouth, { fill: '#7a2e2e', stroke: '#5a1f22', strokeWidth: Math.max(1, 0.015 * u) }, el, 'smiling mouth (open)');
    P.rect(L, { x: cx - 0.12 * u, y: y(6.19), w: 0.24 * u, h: 0.035 * u, fill: '#fbf8f2', clip: { type: 'path', segments: require('./builder').smoothSegments(mouth, true) } }, el, 'teeth');
    taper(P, L, { x: cx - 0.15 * u, y: y(6.21) }, { x: cx - 0.11 * u, y: y(6.2) }, 0.02 * u, rgba(darken(skin, 0.4), 0.7), el, 'smile corner');
    taper(P, L, { x: cx + 0.11 * u, y: y(6.2) }, { x: cx + 0.15 * u, y: y(6.21) }, 0.02 * u, rgba(darken(skin, 0.4), 0.7), el, 'smile corner');
  } else {
    P.blob(L, [{ x: cx - 0.1 * u, y: y(6.17) }, { x: cx, y: y(6.18) }, { x: cx + 0.1 * u, y: y(6.17) }, { x: cx, y: y(6.12) }], { fill: mix(skin, '#b05050', 0.45) }, el, 'lips');
  }
  P.ellipse(L, { x: cx - 0.14 * u, y: y(6.04) - 0.02 * u, w: 0.28 * u, h: 0.05 * u, fill: rgba(shadowOf(skin, 0.4), 0.25), blur: Math.max(1, 0.02 * u), clip: head.clip }, el, 'chin shadow');

  // Hair mass with a hairline and highlights.
  const hairPts = o.hairLength === 'long'
    ? [{ x: cx - 0.42 * u, y: y(6.2) }, { x: cx - 0.44 * u, y: y(6.75) }, { x: cx - 0.3 * u, y: y(7.02) }, { x: cx, y: y(7.12) }, { x: cx + 0.32 * u, y: y(7.02) }, { x: cx + 0.45 * u, y: y(6.75) }, { x: cx + 0.42 * u, y: y(6.2) }, { x: cx + 0.34 * u, y: y(6.6) }, { x: cx + 0.12 * u, y: y(6.8) }, { x: cx - 0.18 * u, y: y(6.76) }, { x: cx - 0.34 * u, y: y(6.62) }]
    : [{ x: cx - 0.39 * u, y: y(6.5) }, { x: cx - 0.43 * u, y: y(6.78) }, { x: cx - 0.3 * u, y: y(7.03) }, { x: cx, y: y(7.13) }, { x: cx + 0.32 * u, y: y(7.04) }, { x: cx + 0.44 * u, y: y(6.78) }, { x: cx + 0.39 * u, y: y(6.5) }, { x: cx + 0.33 * u, y: y(6.7) }, { x: cx + 0.08 * u, y: y(6.82) }, { x: cx - 0.16 * u, y: y(6.74) }, { x: cx - 0.34 * u, y: y(6.68) }];
  toon(P, L, hairPts, { fill: hair, shade: 0.14, highlightAmount: 0.18, highlightAlpha: 0.22, outline: lw, lineColor: darken(hair, 0.5), note: 'hair' }, el);
  for (const [a, b] of [[[-0.22, 6.98], [0.05, 6.86]], [[-0.05, 7.04], [0.2, 6.9]], [[0.1, 7.02], [0.3, 6.85]]]) {
    taper(P, L, { x: cx + a[0] * u, y: y(a[1]) }, { x: cx + b[0] * u, y: y(b[1]) }, 0.03 * u, rgba(lightOf(hair, 0.3), 0.45), el, 'hair highlight strand', { x: 0, y: -0.03 * u });
  }

  const neckPit = { x: cx, y: y(5.6) };
  return {
    u,
    headCount: heads,
    neckPit,
    supportAnkle: support.ankle,
    balanceOffsetHeads: Number((Math.abs(neckPit.x - (support.ankle.x + free.ankle.x) / 2) / u).toFixed(3)),
    top: y(7.13),
    feet: fy,
  };
}

module.exports = { standingIllustrated };
