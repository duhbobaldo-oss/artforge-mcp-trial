'use strict';

/**
 * Hybrid composition: the existing composer's rich rendering, placed by the scene graph.
 *
 * 1. The composer draws the picture as before (room perspective, curtains, sky, sea, figures…).
 * 2. The box of every element it drew is measured from its operations and seeds the scene graph,
 *    whose horizon/floor line follow the composer's environment.
 * 3. The graph solves the requested counts and relations from those real positions.
 * 4. Composer elements the graph moved are translated (and scaled when resized) as a whole, together with the
 *    contact shadows and light pools that belong to them; elements the composer cannot draw, or drew as one
 *    bundle when several separate instances are needed, are drawn by the SceneSpec renderers and inserted into
 *    the composer's layers at their depth. Negated elements the composer added on its own are removed.
 * The result keeps the composer's detail wherever it exists and the graph's guarantees everywhere.
 */

const { buildSceneGraph } = require('./scene-graph');
const { directArt } = require('./art-direction');
const { compileSceneSpec } = require('./scenespec-engine');
const { motifOf } = require('./motifs');

const DECOR = /shadow|glow|halo|pool|light|reflect|ambien|vignette|haze/i;
const ATTACHABLE = new Set(['shadows', 'lighting', 'contact']);

/** Geometry box of one drawing operation (null for non-geometric ops). */
function opBox(op) {
  const p = op.params || {};
  if (Number.isFinite(p.x) && Number.isFinite(p.w) && Number.isFinite(p.y) && Number.isFinite(p.h)) return { x: p.x, y: p.y, w: p.w, h: p.h };
  const pts = Array.isArray(p.points) ? p.points : (Array.isArray(p.segments) ? p.segments : null);
  if (pts && pts.length) {
    const xs = pts.map((q) => q.x).filter(Number.isFinite); const ys = pts.map((q) => q.y).filter(Number.isFinite);
    if (!xs.length) return null;
    const pad = Number(p.brush && p.brush.size) / 2 || Number(p.strokeWidth) / 2 || 0;
    return { x: Math.min(...xs) - pad, y: Math.min(...ys) - pad, w: Math.max(...xs) - Math.min(...xs) + pad * 2, h: Math.max(...ys) - Math.min(...ys) + pad * 2 };
  }
  if (Number.isFinite(p.x1)) return { x: Math.min(p.x1, p.x2), y: Math.min(p.y1, p.y2), w: Math.abs(p.x2 - p.x1), h: Math.abs(p.y2 - p.y1) };
  if (Number.isFinite(p.x) && Number.isFinite(p.y)) return { x: p.x, y: p.y, w: 1, h: 1 };
  return null;
}

function union(boxes) {
  const b = boxes.filter(Boolean);
  if (!b.length) return null;
  const x = Math.min(...b.map((q) => q.x)); const y = Math.min(...b.map((q) => q.y));
  return { x, y, w: Math.max(...b.map((q) => q.x + q.w)) - x, h: Math.max(...b.map((q) => q.y + q.h)) - y };
}

/** Body box per element: decorative and canvas-wide operations do not define where an object is. */
function elementBoxes(ops, canvas) {
  const out = {};
  for (const op of ops) {
    if (!op.element || DECOR.test(op.note || '')) continue;
    const b = opBox(op);
    if (!b || (b.w >= canvas.width * 0.98 && b.h >= canvas.height * 0.98)) continue; // whole-canvas washes
    (out[op.element] = out[op.element] || []).push(b);
  }
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, union(v)]));
}

/** Move + uniformly scale a whole operation around an anchor (bottom-centre of the old box). */
function transformParams(params, from, to) {
  const s = from.h > 0 ? to.h / from.h : 1;
  const ax = from.x + from.w / 2; const ay = from.y + from.h;
  const bx = to.x + to.w / 2; const by = to.y + to.h;
  const X = (x) => Math.round((bx + (x - ax) * s) * 100) / 100;
  const Y = (y) => Math.round((by + (y - ay) * s) * 100) / 100;
  const L = (v) => (Number.isFinite(v) ? Math.round(v * s * 100) / 100 : v);
  const p = JSON.parse(JSON.stringify(params));
  if (Number.isFinite(p.x)) p.x = X(p.x);
  if (Number.isFinite(p.y)) p.y = Y(p.y);
  if (Number.isFinite(p.w)) p.w = L(p.w);
  if (Number.isFinite(p.h)) p.h = L(p.h);
  if (Number.isFinite(p.x1)) { p.x1 = X(p.x1); p.x2 = X(p.x2); p.y1 = Y(p.y1); p.y2 = Y(p.y2); }
  if (Array.isArray(p.points)) p.points = p.points.map((q) => Object.assign({}, q, { x: X(q.x), y: Y(q.y) }));
  const seg = (q) => { const c = Object.assign({}, q); ['x', 'cx', 'c1x', 'c2x'].forEach((k) => { if (Number.isFinite(c[k])) c[k] = X(c[k]); }); ['y', 'cy', 'c1y', 'c2y'].forEach((k) => { if (Number.isFinite(c[k])) c[k] = Y(c[k]); }); return c; };
  if (Array.isArray(p.segments)) p.segments = p.segments.map(seg);
  if (s !== 1) {
    for (const k of ['strokeWidth', 'blur', 'maxWidth']) p[k] = L(p[k]);
    if (Array.isArray(p.radius)) p.radius = p.radius.map(L); else p.radius = L(p.radius);
    if (p.brush && Number.isFinite(p.brush.size)) p.brush.size = L(p.brush.size);
    if (p.shadow) { p.shadow.blur = L(p.shadow.blur); p.shadow.offsetX = L(p.shadow.offsetX); p.shadow.offsetY = L(p.shadow.offsetY); }
    if (p.font && Number.isFinite(p.font.size)) p.font.size = L(p.font.size);
    if (Array.isArray(p.dash)) p.dash = p.dash.map(L);
    Object.keys(p).forEach((k) => { if (p[k] === undefined) delete p[k]; });
  }
  if (p.clip) {
    if (Array.isArray(p.clip.segments)) p.clip.segments = p.clip.segments.map(seg);
    if (Number.isFinite(p.clip.x)) { p.clip.x = X(p.clip.x); p.clip.y = Y(p.clip.y); p.clip.w = L(p.clip.w); p.clip.h = L(p.clip.h); }
  }
  return p;
}

/** Recolour toward a requested colour: hue and saturation from the request, lightness (the shading) kept. */
function recolorParams(params, hex) {
  const { hsl, fromHsl } = require('./color');
  const target = hsl(hex);
  const shift = (c) => {
    if (typeof c !== 'string') return c;
    let r; let g; let b; let a = null;
    const h = /^#([0-9a-f]{6})$/i.exec(c);
    const m = /^rgba?\(([^)]+)\)$/i.exec(c);
    if (h) { r = parseInt(h[1].slice(0, 2), 16); g = parseInt(h[1].slice(2, 4), 16); b = parseInt(h[1].slice(4, 6), 16); }
    else if (m) { const p = m[1].split(',').map((v) => Number(v)); [r, g, b] = p; a = p.length > 3 ? p[3] : null; }
    else return c;
    const to2 = (v) => Math.round(v).toString(16).padStart(2, '0');
    const src = hsl(`#${to2(r)}${to2(g)}${to2(b)}`);
    // Near-black/near-white details (outlines, highlights) keep their neutral value.
    if (src.l < 0.08 || src.l > 0.94) return c;
    const out = fromHsl(target.h, Math.min(1, target.s * 0.85 + src.s * 0.15), src.l * 0.6 + target.l * 0.4);
    if (a === null) return out;
    const o = require('./color').parse(out);
    return `rgba(${o.r},${o.g},${o.b},${a})`;
  };
  const p = JSON.parse(JSON.stringify(params));
  const paint = (v) => (v && typeof v === 'object' && Array.isArray(v.stops) ? Object.assign(v, { stops: v.stops.map((st) => Object.assign({}, st, { color: shift(st.color) })) }) : (v && typeof v === 'object' && v.color ? Object.assign(v, { color: shift(v.color), background: shift(v.background) }) : shift(v)));
  if (p.fill !== undefined) p.fill = paint(p.fill);
  if (p.stroke !== undefined) p.stroke = paint(p.stroke);
  if (p.color !== undefined) p.color = shift(p.color);
  if (Array.isArray(p.colors)) p.colors = p.colors.map(shift);
  if (Array.isArray(p.stops)) p.stops = p.stops.map((st) => Object.assign({}, st, { color: shift(st.color) }));
  return p;
}

const PLANE_LAYERS = {
  sky: ['sky', 'background', 'room'],
  background: ['far', 'background', 'room', 'surface', 'furniture'],
  midground: ['mid', 'furniture', 'objects', 'background', 'figure'],
  foreground: ['near', 'figure', 'objects', 'furniture', 'background'],
};

function composeHybrid(context) {
  const { result, understanding, canvas, rules, roles, references, refsOn, seed, overrides, noText } = context;
  const ops = result.ops.slice();
  const meta = result.meta || {};
  const boxes = elementBoxes(ops, canvas);
  const excluded = new Set(understanding.constraints.excluded || []);

  // Environment lines from the composer.
  const persp = meta.perspective || {};
  const horizonY = Number.isFinite(meta.horizon) ? meta.horizon : (Number.isFinite(persp.horizonY) ? persp.horizonY : (Number.isFinite(persp.eyeLevel) ? persp.eyeLevel : undefined));
  const seeds = {};
  for (const e of understanding.entities) {
    const ids = e.count > 1 ? Array.from({ length: Math.min(e.count, 12) }, (_, i) => `${e.motif}_${i + 1}`) : [e.motif];
    for (const id of ids) if (boxes[id] && !(overrides && overrides.perspective==='three-point' && ['building','tower','house'].includes(e.motif))) seeds[id] = boxes[id];
  }
  // A bundle (one composer element standing for several objects) seeds nothing: it cannot satisfy a count.
  let graph = buildSceneGraph(understanding, canvas, { seed: seeds, horizonY });
  // A composer element that cannot satisfy its relation and is far wider than one object (two wings drawn as one
  // "building") is a bundle: it is redrawn as a single instance by the engine, the rest of the composer is kept.
  const { PRIORS, relationHolds } = require('./scene-graph');
  const bundles = [];
  for (const r of (graph.relations || []).filter((x) => x.applied && !relationHolds(x, graph))) {
    for (const n of graph.nodes.filter((m) => m.seeded && m.entity === r.subject)) {
      const prior = PRIORS[n.motif];
      if (prior && !['terrain', 'water'].includes(n.category) && n.seedBox.w > prior.w * canvas.width * 1.8) bundles.push(n.id);
    }
  }
  if (bundles.length) {
    for (const id of bundles) delete seeds[id];
    graph = buildSceneGraph(understanding, canvas, { seed: seeds, horizonY });
  }
  const art = directArt({ understanding, graph, references, rules, roles, overrides, keepLayout: true });

  const layerOf = {};
  const layers = ops.filter((o) => o.op === 'layer.add' && o.alias).map((o) => o.alias);
  const layersOf = {};
  for (const op of ops) {
    if (!op.element || !op.params || !op.params.layer) continue;
    if (!layerOf[op.element]) layerOf[op.element] = op.params.layer;
    const list = layersOf[op.element] || (layersOf[op.element] = []);
    if (!list.includes(op.params.layer)) list.push(op.params.layer);
  }

  // Composer elements to remove: negated ones, and bundles replaced by separate instances.
  const remove = new Set(bundles);
  for(const e of understanding.entities) if(e.attributes.rigPose || e.attributes.phase==='crescent' || (overrides && overrides.perspective==='three-point' && ['building','tower','house'].includes(e.motif))) remove.add(e.motif);
  for (const id of Object.keys(boxes)) if (excluded.has(motifOf(id))) remove.add(id);
  const engineNodes = new Set();
  for (const n of graph.nodes) {
    if (n.structural || !n.drawable) continue;
    if (n.attributes && (n.attributes.rigPose || n.attributes.phase==='crescent')) {n.seeded=false;engineNodes.add(n.id);continue;}
    if (n.seeded) continue;
    engineNodes.add(n.id);
    // The composer drew this motif under one id (e.g. "trees") but the request needs separate instances.
    const bundle = n.id !== n.motif && boxes[n.motif] ? n.motif : null;
    if (bundle) remove.add(bundle);
  }
  // A shore is needed when objects stand by a sea the composer filled to the bottom.
  if (graph.shoreY && graph.nodes.some((n) => n.motif === 'ground')) engineNodes.add('ground');

  // Only a relation subject is ever moved; everything else keeps exactly what the composer drew
  // (the graph may have clamped a wide sea or garden box, which must not move or rescale it).
  const subjects = new Set((graph.relations || []).filter((r) => r.applied).map((r) => r.subject));
  const immovable = (n) => ['terrain', 'water'].includes(n.category) || n.seedBox.w >= canvas.width * 0.9;
  for (const n of graph.nodes) if (n.seeded && (!subjects.has(n.entity) || immovable(n))) n.box = Object.assign({}, n.seedBox);
  const moved = graph.nodes.filter((n) => n.seeded && subjects.has(n.entity) && !immovable(n) && (Math.abs(n.box.x - n.seedBox.x) > 0.5 || Math.abs(n.box.y - n.seedBox.y) > 0.5 || Math.abs(n.box.h - n.seedBox.h) > 0.5));
  graph.check = require('./scene-graph').checkSceneGraph(graph, understanding);
  const attach = (op) => {
    if (!ATTACHABLE.has(op.element)) return null;
    const b = opBox(op);
    if (!b) return null;
    // Whole-canvas fields belong to the scene, never to a removed figure.
    if(b.w>=canvas.width*.98&&b.h>=canvas.height*.98)return null;
    const c = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
    const near = (n) => { const s = n.seedBox; return c.x >= s.x - s.w * 0.25 && c.x <= s.x + s.w * 1.25 && c.y >= s.y - s.h * 0.25 && c.y <= s.y + s.h * 1.35; };
    const owner = moved.find(near);
    if (owner) return owner;
    // A shadow under a removed bundle goes with it.
    const gone = [...remove].map((id) => boxes[id]).filter(Boolean).some((s) => c.x >= s.x - s.w * 0.25 && c.x <= s.x + s.w * 1.25 && c.y >= s.y - s.h * 0.25 && c.y <= s.y + s.h * 1.35);
    return gone ? { removedShadow: true } : null;
  };
  const recolor = Object.fromEntries(graph.nodes.filter((n) => n.seeded && n.attributes && n.attributes.color).map((n) => [n.id, n.attributes.color]));
  const out = [];
  for (const op of ops) {
    if (op.element && remove.has(op.element)) continue;
    if (op.element === 'sea' && graph.shoreY) {
      const b = opBox(op);
      if (b && b.y > graph.shoreY) continue; // sea highlights below the new shoreline
    }
    const owner = (op.element && moved.find((n) => n.id === op.element)) || attach(op);
    if (owner && owner.removedShadow) continue;
    // An attached shadow/light pool keeps its own tag but names its owner, so the pixel check removes them together.
    let next = owner ? Object.assign({}, op, { owner: op.element !== owner.id ? owner.id : undefined, params: transformParams(op.params, owner.seedBox, owner.box), note: `${op.note || op.op} (placed by the scene graph)` }) : op;
    // A colour the user asked for ("كنبة زرقاء", "a red armchair") is applied to the composer's drawing of it.
    const want = op.element && recolor[op.element];
    if (want && !DECOR.test(op.note || '')) next = Object.assign({}, next, { params: recolorParams(next.params, want), note: `${next.note || op.op} (requested colour ${want})` });
    out.push(next);
  }

  // Scale: an engine-drawn object takes the composer's scale, read from the composer object it is related to
  // (a tree beside the character composer's large figure is sized like the figure, not like the canvas).
  {
    const { PRIORS: P } = require('./scene-graph');
    const before = graph.nodes.map((n) => Object.assign({}, n.box));
    const H = canvas.height;
    for (const n of graph.nodes.filter((x) => engineNodes.has(x.id) && !x.structural && P[x.motif] && !['terrain', 'water', 'sky'].includes(x.category))) {
      const rels = (graph.relations || []).filter((r) => [r.subject, String(r.object).split('#')[0], String(r.object2 || '').split('#')[0]].includes(n.entity));
      const anchor = rels.map((r) => [r.subject, String(r.object).split('#')[0]].find((e) => e !== n.entity)).map((e) => graph.nodes.find((m) => m.entity === e && m.seeded && P[m.motif] && !['terrain', 'water', 'sky'].includes(m.category))).find(Boolean);
      if (!anchor || n.attributes.rigFrame || graph.nodes.some(p=>p.id===n.parent&&p.attributes.rigFrame)) continue;
      // Scale from both dimensions and keep the smaller: a composer "sofa" drawn tall like an armchair must not
      // inflate the coffee table in front of it.
      const W = canvas.width;
      const kh = anchor.box.h / (P[anchor.motif].h * H) / (n.box.h / (P[n.motif].h * H));
      const kw = anchor.box.w / (P[anchor.motif].w * W) / (n.box.w / (P[n.motif].w * W));
      const k = Math.max(0.7, Math.min(2.2, kh, kw));
      if (Math.abs(k - 1) < 0.08) continue;
      const cx = n.box.x + n.box.w / 2; const bottom = n.box.y + n.box.h;
      n.box.w *= k; n.box.h *= k; n.box.x = Math.max(0, Math.min(canvas.width - n.box.w, cx - n.box.w / 2)); n.box.y = Math.max(0, bottom - n.box.h);
    }
    // Keep the new scale only if every relation still holds.
    if (!require('./scene-graph').checkSceneGraph(graph, understanding).relations.every((r) => r.holds)) graph.nodes.forEach((n, i) => { n.box = before[i]; });
    graph.check = require('./scene-graph').checkSceneGraph(graph, understanding);
  }

  // Engine-drawn nodes, inserted into the composer's layers at their depth.
  const compiled = compileSceneSpec(graph, art, { roles, useReferences: refsOn, seed, understanding, noText, only: engineNodes });
  const byNode = {};
  for (const op of compiled.spec.operations) (byNode[op.element] = byNode[op.element] || []).push(op);
  const rel = (n) => (graph.relations || []).find((r) => r.subject === n.entity);
  const pickLayer = (n) => {
    const window=n.parent&&graph.nodes.find(p=>p.id===n.parent&&p.motif==='window');
    if(window&&n.motif==='moon'&&layersOf[window.id])return layersOf[window.id].slice().sort((a,b)=>layers.indexOf(a)-layers.indexOf(b)).at(-1);
    const holder=n.parent&&graph.nodes.find(p=>p.id===n.parent&&p.attributes.rigFrame);
    if(holder&&n.motif==='book')return pickLayer(holder);
    const r = rel(n);
    const target = r && graph.nodes.find((m) => m.entity === String(r.object).split('#')[0] && m.seeded);
    // In front of / on something: above every layer the target paints in (a sofa's front cushions live on a
    // higher layer than its body). Behind: its first layer, before it.
    if (target && layersOf[target.id]) {
      const own = layersOf[target.id].slice().sort((a, b) => layers.indexOf(a) - layers.indexOf(b));
      return ['front', 'on', 'above'].includes(r.relation) ? own[own.length - 1] : own[0];
    }
    if (n.motif === 'ground') return layerOf.sea || (PLANE_LAYERS.midground.find((l) => layers.includes(l)));
    return (PLANE_LAYERS[n.plane] || PLANE_LAYERS.midground).find((l) => layers.includes(l)) || layers[layers.length - 1];
  };
  // Only solid objects count as "nearer" when choosing where to insert; a sea or a sand band that spans the
  // picture is environment and must stay underneath (inserting before it hid the trees under the sea).
  const zOf = new Map(graph.nodes.filter((n) => !n.structural && !['terrain', 'water'].includes(n.category) && n.box.w < canvas.width * 0.9).map((n) => [n.id, n.z]));
  const order = graph.nodes.filter((n) => byNode[n.id]).sort((a, b) => a.z - b.z);
  if (byNode.ground) order.unshift({ id: 'ground', motif: 'ground', plane: 'midground', z: -1 });
  for (const n of order) {
    const layer = pickLayer(n);
    const converted = byNode[n.id].map((op) => ({ op: op.op, element: op.element, note: `${op.note} (scene-graph engine)`, params: Object.assign({}, op.params, { layer }) }));
    let at = -1;
    if (n.motif === 'ground') {
      for (let i = out.length - 1; i >= 0; i -= 1) if (out[i].element === 'sea' && out[i].params && out[i].params.layer === layer) { at = i + 1; break; }
    } else {
      // Before the first op in this layer that belongs to something nearer; else after the layer's last op.
      at = out.findIndex((o) => o.params && o.params.layer === layer && o.element && zOf.has(o.element) && zOf.get(o.element) > n.z);
      if (at < 0) { for (let i = out.length - 1; i >= 0; i -= 1) if (out[i].params && out[i].params.layer === layer) { at = i + 1; break; } }
    }
    if (at < 0) at = out.length;
    out.splice(at, 0, ...converted);
  }

  // Hybrid layer remapping must preserve body -> book -> gripping fingers.
  for(const held of graph.nodes.filter(n=>n.motif==='book'&&n.parent)){
    const holder=graph.nodes.find(n=>n.id===held.parent&&n.attributes.rigFrame);if(!holder)continue;
    const fingers=out.filter(o=>o.element===holder.id&&/in front of held object/.test(o.note||''));
    for(const o of fingers)out.splice(out.indexOf(o),1);
    let index=-1;for(let i=0;i<out.length;i++)if(out[i].element===held.id)index=i;
    if(index>=0)out.splice(index+1,0,...fingers);else out.push(...fingers);
  }
  // Coverage from the final operations, per understood entity and instance.
  const drawn = new Set(out.filter((o) => o.element).map((o) => o.element));
  const coverage = understanding.entities.map((e) => {
    // A requested sky is a structural node; it counts when drawn.
    const instances = graph.nodes.filter((n) => n.entity === e.id && (!n.structural || n.motif === e.motif)).map((n) => n.id).filter((id) => drawn.has(id));
    const requestedCount = Math.min(e.count, 12);
    return { element: e.id, motif: e.motif, requested: true, requestedCount, drawnCount: instances.length, instances, declared: instances.length >= requestedCount ? instances : graph.nodes.filter((n) => n.entity === e.id).map((n) => n.id), drawn: instances.length >= requestedCount, ops: out.filter((o) => instances.includes(o.element)).length, supported: graph.nodes.some((n) => n.entity === e.id && n.drawable) };
  });
  const missing = [...new Set(coverage.filter((c) => !c.drawn).map((c) => c.motif))];
  const sources = Object.fromEntries(graph.nodes.filter((n) => !n.structural && n.drawable).map((n) => [n.id, (n.seeded ? (moved.includes(n) ? 'composer-moved' : 'composer') : 'engine') + (n.seeded && recolor[n.id] ? '+recolored' : '')]));
  return {
    ops: out, graph, art, coverage, missing, sources, removed: [...remove],
    limits: missing.length ? [`These requested elements were NOT drawn: ${missing.join(', ')}.`] : [],
  };
}

module.exports = { composeHybrid, elementBoxes, transformParams, recolorParams, opBox };
