'use strict';

/**
 * Visual review and correction (stage ⑨): measures the drawn document, corrects real objects, re-measures.
 *
 * Measurements come from the drawing engine after rendering (object.list boxes of the objects each element
 * produced), not from the plan: completeness, counts, the requested relations, visual balance, focal placement,
 * proportions between related elements and edge margins. Correctable defects are fixed with object.transform on
 * every object of the element (and of elements resting on it), at most `maxRounds` times, re-measuring after each.
 * Shadows, halos and glows are excluded from body boxes so they never distort a measurement.
 */

const { relationHolds } = require('./scene-graph');

const DECOR = /shadow|halo|glow|reflected|ripple/i;
const PLANE_WEIGHT = { sky: 0, background: 0.6, midground: 1, foreground: 1.2 };

function overlapArea(a, b) {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

function union(boxes) {
  if (!boxes.length) return null;
  const x1 = Math.min(...boxes.map((b) => b.x)); const y1 = Math.min(...boxes.map((b) => b.y));
  const x2 = Math.max(...boxes.map((b) => b.x + b.w)); const y2 = Math.max(...boxes.map((b) => b.y + b.h));
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

/** element → { all objectIds, body boxes } from executed steps + object.list. */
function measure(graph, steps, objects) {
  const boxOf = new Map(objects.filter((o) => o.box).map((o) => [o.id, o]));
  const out = {};
  // Every painted object with its paint rank, owner element and whether it is an opaque body (not a glow/shadow wash).
  const metaOf = new Map();
  for (const s of steps) for (const id of (s.objectId ? [s.objectId] : (s.objectIds || []))) metaOf.set(id, { element: s.element || null, note: s.note || '' });
  const W = graph.canvas.width; const H = graph.canvas.height;
  out.__painted = objects.filter((o) => o.box && o.visible !== false).map((o) => {
    const meta = metaOf.get(o.id) || { element: null, note: '' };
    const wash = o.box.w >= W * 0.95 && o.box.h >= H * 0.95;
    const decor = wash || DECOR.test(meta.note) || ['lighting', 'shadows', 'contact'].includes(meta.element) || Number(o.opacity) < 0.5;
    return { id: o.id, element: meta.element, rank: Number(o.layerIndex) * 100000 + Number(o.index), box: o.box, decor };
  });
  for (const n of graph.nodes) {
    if (n.id === '__painted') continue;
    const mine = steps.filter((s) => s.element === n.id);
    const ids = mine.flatMap((s) => (s.objectId ? [s.objectId] : (s.objectIds || [])));
    const body = mine.filter((s) => !DECOR.test(s.note || '')).flatMap((s) => (s.objectId ? [s.objectId] : (s.objectIds || [])));
    const present = ids.filter((id) => boxOf.has(id));
    const visible = present.filter((id) => boxOf.get(id).visible !== false && boxOf.get(id).opacity !== 0);
    // Paint order as the engine reports it (layer, then index): what is really drawn over what.
    const ranks = body.filter((id) => boxOf.has(id)).map((id) => { const o = boxOf.get(id); return Number(o.layerIndex) * 100000 + Number(o.index); }).filter(Number.isFinite);
    // Pixel group = the element plus what it owns (its moved light pool, its contact shadow).
    const groupIds = ids.concat(steps.filter((s) => s.owner === n.id).flatMap((s) => (s.objectId ? [s.objectId] : (s.objectIds || []))));
    out[n.id] = { ids, groupIds, present: present.length, visible: visible.length, box: union(body.filter((id) => boxOf.has(id)).map((id) => boxOf.get(id).box)), rank: ranks.length ? { min: Math.min(...ranks), max: Math.max(...ranks) } : null };
  }
  return out;
}

function evaluate(graph, art, m, understanding) {
  const W = graph.canvas.width; const H = graph.canvas.height;
  const issues = [];
  // Measured graph: same nodes, boxes from the document.
  const measured = Object.assign({}, graph, { nodes: graph.nodes.map((n) => Object.assign({}, n, { box: (m[n.id] && m[n.id].box) || n.box })) });
  const drawable = graph.nodes.filter((n) => n.drawable && !n.structural);
  for (const n of drawable) {
    const e = m[n.id];
    if (!e || !e.ids.length || e.present < e.ids.length) issues.push({ code: 'ELEMENT_MISSING', node: n.id, fix: false });
    else if (!e.visible) issues.push({ code: 'ELEMENT_INVISIBLE', node: n.id, fix: false });
    else if (e.box && (e.box.x > W || e.box.y > H || e.box.x + e.box.w < 0 || e.box.y + e.box.h < 0)) issues.push({ code: 'ELEMENT_OFF_CANVAS', node: n.id, fix: true });
  }
  for (const ent of (understanding && understanding.entities) || []) {
    const confirmed = drawable.filter((n) => n.entity === ent.id && m[n.id] && m[n.id].visible).length;
    if (drawable.some((n) => n.entity === ent.id) && confirmed < Math.min(ent.count, 12)) issues.push({ code: 'COUNT_SHORT', entity: ent.id, requested: ent.count, confirmed, fix: false });
  }
  const relations = (graph.relations || []).filter((r) => r.applied).map((r) => ({ rel: r, holds: relationHolds(r, measured) }));
  for (const x of relations) if (!x.holds) issues.push({ code: 'RELATION_BROKEN', relation: `${x.rel.subject} ${x.rel.relation} ${x.rel.object}`, rel: x.rel, fix: true });

  // Balance: centre of visual weight (area × plane weight) of free-standing, non-full-width bodies.
  const weighted = measured.nodes.filter((n) => n.drawable && !n.structural && n.box.w < W * 0.9 && n.anchor !== 'surface' && PLANE_WEIGHT[n.plane]);
  const total = weighted.reduce((s, n) => s + n.box.w * n.box.h * PLANE_WEIGHT[n.plane], 0);
  const centroid = total ? weighted.reduce((s, n) => s + (n.box.x + n.box.w / 2) * n.box.w * n.box.h * PLANE_WEIGHT[n.plane], 0) / total : W / 2;
  const balanceOffset = Number((Math.abs(centroid - W / 2) / W).toFixed(3));
  // A deliberate thirds composition is off-centre by design; balance is only judged beyond what the grid implies.
  const balanceLimit = art.composition.grid === 'thirds' ? 0.22 : 0.12;
  if (weighted.length >= 2 && balanceOffset > balanceLimit) issues.push({ code: 'UNBALANCED', offset: balanceOffset, side: centroid > W / 2 ? 'right' : 'left', fix: true });

  const focal = art.composition.focal ? measured.nodes.find((n) => n.id === art.composition.focal) : null;
  let focalDistance = null;
  if (focal && art.composition.target) {
    const d = Math.hypot(focal.box.x + focal.box.w / 2 - art.composition.target.x, focal.box.y + focal.box.h / 2 - art.composition.target.y);
    focalDistance = Number((d / Math.hypot(W, H)).toFixed(3));
    if (focalDistance > 0.08 && !art.composition.note) issues.push({ code: 'FOCAL_OFF_TARGET', distance: focalDistance, fix: true });
  }
  // Occlusion against EVERYTHING painted after the element (environment included: a sea or sand band painted over
  // trees hides them), sampled on a 12×12 grid of the element body. Glows, shadows and washes do not hide.
  const related = (n) => new Set(graph.nodes.filter((o) => o.parent === n.id || n.parent === o.id).map((o) => o.id).concat([n.id]));
  const occluders = (n) => {
    const own = related(n);
    const r = m[n.id] && m[n.id].rank;
    if (!r || !m.__painted) return measured.nodes.filter((o) => !own.has(o.id) && o.drawable && !o.structural && o.z > n.z && o.box.w < W * 0.9).map((o) => ({ box: o.box, element: o.id }));
    return m.__painted.filter((p) => !p.decor && p.rank > r.max && !own.has(p.element));
  };
  const coverOf = (n, box) => {
    const occ = occluders(n).filter((o) => overlapArea(box, o.box) > 0);
    if (!occ.length) return 0;
    let hit = 0;
    for (let i = 0; i < 12; i += 1) for (let k = 0; k < 12; k += 1) {
      const x = box.x + ((i + 0.5) / 12) * box.w; const y = box.y + ((k + 0.5) / 12) * box.h;
      if (occ.some((o) => x >= o.box.x && x <= o.box.x + o.box.w && y >= o.box.y && y <= o.box.y + o.box.h)) hit += 1;
    }
    return hit / 144;
  };
  for (const n of measured.nodes.filter((x) => x.drawable && !x.structural && x.box.w < W * 0.9)) {
    const area = n.box.w * n.box.h;
    if (!area) continue;
    const hidden = coverOf(n, n.box);
    const behindRel = (graph.relations || []).some((r) => r.subject === n.entity && ['behind', 'inside', 'below'].includes(r.relation));
    if (hidden > (behindRel ? 0.7 : 0.3)) issues.push({ code: 'OCCLUDED', node: n.id, hidden: Number(hidden.toFixed(2)), behind: behindRel, fix: true });
  }
  // Proportions: related pairs keep the size ratio of their priors (×0.5 – ×2).
  const proportions = [];
  for (const x of relations) {
    const a = measured.nodes.find((n) => n.entity === x.rel.subject && !n.structural);
    const b = measured.nodes.find((n) => n.entity === x.rel.object.split('#')[0] && !n.structural);
    const pa = graph.nodes.find((n) => a && n.id === a.id); const pb = graph.nodes.find((n) => b && n.id === b.id);
    if (!a || !b || !pa || !pb || a.anchor === 'sky' || b.anchor === 'horizon' || a.anchor === 'horizon') continue;
    const ratio = (a.box.h / b.box.h) / (pa.box.h / pb.box.h);
    proportions.push({ pair: `${a.id}/${b.id}`, ratio: Number(ratio.toFixed(2)) });
    if (ratio < 0.5 || ratio > 2) issues.push({ code: 'PROPORTION', pair: `${a.id}/${b.id}`, ratio: Number(ratio.toFixed(2)), fix: false });
  }
  const edge = Math.min(W, H) * 0.015;
  for (const n of weighted) {
    if (n.box.x < edge * 0.5 || n.box.x + n.box.w > W - edge * 0.5) issues.push({ code: 'TOUCHES_EDGE', node: n.id, fix: true });
  }
  return {
    coverOf,
    metrics: { elements: drawable.length, present: drawable.filter((n) => m[n.id] && m[n.id].visible).length, relationsHeld: relations.filter((x) => x.holds).length, relations: relations.length, balanceOffset, focalDistance, proportions },
    issues,
    measured,
  };
}

/** Corrections as element moves (dx, dy); elements resting on a moved element move with it. */
const BLOCKING = new Set(['ELEMENT_MISSING', 'ELEMENT_INVISIBLE', 'ELEMENT_OFF_CANVAS', 'COUNT_SHORT', 'RELATION_BROKEN', 'OCCLUDED', 'INVISIBLE_IN_IMAGE', 'LOW_VISIBILITY']);

/**
 * Pixel check (drawing tool qa.visibility): how much of each element's box changes when the element is removed.
 * Below the floor the element is not really in the picture, whatever its geometry says.
 */
/** Lighter version of any paint (hex, rgb/rgba, gradient stops, pattern colours): raises value, keeps hue. */
function lightenPaint(v, k) { return tonePaint(v, k, 'lighten'); }
function darkenPaint(v, k) { return tonePaint(v, k, 'darken'); }
function tonePaint(v, k, how) {
  const color = require('./color');
  const parse = color.parse;
  const lighten = color[how];
  const one = (c) => {
    if (typeof c !== 'string') return c;
    if (/^#[0-9a-f]{6}$/i.test(c)) return lighten(c, k);
    const m = /^rgba?\(([^)]+)\)$/i.exec(c);
    if (!m) return c;
    const p = m[1].split(',').map(Number);
    const hex = `#${p.slice(0, 3).map((x) => Math.round(x).toString(16).padStart(2, '0')).join('')}`;
    const o = parse(lighten(hex, k));
    return p.length > 3 ? `rgba(${o.r},${o.g},${o.b},${p[3]})` : `rgb(${o.r},${o.g},${o.b})`;
  };
  if (v && typeof v === 'object') {
    const c = JSON.parse(JSON.stringify(v));
    if (Array.isArray(c.stops)) c.stops = c.stops.map((st) => Object.assign({}, st, { color: one(st.color) }));
    if (c.color) c.color = one(c.color);
    if (c.background) c.background = one(c.background);
    return c;
  }
  return one(v);
}

async function pixelVisibility(bridge, documentId, graph, m) {
  const nodes = graph.nodes.filter((n) => n.drawable && !n.structural && m[n.id] && m[n.id].ids.length && m[n.id].box);
  if (!nodes.length) return { issues: [], groups: [] };
  let res;
  try {
    res = await bridge.call('qa.visibility', { documentId, groups: nodes.map((n) => ({ id: n.id, objectIds: m[n.id].groupIds || m[n.id].ids, box: m[n.id].box })) });
  } catch (error) {
    return { issues: [], groups: [], unavailable: error.message };
  }
  const groups = (res.data && res.data.groups) || [];
  const issues = [];
  for (const g of groups) {
    const n = graph.nodes.find((x) => x.id === g.id);
    const behind = (graph.relations || []).some((r) => r.subject === n.entity && ['behind', 'inside', 'below'].includes(r.relation));
    // Thin objects (a pen, a lamp stand) fill little of their box; the floor counts changed pixels too.
    const floor = behind ? 0.05 : 0.12;
    if (g.changedRatio < floor && g.changedPixels < 400) issues.push({ code: 'INVISIBLE_IN_IMAGE', node: g.id, changedRatio: g.changedRatio, fix: !behind });
    // Present but drawn almost in the colour of what is around it: a viewer does not see it either.
    else if (Number.isFinite(g.changedMean) && g.changedMean < 30 && g.changedRatio < 0.35) issues.push({ code: 'LOW_VISIBILITY', node: g.id, changedRatio: g.changedRatio, changedMean: g.changedMean, lumDelta: g.lumDelta, fix: !behind });
  }
  return { issues, groups: groups.map((g) => ({ id: g.id, changedRatio: g.changedRatio, changedMean: g.changedMean, lumDelta: g.lumDelta })) };
}

function corrections(graph, art, ev, fixes) {
  const W = graph.canvas.width;
  const moves = new Map();
  const add = (id, dx, dy) => { if (!dx && !dy) return; const m = moves.get(id) || { dx: 0, dy: 0 }; m.dx += dx; m.dy += dy; moves.set(id, m); };
  const node = (id) => ev.measured.nodes.find((n) => n.id === id);
  const firstOf = (entity) => ev.measured.nodes.filter((n) => n.entity === entity && !n.structural);
  for (const issue of ev.issues.filter((i) => i.fix && (!fixes || fixes.includes(i.code)))) {
    if (issue.code === 'RELATION_BROKEN') {
      const r = issue.rel; const t = firstOf(r.object.split('#')[0])[0];
      if (!t) continue;
      for (const s of firstOf(r.subject)) {
        const a = s.box; const b = t.box; const gap = Math.min(W, graph.canvas.height) * 0.02;
        if (r.relation === 'on') add(s.id, 0, Math.round(b.y - (a.y + a.h) + a.h * 0.1));
        else if (r.relation === 'beside') add(s.id, Math.round(b.x + b.w + gap - a.x), s.anchor === t.anchor ? Math.round(b.y + b.h - (a.y + a.h)) : 0);
        else if (r.relation === 'left') add(s.id, Math.round(b.x - gap - (a.x + a.w)), 0);
        else if (r.relation === 'right') add(s.id, Math.round(b.x + b.w + gap - a.x), 0);
        else if (r.relation === 'between' && r.object2) { const c = firstOf(r.object2.split('#')[0]).find((n) => !r.object2.includes('#') || n.instance === Number(r.object2.split('#')[1])); if (c) add(s.id, Math.round((b.x + b.w / 2 + c.box.x + c.box.w / 2) / 2 - (a.x + a.w / 2)), 0); }
        else if (r.relation === 'above') add(s.id, 0, Math.round(b.y - gap - (a.y + a.h)));
      }
    } else if (issue.code === 'FOCAL_OFF_TARGET') {
      const f = node(art.composition.focal);
      if (f) add(f.id, Math.round(art.composition.target.x - (f.box.x + f.box.w / 2)), 0);
    } else if (issue.code === 'UNBALANCED') {
      // Move the heaviest free element on the heavy side (not the focal, not a relation anchor) toward the centre.
      const heavy = ev.measured.nodes.filter((n) => n.drawable && !n.structural && n.box.w < W * 0.9 && n.anchor !== 'surface' && n.id !== art.composition.focal
        && !(graph.relations || []).some((r) => [r.subject, r.object, r.object2].some((ref) => String(ref || '').split('#')[0] === n.entity))
        && (issue.side === 'right' ? n.box.x + n.box.w / 2 > W / 2 : n.box.x + n.box.w / 2 < W / 2))
        .sort((a, b) => b.box.w * b.box.h - a.box.w * a.box.h)[0];
      if (heavy) add(heavy.id, Math.round((issue.side === 'right' ? -1 : 1) * Math.min(W * issue.offset * 1.5, W * 0.25)), 0);
    } else if (issue.code === 'OCCLUDED') {
      // Slide horizontally to the nearest position where nearer bodies cover less than a fifth of it.
      const n = node(issue.node);
      if (!n) continue;
      const covered = (x) => ev.coverOf(n, Object.assign({}, n.box, { x }));
      let best = null;
      for (let step = 1; step <= 40 && !best; step += 1) {
        for (const sign of [1, -1]) {
          const x = n.box.x + sign * step * W * 0.02;
          if (x < W * 0.02 || x + n.box.w > W * 0.98) continue;
          // "Behind" stays partly hidden on purpose: only uncover it enough to read.
          if (covered(x) < (issue.behind ? 0.5 : 0.2)) { best = x; break; }
        }
      }
      if (best !== null) add(n.id, Math.round(best - n.box.x), 0);
    } else if (issue.code === 'TOUCHES_EDGE' || issue.code === 'ELEMENT_OFF_CANVAS') {
      const n = node(issue.node); const edge = Math.min(W, graph.canvas.height) * 0.03;
      if (n) add(n.id, n.box.x < W / 2 ? Math.round(edge - n.box.x) : Math.round(W - edge - (n.box.x + n.box.w)), 0);
    }
  }
  // Children move with their parent.
  for (const [id, mv] of [...moves]) for (const child of graph.nodes.filter((n) => n.parent === id)) if (!moves.has(child.id)) moves.set(child.id, Object.assign({}, mv));
  return [...moves].map(([element, mv]) => ({ element, dx: mv.dx, dy: mv.dy }));
}

async function reviewAndCorrect(options) {
  const { bridge, documentId, plan, steps } = options;
  const d = plan.direction;
  const correct = options.correct !== false;
  const maxRounds = Math.max(0, Math.min(3, Number(options.maxRounds === undefined ? 2 : options.maxRounds)));
  const rounds = [];
  const raised = new Set();
  const lightened = new Map(); // element → tone corrections applied
  let first = null;
  for (let round = 0; round <= maxRounds; round += 1) {
    const listed = await bridge.call('object.list', { documentId });
    const m = measure(d.graph, steps, (listed.data && listed.data.objects) || []);
    const ev = evaluate(d.graph, d.art, m, d.understanding);
    const px = await pixelVisibility(bridge, documentId, d.graph, m);
    // A bounding rectangle can include empty space between table legs. Measured pixel
    // visibility takes precedence before moving an already visible object into another.
    ev.issues = ev.issues.filter(issue => {
      if (issue.code !== 'OCCLUDED' || px.unavailable) return true;
      const measured = px.groups.find(g => g.id === issue.node);
      return !measured || measured.changedRatio < 0.6 || measured.changedMean < 40;
    });
    ev.issues.push(...px.issues);
    ev.metrics.pixelVisibility = px.unavailable ? `unavailable: ${px.unavailable}` : Object.fromEntries(px.groups.map((g) => [g.id, { seen: g.changedRatio, contrast: g.changedMean }]));
    if (!first) first = ev;
    const entry = { round, metrics: ev.metrics, issues: ev.issues.map((i) => { const o = Object.assign({}, i); delete o.rel; return o; }), corrections: [] };
    const prev = rounds[rounds.length - 1];
    if (prev && ev.metrics.relationsHeld < prev.metrics.relationsHeld && prev.corrections.length) {
      for (const mv of prev.corrections) {
        for (const objectId of mv.ids) await bridge.call('object.transform', { documentId, objectId, dx: -mv.dx, dy: -mv.dy });
        const n = d.graph.nodes.find((x) => x.id === mv.element);
        if (n) { n.box.x -= mv.dx; n.box.y -= mv.dy; }
      }
      prev.reverted = 'this round broke a requested relation; its corrections were undone';
      const relisted = await bridge.call('object.list', { documentId });
      const back = evaluate(d.graph, d.art, measure(d.graph, steps, (relisted.data && relisted.data.objects) || []), d.understanding);
      rounds.push({ round, metrics: back.metrics, issues: back.issues.map((i) => { const o = Object.assign({}, i); delete o.rel; return o; }), corrections: [], afterRevert: true });
      break;
    }
    rounds.push(entry);
    if (!correct || round === maxRounds || !ev.issues.some((i) => i.fix && (['INVISIBLE_IN_IMAGE', 'LOW_VISIBILITY'].includes(i.code) || !options.fixes || options.fixes.includes(i.code)))) break;
    const moves = corrections(d.graph, d.art, ev, options.fixes);
    // Pixel-invisible elements that are not meant to be behind anything are raised above every scene layer.
    const raise = ev.issues.filter((i) => i.code === 'INVISIBLE_IN_IMAGE' && i.fix && !raised.has(i.node));
    if (raise.length) {
      const info = await bridge.call('document.info', { documentId });
      const layers = ((info.data && info.data.document && info.data.document.layers) || []);
      // The highest layer that already holds a scene element's body (never a lighting/shade overlay layer,
      // whatever its name or language).
      const objs = (listed.data && listed.data.objects) || [];
      const bodyIds = new Set(d.graph.nodes.filter((n) => n.drawable && !n.structural && m[n.id]).flatMap((n) => m[n.id].ids));
      const sceneLayers = new Set(objs.filter((o) => bodyIds.has(o.id)).map((o) => o.layerId));
      const top = layers.slice().reverse().find((l) => sceneLayers.has(l.id));
      if (top) {
        for (const issue of raise) {
          raised.add(issue.node);
          const ids = (m[issue.node] || { ids: [] }).ids;
          for (const objectId of ids) await bridge.call('object.move', { documentId, objectId, targetLayerId: top.id });
          entry.corrections.push({ element: issue.node, raisedTo: top.name || top.id, objects: ids.length, ids: [], dx: 0, dy: 0 });
        }
      }
    }
    // Low contrast: push the element's own paints AWAY from its backdrop, once (it stays in place and layer).
    // Always lightening made hazed mountains in front of a light sky worse (seen 0.229 → 0.146, run_mw7v4unh):
    // an element darker than what is behind it is darkened, a lighter one is lightened.
    // Up to two tone corrections per element: one fixed step can fall just short (hills 25.2 → 27.8 of 30).
    const dim = ev.issues.filter((i) => i.code === 'LOW_VISIBILITY' && i.fix && (lightened.get(i.node) || 0) < 2);
    if (dim.length) {
      const info = await bridge.call('document.info', { documentId });
      const all = new Map(((info.data && info.data.document && info.data.document.layers) || []).flatMap((l) => l.objects || []).map((o) => [o.id, o]));
      for (const issue of dim) {
        lightened.set(issue.node, (lightened.get(issue.node) || 0) + 1);
        let count = 0;
        for (const objectId of (m[issue.node] || { ids: [] }).ids) {
          const o = all.get(objectId);
          if (!o) continue;
          const patch = {};
          const push = issue.lumDelta > 0 ? (c) => lightenPaint(c, 0.35) : (c) => darkenPaint(c, 0.3);
          for (const key of ['fill', 'stroke', 'color']) if (o[key]) patch[key] = push(o[key]);
          if (Array.isArray(o.colors)) patch.colors = o.colors.map(push);
          if (!Object.keys(patch).length) continue;
          await bridge.call('object.update', { documentId, objectId, patch });
          count += 1;
        }
        entry.corrections.push(Object.assign({ element: issue.node, objects: count, ids: [], dx: 0, dy: 0, lumDelta: issue.lumDelta }, issue.lumDelta > 0 ? { lightened: 0.35 } : { darkened: 0.3 }));
      }
    }
    if (!moves.length && !raise.length && !dim.length) break;
    for (const mv of moves) {
      const ids = (m[mv.element] || { ids: [] }).ids;
      for (const objectId of ids) await bridge.call('object.transform', { documentId, objectId, dx: mv.dx, dy: mv.dy });
      // Keep the plan's graph in step with the document so the next round measures relations on moved boxes.
      const n = d.graph.nodes.find((x) => x.id === mv.element);
      if (n) { n.box.x += mv.dx; n.box.y += mv.dy; }
      entry.corrections.push(Object.assign({ objects: ids.length, ids }, mv));
    }
  }
  const last = rounds[rounds.length - 1];
  const fixable = (r) => r.issues.filter((i) => i.fix).length;
  return {
    mode: correct ? 'correct' : 'report',
    scope: 'geometry of drawn objects + pixel visibility per element (qa.visibility); not semantic image understanding',
    rounds,
    final: { metrics: last.metrics, issues: last.issues },
    improved: rounds.length > 1 ? fixable(last) < fixable(rounds[0]) || last.issues.length < rounds[0].issues.length : null,
    // A requested element hidden behind others counts as not delivered.
    ok: !last.issues.some((i) => BLOCKING.has(i.code)),
  };
}

module.exports = { reviewAndCorrect, evaluate, measure, corrections, BLOCKING, tonePaint };
