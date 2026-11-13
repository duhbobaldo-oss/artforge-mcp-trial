'use strict';

/**
 * Composer dispatcher: turns an analysed intent into an executable drawing plan for visual design types
 * (scene, character, landscape, architecture, table, ruled, reference). Text designs (poster/card/text)
 * keep the original router recipe.
 */

const { PlanBuilder, seedFrom } = require('./builder');
const { composeInterior, composeCharacter } = require('./interior');
const { composeLandscape } = require('./landscape');
const { composeCity } = require('./city');
const { composeSceneSpec } = require('../scene-spec');
const { composeStillLife } = require('./still-life');
const { composeAbstract } = require('./abstract');
const { composeTable, composeRuled, composeReference } = require('./documents');
const { hexToOklab, lch, harmonizeDetail, oklchToHex } = require('../swatches');
const { mix, darken, lighten, hsl, contrast } = require('../color');
const { motifOf } = require('../motifs');

const COMPOSED_TYPES = new Set(['scene', 'character', 'landscape', 'architecture', 'table', 'ruled', 'reference', 'abstract']);

/** Which element ids each composer can draw; anything else requested is reported, not faked. */
const SUPPORTED = {
  scene: ['desk', 'notebook', 'pen', 'bookshelf', 'tv', 'person', 'sofa', 'armchair', 'lamp', 'window', 'plant', 'rug', 'clock', 'frame', 'moon', 'stars', 'sun'],
  character: ['person', 'garden', 'trees', 'grass', 'sky', 'sun', 'clouds', 'hills', 'flowers'],
  landscape: ['sun', 'moon', 'stars', 'clouds', 'mountains', 'hills', 'sea', 'river', 'lake', 'trees', 'palms', 'dunes', 'rocks', 'boat', 'lighthouse', 'house', 'birds', 'flowers', 'grass', 'sky', 'garden', 'farm', 'fence'],
  architecture: ['building', 'tower', 'road', 'person', 'trees', 'clouds', 'sky', 'grass', 'garden'],
  abstract: ['shapes', 'lines', 'tiles', 'waves', 'spheres', 'ribbons', 'smoke', 'splash', 'speckles', 'flowers', 'birds', 'sea'],
  table: [], ruled: [], reference: [],
};

/** Default supporting elements so a sparse request still yields a coherent picture (reported as additions). */
const SUPPORTING = {
  scene: ['window', 'rug', 'plant', 'sofa'],
  landscape: ['mountains', 'trees'],
};

/**
 * Restricted palette (Gurney p104 "limited palette") derived from the selected reference palette.
 * With references disabled, a deliberately generic fixed palette is used (A/B comparison baseline).
 */
function scenePalette(roles, refsOn) {
  if (!refsOn) {
    return {
      wall: '#d9d9d9', floor: '#9a9a9a', wood: '#8b5a2b', fabric: '#cc3333', upholstery: '#3355aa', rug: '#aa3333',
      books: ['#cc0000', '#00aa00', '#0000cc', '#cccc00', '#aa00aa'], shirt: '#0055ff', pants: '#333333',
      terrainFar: '#556b2f', terrainNear: '#556b2f', foliage: '#228b22', facade: '#c0c0c0', accent: '#ff0000', strong: '#000080', paper: '#ffffff',
    };
  }
  const colors = roles.colors.length ? roles.colors : ['#1f2a44', '#e9e2d6', '#c76d4f'];
  // Each material slot has a natural colour (what the object is). It takes the reference swatch perceptually
  // closest to it (OKLab ΔE): the closer the swatch, the more of it is used, so a wall/sofa/sky becomes the
  // reference colour while a tree stays green when the palette has no green (it is only harmonised toward it).
  const take = (natural) => harmonizeDetail(natural, colors);
  const NATURAL = {
    wall: '#e9e0d2', floor: '#9a6b45', wood: '#7a5132', fabric: '#c76d4f', upholstery: '#4e6a8a', rug: '#8c3f3a',
    shirt: '#3b6ea8', pants: '#2d3142', terrainFar: '#6d7f99', terrainNear: '#5f8a4a', foliage: '#3f7d4a', facade: '#c9b79c',
  };
  const mapping = {};
  const out = {};
  for (const [slot, natural] of Object.entries(NATURAL)) {
    const r = take(natural);
    // Manufactured surfaces use an actual tint/shade of the chosen swatch.
    // A ten-percent tint of an unrelated natural brown is not a restricted
    // reference palette. Vegetation keeps its semantic natural-colour policy.
    if (!['foliage','terrainNear','terrainFar'].includes(slot)) {
      const source=lch(hexToOklab(r.swatch)),target=hexToOklab(natural).L;
      const chroma=source.C*(target>source.L?(1-target)/Math.max(1e-6,1-source.L):target/Math.max(1e-6,source.L));
      r.color=oklchToHex(target,chroma,source.h);r.weight=1;r.method='reference-swatch-tint-or-shade';
    }
    out[slot] = r.color; mapping[slot] = r;
  }
  const byC = colors.slice().sort((a, b) => lch(hexToOklab(b)).C - lch(hexToOklab(a)).C);
  const accent = roles.accent || byC[0];
  let strong = byC.find((c) => hsl(c).l < 0.45 && hsl(c).s > 0.2) || darken(accent, 0.35);
  if (contrast(strong, '#ffffff') < 4.5) strong = darken(strong, 0.35);
  const byL = colors.slice().sort((a, b) => hsl(a).l - hsl(b).l);
  return Object.assign(out, {
    books: colors.slice(0, 6).map((c, i) => mix(['#7a2e2e', '#2e4a7a', '#3d6b3d', '#b08a2e', '#5b3a6b', '#2e6b6b'][i % 6], c, 0.7)),
    accent,
    strong,
    paper: byL[byL.length - 1],
    // Dominant reference colour for the unifying glaze (Gurney: a shared tint ties a limited palette together).
    glaze: byC[0],
    swatches: colors.slice(),
    mapping,
  });
}

function compose(intent, deps) {
  const { canvas, roles, content, input, evidence, analysis, prompt } = deps;
  const refsOn = input.useReferences !== false;
  const P = new PlanBuilder({ width: canvas.width, height: canvas.height, seed: input.seed || seedFrom(prompt), evidence });
  const palette = scenePalette(roles, refsOn);
  const added = [];
  const working = Object.assign({}, intent, { elements: intent.elements.slice() });
  // Attributes understood from the request (material, colour, size) travel with their elements, so a
  // composer can draw «منزل من حجر» as stone instead of dropping the word.
  if (deps && deps.understanding) {
    working.elements = working.elements.map((e) => {
      const u = deps.understanding.entities.find((x) => x.id === e.id);
      return u && Object.keys(u.attributes || {}).length ? Object.assign({}, e, { attributes: u.attributes }) : e;
    });
  }
  const furniture = ['desk', 'bookshelf', 'tv', 'sofa', 'armchair', 'lamp', 'rug', 'plant', 'frame', 'clock'];
  if (intent.type === 'scene' && !working.elements.some((e) => furniture.includes(e.id))) {
    for (const id of SUPPORTING.scene) { working.elements.push({ id, supporting: true }); added.push(id); }
  } else if (intent.type === 'scene' && !working.elements.some((e) => e.id === 'window') && (intent.lighting === 'morning' || intent.lighting === 'sunset')) {
    working.elements.push({ id: 'window', supporting: true });
    added.push('window');
  }
  if (intent.type === 'scene' && working.elements.some((e) => e.id === 'person') && !working.elements.some((e) => e.id === 'armchair' || e.id === 'sofa')) {
    working.elements.push({ id: 'armchair', supporting: true });
    added.push('armchair');
  }
  if (intent.type === 'landscape' && !working.elements.length) {
    for (const id of SUPPORTING.landscape) { working.elements.push({ id, supporting: true }); added.push(id); }
  }

  P.push({
    op: 'document.create', createsDocument: true, note: `canvas ${canvas.width}x${canvas.height} for ${intent.type}`,
    params: { name: String(input.name || content.headline || intent.label).slice(0, 60), width: canvas.width, height: canvas.height, background: { type: 'solid', color: '#ffffff' }, locale: 'ar', notes: `ArtForge ${intent.type}: ${String(prompt).slice(0, 160)}` },
  });
  const ctx = { intent: working, palette, roles, ev: evidence, input, content, refsOn, analysis };
  let meta;
  if (input.sceneSpec) meta = composeSceneSpec(P, ctx);
  else if (intent.type === 'scene' && working.elements.some((e) => e.id === 'desk')) meta = composeStillLife(P, ctx);
  else switch (intent.type) {
    case 'scene': meta = composeInterior(P, ctx); break;
    case 'character': meta = composeCharacter(P, ctx); break;
    case 'landscape': meta = composeLandscape(P, ctx); break;
    case 'architecture': meta = composeCity(P, ctx); break;
    case 'table': meta = composeTable(P, ctx); break;
    case 'ruled': meta = composeRuled(P, ctx); break;
    case 'reference': meta = composeReference(P, ctx); break;
    case 'abstract': meta = composeAbstract(P, ctx); break;
    default: throw new Error(`no composer for ${intent.type}`);
  }
  // Whole-image finishing chosen by the composer (haze, grade, grain…) is applied by the engine on render.
  // A caller-authored sceneSpec owns its colours: the unifying glaze shifted exact requested hex values (a brand
  // orange #F4A51C no longer matched after a 10% soft-light tint), so it is applied to composer pictures only.
  const callerColours = Boolean(input.sceneSpec);
  if (refsOn && !callerColours && palette.glaze && ['scene', 'character', 'landscape', 'architecture'].includes(intent.type)) {
    ctx.effects = (ctx.effects || []).concat([{ type: 'tint', color: palette.glaze, amount: 0.1, blend: 'soft-light' }]);
  }
  if (ctx.effects) P.ops[0].params.effects = ctx.effects;
  if (refsOn && !callerColours && ['scene', 'character', 'landscape', 'architecture'].includes(intent.type)) {
    const used = palette.mapping ? Object.entries(palette.mapping).map(([slot, m]) => `${slot}←${m.swatch} ${Math.round(m.weight * 100)}%`).join(', ') : '';
    evidence.record('limited-palette', `Materials take the closest reference swatch (OKLab): ${used}; unifying glaze ${palette.glaze}.`, [], 'palette');
  }

  // Coverage: every requested element must be drawn by at least one op, or be reported as unsupported.
  const supported = new Set(input.sceneSpec ? input.sceneSpec.elements.map((e) => e.id) : (SUPPORTED[intent.type] || []));
  // Umbrella words are covered by their parts ("garden" = trees/flowers/grass).
  const ALIASES = { garden: ['garden', 'trees', 'flowers', 'grass'] };
  // الهوية الدلالية من قاموس الأنواع الصريح: pen1/pen2/pens/قلم/أقلام نوع واحد، والعدد لا يصبح عنصرًا ناقصًا.
  // الأنواع المجهولة تبقى كما هي، فلا يُخفي القاموس عنصرًا لم يُرسم فعلًا.
  const drawnMotifs = new Set();
  for (const [id, ops] of P.elements) if (ops && ops.length) drawnMotifs.add(motifOf(id));
  const supportedMotifs = new Set([...supported].map((id) => motifOf(id)));
  const coverage = intent.elements.map((e) => {
    const motif = motifOf(e.id);
    const ops = (ALIASES[e.id] || [e.id]).flatMap((id) => P.elements.get(id) || []);
    const declared = input.sceneSpec ? input.sceneSpec.elements.filter((el) => motifOf(el.id) === motif).map((el) => el.id) : null;
    const instances = [...P.elements].filter(([id, indexes]) => motifOf(id) === motif && indexes.length).map(([id]) => id);
    const requestedCount = Math.max(e.count || 1, declared ? declared.length : 1);
    const drawnCount = instances.length || (ops.length ? 1 : 0);
    return { element: e.id, motif, requested: true, requestedCount, drawnCount, instances, declared, drawn: drawnCount >= requestedCount, ops: instances.flatMap((id) => P.elements.get(id) || []).length || ops.length, supported: supportedMotifs.has(motif) };
  });
  const missing = [...new Set(coverage.filter((c) => !c.drawn).map((c) => c.motif))];
  return {
    ops: P.ops,
    meta: Object.assign({ supportingElementsAdded: added }, meta),
    palette,
    coverage,
    missing,
    limits: missing.length
      ? [`These requested elements have no drawing motif in the ${intent.type} composer and were NOT drawn: ${missing.join(', ')}.`]
      : [],
  };
}

module.exports = { compose, COMPOSED_TYPES, scenePalette, SUPPORTED };
