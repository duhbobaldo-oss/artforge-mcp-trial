'use strict';

/**
 * Art direction (stage ⑦): one coherent set of decisions taken BEFORE drawing.
 *
 * Inputs: the understood request, the scene graph, the reference analysis and the grounded book rules.
 * Output: composition, perspective, depth, lighting, shadows, colour and materials, each with the reason and
 * (when one exists) the book rule it applies. Conflicts are detected and resolved in the open; caller overrides
 * (`artDirection`) win and are labelled `source: "caller"`. The focal subject is moved to its target point here,
 * so the graph handed to the renderer already carries the composition.
 */

const { mix, darken, lighten, hsl } = require('./color');
const { relationHolds } = require('./scene-graph');

const MOOD = {
  calm: { valueKey: 'high', contrast: 0.6, chroma: 0.75, temperature: 'neutral' },
  warm: { valueKey: 'mid', contrast: 0.8, chroma: 0.95, temperature: 'warm' },
  cool: { valueKey: 'mid', contrast: 0.8, chroma: 0.8, temperature: 'cool' },
  dramatic: { valueKey: 'low', contrast: 1.25, chroma: 0.95, temperature: 'mixed' },
  cheerful: { valueKey: 'high', contrast: 0.9, chroma: 1.2, temperature: 'warm' },
  mysterious: { valueKey: 'low', contrast: 0.7, chroma: 0.7, temperature: 'cool' },
  melancholic: { valueKey: 'mid', contrast: 0.65, chroma: 0.65, temperature: 'cool' },
};

const MATERIAL = {
  desk: { kind: 'wood', finish: 'satin', texture: 'wood' }, coffeeTable: { kind: 'wood', finish: 'satin', texture: 'wood' },
  bookshelf: { kind: 'wood', finish: 'matte', texture: 'wood' }, frame: { kind: 'wood', finish: 'satin' },
  sofa: { kind: 'fabric', finish: 'matte', texture: 'noise' }, armchair: { kind: 'fabric', finish: 'matte', texture: 'noise' }, rug: { kind: 'fabric', finish: 'matte', texture: 'noise' },
  window: { kind: 'glass', finish: 'glossy', reflects: true }, tv: { kind: 'glass', finish: 'glossy', reflects: true },
  tower: { kind: 'glass', finish: 'glossy', reflects: true }, building: { kind: 'stone', finish: 'matte', texture: 'noise' },
  lighthouse: { kind: 'stone', finish: 'matte' }, house: { kind: 'stone', finish: 'matte' }, rocks: { kind: 'stone', finish: 'matte', texture: 'noise' },
  sea: { kind: 'water', finish: 'reflective', reflects: true }, lake: { kind: 'water', finish: 'reflective', reflects: true }, river: { kind: 'water', finish: 'reflective', reflects: true },
  trees: { kind: 'foliage', finish: 'matte', texture: 'brush' }, palms: { kind: 'foliage', finish: 'matte', texture: 'brush' }, plant: { kind: 'foliage', finish: 'matte' },
  grass: { kind: 'foliage', finish: 'matte', texture: 'brush' }, flowers: { kind: 'foliage', finish: 'matte' }, garden: { kind: 'foliage', finish: 'matte', texture: 'brush' },
  lamp: { kind: 'metal', finish: 'satin' }, clock: { kind: 'metal', finish: 'satin' }, pen: { kind: 'plastic', finish: 'glossy' },
  notebook: { kind: 'paper', finish: 'matte' }, person: { kind: 'skin-cloth', finish: 'matte' }, boat: { kind: 'wood', finish: 'satin' },
  mountains: { kind: 'stone', finish: 'matte' }, hills: { kind: 'earth', finish: 'matte' }, dunes: { kind: 'sand', finish: 'matte', texture: 'noise' }, road: { kind: 'asphalt', finish: 'matte' },
};

const cx = (b) => b.x + b.w / 2;
const cy = (b) => b.y + b.h / 2;

function directArt(context) {
  const { understanding: u, graph, references, rules, roles } = context;
  const over = Object.assign({}, context.overrides || {});
  const W = graph.canvas.width; const H = graph.canvas.height;
  const grounded = new Map((rules || []).filter((r) => r.grounded).map((r) => [r.id, r]));
  const applied = [];
  const cite = (ruleId, decision) => {
    const r = grounded.get(ruleId);
    if (!r) return null;
    applied.push({ rule: ruleId, book: r.citation.bookId, page: r.citation.page, decision });
    return { rule: ruleId, book: r.citation.bookId, page: r.citation.page };
  };
  const conflicts = [];
  const c = u.constraints;
  const nodes = graph.nodes.filter((n) => !n.structural && n.drawable);
  const has = (m) => nodes.some((n) => n.motif === m);

  // ── composition ──
  const explicitFocal = over.focal ? nodes.find((n) => n.entity === over.focal || n.id === over.focal) : null;
  const ranked = nodes.filter((n) => !['sky', 'terrain', 'water'].includes(n.category) && n.anchor !== 'surface' && n.box.w < W * 0.9)
    // The thing others are placed against («بجانب الكنبة») is the anchor of the picture: it outranks its dependents.
    .map((n) => ({ n, score: (n.motif === 'person' ? 100 : 0) + ((u.relations || []).some((r) => r.object === n.entity) ? 12 : 0) + ((u.relations || []).some((r) => r.subject === n.entity) ? 6 : 0) + (Object.keys(n.attributes || {}).length ? 15 : 0) + (n.plane === 'midground' ? 10 : 0) + (n.box.w * n.box.h) / (W * H) * 120 }))
    .sort((a, b) => b.score - a.score);
  const focal = explicitFocal || (ranked[0] && ranked[0].n) || null;
  let grid = over.composition || c.composition || 'thirds';
  if (grid === 'symmetric' && focal && Math.abs(cx(focal.box) - W / 2) > W * 0.1 && !over.composition) { conflicts.push({ code: 'SYMMETRY_VS_SIDE_FOCAL', resolution: 'focal moved to the centre axis' }); }
  const imageFocal = references && references.image && references.image.focal;
  const thirds = [[1 / 3, 1 / 3], [2 / 3, 1 / 3], [1 / 3, 2 / 3], [2 / 3, 2 / 3]].map(([x, y]) => ({ x: x * W, y: y * H }));
  let target = null;
  if (focal) {
    const here = { x: cx(focal.box), y: cy(focal.box) };
    if (grid === 'center' || grid === 'symmetric') target = { x: W / 2, y: here.y };
    else if (imageFocal && !over.composition) target = { x: imageFocal.x * W, y: here.y };
    // Thirds: only the horizontal third moves the subject; its vertical position belongs to its ground line.
    else target = { x: thirds.reduce((best, p) => (Math.abs(p.x - here.x) < Math.abs(best.x - here.x) ? p : best)).x, y: here.y };
  }
  const composition = { grid, focal: focal ? focal.id : null, target: target ? { x: Math.round(target.x), y: Math.round(target.y) } : null, calmArea: references && references.image ? references.image.calmArea : null, source: over.composition || over.focal ? 'caller' : 'engine', cite: cite('composition-eye', `focal ${focal ? focal.id : 'none'} on the ${grid} grid`) };
  // keepLayout: a composer already composed the picture; the focal subject is recorded, not moved.
  if (context.keepLayout) { composition.target = null; composition.note = 'layout kept from the composer'; }
  const originalX=new Map(graph.nodes.map(n=>[n.id,n.box.x]));
  if (focal && target && !context.keepLayout && !focal.attributes.rigHands) {
    // Move the focal group (focal + everything resting on it) only if that keeps every relation true.
    const dx = Math.round(target.x - cx(focal.box));
    const group = graph.nodes.filter((n) => n === focal || n.parent === focal.id);
    const room = Math.min(...group.map((n) => n.box.x)) + dx >= graph.margin * 0.25 && Math.max(...group.map((n) => n.box.x + n.box.w)) + dx <= W - graph.margin * 0.25;
    if (dx && room) {
      group.forEach((n) => { n.box.x += dx; });
      const broken = (graph.relations || []).filter((r) => r.applied && !relationHolds(r, graph));
      // Related neighbours follow the subject; if that still breaks a relation, undo the move.
      if (broken.length) {
        const ent = (ref) => String(ref || '').split('#')[0];
        const linked = new Set([focal.entity]);
        for (let grew = true; grew;) {
          grew = false;
          for (const r of graph.relations || []) {
            const ends = [ent(r.subject), ent(r.object), ent(r.object2)].filter(Boolean);
            if (ends.some((e) => linked.has(e)) && ends.some((e) => !linked.has(e))) { ends.forEach((e) => linked.add(e)); grew = true; }
          }
        }
        const followers = graph.nodes.filter((n) => !group.includes(n) && !n.structural && n.box.w < W * 0.9 && n.anchor !== 'horizon' && linked.has(n.entity));
        followers.forEach((n) => { n.box.x = Math.min(Math.max(n.box.x + dx, 0), W - n.box.w); graph.nodes.filter((k) => k.parent === n.id).forEach((k) => { k.box.x += dx; }); });
        if ((graph.relations || []).some((r) => r.applied && !relationHolds(r, graph))) {
          group.concat(followers).forEach((n) => { n.box.x -= dx; });
          graph.nodes.filter((k) => followers.some((f) => k.parent === f.id)).forEach((k) => { k.box.x -= dx; });
          composition.moved = 0; composition.note = 'focal kept in place: moving it would break a requested relation';
        } else composition.moved = dx;
      } else composition.moved = dx;
    }
    cite('focal-flagging', `opposite-value halo behind ${focal.id}`);
    composition.flag = true;
  }

  // Composition translations must move the actual kinematic frame and contacts.
  for(const n of graph.nodes){const dx=n.box.x-originalX.get(n.id);if(!dx)continue;
    if(n.attributes.rigFrame)n.attributes.rigFrame.x+=dx;
    if(n.attributes.rigHands)for(const p of Object.values(n.attributes.rigHands))p.x+=dx;
    if(n.attributes.support)n.attributes.support.pelvis.x+=dx;
  }
  // ── perspective ──
  const viewpoint = graph.viewpoint;
  let perspective = over.perspective
    || (viewpoint === 'top' ? 'top-down' : (u.designType === 'architecture' || has('tower') || has('building') ? 'two-point' : (graph.indoor ? 'one-point' : (u.designType === 'abstract' ? 'flat' : 'aerial'))));
  const horizonY = graph.horizonY;
  let vanishing = perspective === 'one-point' ? [{ x: Math.round(W / 2), y: Math.round(horizonY * 0.82) }]
    : (perspective === 'two-point' ? [{ x: Math.round(-W * 0.35), y: Math.round(horizonY) }, { x: Math.round(W * 1.35), y: Math.round(horizonY) }] : []);

  let cameraModel;
  if(perspective==='three-point'||over.world===true) { cameraModel=require('./composer/perspective').camera({width:W,height:H,cameraHeight:over.cameraHeight,pitch:over.cameraPitch??(perspective==='three-point'?.22:0),yaw:over.cameraYaw??(perspective==='one-point'?0:Math.PI/4),focal:over.cameraFocal});vanishing=cameraModel.vanishing; }
  // ── lighting ──
  const lighting = c.lighting || (has('moon') || has('stars') ? 'night' : 'day');
  const sun = nodes.find((n) => n.motif === 'sun');
  const moon = nodes.find((n) => n.motif === 'moon');
  const windowNode = nodes.find((n) => n.motif === 'window');
  const lamp = nodes.find((n) => n.motif === 'lamp');
  let key;
  if (lighting === 'night' && sun) conflicts.push({ code: 'NIGHT_WITH_SUN', resolution: 'night kept (explicit); the sun is drawn but is not the key light' });
  if (lighting === 'night' && graph.indoor && lamp) key = { type: 'lamp', from: lamp.id, x: cx(lamp.box), y: lamp.box.y + lamp.box.h * 0.15, temperature: 'warm', hardness: 'soft', elevation: 30, cite: cite('local-light-source', `${lamp.id} is a local warm pool`) };
  else if (lighting === 'night') { const src = moon || windowNode; key = { type: 'moon', from: src ? src.id : null, x: src ? cx(src.box) : W * 0.75, y: src ? cy(src.box) : H * 0.12, temperature: 'cool', hardness: 'soft', elevation: 45, cite: cite('color-temperature', 'cool moonlight') }; }
  else if (graph.indoor && windowNode) key = { type: 'window', from: windowNode.id, x: cx(windowNode.box), y: cy(windowNode.box), temperature: lighting === 'sunset' ? 'warm' : 'neutral', hardness: 'soft', elevation: 35, cite: cite('key-light', `daylight through ${windowNode.id}`) };
  else if (sun) key = { type: 'sun', from: sun.id, x: cx(sun.box), y: cy(sun.box), temperature: 'warm', hardness: 'hard', elevation: lighting === 'sunset' ? 8 : 50, cite: cite('three-light-systems-sunlight', 'sun key, sky fill, ground bounce') };
  else key = { type: lighting === 'overcast' ? 'sky' : 'sun', from: null, x: W * 0.78, y: H * 0.1, temperature: lighting === 'sunset' ? 'warm' : 'neutral', hardness: lighting === 'overcast' ? 'soft' : 'hard', elevation: lighting === 'sunset' ? 8 : 50, cite: cite('key-light', 'one dominant light, upper right by default') };
  const imageLight = references && references.image && references.image.lightFrom;
  if (over.lightFrom || (imageLight && ['left', 'right', 'top'].includes(imageLight.side) && !key.from)) {
    const side = over.lightFrom || imageLight.side;
    key.x = side === 'left' ? W * 0.12 : (side === 'right' ? W * 0.88 : W / 2);
    key.y = side === 'top' ? 0 : H * 0.15;
    key.source = over.lightFrom ? 'caller' : 'reference-image';
  }
  const fromLeft = key.x < W / 2;
  const angle = Math.round((Math.atan2(key.y - H * 0.55, key.x - W / 2) * 180) / Math.PI);
  const lightingDecision = Object.assign({ mode: lighting, angle, side: Math.abs(key.x - W / 2) < W * 0.08 ? 'top' : (fromLeft ? 'left' : 'right') }, key,
    { fill: lighting === 'night' ? '#26355e' : (lighting === 'sunset' ? '#6a5a8c' : '#9db8de'), x: Math.round(key.x), y: Math.round(key.y) });
  if (lighting === 'night') cite('chiaroscuro', 'light against dark: one lit area');
  if (lighting === 'day' || lighting === 'morning' || lighting === 'sunset') cite('color-temperature', `${key.temperature} key, cool sky fill`);

  // ── shadows ──
  const shadowsMode = over.shadows || (key.hardness === 'hard' ? 'hard' : 'soft');
  const length = shadowsMode === 'none' ? 0 : Number(Math.min(2.2, 1 / Math.tan((Math.max(6, key.elevation) * Math.PI) / 180) * 0.35).toFixed(2));
  const shadows = {
    mode: shadowsMode,
    direction: fromLeft ? 1 : -1, // +1: shadows fall to the right
    length,
    blur: shadowsMode === 'hard' ? 3 : 14,
    color: lighting === 'night' ? 'rgba(8,10,24,0.55)' : 'rgba(40,55,95,0.32)',
    contact: shadowsMode !== 'none',
    cite: [cite(shadowsMode === 'hard' ? 'hard-light-sharp-shadow' : 'hard-light-sharp-shadow', `${shadowsMode} shadows`), cite('occlusion-shadows', 'contact shadows where forms touch'), cite('cast-vs-form-shadow', 'form shadow on the object, cast shadow opposite the light')].filter(Boolean),
  };
  if (lighting !== 'night') cite('shadow-edge', 'daylight shadows tinted blue');

  // ── colour ──
  const moods = c.moods || [];
  if (moods.includes('cheerful') && (moods.includes('melancholic') || lighting === 'night')) conflicts.push({ code: 'MOOD_CONFLICT', resolution: `"${moods[0]}" followed` });
  const mood = MOOD[moods[0]] || null;
  const ref = references && references.primary;
  const temperature = over.temperature || (mood && mood.temperature !== 'mixed' ? mood.temperature : null) || key.temperature || (ref && ref.temperature) || 'neutral';
  const sky = lighting === 'night' ? { top: '#0b1430', bottom: '#2a3a66' } : (lighting === 'sunset' ? { top: '#3b3f78', bottom: '#f2a65a' } : { top: '#6fa3d8', bottom: '#d9e9f5' });
  const color = {
    roles: roles ? { background: roles.background, accent: roles.accent, secondary: roles.secondary, text: roles.text } : null,
    harmony: ref ? ref.harmony : null,
    valueKey: (mood && mood.valueKey) || (lighting === 'night' ? 'low' : (ref ? ref.valueKey : 'mid')),
    contrast: mood ? mood.contrast : 1,
    chroma: mood ? mood.chroma : 1,
    temperature,
    mood: moods[0] || null,
    sky,
    userPalette: c.palette || [],
    cite: cite('limited-palette', 'colours derived from the selected reference palette'),
  };
  cite('chroma-and-value', `value key ${color.valueKey} decided before colour`);

  // ── depth ──
  const depth = {
    planes: {
      background: { mixToSky: 0.55, contrast: 0.5, chroma: 0.6, blur: 1.6 },
      midground: { mixToSky: 0.18, contrast: 0.85, chroma: 0.9, blur: 0.4 },
      foreground: { mixToSky: 0.04, contrast: 1, chroma: 1, blur: 0 },
    },
    warmNearCoolFar: perspective !== 'flat',
    cite: [cite('atmospheric-perspective', 'far planes toward the sky colour'), cite('warm-advance-cool-recede', 'warm near, cool far'), cite('edge-control', 'softer edges on far planes'), cite('adaptation-contrast', 'strongest contrast at the focal subject')].filter(Boolean),
  };
  if (graph.indoor) { depth.planes.background.mixToSky = 0; depth.planes.background.blur = 0; depth.planes.midground.mixToSky = 0; }

  // ── materials ──
  const materials = {};
  for (const n of nodes) {
    const m = MATERIAL[n.motif];
    if (!m) continue;
    materials[n.id] = Object.assign({}, m, { color: n.attributes.color || null });
  }
  if (Object.values(materials).some((m) => m.reflects)) cite('reflections', 'water and glass take the sky colour');
  if (Object.values(materials).some((m) => m.texture === 'brush')) cite('dry-brush-texture', 'foliage and grass by dry-brush strokes');
  if (has('person')) { cite('figure-gesture', 'figure from a line of action'); cite('figure-proportion', '7.5 heads standing'); }

  // ── conflicts on the plan itself ──
  if (graph.indoor && lightingDecision.type === 'window' && !windowNode) conflicts.push({ code: 'LIGHT_SOURCE_MISSING', resolution: 'default key used' });

  return {
    version: 1,
    composition,
    perspective: { type: perspective, horizonY:cameraModel?cameraModel.horizonY:horizonY, vanishing, viewpoint, cameraHeight:cameraModel?cameraModel.eye:undefined, cameraPitch:cameraModel?cameraModel.pitch:over.cameraPitch,cameraYaw:cameraModel?cameraModel.yaw:over.cameraYaw,cameraFocal:cameraModel?cameraModel.focal:over.cameraFocal,world:over.world===true||perspective==='three-point' },
    depth,
    lighting: lightingDecision,
    shadows,
    color,
    materials,
    conflicts,
    rulesApplied: applied.filter((a, i, all) => all.findIndex((x) => x.rule === a.rule) === i),
  };
}

/** Colour helpers used by the renderer: apply a plane's depth to a base colour. */
function atPlane(color, plane, art) {
  const p = art.depth.planes[plane];
  if (!p || !p.mixToSky) return color;
  const base = mix(color, art.color.sky.bottom, p.mixToSky);
  return art.depth.warmNearCoolFar && plane === 'background' ? mix(base, '#8fb3d9', 0.12) : base;
}
function shade(color, art) { return art.lighting.mode === 'night' ? darken(color, 0.45) : mix(darken(color, 0.28), '#3c4f7a', 0.18); }
function lit(color, art) { return art.lighting.temperature === 'warm' ? mix(lighten(color, 0.12), '#ffd59a', 0.12) : (art.lighting.temperature === 'cool' ? mix(lighten(color, 0.08), '#a9c8ff', 0.12) : lighten(color, 0.1)); }
function chroma(color, k) { const h = hsl(color); return k === 1 ? color : require('./color').fromHsl(h.h, Math.max(0, Math.min(1, h.s * k)), h.l); }

function summarizeArt(art) {
  return {
    focal: art.composition.focal, grid: art.composition.grid, moved: art.composition.moved || 0,
    perspective: art.perspective.type, horizonY: Math.round(art.perspective.horizonY),
    light: { type: art.lighting.type, side: art.lighting.side, temperature: art.lighting.temperature, hardness: art.lighting.hardness },
    shadows: { mode: art.shadows.mode, length: art.shadows.length },
    color: { harmony: art.color.harmony, valueKey: art.color.valueKey, temperature: art.color.temperature, mood: art.color.mood },
    materials: Object.keys(art.materials).length,
    conflicts: art.conflicts,
    rules: art.rulesApplied.map((r) => `${r.rule} (${r.book} p${r.page})`),
  };
}

module.exports = { directArt, summarizeArt, atPlane, shade, lit, chroma, MATERIAL };
