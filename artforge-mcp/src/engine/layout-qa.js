'use strict';

/**
 * Layout QA for Arabic design output — geometry only.
 *
 * Separate from `Pipeline.verify` (structural: are requested objects/texts in the document?)
 * and from visual review (taste, needs a human or a vision model → reported as UNKNOWN here).
 *
 * Input is what the drawing tool already reports:
 *   - `document` : full document (layers → objects: type, align, text …)
 *   - `objects`  : `object.list` rows carrying the measured `box` of every object
 *
 * Only unambiguous defects become issues. Margins/RTL/whitespace are metrics, so a deliberate
 * full-bleed poster is never failed for having no margins.
 */

const THRESHOLDS = {
  textOverlapRatio: 0.2,
  textWidthRatio: 0.95,
  edgeTolerance: 1,
  backgroundCoverage: 0.9,
};

function boxOf(item) {
  const box = item && item.box;
  if (!box) return null;
  const x = Number(box.x);
  const y = Number(box.y);
  const w = Number(box.w);
  const h = Number(box.h);
  if (![x, y, w, h].every(Number.isFinite)) return null;
  return { x, y, w: Math.max(0, w), h: Math.max(0, h) };
}

function unionOf(boxes) {
  if (!boxes.length) return null;
  let x1 = Infinity; let y1 = Infinity; let x2 = -Infinity; let y2 = -Infinity;
  for (const b of boxes) {
    x1 = Math.min(x1, b.x); y1 = Math.min(y1, b.y);
    x2 = Math.max(x2, b.x + b.w); y2 = Math.max(y2, b.y + b.h);
  }
  return { x: x1, y: y1, w: Math.max(0, x2 - x1), h: Math.max(0, y2 - y1) };
}

function overlapArea(a, b) {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

function largestEmptyBand(boxes, height) {
  const rows = boxes
    .map((b) => [Math.max(0, b.y), Math.min(height, b.y + b.h)])
    .filter(([top, bottom]) => bottom > top)
    .sort((a, b) => a[0] - b[0]);
  let cursor = 0;
  let best = { from: 0, to: 0, size: 0 };
  for (const [top, bottom] of rows) {
    if (top - cursor > best.size) best = { from: cursor, to: top, size: top - cursor };
    cursor = Math.max(cursor, bottom);
  }
  if (height - cursor > best.size) best = { from: cursor, to: height, size: height - cursor };
  return best;
}

function analyzeLayout(input) {
  const opts = input || {};
  const canvas = {
    width: Number(opts.canvas && opts.canvas.width) || 0,
    height: Number(opts.canvas && opts.canvas.height) || 0,
  };
  const t = Object.assign({}, THRESHOLDS, opts.thresholds || {});
  const rows = Array.isArray(opts.objects) ? opts.objects : [];
  const textMeta = new Map();
  for (const layer of (opts.document && opts.document.layers) || []) {
    for (const object of layer.objects || []) textMeta.set(object.id, object);
  }
  const canvasArea = canvas.width * canvas.height;
  const items = [];
  for (const row of rows) {
    const box = boxOf(row);
    if (!box) continue;
    const meta = textMeta.get(row.id) || {};
    const area = box.w * box.h;
    items.push({
      id: row.id,
      type: row.type,
      name: row.name || null,
      box,
      isText: row.type === 'text',
      isBackground: canvasArea > 0 && area / canvasArea >= t.backgroundCoverage,
      align: meta.align || (row.type === 'text' ? 'right' : null),
    });
  }
  if (!items.length) {
    return { scope: 'vector-geometry-only', applicable: false, ok: null, issues: [], reason: 'no measurable objects' };
  }
  const content = items.filter((i) => !i.isBackground);
  const all = content.length ? content : items;
  const union = unionOf(all.map((i) => i.box));
  const shortSide = Math.min(canvas.width, canvas.height) || 1;
  const marginPx = {
    left: union ? Math.round(union.x) : 0,
    top: union ? Math.round(union.y) : 0,
    right: union ? Math.round(canvas.width - (union.x + union.w)) : 0,
    bottom: union ? Math.round(canvas.height - (union.y + union.h)) : 0,
  };
  const minMargin = Math.min(...Object.values(marginPx));
  const margins = { px: marginPx, minPx: Math.round(minMargin), minRatio: Number((minMargin / shortSide).toFixed(4)) };

  const clipped = items.filter((i) => !i.isBackground && (
    i.box.x < -t.edgeTolerance
    || i.box.y < -t.edgeTolerance
    || i.box.x + i.box.w > canvas.width + t.edgeTolerance
    || i.box.y + i.box.h > canvas.height + t.edgeTolerance
  ));

  const texts = items.filter((i) => i.isText);
  const textPairs = [];
  let maxOverlap = 0;
  for (let a = 0; a < texts.length; a += 1) {
    for (let b = a + 1; b < texts.length; b += 1) {
      const A = texts[a].box; const B = texts[b].box;
      const smaller = Math.min(A.w * A.h, B.w * B.h) || 1;
      const ratio = overlapArea(A, B) / smaller;
      if (ratio > maxOverlap) maxOverlap = ratio;
      if (ratio > t.textOverlapRatio) textPairs.push({ a: texts[a].id, b: texts[b].id, ratio: Number(ratio.toFixed(3)) });
    }
  }

  const wideText = texts.filter((i) => canvas.width > 0 && i.box.w / canvas.width > t.textWidthRatio).map((i) => i.id);
  const alignment = { right: 0, center: 0, left: 0 };
  for (const item of texts) {
    if (item.align === 'right') alignment.right += 1;
    else if (item.align === 'left') alignment.left += 1;
    else alignment.center += 1;
  }
  const rtl = {
    textObjects: texts.length,
    alignment,
    rightShare: texts.length ? Number((alignment.right / texts.length).toFixed(3)) : null,
  };

  const band = largestEmptyBand(all.map((i) => i.box), canvas.height);
  const coverage = canvasArea > 0 && union ? Number(((union.w * union.h) / canvasArea).toFixed(3)) : null;

  const issues = [];
  if (clipped.length) issues.push(`clipping: ${clipped.length} object(s) extend outside the canvas (${clipped.slice(0, 6).map((i) => i.id).join(', ')})`);
  if (textPairs.length) issues.push(`text overlap: ${textPairs.length} pair(s) overlap by more than ${Math.round(t.textOverlapRatio * 100)}% of the smaller box (max ${(maxOverlap * 100).toFixed(1)}%)`);
  if (wideText.length) issues.push(`text wider than ${Math.round(t.textWidthRatio * 100)}% of the canvas: ${wideText.slice(0, 6).join(', ')}`);
  if (texts.length >= 2 && alignment.right === 0 && alignment.center === 0) issues.push('all text is left-aligned although the document locale is right-to-left');

  return {
    scope: 'vector-geometry-only',
    applicable: true,
    ok: issues.length === 0,
    thresholds: t,
    canvas,
    objects: items.length,
    contentObjects: content.length,
    bbox: union ? { x: Math.round(union.x), y: Math.round(union.y), w: Math.round(union.w), h: Math.round(union.h), coverage } : null,
    margins,
    rtl,
    overlap: { textPairs: textPairs.length, maxRatio: Number(maxOverlap.toFixed(3)), pairs: textPairs.slice(0, 10) },
    clipping: { count: clipped.length, ids: clipped.slice(0, 20).map((i) => i.id) },
    whitespace: { largestEmptyBandPx: Math.round(band.size), fromY: Math.round(band.from), toY: Math.round(band.to) },
    issues,
    visualReview: 'not-reviewed',
  };
}

module.exports = { analyzeLayout, THRESHOLDS };
