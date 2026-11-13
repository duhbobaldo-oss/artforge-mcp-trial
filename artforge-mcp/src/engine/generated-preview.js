'use strict';
const crypto = require('node:crypto');

const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

// A generated photo does not compress as PNG: under the 300k base64 limit a 768x1024 picture came back as a
// 210px thumbnail. JPEG keeps the preview large enough to judge (the full PNG is saved to disk separately).
async function generatedPreview(image, canvasModule, limit = 300000) {
  if (image.bytes.toString('base64').length <= limit) return image;
  const decoded = await canvasModule.loadImage(image.bytes);
  const render = (width, mimeType, quality) => {
    const height = Math.max(1, Math.round(image.height * width / image.width));
    const canvas = canvasModule.createCanvas(width, height);
    const ctx = canvas.getContext('2d');
    if (mimeType === 'image/jpeg') { ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, width, height); }
    ctx.drawImage(decoded, 0, 0, width, height);
    const bytes = mimeType === 'image/jpeg' ? canvas.toBuffer('image/jpeg', quality) : canvas.toBuffer('image/png');
    return { bytes, mimeType, width, height, sha256: sha(bytes) };
  };
  const fits = (out) => out.bytes.toString('base64').length <= limit;
  let width = Math.min(image.width, 1024);
  for (let attempt = 0; attempt < 8; attempt++) {
    for (const quality of [82, 68]) {
      let out;
      try { out = render(width, 'image/jpeg', quality); } catch { out = null; }
      if (out && fits(out)) return out;
    }
    if (width === 1) break;
    width = Math.max(1, Math.floor(width * 0.8));
  }
  // JPEG encoding unavailable: fall back to the previous PNG ladder.
  width = Math.min(image.width, 900);
  for (let attempt = 0; attempt < 8; attempt++) {
    const out = render(width, 'image/png');
    if (fits(out)) return out;
    if (width === 1) break;
    width = Math.max(1, Math.floor(width * 0.65));
  }
  throw Object.assign(new Error('PREVIEW_SIZE_LIMIT'), { code: 'PREVIEW_SIZE_LIMIT' });
}
module.exports = { generatedPreview };
