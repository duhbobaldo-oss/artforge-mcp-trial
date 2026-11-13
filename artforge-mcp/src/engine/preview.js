'use strict';

// Measure each PNG; image complexity does not scale linearly with its dimensions.
async function boundedPreview(bridge, documentId, requestedWidth) {
  const rawLimit = Number(process.env.ARTFORGE_MAX_IMAGE_B64_CHARS || 300000);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.floor(rawLimit) : 300000;
  let width = Math.max(120, Math.min(1600, Number(requestedWidth) || 900));
  let image;
  let attempts = 0;
  // Keep shrinking until the PNG fits. A smaller render is not always a smaller file (anti-aliased gradients can
  // grow a little), so "no progress" must not end the search: a 768x1024 cover gave up after two tries and the
  // client received no image at all. Each step shrinks by at least 20%, down to the 120px minimum.
  // Two consecutive renders that do not shrink end the search (the renderer is not responding to width).
  const maxAttempts = 10;
  let previousSize = Infinity; let stalled = 0;
  while (attempts < maxAttempts) {
    image = await bridge.previewPng(documentId, width);
    attempts += 1;
    if (image.base64.length <= limit) return { ...image, width, attempts, fitsLimit: true, limit };
    stalled = image.base64.length >= previousSize ? stalled + 1 : 0;
    previousSize = image.base64.length;
    if (width === 120 || stalled >= 2) break;
    const estimate = Math.floor(width * Math.sqrt(limit * 0.85 / image.base64.length));
    width = Math.max(120, Math.min(Math.floor(width * 0.8), estimate));
  }
  return { skipped: true, reason: 'PREVIEW_SIZE_LIMIT', fitsLimit: false, attempts, limit, bytes: image.bytes, width };
}

module.exports = { boundedPreview };
