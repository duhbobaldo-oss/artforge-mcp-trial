'use strict';

/**
 * Live layer styles (Photoshop-like layer effects), rendered from the layer's composited alpha.
 *
 * Shared by the Node exporter and the browser live view, so no Node-only requires here.
 * Everything is computed from parameters at render time: nothing is baked into the document, so
 * changing a shape, a text or an effect value re-renders correctly.
 *
 * Paint order (bottom → top), several effects of one type stack in list order:
 *   dropShadow, outerGlow, extrude, [layer content × fillOpacity],
 *   patternOverlay, gradientOverlay, colorOverlay, innerGlow, innerShadow, bevel, stroke
 * This follows Photoshop's order. The look is a behavioural approximation, not Adobe's algorithm:
 * Gaussian sizes use sigma = size / 2, glows fall off smoothly over a true distance, bevels are
 * shaded from a distance-field height map.
 */

const { makeCanvas, parseRgba } = require('./effects');
const { distanceFields } = require('./distance');
const { curveLut } = require('./adjustments');

const ORDER = ['dropShadow', 'outerGlow', 'extrude', 'content', 'patternOverlay', 'gradientOverlay', 'colorOverlay',
  'satin', 'innerGlow', 'innerShadow', 'bevel', 'stroke'];

// Contour presets: falloff input t (0..1) -> output (0..1).
const CONTOUR_FN = {
  gaussian: (t) => t * t * (3 - 2 * t),
  cone: (t) => 1 - Math.abs(2 * t - 1),
  coneInverted: (t) => Math.abs(2 * t - 1),
  cove: (t) => t * t,
  halfRound: (t) => Math.sqrt(Math.max(0, 1 - (1 - t) * (1 - t))),
  ring: (t) => Math.exp(-Math.pow((t - 0.5) / 0.2, 2)),
  ringDouble: (t) => Math.abs(Math.sin(2 * Math.PI * t)),
  rollingSlope: (t) => Math.min(1, Math.max(0, t + 0.12 * Math.sin(2 * Math.PI * t))),
  sawtooth: (t) => (t >= 1 ? 1 : (t * 2) % 1),
};
const contourCache = new Map();
/** 256-entry falloff table for a contour (null = linear, nothing to do). */
function contourLut(contour) {
  if (!contour || contour === 'linear') return null;
  const key = typeof contour === 'string' ? contour : JSON.stringify(contour);
  if (contourCache.has(key)) return contourCache.get(key);
  const lut = new Float32Array(256);
  if (typeof contour === 'string') { const fn = CONTOUR_FN[contour] || ((t) => t); for (let i = 0; i < 256; i += 1) lut[i] = fn(i / 255); }
  else { const table = curveLut(contour); for (let i = 0; i < 256; i += 1) lut[i] = table[i] / 255; }
  contourCache.set(key, lut);
  return lut;
}
const contoured = (lut, v) => (lut ? lut[Math.round((v < 0 ? 0 : v > 1 ? 1 : v) * 255)] : v);
// Reshape a coloured effect canvas's alpha through a contour (colour alpha `ca` kept as a ceiling).
function contourCanvas(canvas, lut, ca) {
  if (!lut) return canvas;
  const ctx = canvas.getContext('2d');
  const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = image.data;
  const k = ca > 0 ? ca : 1;
  for (let p = 3; p < d.length; p += 4) d[p] = Math.round(contoured(lut, d[p] / 255 / k) * k * 255);
  ctx.putImageData(image, 0, 0);
  return canvas;
}
const DEG = Math.PI / 180;

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (t) => { const x = clamp01(t); return x * x * (3 - 2 * x); };

function rgb(color) {
  const c = parseRgba(color) || { r: 0, g: 0, b: 0, a: 1 };
  return { r: c.r, g: c.g, b: c.b, a: c.a === undefined ? 1 : c.a };
}

/** Canvas whose colour is `color` and whose alpha is `alpha[i]` (0..1) × the colour's own alpha. */
function maskCanvas(alpha, w, h, color) {
  const c = rgb(color);
  const canvas = makeCanvas(w, h);
  const ctx = canvas.getContext('2d');
  const image = ctx.createImageData(w, h);
  const data = image.data;
  for (let i = 0, p = 0; i < alpha.length; i += 1, p += 4) {
    data[p] = c.r; data[p + 1] = c.g; data[p + 2] = c.b;
    data[p + 3] = Math.round(clamp01(alpha[i]) * c.a * 255);
  }
  ctx.putImageData(image, 0, 0);
  return canvas;
}

function blurred(canvas, sigma) {
  if (!(sigma > 0.05)) return canvas;
  const out = makeCanvas(canvas.width, canvas.height);
  const ctx = out.getContext('2d');
  ctx.filter = `blur(${sigma.toFixed(2)}px)`;
  ctx.drawImage(canvas, 0, 0);
  ctx.filter = 'none';
  return out;
}

/** Keep `canvas` only where `alphaCanvas` is opaque (destination-in). */
function maskedBy(canvas, alphaCanvas) {
  const ctx = canvas.getContext('2d');
  ctx.save();
  ctx.globalCompositeOperation = 'destination-in';
  ctx.drawImage(alphaCanvas, 0, 0);
  ctx.restore();
  return canvas;
}

function drawWith(ctx, canvas, blend, opacity, dx, dy) {
  ctx.save();
  ctx.globalCompositeOperation = blend || 'source-over';
  ctx.globalAlpha = clamp01(opacity === undefined ? 1 : opacity);
  ctx.drawImage(canvas, dx || 0, dy || 0);
  ctx.restore();
}

// Light direction: Photoshop convention, angle counter-clockwise from +x with y up.
function lightOf(effect, env) {
  const global = env.globalLight || { angle: 120, altitude: 30 };
  const angle = effect.useGlobalLight === false ? effect.angle : global.angle;
  const altitude = effect.useGlobalLight === false ? effect.altitude : global.altitude;
  return { angle: Number(angle === undefined ? 120 : angle), altitude: Number(altitude === undefined ? 30 : altitude) };
}

// A shadow falls away from the light: offset opposite to the light direction.
function shadowOffset(effect, env, scale) {
  const { angle } = lightOf(effect, env);
  const d = Number(effect.distance || 0) * scale;
  return { dx: -Math.cos(angle * DEG) * d, dy: Math.sin(angle * DEG) * d };
}

function bounds(data, w, h) {
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y += 1) {
    const row = y * w * 4;
    for (let x = 0; x < w; x += 1) {
      if (data[row + x * 4 + 3]) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

// How far an effect can reach beyond the content, in device pixels.
function reach(effect, scale) {
  const size = Number(effect.size || 0) * scale;
  switch (effect.type) {
    case 'dropShadow': return Number(effect.distance || 0) * scale + size * 1.6 + 2;
    case 'outerGlow': return size + 2;
    case 'stroke': return effect.position === 'inside' ? 1 : size + 2;
    case 'bevel': return effect.style === 'inner' ? 2 : size + 2;
    case 'extrude': return Number(effect.depth || 0) * scale + 2;
    default: return 2 + Number(effect.distance || 0) * scale + size * 1.6;
  }
}

/** Alpha-coverage helpers built from the content's distance fields (lazy, computed once). */
function shapeOps(alpha, w, h) {
  let fields = null;
  const get = () => { if (!fields) fields = distanceFields(alpha, w, h); return fields; };
  return {
    // Shape grown by r px (anti-aliased outer edge).
    dilate(r) {
      const { outside } = get();
      const out = new Float32Array(alpha.length);
      for (let i = 0; i < out.length; i += 1) out[i] = Math.max(alpha[i], clamp01(r + 0.5 - outside[i]));
      return out;
    },
    // Shape shrunk by r px.
    erode(r) {
      const { inside } = get();
      const out = new Float32Array(alpha.length);
      for (let i = 0; i < out.length; i += 1) out[i] = alpha[i] >= 0.5 ? alpha[i] * clamp01(inside[i] - r + 0.5) : 0;
      return out;
    },
    fields: get,
  };
}

/** Opaque colour field with the (optionally offset) shape punched out: the "outside" of the shape. */
function outsideField(shapeCanvas, w, h, color, dx, dy) {
  const canvas = makeCanvas(w, h);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, w, h);
  ctx.globalCompositeOperation = 'destination-out';
  ctx.drawImage(shapeCanvas, dx || 0, dy || 0);
  return canvas;
}

function bevelMaps(effect, alpha, ops, w, h, scale, env) {
  const size = Math.max(0.5, Number(effect.size || 5) * scale);
  const { inside, outside } = ops.fields();
  const style = effect.style || 'inner';
  const height = new Float32Array(alpha.length);
  const region = new Float32Array(alpha.length);
  for (let i = 0; i < alpha.length; i += 1) {
    const sIn = alpha[i] >= 0.5 ? inside[i] : 0;
    const sOut = alpha[i] >= 0.5 ? 0 : outside[i];
    let t;
    if (style === 'outer') { t = alpha[i] >= 0.5 ? 1 : 1 - sOut / size; region[i] = alpha[i] >= 0.5 ? 0 : clamp01(size + 0.5 - sOut) * (1 - alpha[i]); }
    else if (style === 'emboss') { const signed = alpha[i] >= 0.5 ? sIn : -sOut; t = (signed + size / 2) / size; region[i] = clamp01(size / 2 + 0.5 - sOut); }
    else { t = sIn / size; region[i] = alpha[i]; }
    t = contoured(contourLut(effect.contour), clamp01(t));
    // smooth: rounded profile; chisel: straight facets.
    height[i] = (effect.technique === 'chisel' ? t : 1 - (1 - t) * (1 - t)) * size * Number(effect.depth === undefined ? 1 : effect.depth);
  }
  if (effect.direction === 'down') for (let i = 0; i < height.length; i += 1) height[i] = -height[i];
  const light = lightOf(effect, env);
  const alt = light.altitude * DEG;
  const ang = light.angle * DEG;
  const L = { x: Math.cos(alt) * Math.cos(ang), y: -Math.cos(alt) * Math.sin(ang), z: Math.sin(alt) };
  const flat = L.z;
  const highlight = new Float32Array(alpha.length);
  const shadow = new Float32Array(alpha.length);
  const at = (x, y) => height[Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x))];
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const i = y * w + x;
      if (!region[i]) continue;
      // Sobel gradient of the height map (screen space, y down).
      const gx = ((at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1)) - (at(x - 1, y - 1) + 2 * at(x - 1, y) + at(x - 1, y + 1))) / 8;
      const gy = ((at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1)) - (at(x - 1, y - 1) + 2 * at(x, y - 1) + at(x + 1, y - 1))) / 8;
      const len = Math.sqrt(gx * gx + gy * gy + 1);
      const shade = (-gx * L.x - gy * L.y + L.z) / len;
      if (shade > flat) highlight[i] = region[i] * clamp01((shade - flat) / (1 - flat || 1));
      else shadow[i] = region[i] * clamp01((flat - shade) / (flat || 1));
    }
  }
  return { highlight, shadow };
}

/**
 * Apply `layer.effects` and `layer.fillOpacity` to a layer surface (full device-size canvas holding the
 * layer's composited content). Returns a canvas of the same size. `paintBox(ctx, paint, box)` fills a
 * rectangle with an ArtForge paint (gradient/pattern) — provided by the renderer.
 */
function applyLayerStyles(surface, layer, env, scale, paintBox) {
  const effects = (layer.effects || []).filter((e) => e && e.enabled !== false);
  const fill = layer.fillOpacity === undefined ? 1 : clamp01(Number(layer.fillOpacity));
  if (!effects.length && fill >= 1) return surface;
  const W = surface.width;
  const H = surface.height;
  const full = surface.getContext('2d').getImageData(0, 0, W, H);
  const box = bounds(full.data, W, H);
  if (!box) return surface;
  if (!effects.length) {
    const out = makeCanvas(W, H);
    drawWith(out.getContext('2d'), surface, 'source-over', fill);
    return out;
  }
  // Work on a crop around the content plus everything the effects can reach.
  const pad = Math.ceil(Math.max(2, ...effects.map((e) => reach(e, scale))));
  const cx = Math.max(0, box.x - pad);
  const cy = Math.max(0, box.y - pad);
  const w = Math.min(W, box.x + box.w + pad) - cx;
  const h = Math.min(H, box.y + box.h + pad) - cy;
  const content = makeCanvas(w, h);
  content.getContext('2d').drawImage(surface, -cx, -cy);
  const data = content.getContext('2d').getImageData(0, 0, w, h).data;
  const alpha = new Float32Array(w * h);
  for (let i = 0; i < alpha.length; i += 1) alpha[i] = data[i * 4 + 3] / 255;
  const ops = shapeOps(alpha, w, h);
  const contentBox = { x: box.x - cx, y: box.y - cy, w: box.w, h: box.h };
  const shapeAlpha = maskCanvas(alpha, w, h, '#000000'); // the content's alpha as a mask

  const out = makeCanvas(w, h);
  const octx = out.getContext('2d');
  const byType = (type) => effects.filter((e) => e.type === type);

  for (const step of ORDER) {
    if (step === 'content') { drawWith(octx, content, 'source-over', fill); continue; }
    for (const e of byType(step)) {
      const size = Number(e.size || 0) * scale;
      switch (e.type) {
        case 'dropShadow': {
          const spread = clamp01(Number(e.spread || 0));
          const base = spread > 0 ? maskCanvas(ops.dilate(size * spread), w, h, e.color) : maskCanvas(alpha, w, h, e.color);
          const shadow = contourCanvas(blurred(base, (size * (1 - spread)) / 2), contourLut(e.contour), rgb(e.color).a);
          const { dx, dy } = shadowOffset(e, env, scale);
          const placed = makeCanvas(w, h);
          placed.getContext('2d').drawImage(shadow, dx, dy);
          // "Layer knocks out drop shadow" (Photoshop's default): no shadow shows through a translucent fill.
          if (e.knockout !== false) {
            const pctx = placed.getContext('2d');
            pctx.globalCompositeOperation = 'destination-out';
            pctx.drawImage(shapeAlpha, 0, 0);
          }
          drawWith(octx, placed, e.blend || 'multiply', e.opacity);
          break;
        }
        case 'outerGlow': {
          const spread = clamp01(Number(e.spread || 0));
          const { outside } = ops.fields();
          const glow = new Float32Array(alpha.length);
          const lut = contourLut(e.contour);
          const soft = Math.max(0.5, size * (1 - spread));
          for (let i = 0; i < glow.length; i += 1) {
            glow[i] = alpha[i] >= 1 ? 0 : (1 - alpha[i]) * contoured(lut, 1 - smooth((outside[i] - size * spread) / soft));
          }
          drawWith(octx, maskCanvas(glow, w, h, e.color), e.blend || 'screen', e.opacity);
          break;
        }
        case 'extrude': {
          // 2.5D depth: offset copies of the silhouette receding away from `angle`, darkening with depth.
          const depth = Math.max(0, Number(e.depth || 0) * scale);
          const steps = Math.min(400, Math.ceil(depth));
          const c = rgb(e.color || '#333333');
          const k = 1 - Number(e.shade === undefined ? 0.5 : e.shade);
          const ang = Number(e.angle === undefined ? 300 : e.angle) * DEG;
          // Two silhouettes (front colour, fully shaded back colour); each step mixes them by depth.
          const near = maskCanvas(alpha, w, h, `rgb(${c.r},${c.g},${c.b})`);
          const far = maskCanvas(alpha, w, h, `rgb(${Math.round(c.r * k)},${Math.round(c.g * k)},${Math.round(c.b * k)})`);
          const layerCanvas = makeCanvas(w, h);
          const lctx = layerCanvas.getContext('2d');
          for (let s = steps; s >= 1; s -= 1) {
            const x = Math.cos(ang) * s;
            const y = -Math.sin(ang) * s;
            lctx.globalAlpha = 1;
            lctx.drawImage(near, x, y);
            lctx.globalAlpha = s / Math.max(1, steps);
            lctx.drawImage(far, x, y);
          }
          lctx.globalAlpha = 1;
          drawWith(octx, layerCanvas, e.blend || 'source-over', e.opacity);
          break;
        }
        case 'patternOverlay':
        case 'gradientOverlay':
        case 'colorOverlay': {
          const layerCanvas = makeCanvas(w, h);
          const lctx = layerCanvas.getContext('2d');
          if (e.type === 'colorOverlay') { lctx.fillStyle = e.color; lctx.fillRect(0, 0, w, h); }
          else paintBox(lctx, e.type === 'gradientOverlay' ? e.gradient : e.pattern, contentBox);
          maskedBy(layerCanvas, shapeAlpha);
          drawWith(octx, layerCanvas, e.blend || 'source-over', e.opacity);
          break;
        }
        case 'innerGlow': {
          const choke = clamp01(Number(e.choke || 0));
          const { inside } = ops.fields();
          const glow = new Float32Array(alpha.length);
          const lut = contourLut(e.contour);
          const soft = Math.max(0.5, size * (1 - choke));
          for (let i = 0; i < glow.length; i += 1) {
            if (alpha[i] <= 0) continue;
            const s = alpha[i] >= 0.5 ? inside[i] : 0;
            const edge = 1 - smooth((s - size * choke) / soft);
            glow[i] = alpha[i] * contoured(lut, e.source === 'center' ? 1 - edge : edge);
          }
          drawWith(octx, maskCanvas(glow, w, h, e.color), e.blend || 'screen', e.opacity);
          break;
        }
        case 'innerShadow': {
          const choke = clamp01(Number(e.choke || 0));
          const shape = choke > 0 ? maskCanvas(ops.erode(size * choke), w, h, '#000000') : shapeAlpha;
          const { dx, dy } = shadowOffset(e, env, scale);
          const field = contourCanvas(blurred(outsideField(shape, w, h, e.color, dx, dy), (size * (1 - choke)) / 2), contourLut(e.contour), rgb(e.color).a);
          drawWith(octx, maskedBy(field, shapeAlpha), e.blend || 'multiply', e.opacity);
          break;
        }
        case 'satin': {
          const ang = Number(e.angle === undefined ? 19 : e.angle) * DEG;
          const d = Number(e.distance === undefined ? 11 : e.distance) * scale;
          const sx = Math.cos(ang) * d; const sy = -Math.sin(ang) * d;
          const soft = blurred(shapeAlpha, size / 2);
          const sample = (ox, oy) => {
            const c = makeCanvas(w, h);
            c.getContext('2d').drawImage(soft, ox, oy);
            return c.getContext('2d').getImageData(0, 0, w, h).data;
          };
          const a1 = sample(sx, sy); const a2 = sample(-sx, -sy);
          const lut = contourLut(e.contour === undefined ? 'gaussian' : e.contour);
          const satin = new Float32Array(alpha.length);
          for (let i = 0; i < satin.length; i += 1) {
            if (!alpha[i]) continue;
            let s = contoured(lut, Math.abs(a1[i * 4 + 3] - a2[i * 4 + 3]) / 255);
            if (e.invert !== false) s = 1 - s;
            satin[i] = alpha[i] * s;
          }
          drawWith(octx, maskCanvas(satin, w, h, e.color), e.blend || 'multiply', e.opacity);
          break;
        }
        case 'bevel': {
          const maps = bevelMaps(e, alpha, ops, w, h, scale, env);
          const soften = Number(e.soften || 0) * scale / 2;
          drawWith(octx, blurred(maskCanvas(maps.highlight, w, h, e.highlightColor || '#ffffff'), soften), e.highlightBlend || 'screen', e.highlightOpacity === undefined ? 0.75 : e.highlightOpacity);
          drawWith(octx, blurred(maskCanvas(maps.shadow, w, h, e.shadowColor || '#000000'), soften), e.shadowBlend || 'multiply', e.shadowOpacity === undefined ? 0.75 : e.shadowOpacity);
          break;
        }
        case 'stroke': {
          const { inside, outside } = ops.fields();
          const cover = new Float32Array(alpha.length);
          const outer = e.position === 'inside' ? 0 : e.position === 'center' ? size / 2 : size;
          const inner = e.position === 'inside' ? size : e.position === 'center' ? size / 2 : 0;
          for (let i = 0; i < cover.length; i += 1) {
            const a = alpha[i];
            let c = 0;
            if (outer > 0) c += a >= 1 ? 0 : (1 - a) * clamp01(outer + 0.5 - (a >= 0.5 ? 0 : outside[i]));
            if (inner > 0 && a > 0) c += a * clamp01(inner + 0.5 - (a >= 0.5 ? inside[i] : 0));
            cover[i] = clamp01(c);
          }
          const strokeCanvas = maskCanvas(cover, w, h, '#000000');
          if (typeof e.paint === 'string') {
            drawWith(octx, maskCanvas(cover, w, h, e.paint), e.blend || 'source-over', e.opacity);
          } else {
            const painted = makeCanvas(w, h);
            paintBox(painted.getContext('2d'), e.paint, { x: contentBox.x - outer, y: contentBox.y - outer, w: contentBox.w + outer * 2, h: contentBox.h + outer * 2 });
            drawWith(octx, maskedBy(painted, strokeCanvas), e.blend || 'source-over', e.opacity);
          }
          break;
        }
        default: break;
      }
    }
  }
  const result = makeCanvas(W, H);
  result.getContext('2d').drawImage(out, cx, cy);
  return result;
}

module.exports = { applyLayerStyles, ORDER, contourLut };
