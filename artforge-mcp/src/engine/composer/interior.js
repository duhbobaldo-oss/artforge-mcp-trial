'use strict';

/**
 * Interior scene in one-point perspective: back wall, side walls, floor and ceiling converge to a single
 * vanishing point at eye level. Furniture stands against the back wall (frontal) or in the foreground.
 * Lighting (morning / night / sunset / neutral) drives shadows and light pools through the book rules.
 */

const { harmonize } = require('../swatches');
const { mix, darken, lighten, rgba } = require('../color');
const { seatedProfile, SKIN, HAIR } = require('./figure');
const { standingIllustrated } = require('./figure-illustrated');
const { toon, toonRect, limbOutline, organic, taper, ellipsePoints } = require('./style');

/** Room light: the window and the lamp stand on the right, so lit faces turn to the upper right. */
const RL = { x: 0.62, y: -0.78 };

function lightingModel(lighting, ev) {
  const rulesOn = (id) => ev.on(id);
  const base = {
    morning: { key: 'sun', keyColor: '#fff0d2', sky: ['#8ec5f0', '#e9f5ff'], ambient: 0, night: false },
    sunset: { key: 'sun', keyColor: '#ffbf80', sky: ['#4b3b7a', '#f39a5b'], ambient: 0.12, night: false },
    night: { key: 'lamp', keyColor: '#ffcf87', sky: ['#060a22', '#1b2a5a'], ambient: 0.58, night: true },
    neutral: { key: 'ambient', keyColor: '#ffffff', sky: ['#a9cbe8', '#eef6fb'], ambient: 0, night: false },
  }[lighting || 'neutral'] || null;
  const m = Object.assign({ name: lighting || 'neutral' }, base);
  m.hard = m.key === 'sun';
  m.shadowColor = rulesOn('three-light-systems-sunlight') && m.hard ? 'rgba(40,70,140,0.32)' : 'rgba(0,0,0,0.42)';
  m.shadowBlur = rulesOn('hard-light-sharp-shadow') ? (m.hard ? 3 : 18) : 10;
  return m;
}

function composeInterior(P, ctx) {
  const { W, H } = P;
  const { intent, palette, ev } = ctx;
  const light = lightingModel(intent.lighting, ev);
  const want = (id) => intent.elements.some((e) => e.id === id);
  const requested = intent.elements.map((e) => e.id);

  // Room shell — one-point perspective.
  const bw = { l: W * 0.16, r: W * 0.84, t: H * 0.1, b: H * 0.64 };
  const vp = { x: W * 0.5, y: bw.t + (bw.b - bw.t) * 0.56 };
  const ext = (px, py, X) => ({ x: X, y: vp.y + (py - vp.y) * ((X - vp.x) / (px - vp.x)) });
  const wall = palette.wall;
  const floor = palette.floor;
  P.layer('room', 'الغرفة');
  P.layer('furniture', 'الأثاث');
  P.layer('figure', 'الشخص');
  P.layer('shade', 'الظلال والإضاءة المحيطة', { blend: 'multiply' });
  P.layer('light', 'مصادر الضوء', { blend: 'screen' });

  P.poly('room', [{ x: 0, y: 0 }, { x: W, y: 0 }, { x: bw.r, y: bw.t }, { x: bw.l, y: bw.t }], { fill: lighten(wall, 0.22) }, 'room', 'ceiling (converges to the vanishing point)');
  P.poly('room', [{ x: 0, y: 0 }, { x: bw.l, y: bw.t }, { x: bw.l, y: bw.b }, ext(bw.l, bw.b, 0), { x: 0, y: H }], { fill: darken(wall, 0.12) }, 'room', 'left wall');
  P.poly('room', [{ x: W, y: 0 }, { x: bw.r, y: bw.t }, { x: bw.r, y: bw.b }, ext(bw.r, bw.b, W), { x: W, y: H }], { fill: darken(wall, 0.18) }, 'room', 'right wall');
  P.draw('draw.rect', 'room', { x: bw.l, y: bw.t, w: bw.r - bw.l, h: bw.b - bw.t, fill: { type: 'linear', angle: 90, stops: [{ offset: 0, color: lighten(wall, 0.08) }, { offset: 1, color: wall }] } }, 'room', 'back wall');
  const floorPoly = [{ x: bw.l, y: bw.b }, { x: bw.r, y: bw.b }, ext(bw.r, bw.b, W), { x: W, y: H }, { x: 0, y: H }, ext(bw.l, bw.b, 0)];
  P.poly('room', floorPoly, { fill: { type: 'linear', angle: 90, stops: [{ offset: 0, color: darken(floor, 0.1) }, { offset: 1, color: floor }] } }, 'room', 'floor');
  // Floorboards: each plank its own slightly different tone, seams converge to the vanishing point,
  // and staggered end joints recede in depth.
  const planks = 14;
  const toFloor = (x, yy) => ({ x: vp.x + (x - vp.x) * ((yy - vp.y) / (bw.b - vp.y)), y: yy });
  // Planks continue past both ends of the back wall so the whole floor (also the side triangles) is boarded,
  // clipped to the floor so they never paint over the side walls.
  const floorClip = { type: 'path', segments: floorPoly.map((p, i) => ({ op: i ? 'L' : 'M', x: p.x, y: p.y })) };
  for (let k = -10; k < planks + 10; k += 1) {
    const x0 = bw.l + ((bw.r - bw.l) * k) / planks;
    const x1 = bw.l + ((bw.r - bw.l) * (k + 1)) / planks;
    const tone = [0, 0.04, -0.03, 0.02, -0.05, 0.03][((k % 6) + 6) % 6];
    P.poly('room', [{ x: x0, y: bw.b }, { x: x1, y: bw.b }, toFloor(x1, H), toFloor(x0, H)], { fill: tone >= 0 ? lighten(floor, tone) : darken(floor, -tone), stroke: rgba(darken(floor, 0.45), 0.5), strokeWidth: 1.2, clip: floorClip }, 'room', 'floor plank (converges to the vanishing point)');
    for (const t of [0.18, 0.45, 0.8].map((v) => (v + (((k % 3) + 3) % 3) * 0.11) % 1)) {
      const yy = bw.b + (H - bw.b) * t * t;
      const a = toFloor(x0, yy);
      const b = toFloor(x1, yy);
      P.line('room', { x1: a.x, y1: a.y, x2: b.x, y2: b.y, stroke: rgba(darken(floor, 0.45), 0.45), strokeWidth: 1, cap: 'butt', clip: floorClip }, 'room', 'plank end joint');
    }
  }
  P.rect('room', { x: 0, y: bw.b, w: W, h: (H - bw.b) * 0.5, fill: { type: 'linear', angle: 90, stops: [{ offset: 0, color: 'rgba(0,0,0,0.12)' }, { offset: 1, color: 'rgba(0,0,0,0)' }] }, clip: { type: 'path', segments: floorPoly.map((p, i) => ({ op: i ? 'L' : 'M', x: p.x, y: p.y })) } }, 'room', 'floor darkening toward the back wall (clipped to the floor)');
  for (const [a, b] of [[{ x: bw.l, y: bw.t }, { x: bw.l, y: bw.b }], [{ x: bw.r, y: bw.t }, { x: bw.r, y: bw.b }], [{ x: bw.l, y: bw.t }, { x: bw.r, y: bw.t }], [{ x: 0, y: 0 }, { x: bw.l, y: bw.t }], [{ x: W, y: 0 }, { x: bw.r, y: bw.t }]]) {
    P.line('room', { x1: a.x, y1: a.y, x2: b.x, y2: b.y, stroke: rgba(darken(wall, 0.45), 0.55), strokeWidth: 1.5, cap: 'round' }, 'room', 'wall corner edge');
  }
  toonRect(P, 'room', { x: bw.l, y: bw.b - H * 0.02, w: bw.r - bw.l, h: H * 0.02 }, { fill: lighten(wall, 0.35), shade: 0.3, light: RL, outline: 1.2, note: 'skirting board' }, 'room');

  const s = (bw.b - bw.t) / 270; // px per cm on the back wall (wall height ≈ 2.7 m)
  const onWall = (cmX) => bw.l + cmX * s;
  const contact = (cx, y, w, h) => {
    if (!ev.on('occlusion-shadows')) return null;
    // Floor shadows live on the room layer: under every object, never painted across the person.
    const i = P.soft('room', cx, y, w, h, 'rgba(0,0,0,0.55)', 4, 'shadows', 'occlusion (contact) shadow where the object meets the floor');
    return i;
  };
  const contacts = [];

  // Window on the back wall (left part).
  let windowBox = null;
  if (want('window') || intent.lighting === 'morning' || intent.lighting === 'night' || intent.lighting === 'sunset') {
    const wx = onWall(395); const wy = bw.t + 45 * s; const ww = 120 * s; const wh = 130 * s;
    windowBox = { x: wx, y: wy, w: ww, h: wh };
    const frameC = mix(lighten(wall, 0.45), '#ffffff', 0.4);
    toonRect(P, 'furniture', { x: wx - 10, y: wy - 10, w: ww + 20, h: wh + 20 }, { fill: frameC, shade: 0.25, light: RL, note: 'window frame' }, 'window');
    P.rect('furniture', { x: wx, y: wy, w: ww, h: wh, fill: { type: 'linear', angle: 90, stops: [{ offset: 0, color: light.sky[0] }, { offset: 1, color: light.sky[1] }] }, stroke: darken(frameC, 0.4), strokeWidth: 1.5 }, 'window', 'sky seen through the glass');
    if (light.night) {
      P.soft('furniture', wx + ww * 0.7, wy + wh * 0.28, ww * 0.18, ww * 0.18, '#f4f1de', 0, 'moon', 'moon');
      for (let i = 0; i < 26; i += 1) {
        const r = P.rand(0.8, 2.2);
        P.ellipse('furniture', { x: wx + P.rand(4, ww - 8), y: wy + P.rand(4, wh * 0.85), w: r * 2, h: r * 2, fill: rgba('#ffffff', P.rand(0.5, 0.95)) }, 'stars', 'star (inside the window)');
      }
    } else {
      P.soft('furniture', wx + ww * 0.75, wy + wh * 0.3, ww * 0.45, ww * 0.45, rgba(light.keyColor, 0.9), 14, 'window', 'sun glow in the sky');
    }
    const glass = { type: 'rect', x: wx, y: wy, w: ww, h: wh };
    for (const [a, b] of [[0.15, 0.32], [0.42, 0.5]]) {
      P.poly('furniture', [{ x: wx + ww * a, y: wy + wh }, { x: wx + ww * (a + 0.12), y: wy + wh }, { x: wx + ww * (b + 0.3), y: wy }, { x: wx + ww * (b + 0.18), y: wy }], { fill: rgba('#ffffff', light.night ? 0.06 : 0.18), clip: glass }, 'window', 'glare on the glass');
    }
    toonRect(P, 'furniture', { x: wx + ww / 2 - 4, y: wy, w: 8, h: wh }, { fill: frameC, shade: 0.3, light: RL, edge: false, outline: 1, note: 'mullion' }, 'window');
    toonRect(P, 'furniture', { x: wx, y: wy + wh * 0.45 - 4, w: ww, h: 8 }, { fill: frameC, shade: 0.3, light: RL, edge: false, outline: 1, note: 'transom' }, 'window');
    toonRect(P, 'furniture', { x: wx - 20, y: wy + wh + 8, w: ww + 40, h: 12 }, { fill: frameC, shade: 0.3, light: RL, note: 'window sill' }, 'window');
    P.rect('furniture', { x: wx - 34, y: wy - 30, w: ww + 68, h: 7, radius: 3, fill: '#5b4a3a', stroke: '#3a2e24', strokeWidth: 1 }, 'window', 'curtain rod');
    for (const side of [-1, 1]) {
      // Curtain with folds: a wavy panel gathered by a tie-back, shaded as cloth.
      const x0 = side < 0 ? wx - 30 : wx + ww + 4;
      const cw = 30;
      const top = wy - 24;
      const bottom = wy + wh + 46;
      const tie = wy + wh * 0.62;
      const pts = [{ x: x0, y: top }, { x: x0 + cw, y: top }, { x: x0 + cw + side * 3, y: tie - 20 }, { x: x0 + cw - (side < 0 ? 12 : -2), y: tie }, { x: x0 + cw + 4, y: bottom }, { x: x0 - 4, y: bottom }, { x: x0 + (side < 0 ? 2 : 12), y: tie }, { x: x0 - side * 3, y: tie - 20 }];
      toon(P, 'furniture', pts, { fill: palette.fabric, shade: 0.25, light: RL, outline: 1.5, note: 'curtain' }, 'window');
      for (let k = 1; k <= 3; k += 1) taper(P, 'furniture', { x: x0 + (cw * k) / 4, y: top + 6 }, { x: x0 + (cw * k) / 4 + side * 2, y: tie - 6 }, 2.2, rgba(darken(palette.fabric, 0.45), 0.45), 'window', 'curtain fold');
      for (let k = 1; k <= 3; k += 1) taper(P, 'furniture', { x: x0 + (cw * k) / 4, y: tie + 8 }, { x: x0 + (cw * k) / 4 + (k - 2) * 4, y: bottom - 4 }, 2.2, rgba(darken(palette.fabric, 0.45), 0.45), 'window', 'curtain fold');
      P.rect('furniture', { x: x0 - 2, y: tie - 5, w: cw + 4, h: 10, radius: 5, fill: darken(palette.fabric, 0.25), stroke: darken(palette.fabric, 0.55), strokeWidth: 1 }, 'window', 'curtain tie-back');
    }
  }

  // TV unit (centre of the back wall).
  let tvBox = null;
  if (want('tv')) {
    const cabX = onWall(185); const cabW = 175 * s; const cabH = 52 * s; const cabY = bw.b - cabH;
    const legH = 8 * s;
    for (const lx of [cabX + 10 * s, cabX + cabW - 14 * s]) toonRect(P, 'furniture', { x: lx, y: bw.b - legH, w: 4 * s, h: legH }, { fill: darken(palette.wood, 0.35), light: RL, edge: false, outline: 1, note: 'cabinet leg' }, 'tv');
    toonRect(P, 'furniture', { x: cabX, y: cabY - legH, w: cabW, h: cabH }, { fill: palette.wood, shade: 0.1, light: RL, radius: 4, note: 'TV cabinet' }, 'tv');
    for (let i = 0; i < 3; i += 1) {
      const dx = cabX + 8 * s + i * (cabW - 16 * s) / 3;
      const dw = (cabW - 16 * s) / 3 - 6 * s;
      toonRect(P, 'furniture', { x: dx, y: cabY - legH + 9 * s, w: dw, h: cabH - 16 * s }, { fill: lighten(palette.wood, 0.05), shade: 0.15, light: RL, radius: 3, outline: 1.2, note: 'cabinet door' }, 'tv');
      P.rect('furniture', { x: dx + dw / 2 - 7 * s, y: cabY - legH + 13 * s, w: 14 * s, h: 2.6 * s, radius: 1.3 * s, fill: '#c9b48a', stroke: '#7a6545', strokeWidth: 0.8 }, 'tv', 'door handle');
    }
    contacts.push(contact(cabX + cabW / 2, bw.b + 2, cabW * 1.02, 12 * s));
    const tvW = 125 * s; const tvH = 72 * s; const tvX = cabX + (cabW - tvW) / 2; const tvY = cabY - legH - tvH - 20 * s;
    tvBox = { x: tvX, y: tvY, w: tvW, h: tvH };
    toonRect(P, 'furniture', { x: tvX + tvW / 2 - 5 * s, y: tvY + tvH, w: 10 * s, h: 16 * s }, { fill: '#2b2e35', light: RL, edge: false, outline: 1, note: 'TV stand neck' }, 'tv');
    toonRect(P, 'furniture', { x: tvX + tvW / 2 - 26 * s, y: tvY + tvH + 15 * s, w: 52 * s, h: 5 * s }, { fill: '#2b2e35', light: RL, radius: 2 * s, outline: 1, note: 'TV stand base' }, 'tv');
    toonRect(P, 'furniture', { x: tvX - 6, y: tvY - 6, w: tvW + 12, h: tvH + 12 }, { fill: '#1d2026', shade: 0.06, light: RL, radius: 6, lineColor: '#08090b', note: 'TV bezel' }, 'tv');
    if (light.night) {
      P.draw('draw.rect', 'furniture', { x: tvX, y: tvY, w: tvW, h: tvH, fill: { type: 'linear', angle: 135, stops: [{ offset: 0, color: '#2c7be5' }, { offset: 0.55, color: '#7fd1ff' }, { offset: 1, color: '#1b3f8b' }] } }, 'tv', 'TV screen (on)');
      P.poly('furniture', [{ x: tvX + tvW * 0.1, y: tvY + tvH * 0.85 }, { x: tvX + tvW * 0.4, y: tvY + tvH * 0.45 }, { x: tvX + tvW * 0.6, y: tvY + tvH * 0.7 }, { x: tvX + tvW * 0.75, y: tvY + tvH * 0.5 }, { x: tvX + tvW * 0.92, y: tvY + tvH * 0.85 }], { fill: rgba('#0d2a5c', 0.65) }, 'tv', 'picture on screen');
    } else {
      P.rect('furniture', { x: tvX, y: tvY, w: tvW, h: tvH, fill: '#1c1f26' }, 'tv', 'TV screen (off)');
      P.poly('furniture', [{ x: tvX + tvW * 0.55, y: tvY }, { x: tvX + tvW * 0.75, y: tvY }, { x: tvX + tvW * 0.35, y: tvY + tvH }, { x: tvX + tvW * 0.15, y: tvY + tvH }], { fill: 'rgba(255,255,255,0.07)' }, 'tv', 'window reflection on the dark screen');
    }
  }

  // Bookshelf (right part of the back wall).
  if (want('bookshelf')) {
    const bx = onWall(28); const bWid = 125 * s; const bHei = 205 * s; const by = bw.b - bHei;
    toonRect(P, 'furniture', { x: bx, y: by, w: bWid, h: bHei }, { fill: palette.wood, shade: 0.06, light: RL, note: 'bookshelf frame' }, 'bookshelf');
    P.rect('furniture', { x: bx + 8, y: by + 8, w: bWid - 16, h: bHei - 16, fill: { type: 'linear', angle: 0, stops: [{ offset: 0, color: darken(palette.wood, 0.5) }, { offset: 1, color: darken(palette.wood, 0.35) }] }, stroke: darken(palette.wood, 0.6), strokeWidth: 1.2 }, 'bookshelf', 'bookshelf back panel');
    const shelves = 5;
    const inner = (bHei - 16) / shelves;
    const bookColors = palette.books;
    const bookLine = Math.max(0.8, s * 0.6);
    for (let k = 0; k < shelves; k += 1) {
      const sy = by + 8 + k * inner;
      const baseY = sy + inner - 6;
      let x = bx + 12;
      while (x < bx + bWid - 22) {
        const bwid = P.rand(0.05, 0.085) * bWid;
        if (x + bwid > bx + bWid - 12) break;
        const bh = inner * P.rand(0.58, 0.88);
        const color = P.pick(bookColors);
        const roll = P.random();
        if (roll < 0.07 && x > bx + 30) {
          P.poly('furniture', [{ x, y: baseY }, { x: x + bwid, y: baseY }, { x: x + bwid + bh * 0.28, y: baseY - bh * 0.96 }, { x: x + bh * 0.28, y: baseY - bh }], { fill: color, stroke: darken(color, 0.55), strokeWidth: bookLine }, 'bookshelf', 'leaning book');
          x += bwid + bh * 0.3;
        } else if (roll < 0.12 && x < bx + bWid - 60) {
          // A short horizontal stack of books.
          let sy2 = baseY;
          for (let h = 0; h < 3; h += 1) {
            const hh = inner * P.rand(0.1, 0.14);
            const hw = bWid * P.rand(0.2, 0.26);
            const hc = P.pick(bookColors);
            toonRect(P, 'furniture', { x: x + (h % 2) * 2, y: sy2 - hh, w: hw, h: hh }, { fill: hc, shade: 0.15, light: RL, edge: false, outline: bookLine, note: 'stacked book' }, 'bookshelf');
            sy2 -= hh;
          }
          x += bWid * 0.28;
        } else {
          toonRect(P, 'furniture', { x, y: baseY - bh, w: bwid, h: bh }, { fill: color, shade: 0.2, light: RL, edge: false, outline: bookLine, note: 'book' }, 'bookshelf');
          for (const band of [0.12, 0.85]) P.rect('furniture', { x: x + 1, y: baseY - bh * (1 - band), w: bwid - 2, h: Math.max(1.2, bh * 0.025), fill: rgba(lighten(color, 0.5), 0.7) }, 'bookshelf', 'spine band');
          P.rect('furniture', { x: x + bwid * 0.22, y: baseY - bh * 0.62, w: bwid * 0.56, h: Math.max(2, bh * 0.14), radius: 1, fill: rgba('#f5ecd8', 0.8) }, 'bookshelf', 'spine label');
          x += bwid + 1;
        }
        if (P.random() < 0.05) x += bwid * 1.5;
      }
      toonRect(P, 'furniture', { x: bx + 4, y: baseY, w: bWid - 8, h: 7 }, { fill: lighten(palette.wood, 0.08), shade: 0.3, light: RL, outline: 1, note: 'shelf board' }, 'bookshelf');
      if (ev.on('occlusion-shadows')) {
        P.rect('furniture', { x: bx + 8, y: sy, w: bWid - 16, h: inner * 0.18, fill: { type: 'linear', angle: 90, stops: [{ offset: 0, color: 'rgba(0,0,0,0.55)' }, { offset: 1, color: 'rgba(0,0,0,0)' }] } }, 'shadows', 'occlusion shadow under each shelf');
      }
    }
    contacts.push(contact(bx + bWid / 2, bw.b + 2, bWid * 1.05, 12 * s));
  }

  // Plant in the corner.
  if (want('plant')) {
    const px = onWall(166); const py = bw.b;
    const base = { x: px, y: py - 40 * s };
    // Leaves first (behind the pot rim), back ones darker; each leaf has a midrib.
    const order = [0, 8, 1, 7, 2, 6, 3, 5, 4];
    for (const i of order) {
      const a = -Math.PI / 2 + (i - 4) * 0.28;
      const len = (62 + P.rand(-10, 25)) * s;
      const wid = 0.22;
      const tip = { x: px + Math.cos(a) * len, y: base.y + Math.sin(a) * len };
      const leafPts = [base, { x: px + Math.cos(a - wid) * len * 0.55, y: base.y + Math.sin(a - wid) * len * 0.55 }, tip, { x: px + Math.cos(a + wid) * len * 0.55, y: base.y + Math.sin(a + wid) * len * 0.55 }];
      const back = Math.abs(i - 4) > 2;
      toon(P, 'furniture', leafPts, { fill: back ? '#3a7446' : '#4f9a5b', shade: 0.25, light: RL, outline: 1.2, note: 'leaf' }, 'plant');
      taper(P, 'furniture', base, { x: base.x + (tip.x - base.x) * 0.85, y: base.y + (tip.y - base.y) * 0.85 }, 1.6, rgba('#d9ead0', 0.55), 'plant', 'leaf midrib');
    }
    toon(P, 'furniture', [{ x: px - 17 * s, y: py - 36 * s }, { x: px + 17 * s, y: py - 36 * s }, { x: px + 13 * s, y: py }, { x: px - 13 * s, y: py }], { fill: palette.accent, shade: 0.2, light: RL, outline: 1.4, note: 'pot' }, 'plant');
    toonRect(P, 'furniture', { x: px - 20 * s, y: py - 42 * s, w: 40 * s, h: 8 * s }, { fill: lighten(palette.accent, 0.08), shade: 0.3, light: RL, radius: 2 * s, outline: 1.4, note: 'pot rim' }, 'plant');
    contacts.push(contact(px, py + 2, 40 * s, 8 * s));
  }

  // Rug in perspective (supports the seating area).
  const fgScale = 1.75;
  const u = 25 * s * fgScale; // head height of the foreground person
  const seatHipX = W * 0.74;
  const seatHipY = H * 0.74;
  if (want('rug') || want('person') || want('sofa') || want('armchair')) {
    const depthY1 = bw.b + (H - bw.b) * 0.25;
    const depthY2 = H * 0.98;
    const xAt = (x0, yy) => vp.x + (x0 - vp.x) * ((yy - vp.y) / (bw.b - vp.y));
    P.poly('room', [{ x: xAt(onWall(150), depthY1), y: depthY1 }, { x: xAt(onWall(420), depthY1), y: depthY1 }, { x: xAt(onWall(420), depthY2), y: depthY2 }, { x: xAt(onWall(150), depthY2), y: depthY2 }], { fill: palette.rug }, 'rug', 'rug drawn in perspective');
    const quad = (a, b, y1, y2) => [{ x: xAt(onWall(a), y1), y: y1 }, { x: xAt(onWall(b), y1), y: y1 }, { x: xAt(onWall(b), y2), y: y2 }, { x: xAt(onWall(a), y2), y: y2 }];
    P.poly('room', quad(150, 420, depthY1, depthY2), { fill: null, stroke: darken(palette.rug, 0.45), strokeWidth: 2 }, 'rug', 'rug outline');
    P.poly('room', quad(162, 408, depthY1 + 8, depthY2 - 10), { fill: lighten(palette.rug, 0.12), stroke: lighten(palette.rug, 0.4), strokeWidth: 3 }, 'rug', 'rug inner field');
    P.poly('room', quad(185, 385, depthY1 + 22, depthY2 - 30), { fill: null, stroke: darken(palette.rug, 0.2), strokeWidth: 2 }, 'rug', 'rug pattern band');
    // Central medallion, flattened by the floor's perspective.
    const mx = xAt(onWall(285), (depthY1 + depthY2) / 2);
    const my = (depthY1 + depthY2) / 2;
    P.poly('room', [{ x: mx, y: my - (depthY2 - depthY1) * 0.22 }, { x: mx + (xAt(onWall(340), my) - mx), y: my }, { x: mx, y: my + (depthY2 - depthY1) * 0.22 }, { x: mx - (xAt(onWall(340), my) - mx), y: my }], { fill: darken(palette.rug, 0.18), stroke: lighten(palette.rug, 0.4), strokeWidth: 2 }, 'rug', 'rug medallion');
    for (let k = 0; k <= 30; k += 1) {
      const cm = 150 + (270 * k) / 30;
      const x0 = xAt(onWall(cm), depthY2);
      P.line('room', { x1: x0, y1: depthY2, x2: x0, y2: depthY2 + 8, stroke: lighten(palette.rug, 0.45), strokeWidth: 1.5, cap: 'round' }, 'rug', 'rug fringe');
    }
  }

  // Seated person in an armchair facing the TV (profile, facing left).
  let figure = null;
  if (want('person') || want('armchair') || want('sofa')) {
    const f = -1;
    const chair = want('sofa') && !want('armchair') ? 'sofa' : 'armchair';
    const backX = seatHipX - f * 0.75 * u;
    const up = palette.upholstery;
    const extra = chair === 'sofa' ? 1.4 * u : 0;
    const lwF = Math.max(1.4, u * 0.03);
    // Back rest: a padded, slightly curved cushion; piping along its edge.
    const bx0 = Math.min(backX, backX - f * 0.75 * u);
    toon(P, 'furniture', [{ x: bx0 + 0.05 * u, y: seatHipY - 2.6 * u }, { x: bx0 + 0.72 * u, y: seatHipY - 2.55 * u }, { x: bx0 + 0.8 * u, y: seatHipY + 0.6 * u }, { x: bx0 - 0.02 * u, y: seatHipY + 0.6 * u }, { x: bx0 - 0.08 * u, y: seatHipY - 1.0 * u }],
      { fill: up, shade: 0.2, light: RL, outline: lwF, note: `${chair} back rest` }, chair);
    taper(P, 'furniture', { x: bx0 + 0.15 * u, y: seatHipY - 2.4 * u }, { x: bx0 + 0.12 * u, y: seatHipY + 0.3 * u }, 0.05 * u, rgba(darken(up, 0.4), 0.5), chair, 'back cushion seam', { x: -0.05 * u, y: 0 });
    toonRect(P, 'furniture', { x: seatHipX - 1.0 * u, y: seatHipY + 1.0 * u, w: 2.7 * u + extra, h: 0.55 * u }, { fill: darken(up, 0.12), shade: 0.12, light: RL, radius: 0.08 * u, outline: lwF, note: `${chair} base` }, chair);
    toonRect(P, 'furniture', { x: seatHipX - 1.1 * u, y: seatHipY + 0.25 * u, w: 2.9 * u + extra, h: 0.78 * u }, { fill: lighten(up, 0.04), shade: 0.15, light: RL, radius: 0.28 * u, outline: lwF, note: `${chair} seat cushion` }, chair);
    P.line('furniture', { x1: seatHipX - 0.95 * u, y1: seatHipY + 0.62 * u, x2: seatHipX + 1.65 * u + extra, y2: seatHipY + 0.62 * u, stroke: rgba(darken(up, 0.4), 0.45), strokeWidth: lwF * 0.8, dash: [lwF * 2, lwF * 2], cap: 'round' }, chair, 'cushion stitching');
    for (const lx of [seatHipX - 0.85 * u, seatHipX + 1.45 * u + extra]) {
      toon(P, 'furniture', [{ x: lx, y: seatHipY + 1.55 * u }, { x: lx + 0.2 * u, y: seatHipY + 1.55 * u }, { x: lx + 0.15 * u, y: seatHipY + 1.98 * u }, { x: lx + 0.06 * u, y: seatHipY + 1.98 * u }],
        { fill: darken(palette.wood, 0.2), shade: 0.25, highlight: false, light: RL, outline: lwF * 0.8, note: `${chair} tapered wooden leg` }, chair);
    }
    contacts.push(contact(seatHipX + 0.4 * u, seatHipY + 2.0 * u, 3.6 * u, 0.32 * u));
    if (want('person')) {
      const rimRule = light.night && tvBox && ev.on('rim-light') ? ev.rules.get('rim-light') : null;
      figure = seatedProfile(P, {
        layer: 'figure', hx: seatHipX, hy: seatHipY, u, facing: 'left',
        skin: SKIN[0], hair: (intent.appearance || {}).hair || HAIR[1], shirt: (intent.appearance || {}).shirt || palette.shirt, pants: (intent.appearance || {}).pants || palette.pants, shoe: (intent.appearance || {}).shoe,
        rim: rimRule ? { color: ev.on('color-temperature') ? '#9fd0ff' : '#ffffff', width: rimRule.params.rimWidth, alpha: rimRule.params.rimAlpha } : null,
      });
      if (figure.rimOps) ev.record('rim-light', 'Thin cool rim on face, chest and thigh edges that face the TV (the light source).', figure.rimOps, 'person');
      ev.record('figure-proportion-balance', `Seated figure built in head units (u=${u.toFixed(1)}px); centre of gravity (neck pit x=${figure.balance.centerOfGravityX.toFixed(0)}) sits over the seat.`, P.elements.get('person') ? P.elements.get('person').slice(0, 4) : [], 'person');
      contacts.push(contact(figure.ankle.x - 0.4 * u, figure.ankle.y + 0.25 * u, 1.4 * u, 0.25 * u));
    }
    const lwA = Math.max(1.4, u * 0.03);
    toonRect(P, 'figure', { x: seatHipX - 1.15 * u, y: seatHipY - 0.3 * u, w: 0.55 * u, h: 1.4 * u }, { fill: palette.upholstery, shade: 0.18, light: RL, radius: 0.1 * u, outline: lwA, note: `${chair} armrest front panel` }, chair);
    toonRect(P, 'figure', { x: seatHipX - 1.2 * u, y: seatHipY - 0.78 * u, w: 2.45 * u, h: 0.52 * u }, { fill: lighten(palette.upholstery, 0.06), shade: 0.2, light: RL, radius: 0.24 * u, outline: lwA, note: `${chair} near armrest (in front of the body)` }, chair);
    P.ellipse('figure', { x: seatHipX - 1.2 * u, y: seatHipY - 0.78 * u, w: 0.52 * u, h: 0.52 * u, fill: darken(palette.upholstery, 0.08), stroke: darken(palette.upholstery, 0.55), strokeWidth: lwA }, chair, 'scrolled armrest end');
    P.ellipse('figure', { x: seatHipX - 1.07 * u, y: seatHipY - 0.65 * u, w: 0.26 * u, h: 0.26 * u, fill: null, stroke: rgba(darken(palette.upholstery, 0.45), 0.6), strokeWidth: lwA * 0.8 }, chair, 'armrest scroll detail');
  }

  // Floor lamp beside the seating area.
  if (want('lamp')) {
    const lx = W * 0.92; const ly = H * 0.95;
    const metal = '#3a3a42';
    toon(P, 'furniture', ellipsePoints(lx, ly - 0.06 * u, 0.6 * u, 0.15 * u, 16), { fill: metal, shade: 0.3, light: RL, outline: 1.4, note: 'lamp base' }, 'lamp');
    toonRect(P, 'furniture', { x: lx - 4, y: ly - 3.8 * u, w: 8, h: 3.75 * u }, { fill: metal, shade: 0.4, light: RL, edge: false, outline: 1.2, note: 'lamp pole' }, 'lamp');
    const shadeC = light.night ? '#ffe2a8' : '#efe3c8';
    toon(P, 'furniture', [{ x: lx - 0.58 * u, y: ly - 3.72 * u }, { x: lx + 0.58 * u, y: ly - 3.72 * u }, { x: lx + 0.36 * u, y: ly - 4.58 * u }, { x: lx - 0.36 * u, y: ly - 4.58 * u }],
      { fill: shadeC, shade: light.night ? 0.05 : 0.25, light: RL, outline: 1.4, note: 'lamp shade' }, 'lamp');
    for (const yy of [ly - 3.78 * u, ly - 4.52 * u]) P.line('furniture', { x1: lx - (yy > ly - 4 * u ? 0.56 : 0.35) * u, y1: yy, x2: lx + (yy > ly - 4 * u ? 0.56 : 0.35) * u, y2: yy, stroke: darken(shadeC, 0.35), strokeWidth: 1.6, cap: 'round' }, 'lamp', 'shade trim');
    contacts.push(contact(lx, ly, 1.3 * u, 0.25 * u));
    ctx.lampAt = { x: lx, y: ly - 4.1 * u };
  }

  // Wall frame / clock extras when asked.
  if (want('frame')) {
    const fx = onWall(160); const fy = bw.t + 40 * s; const fw = 70 * s; const fh = 50 * s;
    toonRect(P, 'furniture', { x: fx, y: fy, w: fw, h: fh }, { fill: palette.wood, shade: 0.12, light: RL, note: 'picture frame' }, 'frame');
    const art = { type: 'rect', x: fx + 5 * s, y: fy + 5 * s, w: fw - 10 * s, h: fh - 10 * s };
    P.rect('furniture', { x: art.x, y: art.y, w: art.w, h: art.h, fill: { type: 'linear', angle: 90, stops: [{ offset: 0, color: '#a9d3ee' }, { offset: 1, color: '#f4e3c3' }] } }, 'frame', 'painting: sky');
    P.poly('furniture', [{ x: art.x, y: art.y + art.h }, { x: art.x + art.w * 0.35, y: art.y + art.h * 0.45 }, { x: art.x + art.w * 0.6, y: art.y + art.h * 0.75 }, { x: art.x + art.w * 0.8, y: art.y + art.h * 0.5 }, { x: art.x + art.w, y: art.y + art.h }], { fill: '#6f8f6a', clip: art }, 'frame', 'painting: hills');
    P.ellipse('furniture', { x: art.x + art.w * 0.7, y: art.y + art.h * 0.15, w: art.w * 0.14, h: art.w * 0.14, fill: '#f7d774', clip: art }, 'frame', 'painting: sun');
  }
  if (want('clock')) {
    const ccx = onWall(350) + 17 * s; const ccy = bw.t + 47 * s; const r = 17 * s;
    toon(P, 'furniture', ellipsePoints(ccx, ccy, r, r, 20), { fill: '#fafafa', shade: 0.08, light: RL, outline: 2.5, lineColor: '#333', note: 'wall clock' }, 'clock');
    for (let k = 0; k < 12; k += 1) {
      const a = (k / 12) * Math.PI * 2;
      P.line('furniture', { x1: ccx + Math.cos(a) * r * 0.78, y1: ccy + Math.sin(a) * r * 0.78, x2: ccx + Math.cos(a) * r * 0.9, y2: ccy + Math.sin(a) * r * 0.9, stroke: '#333', strokeWidth: k % 3 === 0 ? 1.8 : 1, cap: 'round' }, 'clock', 'hour tick');
    }
    P.line('furniture', { x1: ccx, y1: ccy, x2: ccx + r * 0.35, y2: ccy - r * 0.35, stroke: '#222', strokeWidth: 2, cap: 'round' }, 'clock', 'hour hand');
    P.line('furniture', { x1: ccx, y1: ccy, x2: ccx - r * 0.05, y2: ccy - r * 0.7, stroke: '#222', strokeWidth: 1.4, cap: 'round' }, 'clock', 'minute hand');
  }

  // ---- Lighting pass
  const lightOps = [];
  if (light.night) {
    const darkIdx = P.rect('shade', { x: 0, y: 0, w: W, h: H, fill: rgba('#0a1030', light.ambient) }, 'lighting', 'night ambient darkness (multiply)');
    lightOps.push(darkIdx);
    if (tvBox) {
      const cool = ev.on('color-temperature') ? '#6fb0ff' : '#ffffff';
      const i1 = P.soft('light', tvBox.x + tvBox.w / 2, tvBox.y + tvBox.h / 2, tvBox.w * 2.6, tvBox.h * 3.2, rgba(cool, 0.32), 40, 'lighting', 'TV glow on the wall (cool source)');
      const i2 = P.soft('light', tvBox.x + tvBox.w / 2, bw.b + (H - bw.b) * 0.35, tvBox.w * 2.4, (H - bw.b) * 0.5, rgba(cool, 0.16), 50, 'lighting', 'TV light spilling on the floor');
      P.rect('light', { x: tvBox.x, y: tvBox.y, w: tvBox.w, h: tvBox.h, fill: rgba('#bfe3ff', 0.35) }, 'lighting', 'screen brightness');
      lightOps.push(i1, i2);
      if (ev.on('color-temperature')) ev.record('color-temperature', 'TV treated as a cool source (#6fb0ff glow); the lamp as a warm source — both temperatures kept in one scene.', [i1, i2], 'tv');
    }
    if (ctx.lampAt) {
      const rule = ev.on('local-light-source') ? ev.rules.get('local-light-source').params : null;
      const radius = (rule ? rule.poolRadiusRatio : 0.5) * W;
      const i3 = P.soft('light', ctx.lampAt.x, ctx.lampAt.y + u * 1.2, radius, radius * 0.9, rgba('#ffbf6b', rule ? rule.poolAlpha : 0.25), rule ? 30 : 60, 'lighting', 'lamp light pool (warm, local falloff)');
      const i4 = P.soft('light', ctx.lampAt.x, ctx.lampAt.y, u * 1.4, u * 1.0, rgba('#fff1c9', 0.9), 12, 'lighting', 'lamp bulb glow');
      lightOps.push(i3, i4);
      if (rule) ev.record('local-light-source', `Warm pool radius ${Math.round(radius)}px around the lamp with quick falloff (blur 30).`, [i3, i4], 'lamp');
    }
    if (windowBox) {
      const i5 = P.soft('light', windowBox.x + windowBox.w / 2, windowBox.y + windowBox.h / 2, windowBox.w * 1.6, windowBox.h * 1.5, rgba('#6f8fd6', 0.18), 30, 'lighting', 'moonlight at the window');
      lightOps.push(i5);
    }
    if (ev.on('key-light')) ev.record('key-light', ctx.lampAt ? 'Lamp is the key light (alpha 0.45); TV and moon are secondary (≤0.32).' : 'TV is the key light; moonlight is secondary.', lightOps.slice(1), 'lighting');
  } else if (windowBox) {
    // Sun patch: the window (right of the back wall) projected onto the floor toward the viewer and to the left.
    const fx = windowBox.x + windowBox.w * 0.4;
    const patch = [
      { x: windowBox.x + windowBox.w * 0.8, y: bw.b + 4 }, { x: windowBox.x - windowBox.w * 0.05, y: bw.b + 4 },
      { x: fx - windowBox.w * 2.6, y: H * 0.92 }, { x: fx - windowBox.w * 0.9, y: H * 0.92 },
    ];
    // Light lands ON the floor: drawn on the room layer (under furniture and the person), brightening with screen blend.
    const i1 = P.poly('room', patch, { fill: rgba(light.keyColor, ev.on('key-light') ? 0.5 : 0.38), blend: 'screen', blur: light.hard && ev.on('hard-light-sharp-shadow') ? 4 : 14 }, 'lighting', 'sunlight patch on the floor (key light)');
    const i2 = P.poly('light', [{ x: windowBox.x, y: windowBox.y }, { x: windowBox.x + windowBox.w, y: windowBox.y }, patch[2], patch[3]], { fill: rgba(light.keyColor, 0.07), blur: 24 }, 'lighting', 'faint light shaft through the air');
    lightOps.push(i1, i2);
    if (ev.on('key-light')) ev.record('key-light', 'Sunlight through the window is the single key light (patch alpha 0.55).', [i1, i2], 'lighting');
    if (ev.on('three-light-systems-sunlight')) {
      const i3 = P.rect('light', { x: 0, y: bw.b, w: W, h: H - bw.b, fill: { type: 'linear', angle: 270, stops: [{ offset: 0, color: 'rgba(255,190,120,0.16)' }, { offset: 1, color: 'rgba(255,190,120,0)' }] } }, 'lighting', 'warm bounce light from the lit floor');
      lightOps.push(i3);
      ev.record('three-light-systems-sunlight', 'Warm sun key + cool blue-tinted shadows (sky fill) + warm floor bounce.', [i1, i3], 'lighting');
    }
    // Cast shadows on the floor, away from the window (light enters from the right, shadows fall left).
    const cast = [];
    const castFrom = (x, y, w, h) => cast.push(P.poly('room', [{ x, y }, { x: x + w, y }, { x: x + w - h * 0.9, y: y + h * 0.35 }, { x: x - h * 0.9, y: y + h * 0.35 }], { fill: light.shadowColor, blur: light.shadowBlur }, 'shadows', 'cast shadow away from the window light'));
    if (figure) castFrom(seatHipX - 1.0 * u, seatHipY + 1.9 * u, 3.2 * u, 1.2 * u);
    if (tvBox) castFrom(tvBox.x - 10, bw.b + 2, tvBox.w * 1.3, 40 * s);
    if (cast.length && ev.on('hard-light-sharp-shadow')) ev.record('hard-light-sharp-shadow', `Direct sun → sharp cast shadows (blur ${light.shadowBlur}px).`, cast, 'shadows');
  }
  const contactOps = contacts.filter((i) => i !== null);
  if (contactOps.length) ev.record('occlusion-shadows', `${contactOps.length} contact shadows where furniture, feet and shelves meet other surfaces.`, contactOps, 'shadows');

  ctx.effects = light.night
    ? [{ type: 'bloom', radius: 18, amount: 0.6 }, { type: 'vignette', amount: 0.3 }, { type: 'grain', amount: 0.1 }]
    : [{ type: 'grade', contrast: 1.04, saturation: 0.97, warmth: light.name === 'morning' ? 0.08 : 0.03 }, { type: 'vignette', amount: 0.12 }, { type: 'grain', amount: 0.08 }];
  return {
    perspective: { type: 'one-point', vanishingPoint: { x: Math.round(vp.x), y: Math.round(vp.y) }, eyeLevel: Math.round(vp.y) },
    lighting: light.name,
    requested,
    figure: figure ? { u: Number(u.toFixed(1)), pose: 'seated' } : null,
  };
}

function composeCharacter(P, ctx) {
  const { W, H } = P;
  const { palette, ev, intent } = ctx;
  const want = (id) => intent.elements.some((e) => e.id === id);
  const look = intent.appearance || {};
  const outdoor = ['garden', 'trees', 'grass', 'sky', 'sun', 'clouds', 'mountains', 'hills', 'flowers'].some(want);
  P.layer('background', 'الخلفية');
  P.layer('figure', 'الشخصية');
  P.layer('shade', 'الظلال', { blend: 'multiply' });
  P.layer('light', 'الإضاءة', { blend: 'screen' });
  const floorY = H * (outdoor ? 0.86 : 0.9);
  if (outdoor) drawOutdoorSetting(P, ctx, floorY, want);
  else {
    P.draw('draw.rect', 'background', { x: 0, y: 0, w: W, h: H, fill: { type: 'radial', cx: 0.4, cy: 0.35, r: 0.9, stops: [{ offset: 0, color: lighten(palette.wall, 0.25) }, { offset: 1, color: darken(palette.wall, 0.15) }] } }, 'background', 'studio backdrop');
    P.rect('background', { x: 0, y: floorY, w: W, h: H - floorY, fill: darken(palette.floor, 0.05) }, 'background', 'floor');
  }
  // Requested colours win over palette-derived ones; the palette fills whatever the user did not specify.
  const fig = standingIllustrated(P, {
    layer: 'figure', cx: W * (outdoor && (want('trees') || want('garden')) ? 0.42 : 0.5), footY: floorY + H * 0.02, height: H * (outdoor ? 0.74 : 0.78),
    shirt: look.shirt || palette.shirt, pants: look.pants || palette.pants, shoe: look.shoe, hair: look.hair || HAIR[0], skin: SKIN[1],
    smile: Boolean(look.smile), gender: look.gender, hairLength: look.hairLength || (look.gender === 'female' ? 'long' : 'short'),
  });
  // Small dense accent right under the feet (occlusion), centred on the stance, not a large dark pool.
  const cs = ev.on('occlusion-shadows') ? P.soft('background', fig.supportAnkle.x + fig.u * 0.45, floorY + H * 0.02, fig.u * 2.1, fig.u * 0.28, 'rgba(0,0,0,0.38)', 6, 'shadows', 'contact shadow under the feet') : null;
  if (cs !== null) ev.record('occlusion-shadows', 'Dense contact shadow under the feet.', [cs], 'shadows');
  const key = P.soft('light', W * 0.2, H * 0.25, W * 0.5, H * 0.45, 'rgba(255,240,210,0.06)', 60, 'lighting', 'faint warm key light from the upper left');
  if (ev.on('key-light')) ev.record('key-light', 'Single key light from the upper left; shading on the opposite side of torso and face.', [key], 'lighting');
  ev.record('figure-proportion-balance', `Standing figure in ${fig.headCount} head units (illustration convention); centre of gravity offset from the stance centre = ${fig.balanceOffsetHeads} head.`, (P.elements.get('person') || []).slice(0, 6), 'person');
  ctx.effects = [{ type: 'grade', contrast: 1.04, saturation: 0.98, warmth: 0.05 }, { type: 'grain', amount: 0.08 }];
  return {
    figure: { u: Number(fig.u.toFixed(1)), heads: fig.headCount, balanceOffsetHeads: fig.balanceOffsetHeads, pose: intent.pose || 'standing', fullBodyInFrame: fig.top > 0 && fig.feet < H },
    appearanceApplied: look,
    setting: outdoor ? 'outdoor' : 'studio',
    lighting: intent.lighting || 'neutral',
    requested: intent.elements.map((e) => e.id),
  };
}

/** Daylight outdoor setting for a character: sky, sun, clouds, distant hills, grass ground, one tree. */
function drawOutdoorSetting(P, ctx, groundY, want) {
  const { W, H } = P;
  const { palette, ev } = ctx;
  const hz = (c, k) => (palette.swatches ? harmonize(c, palette.swatches, k) : c);
  const sky = [hz('#8fc8e8', 0.7), hz('#d6eef7', 0.6)];
  P.draw('draw.rect', 'background', { x: 0, y: 0, w: W, h: groundY, fill: { type: 'linear', angle: 90, stops: [{ offset: 0, color: sky[0] }, { offset: 1, color: sky[1] }] } }, 'sky', 'daylight sky');
  // Sun on the upper LEFT: it is the key light that the figure's cel shading assumes.
  // The glow belongs to the sky (behind the figure); on a screen layer above it would wash the figure out.
  P.soft('background', W * 0.16, H * 0.12, W * 0.6, W * 0.6, 'rgba(255,248,214,0.55)', 40, 'sun', 'sun glow in the sky');
  P.soft('background', W * 0.16, H * 0.12, W * 0.16, W * 0.16, '#fff6cf', 0, 'sun', 'sun');
  for (const [cx, cy, s] of [[0.62, 0.12, 1], [0.86, 0.26, 0.75]]) {
    // Puffy cloud: overlapping lobes on a flat base, lit top and cool shaded underside.
    const lobes = [[-0.09, 0.012, 0.055], [-0.03, -0.012, 0.075], [0.05, 0, 0.065], [0.11, 0.016, 0.045]].map(([dx, dy, r]) => ({ x: W * (cx + dx * s), y: H * cy + W * dy * s, r: W * r * s }));
    const bottomY = H * cy + W * 0.035 * s;
    const left = Math.min(...lobes.map((l) => l.x - l.r));
    const right = Math.max(...lobes.map((l) => l.x + l.r));
    const cloud = [];
    for (let i = 0; i <= 16; i += 1) {
      const x = left + ((right - left) * i) / 16;
      let top = bottomY;
      for (const l of lobes) if (Math.abs(x - l.x) < l.r) top = Math.min(top, l.y - Math.sqrt(l.r * l.r - (x - l.x) * (x - l.x)));
      cloud.push({ x, y: Math.min(top, bottomY - 4) });
    }
    cloud.push({ x: right - W * 0.01 * s, y: bottomY }, { x: left + W * 0.01 * s, y: bottomY });
    toon(P, 'background', cloud, { fill: '#ffffff', shade: 0.35, shadeDepth: 0.06, highlight: false, outline: 0, shade: 0.1, light: { x: -0.3, y: -0.95 }, note: 'cloud' }, 'clouds');
  }
  const atmo = ev.on('atmospheric-perspective') ? ev.rules.get('atmospheric-perspective').params : null;
  const hillBase = hz(mix(palette.terrainNear || '#5f8a4a', '#6f9a6a', 0.5), 0.6);
  const far = atmo ? mix(hillBase, sky[1], atmo.farMixToSky) : hillBase;
  const farIdx = P.blob('background', [{ x: -40, y: groundY - H * 0.05 }, { x: W * 0.2, y: groundY - H * 0.14 }, { x: W * 0.55, y: groundY - H * 0.08 }, { x: W * 0.8, y: groundY - H * 0.16 }, { x: W + 40, y: groundY - H * 0.07 }, { x: W + 40, y: groundY + 5 }, { x: -40, y: groundY + 5 }], { fill: far }, 'hills', 'distant hills (atmospheric perspective)', true);
  if (atmo) ev.record('atmospheric-perspective', `Distant hills mixed ${Math.round(atmo.farMixToSky * 100)}% toward the sky so the figure stays in front.`, [farIdx], 'hills');
  const grass = hz(mix(palette.foliage || '#3f7d4a', '#5a9a52', 0.5), 0.6);
  P.draw('draw.rect', 'background', { x: 0, y: groundY - H * 0.01, w: W, h: H - groundY + H * 0.01, fill: { type: 'linear', angle: 90, stops: [{ offset: 0, color: lighten(grass, 0.12) }, { offset: 1, color: darken(grass, 0.18) }] } }, 'grass', 'grass ground');
  // Light patches on the lawn, then clumps of tapered blades in two tones (depth: smaller toward the horizon).
  for (let i = 0; i < 5; i += 1) P.soft('background', P.rand(0.1, 0.9) * W, P.rand(groundY + H * 0.03, H * 0.97), W * P.rand(0.18, 0.3), H * 0.03, rgba(lighten(grass, 0.25), 0.35), 18, 'grass', 'sunlit lawn patch');
  for (let i = 0; i < 46; i += 1) {
    const yy = P.rand(groundY + H * 0.015, H * 0.995);
    const depth = (yy - groundY) / (H - groundY);
    const x = P.rand(0.01, 0.99) * W;
    const hgt = H * (0.012 + depth * 0.03);
    for (let b = -1; b <= 1; b += 1) {
      taper(P, 'background', { x: x + b * hgt * 0.25, y: yy }, { x: x + b * hgt * 0.7 + P.rand(-2, 2), y: yy - hgt * (b === 0 ? 1 : 0.75) }, Math.max(1.2, hgt * 0.16), b === 0 ? darken(grass, 0.28) : lighten(grass, 0.08), 'grass', 'grass blade', { x: b * hgt * 0.15, y: 0 });
    }
  }
  if (want('trees') || want('garden')) {
    const tx = W * 0.82; const ty = groundY + H * 0.035; const s = H / 1600;
    const bark = hz('#6e4a30', 0.8);
    P.soft('background', tx + 40 * s, ty, 320 * s, 46 * s, 'rgba(0,0,0,0.28)', 8, 'trees', 'tree contact shadow');
    toon(P, 'background', [{ x: tx - 30 * s, y: ty }, { x: tx - 22 * s, y: ty - 220 * s }, { x: tx - 16 * s, y: ty - 430 * s }, { x: tx + 16 * s, y: ty - 430 * s }, { x: tx + 22 * s, y: ty - 220 * s }, { x: tx + 34 * s, y: ty }],
      { fill: bark, shade: 0.35, outline: Math.max(1.4, 3 * s), note: 'tree trunk' }, 'trees');
    for (const [ax, ay, bx, by] of [[0, -330, -95, -470], [0, -360, 105, -500], [0, -420, 10, -560]]) {
      toon(P, 'background', limbOutline([{ x: tx + ax * s, y: ty + ay * s }, { x: tx + (ax + bx) * 0.5 * s, y: ty + (ay + by) * 0.5 * s }, { x: tx + bx * s, y: ty + by * s }], [20 * s, 13 * s, 7 * s]), { fill: bark, shade: 0.35, highlight: false, outline: Math.max(1, 2 * s), note: 'branch' }, 'trees');
    }
    for (let k = 0; k < 4; k += 1) taper(P, 'background', { x: tx - 8 * s + k * 5 * s, y: ty - 40 * s - k * 70 * s }, { x: tx - 4 * s + k * 5 * s, y: ty - 90 * s - k * 70 * s }, 4 * s, rgba(darken(bark, 0.4), 0.6), 'trees', 'bark line');
    const leaf = hz(mix(palette.foliage || '#3f7d4a', '#3f8a5a', 0.5), 0.6);
    // Back clusters darker, front clusters lighter: the canopy reads as a volume lit from the upper left.
    for (const [dx, dy, rx, ry, tone] of [[95, -470, 120, 105, -0.12], [-100, -455, 115, 100, -0.1], [0, -610, 150, 125, -0.04], [-60, -540, 130, 115, 0], [80, -555, 135, 112, 0.02], [-5, -470, 125, 100, 0.06]]) {
      toon(P, 'background', organic(P, tx + dx * s, ty + dy * s, rx * s, ry * s, 0.1, 18), { fill: tone < 0 ? darken(leaf, -tone) : lighten(leaf, tone), shade: 0.26, highlightAmount: 0.25, outline: Math.max(1.4, 3 * s), note: 'canopy cluster' }, 'trees');
    }
  }
  if (want('garden') || want('flowers')) {
    // Small drawn flowers (stem, leaf, five petals, centre) in clusters along the front of the lawn.
    const petals = ['#ffffff', '#f6c2d3', '#f7d774', '#c9a7e8'];
    for (let c = 0; c < 4; c += 1) {
      const bx = W * (0.07 + c * 0.25) + P.rand(-20, 20);
      const by = H * (0.93 + (c % 2) * 0.03);
      for (let f = 0; f < 5; f += 1) {
        const fx = bx + P.rand(-0.05, 0.05) * W;
        const fy = by + P.rand(-0.012, 0.012) * H;
        const r = W * P.rand(0.008, 0.012);
        const col = petals[(c + f) % petals.length];
        taper(P, 'background', { x: fx, y: fy + r * 4 }, { x: fx, y: fy }, Math.max(1.2, r * 0.35), darken(grass, 0.3), 'garden', 'flower stem');
        for (let k = 0; k < 5; k += 1) {
          const a = (k / 5) * Math.PI * 2;
          P.ellipse('background', { x: fx + Math.cos(a) * r * 0.75 - r * 0.55, y: fy + Math.sin(a) * r * 0.75 - r * 0.55, w: r * 1.1, h: r * 1.1, fill: col, stroke: darken(col, 0.35), strokeWidth: Math.max(0.6, r * 0.08) }, 'garden', 'petal');
        }
        P.ellipse('background', { x: fx - r * 0.35, y: fy - r * 0.35, w: r * 0.7, h: r * 0.7, fill: '#e8a93a' }, 'garden', 'flower centre');
      }
    }
  }
}

module.exports = { composeInterior, composeCharacter, lightingModel };
