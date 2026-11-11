'use strict';

/**
 * SceneSpec engine (stage ⑧): compiles the scene graph + art direction into a SceneSpec v1
 * (layers, elements, primitive drawing operations with paths and brushes), then checks that the plan is
 * complete and executable before any document is created.
 *
 * Every graph node becomes one element; every operation names its element and layer. Colours come from
 * the reference palette (harmonised per material), are pushed toward the sky by depth plane, lit on the
 * key-light side and shaded on the other; cast and contact shadows fall opposite the light.
 * Nodes without a known motif are never faked: they produce no operations and stay reported as missing.
 */

const { validateSceneSpec } = require('./scene-spec');
const { houseGeometry } = require('./house-geometry');
const { harmonizeDetail } = require('./swatches');
const { mix, darken, lighten, rgba } = require('./color');
const { atPlane, shade, lit, chroma } = require('./art-direction');

const LAYERS = [
  { id: 'sky', name: 'Sky / wall' },
  { id: 'background', name: 'Background plane' },
  { id: 'midground', name: 'Middle plane' },
  { id: 'foreground', name: 'Foreground plane' },
  { id: 'light', name: 'Light and atmosphere' },
];

const NATURAL = {
  bed:'#715640',book:'#f3e8cd',diningTable:'#865b39',wall: '#e9e0d2', floor: '#9a6b45', desk: '#7a5132', coffeeTable: '#7a5132', bookshelf: '#6b4630', sofa: '#4e6a8a', armchair: '#c76d4f',
  rug: '#8c3f3a', lamp: '#d8c3a0', window: '#e9eef6', frame: '#7a5132', clock: '#f2f0ea', tv: '#1e1e22', plant: '#3f7d4a', notebook: '#f4efe4',
  pen: '#2f4b7c', person: '#3b6ea8', mountains: '#6d7f99', hills: '#6f9a55', dunes: '#d9b77e', sea: '#2f6fb0', lake: '#3f7fb8', river: '#3f7fb8',
  grass: '#5f8a4a', garden: '#4f8a46', trees: '#3f7d4a', palms: '#4b8a3e', flowers: '#e58fb0', rocks: '#8a8478', boat: '#8a5a3b', lighthouse: '#f2f0ea',
  house: '#c9b79c', building: '#c9b79c', tower: '#7fa1c4', road: '#55585e', clouds: '#ffffff', sun: '#ffd56a', moon: '#f2f0ea', stars: '#ffffff', birds: '#2b2b33', sky: '#9db8de',
};

const r = (v) => Math.round(v * 10) / 10;

function seeded(seed) { let s = seed >>> 0 || 1; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }

function compileSceneSpec(graph, art, context) {
  const ctx = context || {};
  const W = graph.canvas.width; const H = graph.canvas.height;
  const swatches = (ctx.roles && ctx.roles.colors && ctx.roles.colors.length && ctx.useReferences !== false) ? ctx.roles.colors : null;
  const worldScene=art.perspective.world ? require('./composer/world-furniture').projectFurnitureScene(graph,art) : null;
  const deferredHands=new Map();
  const ops = [];
  const elements = [];
  const rand = seeded(ctx.seed || 7);
  const night = art.lighting.mode === 'night';
  const dir = art.shadows.direction; // +1 shadows fall right
  const lightLeft = art.lighting.side === 'left';

  const base = (n) => {
    const natural = (n.attributes && n.attributes.color) || NATURAL[n.motif] || '#888888';
    let c = n.attributes && n.attributes.color ? natural : (swatches ? harmonizeDetail(natural, swatches).color : natural);
    c = chroma(c, art.color.chroma);
    // In a hybrid the composer's own night shading already darkens everything; darkening twice hid objects.
    if (night && !ctx.only && !['sun', 'moon', 'stars', 'lamp'].includes(n.motif)) c = mix(c, '#1b2340', 0.38);
    // Hybrid at night: the composer's shading layer darkens what is drawn under it, so pre-light like its own objects.
    if (night && ctx.only && !['sun', 'moon', 'stars', 'lamp'].includes(n.motif)) c = lighten(c, 0.3);
    return atPlane(c, n.plane, art);
  };
  const push = (op, layer, element, params, note) => { ops.push({ op, layer, element, params, note }); };
  const rect = (L, el, p, note) => push('draw.rect', L, el, p, note);
  const ell = (L, el, p, note) => push('draw.ellipse', L, el, p, note);
  const poly = (L, el, pts, p, note) => push('draw.polygon', L, el, Object.assign({ points: pts.map((q) => ({ x: r(q.x), y: r(q.y) })), closed: true }, p), note);
  const line = (L, el, p, note) => push('draw.line', L, el, p, note);
  const grad = (L, el, p, note) => push('draw.gradient', L, el, p, note);
  const brush = (L, el, pts, p, note) => push('draw.brush', L, el, Object.assign({ points: pts.map((q) => ({ x: r(q.x), y: r(q.y) })) }, p), note);
  const glow = (L, el, gx, gy, R, color, alpha, note, blend) => grad(L, el, Object.assign({ x: r(gx - R), y: r(gy - R), w: r(R * 2), h: r(R * 2), gradientType: 'radial', stops: [{ offset: 0, color: rgba(color, alpha) }, { offset: 1, color: rgba(color, 0) }] }, blend ? { blend } : {}), note);
  const vgrad = (top, bottom) => ({ type: 'linear', angle: 90, stops: [{ offset: 0, color: top }, { offset: 1, color: bottom }] });
  const sideGrad = (c) => ({ type: 'linear', angle: lightLeft ? 0 : 180, stops: [{ offset: 0, color: lit(c, art) }, { offset: 1, color: shade(c, art) }] });
  const blurOf = (n) => (art.depth.planes[n.plane] ? art.depth.planes[n.plane].blur : 0);

  /** Contact + cast shadow on the ground under a standing node (occlusion + cast-vs-form rules). */
  const groundShadow = (n, el, L) => {
    if (!art.shadows.contact || ['sky', 'water'].includes(n.category) || n.anchor === 'wall' || n.anchor === 'sky' || n.box.w >= W * 0.9) return;
    const b = n.box;
    const len = Math.min(b.h * art.shadows.length, W * 0.25);
    if (len > 4) poly(L, el, [{ x: b.x + b.w * 0.1, y: b.y + b.h }, { x: b.x + b.w * 0.9, y: b.y + b.h }, { x: b.x + b.w * 0.9 + dir * len, y: b.y + b.h - len * 0.18 }, { x: b.x + b.w * 0.1 + dir * len, y: b.y + b.h - len * 0.18 }], { fill: art.shadows.color, blur: art.shadows.blur }, 'cast shadow opposite the key light');
    ell(L, el, { x: b.x + b.w * 0.05, y: b.y + b.h - b.h * 0.04, w: b.w * 0.9, h: Math.max(4, b.h * 0.08), fill: rgba('#000000', night ? 0.5 : 0.35), blur: 4 }, 'contact shadow');
  };

  function worldFloor(n,el){
    const y=Math.max(0,Math.min(H,worldScene.camera.horizonY));rect('sky',el,{x:0,y,w:W,h:H-y,fill:vgrad(darken(base(n),.15),base(n))},'same-camera ground plane');
    for(const [a,b] of require('./composer/perspective').floorGrid(worldScene.camera,8))line('sky',el,{x1:r(a.x),y1:r(a.y),x2:r(b.x),y2:r(b.y),stroke:rgba('#5c5550',.20),strokeWidth:.8},'world projected floor grid');
  }
  function worldFurniture(n,el){
    const materialPaint=require('../../../drawing-tool/src/core/material').materialPaint;
    const faces=n.worldFaces||[];
    const footprint=require('./composer/world-furniture').footprint(n.world),c=worldScene.camera;
    const shadow=[{x:footprint.x,y:0,z:footprint.z},{x:footprint.x+footprint.w,y:0,z:footprint.z},{x:footprint.x+footprint.w+.18,y:0,z:footprint.z+footprint.d+.12},{x:footprint.x+.18,y:0,z:footprint.z+footprint.d+.12}].map(c.project);
    if(shadow.every(Boolean))poly(n.plane,el,shadow,{fill:rgba('#111421',.22),blur:2},'world footprint contact shadow');
    for(const face of faces){
      const intensity=.72+.28*Math.max(0,face.normal.y*.75-face.normal.z*.5+(lightLeft?-1:1)*face.normal.x*.35);
      const natural=face.part==='mattress'||face.part==='pillow'?'#eee4ce':face.part==='blanket'?'#526b80':base(n),color=intensity<1?darken(natural,1-intensity):natural;
      const points=face.points.map(p=>({x:p.x,y:p.y}));
      const xs=points.map(p=>p.x),ys=points.map(p=>p.y),x=Math.min(...xs),y=Math.min(...ys),w=Math.max(...xs)-x,h=Math.max(...ys)-y;
      let mapped=points.map(p=>({x:(p.x-x)/Math.max(.01,w),y:(p.y-y)/Math.max(.01,h)}));
      let uv=face.uv;
      const area=mapped.reduce((sum,p,i)=>sum+p.x*mapped[(i+1)%4].y-mapped[(i+1)%4].x*p.y,0);if(area<0){mapped=mapped.reverse();uv=uv.slice().reverse();}
      poly(n.plane,el,points,{fill:materialPaint(face.material,color,ctx.seed||7,{mapping:{type:'quad',points:mapped,uv},repeatX:Math.max(.01,Math.min(256,face.edgeX*8)),repeatY:Math.max(.01,Math.min(256,face.edgeY*8))}),stroke:rgba(darken(color,.3),.45),strokeWidth:.8},'camera projected '+face.part+' '+face.material);
    }
  }
  const R = {
    sky(n, el) { grad('sky', el, { x: 0, y: 0, w: W, h: worldScene?H:n.box.h + 2, stops: [{ offset: 0, color: art.color.sky.top }, { offset: 1, color: art.color.sky.bottom }], gradientType: 'linear', angle: 90 }, 'sky gradient (art direction sky)'); },
    wall(n, el) { if(worldScene){rect('sky',el,{x:0,y:0,w:W,h:H,fill:base(n)},'world room wall behind projected floor');return;} const c = base(n); rect('sky', el, { x: 0, y: 0, w: W, h: n.box.h, fill: vgrad(lit(c, art), mix(c, art.lighting.fill, 0.15)) }, 'wall'); },
    floor(n, el) { if(worldScene){worldFloor(n,el);return;} const c = base(n); rect('sky', el, { x: 0, y: n.box.y, w: W, h: H - n.box.y, fill: vgrad(darken(c, 0.12), c) }, 'floor'); line('sky', el, { x1: 0, y1: n.box.y, x2: W, y2: n.box.y, stroke: darken(c, 0.35), strokeWidth: 3 }, 'wall/floor junction'); },
    ground(n, el) { if(worldScene){worldFloor(n,el);return;} const c = atPlane(n.ground === 'sand' ? '#d9c79e' : (n.ground === 'pavement' ? '#b7b2a8' : '#7da35e'), 'midground', art); const g = night ? mix(c, '#1b2340', 0.38) : c; rect('sky', el, { x: 0, y: n.box.y, w: W, h: H - n.box.y, fill: vgrad(mix(g, art.color.sky.bottom, 0.25), darken(g, 0.12)) }, `${n.ground} ground`); },
    sun(n, el) { const b = n.box; glow('sky', el, b.x + b.w / 2, b.y + b.h / 2, b.w * 1.6, '#fff3c4', 0.85, 'sun glow'); ell('sky', el, { x: b.x, y: b.y, w: b.w, h: b.h, fill: '#fff1b8' }, 'sun disc'); },
    moon(n, el) { const b = n.box;
      if(n.attributes.phase==='crescent') { push('draw.path','sky',el,{segments:[{op:'M',x:b.x+b.w*0.75,y:b.y},{op:'C',c1x:b.x-b.w*0.2,c1y:b.y,c2x:b.x-b.w*0.2,c2y:b.y+b.h,x:b.x+b.w*0.75,y:b.y+b.h},{op:'C',c1x:b.x+b.w*0.2,c1y:b.y+b.h*0.8,c2x:b.x+b.w*0.2,c2y:b.y+b.h*0.2,x:b.x+b.w*0.75,y:b.y}],closed:true,fill:'#f4f1e6'},'crescent silhouette');return; }
 glow('sky', el, b.x + b.w / 2, b.y + b.h / 2, b.w * 1.4, '#dfe8ff', 0.5, 'moon glow'); ell('sky', el, { x: b.x, y: b.y, w: b.w, h: b.h, fill: '#f4f1e6' }, 'moon disc'); ell('sky', el, { x: b.x + b.w * 0.55, y: b.y + b.h * 0.3, w: b.w * 0.18, h: b.h * 0.18, fill: rgba('#c9c3b2', 0.6) }, 'crater'); },
    stars(n, el) { const b = n.box; for (let i = 0; i < 26; i += 1) { const s = 1.5 + rand() * 3; ell('sky', el, { x: b.x + rand() * b.w, y: b.y + rand() * b.h, w: s, h: s, fill: rgba('#ffffff', 0.5 + rand() * 0.5) }, 'star'); } },
    clouds(n, el) { const b = n.box; const c = night ? '#46557e' : '#ffffff'; for (let i = 0; i < 4; i += 1) ell('sky', el, { x: b.x + b.w * (i * 0.2), y: b.y + b.h * (i % 2 ? 0.05 : 0.3), w: b.w * 0.45, h: b.h * (i % 2 ? 0.95 : 0.7), fill: rgba(c, 0.85), blur: 2 }, 'cloud lobe'); rect('sky', el, { x: b.x + b.w * 0.1, y: b.y + b.h * 0.6, w: b.w * 0.75, h: b.h * 0.25, fill: rgba(darken(c, 0.08), 0.7), radius: b.h * 0.12, blur: 2 }, 'cloud flat base'); },
    birds(n, el) { const b = n.box; for (let i = 0; i < 3; i += 1) { const x = b.x + b.w * (0.15 + i * 0.3); const y = b.y + b.h * (i % 2 ? 0.2 : 0.6); push('draw.path', 'sky', el, { segments: [{ op: 'M', x: r(x), y: r(y) }, { op: 'Q', cx: r(x + 10), cy: r(y - 8), x: r(x + 18), y: r(y) }, { op: 'Q', cx: r(x + 26), cy: r(y - 8), x: r(x + 36), y: r(y) }], closed: false, fill: null, stroke: base(n), strokeWidth: 2.5 }, 'bird'); } },
    mountains(n, el) {
      const b = n.box; const c = base(n); const peaks = 4; const pts = [{ x: 0, y: b.y + b.h }];
      for (let i = 0; i <= peaks * 2; i += 1) pts.push({ x: (W * i) / (peaks * 2), y: i % 2 ? b.y + b.h * (0.05 + rand() * 0.25) : b.y + b.h * (0.45 + rand() * 0.25) });
      pts.push({ x: W, y: b.y + b.h });
      poly(n.plane, el, pts, { fill: vgrad(lighten(c, 0.06), c), blur: blurOf(n) }, 'mountain range');
      for (let i = 1; i < pts.length - 1; i += 2) { const top = pts[i]; const foot = { x: top.x + (lightLeft ? 1 : -1) * W / (peaks * 2), y: b.y + b.h }; poly(n.plane, el, [top, foot, { x: top.x, y: b.y + b.h }], { fill: rgba(shade(c, art), 0.45), blur: 1 }, 'shadow side of the peak (away from the key light)'); }
    },
    hills(n, el) { const b = n.box; const c = base(n); push('draw.path', n.plane, el, { segments: [{ op: 'M', x: 0, y: r(b.y + b.h) }, { op: 'Q', cx: r(W * 0.25), cy: r(b.y - b.h * 0.3), x: r(W * 0.5), y: r(b.y + b.h * 0.4) }, { op: 'Q', cx: r(W * 0.78), cy: r(b.y + b.h * 0.9), x: W, y: r(b.y + b.h * 0.2) }, { op: 'L', x: W, y: r(H) }, { op: 'L', x: 0, y: r(H) }], closed: true, fill: vgrad(lit(c, art), c), blur: blurOf(n) }, 'rolling hills'); },
    dunes(n, el) { R.hills(n, el); },
    sea(n, el) {
      const b = n.box; const c = base(n);
      rect(n.plane, el, { x: 0, y: b.y, w: W, h: b.h, fill: vgrad(mix(c, art.color.sky.bottom, 0.45), darken(c, 0.15)) }, 'sea body; horizon takes the sky colour (reflections)');
      for (let i = 0; i < 12; i += 1) { const y = b.y + b.h * (0.1 + 0.85 * (i / 12) ** 1.4); const w = W * (0.04 + 0.1 * (i / 12)); const x = rand() * (W - w); line(n.plane, el, { x1: r(x), y1: r(y), x2: r(x + w), y2: r(y), stroke: rgba('#ffffff', 0.35), strokeWidth: 1 + i * 0.2, dash: [w * 0.4, w * 0.15] }, 'water highlight'); }
      const sun = graph.nodes.find((m) => m.motif === 'sun' || m.motif === 'moon');
      if (sun) rect('light', el, { x: sun.box.x + sun.box.w * 0.3, y: b.y, w: sun.box.w * 0.4, h: b.h * 0.8, fill: { type: 'linear', angle: 90, stops: [{ offset: 0, color: rgba('#fff3c4', 0.55) }, { offset: 1, color: rgba('#fff3c4', 0) }] }, blur: 6 }, 'reflected sun path');
    },
    lake(n, el) { const b = n.box; const c = base(n); ell(n.plane, el, { x: b.x, y: b.y, w: b.w, h: b.h, fill: vgrad(mix(c, art.color.sky.bottom, 0.5), c) }, 'lake reflecting the sky'); },
    river(n, el) { const b = n.box; const c = base(n); poly(n.plane, el, [{ x: b.x + b.w * 0.42, y: b.y }, { x: b.x + b.w * 0.58, y: b.y }, { x: b.x + b.w, y: b.y + b.h }, { x: b.x, y: b.y + b.h }], { fill: vgrad(mix(c, art.color.sky.bottom, 0.5), c) }, 'river narrowing toward the horizon'); },
    grass(n, el) { const b = n.box; const c = base(n); rect(n.plane, el, { x: 0, y: b.y, w: W, h: H - b.y, fill: vgrad(lit(c, art), darken(c, 0.15)) }, 'grass mass'); for (let i = 0; i < 18; i += 1) { const x = (W * (i + rand())) / 18; brush(n.plane, el, [{ x, y: H }, { x: x + (rand() - 0.5) * 20, y: H - b.h * (0.3 + rand() * 0.4) }], { color: darken(c, 0.2), brush: { preset: 'rough', size: 6, seed: 100 + i }, opacity: 0.6 }, 'dry-brush grass blades'); } },
    garden(n, el) { R.grass(n, el); R.flowers(n, el); },
    flowers(n, el) { const b = n.box; for (let i = 0; i < 10; i += 1) { const x = b.x + rand() * b.w; const y = b.y + rand() * b.h; line(n.plane, el, { x1: r(x), y1: r(y), x2: r(x), y2: r(y + 14), stroke: '#3d6b3d', strokeWidth: 2 }, 'stem'); ell(n.plane, el, { x: r(x - 5), y: r(y - 5), w: 10, h: 10, fill: i % 2 ? base(n) : lighten(base(n), 0.25) }, 'flower head'); } },
    rocks(n, el) { const b = n.box; const c = base(n); groundShadow(n, el, n.plane); poly(n.plane, el, [{ x: b.x, y: b.y + b.h }, { x: b.x + b.w * 0.15, y: b.y + b.h * 0.3 }, { x: b.x + b.w * 0.5, y: b.y }, { x: b.x + b.w * 0.85, y: b.y + b.h * 0.25 }, { x: b.x + b.w, y: b.y + b.h }], { fill: sideGrad(c) }, 'rock'); },
    trees(n, el) {
      const b = n.box; const c = base(n); groundShadow(n, el, n.plane);
      rect(n.plane, el, { x: b.x + b.w * 0.44, y: b.y + b.h * 0.55, w: b.w * 0.12, h: b.h * 0.45, fill: sideGrad(atPlane('#6b4a2f', n.plane, art)) }, 'trunk');
      [[0.05, 0.25, 0.6, 0.45], [0.35, 0.18, 0.6, 0.45], [0.18, 0, 0.64, 0.42]].forEach(([x, y, w, h], i) => ell(n.plane, el, { x: b.x + b.w * x, y: b.y + b.h * y, w: b.w * w, h: b.h * h, fill: sideGrad(i === 2 ? lighten(c, 0.05) : c), blur: blurOf(n) }, 'canopy mass'));
      brush(n.plane, el, [{ x: b.x + b.w * 0.2, y: b.y + b.h * 0.15 }, { x: b.x + b.w * 0.5, y: b.y + b.h * 0.08 }, { x: b.x + b.w * 0.8, y: b.y + b.h * 0.2 }], { color: lit(c, art), brush: { preset: 'rough', size: Math.max(6, b.w * 0.08), seed: 3 }, opacity: 0.5 }, 'lit foliage edge (dry brush)');
    },
    palms(n, el) {
      const b = n.box; const c = base(n); groundShadow(n, el, n.plane);
      brush(n.plane, el, [{ x: b.x + b.w * 0.5, y: b.y + b.h }, { x: b.x + b.w * 0.42, y: b.y + b.h * 0.5 }, { x: b.x + b.w * 0.55, y: b.y + b.h * 0.12 }], { color: atPlane('#7a5a3a', n.plane, art), brush: { preset: 'round', size: Math.max(6, b.w * 0.09), seed: 5 }, smooth: 0.8 }, 'curved trunk');
      for (let i = 0; i < 6; i += 1) { const a = (i / 6) * Math.PI * 2; const tip = { x: b.x + b.w * 0.55 + Math.cos(a) * b.w * 0.5, y: b.y + b.h * 0.14 + Math.abs(Math.sin(a)) * b.h * 0.12 + 6 }; push('draw.path', n.plane, el, { segments: [{ op: 'M', x: r(b.x + b.w * 0.55), y: r(b.y + b.h * 0.12) }, { op: 'Q', cx: r((b.x + b.w * 0.55 + tip.x) / 2), cy: r(b.y - b.h * 0.04), x: r(tip.x), y: r(tip.y) }], closed: false, fill: null, stroke: c, strokeWidth: Math.max(4, b.w * 0.07), cap: 'round' }, 'frond'); }
    },
    boat(n, el) { const b = n.box; const c = base(n); poly(n.plane, el, [{ x: b.x, y: b.y + b.h * 0.6 }, { x: b.x + b.w, y: b.y + b.h * 0.6 }, { x: b.x + b.w * 0.82, y: b.y + b.h }, { x: b.x + b.w * 0.18, y: b.y + b.h }], { fill: sideGrad(c) }, 'hull'); poly(n.plane, el, [{ x: b.x + b.w * 0.5, y: b.y }, { x: b.x + b.w * 0.5, y: b.y + b.h * 0.55 }, { x: b.x + b.w * 0.85, y: b.y + b.h * 0.55 }], { fill: lit('#f4efe4', art) }, 'sail'); line(n.plane, el, { x1: r(b.x + b.w * 0.1), y1: r(b.y + b.h + 3), x2: r(b.x + b.w * 0.9), y2: r(b.y + b.h + 3), stroke: rgba('#ffffff', 0.5), strokeWidth: 2 }, 'waterline ripple'); },
    lighthouse(n, el) { const b = n.box; const c = base(n); groundShadow(n, el, n.plane); poly(n.plane, el, [{ x: b.x + b.w * 0.2, y: b.y + b.h }, { x: b.x + b.w * 0.8, y: b.y + b.h }, { x: b.x + b.w * 0.65, y: b.y + b.h * 0.15 }, { x: b.x + b.w * 0.35, y: b.y + b.h * 0.15 }], { fill: sideGrad(c) }, 'tower'); for (let i = 1; i <= 3; i += 1) rect(n.plane, el, { x: b.x + b.w * (0.2 + i * 0.03), y: b.y + b.h * (0.15 + i * 0.2), w: b.w * (0.6 - i * 0.06), h: b.h * 0.07, fill: '#c0392b' }, 'stripe'); rect(n.plane, el, { x: b.x + b.w * 0.3, y: b.y, w: b.w * 0.4, h: b.h * 0.15, fill: night ? '#ffe9a8' : '#f2e3b0', radius: 4 }, 'lamp room'); },
    house(n, el) {
      // Shared house renderer: volume, roof, openings and the requested wall material as geometry.
      const a = n.attributes || {};
      const g = houseGeometry(n.box, { material: a.material, wallColor: a.color || (a.material ? null : base(n)), night, lightFromLeft: lightLeft, seed: (ctx.seed || 7) + 13 });
      for (const q of g.prims) {
        if (q.type === 'rect') rect(n.plane, el, q.params, q.note);
        else if (q.type === 'ellipse') ell(n.plane, el, q.params, q.note);
        else if (q.type === 'line') line(n.plane, el, q.params, q.note);
        else { const { points, ...style } = q.params; poly(n.plane, el, points, style, q.note); }
      }
    },
    building(n, el) {
      if(art.perspective.type==='three-point') {
        const {camera,boxFaces}=require('./composer/perspective');
        const cam=camera({width:W,height:H,cameraHeight:art.perspective.cameraHeight,pitch:art.perspective.cameraPitch});
        const origin=cam.unprojectGround(n.box.x+n.box.w*0.5,Math.max(cam.horizonY+H*0.08,n.box.y+n.box.h)) || {x:4,y:0,z:6};
        const depth=cam.project(origin).depth,unit=depth/(W*0.9);
        const faces=boxFaces(cam,origin,[n.box.w*unit*0.55,n.box.h*unit*0.85,n.box.w*unit*0.55]);
        for(let i=0;i<faces.length;i++) poly(n.plane,el,faces[i],{fill:i===0?base(n):i===1?darken(base(n),0.25):lighten(base(n),0.2),stroke:darken(base(n),0.4),strokeWidth:2},'three-point camera projected facade');
        return;
      }
      const b = n.box; const c = base(n); const glass = n.motif === 'tower'; groundShadow(n, el, n.plane);
      rect(n.plane, el, { x: b.x, y: b.y, w: b.w, h: b.h, fill: glass ? vgrad(mix(c, art.color.sky.top, 0.35), darken(c, 0.2)) : sideGrad(c) }, glass ? 'glass tower reflecting the sky' : 'facade');
      rect(n.plane, el, { x: lightLeft ? b.x + b.w * 0.7 : b.x, y: b.y, w: b.w * 0.3, h: b.h, fill: rgba(shade(c, art), 0.35) }, 'side in shadow');
      const cols = Math.max(2, Math.round(b.w / 40)); const rows = Math.min(14, Math.max(3, Math.round(b.h / 50)));
      for (let y = 0; y < rows; y += 1) rect(n.plane, el, { x: b.x + b.w * 0.08, y: b.y + b.h * (0.05 + (y * 0.9) / rows), w: b.w * 0.84, h: (b.h * 0.9) / rows * 0.45, fill: { type: 'pattern', kind: 'stripes', color: rgba(night ? '#ffd98a' : '#dfe8f5', night ? 0.7 : 0.5), scale: Math.max(4, b.w / cols / 2), angle: 90 } }, 'window row');
    },
    road(n, el) { const b = n.box; poly(n.plane, el, [{ x: b.x + b.w * 0.47, y: b.y }, { x: b.x + b.w * 0.53, y: b.y }, { x: b.x + b.w, y: H }, { x: b.x, y: H }], { fill: vgrad(atPlane('#6a6d73', 'background', art), '#4a4d52') }, 'road in perspective'); line(n.plane, el, { x1: b.x + b.w / 2, y1: b.y, x2: b.x + b.w / 2, y2: H, stroke: '#f2f0ea', strokeWidth: 4, dash: [24, 18] }, 'centre line'); },
    window(n, el) { const b = n.box; const c = base(n); rect(n.plane, el, { x: b.x - 8, y: b.y - 8, w: b.w + 16, h: b.h + 16, fill: darken(atPlane('#e9e0d2', n.plane, art), 0.15), radius: 4 }, 'window frame'); rect(n.plane, el, { x: b.x, y: b.y, w: b.w, h: b.h, fill: vgrad(art.color.sky.top, art.color.sky.bottom) }, 'glass showing the sky (reflections)'); line(n.plane, el, { x1: b.x + b.w / 2, y1: b.y, x2: b.x + b.w / 2, y2: b.y + b.h, stroke: lighten(c, 0.1), strokeWidth: 6 }, 'mullion'); line(n.plane, el, { x1: b.x, y1: b.y + b.h / 2, x2: b.x + b.w, y2: b.y + b.h / 2, stroke: lighten(c, 0.1), strokeWidth: 6 }, 'transom'); line(n.plane, el, { x1: b.x + b.w * 0.15, y1: b.y + b.h * 0.1, x2: b.x + b.w * 0.35, y2: b.y + b.h * 0.3, stroke: rgba('#ffffff', 0.6), strokeWidth: 3 }, 'glass highlight'); },
    frame(n, el) { const b = n.box; rect(n.plane, el, { x: b.x, y: b.y, w: b.w, h: b.h, fill: base(n), radius: 3, shadow: { color: 'rgba(0,0,0,0.3)', blur: 8, offsetX: 4 * dir, offsetY: 4 } }, 'frame'); rect(n.plane, el, { x: b.x + b.w * 0.1, y: b.y + b.h * 0.12, w: b.w * 0.8, h: b.h * 0.76, fill: vgrad(art.color.sky.top, mix(NATURAL.hills, '#ffffff', 0.2)) }, 'picture'); },
    clock(n, el) { const b = n.box; ell(n.plane, el, { x: b.x, y: b.y, w: b.w, h: b.h, fill: base(n), stroke: '#2b2b33', strokeWidth: 3, shadow: { color: 'rgba(0,0,0,0.25)', blur: 6, offsetX: 3 * dir, offsetY: 3 } }, 'clock face'); line(n.plane, el, { x1: b.x + b.w / 2, y1: b.y + b.h / 2, x2: b.x + b.w / 2, y2: b.y + b.h * 0.2, stroke: '#2b2b33', strokeWidth: 3 }, 'minute hand'); line(n.plane, el, { x1: b.x + b.w / 2, y1: b.y + b.h / 2, x2: b.x + b.w * 0.72, y2: b.y + b.h / 2, stroke: '#2b2b33', strokeWidth: 3 }, 'hour hand'); },
    tv(n, el) { const b = n.box; rect(n.plane, el, { x: b.x, y: b.y, w: b.w, h: b.h, fill: '#141418', radius: 6 }, 'tv bezel'); rect(n.plane, el, { x: b.x + 6, y: b.y + 6, w: b.w - 12, h: b.h - 12, fill: night ? vgrad('#5b8fd9', '#1d2f55') : vgrad('#2a2d36', '#15171c'), radius: 3 }, night ? 'lit screen (cool light)' : 'dark glass screen'); },
    bookshelf(n, el) { const b = n.box; const c = base(n); groundShadow(n, el, n.plane); rect(n.plane, el, { x: b.x, y: b.y, w: b.w, h: b.h, fill: sideGrad(c) }, 'case'); const shelves = 4; for (let s = 0; s < shelves; s += 1) { const y = b.y + b.h * (0.06 + (s * 0.9) / shelves); rect(n.plane, el, { x: b.x + b.w * 0.06, y, w: b.w * 0.88, h: (b.h * 0.9) / shelves - 6, fill: darken(c, 0.4) }, 'shelf recess'); let x = b.x + b.w * 0.08; while (x < b.x + b.w * 0.86) { const bw = 8 + rand() * 12; const bh = ((b.h * 0.9) / shelves - 10) * (0.7 + rand() * 0.3); rect(n.plane, el, { x: r(x), y: r(y + ((b.h * 0.9) / shelves - 6) - bh), w: r(bw), h: r(bh), fill: atPlane(['#7a2e2e', '#2e4a7a', '#3d6b3d', '#b08a2e', '#5b3a6b'][Math.floor(rand() * 5)], n.plane, art) }, 'book'); x += bw + 1; } } },
    sofa(n, el) { const b = n.box; const c = base(n); groundShadow(n, el, n.plane); rect(n.plane, el, { x: b.x, y: b.y, w: b.w, h: b.h * 0.6, fill: sideGrad(darken(c, 0.05)), radius: b.h * 0.12 }, 'backrest'); rect(n.plane, el, { x: b.x, y: b.y + b.h * 0.45, w: b.w, h: b.h * 0.45, fill: sideGrad(c), radius: b.h * 0.1 }, 'seat'); [0, 1].forEach((k) => rect(n.plane, el, { x: k ? b.x + b.w - b.w * 0.09 : b.x, y: b.y + b.h * 0.3, w: b.w * 0.09, h: b.h * 0.6, fill: sideGrad(lighten(c, 0.04)), radius: b.h * 0.08 }, 'arm')); [0.08, 0.88].forEach((k) => rect(n.plane, el, { x: b.x + b.w * k, y: b.y + b.h * 0.9, w: b.w * 0.04, h: b.h * 0.1, fill: '#3b2a1e' }, 'leg')); },
    armchair(n, el) {
      if(!n.attributes.dining){R.sofa(n,el);return;}
      const b=n.box,c=base({...n,motif:'diningTable'}),wood={type:'pattern',kind:'wood',color:darken(c,.16),background:lighten(c,.15),scale:7};groundShadow(n,el,n.plane);
      for(const k of [.08,.86])rect(n.plane,el,{x:b.x+b.w*k,y:b.y+b.h*.08,w:b.w*.07,h:b.h*.90,fill:wood},'wooden dining chair upright and leg');
      for(const k of [.1,.25,.4])rect(n.plane,el,{x:b.x+b.w*.08,y:b.y+b.h*k,w:b.w*.85,h:b.h*.07,fill:wood},'wooden dining back slat');
      rect(n.plane,el,{x:b.x,y:b.y+b.h*.58,w:b.w,h:b.h*.10,fill:wood,stroke:darken(c,.4),strokeWidth:1},'wooden dining seat');
    },
    desk(n, el) { const b = n.box; const c = base(n); groundShadow(n, el, n.plane); rect(n.plane, el, { x: b.x, y: b.y, w: b.w, h: b.h * 0.12, fill: { type: 'pattern', kind: 'wood', color: darken(c, 0.15), background: lit(c, art), scale: 8 } }, 'desk top (wood)'); [0.04, 0.9].forEach((k) => rect(n.plane, el, { x: b.x + b.w * k, y: b.y + b.h * 0.12, w: b.w * 0.06, h: b.h * 0.88, fill: sideGrad(c) }, 'leg')); rect(n.plane, el, { x: b.x + b.w * 0.6, y: b.y + b.h * 0.12, w: b.w * 0.3, h: b.h * 0.35, fill: sideGrad(darken(c, 0.08)) }, 'drawer'); },
    coffeeTable(n, el) { const b = n.box; const c = base(n); groundShadow(n, el, n.plane); rect(n.plane, el, { x: b.x, y: b.y, w: b.w, h: b.h * 0.3, fill: sideGrad(night?lighten(c,.32):c), stroke:darken(c,.45),strokeWidth:Math.max(1,b.h*.025), radius: 4 }, 'table top catching local light'); [0.06, 0.88].forEach((k) => rect(n.plane, el, { x: b.x + b.w * k, y: b.y + b.h * 0.3, w: b.w * 0.06, h: b.h * 0.7, fill: darken(c, 0.2) }, 'leg')); },
    lamp(n, el) { const b = n.box; groundShadow(n, el, n.plane); line(n.plane, el, { x1: b.x + b.w / 2, y1: b.y + b.h * 0.25, x2: b.x + b.w / 2, y2: b.y + b.h, stroke: '#3b3b40', strokeWidth: Math.max(3, b.w * 0.08) }, 'stand'); ell(n.plane, el, { x: b.x + b.w * 0.2, y: b.y + b.h * 0.96, w: b.w * 0.6, h: b.h * 0.04, fill: '#3b3b40' }, 'base'); poly(n.plane, el, [{ x: b.x + b.w * 0.2, y: b.y }, { x: b.x + b.w * 0.8, y: b.y }, { x: b.x + b.w, y: b.y + b.h * 0.25 }, { x: b.x, y: b.y + b.h * 0.25 }], { fill: night ? vgrad('#ffe7b0', '#f2c374') : sideGrad(base(n)), stroke:'#352819', strokeWidth:Math.max(3,b.w*0.08) }, night ? 'glowing shade' : 'shade'); },
    plant(n, el) { const b = n.box; const c = base(n); groundShadow(n, el, n.plane); poly(n.plane, el, [{ x: b.x + b.w * 0.2, y: b.y + b.h * 0.65 }, { x: b.x + b.w * 0.8, y: b.y + b.h * 0.65 }, { x: b.x + b.w * 0.7, y: b.y + b.h }, { x: b.x + b.w * 0.3, y: b.y + b.h }], { fill: sideGrad(atPlane('#b5653b', n.plane, art)) }, 'pot'); for (let i = 0; i < 6; i += 1) ell(n.plane, el, { x: b.x + b.w * (0.05 + (i % 3) * 0.3), y: b.y + b.h * (0.05 + Math.floor(i / 3) * 0.28), w: b.w * 0.42, h: b.h * 0.3, fill: sideGrad(i % 2 ? c : lighten(c, 0.08)) }, 'leaf cluster'); },
    rug(n, el) { const b = n.box; const c = base(n); ell(n.plane, el, { x: b.x, y: b.y, w: b.w, h: b.h, fill: c, stroke: lighten(c, 0.2), strokeWidth: 4 }, 'rug'); ell(n.plane, el, { x: b.x + b.w * 0.15, y: b.y + b.h * 0.2, w: b.w * 0.7, h: b.h * 0.6, fill: null, stroke: rgba(lighten(c, 0.3), 0.7), strokeWidth: 3, dash: [10, 6] }, 'rug pattern'); },
    notebook(n, el) { const b = n.box; const c = base(n); rect(n.plane, el, { x: b.x, y: b.y, w: b.w, h: b.h, fill: c, stroke: darken(c, 0.25), strokeWidth: 1.5, radius: 2, shadow: { color: 'rgba(0,0,0,0.25)', blur: 4, offsetX: 2 * dir, offsetY: 2 } }, 'notebook'); for (let i = 1; i <= 3; i += 1) line(n.plane, el, { x1: b.x + b.w * 0.1, y1: b.y + (b.h * i) / 4, x2: b.x + b.w * 0.9, y2: b.y + (b.h * i) / 4, stroke: rgba('#5a7bb0', 0.6), strokeWidth: 1 }, 'ruled line'); },
    pen(n, el) { const b = n.box; const c = base(n); poly(n.plane, el, [{ x: b.x, y: b.y + b.h * 0.5 }, { x: b.x + b.w * 0.12, y: b.y }, { x: b.x + b.w, y: b.y }, { x: b.x + b.w, y: b.y + b.h }, { x: b.x + b.w * 0.12, y: b.y + b.h }], { fill: sideGrad(c), shadow: { color: 'rgba(0,0,0,0.3)', blur: 3, offsetX: 2 * dir, offsetY: 2 } }, 'pen body'); rect(n.plane, el, { x: b.x + b.w * 0.82, y: b.y - 1, w: b.w * 0.05, h: b.h + 2, fill: '#c9a227' }, 'clip band'); },
    person(n, el) {
      if (n.attributes && n.attributes.rigPose) {
        const held=graph.nodes.find(q=>q.motif==='book' && q.parent===n.id);
        const hands=held ? {L:{x:held.box.x+held.box.w*0.15,y:held.box.y+held.box.h*0.65},R:{x:held.box.x+held.box.w*0.85,y:held.box.y+held.box.h*0.65}} : n.attributes.rigHands;
        const anatomy=require('./composer/anatomy-renderer').anatomyOperations(n.box,{pose:n.attributes.rigPose,frame:n.attributes.rigFrame,hands,shirt:base(n),appearance:ctx.understanding?.constraints.appearance});
        n.attributes.anatomy={contacts:anatomy.contacts,issues:anatomy.issues,clamped:anatomy.clamped};
        if(Object.values(anatomy.contacts).some(error=>error>1))throw Object.assign(new Error('Requested hand contact is outside the constrained arm reach'),{code:'ANATOMY_CONTACT_UNREACHABLE',details:{node:n.id,contacts:anatomy.contacts}});
        for(const op of anatomy.ops) {if(held&&op.stage==='contact-front'){const list=deferredHands.get(held.id)||[];list.push({op,layer:n.plane,element:el});deferredHands.set(held.id,list);}else push(op.op,n.plane,el,op.params,op.note);}
        return;
      }
      const b = n.box; const c = base(n); const head = b.h / 7.5; const cxp = b.x + b.w / 2; groundShadow(n, el, n.plane);
      const skin = atPlane('#d9a77c', n.plane, art); const pants = atPlane('#2d3142', n.plane, art);
      if (n.attributes.pose === 'seated') {
        [0.72,0.92].forEach((k,i)=>brush(n.plane,el,[{x:cxp-b.w*0.1,y:b.y+b.h*0.55},{x:b.x+b.w*k,y:b.y+b.h*0.64},{x:b.x+b.w*k,y:b.y+b.h*0.98}],{color:i ? darken(pants,0.1) : pants,brush:{preset:'round',size:b.w*0.18,seed:11+i}},'seated bent leg'));
      } else {
      brush(n.plane, el, [{ x: cxp - b.w * 0.12, y: b.y + b.h }, { x: cxp - b.w * 0.1, y: b.y + head * 4 }], { color: pants, brush: { preset: 'round', size: b.w * 0.2, seed: 11 } }, 'leg (line of action down to the supporting foot)');
      brush(n.plane, el, [{ x: cxp + b.w * 0.12, y: b.y + b.h }, { x: cxp + b.w * 0.1, y: b.y + head * 4 }], { color: darken(pants, 0.1), brush: { preset: 'round', size: b.w * 0.2, seed: 12 } }, 'leg');
      }
      rect(n.plane, el, { x: cxp - b.w * 0.28, y: b.y + head * 1.2, w: b.w * 0.56, h: head * 3, fill: sideGrad(c), radius: b.w * 0.12 }, 'torso (shirt)');
      [-1, 1].forEach((k) => brush(n.plane, el, [{ x: cxp + k * b.w * 0.3, y: b.y + head * 1.5 }, { x: cxp + k * b.w * 0.36, y: b.y + head * 3.8 }], { color: darken(c, 0.06), brush: { preset: 'round', size: b.w * 0.14, seed: 13 + k } }, 'arm'));
      ell(n.plane, el, { x: cxp - head * 0.42, y: b.y, w: head * 0.84, h: head, fill: sideGrad(skin) }, 'head (7.5-head proportion)');
      ell(n.plane, el, { x: cxp - head * 0.46, y: b.y - head * 0.06, w: head * 0.92, h: head * 0.5, fill: '#2b1d16' }, 'hair');
    },
  };
  R.tower = R.building;
  R.bed = (n,el) => {
    const b=n.box; groundShadow(n,el,n.plane);
    rect(n.plane,el,{x:b.x,y:b.y,w:b.w,h:b.h*0.58,fill:'#715640',radius:8},'bed headboard');
    rect(n.plane,el,{x:b.x,y:b.y+b.h*0.3,w:b.w,h:b.h*0.65,fill:'#e8dfce',radius:8},'mattress');
    [0.08,0.55].forEach(k=>rect(n.plane,el,{x:b.x+b.w*k,y:b.y+b.h*0.32,w:b.w*0.37,h:b.h*0.2,fill:'#faf1dc',radius:8},'pillow'));
    rect(n.plane,el,{x:b.x,y:b.y+b.h*0.55,w:b.w,h:b.h*0.4,fill:sideGrad('#526b80'),radius:5},'blanket');
    [0.06,0.9].forEach(k=>rect(n.plane,el,{x:b.x+b.w*k,y:b.y+b.h*0.95,w:b.w*0.04,h:b.h*0.05,fill:'#4a3427'},'bed leg'));
  };
  R.book = (n,el) => {
    const b=n.box;
    poly(n.plane,el,[{x:b.x,y:b.y},{x:b.x+b.w*0.5,y:b.y+b.h*0.15},{x:b.x+b.w,y:b.y},{x:b.x+b.w,y:b.y+b.h*0.85},{x:b.x+b.w*0.5,y:b.y+b.h},{x:b.x,y:b.y+b.h*0.85}],{fill:'#f3e8cd',stroke:'#65523e',strokeWidth:2},'open book pages');
    line(n.plane,el,{x1:b.x+b.w*0.5,y1:b.y+b.h*0.15,x2:b.x+b.w*0.5,y2:b.y+b.h,stroke:'#8e7759',strokeWidth:2},'book spine');
  };
  R.diningTable = (n, el) => { const b=n.box; groundShadow(n,el,n.plane); rect(n.plane,el,{x:b.x,y:b.y,w:b.w,h:b.h*0.32,fill:sideGrad('#865b39'),radius:5},'dining table top'); [0.05,0.88].forEach(k=>rect(n.plane,el,{x:b.x+b.w*k,y:b.y+b.h*0.16,w:b.w*0.07,h:b.h*0.84,fill:'#573b27'},'dining table leg')); };
  R.plate = (n,el) => { const b=n.box; ell(n.plane,el,{x:b.x,y:b.y,w:b.w,h:b.h,fill:'#eae8e0',stroke:'#777b85',strokeWidth:2},'plate rim'); ell(n.plane,el,{x:b.x+b.w*0.15,y:b.y+b.h*0.15,w:b.w*0.7,h:b.h*0.7,fill:'#d1d4db'},'plate well'); };
  R.cutlery = (n,el) => { const b=n.box; [0.2,0.75].forEach(k=>{line(n.plane,el,{x1:b.x+b.w*k,y1:b.y+b.h*0.25,x2:b.x+b.w*k,y2:b.y+b.h,stroke:'#bac2ca',strokeWidth:4},'utensil handle');}); [0.12,0.2,0.28].forEach(k=>line(n.plane,el,{x1:b.x+b.w*k,y1:b.y,x2:b.x+b.w*k,y2:b.y+b.h*0.3,stroke:'#bac2ca',strokeWidth:2},'fork tine')); };
  R.car = (n,el) => { const b=n.box; groundShadow(n,el,n.plane); rect(n.plane,el,{x:b.x,y:b.y+b.h*0.35,w:b.w,h:b.h*0.45,fill:sideGrad('#b94e42'),radius:12},'car body'); poly(n.plane,el,[{x:b.x+b.w*0.18,y:b.y+b.h*0.4},{x:b.x+b.w*0.32,y:b.y},{x:b.x+b.w*0.65,y:b.y},{x:b.x+b.w*0.85,y:b.y+b.h*0.4}],{fill:'#8eb3c5',stroke:'#442e32',strokeWidth:4},'car cabin'); [0.2,0.8].forEach(k=>ell(n.plane,el,{x:b.x+b.w*k-b.h*0.15,y:b.y+b.h*0.66,w:b.h*0.3,h:b.h*0.3,fill:'#25282d',stroke:'#c3c6ce',strokeWidth:3},'wheel')); };
  R.fireplace = (n,el) => { const b=n.box; rect(n.plane,el,{x:b.x,y:b.y,w:b.w,h:b.h,fill:'#8c7360'},'fireplace surround'); rect(n.plane,el,{x:b.x+b.w*0.15,y:b.y+b.h*0.25,w:b.w*0.7,h:b.h*0.7,fill:'#27232a'},'hearth'); poly(n.plane,el,[{x:b.x+b.w*0.25,y:b.y+b.h*0.85},{x:b.x+b.w*0.45,y:b.y+b.h*0.35},{x:b.x+b.w*0.53,y:b.y+b.h*0.65},{x:b.x+b.w*0.7,y:b.y+b.h*0.45},{x:b.x+b.w*0.78,y:b.y+b.h*0.85}],{fill:'#ed8c35'},'flames'); };


  const drawn = new Map();
  const ordered = graph.nodes.slice().sort((a, b) => a.z - b.z);
  const focal = art.composition.focal ? graph.nodes.find((n) => n.id === art.composition.focal) : null;
  for (const n of ordered) {
    // Partial compile (hybrid): only the nodes the composer cannot draw.
    if (ctx.only && !ctx.only.has(n.id)) continue;
    const el = n.id;
    const fn = R[n.motif];
    elements.push({ id: el, description: `${n.motif}${n.instance > 1 || n.id.includes('_') ? ` #${n.instance}` : ''} on the ${n.plane} plane (${n.anchor})${n.structural ? ' — structural context' : ''}` });
    if (!fn || !n.drawable) { drawn.set(el, 0); continue; }
    const before = ops.length;
    // focal-flagging: an opposite-value halo behind the focal subject.
    if (focal && focal.id === n.id && art.composition.flag) {
      glow(n.plane, el, n.box.x + n.box.w / 2, n.box.y + n.box.h * 0.45, Math.max(n.box.w, n.box.h) * 0.75, night ? '#ffe7b0' : '#ffffff', night ? 0.18 : 0.22, 'focal-flagging halo behind the focal subject');
    }
    if(n.worldFaces)worldFurniture(n,el);else fn(n, el);
    if(deferredHands.has(n.id))for(const item of deferredHands.get(n.id))push(item.op.op,item.layer,item.element,item.op.params,item.op.note+' in front of held object');
    drawn.set(el, ops.length - before);
  }

  if (ctx.only) return { spec: { version: 1, elements, layers: LAYERS.slice(), operations: ops }, check: null, drawn: Object.fromEntries(drawn) };
  // Light layer: key glow + night ambience + local lamp pool (chiaroscuro / local light source).
  elements.push({ id: 'lighting', description: `key light: ${art.lighting.type} from the ${art.lighting.side}, ${art.lighting.temperature}` });
  const k = art.lighting;
  if (night) {
    rect('light', 'lighting', { x: 0, y: 0, w: W, h: H, fill: rgba('#0c1430', 0.35), blend: 'multiply' }, 'night ambience (chiaroscuro)');
    const lamp = graph.nodes.find((n) => n.motif === 'lamp');
    if (lamp && k.type === 'lamp') glow('light', 'lighting', k.x, k.y, Math.max(W, H) * 0.38, '#ffc27a', 0.45, 'warm pool of the local lamp', 'screen');
  } else {
    glow('light', 'lighting', k.x, k.y, Math.max(W, H) * 0.55, k.temperature === 'warm' ? '#ffd59a' : '#fff6e0', 0.28, 'key light falloff', 'screen');
    grad('light', 'lighting', { x: 0, y: 0, w: W, h: H, gradientType: 'linear', angle: k.side === 'left' ? 0 : 180, stops: [{ offset: 0, color: rgba('#ffffff', 0) }, { offset: 1, color: rgba(k.fill, 0.12) }], blend: 'multiply' }, 'cool fill on the shadow side');
  }

  const spec = { version: 1, elements, layers: LAYERS.slice(), operations: ops };
  const check = checkSceneSpec(spec, graph, art, ctx);
  return { spec, check, drawn: Object.fromEntries(drawn) };
}

/** Completeness and feasibility of a SceneSpec against its graph and art direction. */
function checkSceneSpec(spec, graph, art, context) {
  const ctx = context || {};
  const issues = [];
  const W = graph.canvas.width; const H = graph.canvas.height;
  try { validateSceneSpec(spec); } catch (error) { issues.push({ code: 'INVALID', message: error.message }); }
  const opsBy = {};
  spec.operations.forEach((op) => { opsBy[op.element] = (opsBy[op.element] || 0) + 1; });
  const layerIndex = Object.fromEntries(spec.layers.map((l, i) => [l.id, i]));
  for (const n of graph.nodes) {
    if (n.drawable && !n.structural && !opsBy[n.id]) issues.push({ code: 'NODE_NOT_DRAWN', node: n.id });
    if (!n.drawable) issues.push({ code: 'NO_MOTIF', node: n.id, blocking: false });
  }
  for (const e of (ctx.understanding ? ctx.understanding.entities : [])) {
    const drawnInstances = graph.nodes.filter((n) => n.entity === e.id && opsBy[n.id]).length;
    if (graph.nodes.some((n) => n.entity === e.id && n.drawable) && drawnInstances < Math.min(e.count, 12)) issues.push({ code: 'COUNT_SHORT', entity: e.id, requested: e.count, drawn: drawnInstances });
  }
  for (const op of spec.operations) {
    const node = graph.nodes.find((n) => n.id === op.element);
    if (node && op.layer !== 'light' && layerIndex[op.layer] !== undefined && node.plane !== 'sky' && op.layer !== 'sky' && layerIndex[op.layer] !== layerIndex[node.plane]) { issues.push({ code: 'LAYER_ORDER', element: op.element, layer: op.layer, plane: node.plane }); break; }
  }
  const out = spec.operations.filter((op) => { const p = op.params; return Number.isFinite(p.x) && Number.isFinite(p.w) && (p.x > W || p.x + p.w < 0 || p.y > H || p.y + p.h < 0); });
  if (out.length) issues.push({ code: 'OUT_OF_BOUNDS', count: out.length });
  if (ctx.noText && spec.operations.some((op) => op.op === 'draw.text')) issues.push({ code: 'TEXT_FORBIDDEN' });
  if (art.lighting && !spec.operations.some((op) => op.layer === 'light')) issues.push({ code: 'NO_LIGHT_LAYER' });
  if (spec.operations.length > 1200) issues.push({ code: 'OP_LIMIT', count: spec.operations.length });
  const blocking = issues.filter((i) => i.blocking !== false && !['NO_MOTIF'].includes(i.code));
  return { complete: blocking.length === 0, executable: !issues.some((i) => ['INVALID', 'OP_LIMIT'].includes(i.code)), operations: spec.operations.length, elements: spec.elements.length, issues };
}

module.exports = { compileSceneSpec, checkSceneSpec, NATURAL };
