'use strict';

/**
 * Landscapes: sky, celestial light, layered terrain with atmospheric perspective, water with reflections,
 * vegetation and props. style "painterly" renders surfaces with brush strokes instead of flat fills.
 */

const { harmonize } = require('../swatches');
const { mix, darken, lighten, rgba, parse } = require('../color');
const { streetTree } = require('./city');
const { toon, organic } = require('./style');
const { houseGeometry } = require('../house-geometry');

const SKIES = {
  morning: { top: '#6fa9de', mid: '#a9d2f0', horizon: '#fde8c8', sun: '#fff3c4', y: 0.22, x: 0.28 },
  sunset: { top: '#2e2a6b', mid: '#b5577a', horizon: '#ffb36b', sun: '#ffd88a', y: 0.5, x: 0.62 },
  night: { top: '#050820', mid: '#121c47', horizon: '#2c3d74', sun: '#f2f0e0', y: 0.2, x: 0.74 },
  neutral: { top: '#5d9bd6', mid: '#9ccbee', horizon: '#e8f3fa', sun: '#fffbe6', y: 0.18, x: 0.7 },
};

function ridge(P, x0, x1, baseY, amp, rough, steps) {
  const pts = [];
  const n = steps || 18;
  let y = baseY;
  for (let i = 0; i <= n; i += 1) {
    const t = i / n;
    const peak = Math.sin(t * Math.PI * P.rand(1.4, 2.2) + P.rand(0, 2)) * amp * 0.55;
    y = baseY - Math.abs(peak) - P.rand(0, amp * rough);
    pts.push({ x: x0 + (x1 - x0) * t, y });
  }
  return pts;
}

function composeLandscape(P, ctx) {
  const { W, H } = P;
  const { intent, palette, ev } = ctx;
  const lighting = intent.lighting || 'neutral';
  // Sky stops are harmonised with the reference swatches (a lighter pull than objects: the sky must stay a sky).
  const baseSky = SKIES[lighting] || SKIES.neutral;
  const sky = palette.swatches
    ? Object.fromEntries(Object.entries(baseSky).map(([k, v]) => [k, typeof v === 'string' && k !== 'sun' ? harmonize(v, palette.swatches, 0.75) : v]))
    : baseSky;
  const garden = intent.elements.some((e) => e.id === 'garden');
  const want = (id) => intent.elements.some((e) => e.id === id) || (garden && ['trees', 'flowers', 'grass'].includes(id));
  const painterly = intent.style === 'painterly';
  const hasSea = want('sea') || want('boat') || want('lighthouse');
  const horizon = H * (hasSea ? 0.55 : 0.6);
  const atmo = ev.on('atmospheric-perspective') ? ev.rules.get('atmospheric-perspective').params : null;
  const coolFar = ev.on('warm-advance-cool-recede') ? ev.rules.get('warm-advance-cool-recede').params.farCoolShift : null;
  const silhouette = lighting === 'sunset' && ev.on('contre-jour-silhouette');
  const skyColor = sky.horizon;
  // Depth colour: base terrain colour pushed toward the sky colour with distance (atmospheric perspective).
  // Acceptance condition: an element the request names (e.g. «جبال بعيدة») must keep a readable silhouette.
  // The fixed 62% far mix made requested mountains nearly the colour of the sky band behind them and review
  // failed LOW_VISIBILITY (run_mw7v4unh). The haze (hue/chroma shift toward the sky) is kept as planned; only
  // the VALUE is stepped down until the element separates from the sky actually behind it (its middle band
  // to the horizon), which is how distant ranges still read against a bright sky.
  const requested = new Set(intent.elements.filter((e) => !e.supporting).map((e) => e.id));
  const MIN_SEPARATION = 40; // max channel difference (0..255) to every sky tone behind the element
  const separation = (a, b) => { const p = parse(a); const q = parse(b); return Math.max(Math.abs(p.r - q.r), Math.abs(p.g - q.g), Math.abs(p.b - q.b)); };
  // The ridge shows against the sky's middle band (its foot is hidden by the nearer planes).
  const behind = [sky.mid, mix(sky.mid, sky.horizon, 0.35)];
  const apart = (c) => Math.min(...behind.map((b) => separation(c, b)));
  const MIN_FRONT = 28; // the far plane must also stay distinct from the plane in front of it
  const atmoUsed = {};
  const hazed = (base, depth) => {
    const k = depth === 'far' ? atmo.farMixToSky : depth === 'mid' ? atmo.midMixToSky : atmo.nearMixToSky;
    let c = mix(base, skyColor, k);
    if (coolFar && depth === 'far') c = mix(c, coolFar, 0.25);
    return { c, k };
  };
  const depthColor = (base, depth, element, frontBase) => {
    if (!atmo) return base;
    const { c, k } = hazed(base, depth);
    if (!(element && requested.has(element) && depth !== 'near')) return c;
    // Smallest value step, lighter or darker, that separates from the sky behind AND the plane in front.
    const front = frontBase ? hazed(frontBase, depth === 'far' ? 'mid' : 'near').c : null;
    const score = (x) => Math.min(apart(x) / MIN_SEPARATION, front ? separation(x, front) / MIN_FRONT : Infinity);
    let best = { step: 0, color: c, s: score(c) };
    if (best.s < 1) {
      for (let t = 0.04; t <= 0.5 + 1e-9 && best.s < 1; t += 0.04) {
        for (const [dir, x] of [['lighter', lighten(c, t)], ['darker', darken(c, t)]]) {
          const s2 = score(x);
          if (s2 > best.s) best = { step: Number(t.toFixed(2)), dir, color: x, s: s2 };
        }
      }
    }
    atmoUsed[depth] = { mix: k, valueStep: best.step, dir: best.dir, element, separation: apart(best.color), front: front ? separation(best.color, front) : null };
    return best.color;
  };
  const darkFor = (c) => (silhouette ? darken(c, 0.62) : (lighting === 'night' ? darken(c, 0.55) : c));

  P.layer('sky', 'السماء');
  P.layer('far', 'البعيد');
  P.layer('mid', 'الوسط');
  P.layer('near', 'القريب');
  P.layer('light', 'الضوء', { blend: 'screen' });
  P.layer('fx', 'اللمسات');

  P.draw('draw.rect', 'sky', { x: 0, y: 0, w: W, h: horizon + 4, fill: { type: 'linear', angle: 90, stops: [{ offset: 0, color: sky.top }, { offset: 0.55, color: sky.mid }, { offset: 1, color: sky.horizon }] } }, 'sky', 'sky gradient');
  if (painterly) {
    for (let i = 0; i < 9; i += 1) {
      const y = (horizon * (i + 0.5)) / 9;
      const pts = []; for (let k = 0; k <= 6; k += 1) pts.push({ x: -40 + (W + 80) * (k / 6), y: y + P.rand(-12, 12) });
      P.brush('sky', { points: pts, colors: [mix(sky.top, sky.horizon, i / 9), lighten(mix(sky.mid, sky.horizon, i / 9), 0.1)], brush: { preset: 'soft-edge', size: horizon / 6, hardness: 0.2, seed: 30 + i }, opacity: 0.55, smooth: 0.8 }, 'sky', 'painterly sky stroke (soft-edge brush, colour blending)');
    }
  }
  // Sun / moon.
  const celestial = lighting === 'night' ? 'moon' : 'sun';
  if (lighting === 'night' || want('moon')) {
    // Stars: many faint pin-points (denser and fainter toward the horizon haze) and a few bright ones with a glow.
    const starIds = [];
    for (let i = 0; i < 160; i += 1) {
      const y = horizon * Math.pow(P.rand(0, 1), 1.4) * 0.92;
      const r = Math.max(0.6, (W / 1600) * P.rand(0.6, 1.8));
      const a = (0.35 + 0.6 * (1 - y / horizon)) * P.rand(0.5, 1);
      starIds.push(P.ellipse('sky', { x: Math.round(P.rand(0, W)), y: Math.round(y), w: r * 2, h: r * 2, fill: rgba('#ffffff', Number(a.toFixed(2))) }, 'stars', 'star (pin-point)'));
    }
    for (let i = 0; i < 7; i += 1) {
      const x = P.rand(0.05, 0.95) * W; const y = P.rand(0.05, 0.45) * horizon; const r = (W / 1600) * P.rand(2, 3.2);
      P.soft('sky', x, y, r * 7, r * 7, rgba(sky.sun, 0.25), r * 2, 'stars', 'bright star glow');
      P.ellipse('sky', { x: Math.round(x - r), y: Math.round(y - r), w: r * 2, h: r * 2, fill: '#ffffff' }, 'stars', 'bright star');
    }
  }
  const sx = W * sky.x; const sy = lighting === 'sunset' ? horizon - H * 0.07 : H * sky.y;
  const glow = P.soft('light', sx, sy, H * 0.75, H * 0.75, rgba(sky.sun, lighting === 'night' ? 0.25 : 0.55), 50, celestial, `${celestial} glow`);
  P.soft('sky', sx, sy, H * 0.12, H * 0.12, sky.sun, 0, celestial, celestial);
  if (want('clouds') || painterly || lighting === 'sunset') {
    for (let i = 0; i < 5; i += 1) {
      const cx = P.rand(0.05, 0.95) * W; const cy = P.rand(0.08, 0.38) * horizon;
      const cw = P.rand(0.12, 0.24) * W;
      const cloudColor = lighting === 'sunset' ? '#ffc7a1' : lighting === 'night' ? '#2b3a6b' : '#ffffff';
      for (let k = 0; k < 4; k += 1) P.soft('sky', cx + (k - 1.5) * cw * 0.22, cy + P.rand(-8, 8), cw * P.rand(0.35, 0.55), cw * 0.22, rgba(cloudColor, 0.75), 10, 'clouds', 'cloud puff (blurred ellipse)');
    }
  }

  // Terrain layers.
  const depthOps = [];
  if (want('mountains') || (!hasSea && !want('dunes'))) {
    const baseMountain = palette.terrainFar;
    for (const [depth, amp, layer] of [['far', H * 0.26, 'far'], ['mid', H * 0.18, 'mid']]) {
      const base = depth === 'far' ? baseMountain : mix(baseMountain, palette.terrainNear, 0.4);
      const c = darkFor(depthColor(base, depth, 'mountains', depth === 'far' ? mix(baseMountain, palette.terrainNear, 0.4) : palette.terrainNear));
      const pts = ridge(P, -20, W + 20, horizon + (depth === 'mid' ? H * 0.03 : 0), amp, 0.12, 16);
      const idx = P.poly(layer, [...pts, { x: W + 20, y: horizon + H * 0.08 }, { x: -20, y: horizon + H * 0.08 }], { fill: { type: 'linear', angle: 90, stops: [{ offset: 0, color: lighten(c, 0.08) }, { offset: 1, color: c }] } }, 'mountains', `${depth} mountain range`);
      depthOps.push(idx);
      // Sunlit faces: each peak's left slope faces the light; a lighter facet runs from the peak down
      // to the base, clipped inside the range. Far ranges get a soft snow/haze cap on the highest peaks.
      const rangeOutline = [...pts, { x: W + 20, y: horizon + H * 0.08 }, { x: -20, y: horizon + H * 0.08 }];
      const rangeClip = { type: 'path', segments: rangeOutline.map((p, i) => ({ op: i ? 'L' : 'M', x: p.x, y: p.y })) };
      const baseY = horizon + H * 0.08;
      for (let i = 1; i < pts.length - 1; i += 1) {
        if (!(pts[i].y < pts[i - 1].y && pts[i].y < pts[i + 1].y)) continue;
        const foot = { x: pts[i].x + (pts[i + 1].x - pts[i].x) * 0.35, y: baseY };
        P.poly(layer, [pts[i - 1], pts[i], foot, { x: pts[i - 1].x, y: baseY }], { fill: { type: 'linear', angle: 90, stops: [{ offset: 0, color: rgba(lighten(c, 0.22), 0.85) }, { offset: 1, color: rgba(lighten(c, 0.05), 0) }] }, clip: rangeClip, blur: 1.5 }, 'mountains', `${depth} sunlit slope`);
        P.line(layer, { x1: pts[i].x, y1: pts[i].y, x2: foot.x, y2: Math.min(baseY, pts[i].y + (baseY - pts[i].y) * 0.6), stroke: rgba(darken(c, 0.25), 0.35), strokeWidth: 1.4, cap: 'round', clip: rangeClip }, 'mountains', `${depth} ridge crease`);
        if (depth === 'far' && pts[i].y < horizon - amp * 0.75) {
          P.poly(layer, [{ x: pts[i].x - amp * 0.18, y: pts[i].y + amp * 0.14 }, pts[i], { x: pts[i].x + amp * 0.16, y: pts[i].y + amp * 0.16 }, { x: pts[i].x, y: pts[i].y + amp * 0.1 }], { fill: rgba('#ffffff', 0.75), clip: rangeClip }, 'mountains', 'snow cap');
        }
      }
      if (painterly) {
        P.brush(layer, { points: pts.map((p) => ({ x: p.x, y: p.y + 10 })), color: lighten(c, 0.22), brush: { preset: 'soft-edge', size: 26, hardness: 0.1, seed: 50 }, opacity: 0.45, smooth: 0.6 }, 'mountains', 'light catching the ridge (soft-edge brush)');
        P.brush(layer, { points: pts.map((p) => ({ x: p.x, y: p.y + amp * 0.45 })), color: darken(c, 0.12), brush: { preset: 'texture', size: 30, angle: 70, jitter: 0.5, seed: 60 }, opacity: 0.35, smooth: 0.5 }, 'mountains', 'rock texture (texture brush)');
      }
    }
  }
  if (want('dunes')) {
    for (let k = 0; k < 3; k += 1) {
      const depth = ['far', 'mid', 'near'][k];
      const y = horizon + H * (0.02 + k * 0.1);
      const c = darkFor(depthColor(mix('#d9a35b', '#f1c27d', k / 2), depth));
      const idx = P.blob(depth === 'near' ? 'near' : depth, [{ x: -50, y: y + 40 }, { x: W * 0.25, y: y - H * 0.06 }, { x: W * 0.55, y: y + 10 }, { x: W * 0.85, y: y - H * 0.08 }, { x: W + 50, y: y + 30 }, { x: W + 50, y: H + 10 }, { x: -50, y: H + 10 }], { fill: c }, 'dunes', `${depth} dune`, true);
      depthOps.push(idx);
    }
  }
  if (atmo && depthOps.length) {
    const pct = (depth, planned) => { const u = atmoUsed[depth]; return u && u.valueStep ? `${Math.round(planned * 100)}% (value ${u.dir} by ${Math.round(u.valueStep * 100)}% so the requested ${u.element} keep a silhouette: ${u.separation}/255 from the sky behind${u.front !== null ? `, ${u.front}/255 from the plane in front` : ''})` : `${Math.round(planned * 100)}%`; };
    ev.record('atmospheric-perspective', `Far layer mixed ${pct('far', atmo.farMixToSky)} toward the sky colour, mid ${pct('mid', atmo.midMixToSky)}, near ${Math.round(atmo.nearMixToSky * 100)}%.`, depthOps, 'terrain');
    if (coolFar) ev.record('warm-advance-cool-recede', 'Far range shifted 25% toward cool blue; foreground keeps warm greens/ochres.', depthOps.slice(0, 1), 'terrain');
  }

  // Water.
  const waterColor = lighting === 'sunset' ? '#5b4a7a' : lighting === 'night' ? '#0d1838' : '#3f7fb5';
  if (hasSea) {
    const waterTop = horizon;
    P.draw('draw.rect', 'mid', { x: 0, y: waterTop, w: W, h: H - waterTop, fill: { type: 'linear', angle: 90, stops: [{ offset: 0, color: lighten(waterColor, 0.25) }, { offset: 1, color: darken(waterColor, 0.25) }] } }, 'sea', 'water surface');
    for (let i = 0; i < 26; i += 1) {
      const y = waterTop + (H - waterTop) * Math.pow(i / 26, 1.4) + 4;
      const len = 10 + (y - waterTop) * 0.25;
      const x = Math.abs(sx + P.rand(-1, 1) * (12 + (y - waterTop) * 0.3));
      P.line('light', { x1: x - len / 2, y1: y, x2: x + len / 2, y2: y, stroke: rgba(sky.sun, 0.7), strokeWidth: 2 + (y - waterTop) * 0.012, cap: 'round' }, 'sea', 'sun/moon glitter path on the water');
    }
    for (let i = 0; i < 16; i += 1) {
      const y = P.rand(waterTop + 10, H - 10); const x = P.rand(0, W);
      P.line('mid', { x1: x, y1: y, x2: x + 30 + (y - waterTop) * 0.1, y2: y, stroke: rgba('#ffffff', 0.18), strokeWidth: 1.5, cap: 'round' }, 'sea', 'wave highlight');
    }
  }

  // Near ground (when not sea everywhere).
  if (!hasSea) {
    const groundColor = darkFor(depthColor(palette.terrainNear, 'near'));
    P.rect('mid', { x: 0, y: horizon + H * 0.04, w: W, h: H - horizon, fill: darkFor(depthColor(mix(palette.terrainNear, palette.terrainFar, 0.5), 'mid')) }, 'grass', 'middle-distance plain (continuous ground to the horizon)');
    const groundIdx = P.blob('near', [{ x: -40, y: horizon + H * 0.14 }, { x: W * 0.3, y: horizon + H * 0.1 }, { x: W * 0.7, y: horizon + H * 0.16 }, { x: W + 40, y: horizon + H * 0.12 }, { x: W + 40, y: H + 10 }, { x: -40, y: H + 10 }], { fill: { type: 'linear', angle: 90, stops: [{ offset: 0, color: lighten(groundColor, 0.06) }, { offset: 1, color: darken(groundColor, 0.18) }] } }, 'grass', 'foreground ground', true);
    P.rect('near', { x: 0, y: horizon + H * 0.1, w: W, h: H, fill: { type: 'pattern', kind: 'noise', color: rgba(darken(groundColor, 0.4), 0.6), scale: 6 }, opacity: 0.35, blend: 'multiply', clip: { type: 'path', segments: [{ op: 'M', x: -40, y: horizon + H * 0.14 }, { op: 'L', x: W * 0.3, y: horizon + H * 0.1 }, { op: 'L', x: W * 0.7, y: horizon + H * 0.16 }, { op: 'L', x: W + 40, y: horizon + H * 0.12 }, { op: 'L', x: W + 40, y: H + 10 }, { op: 'L', x: -40, y: H + 10 }] } }, 'grass', 'grass texture');
    if (want('river')) {
      // Meandering river on the ground plane: width and meander amplitude scale with the distance below the
      // horizon (s), so bends tighten and the stream narrows toward the vanishing point.
      const rc = palette.swatches ? harmonize(lighting === 'night' ? '#0d1838' : '#3f7fb5', palette.swatches, 0.6) : (lighting === 'night' ? '#0d1838' : '#3f7fb5');
      const y0 = horizon + H * 0.05;
      const left = [];
      const right = [];
      const bankL = [];
      const bankR = [];
      for (let i = 0; i <= 36; i += 1) {
        const y = y0 + (H + 30 - y0) * Math.pow(i / 36, 1.5);
        const s = (y - horizon) / (H - horizon);
        const cx = W * 0.5 + W * 0.09 * s * Math.sin(1.9 / (s + 0.12));
        const half = (W * 0.004 + W * 0.13 * s) * Math.min(1, 0.15 + i / 5);
        left.push({ x: cx - half, y }); right.unshift({ x: cx + half, y });
        bankL.push({ x: cx - half * 1.12 - 2, y: y - 1 }); bankR.unshift({ x: cx + half * 1.12 + 2, y: y - 1 });
      }
      const riverPts = left.concat(right);
      P.blob('near', bankL.concat(bankR), { fill: darken(depthColor(palette.terrainNear, 'near'), 0.35) }, 'river', 'river banks (wet earth edge)', true);
      P.blob('near', riverPts, { fill: { type: 'linear', angle: 90, smooth: true, stops: [{ offset: 0, color: lighten(mix(rc, sky.horizon, 0.6), 0.2) }, { offset: 0.45, color: lighten(rc, 0.15) }, { offset: 1, color: darken(rc, 0.12) }] } }, 'river', 'river: sky reflected in the distance, deeper water near (perspective meander)', true);
      const riverClip = { type: 'path', segments: riverPts.map((p, i) => ({ op: i ? 'L' : 'M', x: p.x, y: p.y })) };
      for (let i = 0; i < 22; i += 1) {
        const t = Math.pow(P.rand(0.05, 1), 1.3);
        const y = y0 + (H - y0) * t;
        const s = (y - horizon) / (H - horizon);
        const cx = W * 0.5 + W * 0.09 * s * Math.sin(1.9 / (s + 0.12)) + P.rand(-0.6, 0.6) * W * 0.1 * s;
        const len = W * 0.06 * s + 4;
        P.line('near', { x1: cx - len / 2, y1: y, x2: cx + len / 2, y2: y, stroke: rgba(sky.sun, 0.35), strokeWidth: 1 + 2.5 * s, cap: 'round', clip: riverClip }, 'river', 'ripple highlights (shorter and thinner with distance)');
      }
    }
    if (want('lake')) {
      // Lake on the ground plane: wide and flat (seen at a low angle), reflections stay inside its outline.
      const lx = W * 0.5; const ly = horizon + H * 0.2; const lw = W * 0.56; const lh = H * 0.13;
      P.blob('near', [{ x: lx - lw / 2, y: ly }, { x: lx - lw * 0.2, y: ly - lh / 2 }, { x: lx + lw * 0.25, y: ly - lh * 0.45 }, { x: lx + lw / 2, y: ly + lh * 0.05 }, { x: lx + lw * 0.2, y: ly + lh / 2 }, { x: lx - lw * 0.25, y: ly + lh * 0.45 }],
        { fill: { type: 'linear', angle: 90, stops: [{ offset: 0, color: lighten(waterColor, 0.3) }, { offset: 1, color: waterColor }] } }, 'lake', 'lake on the ground plane', true);
      for (let i = 0; i < 7; i += 1) {
        const y = ly - lh * 0.3 + (lh * 0.6 * i) / 6;
        const half = lw * 0.16 * Math.sqrt(1 - Math.pow((y - ly) / (lh * 0.55), 2));
        P.line('light', { x1: lx - half, y1: y, x2: lx + half * 0.6, y2: y, stroke: rgba(sky.sun, 0.45), strokeWidth: 2, cap: 'round' }, 'lake', 'light reflected on the lake surface');
      }
    }
    if (painterly || want('grass')) {
      for (let i = 0; i < 26; i += 1) {
        let x = P.rand(0, W); const y = P.rand(horizon + H * 0.18, H);
        if (want('river') && x > W * 0.28 && x < W * 0.74) x = x < W * 0.5 ? x - W * 0.25 : x + W * 0.25;
        P.brush('near', { points: [{ x, y }, { x: x + P.rand(-6, 6), y: y - P.rand(14, 34) }], color: lighten(groundColor, P.rand(0.05, 0.25)), brush: { preset: 'texture', size: 18, angle: 80, seed: 90 + i }, opacity: 0.8, smooth: 0 }, 'grass', 'grass texture (texture brush)');
      }
    }
    void groundIdx;
  } else {
    P.blob('near', [{ x: -40, y: H * 0.86 }, { x: W * 0.25, y: H * 0.8 }, { x: W * 0.45, y: H * 0.9 }, { x: W * 0.45, y: H + 20 }, { x: -40, y: H + 20 }], { fill: darkFor('#d8b98a') }, 'sea', 'beach / shore in the foreground', true);
  }

  // Props.
  const near = (c) => darkFor(c);
  if (want('rocks')) {
    for (let i = 0; i < 4; i += 1) {
      const bx = W * (0.05 + i * 0.09); const by = H * (0.9 + (i % 2) * 0.04); const r = H * (0.05 + (i % 3) * 0.02);
      P.poly('near', [{ x: bx - r, y: by }, { x: bx - r * 0.6, y: by - r * 0.9 }, { x: bx + r * 0.2, y: by - r * 1.1 }, { x: bx + r, y: by - r * 0.3 }, { x: bx + r * 1.1, y: by }], { fill: near('#6b6f78') }, 'rocks', 'rock');
      P.poly('near', [{ x: bx + r * 0.2, y: by - r * 1.1 }, { x: bx + r, y: by - r * 0.3 }, { x: bx + r * 1.1, y: by }, { x: bx + r * 0.3, y: by }], { fill: rgba('#000000', 0.25), blend: 'multiply' }, 'rocks', 'rock shadow facet');
    }
  }
  if (want('lighthouse')) {
    const lx = W * 0.82; const base = hasSea ? horizon + H * 0.12 : horizon + H * 0.1; const th = H * 0.36; const tw = H * 0.07;
    P.blob('mid', [{ x: lx - W * 0.1, y: base + 10 }, { x: lx - W * 0.04, y: base - 18 }, { x: lx + W * 0.05, y: base - 14 }, { x: lx + W * 0.11, y: base + 10 }], { fill: near('#4d4a52') }, 'lighthouse', 'rocky islet', true);
    P.poly('mid', [{ x: lx - tw / 2, y: base }, { x: lx + tw / 2, y: base }, { x: lx + tw * 0.33, y: base - th }, { x: lx - tw * 0.33, y: base - th }], { fill: near('#f3efe6') }, 'lighthouse', 'tapered tower');
    for (let k = 0; k < 3; k += 1) {
      const y0 = base - th * (0.18 + k * 0.28); const y1 = y0 - th * 0.12;
      const w0 = tw * (0.5 - (0.17 * (base - y0)) / th); const w1 = tw * (0.5 - (0.17 * (base - y1)) / th);
      P.poly('mid', [{ x: lx - w0, y: y0 }, { x: lx + w0, y: y0 }, { x: lx + w1, y: y1 }, { x: lx - w1, y: y1 }], { fill: near('#c0392b') }, 'lighthouse', 'red stripe');
    }
    P.rect('mid', { x: lx - tw * 0.38, y: base - th - tw * 0.55, w: tw * 0.76, h: tw * 0.55, fill: '#ffe9a6' }, 'lighthouse', 'lamp room');
    P.poly('mid', [{ x: lx - tw * 0.45, y: base - th - tw * 0.55 }, { x: lx + tw * 0.45, y: base - th - tw * 0.55 }, { x: lx, y: base - th - tw * 0.95 }], { fill: near('#2f2f35') }, 'lighthouse', 'roof');
    if (lighting === 'sunset' || lighting === 'night') {
      P.poly('light', [{ x: lx, y: base - th - tw * 0.3 }, { x: lx - W * 0.45, y: base - th - H * 0.12 }, { x: lx - W * 0.45, y: base - th + H * 0.04 }], { fill: { type: 'linear', angle: 180, stops: [{ offset: 0, color: 'rgba(255,240,180,0.55)' }, { offset: 1, color: 'rgba(255,240,180,0)' }] }, blur: 6 }, 'lighthouse', 'lighthouse beam');
    }
  }
  if (want('boat')) {
    const bx = W * 0.45; const by = horizon + (H - horizon) * 0.35; const bl = W * 0.11;
    P.blob('mid', [{ x: bx - bl / 2, y: by }, { x: bx + bl / 2, y: by }, { x: bx + bl * 0.36, y: by + bl * 0.16 }, { x: bx - bl * 0.36, y: by + bl * 0.16 }], { fill: near('#5a3a28') }, 'boat', 'hull');
    P.line('mid', { x1: bx, y1: by, x2: bx, y2: by - bl * 0.75, stroke: near('#3b2a1e'), strokeWidth: 4, cap: 'butt' }, 'boat', 'mast');
    P.poly('mid', [{ x: bx + 3, y: by - bl * 0.72 }, { x: bx + 3, y: by - 6 }, { x: bx + bl * 0.42, y: by - 6 }], { fill: near('#f5efe0') }, 'boat', 'sail');
    P.poly('mid', [{ x: bx - bl / 2, y: by + bl * 0.17 }, { x: bx + bl / 2, y: by + bl * 0.17 }, { x: bx + bl * 0.36, y: by + bl * 0.45 }, { x: bx - bl * 0.36, y: by + bl * 0.45 }], { fill: rgba(darken(near('#5a3a28'), 0.2), 0.35), blur: 3 }, 'boat', 'reflection in the water');
  }
  const tree = (x, y, scale, depth) => {
    const leaf = darkFor(depthColor(palette.foliage, depth));
    P.rect(depth === 'near' ? 'near' : 'mid', { x: x - 5 * scale, y: y - 60 * scale, w: 10 * scale, h: 60 * scale, fill: darkFor(depthColor('#5b3b24', depth)) }, 'trees', 'trunk');
    if (painterly) {
      P.brush(depth === 'near' ? 'near' : 'mid', { points: [{ x: x - 30 * scale, y: y - 80 * scale }, { x: x, y: y - 120 * scale }, { x: x + 30 * scale, y: y - 80 * scale }, { x: x, y: y - 60 * scale }], color: leaf, colors: [lighten(leaf, 0.15), leaf, darken(leaf, 0.2)], brush: { preset: 'rough', size: 48 * scale, seed: Math.round(x) }, smooth: 0.7 }, 'trees', 'canopy (rough bristle brush)');
    } else {
      // Rounded, softly shaded canopy with branches (same tree language as the city scenes).
      streetTree(P, depth === 'near' ? 'near' : 'mid', x, y, 190 * scale, leaf, 'trees');
    }
  };
  // A requested house is the subject of the picture (it was a 9%-wide prop behind the trees).
  const houseEl = intent.elements.find((e) => e.id === 'house');
  // Not when the request says it is small («بيت صغير») or the house is one prop of a coast scene.
  const heroHouse = Boolean(houseEl && !houseEl.supporting && !hasSea && !(houseEl.attributes && houseEl.attributes.size === 'small'));
  const houseBox = heroHouse
    ? (() => { const w = W * 0.42; const h = Math.min(H * 0.5, w * 0.82); return { x: W * 0.52 - w / 2, y: horizon + H * 0.21 - h, w, h }; })()
    : null;
  if (want('trees') || (!hasSea && !want('dunes'))) {
    const clear = (x) => (!want('river') || x < W * 0.36 || x > W * 0.66) && (!houseBox || x < houseBox.x - W * 0.04 || x > houseBox.x + houseBox.w * 1.1 + W * 0.04);
    for (let i = 0; i < 6; i += 1) { const x = W * (0.08 + i * 0.16) + P.rand(-20, 20); if (clear(x)) tree(x, horizon + H * 0.13, 0.55, 'mid'); }
    for (const fx of (houseBox ? [0.07, 0.92] : [0.1, 0.84, 0.3])) if (clear(W * fx) || houseBox) tree(W * fx, H * 0.95, 1.45, 'near');
  }
  if (want('palms')) {
    for (let i = 0; i < 3; i += 1) {
      const px = W * (0.08 + i * 0.12); const py = H * (0.97 - (i % 2) * 0.03); const h = H * (0.42 - i * 0.05);
      const trunk = darkFor('#6b4a2e');
      P.blob('near', [{ x: px - 8, y: py }, { x: px + h * 0.12, y: py - h * 0.5 }, { x: px + h * 0.2, y: py - h }, { x: px + h * 0.2 + 10, y: py - h }, { x: px + h * 0.12 + 12, y: py - h * 0.5 }, { x: px + 8, y: py }], { fill: trunk }, 'palms', 'curved palm trunk', true);
      const top = { x: px + h * 0.2 + 5, y: py - h };
      for (let k = 0; k < 8; k += 1) {
        const a = -Math.PI + (k / 7) * Math.PI + P.rand(-0.1, 0.1);
        const len = h * P.rand(0.32, 0.42);
        const tip = { x: top.x + Math.cos(a) * len, y: top.y + Math.sin(a) * len * 0.45 + len * 0.35 };
        const mid = { x: top.x + Math.cos(a) * len * 0.5, y: top.y + Math.sin(a) * len * 0.55 };
        P.blob('near', [top, { x: mid.x, y: mid.y - 10 }, tip, { x: mid.x, y: mid.y + 6 }], { fill: darkFor(k % 2 ? '#2f6b3a' : '#3d8248') }, 'palms', 'palm frond');
      }
    }
  }
  if (want('house')) {
    const attrs = (houseEl && houseEl.attributes) || {};
    const box = houseBox || { x: W * 0.62, y: horizon + H * 0.15 - W * 0.1, w: W * 0.12, h: W * 0.1 };
    const lightLeft = (SKIES[lighting] || SKIES.neutral).x < 0.5;
    const house = houseGeometry(box, { material: attrs.material, wallColor: attrs.color, night: lighting === 'night', lightFromLeft: lightLeft, seed: Math.round(P.rand(1, 1e6)) });
    // The hero house stands on the foreground ground (layer "near", drawn after it); a prop stays in "mid".
    const L = heroHouse ? 'near' : 'mid';
    for (const g of house.prims) {
      const params = g.params.fill && typeof g.params.fill === 'string' && silhouette ? Object.assign({}, g.params, { fill: darkFor(g.params.fill) }) : g.params;
      if (g.type === 'rect') P.rect(L, params, 'house', g.note);
      else if (g.type === 'ellipse') P.ellipse(L, params, 'house', g.note);
      else if (g.type === 'line') P.line(L, params, 'house', g.note);
      else { const { points, ...style } = params; P.poly(L, points, style, 'house', g.note); }
    }
    if (garden && heroHouse) {
      // A path from the door to the viewer, and flower beds along it.
      const d = house.door; const pw = box.w * 0.1;
      P.poly('near', [{ x: d.x - pw * 0.5, y: d.y }, { x: d.x + pw * 0.5, y: d.y }, { x: d.x + pw * 1.6, y: H + 4 }, { x: d.x - pw * 1.6, y: H + 4 }], { fill: darkFor('#b9ab92') }, 'garden', 'garden path to the door');
      for (let i = 0; i < 6; i += 1) {
        const t = (i + 0.5) / 6; const yy = d.y + (H - d.y) * t; const half = pw * (0.5 + 1.1 * t);
        P.line('near', { x1: d.x - half, y1: yy, x2: d.x + half, y2: yy, stroke: 'rgba(80,70,55,0.35)', strokeWidth: 1.5 }, 'garden', 'path paving joint');
      }
      const k = W / 1440;
      for (const side of [-1, 1]) {
        for (let i = 0; i < 14; i += 1) {
          const t = (i + 0.5) / 14; const yy = d.y + (H - d.y) * t; const half = pw * (0.5 + 1.1 * t) + (14 + t * 30) * k;
          const fx = d.x + side * (half + P.rand(4, 40) * k); const s = (12 + t * 30) * k;
          P.ellipse('near', { x: fx - s, y: yy - s * 0.6, w: s * 2.1, h: s * 1.3, fill: darkFor('#3f7a3a') }, 'garden', 'flower bed foliage');
          P.ellipse('near', { x: fx - s * 0.35, y: yy - s * 0.85, w: s * 0.7, h: s * 0.7, fill: darkFor(['#e8789a', '#f2c14e', '#ffffff', '#d9534f'][i % 4]) }, 'flowers', 'flower');
        }
      }
    }
  }
  if (want('birds')) {
    for (let i = 0; i < 5; i += 1) {
      const bx = W * P.rand(0.3, 0.7); const by = horizon * P.rand(0.2, 0.5); const s = P.rand(8, 16);
      P.blob('fx', [{ x: bx - s, y: by }, { x: bx - s * 0.4, y: by - s * 0.45 }, { x: bx, y: by }, { x: bx + s * 0.4, y: by - s * 0.45 }, { x: bx + s, y: by }], { fill: null, stroke: '#2a2a35', strokeWidth: 2 }, 'birds', 'bird', false);
    }
  }
  if (want('flowers') || painterly) {
    for (let i = 0; i < 5; i += 1) {
      let x = P.rand(0.05, 0.95) * W; const y = P.rand(0.86, 0.97) * H;
      if (want('river') && x > W * 0.25 && x < W * 0.77) x = x < W * 0.5 ? W * 0.18 : W * 0.86;
      P.brush('near', { points: [{ x: x - 40, y }, { x: x + 40, y: y + 6 }], colors: [palette.accent, lighten(palette.accent, 0.3), '#ffffff'], brush: { preset: 'spray', size: 26, seed: 140 + i }, smooth: 0 }, 'flowers', 'flowers (spray brush, colour mix)');
    }
  }
  if (painterly) {
    P.rect('fx', { x: 0, y: 0, w: W, h: H, fill: rgba(sky.sun, 0.12), blend: 'soft-light' }, 'painting', 'unifying warm glaze (soft-light blend)');
  }
  if (lighting === 'sunset' && silhouette) {
    ev.record('contre-jour-silhouette', 'Sun low behind the subject: near forms darkened 62% into silhouettes.', [glow], 'lighting');
  }
  if (lighting === 'morning' && ev.on('three-light-systems-sunlight')) {
    ev.record('three-light-systems-sunlight', 'Warm sun glow, cool blue sky gradient, warm reflected light on the ground.', [glow], 'lighting');
  }
  // Whole-image finishing: haze where the land meets the sky (depth), gentle grade and grain.
  ctx.effects = lighting === 'night'
    ? [{ type: 'bloom', radius: 18, amount: 0.55 }, { type: 'vignette', amount: 0.35 }, { type: 'grain', amount: 0.12 }]
    : [{ type: 'haze', color: mix(sky.horizon, '#ffffff', 0.3), from: (horizon / H) - 0.22, to: (horizon / H) + 0.12, amount: lighting === 'sunset' ? 0.14 : painterly ? 0.14 : 0.2 }, { type: 'grade', contrast: 1.05, saturation: painterly ? 1.05 : 0.97, warmth: lighting === 'sunset' ? 0.18 : 0.05 }, { type: 'grain', amount: painterly ? 0.16 : 0.1 }];
  return { horizon: Math.round(horizon), lighting, style: painterly ? 'painterly' : 'illustration', requested: intent.elements.map((e) => e.id) };
}

module.exports = { composeLandscape };
