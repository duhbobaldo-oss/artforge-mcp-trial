'use strict';
const crypto = require('node:crypto');

async function generatedPreview(image, canvasModule, limit = 300000) {
  if (image.bytes.toString('base64').length <= limit) return image;
  const decoded = await canvasModule.loadImage(image.bytes);
  let width = Math.min(image.width, 900);
  for (let attempt = 0; attempt < 6; attempt++) {
    const height = Math.max(1, Math.round(image.height * width / image.width));
    const canvas = canvasModule.createCanvas(width, height);
    canvas.getContext('2d').drawImage(decoded, 0, 0, width, height);
    const bytes = canvas.toBuffer('image/png');
    if (bytes.toString('base64').length <= limit) return { bytes, mimeType: 'image/png', width, height,
      sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
    if (width === 1) break;
    width = Math.max(1, Math.floor(width * 0.65));
  }
  throw Object.assign(new Error('PREVIEW_SIZE_LIMIT'), { code: 'PREVIEW_SIZE_LIMIT' });
}
module.exports = { generatedPreview };
