'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { loadCanvasModule } = require('./paths');
const { extractSwatches, describePalette } = require('./swatches');

const INDEX_SCHEMA = 'artforge.references';
// v2: palettes are read as palette cards (flat swatches + card background + mood tags), not global histograms.
const INDEX_VERSION = 2;

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function mean(values) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** Dominant colours + simple tone metrics read from real pixels. */
function analyseImage(loadImage, createCanvas, filePath, paletteSize) {
  return loadImage(filePath).then((image) => {
    const sampleWidth = Math.min(96, image.width);
    const sampleHeight = Math.min(96, image.height);
    const canvas = createCanvas(sampleWidth, sampleHeight);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(image, 0, 0, sampleWidth, sampleHeight);
    const { data } = ctx.getImageData(0, 0, sampleWidth, sampleHeight);

    const buckets = new Map();
    const luminances = [];
    let edgeSum = 0;
    let edgeCount = 0;
    for (let y = 0; y < sampleHeight; y += 1) {
      for (let x = 0; x < sampleWidth; x += 1) {
        const index = (y * sampleWidth + x) * 4;
        const r = data[index];
        const g = data[index + 1];
        const b = data[index + 2];
        const key = `${r >> 4}-${g >> 4}-${b >> 4}`;
        const bucket = buckets.get(key) || { r: 0, g: 0, b: 0, n: 0 };
        bucket.r += r;
        bucket.g += g;
        bucket.b += b;
        bucket.n += 1;
        buckets.set(key, bucket);
        luminances.push(0.2126 * r + 0.7152 * g + 0.0722 * b);
        if (x + 1 < sampleWidth) {
          const right = index + 4;
          edgeSum += Math.abs(data[right] - r) + Math.abs(data[right + 1] - g) + Math.abs(data[right + 2] - b);
          edgeCount += 1;
        }
      }
    }

    const total = sampleWidth * sampleHeight;
    const sorted = Array.from(buckets.values()).sort((a, b) => b.n - a.n);
    const colors = sorted.slice(0, paletteSize || 6).map((bucket) => {
      const r = Math.round(bucket.r / bucket.n);
      const g = Math.round(bucket.g / bucket.n);
      const b = Math.round(bucket.b / bucket.n);
      return {
        hex: `#${[r, g, b].map((value) => value.toString(16).padStart(2, '0')).join('')}`,
        share: Number((bucket.n / total).toFixed(4)),
        luminance: Math.round(((0.2126 * r + 0.7152 * g + 0.0722 * b) / 255) * 100) / 100,
      };
    });

    const averageLuminance = mean(luminances) / 255;
    const variance = mean(luminances.map((value) => ((value / 255) - averageLuminance) ** 2));
    return {
      width: image.width,
      height: image.height,
      aspect: Number((image.width / image.height).toFixed(4)),
      colors,
      averageLuminance: Number(averageLuminance.toFixed(4)),
      contrast: Number(Math.sqrt(variance).toFixed(4)),
      edgeDensity: Number((edgeSum / Math.max(1, edgeCount) / 255).toFixed(4)),
      tone: averageLuminance < 0.45 ? 'dark' : 'light',
    };
  });
}

/** Palette card → flat swatches (see swatches.js). 200px wide is enough for swatches and takes ~15 ms. */
function readPaletteCard(loadImage, createCanvas, filePath) {
  return loadImage(filePath).then((image) => {
    const w = Math.min(200, image.width);
    const h = Math.max(8, Math.round((w * image.height) / image.width));
    const canvas = createCanvas(w, h);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(image, 0, 0, w, h);
    return extractSwatches(ctx.getImageData(0, 0, w, h).data, w, h);
  });
}

function parseInstructionRules(markdown) {
  const rules = [];
  for (const line of String(markdown || '').split(/\r?\n/)) {
    const numbered = /^(\d+)[.)]\\?\s+(.*)$/.exec(line.trim());
    if (numbered) rules.push(numbered[2].replace(/\\/g, '').replace(/\*\*/g, '').trim());
  }
  return rules.filter((rule) => rule.length > 8);
}

function readText(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

/**
 * Build the reference index from the preserved ArtForge reference folders.
 * The source images/books are only read: nothing is copied, moved or modified.
 */
async function buildReferenceIndex(paths, options) {
  const opts = options || {};
  const { loadImage, createCanvas } = loadCanvasModule(paths.drawingTool);
  const paletteSize = opts.paletteSize || 8;

  const imageFiles = (dir) => (fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((file) => /\.(png|jpe?g|webp)$/i.test(file)).sort()
    : []);

  const palettes = [];
  for (const file of imageFiles(paths.colorSchemeDir)) {
    const fullPath = path.join(paths.colorSchemeDir, file);
    const buffer = fs.readFileSync(fullPath);
    const analysis = await analyseImage(loadImage, createCanvas, fullPath, paletteSize);
    const card = await readPaletteCard(loadImage, createCanvas, fullPath);
    if (card.swatches.length >= 2) {
      analysis.histogramColors = analysis.colors;
      analysis.colors = card.swatches.map((s) => ({ hex: s.hex, share: s.share, luminance: Number(s.L.toFixed(2)), role: s.role, C: s.C, h: s.h }));
    }
    analysis.swatchSource = card.swatches.length >= 2 ? 'flat-swatches' : 'histogram';
    analysis.collection = card.collection;
    analysis.mood = describePalette(card.swatches.length >= 2 ? card.swatches : []);
    palettes.push(Object.assign({
      id: `palette-${path.basename(file, path.extname(file)).replace(/[^A-Za-z0-9-]/g, '')}`,
      kind: 'palette',
      file,
      path: fullPath,
      bytes: buffer.length,
      sha256: sha256(buffer),
    }, analysis));
  }

  const designSystems = [];
  for (const file of imageFiles(paths.designSystemDir)) {
    const fullPath = path.join(paths.designSystemDir, file);
    const buffer = fs.readFileSync(fullPath);
    const analysis = await analyseImage(loadImage, createCanvas, fullPath, 6);
    designSystems.push(Object.assign({
      id: `design-system-${path.basename(file, path.extname(file)).replace(/[^A-Za-z0-9-]/g, '')}`,
      kind: 'design-system',
      file,
      path: fullPath,
      bytes: buffer.length,
      sha256: sha256(buffer),
    }, analysis));
  }

  const books = [];
  if (fs.existsSync(paths.booksDir)) {
    for (const file of fs.readdirSync(paths.booksDir).filter((name) => /\.pdf$/i.test(name)).sort()) {
      const fullPath = path.join(paths.booksDir, file);
      const buffer = fs.readFileSync(fullPath);
      books.push({
        id: `book-${path.basename(file, path.extname(file)).replace(/[^A-Za-z0-9-]/g, '').slice(0, 48)}`,
        kind: 'book',
        file,
        path: fullPath,
        bytes: buffer.length,
        sha256: sha256(buffer),
        note: 'PDF theory source; the MCP returns its path and metadata, it does not extract the text.',
      });
    }
  }

  const instructions = [
    {
      id: 'instructions-workflow',
      kind: 'instruction',
      title: 'ArtForge workflow (project README)',
      path: paths.rootReadme,
      text: readText(paths.rootReadme),
      rules: parseInstructionRules(readText(paths.rootReadme)),
    },
    {
      id: 'instructions-design-system',
      kind: 'instruction',
      title: 'Design system usage rules',
      path: paths.designSystemReadme,
      text: readText(paths.designSystemReadme),
      rules: parseInstructionRules(readText(paths.designSystemReadme)),
    },
    {
      id: 'instructions-color-scheme',
      kind: 'instruction',
      title: 'Colour palette usage rules',
      path: paths.colorSchemeReadme,
      text: readText(paths.colorSchemeReadme).replace(/\\/g, ''),
      rules: parseInstructionRules(readText(paths.colorSchemeReadme)),
    },
  ];

  const archive = fs.existsSync(paths.referenceArchive)
    ? {
      path: paths.referenceArchive,
      bytes: fs.statSync(paths.referenceArchive).size,
      sha256: sha256(fs.readFileSync(paths.referenceArchive)),
    }
    : null;

  return {
    schema: INDEX_SCHEMA,
    version: INDEX_VERSION,
    generatedAt: new Date().toISOString(),
    source: {
      colorSchemeDir: paths.colorSchemeDir,
      designSystemDir: paths.designSystemDir,
      booksDir: paths.booksDir,
      archive,
    },
    rules: {
      palettesPerDesign: { min: 1, max: 3 },
      designSystemsPerDesign: 1,
      contentIsolation: true,
      note: 'Palettes and styleguides are visual references only; never copy their text or dummy content.',
    },
    counts: {
      palettes: palettes.length,
      designSystems: designSystems.length,
      books: books.length,
      instructions: instructions.length,
    },
    instructions,
    palettes,
    designSystems,
    books,
  };
}

module.exports = { buildReferenceIndex, INDEX_SCHEMA, INDEX_VERSION, parseInstructionRules };
