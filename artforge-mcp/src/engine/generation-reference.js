'use strict';

const crypto = require('node:crypto');
const { validatePng } = require('./png-contract');
const fail = code => Object.assign(new Error(code), { code });

// Only a document already accessible through the drawing bridge can be referenced.
// No client-selected URL, file path, base64 upload, or provider configuration.
async function documentReference(bridge, documentId) {
  if (typeof documentId !== 'string' || !/^doc_[A-Za-z0-9_-]{1,96}$/.test(documentId)) throw fail('INVALID_GENERATION_REFERENCE');
  let info, preview;
  try {
    info = (await bridge.call('document.info', { documentId })).data.document?.canvas;
    if (!info || ![info.width, info.height].every(n => Number.isInteger(n) && n > 0 && n <= 8192)) throw fail('INVALID_GENERATION_REFERENCE');
    // Cloudflare requires each reference dimension to be strictly below 512px.
    const maxWidth = Math.max(1, Math.min(info.width, 511, Math.floor(511 * info.width / info.height)));
    preview = (await bridge.call('document.preview', { documentId, maxWidth, static: true })).data;
  } catch (e) {
    if (e.code === 'INVALID_GENERATION_REFERENCE') throw e;
    throw fail('GENERATION_REFERENCE_UNAVAILABLE');
  }
  if (!preview || ![preview.width, preview.height].every(n => Number.isInteger(n) && n >= 1 && n < 512)
    || typeof preview.base64 !== 'string' || preview.base64.length > 2 * 1024 * 1024
    || !/^[A-Za-z0-9+/]+={0,2}$/.test(preview.base64)) throw fail('INVALID_GENERATION_REFERENCE');
  const bytes = Buffer.from(preview.base64, 'base64');
  try { validatePng(bytes, preview); } catch { throw fail('INVALID_GENERATION_REFERENCE'); }
  return { documentId, mimeType: 'image/png', width: preview.width, height: preview.height,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'), bytes };
}

module.exports = { documentReference };
