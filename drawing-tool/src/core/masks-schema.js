'use strict';

/**
 * Validation for coverage programs (masks and selections) and layer masks.
 *   layer.mask       — raster mask: { enabled, invert, density, feather, linked, program: [steps] }
 *   layer.vectorMask — vector mask: { enabled, invert, density, feather, linked, shapes: [rect|ellipse|polygon|path] }
 * Both shape the layer before its effects; when both exist their coverages multiply.
 */

const { assert } = require('./errors');

const SHAPES = ['all', 'rect', 'ellipse', 'polygon', 'path', 'brush', 'gradient', 'pixels'];
const VECTOR_SHAPES = ['rect', 'ellipse', 'polygon', 'path'];
const MODIFIERS = ['invert', 'feather', 'grow', 'shrink', 'smooth'];
const MAX_STEPS = 2000;
const MAX_POINTS = 20000;
const MAX_RLE = 16 * 1024 * 1024;

function num(value, field, min, max) {
  const n = Number(value);
  assert(Number.isFinite(n) && (min === undefined || n >= min) && (max === undefined || n <= max), 'INVALID_MASK',
    `${field} must be a number${min !== undefined ? ` between ${min} and ${max}` : ''}`, { received: value });
  return n;
}

function point(p, field) {
  assert(p && typeof p === 'object', 'INVALID_MASK', `${field} must be {x, y}`);
  return { x: num(p.x, `${field}.x`), y: num(p.y, `${field}.y`) };
}

function normalizeShape(input, field, allowed) {
  const types = allowed || SHAPES;
  assert(input && typeof input === 'object' && types.includes(input.type), 'INVALID_MASK',
    `${field}.type must be one of ${types.join(', ')}`, { received: input && input.type });
  const out = { type: input.type };
  switch (input.type) {
    case 'all': break;
    case 'rect':
    case 'ellipse':
      for (const k of ['x', 'y']) out[k] = num(input[k], `${field}.${k}`);
      for (const k of ['w', 'h']) out[k] = num(input[k], `${field}.${k}`, 0, 100000);
      if (input.type === 'rect' && input.radius !== undefined) out.radius = num(input.radius, `${field}.radius`, 0, 100000);
      break;
    case 'polygon':
      assert(Array.isArray(input.points) && input.points.length >= 3 && input.points.length <= MAX_POINTS, 'INVALID_MASK',
        `${field}.points needs 3 to ${MAX_POINTS} points (a lasso is a polygon of many points)`);
      out.points = input.points.map((p, i) => point(p, `${field}.points[${i}]`));
      break;
    case 'path':
      assert(Array.isArray(input.segments) && input.segments.length >= 2 && input.segments.length <= MAX_POINTS, 'INVALID_MASK',
        `${field}.segments needs at least 2 path segments`);
      out.segments = input.segments.map((seg, i) => {
        const op = String(seg && seg.op || '').toUpperCase();
        assert(['M', 'L', 'Q', 'C', 'Z'].includes(op), 'INVALID_MASK', `${field}.segments[${i}].op must be M, L, Q, C or Z`);
        const s = { op };
        for (const k of ['x', 'y', 'cx', 'cy', 'c1x', 'c1y', 'c2x', 'c2y']) if (seg[k] !== undefined) s[k] = num(seg[k], `${field}.segments[${i}].${k}`);
        return s;
      });
      if (input.fillRule !== undefined) {
        assert(['nonzero', 'evenodd'].includes(input.fillRule), 'INVALID_MASK', `${field}.fillRule must be nonzero or evenodd`);
        out.fillRule = input.fillRule;
      }
      break;
    case 'brush':
      assert(Array.isArray(input.points) && input.points.length >= 1 && input.points.length <= MAX_POINTS, 'INVALID_MASK',
        `${field}.points needs 1 to ${MAX_POINTS} points`);
      out.points = input.points.map((p, i) => point(p, `${field}.points[${i}]`));
      out.size = num(input.size === undefined ? 20 : input.size, `${field}.size`, 0.5, 5000);
      out.hardness = num(input.hardness === undefined ? 1 : input.hardness, `${field}.hardness`, 0, 1);
      break;
    case 'gradient':
      out.from = point(input.from, `${field}.from`);
      out.to = point(input.to, `${field}.to`);
      out.fromValue = num(input.fromValue === undefined ? 0 : input.fromValue, `${field}.fromValue`, 0, 1);
      out.toValue = num(input.toValue === undefined ? 1 : input.toValue, `${field}.toValue`, 0, 1);
      break;
    case 'pixels':
      for (const k of ['x', 'y']) out[k] = num(input[k], `${field}.${k}`);
      for (const k of ['w', 'h']) out[k] = Math.round(num(input[k], `${field}.${k}`, 1, 16384));
      assert(typeof input.rle === 'string' && input.rle.length <= MAX_RLE && /^[A-Za-z0-9+/=]*$/.test(input.rle), 'INVALID_MASK',
        `${field}.rle must be base64 run-length data`);
      out.rle = input.rle;
      break;
    default: break;
  }
  return out;
}

function normalizeStep(input, field) {
  assert(input && typeof input === 'object', 'INVALID_MASK', `${field} must be an object`);
  const op = input.op;
  if (op === 'paint' || op === 'intersect') {
    const out = { op, shape: normalizeShape(input.shape, `${field}.shape`) };
    if (op === 'paint') out.value = num(input.value === undefined ? 1 : input.value, `${field}.value`, 0, 1);
    if (input.feather !== undefined && Number(input.feather) > 0) out.feather = num(input.feather, `${field}.feather`, 0, 1000);
    return out;
  }
  assert(MODIFIERS.includes(op), 'INVALID_MASK', `${field}.op must be paint, intersect, ${MODIFIERS.join(', ')}`, { received: op });
  if (op === 'invert') return { op };
  return { op, radius: num(input.radius, `${field}.radius`, 0, 1000) };
}

function normalizeProgram(list, field) {
  assert(Array.isArray(list), 'INVALID_MASK', `${field} must be an array of steps`);
  assert(list.length <= MAX_STEPS, 'INVALID_MASK', `${field} allows at most ${MAX_STEPS} steps`);
  return list.map((s, i) => normalizeStep(s, `${field}[${i}]`));
}

function maskCommon(input, field) {
  const out = {
    enabled: input.enabled !== false,
    invert: Boolean(input.invert),
    density: num(input.density === undefined ? 1 : input.density, `${field}.density`, 0, 1),
    feather: num(input.feather === undefined ? 0 : input.feather, `${field}.feather`, 0, 1000),
    linked: input.linked !== false,
  };
  return out;
}

function normalizeMask(input, field) {
  if (input === undefined || input === null) return undefined;
  assert(typeof input === 'object', 'INVALID_MASK', `${field} must be an object`);
  return Object.assign(maskCommon(input, field), { program: normalizeProgram(input.program || [{ op: 'paint', value: 1, shape: { type: 'all' } }], `${field}.program`) });
}

function normalizeVectorMask(input, field) {
  if (input === undefined || input === null) return undefined;
  assert(typeof input === 'object', 'INVALID_MASK', `${field} must be an object`);
  assert(Array.isArray(input.shapes) && input.shapes.length >= 1 && input.shapes.length <= 500, 'INVALID_MASK',
    `${field}.shapes needs 1 to 500 shapes (rect, ellipse, polygon, path)`);
  return Object.assign(maskCommon(input, field), { shapes: input.shapes.map((s, i) => normalizeShape(s, `${field}.shapes[${i}]`, VECTOR_SHAPES)) });
}

/** A vector mask as a coverage program: the union of its shapes. */
const vectorProgram = (mask) => mask.shapes.map((shape) => ({ op: 'paint', value: 1, shape }));

module.exports = { SHAPES, VECTOR_SHAPES, MODIFIERS, normalizeShape, normalizeStep, normalizeProgram, normalizeMask, normalizeVectorMask, vectorProgram };
