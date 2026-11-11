'use strict';

const crypto = require('node:crypto');
const error = code => Object.assign(new Error(code), { code });
const text = (v, max) => typeof v === 'string' && v.length <= max;
function exactKeys(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !keys.includes(k))) throw error('INVALID_GENERATION_SPEC');
}

// Separate versioned contract: no changes to SceneSpec v1 or legacy generation.generate.
function compileGenerationSpec(input) {
  exactKeys(input, ['version', 'operationId', 'prompt', 'width', 'height', 'seed', 'overlays']);
  if (input.version !== 1 || typeof input.operationId !== 'string' || !/^[A-Za-z0-9_-]{1,96}$/.test(input.operationId)
    || !text(input.prompt, 6000) || !input.prompt.trim()
    || ![input.width, input.height].every(n => Number.isInteger(n) && n >= 64 && n <= 2048 && n % 16 === 0)
    || !Number.isInteger(input.seed) || input.seed < 0 || input.seed > 0xffffffff) throw error('INVALID_GENERATION_SPEC');
  const overlays = input.overlays === undefined ? [] : input.overlays;
  if (!Array.isArray(overlays) || overlays.length > 20) throw error('INVALID_GENERATION_SPEC');
  const normalized = overlays.map(o => {
    exactKeys(o, ['text', 'x', 'y', 'w', 'h', 'fontSize', 'rtl', 'color']);
    if (!text(o.text, 2000) || !o.text || ![o.x, o.y, o.w, o.h, o.fontSize].every(Number.isFinite)
      || o.x < 0 || o.y < 0 || o.w <= 0 || o.h <= 0 || o.x + o.w > input.width || o.y + o.h > input.height
      || o.fontSize < 8 || o.fontSize > 200 || typeof o.rtl !== 'boolean' || !/^#[0-9a-f]{6}$/i.test(o.color)) throw error('INVALID_GENERATION_SPEC');
    return { text: o.text, x: o.x, y: o.y, w: o.w, h: o.h, fontSize: o.fontSize, rtl: o.rtl, color: o.color };
  });
  return { version: 1, operationId: input.operationId, prompt: input.prompt, width: input.width, height: input.height, seed: input.seed, overlays: normalized };
}
function fingerprint(spec, profile) {
  const { operationId, ...content } = spec;
  return crypto.createHash('sha256').update(JSON.stringify({ content, profile })).digest('hex');
}
module.exports = { compileGenerationSpec, fingerprint, error };
