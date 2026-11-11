'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createCanvas } = require('@napi-rs/canvas');
const { assert } = require('./errors');
const { render } = require('./renderer');
const { encodePng } = require('./png');

// Offscreen canvases for layer filters, patterns and post effects (the browser uses OffscreenCanvas).
globalThis.__artforgeCreateCanvas = createCanvas;

const MIME = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp' };
const EXT = { png: '.png', jpeg: '.jpg', webp: '.webp' };
const MAX_EXPORT_PIXELS = 16384;

function normalizeFormat(format) {
  const value = String(format || 'png').toLowerCase();
  const normalized = value === 'jpg' ? 'jpeg' : value;
  assert(MIME[normalized], 'INVALID_FORMAT', 'format must be png, jpeg or webp', { received: format });
  return normalized;
}

function normalizeScale(scale) {
  const value = scale === undefined ? 1 : Number(scale);
  assert(Number.isFinite(value) && value > 0 && value <= 4, 'INVALID_SCALE',
    'scale must be a number greater than 0 and at most 4', { received: scale });
  return value;
}

/**
 * Full-size render cache. Export, QA and preview of one design used to rasterise the same document three times.
 * The key is a fingerprint of the document content (canvas, layers, animation) plus the render options, so any
 * change to any object is a different key: a stale image cannot be served. Only full-size (scale 1) renders are
 * cached, and only for callers that ask (cache: true); returned canvases are read-only for those callers.
 */
const RENDER_CACHE = [];
const RENDER_CACHE_SIZE = 3;
function renderKey(doc, opts) {
  return crypto.createHash('sha1')
    .update(JSON.stringify([doc.canvas, doc.layers, doc.animation || null, opts.time || 0, opts.applyAnimation !== false, opts.flattenBackground || '']))
    .digest('hex');
}
function cachedRender(key) {
  const hit = RENDER_CACHE.find((entry) => entry.key === key);
  return hit ? hit.value : null;
}

/**
 * Rasterise a document with the shared renderer.
 * Returns { canvas, ctx, warnings, width, height, scale }.
 */
function renderToCanvas(doc, options) {
  const opts = options || {};
  const scale = normalizeScale(opts.scale);
  let key = null;
  if (opts.cache && scale === 1 && process.env.ARTFORGE_RENDER_CACHE !== 'off') {
    key = renderKey(doc, opts);
    const hit = cachedRender(key);
    if (hit) return Object.assign({}, hit, { cached: true });
  }
  const result = renderUncached(doc, opts, scale);
  if (key) {
    RENDER_CACHE.unshift({ key, value: result });
    RENDER_CACHE.length = Math.min(RENDER_CACHE.length, RENDER_CACHE_SIZE);
  }
  return result;
}

function renderUncached(doc, opts, scale) {
  const width = Math.max(1, Math.round(doc.canvas.width * scale));
  const height = Math.max(1, Math.round(doc.canvas.height * scale));
  assert(width <= MAX_EXPORT_PIXELS && height <= MAX_EXPORT_PIXELS, 'EXPORT_TOO_LARGE',
    `rendered size ${width}x${height} exceeds the ${MAX_EXPORT_PIXELS}px limit; reduce scale`);
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  const warnings = [];
  if (opts.flattenBackground) {
    ctx.fillStyle = opts.flattenBackground;
    ctx.fillRect(0, 0, width, height);
  }
  ctx.save();
  ctx.scale(scale, scale);
  render(ctx, doc, {
    time: opts.time || 0,
    images: opts.images || {},
    applyAnimation: opts.applyAnimation !== false,
    warnings,
  });
  ctx.restore();
  return { canvas, ctx, warnings, width, height, scale };
}

/** Encode a document to an image buffer (no disk write). */
function encodeImage(doc, options) {
  const opts = options || {};
  const format = normalizeFormat(opts.format);
  const quality = opts.quality === undefined ? 0.92 : Number(opts.quality);
  assert(Number.isFinite(quality) && quality > 0 && quality <= 1, 'INVALID_QUALITY',
    'quality must be greater than 0 and at most 1', { received: opts.quality });
  const renderStart = performance.now();
  const rendered = renderToCanvas(doc, {
    scale: opts.scale,
    time: opts.time,
    images: opts.images,
    applyAnimation: opts.applyAnimation,
    flattenBackground: format === 'jpeg' ? '#ffffff' : null,
    cache: opts.cache !== false,
  });
  const renderMs = performance.now() - renderStart;
  // Colour management: pixels are in the document's profile; convertTo converts them, and the
  // (resulting) profile is embedded unless icc:false. WebP output carries no profile.
  const colors = require('./color-profiles');
  const sourceProfile = (doc.canvas && doc.canvas.colorProfile) || 'srgb';
  const outputProfile = opts.convertTo ? colors.requireProfile(opts.convertTo) && opts.convertTo : sourceProfile;
  if (outputProfile !== sourceProfile) {
    const c = rendered.canvas.getContext('2d');
    const image = c.getImageData(0, 0, rendered.width, rendered.height);
    colors.convertPixels(image.data, sourceProfile, outputProfile);
    c.putImageData(image, 0, 0);
  }
  const encodeStart = performance.now();
  let buffer = format === 'png'
    ? encodePng(rendered.canvas)
    : rendered.canvas.toBuffer(MIME[format], quality);
  // Untagged images are read as sRGB everywhere, so sRGB output stays untagged (unchanged files and
  // previews) unless icc:true asks for the profile; any other profile is always embedded.
  const embed = format !== 'webp' && (opts.icc === true || (opts.icc !== false && outputProfile !== 'srgb'));
  if (embed) buffer = format === 'png' ? colors.embedPng(buffer, outputProfile) : colors.embedJpeg(buffer, outputProfile);
  else if (format === 'webp' && opts.icc !== false && outputProfile !== 'srgb') rendered.warnings.push(`WebP export carries no ICC profile: pixels are ${outputProfile}; use PNG/JPEG or convertTo:"srgb"`);
  return {
    buffer,
    timings: { renderMs, pngEncodeMs: format === 'png' ? performance.now() - encodeStart : 0 },
    format,
    mime: MIME[format],
    width: rendered.width,
    height: rendered.height,
    scale: rendered.scale,
    warnings: rendered.warnings,
    sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
    colorProfile: outputProfile,
    iccEmbedded: embed,
  };
}

/** Encode and write a single image file, returning its absolute path and metadata. */
function exportImage(doc, options) {
  const opts = options || {};
  assert(typeof opts.outPath === 'string' && opts.outPath.length > 0, 'INVALID_PATH',
    'outPath is required (absolute or project-relative file path)');
  const encoded = encodeImage(doc, opts);
  const outPath = path.resolve(opts.outPath);
  const writeStart = performance.now();
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, encoded.buffer);
  return {
    path: outPath,
    timings: { ...encoded.timings, exportWriteMs: performance.now() - writeStart },
    bytes: encoded.buffer.length,
    format: encoded.format,
    mime: encoded.mime,
    width: encoded.width,
    height: encoded.height,
    scale: encoded.scale,
    sha256: encoded.sha256,
    warnings: encoded.warnings,
    colorProfile: encoded.colorProfile,
    iccEmbedded: encoded.iccEmbedded,
  };
}

/** Render every frame of the animation timeline as a numbered PNG sequence. */
function exportFrames(doc, options) {
  const opts = options || {};
  assert(doc.animation && doc.animation.enabled, 'ANIMATION_DISABLED',
    'animation.enabled must be true before exporting frames (use animation.set)');
  assert(typeof opts.outDir === 'string' && opts.outDir.length > 0, 'INVALID_PATH', 'outDir is required');
  const outDir = path.resolve(opts.outDir);
  fs.mkdirSync(outDir, { recursive: true });
  const fps = Number(opts.fps || doc.animation.fps || 12);
  assert(Number.isFinite(fps) && fps >= 1 && fps <= 60, 'INVALID_FPS', 'fps must be between 1 and 60');
  const duration = doc.animation.duration;
  const frameCount = Math.max(1, Math.round((duration / 1000) * fps));
  const files = [];
  for (let index = 0; index < frameCount; index += 1) {
    const time = Math.round((index / fps) * 1000);
    const encoded = encodeImage(doc, { format: 'png', scale: opts.scale, time, images: opts.images });
    const filePath = path.join(outDir, `frame_${String(index).padStart(4, '0')}.png`);
    fs.writeFileSync(filePath, encoded.buffer);
    files.push({ index, time, path: filePath, bytes: encoded.buffer.length, sha256: encoded.sha256 });
  }
  return { frames: files.length, fps, duration, dir: outDir, files };
}

/** Small PNG used by the UI and MCP responses as an authoritative engine preview. */
function renderPreview(doc, options) {
  const opts = options || {};
  const maxWidth = Number(opts.maxWidth || 900);
  const scale = Math.min(1, maxWidth / doc.canvas.width);
  // The design was usually just exported at full size: downscale that render instead of rasterising again.
  const full = scale < 1 && process.env.ARTFORGE_RENDER_CACHE !== 'off' ? cachedRender(renderKey(doc, { time: opts.time, applyAnimation: opts.applyAnimation })) : null;
  if (full) {
    const width = Math.max(1, Math.round(doc.canvas.width * scale));
    const height = Math.max(1, Math.round(doc.canvas.height * scale));
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(full.canvas, 0, 0, width, height);
    const buffer = encodePng(canvas);
    return {
      buffer, width, height, scale: Number(scale.toFixed(4)), warnings: full.warnings, fromCache: true,
      sha256: crypto.createHash('sha256').update(buffer).digest('hex'), base64: buffer.toString('base64'),
    };
  }
  const encoded = encodeImage(doc, {
    format: 'png',
    scale,
    time: opts.time,
    images: opts.images,
    applyAnimation: opts.applyAnimation,
  });
  return {
    buffer: encoded.buffer,
    width: encoded.width,
    height: encoded.height,
    scale: Number(scale.toFixed(4)),
    sha256: encoded.sha256,
    warnings: encoded.warnings,
    base64: encoded.buffer.toString('base64'),
  };
}

module.exports = {
  MIME,
  EXT,
  MAX_EXPORT_PIXELS,
  normalizeFormat,
  normalizeScale,
  renderToCanvas,
  encodeImage,
  exportImage,
  exportFrames,
  renderPreview,
};
