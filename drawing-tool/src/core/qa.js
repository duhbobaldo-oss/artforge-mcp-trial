'use strict';

/**
 * Measurable quality checks on the RENDERED pixels (not on the plan): text clipping, overflowing words,
 * estimated text contrast, accidental text overlaps, and ruled-paper baseline alignment.
 * It cannot judge artistic quality; that still needs a visual review.
 */

const { createCanvas } = require('@napi-rs/canvas');
const { renderToCanvas } = require('./exporter');
const { bboxOf } = require('./renderer');
const { layoutText } = require('./text');
const { hexToRgb } = require('./paint');
const { toOklab } = require('./effects');
const layerTree = require('./layer-tree');

function luminance(r, g, b) {
  const lin = (c) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function contrastRatio(a, b) {
  const hi = Math.max(a, b);
  const lo = Math.min(a, b);
  return (hi + 0.05) / (lo + 0.05);
}

function intersectArea(a, b) {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

function groupOf(name) {
  return String(name || '').split(':').slice(0, 2).join(':');
}

function qaCheck(doc, images, options) {
  const opts = options || {};
  const issues = [];
  const W = Math.round(doc.canvas.width);
  const H = Math.round(doc.canvas.height);
  // Background = the same design rendered once with every text object hidden, so the contrast estimate
  // measures what is really behind the letters (works even when text and background are close in colour).
  const noText = Object.assign({}, doc, { layers: doc.layers.map((l) => Object.assign({}, l, { objects: (l.objects || []).filter((o) => o.type !== 'text') })) });
  // Without any text the background IS the design: reuse the full render the export just made.
  const hasText = doc.layers.some((l) => (l.objects || []).some((o) => o.type === 'text'));
  const bgRender = hasText ? renderToCanvas(noText, { images, applyAnimation: false }) : renderToCanvas(doc, { images, applyAnimation: false, cache: true });
  const pixels = bgRender.ctx.getImageData(0, 0, W, H).data;
  const measure = createCanvas(8, 8).getContext('2d');
  const texts = [];
  for (const layer of doc.layers) {
    if (!layerTree.effectiveVisible(doc.layers, layer)) continue;
    for (const obj of layer.objects) {
      if (obj.type !== 'text' || !String(obj.text || '').trim()) continue;
      const box = bboxOf(obj, measure);
      const layout = layoutText(measure, obj);
      texts.push({ obj, box, layerId: layer.id });
      const label = obj.name || obj.id;
      if (box.x < -1 || box.y < -1 || box.x + box.w > W + 1 || box.y + box.h > H + 1) {
        issues.push({ code: 'TEXT_OUTSIDE_CANVAS', object: label, box: roundBox(box), message: 'text extends beyond the canvas and will be clipped' });
      }
      if (layout.overflowWords.length) {
        issues.push({ code: 'TEXT_WORD_OVERFLOW', object: label, words: layout.overflowWords.slice(0, 3), message: 'a word is wider than its text box' });
      }
      const fill = typeof obj.fill === 'string' ? hexToRgb(obj.fill) : null;
      if (fill && obj.opacity !== 0) {
        const textL = luminance(fill.r, fill.g, fill.b);
        const samples = [];
        const x0 = Math.max(0, Math.floor(box.x));
        const y0 = Math.max(0, Math.floor(box.y));
        const x1 = Math.min(W - 1, Math.ceil(box.x + box.w));
        const y1 = Math.min(H - 1, Math.ceil(box.y + box.h));
        const step = Math.max(1, Math.floor(Math.sqrt(((x1 - x0) * (y1 - y0)) / 600)));
        for (let y = y0; y <= y1; y += step) {
          for (let x = x0; x <= x1; x += step) {
            const i = (y * W + x) * 4;
            samples.push(luminance(pixels[i], pixels[i + 1], pixels[i + 2]));
          }
        }
        if (samples.length >= 8) {
          samples.sort((a, b) => a - b);
          const bg = samples[Math.floor(samples.length / 2)];
          const ratio = contrastRatio(textL, bg);
          const large = Number((obj.font || {}).size || 0) >= 24 || (Number((obj.font || {}).size || 0) >= 18.5 && Number((obj.font || {}).weight || 400) >= 700);
          const min = large ? 3 : 4.5;
          if (ratio < min) {
            issues.push({ code: 'LOW_CONTRAST', object: label, ratio: Number(ratio.toFixed(2)), required: min, message: 'estimated text/background contrast is below WCAG' });
          }
        }
      }
    }
  }
  for (let i = 0; i < texts.length; i += 1) {
    for (let j = i + 1; j < texts.length; j += 1) {
      const a = texts[i];
      const b = texts[j];
      if (groupOf(a.obj.name) && groupOf(a.obj.name) === groupOf(b.obj.name) && /:m\d|:l\d/.test(`${a.obj.name}${b.obj.name}`)) continue;
      const area = intersectArea(a.box, b.box);
      const smaller = Math.min(a.box.w * a.box.h, b.box.w * b.box.h) || 1;
      if (area / smaller > 0.2) {
        issues.push({ code: 'TEXT_OVERLAP', objects: [a.obj.name || a.obj.id, b.obj.name || b.obj.id], overlap: Number((area / smaller).toFixed(2)), message: 'two text boxes overlap' });
      }
    }
  }
  const result = { ok: issues.length === 0, canvas: { width: W, height: H }, textObjects: texts.length, issues };
  if (Array.isArray(opts.palette) && opts.palette.length) result.palette = paletteAdherence(pixels, W, H, opts.palette);
  if (opts.ruled && opts.ruled.layerId && Array.isArray(opts.ruled.rules)) result.ruled = ruledCheck(doc, images, opts.ruled);
  if (result.ruled && !result.ruled.ok) {
    result.ok = false;
    result.issues.push({ code: 'RULED_MISALIGNED', message: result.ruled.summary });
  }
  return result;
}

/**
 * How faithfully the rendered pixels use the reference palette (text excluded, effects included).
 *   exact   share of pixels within ΔE 0.08 (OKLab) of a palette swatch
 *   family  share of pixels that are a swatch, a tint/shade of one, or a blend of two (distance ≤ 0.06 from the
 *           OKLab segment between any two of: swatches, white, black) — what a limited palette may produce
 *   swatchesSeen  swatches that cover at least 1% of the picture
 */
function paletteAdherence(pixels, W, H, palette) {
  const sw = palette.map((hex) => { const c = hexToRgb(hex); return Object.assign({ hex }, toOklab(c)); });
  const anchors = sw.concat([Object.assign({ hex: '#ffffff' }, toOklab({ r: 255, g: 255, b: 255 })), Object.assign({ hex: '#000000' }, toOklab({ r: 0, g: 0, b: 0 }))]);
  const segs = [];
  for (let i = 0; i < anchors.length; i += 1) for (let j = i + 1; j < anchors.length; j += 1) segs.push([anchors[i], anchors[j]]);
  const dist = (p, q) => Math.hypot(p.L - q.L, p.A - q.A, p.B - q.B);
  const segDist = (p, a, b) => {
    const vx = b.L - a.L; const vy = b.A - a.A; const vz = b.B - a.B;
    const len2 = vx * vx + vy * vy + vz * vz || 1e-9;
    const t = Math.max(0, Math.min(1, ((p.L - a.L) * vx + (p.A - a.A) * vy + (p.B - a.B) * vz) / len2));
    return Math.hypot(p.L - (a.L + vx * t), p.A - (a.A + vy * t), p.B - (a.B + vz * t));
  };
  const step = Math.max(1, Math.round(Math.sqrt((W * H) / 40000)));
  let n = 0; let exact = 0; let family = 0;
  const seen = new Array(sw.length).fill(0);
  const cache = new Map();
  for (let y = 0; y < H; y += step) {
    for (let x = 0; x < W; x += step) {
      const i = (y * W + x) * 4;
      if (pixels[i + 3] < 128) continue;
      const key = ((pixels[i] >> 2) << 12) | ((pixels[i + 1] >> 2) << 6) | (pixels[i + 2] >> 2);
      let hit = cache.get(key);
      if (!hit) {
        const p = toOklab({ r: pixels[i], g: pixels[i + 1], b: pixels[i + 2] });
        let best = Infinity; let bi = 0;
        sw.forEach((c, k) => { const d = dist(p, c); if (d < best) { best = d; bi = k; } });
        let fam = best < 0.06;
        for (let s = 0; !fam && s < segs.length; s += 1) if (segDist(p, segs[s][0], segs[s][1]) <= 0.06) fam = true;
        hit = { exact: best < 0.08, fam, bi };
        cache.set(key, hit);
      }
      n += 1;
      if (hit.exact) { exact += 1; seen[hit.bi] += 1; }
      if (hit.fam) family += 1;
    }
  }
  return {
    exact: Number((exact / Math.max(1, n)).toFixed(3)),
    family: Number((family / Math.max(1, n)).toFixed(3)),
    swatchesSeen: sw.filter((c, k) => seen[k] / Math.max(1, n) >= 0.01).map((c) => c.hex),
    swatches: sw.length,
  };
}

function roundBox(b) {
  return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.w), h: Math.round(b.h) };
}

/**
 * Pixel measurement of writing on ruled paper: renders ONLY the text layer, then for each rule finds the
 * densest ink row above it (the Arabic baseline stroke), the gap to the rule, ink touching the rule and ink
 * intruding above the previous rule.
 */
function ruledCheck(doc, images, ruled) {
  const only = Object.assign({}, doc, {
    canvas: Object.assign({}, doc.canvas, { background: { type: 'none' } }),
    // Show only the ruled layer; its enclosing groups stay visible so it is not hidden with them.
    layers: (() => {
      const ruledLayer = doc.layers.find((l) => l.id === ruled.layerId);
      const keep = new Set([ruled.layerId, ...(ruledLayer ? layerTree.ancestors(doc.layers, ruledLayer).map((g) => g.id) : [])]);
      return doc.layers.map((l) => Object.assign({}, l, { visible: keep.has(l.id) }));
    })(),
  });
  const { canvas, ctx } = renderToCanvas(only, { images, applyAnimation: false });
  const W = canvas.width;
  const H = canvas.height;
  const data = ctx.getImageData(0, 0, W, H).data;
  const rows = new Float64Array(H);
  for (let y = 0; y < H; y += 1) {
    let n = 0;
    for (let x = 0; x < W; x += 1) if (data[(y * W + x) * 4 + 3] > 140) n += 1;
    rows[y] = n;
  }
  // Optional font size per rule: the densest ink row of a bold heading sits differently from body text,
  // so consistency is judged within each text size (same style must sit identically on every rule).
  const sizeOf = new Map();
  ruled.rules.forEach((r, i) => { if (Array.isArray(ruled.sizes)) sizeOf.set(Math.round(Number(r)), Number(ruled.sizes[i])); });
  const rules = ruled.rules.map(Number).sort((a, b) => a - b);
  const pitch = Number(ruled.pitch) || (rules.length > 1 ? rules[1] - rules[0] : 40);
  const lines = [];
  for (let k = 0; k < rules.length; k += 1) {
    const rule = Math.round(rules[k]);
    const top = Math.max(0, Math.round(rule - pitch * 0.75));
    let ink = 0;
    for (let y = top; y <= Math.min(H - 1, rule); y += 1) ink += rows[y];
    if (ink < 20) continue;
    let best = top;
    for (let y = top; y <= Math.min(H - 1, rule); y += 1) if (rows[y] > rows[best]) best = y;
    const touching = (rows[rule] || 0) + (rows[rule - 1] || 0) + (rows[rule + 1] || 0);
    const peak = rows[best] || 1;
    const prev = k > 0 ? Math.round(rules[k - 1]) : null;
    let intrusion = 0;
    if (prev !== null) for (let y = Math.max(0, prev - 1); y <= prev + 1; y += 1) intrusion += rows[y];
    lines.push({ rule, size: sizeOf.get(rule) || null, baselineRow: best, gap: rule - best, touchRatio: Number((touching / (3 * peak)).toFixed(3)), intoPreviousRule: intrusion });
  }
  const gaps = lines.map((l) => l.gap);
  const gapMin = gaps.length ? Math.min(...gaps) : null;
  const gapMax = gaps.length ? Math.max(...gaps) : null;
  const maxTouch = lines.length ? Math.max(...lines.map((l) => l.touchRatio)) : 0;
  const tolerance = Number(ruled.tolerancePx || 3);
  const minGap = Number(ruled.minGapPx === undefined ? 1 : ruled.minGapPx);
  const groups = {};
  for (const l of lines) (groups[l.size || 'all'] = groups[l.size || 'all'] || []).push(l.gap);
  const spreadBySize = Object.fromEntries(Object.entries(groups).map(([k, g]) => [k, { lines: g.length, gapMin: Math.min(...g), gapMax: Math.max(...g), spread: Math.max(...g) - Math.min(...g) }]));
  const worstSpread = Math.max(0, ...Object.values(spreadBySize).map((g) => g.spread));
  const ok = lines.length === 0 ? true : gapMin >= minGap && worstSpread <= tolerance && maxTouch <= Number(ruled.maxTouchRatio || 0.35);
  return {
    ok,
    linesMeasured: lines.length,
    gapMinPx: gapMin,
    gapMaxPx: gapMax,
    gapSpreadPx: gaps.length ? gapMax - gapMin : null,
    maxTouchRatio: maxTouch,
    spreadBySize,
    worstSpreadPx: worstSpread,
    summary: lines.length === 0 ? 'no written lines on this page (e.g. table only)' : `${lines.length} written lines measured; baseline-to-rule gap ${gapMin}..${gapMax}px, worst spread within one text size ${worstSpread}px (tolerance ${tolerance}px); max ink touching rule ratio ${maxTouch}`,
    lines,
  };
}

/** Composition analysis of a reference image: 3x3 brightness/detail grid + calm region for text. */
async function analyzeImage(image) {
  const w = 96;
  const h = Math.max(1, Math.round((image.height / image.width) * w));
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(image, 0, 0, w, h);
  const d = ctx.getImageData(0, 0, w, h).data;
  const lum = new Float64Array(w * h);
  for (let i = 0; i < w * h; i += 1) lum[i] = 0.2126 * d[i * 4] + 0.7152 * d[i * 4 + 1] + 0.0722 * d[i * 4 + 2];
  const grid = [];
  for (let gy = 0; gy < 3; gy += 1) {
    for (let gx = 0; gx < 3; gx += 1) {
      let sum = 0; let edge = 0; let n = 0;
      for (let y = Math.floor((gy * h) / 3); y < Math.floor(((gy + 1) * h) / 3); y += 1) {
        for (let x = Math.floor((gx * w) / 3); x < Math.floor(((gx + 1) * w) / 3); x += 1) {
          const v = lum[y * w + x];
          sum += v;
          if (x + 1 < w) edge += Math.abs(v - lum[y * w + x + 1]);
          if (y + 1 < h) edge += Math.abs(v - lum[(y + 1) * w + x]);
          n += 1;
        }
      }
      grid.push({ row: gy, col: gx, brightness: Number((sum / n / 255).toFixed(3)), detail: Number((edge / n / 255).toFixed(4)) });
    }
  }
  const calm = grid.slice().sort((a, b) => a.detail - b.detail)[0];
  const busy = grid.slice().sort((a, b) => b.detail - a.detail)[0];
  const mean = grid.reduce((s, c) => s + c.brightness, 0) / grid.length;
  const leftMass = grid.filter((c) => c.col === 0).reduce((s, c) => s + c.detail, 0);
  const rightMass = grid.filter((c) => c.col === 2).reduce((s, c) => s + c.detail, 0);
  return {
    width: image.width,
    height: image.height,
    aspect: Number((image.width / image.height).toFixed(3)),
    meanBrightness: Number(mean.toFixed(3)),
    tone: mean < 0.4 ? 'dark' : (mean > 0.62 ? 'light' : 'mid'),
    grid,
    calmestCell: calm,
    busiestCell: busy,
    balance: Math.abs(leftMass - rightMass) < 0.01 ? 'balanced' : (leftMass > rightMass ? 'detail-left' : 'detail-right'),
  };
}

/**
 * Pixel visibility of object groups: the design is rendered once as is and once per group with that group
 * removed; the share of pixels inside the group's box that visibly change is how much of it the viewer sees.
 * Catches what geometry cannot: an element hidden under later layers or drawn in the colour of its background.
 */
function visibility(doc, images, groups, options) {
  const opts = options || {};
  const W = doc.canvas.width; const H = doc.canvas.height;
  const scale = Math.max(0.1, Math.min(1, Number(opts.scale) || Math.min(1, 480 / Math.max(W, H))));
  const threshold = Number(opts.threshold) || 18;
  const full = renderToCanvas(doc, { images, applyAnimation: false, scale });
  const fw = full.canvas.width; const fh = full.canvas.height;
  const base = full.ctx.getImageData(0, 0, fw, fh).data;
  const measure = createCanvas(8, 8).getContext('2d');
  const out = [];
  for (const group of (groups || []).slice(0, 40)) {
    const ids = new Set((group.objectIds || []).map(String));
    const boxes = [];
    const without = Object.assign({}, doc, { layers: doc.layers.map((l) => Object.assign({}, l, { objects: (l.objects || []).filter((o) => { if (ids.has(o.id)) { boxes.push(bboxOf(o, measure)); return false; } return true; }) })) });
    if (!boxes.length) { out.push({ id: group.id, found: 0, changedRatio: 0, changedPixels: 0 }); continue; }
    const box = group.box || { x: Math.min(...boxes.map((b) => b.x)), y: Math.min(...boxes.map((b) => b.y)), w: Math.max(...boxes.map((b) => b.x + b.w)) - Math.min(...boxes.map((b) => b.x)), h: Math.max(...boxes.map((b) => b.y + b.h)) - Math.min(...boxes.map((b) => b.y)) };
    const x0 = Math.max(0, Math.floor(box.x * scale)); const y0 = Math.max(0, Math.floor(box.y * scale));
    const x1 = Math.min(fw, Math.ceil((box.x + box.w) * scale)); const y1 = Math.min(fh, Math.ceil((box.y + box.h) * scale));
    const px = renderToCanvas(without, { images, applyAnimation: false, scale }).ctx.getImageData(0, 0, fw, fh).data;
    let changed = 0; let total = 0; let sum = 0; let changedSum = 0; let lumSum = 0;
    const lum = (d, i) => 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
    for (let y = y0; y < y1; y += 1) {
      for (let x = x0; x < x1; x += 1) {
        const i = (y * fw + x) * 4;
        const d = Math.max(Math.abs(base[i] - px[i]), Math.abs(base[i + 1] - px[i + 1]), Math.abs(base[i + 2] - px[i + 2]));
        total += 1; sum += d;
        if (d > threshold) { changed += 1; changedSum += d; lumSum += lum(base, i) - lum(px, i); }
      }
    }
    out.push({ id: group.id, found: boxes.length, changedRatio: total ? Number((changed / total).toFixed(3)) : 0, changedPixels: changed, meanDelta: total ? Number((sum / total).toFixed(1)) : 0, changedMean: changed ? Number((changedSum / changed).toFixed(1)) : 0,
      // Signed tone of the element against what is behind it (positive = lighter): tells a repair which way to push.
      lumDelta: changed ? Number((lumSum / changed).toFixed(1)) : 0, box: roundBox(box) });
  }
  return { scale: Number(scale.toFixed(3)), threshold, groups: out };
}

module.exports = { qaCheck, ruledCheck, analyzeImage, paletteAdherence, contrastRatio, luminance, visibility };
