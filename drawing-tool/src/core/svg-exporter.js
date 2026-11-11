'use strict';

/**
 * Editable SVG export (plan item 9): vectors stay vectors, text stays text.
 *
 * rect/ellipse/line/polygon/path → SVG shapes; text → <text> per laid-out line (RTL direction, font, alignment);
 * linear/radial gradients → <defs>; opacity, blend (mix-blend-mode), blur and shadow (filters), rotation,
 * rect/ellipse/path clips and layer opacity/visibility are kept. What SVG cannot express identically
 * (stamp brushes, image assets, pattern/conic paints, arrows) is rasterised for that ONE object only and embedded
 * as an <image> at its box, and listed in `rasterized`. Whole-canvas effects are reported, not faked.
 */

const { createCanvas } = require('@napi-rs/canvas');
const { bboxOf, drawObject } = require('./renderer');
const { layoutText, normalizeFont } = require('./text');
const { encodePng } = require('./png');

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const fontAlias = family => 'ArtForge Embedded ' + family.replace(/[^a-zA-Z0-9 _-]/g, '');
const embeddedFamily = (font,opts) => opts.embedFonts!==false && require('node:fs').existsSync(require('node:path').join(__dirname,'../../fonts',font.family+'-'+(font.weight>=600?'Bold':'Regular')+'.ttf')) ? fontAlias(font.family) : font.family;
const n = (v) => Math.round(Number(v) * 100) / 100;

function exportSvg(doc, options) {
  const opts = options || {};
  const W = doc.canvas.width; const H = doc.canvas.height;
  const measure = createCanvas(8, 8).getContext('2d');
  const defs = [];
  const warnings = [];
  const stats = { vector: 0, text: 0, rasterized: [] };
  const usedFonts = new Map();
  let uid = 0;
  let activeLayer=null;
  const id = (p) => `${p}${(uid += 1)}`;

  function paint(p, box) {
    if (p === undefined || p === null || p === 'none') return 'none';
    if (typeof p === 'string') return esc(p);
    if (p.type === 'linear') {
      const a = ((Number(p.angle || 0) % 360) * Math.PI) / 180;
      const cx = box.x + box.w / 2; const cy = box.y + box.h / 2;
      const half = (Math.abs(Math.cos(a)) * box.w + Math.abs(Math.sin(a)) * box.h) / 2;
      const gid = id('g');
      defs.push(`<linearGradient id="${gid}" gradientUnits="userSpaceOnUse" x1="${n(cx - Math.cos(a) * half)}" y1="${n(cy - Math.sin(a) * half)}" x2="${n(cx + Math.cos(a) * half)}" y2="${n(cy + Math.sin(a) * half)}">${p.stops.map((s) => `<stop offset="${n(s.offset)}" stop-color="${esc(s.color)}"/>`).join('')}</linearGradient>`);
      return `url(#${gid})`;
    }
    if (p.type === 'radial') {
      const cx = box.x + box.w * (p.cx === undefined ? 0.5 : p.cx); const cy = box.y + box.h * (p.cy === undefined ? 0.5 : p.cy);
      const r = Math.max(1, Math.max(box.w, box.h) * (p.r === undefined ? 0.5 : p.r));
      const gid = id('g');
      defs.push(`<radialGradient id="${gid}" gradientUnits="userSpaceOnUse" cx="${n(cx)}" cy="${n(cy)}" r="${n(r)}">${p.stops.map((s) => `<stop offset="${n(s.offset)}" stop-color="${esc(s.color)}"/>`).join('')}</radialGradient>`);
      return `url(#${gid})`;
    }
    return null; // conic, pattern: not expressible identically
  }

  const rasterizable = (o) => o.type === 'brush' || o.type === 'image' || (o.type === 'line' && o.arrow && o.arrow !== 'none')
    || [o.fill, o.stroke].some((p) => p && typeof p === 'object' && !['linear', 'radial'].includes(p.type));

  function rasterObject(o, box, lit=false) {
    const pad = Math.ceil(Number(o.blur || 0) * 3 + (o.shadow ? Number(o.shadow.blur || 0) * 2 + Math.abs(Number(o.shadow.offsetX || 0)) + Math.abs(Number(o.shadow.offsetY || 0)) : 0) + 2);
    const x = Math.max(0, Math.floor(box.x - pad)); const y = Math.max(0, Math.floor(box.y - pad));
    const w = Math.max(1, Math.min(W, Math.ceil(box.x + box.w + pad)) - x); const h = Math.max(1, Math.min(H, Math.ceil(box.y + box.h + pad)) - y);
    if(lit&&W*H>4000000)throw Object.assign(new Error('Scoped light export exceeds4MP bounded world-coordinate budget'),{code:'EFFECT_EXPORT_TOO_LARGE'});
    const canvas = createCanvas(w, h);
    const world = lit ? createCanvas(W,H) : canvas;
    const ctx = world.getContext('2d');
    if(!lit)ctx.translate(-x, -y);
    drawObject(ctx, o, null, opts.images || {}, (m) => warnings.push(m), {lights:[...(doc.canvas.lights||[]),...((activeLayer&&activeLayer.lights)||[])],layerId:activeLayer&&activeLayer.id,width:W,height:H});
    if(lit)canvas.getContext('2d').drawImage(world,x,y,w,h,0,0,w,h);
    stats.rasterized.push({ id: o.id, type: o.type,reason:o.fill&&typeof o.fill==='object'?o.fill.type:'unsupported-svg-or-scoped-light' });
    return `<image x="${x}" y="${y}" width="${w}" height="${h}" href="data:image/png;base64,${encodePng(canvas).toString('base64')}"/>`;
  }

  function common(o, box) {
    const parts = [];
    if (o.opacity !== undefined && Number(o.opacity) < 1) parts.push(`opacity="${n(o.opacity)}"`);
    const style = [];
    if (o.blend && o.blend !== 'source-over') style.push(`mix-blend-mode:${o.blend === 'lighter' ? 'plus-lighter' : o.blend}`);
    if (style.length) parts.push(`style="${style.join(';')}"`);
    const filters = [];
    if (Number(o.blur) > 0) filters.push(`<feGaussianBlur stdDeviation="${n(Number(o.blur) / 2)}"/>`);
    if (o.shadow) filters.push(`<feDropShadow dx="${n(o.shadow.offsetX || 0)}" dy="${n(o.shadow.offsetY || 0)}" stdDeviation="${n(Number(o.shadow.blur || 0) / 2)}" flood-color="${esc(o.shadow.color || 'rgba(0,0,0,0.5)')}"/>`);
    if (filters.length) { const fid = id('f'); defs.push(`<filter id="${fid}" x="-50%" y="-50%" width="200%" height="200%">${filters.join('')}</filter>`); parts.push(`filter="url(#${fid})"`); }
    if (o.clip) {
      const c = o.clip; const cid = id('c');
      const shape = c.type === 'ellipse' ? `<ellipse cx="${n(c.x + c.w / 2)}" cy="${n(c.y + c.h / 2)}" rx="${n(c.w / 2)}" ry="${n(c.h / 2)}"/>`
        : (c.type === 'path' ? `<path d="${pathD(c.segments, true)}"/>` : `<rect x="${n(c.x)}" y="${n(c.y)}" width="${n(c.w)}" height="${n(c.h)}"${c.radius ? ` rx="${n(c.radius)}"` : ''}/>`);
      defs.push(`<clipPath id="${cid}">${shape}</clipPath>`); parts.push(`clip-path="url(#${cid})"`);
    }
    if (Number(o.rotation) && o.type !== 'text') parts.push(`transform="rotate(${n(o.rotation)} ${n(box.x + box.w / 2)} ${n(box.y + box.h / 2)})"`);
    return parts.length ? ` ${parts.join(' ')}` : '';
  }

  function layerFilter(f){const fid=id('lf'),parts=[];for(const [key,v] of Object.entries(f)){if(key==='blur')parts.push('<feGaussianBlur stdDeviation="'+n(v/2)+'"/>');else if(key==='saturate'||key==='hueRotate')parts.push('<feColorMatrix type="'+(key==='hueRotate'?'hueRotate':'saturate')+'" values="'+n(v)+'"/>');else if(key==='brightness'||key==='contrast'||key==='opacity'){const slope=key==='contrast'?v:1,intercept=key==='contrast'?0.5-v*0.5:0;parts.push('<feComponentTransfer>'+['R','G','B'].map(c=>'<feFunc'+c+' type="linear" slope="'+n(key==='brightness'?v:slope)+'" intercept="'+n(intercept)+'"/>').join('')+(key==='opacity'?'<feFuncA type="linear" slope="'+n(v)+'"/>':'')+'</feComponentTransfer>');}else if(key==='grayscale')parts.push('<feColorMatrix type="saturate" values="'+n(1-v)+'"/>');else warnings.push('Unsupported SVG layer filter '+key);}defs.push('<filter id="'+fid+'" x="-50%" y="-50%" width="200%" height="200%">'+parts.join('')+'</filter>');return fid;}

  function strokeAttrs(o, box) {
    if (!o.stroke || !(Number(o.strokeWidth) > 0)) return '';
    const s = paint(o.stroke, box);
    return ` stroke="${s}" stroke-width="${n(o.strokeWidth)}"${Array.isArray(o.dash) && o.dash.length ? ` stroke-dasharray="${o.dash.map(n).join(' ')}"` : ''}${o.cap ? ` stroke-linecap="${esc(o.cap)}"` : ''} stroke-linejoin="round"`;
  }

  function pathD(segments, closed) {
    const d = (segments || []).map((s) => {
      if (s.op === 'M' || s.op === 'L') return `${s.op}${n(s.x)} ${n(s.y)}`;
      if (s.op === 'Q') return `Q${n(s.cx)} ${n(s.cy)} ${n(s.x)} ${n(s.y)}`;
      if (s.op === 'C') return `C${n(s.c1x)} ${n(s.c1y)} ${n(s.c2x)} ${n(s.c2y)} ${n(s.x)} ${n(s.y)}`;
      return 'Z';
    }).join(' ');
    return closed && !/Z$/.test(d) ? `${d} Z` : d;
  }

  function roundRectD(x, y, w, h, r) {
    const [tl, tr, br, bl] = (Array.isArray(r) ? r : [r, r, r, r]).map((v) => Math.min(Number(v) || 0, w / 2, h / 2));
    return `M${n(x + tl)} ${n(y)} H${n(x + w - tr)} Q${n(x + w)} ${n(y)} ${n(x + w)} ${n(y + tr)} V${n(y + h - br)} Q${n(x + w)} ${n(y + h)} ${n(x + w - br)} ${n(y + h)} H${n(x + bl)} Q${n(x)} ${n(y + h)} ${n(x)} ${n(y + h - bl)} V${n(y + tl)} Q${n(x)} ${n(y)} ${n(x + tl)} ${n(y)} Z`;
  }

  function objectSvg(o) {
    const box = bboxOf(o, measure);
    const lights=[...(doc.canvas.lights||[]),...((activeLayer&&activeLayer.lights)||[])];
    const lit=lights.length && require('./lighting').matchingLights(lights,{object:o,layerId:activeLayer&&activeLayer.id}).length;
    // Text already supports native SVG clip/filter composition and must remain editable.
    if (rasterizable(o) || lit || (o.type !== 'text' && o.clip && (o.blur || o.shadow))) return rasterObject(o, box,lit);
    const fill = paint(o.fill, box);
    const c = common(o, box);
    stats.vector += 1;
    switch (o.type) {
      case 'rect': return Array.isArray(o.radius)
        ? `<path d="${roundRectD(o.x, o.y, o.w, o.h, o.radius)}" fill="${fill}"${strokeAttrs(o, box)}${c}/>`
        : `<rect x="${n(o.x)}" y="${n(o.y)}" width="${n(o.w)}" height="${n(o.h)}"${o.radius ? ` rx="${n(o.radius)}"` : ''} fill="${fill}"${strokeAttrs(o, box)}${c}/>`;
      case 'ellipse': return `<ellipse cx="${n(o.x + o.w / 2)}" cy="${n(o.y + o.h / 2)}" rx="${n(o.w / 2)}" ry="${n(o.h / 2)}" fill="${fill}"${strokeAttrs(o, box)}${c}/>`;
      case 'line': return `<line x1="${n(o.x1)}" y1="${n(o.y1)}" x2="${n(o.x2)}" y2="${n(o.y2)}"${strokeAttrs(Object.assign({ stroke: '#000', strokeWidth: 2 }, o), box) || ' stroke="#000"'}${c}/>`;
      case 'polygon': {
        const pts = o.points.map((p) => `${n(p.x)},${n(p.y)}`).join(' ');
        return o.closed === false ? `<polyline points="${pts}" fill="none"${strokeAttrs(o, box)}${c}/>` : `<polygon points="${pts}" fill="${fill}"${strokeAttrs(o, box)}${c}/>`;
      }
      case 'path': return `<path d="${pathD(o.segments, o.closed)}" fill="${o.closed ? fill : (o.fill ? fill : 'none')}"${strokeAttrs(o, box)}${c}/>`;
      case 'network': {
        // Vector network: one <path> per filled face, then all edges as one stroked <path>.
        const SH = require('./shapes');
        const faces = (o.regions || []).filter((r) => r.fill).map((r) => `<path d="${pathD(SH.networkRegionSegments(o, r).filter((s) => s.op !== 'Z'), true)}" fill="${paint(r.fill, box) || 'none'}"/>`).join('');
        return `<g data-network="${esc(o.id)}"${c}>${faces}<path d="${pathD(SH.networkEdgeSegments(o), false)}" fill="none"${strokeAttrs(o, box)}/></g>`;
      }
      case 'text': {
        stats.text += 1; stats.vector -= 1;
        const font = normalizeFont(o.font);
        if (!usedFonts.has(font.family)) usedFonts.set(font.family, new Set());
        usedFonts.get(font.family).add(font.weight || 400);
        const layout = layoutText(measure, Object.assign({}, o, { font }));
        // SVG start/end follow paragraph direction; Canvas left/right are physical.
        const anchor = layout.align === 'center' ? 'middle' : ((layout.align === 'right') !== layout.rtl ? 'end' : 'start');
        const baseline = 'alphabetic';
        const baselineOffset = layout.baseline === 'alphabetic' ? 0 : layout.ascent;
        const rot = Number(o.rotation) ? ` transform="rotate(${n(o.rotation)} ${n(box.x + box.w / 2)} ${n(box.y + box.h / 2)})"` : '';
        // Keep Canvas paragraph direction on every line: plaintext would autodetect a Latin-first line.
        const runLine = (line) => line.pieces.slice().sort((a, b) => a.start - b.start).map((p) => {
          const attrs = [];
          if (!usedFonts.has(p.font.family)) usedFonts.set(p.font.family, new Set());
          usedFonts.get(p.font.family).add(p.font.weight || 400);
          if (p.font.family !== font.family) attrs.push(`font-family="${esc(embeddedFamily(p.font, opts))}"`);
          if (p.font.size !== font.size) attrs.push(`font-size="${n(p.font.size)}"`);
          if (p.font.weight !== font.weight) attrs.push(`font-weight="${esc(p.font.weight)}"`);
          if (p.font.style !== font.style) attrs.push(`font-style="${esc(p.font.style)}"`);
          if (p.fill !== undefined) attrs.push(`fill="${paint(p.fill, box) || 'none'}"`);
          if (p.underline) attrs.push('text-decoration="underline"');
          return attrs.length ? `<tspan ${attrs.join(' ')}>${esc(p.draw)}</tspan>` : esc(p.draw);
        }).join('');
        const lines = layout.lines.map((line, i) => `<text x="${n(o.x)}" y="${n(Number(o.y) + baselineOffset + (layout.runs ? line.top + line.ascent - layout.lines[0].ascent : i * layout.lineHeight))}" text-anchor="${anchor}" dominant-baseline="${baseline}"${layout.rtl ? ' direction="rtl" unicode-bidi="embed"' : ''}>${layout.runs ? runLine(line) : esc(line.text)}</text>`).join('');
        return `<g font-family="${esc(embeddedFamily(font,opts))}" font-size="${n(font.size)}" font-weight="${esc(font.weight || 400)}" font-style="${esc(font.style)}" letter-spacing="${n(font.letterSpacing)}" fill="${fill}"${strokeAttrs(o, box)}${c}${rot}>${lines}</g>`;
      }
      default: stats.vector -= 1; return rasterObject(o, box);
    }
  }

  const body = [];
  const bg = doc.canvas.background || { type: 'none' };
  if (bg.type === 'solid' && bg.color) body.push(`<rect width="${W}" height="${H}" fill="${esc(bg.color)}"/>`);
  else if (bg.type === 'gradient' && bg.gradient) body.push(`<rect width="${W}" height="${H}" fill="${paint(bg.gradient, { x: 0, y: 0, w: W, h: H }) || 'none'}"/>`);
  // Layer groups (v2) nest as <g>. A pass-through group at full opacity is a plain <g>, which SVG does
  // not isolate; a group with a blend mode or Normal ('source-over') is isolated like in the renderer.
  const groupSvg = (node) => {
    const g = node.layer;
    const attrs = [`id="${esc(g.id)}"`, `data-name="${esc(g.name || '')}"`, 'data-type="group"'];
    const style = [];
    if (g.opacity !== undefined && Number(g.opacity) < 1) {
      attrs.push(`opacity="${n(g.opacity)}"`);
      if ((g.blend || 'pass-through') === 'pass-through') warnings.push(`group "${g.name || g.id}": pass-through with opacity is exported as an isolated SVG group; blended layers inside may differ`);
    }
    if (g.blend && g.blend !== 'pass-through') {
      style.push('isolation:isolate');
      if (g.blend !== 'source-over') style.push(`mix-blend-mode:${g.blend === 'lighter' ? 'plus-lighter' : g.blend}`);
    }
    if (style.length) attrs.push(`style="${style.join(';')}"`);
    return `<g ${attrs.join(' ')}>${nodesSvg(node.children)}</g>`;
  };
  // Masks and clipping groups have no faithful SVG equivalent here either: that part is exported as an
  // image of exactly those layers (with a warning), the rest stays vector.
  const rasterPart = (id, name, layers, opacity, blend, reason) => {
    const single = Object.assign({}, doc, { canvas: Object.assign({}, doc.canvas, { background: { type: 'none' }, effects: [] }), layers });
    const { canvas } = require('./exporter').renderToCanvas(single, { images: opts.images || {}, applyAnimation: false });
    warnings.push(`"${name || id}": ${reason} exported as an image; its shapes and text are not editable in the SVG`);
    stats.rasterized.push({ id, type: 'layer-raster', reason });
    const attrs = [`id="${esc(id)}"`, `data-name="${esc(name || '')}"`, `data-raster="${esc(reason)}"`];
    if (opacity !== undefined && Number(opacity) < 1) attrs.push(`opacity="${n(opacity)}"`);
    if (blend && blend !== 'source-over' && blend !== 'pass-through') attrs.push(`style="mix-blend-mode:${blend}"`);
    return `<g ${attrs.join(' ')}><image x="0" y="0" width="${W}" height="${H}" href="data:image/png;base64,${canvas.toBuffer('image/png').toString('base64')}"/></g>`;
  };
  const hasMask = (l) => Boolean((l.mask && l.mask.enabled !== false) || (l.vectorMask && l.vectorMask.enabled !== false));
  const subtreeOf = (group) => {
    const inside = require('./layer-tree').descendantIds(doc.layers, group.id);
    return [Object.assign({}, group, { parentId: undefined, opacity: 1, blend: group.blend === 'pass-through' ? 'pass-through' : 'source-over' })]
      .concat(doc.layers.filter((l) => inside.has(l.id)));
  };
  const nodesSvg = (nodes) => {
    const parts = [];
    for (let i = 0; i < nodes.length; i += 1) {
      const node = nodes[i];
      let j = i + 1;
      while (!node.children && !node.layer.clipped && j < nodes.length && !nodes[j].children && nodes[j].layer.clipped) j += 1;
      if (j > i + 1) {
        const base = node.layer;
        if (base.visible !== false) {
          const run = [Object.assign({}, base, { parentId: undefined, opacity: 1, blend: 'source-over' })]
            .concat(nodes.slice(i + 1, j).map((n) => Object.assign({}, n.layer, { parentId: undefined })));
          parts.push(rasterPart(base.id, base.name, run, base.opacity, base.blend, 'clipping group'));
        }
        i = j - 1;
        continue;
      }
      if (node.layer.visible === false) continue;
      if (node.children && hasMask(node.layer)) parts.push(rasterPart(node.layer.id, node.layer.name, subtreeOf(node.layer), node.layer.opacity, node.layer.blend, 'group mask'));
      else parts.push(node.children ? groupSvg(node) : layerSvg(node.layer));
    }
    return parts.join('');
  };
  // Layer effects (shadows, glows, bevels, strokes, overlays) have no faithful SVG equivalent, so a styled
  // layer is exported as an image of that layer, said so in the warnings, never silently dropped.
  const styledLayerSvg = (layer) => {
    const single = Object.assign({}, doc, {
      canvas: Object.assign({}, doc.canvas, { background: { type: 'none' }, effects: [] }),
      layers: [Object.assign({}, layer, { opacity: 1, blend: 'source-over', parentId: undefined })],
    });
    const { canvas } = require('./exporter').renderToCanvas(single, { images: opts.images || {}, applyAnimation: false });
    warnings.push(`layer "${layer.name || layer.id}": ${layer.raster ? 'pixels' : hasMask(layer) ? 'mask/effects' : 'effects'} exported as an image${layer.raster ? '' : '; its shapes and text are not editable in the SVG'}`);
    stats.rasterized.push({ id: layer.id, type: 'layer-effects', reason: (layer.effects || []).filter((e) => e.enabled !== false).map((e) => e.type).concat(layer.fillOpacity < 1 ? ['fillOpacity'] : []).join(',') });
    const attrs = [`id="${esc(layer.id)}"`, `data-name="${esc(layer.name || '')}"`, 'data-effects="rasterized"'];
    if (layer.opacity !== undefined && Number(layer.opacity) < 1) attrs.push(`opacity="${n(layer.opacity)}"`);
    if (layer.blend && layer.blend !== 'source-over') attrs.push(`style="mix-blend-mode:${layer.blend}"`);
    return `<g ${attrs.join(' ')}><image x="0" y="0" width="${W}" height="${H}" href="data:image/png;base64,${canvas.toBuffer('image/png').toString('base64')}"/></g>`;
  };
  const styled = (layer) => Boolean((layer.effects && layer.effects.some((e) => e.enabled !== false)) || (layer.fillOpacity !== undefined && layer.fillOpacity < 1) || hasMask(layer) || Boolean(layer.raster && Object.keys(layer.raster.tiles).length));
  const layerSvg = (layer) => {
    if (styled(layer)) return styledLayerSvg(layer);
    activeLayer=layer;
    const attrs = [`id="${esc(layer.id)}"`, `data-name="${esc(layer.name || '')}"`];
    if (layer.opacity !== undefined && Number(layer.opacity) < 1) attrs.push(`opacity="${n(layer.opacity)}"`);
    if (layer.blend && layer.blend !== 'source-over') attrs.push(`style="mix-blend-mode:${layer.blend}"`);
    const t=layer.transform||{};if(Object.values(t).some(v=>Number(v)))attrs.push('transform="translate('+n(t.x||0)+' '+n(t.y||0)+') translate('+n(t.pivotX||0)+' '+n(t.pivotY||0)+') rotate('+n(t.rotation||0)+') scale('+n(t.scaleX===undefined?1:t.scaleX)+' '+n(t.scaleY===undefined?1:t.scaleY)+') translate('+n(-(t.pivotX||0))+' '+n(-(t.pivotY||0))+')"');
    if(layer.filter)attrs.push('filter="url(#'+layerFilter(layer.filter)+')"');
    if (false) warnings.push(`layer "${layer.name || layer.id}" filter is not exported (raster-only)`);
    return `<g ${attrs.join(' ')}>${(layer.objects || []).filter((o) => o.visible !== false).map(objectSvg).join('')}</g>`;
  };
  body.push(nodesSvg(require('./layer-tree').buildTree(doc.layers)));
  if (false) warnings.push(`canvas effects (${Object.keys(doc.canvas.effects).join(', ')}) are raster post-processing and are not in the SVG`);
  if(doc.canvas.effects && doc.canvas.effects.length){const effect=require('./export-effects').finishingOverlay(doc,opts.images||{});if(effect.mask){const mid=id('finishmask');defs.push('<mask id="'+mid+'" maskUnits="userSpaceOnUse" x="0" y="0" width="'+W+'" height="'+H+'"><image width="'+W+'" height="'+H+'" href="data:image/png;base64,'+effect.mask.toString('base64')+'"/></mask>');body.splice(0,body.length,'<g mask="url(#'+mid+')">'+body.join('')+'</g>');}body.push('<image width="'+W+'" height="'+H+'" href="data:image/png;base64,'+effect.png.toString('base64')+'" data-artforge-effect="finishing-delta"/>');stats.rasterized.push({id:'canvas-finishing',type:'effect-overlay',reason:doc.canvas.effects.map(e=>e.type).join(','),changedPixels:effect.changedPixels,replacedAlphaPixels:effect.replacedAlphaPixels});}
  // Bundled OFL fonts used by the text are embedded, so Arabic shaping works in any viewer without installing them.
  const fontCss = [];
  if (opts.embedFonts !== false) {
    const fs = require('node:fs'); const path = require('node:path');
    const dir = path.join(__dirname, '..', '..', 'fonts');
    for (const [family, weights] of usedFonts) {
      for (const weight of weights) {
        const bold = Number(weight) >= 600;
        const file = path.join(dir, `${family}-${bold ? 'Bold' : 'Regular'}.ttf`);
        if (!fs.existsSync(file)) { warnings.push(`Font ${family} weight ${weight} is not bundled; viewer fallback may differ`); continue; }
        fontCss.push(`@font-face{font-family:'${fontAlias(family)}';font-weight:${bold ? 700 : 400};src:url(data:font/ttf;base64,${fs.readFileSync(file).toString('base64')}) format('truetype');}`);
      }
    }
  }
  if (fontCss.length) defs.unshift(`<style>${fontCss.join('')}</style>`);
  const svg = `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${defs.length ? `<defs>${defs.join('')}</defs>` : ''}${body.join('')}</svg>\n`;
  return { svg, vectorObjects: stats.vector, textObjects: stats.text, rasterized: stats.rasterized, warnings };
}

module.exports = { exportSvg };
