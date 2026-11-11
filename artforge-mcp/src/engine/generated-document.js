'use strict';

// Reuses the real renderer, Arabic shaping, assets and project persistence. No second canvas implementation.
async function createGeneratedDocument(bridge, spec, bytes, context) {
  const call = async (op, params) => {
    if (context.signal?.aborted) throw Object.assign(new Error('GENERATION_CANCELLED'), { code: 'GENERATION_CANCELLED' });
    const result = await bridge.call(op, params);
    return result.data;
  };
  let documentId, assetId;
  try {
    const created = await call('document.create', { name: context.jobId, width: spec.width, height: spec.height, background: '#ffffff',
      notes: JSON.stringify({ generationJob: context.jobId, generated: true, seed: spec.seed }) });
    documentId = created.documentId || created.document.id;
    const image = await call('image.add', { name: context.jobId, dataUrl: 'data:image/png;base64,' + bytes.toString('base64') });
    assetId = image.asset.id;
    await call('draw.image', { documentId, assetId, x: 0, y: 0, w: spec.width, h: spec.height, name: 'Generated image', fit: 'contain' });
    for (const overlay of spec.overlays) await call('draw.text', { documentId, text: overlay.text, x: overlay.rtl ? overlay.x + overlay.w : overlay.x, y: overlay.y, w: overlay.w, h: overlay.h,
      font: { family: overlay.rtl ? 'Tajawal' : 'Consolas', size: overlay.fontSize }, fill: overlay.color, rtl: overlay.rtl,
      align: overlay.rtl ? 'right' : 'left', maxWidth: overlay.w, name: 'Editable exact text' });
    const saved = await call('document.save', { documentId });
    const exported = await call('export.image', { documentId, format: 'png' });
    if (context.signal?.aborted) throw Object.assign(new Error('GENERATION_CANCELLED'), { code: 'GENERATION_CANCELLED' });
    const artifact = context.artifacts?.register(exported.path, 'png', documentId);
    return { documentId, saved: true, exported: true, project: saved, export: exported, artifact: artifact || null };
  } catch (e) {
    // Existing document/asset lifecycle owns cleanup; no global delete, no production paths.
    if (documentId) await bridge.call('document.delete', { documentId }).catch(() => {});
    if (assetId) await bridge.call('image.remove', { assetId }).catch(() => {});
    throw e;
  }
}
module.exports = { createGeneratedDocument };
