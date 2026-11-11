'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { generatedPreview } = require('./generated-preview');

async function bookPagePreview(knowledge, paths, bookId, page, width = 600) {
  const book = knowledge.book(bookId);
  if (!book || !knowledge.pageRecord(bookId, page) || path.basename(book.file) !== book.file) {
    throw Object.assign(new Error('Unknown book or page'), { code: 'INVALID_BOOK_PAGE' });
  }
  if (!Number.isInteger(width) || width < 120 || width > 900) throw Object.assign(new Error('Preview width must be 120–900'), { code: 'INVALID_PAGE_PREVIEW_WIDTH' });
  const file = path.join(paths.booksDir, book.file);
  if (!fs.existsSync(file)) throw Object.assign(new Error('Original reference book is unavailable'), { code: 'BOOK_SOURCE_UNAVAILABLE' });
  const digest = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  if (digest !== book.sha256) throw Object.assign(new Error('Original book does not match the indexed source'), { code: 'BOOK_SOURCE_MISMATCH' });
  const { openBook } = require(path.join(paths.projectRoot, 'book-index', 'src', 'pdf'));
  const { loadCanvasModule } = require('./paths');
  const canvasModule = loadCanvasModule(paths.drawingTool);
  const doc = await openBook(file);
  try {
    if (page > doc.numPages) throw Object.assign(new Error('Page outside original book'), { code: 'INVALID_BOOK_PAGE' });
    const { rendered } = await doc.renderPage(page - 1, { scale: 0.6 });
    const canvas = canvasModule.createCanvas(width, Math.max(1, Math.round(rendered.height * width / rendered.width)));
    const raster = canvasModule.createCanvas(rendered.width, rendered.height);
    const ctx = raster.getContext('2d');
    const pixels = ctx.createImageData(rendered.width, rendered.height);
    pixels.data.set(rendered.data); ctx.putImageData(pixels, 0, 0);
    canvas.getContext('2d').drawImage(raster, 0, 0, canvas.width, canvas.height);
    const bytes = canvas.toBuffer('image/png');
    const preview = await generatedPreview({ bytes, mimeType: 'image/png', width: canvas.width, height: canvas.height,
      sha256: crypto.createHash('sha256').update(bytes).digest('hex') }, canvasModule);
    return { ...preview, source: { kind: 'original-book-page', bookId, page, file: book.file, sha256: digest,
      usage: 'reference-only; not a generated design', license: 'user-supplied source; redistribution rights not inferred' } };
  } finally { doc.close(); }
}
module.exports = { bookPagePreview };
