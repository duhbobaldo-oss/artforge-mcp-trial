'use strict';

/**
 * ArtForge shared renderer.
 * Pure CanvasRenderingContext2D drawing code: the same file renders the
 * authoritative Node export and the browser live view.
 */

const { createPaint } = require('./paint');
const { resolveAnimation } = require('./animation');
const { drawBrushObject, brushBBox } = require('./brush');
const { fillPattern, makeCanvas, filterString, applyEffects, parseRgba } = require('./effects');
const { buildTree } = require('./layer-tree');
const { applyLayerStyles } = require('./layer-styles');
const { renderCoverage, finishMask } = require('./coverage');
const { adjustCanvas, applyFilterStack } = require('./adjustments');

const hasFilters = (layer) => Boolean(layer.filters && layer.filters.some((f) => f.enabled !== false));

// Layer effects or a reduced fill opacity need the layer flattened on its own surface first.
const hasStyles = (layer) => Boolean((layer.effects && layer.effects.some((e) => e.enabled !== false))
  || (layer.fillOpacity !== undefined && layer.fillOpacity < 1));
const { layoutText, fontString, normalizeFont, bidiIsolate, isolate } = require('./text');

const DEG = Math.PI / 180;

function num(value, fallback) {
  return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function applyShadow(ctx, shadow) {
  if (!shadow) return;
  ctx.shadowColor = shadow.color || 'rgba(0,0,0,0.35)';
  ctx.shadowBlur = Math.max(0, num(shadow.blur, 0));
  ctx.shadowOffsetX = num(shadow.offsetX, 0);
  ctx.shadowOffsetY = num(shadow.offsetY, 0);
}

// Native Canvas and Chromium use different shadow kernels/compositing for
// translucent drawImage. Material/mesh isolation uses one bounded alpha mask
// with three box passes (Gaussian approximation) on both runtimes instead.
function isolatedShadowRaster(surface, shadow) {
  const scale=Math.min(1,512/Math.max(surface.width,surface.height));
  const w=Math.max(1,Math.round(surface.width*scale)),h=Math.max(1,Math.round(surface.height*scale));
  const mask=makeCanvas(w,h),mc=mask.getContext('2d');mc.drawImage(surface,0,0,w,h);
  const data=mc.getImageData(0,0,w,h);let color=parseRgba(shadow.color||'rgba(0,0,0,0.35)');
  if(!color){const probe=makeCanvas(1,1).getContext('2d');probe.fillStyle=shadow.color;probe.fillRect(0,0,1,1);const p=probe.getImageData(0,0,1,1).data;color={r:p[0],g:p[1],b:p[2],a:p[3]/255};}
  let alpha=new Float32Array(w*h),temp=new Float32Array(w*h);
  for(let i=0;i<alpha.length;i++)alpha[i]=data.data[i*4+3];
  const radius=Math.ceil(Math.max(0,num(shadow.blur,0))*scale*.5);
  if(radius){const divisor=2*radius+1;
    for(let pass=0;pass<3;pass++){
      for(let y=0;y<h;y++){let sum=0;for(let x=0;x<=Math.min(radius,w-1);x++)sum+=alpha[y*w+x];for(let x=0;x<w;x++){temp[y*w+x]=sum/divisor;if(x-radius>=0)sum-=alpha[y*w+x-radius];if(x+radius+1<w)sum+=alpha[y*w+x+radius+1];}}
      for(let x=0;x<w;x++){let sum=0;for(let y=0;y<=Math.min(radius,h-1);y++)sum+=temp[y*w+x];for(let y=0;y<h;y++){alpha[y*w+x]=sum/divisor;if(y-radius>=0)sum-=temp[(y-radius)*w+x];if(y+radius+1<h)sum+=temp[(y+radius+1)*w+x];}}
    }
  }
  for(let i=0;i<alpha.length;i++){const k=i*4;data.data[k]=color.r;data.data[k+1]=color.g;data.data[k+2]=color.b;data.data[k+3]=Math.round(alpha[i]*color.a);}
  mc.putImageData(data,0,0);return mask;
}

function clearShadow(ctx) {
  ctx.shadowColor = 'transparent';
  ctx.shadowBlur = 0;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 0;
}

function setDash(ctx, dash) {
  ctx.setLineDash(Array.isArray(dash) && dash.length ? dash.map((d) => Math.max(0, Number(d) || 0)) : []);
}

function roundedRectPath(ctx, box, radius) {
  const r = Array.isArray(radius) ? radius : [num(radius, 0), num(radius, 0), num(radius, 0), num(radius, 0)];
  const limit = Math.min(Math.abs(box.w), Math.abs(box.h)) / 2;
  const corners = r.map((value) => clamp(num(value, 0), 0, limit));
  const [tl, tr, br, bl] = corners;
  ctx.beginPath();
  ctx.moveTo(box.x + tl, box.y);
  ctx.lineTo(box.x + box.w - tr, box.y);
  ctx.quadraticCurveTo(box.x + box.w, box.y, box.x + box.w, box.y + tr);
  ctx.lineTo(box.x + box.w, box.y + box.h - br);
  ctx.quadraticCurveTo(box.x + box.w, box.y + box.h, box.x + box.w - br, box.y + box.h);
  ctx.lineTo(box.x + bl, box.y + box.h);
  ctx.quadraticCurveTo(box.x, box.y + box.h, box.x, box.y + box.h - bl);
  ctx.lineTo(box.x, box.y + tl);
  ctx.quadraticCurveTo(box.x, box.y, box.x + tl, box.y);
  ctx.closePath();
}

function ellipsePath(ctx, box) {
  ctx.beginPath();
  ctx.ellipse(box.x + box.w / 2, box.y + box.h / 2, Math.abs(box.w) / 2, Math.abs(box.h) / 2, 0, 0, Math.PI * 2);
  ctx.closePath();
}

function polygonPath(ctx, points, closed) {
  if (!Array.isArray(points) || points.length === 0) return false;
  ctx.beginPath();
  points.forEach((point, index) => {
    if (index === 0) ctx.moveTo(num(point.x, 0), num(point.y, 0));
    else ctx.lineTo(num(point.x, 0), num(point.y, 0));
  });
  if (closed) ctx.closePath();
  return true;
}

function pathFromSegments(ctx, segments, closed) {
  if (!Array.isArray(segments) || segments.length === 0) return false;
  ctx.beginPath();
  for (const seg of segments) {
    const op = String(seg.op || '').toUpperCase();
    if (op === 'M') ctx.moveTo(num(seg.x, 0), num(seg.y, 0));
    else if (op === 'L') ctx.lineTo(num(seg.x, 0), num(seg.y, 0));
    else if (op === 'Q') ctx.quadraticCurveTo(num(seg.cx, 0), num(seg.cy, 0), num(seg.x, 0), num(seg.y, 0));
    else if (op === 'C') {
      ctx.bezierCurveTo(num(seg.c1x, 0), num(seg.c1y, 0), num(seg.c2x, 0), num(seg.c2y, 0), num(seg.x, 0), num(seg.y, 0));
    } else if (op === 'Z') ctx.closePath();
  }
  if (closed) ctx.closePath();
  return true;
}

function drawArrowHead(ctx, from, to, size, color) {
  const angle = Math.atan2(to.y - from.y, to.x - from.x);
  const len = Math.max(4, size);
  ctx.save();
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(to.x, to.y);
  ctx.lineTo(to.x - len * Math.cos(angle - Math.PI / 7), to.y - len * Math.sin(angle - Math.PI / 7));
  ctx.lineTo(to.x - len * Math.cos(angle + Math.PI / 7), to.y - len * Math.sin(angle + Math.PI / 7));
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function bboxOf(obj, measureCtx) {
  switch (obj.type) {
    case 'ellipse':
    case 'rect':
    case 'image':
      return { x: num(obj.x, 0), y: num(obj.y, 0), w: num(obj.w, 0), h: num(obj.h, 0) };
    case 'line':
      return {
        x: Math.min(num(obj.x1, 0), num(obj.x2, 0)),
        y: Math.min(num(obj.y1, 0), num(obj.y2, 0)),
        w: Math.abs(num(obj.x2, 0) - num(obj.x1, 0)),
        h: Math.abs(num(obj.y2, 0) - num(obj.y1, 0)),
      };
    case 'network':
    case 'polygon': {
      const pts = Array.isArray(obj.points) ? obj.points : [];
      const xs = pts.map((p) => num(p.x, 0));
      const ys = pts.map((p) => num(p.y, 0));
      const minX = xs.length ? Math.min.apply(null, xs) : 0;
      const minY = ys.length ? Math.min.apply(null, ys) : 0;
      return {
        x: minX,
        y: minY,
        w: (xs.length ? Math.max.apply(null, xs) : 0) - minX,
        h: (ys.length ? Math.max.apply(null, ys) : 0) - minY,
      };
    }
    case 'path': {
      const segs = Array.isArray(obj.segments) ? obj.segments : [];
      const xs = [];
      const ys = [];
      for (const s of segs) {
        ['x', 'cx', 'c1x', 'c2x'].forEach((k) => {
          if (Number.isFinite(Number(s[k]))) xs.push(Number(s[k]));
        });
        ['y', 'cy', 'c1y', 'c2y'].forEach((k) => {
          if (Number.isFinite(Number(s[k]))) ys.push(Number(s[k]));
        });
      }
      const minX = xs.length ? Math.min.apply(null, xs) : 0;
      const minY = ys.length ? Math.min.apply(null, ys) : 0;
      return {
        x: minX,
        y: minY,
        w: (xs.length ? Math.max.apply(null, xs) : 0) - minX,
        h: (ys.length ? Math.max.apply(null, ys) : 0) - minY,
      };
    }
    case 'brush':
      return brushBBox(obj);
    case 'text': {
      const font = normalizeFont(obj.font);
      let layout;
      if (measureCtx) {
        layout = layoutText(measureCtx, obj);
      } else {
        const approxWidth = String(obj.text || '').length * font.size * 0.55;
        layout = {
          boxWidth: obj.maxWidth ? Math.min(obj.maxWidth, approxWidth) : approxWidth,
          boxHeight: Math.max(1, String(obj.text || '').split('\n').length) * font.size * font.lineHeight,
          align: obj.align || 'right',
        };
      }
      const w = layout.boxWidth;
      const h = layout.boxHeight;
      const align = layout.align;
      const x = num(obj.x, 0);
      // alphabetic: y is the first baseline, so the box starts one ascent above it.
      const y = num(obj.y, 0) - (obj.baseline === 'alphabetic' && layout.ascent ? layout.ascent : 0);
      if (align === 'right') return { x: x - w, y, w, h };
      if (align === 'center') return { x: x - w / 2, y, w, h };
      return { x, y, w, h };
    }
    default:
      return { x: num(obj.x, 0), y: num(obj.y, 0), w: num(obj.w, 0), h: num(obj.h, 0) };
  }
}

function resolveObject(obj, override) {
  const out = Object.assign({}, obj);
  if (!override) return out;
  if (override.x !== undefined) out.x = override.x;
  if (override.y !== undefined) out.y = override.y;
  if (override.w !== undefined) out.w = override.w;
  if (override.h !== undefined) out.h = override.h;
  if (override.rotation !== undefined) out.rotation = override.rotation;
  if (override.fontSize !== undefined) {
    out.font = Object.assign({}, out.font, { size: override.fontSize });
  }
  if (override.scale !== undefined && override.scale !== 1) {
    const bbox = bboxOf(out);
    const scale = override.scale;
    out.w = bbox.w * scale;
    out.h = bbox.h * scale;
    out.x = bbox.x + bbox.w / 2 - out.w / 2;
    out.y = bbox.y + bbox.h / 2 - out.h / 2;
  }
  if (override.opacity !== undefined) {
    out.opacity = clamp(num(out.opacity, 1) * num(override.opacity, 1), 0, 1);
  }
  return out;
}

function fillAndStroke(ctx, obj, bbox, warn, images) {
  const hasFill = obj.fill !== undefined && obj.fill !== null;
  if (hasFill && obj.fill.type === 'pattern') {
    if (obj.fill.background) { ctx.fillStyle = obj.fill.background; ctx.fill(); }
    fillPattern(ctx, obj.fill, bbox);
  } else if(hasFill && obj.fill.type==='material') {
    require('./material').fillMaterial(ctx,obj.fill,bbox,images);
  } else if (hasFill && obj.fill.type==='mesh') {
    require('./mesh-gradient').fillMesh(ctx,obj.fill,bbox);
  } else if (hasFill) {
    ctx.fillStyle = createPaint(ctx, obj.fill, bbox);
    ctx.fill();
  }
  const strokeWidth = num(obj.strokeWidth, 0);
  if (obj.stroke && strokeWidth > 0) {
    ctx.strokeStyle = createPaint(ctx, obj.stroke, bbox);
    ctx.lineWidth = strokeWidth;
    ctx.lineJoin = obj.lineJoin || 'miter';
    ctx.lineCap = obj.lineCap || 'butt';
    setDash(ctx, obj.dash);
    ctx.stroke();
    setDash(ctx, []);
  }
}

function drawTextObject(ctx, obj, warn) {
  if(obj.fill && obj.fill.type==='mesh' && warn) warn('Mesh text paint uses the linear fallback');
  const font = normalizeFont(obj.font);
  ctx.font = fontString(font);
  const layout = layoutText(ctx, Object.assign({}, obj, { font }));
  ctx.textBaseline = layout.baseline === 'alphabetic' ? 'alphabetic' : 'top';
  const x = num(obj.x, 0);
  const y = num(obj.y, 0);
  const align = layout.align;
  ctx.textAlign = align === 'right' ? 'right' : align === 'center' ? 'center' : 'left';
  const letterSpacing = font.letterSpacing || 0;
  const supportsLetterSpacing = typeof ctx.letterSpacing === 'string';
  if (letterSpacing !== 0 && !supportsLetterSpacing) {
    if (warn) warn(`letterSpacing is not supported by the Node rendering backend; ignored for "${obj.id || 'text'}"`);
  }
  const letterSpacingActive = letterSpacing !== 0 && supportsLetterSpacing;
  if (letterSpacingActive) ctx.letterSpacing = `${letterSpacing}px`;
  const bbox = bboxOf(Object.assign({}, obj, { font }), ctx);
  const height = Math.max(layout.lines.length * layout.lineHeight, 1);
  const paintBox = { x: bbox.x, y: bbox.y, w: bbox.w, h: height };
  if (warn && layout.overflowWords && layout.overflowWords.length) {
    warn(`text "${obj.id || 'text'}" has ${layout.overflowWords.length} word(s) wider than maxWidth: ${layout.overflowWords.slice(0, 3).join(' | ')}`);
  }
  ctx.save();
  if (num(obj.rotation, 0)) {
    const cx = bbox.x + bbox.w / 2;
    const cy = bbox.y + bbox.h / 2;
    ctx.translate(cx, cy);
    ctx.rotate(num(obj.rotation, 0) * DEG);
    ctx.translate(-cx, -cy);
  }
  applyShadow(ctx, obj.shadow);
  const strokeWidth = num(obj.strokeWidth, 0);
  if (layout.runs) {
    // Styled runs: each piece in its own font/fill, placed in visual order on a shared baseline.
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    const top0 = layout.baseline === 'alphabetic' ? y - (layout.lines[0] ? layout.lines[0].ascent : 0) : y;
    for (const line of layout.lines) {
      const startX = align === 'right' ? x - line.width : align === 'center' ? x - line.width / 2 : x;
      // Same placement as plain text (em top at the line top); the tallest piece sets the baseline.
      const baseY = top0 + line.top + line.ascent;
      for (const piece of line.pieces) {
        if (!piece.draw) continue;
        ctx.font = fontString(piece.font);
        const text = isolate(piece.draw, piece.resolved);
        const fill = piece.fill !== undefined ? piece.fill : obj.fill;
        if (fill !== undefined && fill !== null) {
          ctx.fillStyle = createPaint(ctx, fill, paintBox);
          ctx.fillText(text, startX + piece.x, baseY);
          if (piece.underline) ctx.fillRect(startX + piece.x, baseY + piece.font.size * 0.1, piece.width, Math.max(1, piece.font.size / 16));
        }
        if (obj.stroke && strokeWidth > 0) {
          clearShadow(ctx);
          ctx.strokeStyle = createPaint(ctx, obj.stroke, paintBox);
          ctx.lineWidth = strokeWidth;
          ctx.lineJoin = 'round';
          ctx.strokeText(text, startX + piece.x, baseY);
          applyShadow(ctx, obj.shadow);
        }
      }
    }
    ctx.font = fontString(font);
  }
  for (let index = 0; !layout.runs && index < layout.lines.length; index += 1) {
    const line = layout.lines[index];
    const lineY = y + index * layout.lineHeight;
    if (obj.fill !== undefined && obj.fill !== null) {
      ctx.fillStyle = createPaint(ctx, obj.fill, paintBox);
      ctx.fillText(bidiIsolate(line.text, layout.rtl), x, lineY);
    }
    if (obj.stroke && strokeWidth > 0) {
      clearShadow(ctx);
      ctx.strokeStyle = createPaint(ctx, obj.stroke, paintBox);
      ctx.lineWidth = strokeWidth;
      ctx.lineJoin = 'round';
      ctx.strokeText(bidiIsolate(line.text, layout.rtl), x, lineY);
    }
  }
  if (letterSpacingActive) ctx.letterSpacing = '0px';
  ctx.restore();
  clearShadow(ctx);
  return layout;
}

function drawImageObject(ctx, obj, images, warn) {
  const image = images && obj.assetId ? images[obj.assetId] : null;
  if (!image) {
    if (warn) warn(`image asset "${obj.assetId}" is not available; object "${obj.id || ''}" skipped`);
    return;
  }
  const x = num(obj.x, 0);
  const y = num(obj.y, 0);
  const w = num(obj.w, image.width);
  const h = num(obj.h, image.height);
  const fit = obj.fit || 'fill';
  const iw = image.width || w;
  const ih = image.height || h;
  ctx.save();
  applyShadow(ctx, obj.shadow);
  if (num(obj.radius, 0) > 0) {
    roundedRectPath(ctx, { x, y, w, h }, obj.radius);
    ctx.clip();
  }
  if (obj.flipX || obj.flipY) {
    ctx.translate(x + w / 2, y + h / 2);
    ctx.scale(obj.flipX ? -1 : 1, obj.flipY ? -1 : 1);
    ctx.translate(-(x + w / 2), -(y + h / 2));
  }
  if (fit === 'fill' || !iw || !ih) {
    ctx.drawImage(image, x, y, w, h);
  } else {
    const scale = fit === 'contain' ? Math.min(w / iw, h / ih) : Math.max(w / iw, h / ih);
    const dw = iw * scale;
    const dh = ih * scale;
    ctx.drawImage(image, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
  }
  ctx.restore();
  clearShadow(ctx);
}

function applyClip(ctx, clip) {
  if (clip.type === 'path') {
    if (!pathFromSegments(ctx, clip.segments, true)) return;
  } else if (clip.type === 'ellipse') {
    ellipsePath(ctx, { x: num(clip.x, 0), y: num(clip.y, 0), w: num(clip.w, 0), h: num(clip.h, 0) });
  } else {
    roundedRectPath(ctx, { x: num(clip.x, 0), y: num(clip.y, 0), w: num(clip.w, 0), h: num(clip.h, 0) }, clip.radius || 0);
  }
  ctx.clip();
}

function drawObject(ctx, obj, override, images, warn, options) {
  const resolved = resolveObject(obj, override);
  const renderOptions=options||{};
  const lights=require('./lighting').matchingLights(renderOptions.lights||[],{object:resolved,layerId:renderOptions.layerId});
  const isolatedShadow=resolved.shadow && resolved.fill && ['mesh','material'].includes(resolved.fill.type) && resolved.type!=='text';
  if(renderOptions.isolate!==false && (lights.length || isolatedShadow)) {
    const box=bboxOf(resolved,ctx),angle=num(resolved.rotation,0)*DEG,cx=box.x+box.w/2,cy=box.y+box.h/2;
    const rw=Math.abs(Math.cos(angle))*box.w+Math.abs(Math.sin(angle))*box.h,rh=Math.abs(Math.sin(angle))*box.w+Math.abs(Math.cos(angle))*box.h;
    const shadow=resolved.shadow||{},pad=Math.ceil(num(resolved.blur,0)*3+num(shadow.blur,0)*3+Math.abs(num(shadow.offsetX,0))+Math.abs(num(shadow.offsetY,0))+4);
    const x=Math.floor(cx-rw/2-pad),y=Math.floor(cy-rh/2-pad),w=Math.max(1,Math.ceil(rw+2*pad)),h=Math.max(1,Math.ceil(rh+2*pad));
    if(w*h>16000000)throw Object.assign(new Error('Lit/shadowed object exceeds bounded offscreen surface'),{code:'RENDER_RESOURCE_LIMIT'});
    const surface=makeCanvas(w,h),sc=surface.getContext('2d');sc.translate(-x,-y);
    drawObject(sc,Object.assign({},resolved,{blend:'source-over',shadow:isolatedShadow?undefined:resolved.shadow}),null,images,warn,{isolate:false});
    if(lights.length)require('./lighting').applyLighting(sc,lights,renderOptions.width||ctx.canvas.width,renderOptions.height||ctx.canvas.height,{origin:{x,y},transform:ctx.getTransform()});
    ctx.save();if(resolved.blend&&resolved.blend!=='source-over')ctx.globalCompositeOperation=resolved.blend;
    if(isolatedShadow)ctx.drawImage(isolatedShadowRaster(surface,resolved.shadow),x+num(resolved.shadow.offsetX,0),y+num(resolved.shadow.offsetY,0),w,h);ctx.drawImage(surface,x,y);ctx.restore();clearShadow(ctx);return;
  }
  const opacity = clamp(num(resolved.opacity, 1), 0, 1);
  ctx.save();
  ctx.globalAlpha *= opacity;
  if (resolved.blend && resolved.blend !== 'source-over') ctx.globalCompositeOperation = resolved.blend;
  if (resolved.clip) applyClip(ctx, resolved.clip);
  // Gaussian blur per object: soft shadows, glow, atmospheric depth, smooth colour transitions.
  if (num(resolved.blur, 0) > 0 && 'filter' in ctx) ctx.filter = `blur(${num(resolved.blur, 0)}px)`;
  if (num(resolved.rotation, 0) && resolved.type !== 'text') {
    const bbox = bboxOf(resolved, ctx);
    const cx = bbox.x + bbox.w / 2;
    const cy = bbox.y + bbox.h / 2;
    ctx.translate(cx, cy);
    ctx.rotate(num(resolved.rotation, 0) * DEG);
    ctx.translate(-cx, -cy);
  }
  switch (resolved.type) {
    case 'rect': {
      const box = { x: num(resolved.x, 0), y: num(resolved.y, 0), w: num(resolved.w, 0), h: num(resolved.h, 0) };
      roundedRectPath(ctx, box, resolved.radius || 0);
      applyShadow(ctx, resolved.shadow);
      fillAndStroke(ctx, resolved, box, warn, images);
      break;
    }
    case 'ellipse': {
      const box = { x: num(resolved.x, 0), y: num(resolved.y, 0), w: num(resolved.w, 0), h: num(resolved.h, 0) };
      ellipsePath(ctx, box);
      applyShadow(ctx, resolved.shadow);
      fillAndStroke(ctx, resolved, box, warn, images);
      break;
    }
    case 'line': {
      const from = { x: num(resolved.x1, 0), y: num(resolved.y1, 0) };
      const to = { x: num(resolved.x2, 0), y: num(resolved.y2, 0) };
      ctx.beginPath();
      ctx.moveTo(from.x, from.y);
      ctx.lineTo(to.x, to.y);
      ctx.strokeStyle = createPaint(ctx, resolved.stroke || '#000000', bboxOf(resolved));
      ctx.lineWidth = Math.max(0.5, num(resolved.strokeWidth, 2));
      ctx.lineCap = resolved.cap || 'round';
      setDash(ctx, resolved.dash);
      applyShadow(ctx, resolved.shadow);
      ctx.stroke();
      clearShadow(ctx);
      setDash(ctx, []);
      const arrowSize = num(resolved.arrowSize, ctx.lineWidth * 3);
      if (resolved.arrow === 'end' || resolved.arrow === 'both') {
        drawArrowHead(ctx, from, to, arrowSize, resolved.stroke || '#000000');
      }
      if (resolved.arrow === 'start' || resolved.arrow === 'both') {
        drawArrowHead(ctx, to, from, arrowSize, resolved.stroke || '#000000');
      }
      break;
    }
    case 'network': {
      // Filled faces first, then every edge stroked once (edges may branch from any vertex).
      const SH = require('./shapes');
      const box = bboxOf(resolved);
      applyShadow(ctx, resolved.shadow);
      for (const region of resolved.regions || []) {
        if (!region.fill || !pathFromSegments(ctx, SH.networkRegionSegments(resolved, region), true)) continue;
        fillAndStroke(ctx, { fill: region.fill }, box, warn, images);
      }
      if (resolved.stroke && pathFromSegments(ctx, SH.networkEdgeSegments(resolved), false)) {
        fillAndStroke(ctx, Object.assign({}, resolved, { fill: null }), box, warn, images);
      }
      break;
    }
    case 'polygon': {
      if (!polygonPath(ctx, resolved.points, resolved.closed !== false)) break;
      applyShadow(ctx, resolved.shadow);
      fillAndStroke(ctx, resolved, bboxOf(resolved), warn, images);
      break;
    }
    case 'path': {
      if (!pathFromSegments(ctx, resolved.segments, resolved.closed)) break;
      applyShadow(ctx, resolved.shadow);
      fillAndStroke(ctx, resolved, bboxOf(resolved), warn, images);
      break;
    }
    case 'text': {
      drawTextObject(ctx, resolved, warn);
      break;
    }
    case 'image': {
      drawImageObject(ctx, resolved, images, warn);
      break;
    }
    case 'brush': {
      drawBrushObject(ctx, resolved);
      break;
    }
    default:
      if (warn) warn(`unknown object type "${resolved.type}" skipped`);
      break;
  }
  if ('filter' in ctx && ctx.filter && ctx.filter !== 'none') ctx.filter = 'none';
  ctx.restore();
}

function drawBackground(ctx, doc) {
  const background = doc.canvas.background;
  if (!background || background.type === 'none') return;
  const box = { x: 0, y: 0, w: doc.canvas.width, h: doc.canvas.height };
  ctx.save();
  if (background.type === 'gradient' && background.gradient) {
    ctx.fillStyle = createPaint(ctx, background.gradient, box);
  } else {
    ctx.fillStyle = background.color || '#ffffff';
  }
  ctx.fillRect(0, 0, doc.canvas.width, doc.canvas.height);
  ctx.restore();
}

// True when an object composites against the backdrop with something other than source-over (an
// explicit object blend, or a brush whose wet edge multiplies internally). Such objects make an
// isolated surface differ from pass-through, so translucent normal layers must keep the backdrop.
function seesBackdrop(object) {
  return Boolean((object.blend && object.blend !== 'source-over') || object.type === 'brush');
}

// How one layer is composited.
//  v1 documents: 'legacy' / 'legacy-filter' — the historical behaviour, unchanged.
//  v2 documents: group semantics. A normal layer is a pass-through group; a layer with a blend mode or
//  filter is an isolated group. 'direct' when opacity is 1 and nothing needs isolating (identical result).
function layerCompositeMode(v2, layer, opacity, blend, ctx) {
  if (!v2) return layer.filter && ctx.canvas ? 'legacy-filter' : 'legacy';
  if (!ctx.canvas) return 'direct-legacy'; // no surface to isolate into: best-effort legacy path
  const hasFilter = Boolean(layer.filter && Object.keys(layer.filter).length);
  if (hasFilter || blend !== 'source-over' || hasStyles(layer) || hasMask(layer) || hasFilters(layer) || layer.blendIf) return 'isolated';
  if (opacity >= 1) return 'direct';
  // With only source-over objects, pass-through at opacity o equals an isolated surface composited
  // at o, and the isolated surface needs one buffer instead of two.
  return (layer.objects || []).some(seesBackdrop) ? 'passthrough' : 'isolated';
}

// Layer masks: raster (coverage program) and vector (paths). Enabled masks need the layer on its own surface.
const hasMask = (layer) => Boolean((layer.mask && layer.mask.enabled !== false) || (layer.vectorMask && layer.vectorMask.enabled !== false));

/**
 * Device-pixel coverage of a layer's masks (null when none is enabled). Linked masks follow the layer
 * transform (`layerMatrix`); unlinked ones stay in document space. Raster × vector when both exist.
 */
function maskCoverage(layer, w, h, layerMatrix, env) {
  const parts = [];
  if (layer.mask && layer.mask.enabled !== false) parts.push([layer.mask, layer.mask.program]);
  if (layer.vectorMask && layer.vectorMask.enabled !== false) {
    parts.push([layer.vectorMask, layer.vectorMask.shapes.map((shape) => ({ op: 'paint', value: 1, shape }))]);
  }
  let out = null;
  for (const [mask, program] of parts) {
    const matrix = mask.linked === false ? env.baseMatrix : layerMatrix;
    const coverage = finishMask(renderCoverage(program, w, h, matrix, env.deviceScale), mask, env.deviceScale);
    if (!out) { out = coverage; continue; }
    const octx = out.getContext('2d');
    octx.globalCompositeOperation = 'destination-in';
    octx.drawImage(coverage, 0, 0);
    octx.globalCompositeOperation = 'source-over';
  }
  return out;
}

function keepWhere(surface, coverage) {
  const c = surface.getContext('2d');
  c.save();
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.globalCompositeOperation = 'destination-in';
  c.drawImage(coverage, 0, 0);
  c.restore();
  return surface;
}

// Copy of the current surface (device pixels).
function snapshot(ctx) {
  const copy = makeCanvas(ctx.canvas.width, ctx.canvas.height);
  copy.getContext('2d').drawImage(ctx.canvas, 0, 0);
  return copy;
}

// Pass-through at opacity o: result = backdrop·(1−o) + composited·o over the whole surface.
// clearRect + source-over rather than 'copy': Skia's 'copy' applies globalAlpha twice.
function mixPassThrough(ctx, backdrop, composited, opacity) {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1 - opacity;
  ctx.drawImage(backdrop, 0, 0);
  ctx.globalCompositeOperation = 'lighter';
  ctx.globalAlpha = opacity;
  ctx.drawImage(composited, 0, 0);
}

// Pass-through with a mask: result = backdrop·(1−k) + composited·k, k = mask·opacity per pixel.
function mixMasked(ctx, backdrop, composited, coverage, opacity) {
  const k = makeCanvas(coverage.width, coverage.height);
  const kctx = k.getContext('2d');
  kctx.globalAlpha = opacity;
  kctx.drawImage(coverage, 0, 0);
  const back = makeCanvas(backdrop.width, backdrop.height);
  const bctx = back.getContext('2d');
  bctx.drawImage(backdrop, 0, 0);
  bctx.globalCompositeOperation = 'destination-out';
  bctx.drawImage(k, 0, 0);
  keepWhere(composited, k);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
  ctx.drawImage(back, 0, 0);
  ctx.globalCompositeOperation = 'lighter';
  ctx.drawImage(composited, 0, 0);
}

const layerOpacityOf = (layer, env) => {
  const anim = (env.resolved.layers && env.resolved.layers[layer.id]) || {};
  return clamp(num(layer.opacity, 1) * num(anim.opacity, 1), 0, 1);
};

function applyLayerTransform(ctx, layer) {
  const transform = layer.transform || {};
  ctx.translate(num(transform.x, 0), num(transform.y, 0));
  const rotation = num(transform.rotation, 0);
  const scaleX = transform.scaleX === undefined ? 1 : num(transform.scaleX, 1);
  const scaleY = transform.scaleY === undefined ? 1 : num(transform.scaleY, 1);
  if (rotation || scaleX !== 1 || scaleY !== 1) {
    const pivotX = num(transform.pivotX, 0);
    const pivotY = num(transform.pivotY, 0);
    ctx.translate(pivotX, pivotY);
    ctx.rotate(rotation * DEG);
    ctx.scale(scaleX, scaleY);
    ctx.translate(-pivotX, -pivotY);
  }
}

function drawLayerObjects(target, layer, env) {
  const doc = env.doc;
  // Pixel layer: its tiles first (layer coordinates), then any vector objects on top.
  if (layer.raster) {
    const size = layer.raster.tileSize || 256;
    for (const [k, hash] of Object.entries(layer.raster.tiles)) {
      const image = (env.options.images || {})[`tile:${hash}`];
      if (!image) { env.warnings.push(`pixel tile ${hash.slice(0, 8)} of layer "${layer.name}" is not loaded`); continue; }
      const [tx, ty] = k.split(',').map(Number);
      target.drawImage(image, tx * size, ty * size);
    }
  }
  for (const object of layer.objects) {
    const objectAnim = (env.resolved.objects && env.resolved.objects[object.id]) || {};
    drawObject(target, object, objectAnim, env.options.images || {}, (message) => env.warnings.push(message), {lights:[...(doc.canvas.lights||[]),...(layer.lights||[])],layerId:layer.id,width:doc.canvas.width,height:doc.canvas.height});
  }
}

/**
 * A v2 layer on its own device surface, finished in Photoshop's order: content → filter (smart-filter
 * style) → masks → layer effects. Returns the styled surface (no layer opacity/blend yet) and the masked
 * content before effects, whose alpha is what clipped layers clip to.
 */
function layerSurface(ctx, layer, env) {
  ctx.save();
  applyLayerTransform(ctx, layer);
  const layerMatrix = ctx.getTransform();
  const off = makeCanvas(ctx.canvas.width, ctx.canvas.height);
  const target = off.getContext('2d');
  target.setTransform(layerMatrix);
  drawLayerObjects(target, layer, env);
  ctx.restore();
  let content = off;
  if (hasFilters(layer)) {
    // Smart filters act on the layer's own content, limited by the filter mask if there is one.
    const fm = layer.filterMask && layer.filterMask.enabled !== false
      ? finishMask(renderCoverage(layer.filterMask.program, off.width, off.height, layer.filterMask.linked === false ? env.baseMatrix : layerMatrix, env.deviceScale), layer.filterMask, env.deviceScale)
      : null;
    content = applyFilterStack(off, layer.filters, env.deviceScale, fm);
  }
  if (layer.filter && Object.keys(layer.filter).length) {
    const source = content;
    content = makeCanvas(off.width, off.height);
    const fctx = content.getContext('2d');
    fctx.filter = filterString(layer.filter);
    fctx.drawImage(source, 0, 0);
    fctx.filter = 'none';
  }
  if (hasMask(layer)) keepWhere(content, maskCoverage(layer, content.width, content.height, layerMatrix, env));
  const surface = hasStyles(layer) ? applyLayerStyles(content, layer, env, env.deviceScale, stylePainter(env)) : content;
  return { surface, content };
}

// Blend If: scale the surface's alpha by ramp(this value) × ramp(underlying value) per pixel.
const blendIfValue = (channel, d, p) => (channel === 'red' ? d[p] : channel === 'green' ? d[p + 1] : channel === 'blue' ? d[p + 2]
  : 0.299 * d[p] + 0.587 * d[p + 1] + 0.114 * d[p + 2]);
function blendIfRamp(r, v) {
  if (v < r[0] || v > r[3]) return 0;
  if (v < r[1]) return (v - r[0]) / (r[1] - r[0] || 1);
  if (v > r[2]) return (r[3] - v) / (r[3] - r[2] || 1);
  return 1;
}
function applyBlendIf(surface, underCtx, blendIf) {
  if (!blendIf) return surface;
  const W = surface.width; const H = surface.height;
  const sctx = surface.getContext('2d');
  const image = sctx.getImageData(0, 0, W, H);
  const d = image.data;
  const under = underCtx.getImageData(0, 0, W, H).data;
  const ch = blendIf.channel || 'gray';
  for (let p = 0; p < d.length; p += 4) {
    if (!d[p + 3]) continue;
    const k = blendIfRamp(blendIf.this, blendIfValue(ch, d, p)) * blendIfRamp(blendIf.underlying, blendIfValue(ch, under, p));
    if (k < 1) d[p + 3] = Math.round(d[p + 3] * k);
  }
  sctx.putImageData(image, 0, 0);
  return surface;
}

const stylePainter = (env) => (pctx, paint, box) => {
  pctx.beginPath();
  pctx.rect(box.x, box.y, box.w, box.h);
  fillAndStroke(pctx, { fill: paint }, box, (message) => env.warnings.push(message), env.options.images || {});
};

/**
 * A group rendered on its own transparent surface (isolated): its children, then its mask, then its layer
 * styles. `content` (before styles) is what layers clipped to the group clip to.
 */
function groupSurface(ctx, node, env) {
  const group = node.layer;
  const surface = makeCanvas(ctx.canvas.width, ctx.canvas.height);
  const sc = surface.getContext('2d');
  sc.setTransform(ctx.getTransform());
  renderNodes(sc, node.children, env);
  if (hasMask(group)) keepWhere(surface, maskCoverage(group, surface.width, surface.height, env.baseMatrix, env));
  const styled = hasStyles(group) ? applyLayerStyles(surface, group, env, env.deviceScale, stylePainter(env)) : surface;
  return { surface: styled, content: surface };
}

const groupBlend = (layer) => (layer.blend === 'pass-through' ? 'source-over' : layer.blend || 'source-over');

function compositeOnce(ctx, surface, opacity, blend) {
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = opacity;
  ctx.globalCompositeOperation = blend || 'source-over';
  ctx.drawImage(surface, 0, 0);
  ctx.restore();
}

/**
 * Clipping group (v2): clipped layers show only where the base layer has content, blend with the base
 * as a group, and the whole group takes the base layer's opacity and blend mode (Photoshop's default
 * "blend clipped layers as group"). Hidden base → the whole group is hidden.
 */
/**
 * Adjustment layer: recolour what is already composited on `ctx` and mix it back per pixel by
 * mask × opacity (alpha unchanged), through the layer's blend mode. `limit` (a canvas whose alpha
 * bounds the effect) is the clipping base content when the adjustment is clipped.
 */
function applyAdjustment(ctx, layer, env, limit) {
  const opacity = layerOpacityOf(layer, env);
  if (opacity <= 0 || !ctx.canvas) return;
  const backdrop = snapshot(ctx);
  let result = adjustCanvas(backdrop, layer.adjustment);
  if (layer.blend && layer.blend !== 'source-over') {
    const blended = snapshot(ctx);
    const bctx = blended.getContext('2d');
    bctx.globalCompositeOperation = layer.blend;
    bctx.drawImage(result, 0, 0);
    bctx.globalCompositeOperation = 'destination-in';
    bctx.drawImage(backdrop, 0, 0);
    result = blended;
  }
  let coverage = hasMask(layer) ? maskCoverage(layer, backdrop.width, backdrop.height, env.baseMatrix, env) : null;
  if (limit) {
    if (!coverage) { coverage = makeCanvas(backdrop.width, backdrop.height); const c = coverage.getContext('2d'); c.fillStyle = '#000'; c.fillRect(0, 0, backdrop.width, backdrop.height); }
    keepWhere(coverage, limit);
  }
  ctx.save();
  if (coverage) mixMasked(ctx, backdrop, result, coverage, opacity);
  else mixPassThrough(ctx, backdrop, result, opacity);
  ctx.restore();
}

// The base may be a layer or a group (clipping to a group uses the group's composited content).
function renderClipGroup(ctx, baseNode, clipped, env) {
  const base = baseNode.layer;
  const baseResult = baseNode.children ? groupSurface(ctx, baseNode, env) : layerSurface(ctx, base, env);
  const group = makeCanvas(ctx.canvas.width, ctx.canvas.height);
  const gctx = group.getContext('2d');
  gctx.drawImage(baseResult.surface, 0, 0);
  for (const layer of clipped) {
    if (layer.visible === false) continue;
    if (layer.type === 'adjustment') { applyAdjustment(gctx, layer, env, baseResult.content); continue; }
    const opacity = layerOpacityOf(layer, env);
    if (opacity <= 0) continue;
    const { surface } = layerSurface(ctx, layer, env);
    keepWhere(surface, baseResult.content);
    applyBlendIf(surface, gctx, layer.blendIf);
    compositeOnce(gctx, surface, opacity, layer.blend);
  }
  if (!baseNode.children) applyBlendIf(group, ctx, base.blendIf);
  compositeOnce(ctx, group, layerOpacityOf(base, env), groupBlend(base));
}

function renderNodes(ctx, nodes, env) {
  for (let i = 0; i < nodes.length; i += 1) {
    const node = nodes[i];
    // A leaf base followed by clipped leaf layers renders as one clipping group.
    if (env.v2 && ctx.canvas && !node.layer.clipped && node.layer.type !== 'adjustment') {
      let j = i + 1;
      while (j < nodes.length && !nodes[j].children && nodes[j].layer.clipped) j += 1;
      if (j > i + 1) {
        if (node.layer.visible !== false) renderClipGroup(ctx, node, nodes.slice(i + 1, j).map((n) => n.layer), env);
        i = j - 1;
        continue;
      }
    }
    if (node.layer.visible === false) continue;
    if (node.layer.type === 'adjustment') { if (env.v2) applyAdjustment(ctx, node.layer, env, null); continue; }
    if (node.layer.clipped && !node.children) env.warnings.push(`layer "${node.layer.name}" is clipped but has no layer below it; shown unclipped`);
    if (node.children) renderGroup(ctx, node, env);
    else renderLayer(ctx, node.layer, env);
  }
}

// A group (v2 only). 'pass-through': children composite straight into what is below; with opacity < 1
// or a mask, the result is mixed with the backdrop per pixel. Any other blend, 'source-over' (Normal)
// included, isolates the group: children composite on a transparent surface, which composites once.
function renderGroup(ctx, node, env) {
  const group = node.layer;
  const opacity = layerOpacityOf(group, env);
  const blend = group.blend || 'pass-through';
  if (opacity <= 0) return;
  const masked = hasMask(group) && Boolean(ctx.canvas);
  // Styles need the group's own composite: render it isolated, style it, composite once.
  if (ctx.canvas && hasStyles(group)) { compositeOnce(ctx, groupSurface(ctx, node, env).surface, opacity, groupBlend(group)); return; }
  if (!ctx.canvas || (blend === 'pass-through' && opacity >= 1 && !masked)) { renderNodes(ctx, node.children, env); return; }
  const passThrough = blend === 'pass-through';
  const backdrop = passThrough ? snapshot(ctx) : null;
  const surface = passThrough ? snapshot(ctx) : makeCanvas(ctx.canvas.width, ctx.canvas.height);
  const sc = surface.getContext('2d');
  sc.setTransform(ctx.getTransform());
  renderNodes(sc, node.children, env);
  const coverage = masked ? maskCoverage(group, surface.width, surface.height, env.baseMatrix, env) : null;
  ctx.save();
  if (passThrough) {
    if (coverage) mixMasked(ctx, backdrop, surface, coverage, opacity);
    else mixPassThrough(ctx, backdrop, surface, opacity);
  } else {
    if (coverage) keepWhere(surface, coverage);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = opacity;
    ctx.globalCompositeOperation = blend;
    ctx.drawImage(surface, 0, 0);
  }
  ctx.restore();
}

function renderLayer(ctx, layer, env) {
  const layerOpacity = layerOpacityOf(layer, env);
  const layerBlend = layer.blend || 'source-over';
  const mode = layerCompositeMode(env.v2, layer, layerOpacity, layerBlend, ctx);
  if (mode === 'isolated') {
    compositeOnce(ctx, applyBlendIf(layerSurface(ctx, layer, env).surface, ctx, layer.blendIf), layerOpacity, layerBlend);
    return;
  }
  ctx.save();
  if (mode === 'legacy' || mode === 'legacy-filter' || mode === 'direct-legacy') {
    // v1 semantics: layer alpha and blend apply to each object as it is drawn, so overlapping
    // objects inside a translucent layer accumulate alpha. Kept so saved v1 designs look unchanged.
    ctx.globalAlpha = layerOpacity;
    ctx.globalCompositeOperation = layerBlend;
  }
  applyLayerTransform(ctx, layer);
  // Remaining offscreen modes:
  //  legacy-filter → flatten the layer, then composite it with the layer alpha/blend set above.
  //  passthrough   → v2 normal layer with opacity < 1 whose objects blend with what is below: objects
  //                  draw onto a copy of the backdrop, and the result is mixed with the untouched
  //                  backdrop by the layer opacity (backdrop·(1−o) + result·o).
  let target = ctx;
  let off = null;
  let backdrop = null;
  if (mode === 'legacy-filter' || mode === 'passthrough') {
    off = makeCanvas(ctx.canvas.width, ctx.canvas.height);
    target = off.getContext('2d');
    if (mode === 'passthrough') {
      backdrop = snapshot(ctx);
      target.drawImage(backdrop, 0, 0);
    }
    target.setTransform(ctx.getTransform());
  }
  drawLayerObjects(target, layer, env);
  if (off) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (mode === 'passthrough') {
      mixPassThrough(ctx, backdrop, off, layerOpacity);
    } else {
      ctx.filter = filterString(layer.filter);
      ctx.drawImage(off, 0, 0);
      ctx.filter = 'none';
    }
  }
  ctx.restore();
}

/**
 * Render a document onto a 2D context.
 * opts: { time, images, applyAnimation, drawBackground, clear, warnings }
 */
function render(ctx, doc, opts) {
  const options = opts || {};
  const warnings = options.warnings || [];
  const resolved = options.applyAnimation === false
    ? { layers: {}, objects: {} }
    : resolveAnimation(doc, options.time || 0);
  if (options.clear !== false) ctx.clearRect(0, 0, doc.canvas.width, doc.canvas.height);
  if (options.drawBackground !== false) drawBackground(ctx, doc);
  // Effect sizes are in document pixels; surfaces are in device pixels (export scale).
  const m = typeof ctx.getTransform === 'function' ? ctx.getTransform() : null;
  const deviceScale = m ? Math.sqrt(Math.abs(m.a * m.d - m.b * m.c)) || 1 : 1;
  const env = { doc, resolved, options, warnings, v2: Boolean(doc.canvas && doc.canvas.compositing === 'v2'),
    globalLight: doc.canvas && doc.canvas.globalLight, deviceScale,
    baseMatrix: m ? { a: m.a, b: m.b, c: m.c, d: m.d, e: m.e, f: m.f } : { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 } };
  // Groups exist only in v2 documents; a v1 document is a flat list of root layers, rendered as before.
  renderNodes(ctx, env.v2 ? buildTree(doc.layers) : doc.layers.map((layer) => ({ layer })), env);
  if (options.effects !== false && doc.canvas.effects && doc.canvas.effects.length && ctx.canvas) {
    applyEffects(ctx, doc.canvas.effects, doc.canvas.width, doc.canvas.height);
  }
  return { warnings, time: resolved.time || 0 };
}

module.exports = {
  render,
  bboxOf,
  drawObject,
  drawBackground,
  roundedRectPath,
  ellipsePath,
  polygonPath,
  pathFromSegments,
  resolveObject,
  applyLayerTransform,
};
