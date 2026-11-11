'use strict';

/**
 * Validation, defaults and presets for layer styles (`layer.effects`).
 * Defaults are written into the document so every value is explicit and editable later.
 * Sizes and distances are in document pixels; opacity, spread, choke and shade are 0..1.
 */

const { assert } = require('./errors');
const { makeId } = require('./ids');
const { normalizeColor, normalizePaint, BLEND_MODES } = require('./paint');
const { normalizePattern } = require('./effects');

const LIGHT = { angle: 120, altitude: 30 };

const DEFAULTS = {
  dropShadow: { color: '#000000', opacity: 0.75, blend: 'multiply', useGlobalLight: true, angle: 120, distance: 5, spread: 0, size: 5, knockout: true },
  innerShadow: { color: '#000000', opacity: 0.75, blend: 'multiply', useGlobalLight: true, angle: 120, distance: 5, choke: 0, size: 5 },
  outerGlow: { color: '#ffffbe', opacity: 0.75, blend: 'screen', spread: 0, size: 5 },
  innerGlow: { color: '#ffffbe', opacity: 0.75, blend: 'screen', source: 'edge', choke: 0, size: 5 },
  stroke: { size: 3, position: 'outside', paint: '#000000', opacity: 1, blend: 'source-over' },
  bevel: {
    style: 'inner', technique: 'smooth', depth: 1, direction: 'up', size: 5, soften: 0,
    useGlobalLight: true, angle: 120, altitude: 30,
    highlightColor: '#ffffff', highlightBlend: 'screen', highlightOpacity: 0.75,
    shadowColor: '#000000', shadowBlend: 'multiply', shadowOpacity: 0.75,
  },
  colorOverlay: { color: '#ff0000', opacity: 1, blend: 'source-over' },
  // Satin: the shape's blurred silhouette offset both ways along `angle`, differenced, shaped by a contour.
  satin: { color: '#000000', opacity: 0.5, blend: 'multiply', angle: 19, distance: 11, size: 14, invert: true, contour: 'gaussian' },
  gradientOverlay: { gradient: { type: 'linear', angle: 90, stops: [{ offset: 0, color: '#000000' }, { offset: 1, color: '#ffffff' }] }, opacity: 1, blend: 'source-over' },
  patternOverlay: { pattern: { type: 'pattern', kind: 'noise', color: 'rgba(0,0,0,0.35)', scale: 10 }, opacity: 1, blend: 'source-over' },
  extrude: { depth: 12, angle: 300, color: '#333333', shade: 0.5, opacity: 1, blend: 'source-over' },
};
const TYPES = Object.keys(DEFAULTS);
const ENUMS = {
  innerGlow: { source: ['edge', 'center'] },
  stroke: { position: ['outside', 'inside', 'center'] },
  bevel: { style: ['inner', 'outer', 'emboss'], technique: ['smooth', 'chisel'], direction: ['up', 'down'] },
};
const RANGES = {
  opacity: [0, 1], spread: [0, 1], choke: [0, 1], shade: [0, 1], highlightOpacity: [0, 1], shadowOpacity: [0, 1],
  size: [0, 250], distance: [0, 30000], soften: [0, 16], depth: [0.01, 10], altitude: [0, 90], angle: [-360, 360],
};
// Per-type ranges where one key means different things: bevel depth is a multiplier, extrusion depth is px.
const TYPE_RANGES = { extrude: { depth: [0, 500] } };
const rangeOf = (type, key) => (TYPE_RANGES[type] && TYPE_RANGES[type][key]) || RANGES[key];
const BLEND_KEYS = ['blend', 'highlightBlend', 'shadowBlend'];
const COLOR_KEYS = ['color', 'highlightColor', 'shadowColor'];
const MAX_EFFECTS = 32;
// Contours reshape an effect's falloff (Photoshop's Contour picker): a named preset or 2-16 [input, output] points (0..255).
const CONTOURS = ['linear', 'gaussian', 'cone', 'coneInverted', 'cove', 'halfRound', 'ring', 'ringDouble', 'rollingSlope', 'sawtooth'];
const CONTOUR_TYPES = ['dropShadow', 'innerShadow', 'outerGlow', 'innerGlow', 'bevel', 'satin'];

function normalizeContour(value, field) {
  if (typeof value === 'string') {
    assert(CONTOURS.includes(value), 'INVALID_EFFECT', `${field} must be one of ${CONTOURS.join(', ')} or a list of [input, output] points`, { received: value });
    return value;
  }
  assert(Array.isArray(value) && value.length >= 2 && value.length <= 16, 'INVALID_EFFECT', `${field} needs 2 to 16 [input, output] points (0..255)`);
  return value.map((p, i) => {
    assert(Array.isArray(p) && p.length === 2 && p.every((v) => Number.isFinite(Number(v)) && Number(v) >= 0 && Number(v) <= 255),
      'INVALID_EFFECT', `${field}[${i}] must be [input, output] in 0..255`);
    return [Number(p[0]), Number(p[1])];
  }).sort((a, b) => a[0] - b[0]);
}

function normalizeEffect(input, label) {
  assert(input && typeof input === 'object', 'INVALID_EFFECT', `${label} must be an object with a type`);
  assert(TYPES.includes(input.type), 'INVALID_EFFECT', `${label}.type is not supported`, { received: input.type, allowed: TYPES });
  const defaults = DEFAULTS[input.type];
  const known = new Set(['id', 'type', 'enabled', 'name'].concat(Object.keys(defaults), CONTOUR_TYPES.includes(input.type) ? ['contour'] : []));
  const unknown = Object.keys(input).filter((k) => !known.has(k));
  assert(!unknown.length, 'INVALID_EFFECT', `${label} (${input.type}) does not support ${unknown.join(', ')}`, { unknown, allowed: [...known] });
  const out = { id: typeof input.id === 'string' && input.id ? input.id : makeId('fx'), type: input.type, enabled: input.enabled !== false };
  if (input.name) out.name = String(input.name);
  for (const [key, fallback] of Object.entries(defaults)) {
    const value = input[key] === undefined ? fallback : input[key];
    const field = `${label}.${key}`;
    const range = rangeOf(input.type, key);
    if (range) {
      const n = Number(value);
      assert(Number.isFinite(n) && n >= range[0] && n <= range[1], 'INVALID_EFFECT',
        `${field} must be between ${range[0]} and ${range[1]}`, { received: value });
      out[key] = n;
    } else if (BLEND_KEYS.includes(key)) {
      assert(BLEND_MODES.includes(value), 'INVALID_BLEND', `${field} is not supported`, { received: value });
      out[key] = value;
    } else if (COLOR_KEYS.includes(key)) {
      out[key] = normalizeColor(value, field);
    } else if (ENUMS[input.type] && ENUMS[input.type][key]) {
      assert(ENUMS[input.type][key].includes(value), 'INVALID_EFFECT', `${field} must be ${ENUMS[input.type][key].join(', ')}`, { received: value });
      out[key] = value;
    } else if (key === 'paint') {
      out.paint = normalizePaint(value, field);
      assert(typeof out.paint === 'string' || ['linear', 'radial', 'conic', 'pattern'].includes(out.paint.type), 'INVALID_EFFECT',
        `${field} must be a colour, gradient or pattern`);
    } else if (key === 'gradient') {
      out.gradient = normalizePaint(value, field);
      assert(out.gradient && ['linear', 'radial', 'conic'].includes(out.gradient.type), 'INVALID_EFFECT', `${field} must be a gradient`);
    } else if (key === 'contour') {
      out.contour = normalizeContour(value, field);
    } else if (key === 'pattern') {
      out.pattern = normalizePattern(Object.assign({ type: 'pattern' }, value), field);
    } else if (typeof fallback === 'boolean') {
      out[key] = Boolean(value);
    } else {
      out[key] = value;
    }
  }
  // Optional contour on effects whose default has none: stored only when it is not linear.
  if (input.contour !== undefined && defaults.contour === undefined) {
    const contour = normalizeContour(input.contour, `${label}.contour`);
    if (contour !== 'linear') out.contour = contour;
  }
  return out;
}

function normalizeEffectList(list, label) {
  if (list === undefined || list === null) return undefined;
  assert(Array.isArray(list), 'INVALID_EFFECT', `${label}.effects must be an array`);
  assert(list.length <= MAX_EFFECTS, 'INVALID_EFFECT', `${label}.effects allows at most ${MAX_EFFECTS} effects`);
  const out = list.map((e, i) => normalizeEffect(e, `${label}.effects[${i}]`));
  const ids = new Set(out.map((e) => e.id));
  assert(ids.size === out.length, 'INVALID_EFFECT', `${label}.effects ids must be unique`);
  return out.length ? out : undefined;
}

function normalizeGlobalLight(input) {
  if (input === undefined || input === null) return undefined;
  assert(typeof input === 'object', 'INVALID_LIGHT', 'canvas.globalLight must be {angle, altitude}');
  const angle = input.angle === undefined ? LIGHT.angle : Number(input.angle);
  const altitude = input.altitude === undefined ? LIGHT.altitude : Number(input.altitude);
  assert(Number.isFinite(angle) && angle >= -360 && angle <= 360, 'INVALID_LIGHT', 'canvas.globalLight.angle must be between -360 and 360');
  assert(Number.isFinite(altitude) && altitude >= 0 && altitude <= 90, 'INVALID_LIGHT', 'canvas.globalLight.altitude must be between 0 and 90');
  return { angle, altitude };
}

// Presets are parameter stacks (editable afterwards), not baked images. `color` tints the preset.
const PRESETS = {
  gold: () => [
    { type: 'gradientOverlay', gradient: { type: 'linear', angle: 90, stops: [
      { offset: 0, color: '#fff3b0' }, { offset: 0.35, color: '#e2b53e' }, { offset: 0.55, color: '#a8741a' },
      { offset: 0.8, color: '#f2d06b' }, { offset: 1, color: '#7a4f0c' }] } },
    { type: 'bevel', style: 'inner', technique: 'chisel', depth: 2.2, size: 6, soften: 1, altitude: 40, highlightOpacity: 0.85, shadowColor: '#4a2e00', shadowOpacity: 0.7 },
    { type: 'stroke', size: 2, position: 'outside', paint: '#5a3a06' },
    { type: 'dropShadow', distance: 6, size: 10, opacity: 0.55 },
  ],
  chrome: () => [
    { type: 'gradientOverlay', gradient: { type: 'linear', angle: 90, stops: [
      { offset: 0, color: '#ffffff' }, { offset: 0.45, color: '#9aa4ad' }, { offset: 0.5, color: '#3b434a' },
      { offset: 0.62, color: '#c9d1d8' }, { offset: 1, color: '#6d767e' }] } },
    { type: 'bevel', style: 'inner', technique: 'smooth', depth: 2.5, size: 5, altitude: 45, highlightOpacity: 0.9, shadowOpacity: 0.65 },
    { type: 'stroke', size: 1.5, position: 'outside', paint: '#2b3035' },
    { type: 'dropShadow', distance: 5, size: 8, opacity: 0.5 },
  ],
  glass: (color) => [
    { type: 'colorOverlay', color: color || '#9fd8ff', opacity: 0.35 },
    { type: 'innerGlow', color: '#ffffff', source: 'edge', size: 6, opacity: 0.7, blend: 'screen' },
    { type: 'bevel', style: 'inner', technique: 'smooth', depth: 1.5, size: 8, soften: 2, altitude: 60, highlightOpacity: 0.9, shadowOpacity: 0.25 },
    { type: 'stroke', size: 1, position: 'inside', paint: 'rgba(255,255,255,0.8)' },
    { type: 'dropShadow', distance: 8, size: 14, opacity: 0.3 },
  ],
  neon: (color) => [
    { type: 'colorOverlay', color: '#ffffff', opacity: 1 },
    { type: 'innerGlow', color: color || '#ff2bd6', source: 'edge', size: 4, opacity: 0.9, blend: 'source-over' },
    { type: 'outerGlow', color: color || '#ff2bd6', size: 10, spread: 0.15, opacity: 0.9, blend: 'screen' },
    { type: 'outerGlow', color: color || '#ff2bd6', size: 28, opacity: 0.55, blend: 'screen' },
  ],
  emboss: () => [
    { type: 'bevel', style: 'emboss', technique: 'smooth', depth: 1.5, size: 4, altitude: 35 },
  ],
  extruded: (color) => [
    { type: 'extrude', depth: 14, angle: 300, color: color || '#3b3b3b', shade: 0.6 },
    { type: 'bevel', style: 'inner', technique: 'chisel', depth: 1.2, size: 3, altitude: 45, highlightOpacity: 0.6, shadowOpacity: 0.4 },
    { type: 'dropShadow', distance: 18, size: 16, opacity: 0.45 },
  ],
};

function presetEffects(name, color, label) {
  assert(Object.prototype.hasOwnProperty.call(PRESETS, name), 'INVALID_PRESET', `unknown effect preset: ${name}`, { allowed: Object.keys(PRESETS) });
  if (color !== undefined) normalizeColor(color, `${label || 'preset'}.color`);
  return PRESETS[name](color).map((e, i) => normalizeEffect(e, `${label || 'preset'}[${i}]`));
}

module.exports = { CONTOURS, normalizeContour, DEFAULTS, TYPES, PRESETS: Object.keys(PRESETS), MAX_EFFECTS, LIGHT, normalizeEffect, normalizeEffectList, normalizeGlobalLight, presetEffects };
