'use strict';

// Measure each PNG; image complexity does not scale linearly with its dimensions.
async function boundedPreview(bridge, documentId, requestedWidth) {
  const rawLimit = Number(process.env.ARTFORGE_MAX_IMAGE_B64_CHARS || 300000);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.floor(rawLimit) : 300000;
  let width = Math.max(120, Math.min(1600, Number(requestedWidth) || 900));
  let image;
  let attempts = 0;
  let previousSize = Infinity;
  while (attempts < 6) {
    image = await bridge.previewPng(documentId, width);
    attempts += 1;
    if (image.base64.length <= limit) return { ...image, width, attempts, fitsLimit: true, limit };
    // Stop at the minimum size or when another render makes no progress.
    if (attempts === 6 || width === 120 || image.base64.length >= previousSize) break;
    previousSize = image.base64.length;
    width = Math.max(120, Math.min(width - 1, Math.floor(width * Math.sqrt(limit * 0.85 / image.base64.length))));
  }
  return { skipped: true, reason: 'PREVIEW_SIZE_LIMIT', fitsLimit: false, attempts, limit, bytes: image.bytes, width };
}

module.exports = { boundedPreview };
