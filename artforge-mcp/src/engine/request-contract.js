'use strict';
const crypto = require('node:crypto');
const { understandRequest } = require('./understanding');
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
// Derived before planning, without caller geometry or planner-selected elements.
function requestContract(prompt, input = {}) {
  const parsed = understandRequest(prompt, {});
  const contract = {
    version: 1, prompt: String(prompt),
    required: parsed.entities.map(e => ({ id: e.id, motif: e.motif, count: e.count, attributes: e.attributes })),
    relations: parsed.relations, constraints: parsed.constraints,
    texts: Object.fromEntries(['headline', 'body', 'kicker'].filter(k => input[k] !== undefined).map(k => [k, String(input[k])])),
    ambiguities: parsed.ambiguities,
    scope: 'lexicon-recognized-requirements; unknown nouns require visual review',
  };
  contract.sha256 = crypto.createHash('sha256').update(JSON.stringify(contract)).digest('hex');
  return freeze(contract);
}
function compareContract(contract, coverage = []) {
  return contract.required.map(required => {
    const entries = coverage.filter(c => c.motif === required.motif);
    const planned = new Set(entries.flatMap(c => c.instances || [] )).size;
    return { motif: required.motif, required: required.count, planned, ok: planned >= required.count };
  });
}
module.exports = { requestContract, compareContract };
