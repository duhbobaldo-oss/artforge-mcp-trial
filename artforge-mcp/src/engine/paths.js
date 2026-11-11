'use strict';

const path = require('node:path');
const fs = require('node:fs');

/**
 * The reference index needs an image decoder. Instead of installing a second copy
 * of the ~35MB Skia binary, reuse the one already installed with the drawing tool.
 */
function loadCanvasModule(toolRoot) {
  try {
    return require('@napi-rs/canvas');
  } catch {
    const candidate = path.join(toolRoot, 'node_modules', '@napi-rs', 'canvas');
    if (!fs.existsSync(candidate)) {
      throw new Error(
        `@napi-rs/canvas not found. Install the drawing tool dependencies first: cd "${toolRoot}" && npm install`,
      );
    }
    return require(candidate);
  }
}

function toolPaths(projectRoot) {
  const drawingTool = path.join(projectRoot, 'drawing-tool');
  return {
    projectRoot,
    drawingTool,
    drawingToolEntry: path.join(drawingTool, 'bin', 'artforge-draw.js'),
    drawingToolOpsSource: path.join(drawingTool, 'src', 'core', 'ops.js'),
    docsDir: path.join(projectRoot, 'docs'),
    colorSchemeDir: path.join(projectRoot, 'Color_Scheme'),
    designSystemDir: path.join(projectRoot, 'Design_System'),
    booksDir: path.join(projectRoot, 'THE_BOOK'),
    bookIndexPath: path.join(projectRoot, 'book-index', 'data', 'books.index.json'),
    bookIndexBooksDir: path.join(projectRoot, 'book-index', 'data', 'books'),
    colorSchemeReadme: path.join(projectRoot, 'Color_Scheme', 'README.md'),
    designSystemReadme: path.join(projectRoot, 'Design_System', 'README.md'),
    rootReadme: path.join(projectRoot, 'README.md'),
    referenceArchive: path.join(projectRoot, 'ArtForge.zip'),
  };
}

module.exports = { loadCanvasModule, toolPaths };
