'use strict';

const { assert } = require('./errors');
const { normalizePattern, smoothStops } = require('./effects');

const COLOR_RE = /^(#[0-9a-fA-F]{3,8}|rgba?\([^)]*\)|hsla?\([^)]*\)|transparent)$/;

const BLEND_MODES = [
  'source-over', 'source-in', 'source-out', 'source-atop',
  'destination-over', 'destination-in', 'destination-out', 'destination-atop',
  'lighter', 'copy', 'xor', 'multiply', 'screen', 'overlay', 'darken', 'lighten',
  'color-dodge', 'color-burn', 'hard-light', 'soft-light', 'difference', 'exclusion',
  'hue', 'saturation', 'color', 'luminosity',
];

/** A paint is either a color string or a gradient descriptor. */
function isGradient(paint) {
  return Boolean(paint) && typeof paint === 'object' && (paint.type === 'linear' || paint.type === 'radial' || paint.type === 'conic');
}

function normalizeColor(value, field) {
  assert(typeof value === 'string' && COLOR_RE.test(value.trim()), 'INVALID_COLOR',
    `${field || 'color'} must be a CSS color (#hex, rgb(), rgba(), hsl(), hsla() or "transparent")`,
    { received: value });
  return value.trim();
}

function normalizeGradient(gradient, field) {
  const name = field || 'paint';
  assert(gradient.type === 'linear' || gradient.type === 'radial' || gradient.type === 'conic', 'INVALID_GRADIENT',
    `${name}.type must be "linear", "radial" or "conic"`, { received: gradient.type });
  assert(Array.isArray(gradient.stops) && gradient.stops.length >= 2, 'INVALID_GRADIENT',
    `${name}.stops must contain at least two stops`);
  const stops = gradient.stops.map((stop, index) => {
    assert(typeof stop === 'object' && stop !== null, 'INVALID_GRADIENT',
      `${name}.stops[${index}] must be an object with offset and color`);
    const offset = Number(stop.offset);
    assert(Number.isFinite(offset) && offset >= 0 && offset <= 1, 'INVALID_GRADIENT',
      `${name}.stops[${index}].offset must be a number between 0 and 1`, { received: stop.offset });
    return { offset, color: normalizeColor(stop.color, `${name}.stops[${index}].color`) };
  }).sort((a, b) => a.offset - b.offset);

  // smooth: interpolate the stops in OKLab (perceptually even, no muddy middle), optional easing.
  const out = { type: gradient.type, stops: gradient.smooth ? smoothStops(stops, gradient.easing) : stops };
  if (gradient.smooth) out.smooth = true;
  if (gradient.type === 'linear') {
    const angle = gradient.angle === undefined ? 90 : Number(gradient.angle);
    assert(Number.isFinite(angle), 'INVALID_GRADIENT', `${name}.angle must be a number (degrees)`);
    out.angle = angle;
  } else if (gradient.type === 'conic') {
    out.angle = gradient.angle === undefined ? 0 : Number(gradient.angle);
    assert(Number.isFinite(out.angle), 'INVALID_GRADIENT', `${name}.angle must be a number (degrees)`);
    out.cx = clamp01(gradient.cx, 0.5, `${name}.cx`);
    out.cy = clamp01(gradient.cy, 0.5, `${name}.cy`);
  } else {
    out.cx = clamp01(gradient.cx, 0.5, `${name}.cx`);
    out.cy = clamp01(gradient.cy, 0.5, `${name}.cy`);
    out.r = clamp01(gradient.r === undefined ? 0.5 : gradient.r, 0.5, `${name}.r`, true);
  }
  return out;
}

function clamp01(value, fallback, field, allowZero) {
  if (value === undefined) return fallback;
  const n = Number(value);
  assert(Number.isFinite(n) && n >= 0 && n <= 1 && (allowZero || n > 0), 'INVALID_GRADIENT',
    `${field} must be a number between 0 and 1`, { received: value });
  return n;
}

function normalizePaint(paint, field, options) {
  const opts = options || {};
  if (paint === null || paint === undefined) {
    return opts.allowNone === false ? normalizeColor('#000000', field) : null;
  }
  if (typeof paint === 'string') return normalizeColor(paint, field);
  if (paint && paint.type === 'mesh') return require('./mesh-gradient').normalizeMesh(paint);
  if (paint && paint.type === 'material') return require('./material').normalizeMaterial(paint);
  if (isGradient(paint)) return normalizeGradient(paint, field);
  if (paint && paint.type === 'pattern') return normalizePattern(paint, field || 'paint');
  assert(false, 'INVALID_PAINT', `${field || 'paint'} must be a color string or a gradient object`, { received: paint });
  return null;
}

/** Convert a gradient descriptor into a CanvasGradient for the given bounding box. */
function createPaint(ctx, paint, bbox) {
  if (paint && paint.type === 'mesh') return require('./mesh-gradient').meshPaint(ctx,paint,bbox);
  if(paint && paint.type==='material') return paint.color; // text/stroke fallback; shape fills use clipped material raster
  if (!isGradient(paint)) return paint;
  const box = bbox || { x: 0, y: 0, w: 1, h: 1 };
  let gradient;
  if (paint.type === 'linear') {
    const angle = ((paint.angle % 360) * Math.PI) / 180;
    const cx = box.x + box.w / 2;
    const cy = box.y + box.h / 2;
    // Gradient line length = the box projected on the gradient direction (CSS behaviour), so the first and
    // last stops land exactly on the box edges. Using max(w, h) left a hard edge on wide/tall boxes.
    const half = (Math.abs(Math.cos(angle)) * box.w + Math.abs(Math.sin(angle)) * box.h) / 2;
    const dx = Math.cos(angle) * half;
    const dy = Math.sin(angle) * half;
    gradient = ctx.createLinearGradient(cx - dx, cy - dy, cx + dx, cy + dy);
  } else if (paint.type === 'conic' && typeof ctx.createConicGradient === 'function') {
    gradient = ctx.createConicGradient((paint.angle * Math.PI) / 180, box.x + box.w * paint.cx, box.y + box.h * paint.cy);
  } else {
    const cx = box.x + box.w * (paint.cx === undefined ? 0.5 : paint.cx);
    const cy = box.y + box.h * (paint.cy === undefined ? 0.5 : paint.cy);
    const radius = Math.max(1, Math.max(box.w, box.h) * (paint.r === undefined ? 0.5 : paint.r));
    gradient = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
  }
  for (const stop of paint.stops) gradient.addColorStop(stop.offset, stop.color);
  return gradient;
}

/** Extract hex colors from a paint (used by the MCP reference engine and palettes). */
function paintColors(paint) {
  if (!paint) return [];
  if (typeof paint === 'string') return [paint];
  if (isGradient(paint)) return paint.stops.map((s) => s.color);
  if(paint.type==='material') return [paint.color];
  if(paint.type==='mesh') return paint.nodes.map(n=>n.color);
  return [];
}

function toHex(r, g, b) {
  const hex = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}

function hexToRgb(color) {
  const value = String(color).trim();
  if (value.startsWith('#')) {
    let hex = value.slice(1);
    if (hex.length === 3) hex = hex.split('').map((c) => c + c).join('');
    if (hex.length >= 6) {
      return {
        r: parseInt(hex.slice(0, 2), 16),
        g: parseInt(hex.slice(2, 4), 16),
        b: parseInt(hex.slice(4, 6), 16),
      };
    }
  }
  const rgba = value.match(/^rgba?\(([^)]+)\)$/i);
  if (rgba) {
    const parts = rgba[1].split(',').map((p) => parseFloat(p));
    return { r: parts[0] || 0, g: parts[1] || 0, b: parts[2] || 0 };
  }
  return null;
}

module.exports = {
  BLEND_MODES,
  COLOR_RE,
  isGradient,
  normalizeColor,
  normalizeGradient,
  normalizePaint,
  createPaint,
  paintColors,
  toHex,
  hexToRgb,
};
