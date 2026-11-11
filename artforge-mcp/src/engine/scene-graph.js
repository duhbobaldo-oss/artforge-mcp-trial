'use strict';

/**
 * Scene graph (stage ③): a structured description of the picture BEFORE any drawing decision.
 *
 * Every requested entity becomes one node per instance (count 3 → pen_1, pen_2, pen_3) with an anchor
 * (sky, horizon, ground, floor, wall, surface, water), a depth plane, a pixel box and a z order.
 * Placement starts from size priors and anchors, then the spatial relations from the request are solved
 * (on, beside, behind, between…). The result reports which relations hold geometrically and which do not,
 * so a later stage can correct them instead of assuming success.
 */

const { motifOf } = require('./motifs');

const PLANES = ['sky', 'background', 'midground', 'foreground'];
const PLANE_DEPTH = { sky: 0, background: 0.25, midground: 0.6, foreground: 0.92 };
const PLANE_SCALE = { sky: 1, background: 0.62, midground: 1, foreground: 1.2 };

/**
 * Priors: anchor, default plane, size as a fraction of the canvas (w of width, h of height),
 * `round` sizes on the shorter side so a sun stays round on any aspect.
 */
const PRIORS = {
  bed: { anchor:'floor', plane:'midground', w:0.38, h:0.28, category:'furniture' },
  book: { anchor:'surface', plane:'foreground', w:0.12, h:0.08, category:'prop' },
  diningTable: { anchor: 'floor', plane: 'midground', w: 0.4, h: 0.25, category: 'furniture' },
  plate: { anchor: 'surface', plane: 'foreground', w: 0.08, h: 0.035, category: 'prop' },
  cutlery: { anchor: 'surface', plane: 'foreground', w: 0.07, h: 0.05, category: 'prop' },
  car: { anchor: 'ground', plane: 'foreground', w: 0.26, h: 0.15, category: 'vehicle' },
  fireplace: { anchor: 'wall', plane: 'background', w: 0.2, h: 0.27, category: 'room' },
  sky: { anchor: 'sky', plane: 'sky', w: 1, h: 0.62, category: 'sky', structural: true },
  sun: { anchor: 'sky', plane: 'sky', w: 0.11, h: 0.11, round: true, category: 'sky' },
  moon: { anchor: 'sky', plane: 'sky', w: 0.09, h: 0.09, round: true, category: 'sky' },
  stars: { anchor: 'sky', plane: 'sky', w: 0.9, h: 0.32, category: 'sky' },
  clouds: { anchor: 'sky', plane: 'sky', w: 0.28, h: 0.09, category: 'sky' },
  birds: { anchor: 'sky', plane: 'sky', w: 0.14, h: 0.06, category: 'sky' },
  mountains: { anchor: 'horizon', plane: 'background', w: 1, h: 0.3, category: 'terrain' },
  hills: { anchor: 'horizon', plane: 'background', w: 1, h: 0.16, category: 'terrain' },
  dunes: { anchor: 'ground', plane: 'midground', w: 1, h: 0.2, category: 'terrain' },
  sea: { anchor: 'water', plane: 'midground', w: 1, h: 0.26, category: 'water' },
  lake: { anchor: 'ground', plane: 'midground', w: 0.5, h: 0.1, category: 'water' },
  river: { anchor: 'ground', plane: 'midground', w: 0.32, h: 0.34, category: 'water' },
  grass: { anchor: 'ground', plane: 'foreground', w: 1, h: 0.16, category: 'terrain' },
  garden: { anchor: 'ground', plane: 'foreground', w: 0.6, h: 0.2, category: 'vegetation' },
  trees: { anchor: 'ground', plane: 'midground', w: 0.13, h: 0.36, category: 'vegetation' },
  palms: { anchor: 'ground', plane: 'midground', w: 0.12, h: 0.42, category: 'vegetation' },
  flowers: { anchor: 'ground', plane: 'foreground', w: 0.14, h: 0.06, category: 'vegetation' },
  rocks: { anchor: 'ground', plane: 'foreground', w: 0.12, h: 0.08, category: 'terrain' },
  boat: { anchor: 'water', plane: 'midground', w: 0.12, h: 0.09, category: 'object' },
  lighthouse: { anchor: 'ground', plane: 'midground', w: 0.06, h: 0.36, category: 'building' },
  house: { anchor: 'ground', plane: 'midground', w: 0.2, h: 0.2, category: 'building' },
  building: { anchor: 'ground', plane: 'midground', w: 0.2, h: 0.48, category: 'building' },
  tower: { anchor: 'ground', plane: 'midground', w: 0.12, h: 0.72, category: 'building' },
  road: { anchor: 'ground', plane: 'foreground', w: 0.5, h: 0.24, category: 'terrain' },
  wall: { anchor: 'wall', plane: 'background', w: 1, h: 0.62, category: 'room', structural: true },
  floor: { anchor: 'floor', plane: 'background', w: 1, h: 0.38, category: 'room', structural: true },
  ground: { anchor: 'ground', plane: 'background', w: 1, h: 0.44, category: 'terrain', structural: true },
  window: { anchor: 'wall', plane: 'background', w: 0.2, h: 0.3, category: 'room' },
  frame: { anchor: 'wall', plane: 'background', w: 0.12, h: 0.1, category: 'room' },
  clock: { anchor: 'wall', plane: 'background', w: 0.06, h: 0.06, round: true, category: 'room' },
  tv: { anchor: 'wall', plane: 'background', w: 0.22, h: 0.15, category: 'object' },
  bookshelf: { anchor: 'floor', plane: 'background', w: 0.2, h: 0.55, category: 'furniture' },
  sofa: { anchor: 'floor', plane: 'midground', w: 0.32, h: 0.2, category: 'furniture' },
  armchair: { anchor: 'floor', plane: 'midground', w: 0.15, h: 0.22, category: 'furniture' },
  desk: { anchor: 'floor', plane: 'midground', w: 0.36, h: 0.27, category: 'furniture' },
  coffeeTable: { anchor: 'floor', plane: 'foreground', w: 0.2, h: 0.08, category: 'furniture' },
  lamp: { anchor: 'floor', plane: 'midground', w: 0.06, h: 0.36, category: 'furniture' },
  plant: { anchor: 'floor', plane: 'foreground', w: 0.07, h: 0.18, category: 'vegetation' },
  rug: { anchor: 'floor', plane: 'foreground', w: 0.42, h: 0.08, category: 'room' },
  person: { anchor: 'floor', plane: 'midground', w: 0.1, h: 0.44, category: 'figure' },
  notebook: { anchor: 'surface', plane: 'midground', w: 0.1, h: 0.03, category: 'prop' },
  pen: { anchor: 'surface', plane: 'midground', w: 0.06, h: 0.012, category: 'prop' },
};
const OUTDOOR_TO_INDOOR = { floor: 'ground', wall: 'horizon' };

function prior(motif) {
  return PRIORS[motif] || { anchor: 'ground', plane: 'midground', w: 0.12, h: 0.15, category: 'unknown', drawable: false };
}

const r1 = (v) => Math.round(v * 10) / 10;
function box(x, y, w, h) { return { x: r1(x), y: r1(y), w: r1(w), h: r1(h) }; }
function overlap(a, b) {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}
const cx = (b) => b.x + b.w / 2;
const bottom = (b) => b.y + b.h;

/** Horizon and floor lines from the viewpoint: top views show more ground, low angles more sky. */
function framing(viewpoint, indoor) {
  const horizon = { eye: 0.56, wide: 0.58, closeup: 0.5, top: 0.22, low: 0.78 }[viewpoint] || 0.56;
  const floorLine = { eye: 0.62, wide: 0.6, closeup: 0.66, top: 0.3, low: 0.74 }[viewpoint] || 0.62;
  return indoor ? { horizon: floorLine, floorLine } : { horizon, floorLine: horizon };
}

function buildSceneGraph(understanding, canvas, options) {
  const opts = options || {};
  const W = canvas.width;
  const H = canvas.height;
  const minSide = Math.min(W, H);
  const motifs = understanding.entities.map((e) => e.motif);
  const roomish = ['desk', 'bookshelf', 'tv', 'sofa', 'armchair', 'lamp', 'rug', 'plant', 'frame', 'clock', 'coffeeTable', 'window', 'notebook', 'pen'];
  const indoor = understanding.designType === 'scene' || (understanding.designType !== 'landscape' && motifs.some((m) => roomish.includes(m)) && !motifs.some((m) => ['mountains', 'sea', 'sky', 'hills', 'dunes'].includes(m)));
  const viewpoint = understanding.constraints.viewpoint || 'eye';
  const lines = framing(viewpoint, indoor);
  // A composer that already drew the environment fixes the horizon / floor line the graph must agree with.
  const horizonY = Number.isFinite(opts.horizonY) ? opts.horizonY : lines.horizon * H;
  const floorY = Number.isFinite(opts.floorY) ? opts.floorY : (indoor && Number.isFinite(opts.horizonY) ? opts.horizonY : lines.floorLine * H);
  const margin = Math.round(minSide * 0.04);
  // A sea is a band from the horizon to the shore; ground objects stand on the shore below it.
  const hasSea = !indoor && motifs.includes('sea') && understanding.entities.some((e) => ['house', 'trees', 'palms', 'lighthouse', 'building', 'tower', 'person', 'rocks', 'garden', 'flowers', 'grass'].includes(e.motif));
  const shoreY = hasSea ? horizonY + (H - horizonY) * 0.34 : horizonY;

  const nodes = [];
  const add = (motif, instance, entity, structural) => {
    const p = prior(motif);
    let anchor = p.anchor;
    if (!indoor && OUTDOOR_TO_INDOOR[anchor]) anchor = OUTDOOR_TO_INDOOR[anchor];
    if (indoor && anchor === 'horizon') anchor = 'wall';
    if (indoor && anchor === 'ground') anchor = 'floor';
    const sizeK = entity && entity.attributes && entity.attributes.size === 'large' ? 1.35 : (entity && entity.attributes && entity.attributes.size === 'small' ? 0.7 : 1);
    const scale = PLANE_SCALE[p.plane] * sizeK;
    let w = (p.round ? p.w * minSide : p.w * W) * (p.w >= 0.9 ? 1 : scale);
    const h = (p.round ? p.h * minSide : p.h * H) * (p.w >= 0.9 ? 1 : scale);
    if(motif==='person' && entity && entity.attributes.rigPose) w=Math.max(w,h*0.6);
    const count = entity ? entity.count : 1;
    const id = count > 1 ? `${motif}_${instance}` : motif;
    nodes.push({
      id,
      entity: entity ? entity.id : motif,
      motif,
      instance,
      category: p.category,
      anchor,
      plane: p.plane,
      drawable: p.drawable !== false,
      structural: Boolean(structural || p.structural),
      attributes: entity ? Object.assign({}, entity.attributes) : {},
      box: box(0, 0, Math.min(w, W), Math.min(h, H)),
      z: 0,
    });
  };

  // Structural context first: an interior has a wall and a floor, an exterior has sky (unless already asked).
  if (indoor) { add('wall', 1, null, true); add('floor', 1, null, true); } else {
    if (!motifs.includes('sky')) add('sky', 1, null, true);
    add('ground', 1, null, true);
  }
  for (const entity of understanding.entities) {
    for (let i = 1; i <= Math.max(1, Math.min(entity.count, 12)); i += 1) add(entity.motif, i, entity, false);
  }

  // ── initial placement by anchor ──
  const slots = {};
  const place = (n) => {
    const b = n.box;
    const lane = `${n.anchor}:${n.plane}`;
    const group = nodes.filter((m) => `${m.anchor}:${m.plane}` === lane && !m.structural && m.box.w < W * 0.9);
    const k = group.indexOf(n);
    const slotsIn = Math.max(1, group.length);
    slots[lane] = slotsIn;
    // Spread the lane evenly; the first of a lane sits on the right third (RTL reading start), the rest follow.
    const usable = W - margin * 2;
    const centre = b.w >= W * 0.9 ? W / 2 : margin + usable * ((slotsIn - k - 0.5) / slotsIn);
    let x = centre - b.w / 2;
    let y;
    switch (n.anchor) {
      case 'sky': y = n.structural ? 0 : Math.max(margin, horizonY * (n.motif === 'stars' ? 0.08 : 0.18) + (k % 2) * horizonY * 0.12); break;
      case 'horizon': y = horizonY - b.h; break;
      case 'water': y = horizonY + (n.motif === 'sea' ? 0 : (shoreY - horizonY) * 0.3); break;
      case 'wall': y = n.structural ? 0 : Math.max(margin, floorY * 0.42 - b.h / 2); break;
      case 'floor': {
        if (n.structural) { y = floorY; break; }
        const depth = PLANE_DEPTH[n.plane];
        y = floorY + (H - floorY) * depth * 0.85 - b.h;
        break;
      }
      case 'surface': y = floorY - b.h; break;
      default: { // ground
        const depth = PLANE_DEPTH[n.plane];
        const top = n.category === 'terrain' || n.category === 'water' ? horizonY : shoreY + (H - shoreY) * 0.08;
        y = top + (H - top) * depth * 0.88 - b.h;
        if (b.w >= W * 0.9) x = 0;
      }
    }
    if (n.motif === 'sea') { x = 0; y = horizonY; n.box.h = hasSea ? shoreY - horizonY : Math.max(n.box.h, (H - horizonY) * 0.55); }
    if (n.motif === 'grass' || n.motif === 'road') y = H - b.h;
    if (n.structural && n.motif === 'floor') n.box.h = H - floorY;
    if (n.structural && n.motif === 'wall') n.box.h = floorY;
    if (n.structural && n.motif === 'sky') n.box.h = horizonY + 2;
    if (n.structural && n.motif === 'ground') { x = 0; y = hasSea ? shoreY : horizonY; n.box.h = H - y; n.ground = hasSea ? 'sand' : (motifs.some((m) => ['building', 'tower', 'road'].includes(m)) ? 'pavement' : 'grass'); }
    n.box.x = r1(x);
    n.box.y = r1(y);
  };
  nodes.forEach(place);
  // Seeds: positions an existing composer actually drew. Relations then move subjects from there.
  for (const n of nodes) {
    const seed = opts.seed && opts.seed[n.id];
    if (!seed || n.structural) continue;
    n.box = box(seed.x, seed.y, seed.w, seed.h);
    n.seeded = true;
    n.seedBox = Object.assign({}, n.box);
  }

  // ── relations ──
  const byId = (ref) => {
    if (!ref) return [];
    const [entityId, instance] = String(ref).split('#');
    const list = nodes.filter((n) => n.entity === entityId && !n.structural);
    return instance ? list.filter((n) => n.instance === Number(instance)) : list;
  };
  const gap = minSide * 0.02;
  const solved = [];
  for (const rel of understanding.relations || []) {
    const subjects = byId(rel.subject);
    const target = byId(rel.object)[0];
    const target2 = rel.object2 ? byId(rel.object2)[0] : null;
    if (!subjects.length || !target) { solved.push(Object.assign({}, rel, { applied: false, reason: 'entity not in graph' })); continue; }
    subjects.forEach((s, i) => {
      // Something a composer already drew in the right place is not moved (top-down desk: inside = on).
      if (s.seeded && target.seeded && !s.attributes.rigPose && relationHolds(Object.assign({}, rel, { subject: s.entity }), { canvas: { width: W, height: H }, nodes: [s, target].concat(target2 ? [target2] : []) })) return;
      // Terrain and canvas-wide elements are environment: relations to them are satisfied by depth order only.
      if (s.seeded && (['terrain', 'water'].includes(s.category) || s.box.w >= W * 0.9)) { if (rel.relation === 'behind') s.behind = target.id; return; }
      const t = target.box;
      const b = s.box;
      const spread = subjects.length > 1 ? (i - (subjects.length - 1) / 2) * (b.w + gap * 0.5) : 0;
      const sameGround = s.anchor === target.anchor || (['floor', 'ground'].includes(s.anchor) && ['floor', 'ground', 'surface'].includes(target.anchor));
      switch (rel.relation) {
        case 'held':
          b.w = Math.min(b.w,t.w*0.75); b.h = Math.min(b.h,t.h*0.16);
          b.x = cx(t)-b.w/2; b.y = t.y+t.h*(target.attributes.rigPose?0.65:0.5);
          s.plane=target.plane; s.parent=target.id; s.anchor='surface'; break;
        case 'on':
          if (s.motif === 'person' && target.motif === 'armchair' && s.attributes.pose === 'seated') { b.w=s.attributes.rigPose?t.w*1.35:Math.min(b.w,t.w*0.8); b.h=Math.min(b.h,t.h*1.5); b.x=cx(t)-b.w/2; b.y=bottom(t)-b.h; }
          else if (target.motif === 'road') { b.x = cx(t) - b.w / 2; b.y = t.y + t.h * 0.8 - b.h; }
          else if (s.anchor === 'water' || target.category === 'water') { b.y = t.y + Math.min(t.h * 0.25, t.h - b.h); b.x = t.x + t.w * (0.3 + 0.4 * ((i + 1) / (subjects.length + 1))) - b.w / 2; }
          else { b.x = cx(t) - b.w / 2 + spread * 1.1; b.y = t.y - b.h + Math.min(b.h * 0.2, t.h * 0.05); }
          s.plane = target.plane; s.parent = target.id; s.anchor = 'surface';
          break;
        case 'above': b.x = cx(t) - b.w / 2 + spread; b.y = t.y - b.h - gap; break;
        case 'below': b.x = cx(t) - b.w / 2 + spread; b.y = bottom(t) - b.h; s.plane = target.plane; break;
        case 'beside': {
          const right = t.x + t.w + gap;
          const left = t.x - gap - b.w;
          b.x = right + b.w <= W - margin ? right + i * (b.w + gap) : left - i * (b.w + gap);
          if (sameGround) { b.y = bottom(t) - b.h; s.plane = target.plane; }
          break;
        }
        case 'left': b.x = t.x - gap - b.w - i * (b.w + gap); if (sameGround) { b.y = bottom(t) - b.h; s.plane = target.plane; } break;
        case 'right': b.x = t.x + t.w + gap + i * (b.w + gap); if (sameGround) { b.y = bottom(t) - b.h; s.plane = target.plane; } break;
        case 'behind': {
          if (s.anchor === 'sky') { s.behind = target.id; break; }
          const back = PLANES[Math.max(1, PLANES.indexOf(target.plane) - 1)];
          // Just behind, not far away: a slight size reduction keeps it readable above the nearer object.
          if (back !== s.plane && !['horizon', 'sky'].includes(s.anchor)) { b.w *= 0.85; b.h *= 0.85; s.plane = back; }
          if (s.anchor === 'horizon' || b.w >= W * 0.9) { s.behind = target.id; break; }
          // Keep at least half of it visible: offset to the side of the target with more room.
          const roomRight = W - (t.x + t.w); const roomLeft = t.x;
          b.x = (roomRight >= roomLeft ? t.x + t.w - b.w * 0.25 : t.x - b.w * 0.75) + spread;
          // Further back = its foot higher on the floor/ground, never floating above the target.
          b.y = bottom(t) - b.h - gap * 1.5;
          break;
        }
        case 'front': {
          const fwd = PLANES[Math.min(3, PLANES.indexOf(target.plane) + 1)];
          s.plane = fwd;
          b.x = cx(t) - b.w / 2 + spread;
          b.y = Math.min(H - margin - b.h, bottom(t) + gap * 2 - b.h * 0.3);
          break;
        }
        case 'inside': { const k = Math.min(1, (t.w * 0.6) / b.w, (t.h * 0.6) / b.h); b.w *= k; b.h *= k; b.x = cx(t) - b.w / 2; b.y = t.y + t.h / 2 - b.h / 2; s.parent = target.id; break; }
        case 'between': if (target2) { b.x = (cx(t) + cx(target2.box)) / 2 - b.w / 2; if (sameGround) { b.y = Math.max(bottom(t), bottom(target2.box)) - b.h; s.plane = target.plane; } } break;
        default: break; // facing: orientation only
      }
      if (rel.relation === 'facing') s.facing = target.id;
    });
    solved.push(Object.assign({}, rel, { applied: true }));
  }

  // Between two instances of one element: separate them enough for the subject to fit.
  for (const rel of solved.filter((r) => r.relation === 'between' && r.applied && r.object2)) {
    const a = byId(rel.object)[0]; const c = byId(rel.object2)[0]; const s = byId(rel.subject)[0];
    if (!a || !c || !s) continue;
    const need = s.box.w / 2 + gap + Math.max(a.box.w, c.box.w) / 2;
    const mid = cx(s.box);
    a.box.x = mid + need - a.box.w / 2; c.box.x = mid - need - c.box.w / 2;
    a.box.y = bottom(s.box) - a.box.h; c.box.y = bottom(s.box) - c.box.h;
  }

  // Objects resting on one surface share its top: lay them out right-to-left with gaps instead of stacking.
  for (const parent of nodes) {
    const kids = nodes.filter((n) => n.parent === parent.id && n.anchor === 'surface');
    if (kids.length < 2 || parent.category === 'water') continue;
    const total = kids.reduce((s, k) => s + k.box.w, 0) + gap * 0.6 * (kids.length - 1);
    const scale = total > parent.box.w * 0.9 ? (parent.box.w * 0.9) / total : 1;
    let x = cx(parent.box) + (total * scale) / 2;
    for (const k of kids) {
      k.box.w *= scale; k.box.h *= scale;
      x -= k.box.w;
      k.box.x = x;
      k.box.y = parent.box.y - k.box.h + Math.min(k.box.h * 0.2, parent.box.h * 0.05);
      x -= gap * 0.6 * scale;
    }
  }

  // A dining set uses two rows so the table remains visible; explicit spatial constraints win.
  const dining = nodes.find(n => n.motif === 'diningTable');
  if (dining && !(understanding.relations || []).some(r => ['armchair','diningTable'].includes(r.subject))) {
    dining.box = box(W*0.28,H*0.53,W*0.44,H*0.24);
    const chairs=nodes.filter(n=>n.motif==='armchair');
    chairs.forEach((n,i)=>{const row=i<Math.ceil(chairs.length/2)?0:1;const count=row===0?Math.ceil(chairs.length/2):Math.floor(chairs.length/2);const k=row===0?i:i-Math.ceil(chairs.length/2);n.box=box(W*(0.28+0.44*(k+0.5)/count)-W*0.055,H*(row===0?0.41:0.65),W*0.11,H*0.17);n.plane='midground';n.attributes.dining=true;});
    for(const motif of ['plate','cutlery']){const items=nodes.filter(n=>n.motif===motif);items.forEach((n,i)=>{n.box.x=dining.box.x+dining.box.w*(i+.5)/items.length-n.box.w/2;n.box.y=dining.box.y+H*(motif==='plate'?.008:.025);n.plane=dining.plane;n.parent=dining.id;});}
  }
  const skyWindow=indoor && nodes.find(n=>n.motif==='window');
  if(skyWindow) for(const n of nodes.filter(n=>n.motif==='moon' && n.attributes.phase==='crescent')) {
    if(!(understanding.relations||[]).some(r=>r.subject===n.entity)) {
      const w=Math.min(n.box.w,skyWindow.box.w*0.22);n.box=box(skyWindow.box.x+skyWindow.box.w*0.65,skyWindow.box.y+skyWindow.box.h*0.25,w,w);n.parent=skyWindow.id;
    }
  }
  // A desk pose uses a side-view work surface and an explicit support seat.
  // The tabletop contacts and pelvis share the same head-unit frame.
  for(const n of nodes.filter(n=>n.attributes.rigPose==='desk')){
    const desk=nodes.find(t=>t.motif==='desk');if(!desk)continue;
    desk.box=box(W*.46,H*.58,W*.42,H*.27);
    const unit=Math.min(desk.box.h/3.1,W*.065),x=desk.box.x-unit*1.3,y=desk.box.y+unit;
    n.attributes.rigFrame={x,y,unit};n.attributes.rigHands={L:{x:x+unit*1.7,y:desk.box.y},R:{x:x+unit*2.7,y:desk.box.y}};
    n.box=box(x-unit,y-unit*3.5,unit*4,unit*5.8);
    // This seat is actual scene geometry, reported as an intentional support.
    let chair=nodes.find(t=>t.motif==='armchair');if(!chair){chair={id:'rig-seat',entity:'rig-seat',motif:'armchair',instance:1,category:'furniture',anchor:'floor',plane:n.plane,drawable:true,structural:false,attributes:{supportFor:n.id},box:box(x-unit*.8,y-unit*2,unit*1.54,unit*3.23)};nodes.push(chair);}
    n.attributes.support={node:chair.id,pelvis:{x,y}};
  }
  // A bare reclining figure needs landscape framing rather than a portrait seed.
  for(const n of nodes.filter(n=>n.attributes.rigPose==='reclining'))if(!nodes.some(t=>t!==n&&!t.structural)){
    n.box=box(W*.1,H*.4,W*.8,H*.45);n.attributes.rigFrame=undefined;
  }
  // A seated rig is anchored at the chair seat, not fitted into its whole bounding box.
  // The same pelvis/head unit frame drives the limbs and the held object's contacts.
  for(const n of nodes.filter(n=>n.motif==='person' && n.attributes.rigPose && n.parent)) {
    const chair=nodes.find(t=>t.id===n.parent && t.motif==='armchair');if(!chair)continue;
    const unit=chair.box.h/5,x=chair.box.x+chair.box.w*0.52,y=chair.box.y+chair.box.h*0.62;
    n.attributes.rigFrame={x,y,unit};n.box=box(x-unit*1.15,y-unit*3.5,unit*3.7,unit*5.7);
    for(const held of nodes.filter(t=>t.motif==='book' && t.parent===n.id))held.box=box(x-unit*0.1,y-unit*0.85,unit*1.6,unit*0.6);
  }
  // Clamp inside the canvas and assign z: planes back to front, then lower bottom = nearer, children above parents.
  for (const n of nodes) {
    const b = n.box;
    b.w = Math.min(b.w, W); b.h = Math.min(b.h, H);
    b.x = r1(Math.min(Math.max(b.x, n.structural || b.w >= W * 0.9 ? 0 : margin * 0.25), W - b.w));
    b.y = r1(Math.min(Math.max(b.y, 0), H - b.h));
    b.w = r1(b.w); b.h = r1(b.h);
  }
  const {fitPoseFrame,heldBookBox}=require('./composer/pose-layout');
  for(const n of nodes.filter(n=>n.motif==='person'&&n.attributes.rigPose)){
    n.attributes.rigFrame=n.attributes.rigFrame||fitPoseFrame(n.box,n.attributes.rigPose);
    for(const held of nodes.filter(t=>t.motif==='book'&&t.parent===n.id)){held.box=heldBookBox(n.attributes.rigFrame);held.plane=n.plane;}
  }
  for (const n of nodes) {
    n.z = n.structural ? -1000 + ['sky', 'wall', 'ground', 'floor'].indexOf(n.motif)
      : Math.round((PLANES.indexOf(n.plane) * 1000 + 100 + bottom(n.box) / H * 400) * 10) / 10;
    if (n.anchor === 'horizon') n.z = Math.min(n.z, 1000 + 150);
  }
  // Something resting on/inside a parent paints right after it, not in front of everything nearer than the parent
  // (a boat on the sea stays behind the trees on the shore).
  for (const n of nodes) {
    const parent = n.parent ? nodes.find((m) => m.id === n.parent) : null;
    if (parent) n.z = Math.round((parent.z + 1 + n.instance * 0.01) * 100) / 100;
  }
  for (const n of nodes) {
    if (!n.behind) continue;
    const t = nodes.find((m) => m.id === n.behind);
    if (t && n.z >= t.z) n.z = t.z - 1;
  }
  nodes.sort((a, b) => a.z - b.z);

  const graph = { version: 1, canvas: { width: W, height: H }, indoor, viewpoint, horizonY: r1(horizonY), floorY: r1(floorY), shoreY: hasSea ? r1(shoreY) : null, margin, nodes, relations: solved };
  graph.check = checkSceneGraph(graph, understanding);
  return graph;
}

/** Geometric truth of each relation on the current boxes. */
function relationHolds(rel, graph) {
  const find = (ref) => {
    const [entityId, instance] = String(ref).split('#');
    const list = graph.nodes.filter((n) => n.entity === entityId && !n.structural);
    return instance ? list.filter((n) => n.instance === Number(instance)) : list;
  };
  const subjects = find(rel.subject);
  const t = find(rel.object)[0];
  if (!subjects.length || !t) return false;
  const tol = Math.min(graph.canvas.width, graph.canvas.height) * 0.03;
  return subjects.every((s) => {
    const a = s.box; const b = t.box;
    switch (rel.relation) {
      case 'held': return cx(a) >= b.x-tol && cx(a) <= b.x+b.w+tol && a.y >= b.y+b.h*0.25 && bottom(a) <= bottom(b)+tol;
      case 'on': {
        // A large surface seen from above (a desk filling the frame): resting on it = lying inside it.
        if (s.motif === 'person' && t.motif === 'armchair' && s.attributes.pose === 'seated') return overlap(a,b)>0 && Math.abs(bottom(a)-bottom(b))<=Math.max(tol*3,b.h*0.35);
        if (t.motif === 'road') return a.x >= b.x - tol && a.x + a.w <= b.x + b.w + tol && a.y >= b.y - tol && bottom(a) <= bottom(b) + tol;
        const big = b.w * b.h >= graph.canvas.width * graph.canvas.height * 0.35;
        if (big && a.x >= b.x - tol && a.x + a.w <= b.x + b.w + tol && a.y >= b.y - tol && bottom(a) <= bottom(b) + tol) return true;
        return a.x + a.w > b.x && a.x < b.x + b.w && Math.abs(bottom(a) - b.y) <= Math.max(tol, a.h * 0.35) + (t.category === 'water' ? b.h : 0);
      }
      case 'above': return bottom(a) <= b.y + tol && cx(a) > b.x - tol && cx(a) < b.x + b.w + tol;
      case 'below': return bottom(a) >= bottom(b) - tol && cx(a) > b.x && cx(a) < b.x + b.w;
      // Different supports (a chair on the floor beside a window on the wall): only the horizontal side counts.
      case 'beside': return (s.anchor !== t.anchor || Math.abs(bottom(a) - bottom(b)) <= tol * 3) && (a.x >= b.x + b.w - tol || a.x + a.w <= b.x + tol);
      case 'left': return a.x + a.w <= b.x + tol;
      case 'right': return a.x >= b.x + b.w - tol;
      case 'behind': return s.z < t.z || s.behind === t.id;
      case 'front': return s.z > t.z;
      case 'inside': return a.x >= b.x - tol && a.y >= b.y - tol && a.x + a.w <= b.x + b.w + tol && bottom(a) <= bottom(b) + tol;
      case 'between': {
        const c = find(rel.object2)[0];
        if (!c) return false;
        const lo = Math.min(cx(b), cx(c.box)); const hi = Math.max(cx(b), cx(c.box));
        return cx(a) > lo && cx(a) < hi;
      }
      default: return true;
    }
  });
}

function checkSceneGraph(graph, understanding) {
  const issues = [];
  const W = graph.canvas.width; const H = graph.canvas.height;
  const counts = {};
  for (const n of graph.nodes) if (n.entity) counts[n.entity] = (counts[n.entity] || 0) + 1;
  for (const e of understanding.entities) {
    const want = Math.min(e.count, 12);
    if ((counts[e.id] || 0) !== want) issues.push({ code: 'COUNT_MISMATCH', entity: e.id, requested: e.count, nodes: counts[e.id] || 0 });
    if (e.count > 12) issues.push({ code: 'COUNT_CAPPED', entity: e.id, requested: e.count, nodes: 12 });
  }
  for (const n of graph.nodes) {
    const b = n.box;
    if (b.x < -1 || b.y < -1 || b.x + b.w > W + 1 || b.y + b.h > H + 1) issues.push({ code: 'OUT_OF_CANVAS', node: n.id });
    if (!n.drawable) issues.push({ code: 'NO_MOTIF', node: n.id, note: 'no drawing motif exists for this element; it will be reported as missing, not faked' });
  }
  const solid = graph.nodes.filter((n) => !n.structural && n.box.w < W * 0.9 && !['sky', 'room'].includes(n.category) && n.category !== 'terrain' && n.category !== 'water');
  for (let i = 0; i < solid.length; i += 1) {
    for (let k = i + 1; k < solid.length; k += 1) {
      const a = solid[i]; const b = solid[k];
      if (a.plane !== b.plane || a.parent === b.id || b.parent === a.id || a.anchor === 'surface' || b.anchor === 'surface') continue;
      const related = (graph.relations || []).some((r) => [r.subject, r.object].includes(a.entity) && [r.subject, r.object].includes(b.entity) && ['behind', 'front', 'inside', 'on'].includes(r.relation));
      const ratio = overlap(a.box, b.box) / Math.max(1, Math.min(a.box.w * a.box.h, b.box.w * b.box.h));
      if (!related && ratio > 0.3) issues.push({ code: 'OVERLAP', nodes: [a.id, b.id], ratio: Number(ratio.toFixed(2)) });
    }
  }
  const relations = (graph.relations || []).map((r) => ({ subject: r.subject, relation: r.relation, object: r.object, object2: r.object2, holds: r.applied ? relationHolds(r, graph) : false }));
  for (const r of relations) if (!r.holds) issues.push({ code: 'RELATION_NOT_SATISFIED', relation: `${r.subject} ${r.relation} ${r.object}` });
  return { ok: !issues.some((i) => ['COUNT_MISMATCH', 'OUT_OF_CANVAS', 'RELATION_NOT_SATISFIED'].includes(i.code)), issues, relations };
}

/** Compact view for plan responses (no full boxes for structural nodes). */
function summarizeGraph(graph) {
  return {
    indoor: graph.indoor,
    viewpoint: graph.viewpoint,
    horizonY: graph.horizonY,
    nodes: graph.nodes.filter((n) => !n.structural).map((n) => ({ id: n.id, plane: n.plane, box: [n.box.x, n.box.y, n.box.w, n.box.h].map(Math.round), z: Math.round(n.z), drawable: n.drawable })),
    relations: graph.check.relations,
    issues: graph.check.issues.slice(0, 8),
  };
}

module.exports = { buildSceneGraph, checkSceneGraph, relationHolds, summarizeGraph, PRIORS, PLANES, motifOf };
