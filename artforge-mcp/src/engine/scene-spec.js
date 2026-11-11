'use strict';

// Model-authored geometry is data, never executable code or filesystem operations.
const DRAW_OPS = new Set(['draw.rect', 'draw.ellipse', 'draw.line', 'draw.polygon', 'draw.path', 'draw.gradient', 'draw.brush', 'draw.stroke', 'draw.text']);
const ID = /^(?!(?:constructor|prototype|__proto__)$)[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;
function invalid(message) {
  const error = new Error(`sceneSpec: ${message}`);
  error.code = 'INVALID_SCENE_SPEC';
  throw error;
}
function validateSceneSpec(spec) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) invalid('must be an object');
  if (JSON.stringify(spec).length > 1500000) invalid('exceeds 1.5 MB');
  if (spec.version !== 1) invalid('version must be 1');
  if (!Array.isArray(spec.elements) || !spec.elements.length || spec.elements.length > 80) invalid('elements must contain 1-80 entries');
  const elements = new Set();
  for (const el of spec.elements) {
    if (!el || !ID.test(el.id) || elements.has(el.id)) invalid('element ids must be unique ASCII identifiers');
    if (typeof el.description !== 'string' || !el.description.trim() || el.description.length > 500) invalid('each element needs a description (1-500 characters)');
    elements.add(el.id);
  }
  if (!Array.isArray(spec.layers) || !spec.layers.length || spec.layers.length > 20) invalid('layers must contain 1-20 entries');
  const layers = new Set();
  for (const layer of spec.layers) {
    if (!layer || !ID.test(layer.id) || layers.has(layer.id)) invalid('layer ids must be unique ASCII identifiers');
    layers.add(layer.id);
  }
  if (!Array.isArray(spec.operations) || !spec.operations.length || spec.operations.length > 1200) invalid('operations must contain 1-1200 drawing operations');
  function inspect(value, depth) {
    if (depth > 14) invalid('parameters are nested too deeply');
    if (typeof value === 'number' && (!Number.isFinite(value) || Math.abs(value) > 100000)) invalid('numeric parameters must be finite and bounded');
    if (typeof value === 'string' && value.length > 10000) invalid('parameter string too long');
    if (typeof value === 'string' && value.startsWith('$') && !/^\$color\.(background|backgroundAlt|accent|secondary|text)$/.test(value)) invalid('only $color role bindings are supported');
    if (value && typeof value === 'object') {
      if (Array.isArray(value) && value.length > 5000) invalid('parameter array too long');
      for (const [key, child] of Object.entries(value)) {
        if (['__proto__', 'prototype', 'constructor', 'documentId', 'layerId', 'path', 'url', 'src', 'assetId'].includes(key)) invalid(`forbidden parameter: ${key}`);
        inspect(child, depth + 1);
      }
    }
  }
  for (const op of spec.operations) {
    if (!op || !DRAW_OPS.has(op.op)) invalid('only documented primitive drawing operations are allowed');
    if (!elements.has(op.element) || !layers.has(op.layer)) invalid('operation references an unknown element or layer');
    if (!op.params || Array.isArray(op.params) || typeof op.params !== 'object') invalid('params must be an object');
    if ('layer' in op.params) invalid('use the operation layer field');
    for (const key of ['fontSize', 'fontFamily', 'fontWeight', 'direction']) {
      if (key in op.params) invalid(`unsupported parameter ${key}; draw.text uses font:{family,size,weight} and rtl:true`);
    }
    if (op.op === 'draw.text' && (typeof op.params.text !== 'string' || !op.params.text.trim())) invalid('draw.text requires literal nonempty text');
    inspect(op.params, 0);
  }
  const applications = spec.referenceApplications || [];
  if (!Array.isArray(applications) || applications.length > 20) invalid('referenceApplications must be an array of at most 20 decisions');
  for (const decision of applications) {
    if (!decision || typeof decision.sourceId !== 'string' || typeof decision.decision !== 'string' || !decision.decision.trim()) invalid('reference decisions need sourceId and decision');
    if (!Array.isArray(decision.operationIndexes) || !decision.operationIndexes.length || decision.operationIndexes.some((i) => !Number.isInteger(i) || i < 0 || i >= spec.operations.length)) invalid('reference decision operation indexes are invalid');
  }
  return spec;
}

function composeSceneSpec(P, ctx) {
  const spec = validateSceneSpec(ctx.input.sceneSpec);
  function bind(value) {
    if (typeof value === 'string' && value.startsWith('$color.')) return ctx.roles[value.slice(7)];
    if (Array.isArray(value)) return value.map(bind);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, bind(v)]));
    return value;
  }
  for (const layer of spec.layers) P.layer(layer.id, String(layer.name || layer.id).slice(0, 100));
  const offset = P.ops.length;
  for (const step of spec.operations) P.draw(step.op, step.layer, bind(step.params), step.element, step.note);
  // These decisions are model assertions tied to actual geometry; they are not visual proof.
  return {
    mode: 'model-authored', version: 1,
    referenceApplications: (spec.referenceApplications || []).map((d) => ({ ...d, planOperationIndexes: d.operationIndexes.map((i) => offset + i), verification: 'declared-not-visually-verified' })),
    visualReview: 'required',
  };
}

module.exports = { DRAW_OPS, validateSceneSpec, composeSceneSpec };
