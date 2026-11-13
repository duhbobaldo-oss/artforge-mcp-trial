'use strict';

const fs = require('node:fs');
const path = require('node:path');

// generation.generate used to return only a bounded preview: the full-resolution image existed in memory and was
// dropped, so a 1024x576 painting reached the user as a 380px thumbnail. Delivery now has two durable parts:
//   1. the exact provider PNG written to <project>/outputs (atomic write, idempotent per operationId);
//   2. an editable document with the image as its base layer, so exact text is added with draw.text afterwards
//      (generators garble lettering) and the composite is exported at the image's real size.
const documents = new Map(); // operationId -> documentId (process-local, like the adapter's receipts)

function writeOutput(projectRoot, operationId, bytes) {
  const dir = path.join(projectRoot, 'outputs');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `generated-${operationId}.png`);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, bytes);
  fs.renameSync(tmp, file);
  return file;
}

async function editableDocument(bridge, operationId, generated) {
  const known = documents.get(operationId);
  if (known) return { documentId: known, reused: true };
  let documentId; let assetId;
  try {
    const created = (await bridge.call('document.create', { name: `Generated ${operationId}`.slice(0, 60), width: generated.width, height: generated.height,
      background: '#ffffff', notes: JSON.stringify({ generated: true, operationId, sha256: generated.sha256 }) })).data;
    documentId = created.documentId || created.document.id;
    const image = (await bridge.call('image.add', { name: `generated-${operationId}`, dataUrl: 'data:image/png;base64,' + generated.bytes.toString('base64') })).data;
    assetId = image.asset.id;
    await bridge.call('draw.image', { documentId, assetId, x: 0, y: 0, w: generated.width, h: generated.height, name: 'Generated image', fit: 'contain' });
    await bridge.call('document.save', { documentId });
    documents.set(operationId, documentId);
    if (documents.size > 64) documents.delete(documents.keys().next().value);
    return { documentId, reused: false };
  } catch (e) {
    if (documentId) await bridge.call('document.delete', { documentId }).catch(() => {});
    if (assetId) await bridge.call('image.remove', { assetId }).catch(() => {});
    throw e;
  }
}

/** Persist a generated image. The file is mandatory; the editable document is best-effort and reported. */
async function deliverGenerated(engine, generated, params) {
  const operationId = String(params.operationId);
  const file = writeOutput(engine.projectRoot, operationId, generated.bytes);
  const exported = { path: file, bytes: generated.bytes.length, width: generated.width, height: generated.height, format: 'png', sha256: generated.sha256 };
  if (params.editableDocument === false) return { exported, document: { skipped: true, reason: 'editableDocument:false' } };
  try {
    const doc = await editableDocument(engine.bridge, operationId, generated);
    return { exported, document: { documentId: doc.documentId, reused: doc.reused,
      next: 'Add exact text with artforge_tool_op op:"batch" (draw.text) on this documentId, then artforge_export for the composite.' } };
  } catch (e) {
    return { exported, document: { skipped: true, reason: 'DOCUMENT_CREATE_FAILED', message: String(e && e.message || e).slice(0, 200) } };
  }
}

module.exports = { deliverGenerated };
