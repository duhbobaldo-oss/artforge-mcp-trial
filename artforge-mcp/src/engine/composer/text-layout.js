'use strict';

const path = require('node:path');
const { loadCanvasModule } = require('../paths');
const { layoutText } = require('../../../../drawing-tool/src/core/text');
const { registerBundledFonts } = require('../../../../drawing-tool/src/core/fonts');

/** Use the same shaper, wrapping and bundled fonts as the local drawing tool. No network calls. */
function fitCopy(canvas, layout, margin, content, typography) {
  const toolRoot = path.resolve(__dirname, '../../../../drawing-tool');
  registerBundledFonts(path.join(toolRoot, 'fonts'));
  const ctx = loadCanvasModule(toolRoot).createCanvas(8, 8).getContext('2d');
  const padding = Math.max(2, Math.round(Math.min(canvas.width, canvas.height) * 0.05));
  const innerWidth = canvas.width - 2 * (margin + padding);
  const widths = {
    headline: Math.max(1, Math.round(innerWidth * (layout.headline.maxWidthRatio || 1))),
    body: Math.max(1, Math.round(innerWidth * (layout.body.maxWidthRatio || 0.6))),
    kicker: innerWidth,
  };
  const availableHeight = canvas.height - 2 * margin;
  for (let step = 0; step <= 8; step += 1) {
    const scale = 1 - step * 0.05;
    const fonts = {};
    const heights = {};
    let fitsWidth = innerWidth > 0;
    for (const field of ['headline', 'body', 'kicker']) {
      fonts[field] = { ...typography[field], size: Math.max(12, Math.round(typography[field].size * scale)) };
      const measured = layoutText(ctx, { text: content[field], font: fonts[field], maxWidth: widths[field], align: 'right' });
      heights[field] = content[field] ? Math.ceil(measured.contentHeight) : 0;
      if (content[field] && measured.contentWidth > widths[field] + 0.5) fitsWidth = false;
    }
    // Amiri's Arabic marks extend above its logical line box; reserve optical breathing room.
    const gap = Math.max(8, Math.round(fonts.headline.size * 0.65));
    let cursor = padding;
    const positions = {};
    for (const field of ['kicker', 'headline', 'body']) {
      positions[field] = cursor;
      if (content[field]) cursor += heights[field] + gap;
    }
    const lineY = cursor + Math.round(padding * 0.3);
    const height = Math.max(Math.ceil(lineY + layout.accentLine.thickness + padding), Math.round(canvas.height * 0.24));
    if (fitsWidth && height <= availableHeight) {
      const top = Math.round((canvas.height - height) / 2);
      return { fonts, widths, padding, height, top, lineY: top + lineY,
        positions: Object.fromEntries(Object.entries(positions).map(([field, y]) => [field, top + y])) };
    }
  }
  const error = new Error('Copy does not fit this canvas at a readable size. Shorten the text or increase the canvas dimensions.');
  error.code = 'TEXT_LAYOUT_OVERFLOW';
  throw error;
}

module.exports = { fitCopy };