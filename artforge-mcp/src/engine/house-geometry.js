'use strict';

/**
 * One house, drawn the same way by the landscape composer and by the SceneSpec renderer.
 *
 * Geometry: a gable front (facing the viewer) and a receding side wall, a two-plane roof with overhang,
 * a door, windows with frames and mullions, a chimney and a plinth. The wall MATERIAL is geometry, not a
 * colour: stone = irregular coursed stones with mortar joints, brick = running bond, wood = lapped boards.
 * Before this module a requested «منزل من حجر» was one flat gradient rectangle (scenespec-engine house) or
 * four flat rectangles at 9% of the width (landscape composer), so the material never appeared.
 *
 * houseGeometry(box, opts) → [{ type: 'rect'|'poly'|'line', params, note, part }] in absolute pixels.
 * box: { x, y, w, h } with y + h = the ground line. Notes name the material ("stone course …") so the
 * verifier can prove the material was drawn (see materialEvidence).
 */

const { mix, darken, lighten } = require('./color');

const MATERIALS = {
  stone: { wall: '#a59c8f', mortar: '#d6cfc2', note: 'stone course' },
  brick: { wall: '#a24b33', mortar: '#d8cdbd', note: 'brick course' },
  wood: { wall: '#8b5d38', mortar: null, note: 'wood board' },
  plaster: { wall: '#e7dcc8', mortar: null, note: 'plaster wall' },
};

function seeded(seed) {
  let s = (seed >>> 0) || 1;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

/**
 * opts: material (stone|brick|wood|plaster), wallColor (overrides the material colour), roofColor,
 *       lightFromLeft (default true), night, glassColor, seed.
 */
function houseGeometry(box, opts) {
  const o = opts || {};
  const material = MATERIALS[o.material] ? o.material : 'plaster';
  const M = MATERIALS[material];
  const rand = seeded(o.seed || 11);
  const out = [];
  const push = (type, params, note, part) => out.push({ type, params, note, part });
  const lightLeft = o.lightFromLeft !== false;
  const wallBase = o.wallColor ? mix(o.wallColor, M.wall, material === 'plaster' ? 0 : 0.35) : M.wall;
  const roofBase = o.roofColor || (material === 'wood' ? '#4a3a33' : '#8c3f3a');
  const frontShade = lightLeft ? 1 : 0.84;
  const sideShade = lightLeft ? 0.74 : 1;
  const shadeOf = (c, k) => (k >= 1 ? c : darken(c, 1 - k));

  // ---------------------------------------------------------------- volume
  const { x, y, w, h } = box;
  const ground = y + h;
  const fw = w * 0.56; // gable front
  const sw = w * 0.44; // receding side
  const dy = sw * 0.16; // the side recedes upward a little (oblique view)
  const roofH = Math.min(h * 0.36, fw * 0.55);
  const wallH = Math.max(h * 0.3, h - roofH - dy - h * 0.04);
  const gy = ground - wallH; // eave line of the front
  const ov = fw * 0.06; // roof overhang
  const F = { x0: x, x1: x + fw, top: gy, bottom: ground };
  const sidePt = (u, v) => ({ x: F.x1 + sw * u, y: ground - dy * u - wallH * v }); // u along the side, v up
  const frontPt = (u, v) => ({ x: F.x0 + fw * u, y: ground - wallH * v });

  // Ground contact shadow.
  push('poly', { points: [{ x: x - w * 0.04, y: ground + 2 }, { x: x + w * 1.08, y: ground - dy * 0.6 }, { x: x + w * 1.12, y: ground + h * 0.05 }, { x: x - w * 0.02, y: ground + h * 0.06 }],
    fill: 'rgba(30,26,20,0.28)', blur: Math.max(2, w * 0.02) }, 'house contact shadow', 'shadow');

  // Wall fields (the mortar colour for masonry, the base colour otherwise).
  const field = M.mortar || wallBase;
  push('rect', { x: F.x0, y: F.top, w: fw, h: wallH, fill: shadeOf(field, frontShade) }, `front wall (${material})`, 'front');
  push('poly', { points: [sidePt(0, 0), sidePt(1, 0), sidePt(1, 1), sidePt(0, 1)], fill: shadeOf(field, sideShade) }, `side wall (${material})`, 'side');
  const gable = [{ x: F.x0, y: gy }, { x: F.x1, y: gy }, { x: F.x0 + fw / 2, y: gy - roofH }];
  push('poly', { points: gable, fill: shadeOf(field, frontShade) }, `gable (${material})`, 'gable');

  // ---------------------------------------------------------------- material
  const courses = [];
  const face = (name, shade, toPt, rows, widthAt) => {
    const rowH = 1 / rows;
    for (let r = 0; r < rows; r += 1) {
      const v0 = r * rowH; const v1 = v0 + rowH;
      const span = widthAt ? widthAt((v0 + v1) / 2) : [0, 1];
      if (span[1] - span[0] <= 0.02) continue;
      if (material === 'wood') {
        // Lapped boards: a board, its darker drip edge, and a highlight on top.
        const a = toPt(span[0], v0); const b = toPt(span[1], v0); const c = toPt(span[1], v1); const d = toPt(span[0], v1);
        const tone = mix(shadeOf(wallBase, shade), '#000000', rand() * 0.06);
        courses.push({ type: 'poly', params: { points: [a, b, c, d], fill: tone, stroke: shadeOf(darken(wallBase, 0.35), shade), strokeWidth: 1 }, note: `${M.note} ${name}` });
        courses.push({ type: 'line', params: { x1: a.x, y1: a.y, x2: b.x, y2: b.y, stroke: 'rgba(25,15,8,0.45)', strokeWidth: Math.max(1, (toPt(0, rowH).y - toPt(0, 0).y) * -0.12) }, note: `${M.note} shadow ${name}` });
        continue;
      }
      // Masonry: units of varying width; brick rows are offset by half a unit (running bond).
      const unit = material === 'brick' ? 0.115 : 0.16;
      let u = span[0] - (material === 'brick' ? (r % 2 ? unit / 2 : 0) : rand() * unit * 0.6);
      const gap = material === 'brick' ? 0.06 : 0.09; // joint, as a fraction of the row height
      while (u < span[1]) {
        const len = material === 'brick' ? unit : unit * (0.55 + rand() * 0.9);
        const u0 = Math.max(span[0], u); const u1 = Math.min(span[1], u + len);
        u += len;
        if (u1 - u0 < unit * 0.18) continue;
        const ju = (u1 - u0) * gap * 0.5; const jv = rowH * gap;
        const jitter = material === 'stone' ? () => (rand() - 0.5) * rowH * 0.18 : () => 0;
        const corners = [[u0 + ju, v0 + jv], [u1 - ju, v0 + jv], [u1 - ju, v1 - jv], [u0 + ju, v1 - jv]]
          .map(([cu, cv]) => toPt(Math.min(span[1], Math.max(span[0], cu + jitter() * 0.2)), Math.min(1, Math.max(0, cv + jitter()))));
        const pts = material === 'stone'
          ? [corners[0], { x: (corners[0].x + corners[1].x) / 2, y: (corners[0].y + corners[1].y) / 2 - (rand() - 0.3) * 2 }, corners[1], corners[2], { x: (corners[2].x + corners[3].x) / 2, y: (corners[2].y + corners[3].y) / 2 + (rand() - 0.3) * 2 }, corners[3]]
          : corners;
        const variation = material === 'stone' ? (rand() - 0.5) * 0.22 : (rand() - 0.5) * 0.12;
        const tone = variation >= 0 ? lighten(shadeOf(wallBase, shade), variation) : darken(shadeOf(wallBase, shade), -variation);
        const warm = material === 'stone' && rand() < 0.3 ? mix(tone, '#b79a74', 0.25) : tone;
        courses.push({ type: 'poly', params: { points: pts, fill: warm, stroke: shadeOf(darken(wallBase, 0.32), shade), strokeWidth: material === 'stone' ? 1.2 : 0.8 }, note: `${M.note} ${name}` });
      }
    }
  };
  if (material !== 'plaster') {
    const rowsFront = Math.max(6, Math.round(wallH / Math.max(8, (material === 'stone' ? fw * 0.075 : (material === 'brick' ? fw * 0.035 : fw * 0.06)))));
    face('front', frontShade, frontPt, rowsFront);
    face('side', sideShade, sidePt, rowsFront);
    // Gable: rows above the eave, clipped to the triangle.
    const gRows = Math.max(3, Math.round(rowsFront * roofH / wallH));
    const gablePt = (u, v) => ({ x: F.x0 + fw * u, y: gy - roofH * v });
    face('gable', frontShade, gablePt, gRows, (v) => [0.5 * v + 0.02, 1 - 0.5 * v - 0.02]);
  } else {
    push('rect', { x: F.x0, y: F.top, w: fw, h: wallH, fill: { type: 'linear', angle: 90, stops: [{ offset: 0, color: 'rgba(255,255,255,0.08)' }, { offset: 1, color: 'rgba(0,0,0,0.08)' }] } }, 'plaster wall shading', 'front');
  }
  for (const c of courses) push(c.type, c.params, c.note, 'material');

  // Corner and plinth.
  push('line', { x1: F.x1, y1: ground, x2: F.x1, y2: gy, stroke: 'rgba(20,16,12,0.35)', strokeWidth: Math.max(1.5, w * 0.004) }, 'house corner edge', 'edge');
  const plinth = wallH * 0.06;
  push('poly', { points: [frontPt(0, 0), frontPt(1, 0), { x: F.x1, y: ground - plinth }, { x: F.x0, y: ground - plinth }], fill: shadeOf('#6f675d', frontShade) }, 'plinth front', 'plinth');
  push('poly', { points: [sidePt(0, 0), sidePt(1, 0), { x: sidePt(1, 0).x, y: sidePt(1, 0).y - plinth }, { x: sidePt(0, 0).x, y: sidePt(0, 0).y - plinth }], fill: shadeOf('#6f675d', sideShade) }, 'plinth side', 'plinth');

  // ---------------------------------------------------------------- roof
  const apex = { x: F.x0 + fw / 2, y: gy - roofH };
  const apexBack = { x: apex.x + sw, y: apex.y - dy };
  const eaveFront = { x: F.x1 + ov, y: gy + ov * 0.45 };
  const eaveBack = { x: F.x1 + sw + ov, y: gy - dy + ov * 0.45 };
  const roofSide = [apex, apexBack, eaveBack, eaveFront];
  push('poly', { points: roofSide, fill: { type: 'linear', angle: 90, stops: [{ offset: 0, color: lighten(roofBase, 0.06) }, { offset: 1, color: darken(roofBase, 0.18) }] } }, 'roof slope', 'roof');
  // Tile courses on the slope.
  for (let i = 1; i < 7; i += 1) {
    const t = i / 7;
    const a = { x: apex.x + (eaveFront.x - apex.x) * t, y: apex.y + (eaveFront.y - apex.y) * t };
    const b = { x: apexBack.x + (eaveBack.x - apexBack.x) * t, y: apexBack.y + (eaveBack.y - apexBack.y) * t };
    push('line', { x1: a.x, y1: a.y, x2: b.x, y2: b.y, stroke: rgbaOf(darken(roofBase, 0.4), 0.5), strokeWidth: Math.max(1, w * 0.003) }, 'roof tile course', 'roof');
  }
  // Barge boards on the gable (the roof edge facing the viewer) with overhang.
  const bargeW = Math.max(3, fw * 0.035);
  push('poly', { points: [{ x: F.x0 - ov, y: gy + ov * 0.45 }, apex, { x: apex.x, y: apex.y + bargeW }, { x: F.x0 - ov + bargeW * 0.7, y: gy + ov * 0.45 + bargeW * 0.6 }], fill: darken(roofBase, 0.25) }, 'gable barge board', 'roof');
  push('poly', { points: [apex, eaveFront, { x: eaveFront.x - bargeW * 0.7, y: eaveFront.y + bargeW * 0.6 }, { x: apex.x, y: apex.y + bargeW }], fill: darken(roofBase, 0.3) }, 'gable barge board', 'roof');
  push('line', { x1: apex.x, y1: apex.y, x2: apexBack.x, y2: apexBack.y, stroke: darken(roofBase, 0.45), strokeWidth: Math.max(2, w * 0.006) }, 'roof ridge', 'roof');
  // Chimney on the slope.
  const ct = 0.55; const cu = { x: apex.x + (apexBack.x - apex.x) * ct, y: apex.y + (apexBack.y - apex.y) * ct };
  const cw = sw * 0.12; const ch = roofH * 0.55;
  const chimneyColor = material === 'wood' ? '#7d756c' : (material === 'brick' ? wallBase : '#8f877c');
  push('rect', { x: cu.x + sw * 0.05, y: cu.y - ch * 0.55, w: cw, h: ch, fill: shadeOf(chimneyColor, sideShade) }, `chimney (${material})`, 'chimney');
  push('rect', { x: cu.x + sw * 0.05 - cw * 0.12, y: cu.y - ch * 0.62, w: cw * 1.24, h: ch * 0.1, fill: darken(chimneyColor, 0.3) }, 'chimney cap', 'chimney');

  // ---------------------------------------------------------------- openings
  const glass = o.night ? '#ffd98a' : (o.glassColor || '#9fbfdc');
  const frame = material === 'wood' ? '#efe6d6' : '#f2ede4';
  const doorW = fw * 0.22; const doorH = wallH * 0.6;
  const door = { x: F.x0 + fw / 2 - doorW / 2, y: ground - doorH, w: doorW, h: doorH };
  push('rect', { x: door.x - doorW * 0.08, y: door.y - doorW * 0.08, w: doorW * 1.16, h: doorH + doorW * 0.08, fill: frame }, 'door frame', 'door');
  push('rect', { x: door.x, y: door.y, w: doorW, h: doorH, fill: shadeOf('#5a3a24', frontShade), radius: doorW * 0.08 }, 'door', 'door');
  push('line', { x1: door.x + doorW / 2, y1: door.y + doorH * 0.08, x2: door.x + doorW / 2, y2: ground - doorH * 0.04, stroke: 'rgba(0,0,0,0.25)', strokeWidth: 1.2 }, 'door panel', 'door');
  push('ellipse', { x: door.x + doorW * 0.78, y: door.y + doorH * 0.52, w: doorW * 0.08, h: doorW * 0.08, fill: '#d9b45a' }, 'door knob', 'door');
  push('rect', { x: door.x - doorW * 0.2, y: ground - wallH * 0.03, w: doorW * 1.4, h: wallH * 0.035, fill: '#7d766c' }, 'door step', 'door');
  const windowAt = (corner, ww, wh, name, toPt, shade) => {
    // corner: (u, v) of the window's bottom-left on its face; drawn through the face mapping so side windows recede.
    const [u, v] = corner;
    const q = (du, dv) => toPt(u + du, v + dv);
    push('poly', { points: [q(-0.02, -0.03), q(ww + 0.02, -0.03), q(ww + 0.02, wh + 0.03), q(-0.02, wh + 0.03)], fill: frame }, `window frame ${name}`, 'window');
    push('poly', { points: [q(0, 0), q(ww, 0), q(ww, wh), q(0, wh)], fill: shadeOf(glass, shade) }, `window glass ${name}`, 'window');
    push('poly', { points: [q(0, wh * 0.55), q(ww, wh * 0.55), q(ww, wh * 0.6), q(0, wh * 0.6)], fill: frame }, `window mullion ${name}`, 'window');
    push('poly', { points: [q(ww * 0.47, 0), q(ww * 0.53, 0), q(ww * 0.53, wh), q(ww * 0.47, wh)], fill: frame }, `window mullion ${name}`, 'window');
    push('poly', { points: [q(-0.04, -0.05), q(ww + 0.04, -0.05), q(ww + 0.04, -0.02), q(-0.04, -0.02)], fill: darken(frame, 0.15) }, `window sill ${name}`, 'window');
  };
  windowAt([0.08, 0.42], 0.2, 0.32, 'front left', frontPt, frontShade);
  windowAt([0.72, 0.42], 0.2, 0.32, 'front right', frontPt, frontShade);
  windowAt([0.42, 0.18], 0.13, 0.15, 'gable', (u, v) => ({ x: F.x0 + fw * u, y: gy - roofH * v }), frontShade);
  windowAt([0.18, 0.4], 0.24, 0.32, 'side 1', sidePt, sideShade);
  windowAt([0.6, 0.4], 0.24, 0.32, 'side 2', sidePt, sideShade);
  if (o.night) push('ellipse', { x: door.x - doorW * 1.5, y: door.y - doorH * 0.2, w: doorW * 4, h: doorH * 1.4, fill: 'rgba(255,214,140,0.18)', blur: doorW * 0.6 }, 'window light spill', 'light');

  return { prims: out, door: { x: door.x + doorW / 2, y: ground }, footprint: { x: x - w * 0.02, y: ground - dy, w: w * 1.1, h: dy + h * 0.06 }, material };
}

function rgbaOf(hex, a) {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

/** What a plan proves about a requested material: ops whose note names it (e.g. "stone course"). */
function materialEvidence(ops, element, material) {
  const word = (MATERIALS[material] || {}).note;
  if (!word) return { material, units: 0 };
  const units = ops.filter((op) => op.element === element && String(op.note || '').startsWith(word) && !/shadow/.test(op.note)).length;
  return { material, units };
}

module.exports = { houseGeometry, materialEvidence, MATERIALS };
