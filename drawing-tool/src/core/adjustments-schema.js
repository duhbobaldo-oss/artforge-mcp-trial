'use strict';

/** Validation and defaults for adjustment layers and smart filter stacks. */

const { assert } = require('./errors');
const { makeId } = require('./ids');
const { normalizeColor, BLEND_MODES } = require('./paint');

const num = (v, field, min, max, fallback) => {
  const n = Number(v === undefined ? fallback : v);
  assert(Number.isFinite(n) && n >= min && n <= max, 'INVALID_ADJUSTMENT', `${field} must be between ${min} and ${max}`, { received: v });
  return n;
};

function points(list, field) {
  assert(Array.isArray(list) && list.length >= 2 && list.length <= 16, 'INVALID_ADJUSTMENT', `${field} needs 2 to 16 [input, output] points (0..255)`);
  return list.map((p, i) => {
    assert(Array.isArray(p) && p.length === 2, 'INVALID_ADJUSTMENT', `${field}[${i}] must be [input, output]`);
    return [num(p[0], `${field}[${i}][0]`, 0, 255), num(p[1], `${field}[${i}][1]`, 0, 255)];
  });
}

function levels(l, field) {
  const o = l || {};
  return {
    inBlack: num(o.inBlack, `${field}.inBlack`, 0, 254, 0), inWhite: num(o.inWhite, `${field}.inWhite`, 1, 255, 255),
    gamma: num(o.gamma, `${field}.gamma`, 0.1, 9.99, 1), outBlack: num(o.outBlack, `${field}.outBlack`, 0, 255, 0), outWhite: num(o.outWhite, `${field}.outWhite`, 0, 255, 255),
  };
}

const KINDS = ['curves', 'levels', 'brightnessContrast', 'exposure', 'hueSaturation', 'vibrance', 'colorBalance', 'blackWhite',
  'photoFilter', 'gradientMap', 'invert', 'posterize', 'threshold'];

function normalizeAdjustment(input, field) {
  assert(input && KINDS.includes(input.kind), 'INVALID_ADJUSTMENT', `${field}.kind must be one of ${KINDS.join(', ')}`, { received: input && input.kind });
  const a = { kind: input.kind };
  const f = field;
  switch (input.kind) {
    case 'curves':
      a.rgb = points(input.rgb || [[0, 0], [255, 255]], `${f}.rgb`);
      for (const c of ['r', 'g', 'b']) if (input[c]) a[c] = points(input[c], `${f}.${c}`);
      break;
    case 'levels':
      a.rgb = levels(input.rgb || input, `${f}.rgb`);
      for (const c of ['r', 'g', 'b']) if (input[c]) a[c] = levels(input[c], `${f}.${c}`);
      break;
    case 'brightnessContrast':
      a.brightness = num(input.brightness, `${f}.brightness`, -1, 1, 0); a.contrast = num(input.contrast, `${f}.contrast`, -1, 0.99, 0); break;
    case 'exposure':
      a.exposure = num(input.exposure, `${f}.exposure`, -20, 20, 0); a.offset = num(input.offset, `${f}.offset`, -0.5, 0.5, 0); a.gamma = num(input.gamma, `${f}.gamma`, 0.01, 9.99, 1); break;
    case 'hueSaturation':
      a.hue = num(input.hue, `${f}.hue`, -180, 180, 0); a.saturation = num(input.saturation, `${f}.saturation`, -1, 1, 0); a.lightness = num(input.lightness, `${f}.lightness`, -1, 1, 0);
      if (input.colorize) a.colorize = { hue: num(input.colorize.hue, `${f}.colorize.hue`, 0, 360, 0), saturation: num(input.colorize.saturation, `${f}.colorize.saturation`, 0, 1, 0.25) };
      break;
    case 'vibrance':
      a.vibrance = num(input.vibrance, `${f}.vibrance`, -1, 1, 0); a.saturation = num(input.saturation, `${f}.saturation`, -1, 1, 0); break;
    case 'colorBalance':
      for (const r of ['shadows', 'midtones', 'highlights']) {
        const v = input[r] || [0, 0, 0];
        assert(Array.isArray(v) && v.length === 3, 'INVALID_ADJUSTMENT', `${f}.${r} must be [cyan↔red, magenta↔green, yellow↔blue] in -100..100`);
        a[r] = v.map((x, i) => num(x, `${f}.${r}[${i}]`, -100, 100));
      }
      a.preserveLuminosity = input.preserveLuminosity !== false; break;
    case 'blackWhite':
      for (const [k, d] of Object.entries({ reds: 40, yellows: 60, greens: 40, cyans: 60, blues: 20, magentas: 80 })) a[k] = num(input[k], `${f}.${k}`, -200, 300, d);
      if (input.tint) a.tint = { color: normalizeColor(input.tint.color || '#e1d3b3', `${f}.tint.color`), amount: num(input.tint.amount, `${f}.tint.amount`, 0, 1, 0.3) };
      break;
    case 'photoFilter':
      a.color = normalizeColor(input.color || '#ec8a00', `${f}.color`); a.density = num(input.density, `${f}.density`, 0, 1, 0.25); a.preserveLuminosity = input.preserveLuminosity !== false; break;
    case 'gradientMap': {
      const stops = input.stops || [{ offset: 0, color: '#000000' }, { offset: 1, color: '#ffffff' }];
      assert(Array.isArray(stops) && stops.length >= 2, 'INVALID_ADJUSTMENT', `${f}.stops needs at least two {offset, color}`);
      a.stops = stops.map((s, i) => ({ offset: num(s.offset, `${f}.stops[${i}].offset`, 0, 1), color: normalizeColor(s.color, `${f}.stops[${i}].color`) }));
      break;
    }
    case 'posterize': a.levels = Math.round(num(input.levels, `${f}.levels`, 2, 255, 4)); break;
    case 'threshold': a.level = num(input.level, `${f}.level`, 0, 255, 128); break;
    default: break;
  }
  return a;
}

const FILTERS = {
  gaussianBlur: { radius: [0, 250, 4] },
  motionBlur: { angle: [-360, 360, 0], distance: [1, 999, 20] },
  radialBlur: { amount: [1, 100, 10], centerX: [0, 1, 0.5], centerY: [0, 1, 0.5] },
  unsharpMask: { amount: [0, 5, 1], radius: [0.1, 250, 2], threshold: [0, 255, 0] },
  sharpen: {},
  highPass: { radius: [0.1, 250, 4] },
  addNoise: { amount: [0, 1, 0.1], seed: [0, 1e9, 7] },
  pixelate: { cellSize: [2, 500, 10] },
  adjustment: {},
};

function normalizeFilter(input, field) {
  assert(input && Object.prototype.hasOwnProperty.call(FILTERS, input.type), 'INVALID_FILTER', `${field}.type must be one of ${Object.keys(FILTERS).join(', ')}`, { received: input && input.type });
  const out = { id: typeof input.id === 'string' && input.id ? input.id : makeId('flt'), type: input.type, enabled: input.enabled !== false };
  out.opacity = num(input.opacity, `${field}.opacity`, 0, 1, 1);
  out.blend = input.blend || 'source-over';
  assert(BLEND_MODES.includes(out.blend), 'INVALID_BLEND', `${field}.blend is not supported`);
  for (const [k, [min, max, d]] of Object.entries(FILTERS[input.type])) out[k] = num(input[k], `${field}.${k}`, min, max, d);
  if (input.type === 'radialBlur') {
    out.mode = input.mode || 'spin';
    assert(['spin', 'zoom'].includes(out.mode), 'INVALID_FILTER', `${field}.mode must be spin or zoom`);
  }
  if (input.type === 'addNoise') out.monochrome = input.monochrome !== false;
  if (input.type === 'adjustment') out.adjustment = normalizeAdjustment(input.adjustment, `${field}.adjustment`);
  return out;
}

function normalizeFilterList(list, label) {
  if (list === undefined || list === null) return undefined;
  assert(Array.isArray(list) && list.length <= 32, 'INVALID_FILTER', `${label}.filters must be an array of at most 32 filters`);
  const out = list.map((f, i) => normalizeFilter(f, `${label}.filters[${i}]`));
  assert(new Set(out.map((f) => f.id)).size === out.length, 'INVALID_FILTER', `${label}.filters ids must be unique`);
  return out.length ? out : undefined;
}

module.exports = { KINDS, FILTERS: Object.keys(FILTERS), normalizeAdjustment, normalizeFilter, normalizeFilterList };
