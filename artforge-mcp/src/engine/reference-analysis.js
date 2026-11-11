'use strict';

/**
 * Visual reference analysis (stage ⑤): turns the selected references into rules the art director can use.
 *
 *   palette       → harmony type (hue distribution in OKLCh), value key and range, temperature, chroma level,
 *                   60/30/10 role order.
 *   styleguide    → tone, aspect and edge density → detail level and margin suggestion.
 *   user image    → focal cell (busiest), calm cell (for text/negative space), horizon estimate, light side, balance
 *                   (from the drawing tool's image.analyze grid).
 * Every rule names its source and whether it is a measurement or an estimate.
 */

const { hexToOklab, lch } = require('./swatches');

function hueGap(a, b) { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; }

function analyzePalette(colors, sourceId) {
  const hexes = (colors || []).map((c) => (typeof c === 'string' ? c : c && c.hex)).filter((h) => /^#[0-9a-f]{6}$/i.test(String(h)));
  if (!hexes.length) return null;
  const items = hexes.map((hex) => { const lab = hexToOklab(hex); const p = lch(lab); return { hex, L: p.L, C: p.C, h: p.h }; });
  const chromatic = items.filter((i) => i.C >= 0.04);
  const hues = chromatic.map((i) => i.h);
  let harmony = 'neutral';
  if (hues.length === 1) harmony = 'monochrome';
  else if (hues.length > 1) {
    let maxGap = 0;
    for (let i = 0; i < hues.length; i += 1) for (let k = i + 1; k < hues.length; k += 1) maxGap = Math.max(maxGap, hueGap(hues[i], hues[k]));
    // Cluster hues 30° apart; the number and spacing of clusters names the scheme.
    const sorted = hues.slice().sort((a, b) => a - b);
    const clusters = [];
    for (const h of sorted) { const c = clusters.find((x) => hueGap(x.h, h) <= 30); if (c) { c.n += 1; } else clusters.push({ h, n: 1 }); }
    if (maxGap <= 25) harmony = 'monochrome';
    else if (maxGap <= 70) harmony = 'analogous';
    else if (clusters.length === 2 && maxGap >= 150) harmony = 'complementary';
    else if (clusters.length === 3) {
      const gaps = [hueGap(clusters[0].h, clusters[1].h), hueGap(clusters[1].h, clusters[2].h), hueGap(clusters[0].h, clusters[2].h)].sort((a, b) => a - b);
      harmony = gaps[0] >= 90 ? 'triadic' : (gaps[2] >= 150 ? 'split-complementary' : 'varied');
    } else harmony = 'varied';
  }
  const Ls = items.map((i) => i.L);
  const meanL = Ls.reduce((s, v) => s + v, 0) / Ls.length;
  const range = Math.max(...Ls) - Math.min(...Ls);
  const meanC = items.reduce((s, i) => s + i.C, 0) / items.length;
  // Warm hues ≈ 0–100° (reds, oranges, yellows) in OKLCh; cool ≈ 150–300°.
  const warm = chromatic.filter((i) => i.h < 100 || i.h > 330).length;
  const cool = chromatic.filter((i) => i.h >= 150 && i.h <= 300).length;
  const byC = items.slice().sort((a, b) => b.C - a.C);
  const byL = items.slice().sort((a, b) => a.L - b.L);
  return {
    sourceId,
    measured: true,
    swatches: hexes.length,
    harmony,
    valueKey: meanL > 0.72 ? 'high' : (meanL < 0.42 ? 'low' : 'mid'),
    valueRange: Number(range.toFixed(3)),
    temperature: warm > cool ? 'warm' : (cool > warm ? 'cool' : 'neutral'),
    chroma: meanC < 0.05 ? 'muted' : (meanC > 0.13 ? 'vivid' : 'moderate'),
    roles: {
      dominant: byL[byL.length - 1 - Math.floor(byL.length / 3)] ? byL[byL.length - 1 - Math.floor(byL.length / 3)].hex : hexes[0],
      secondary: byL[Math.floor(byL.length / 3)].hex,
      accent: byC[0].hex,
      ratio: '60/30/10',
    },
  };
}

function analyzeDesignSystem(ds) {
  if (!ds) return null;
  const density = Number(ds.edgeDensity);
  return {
    sourceId: ds.id,
    measured: true,
    tone: ds.tone || null,
    aspect: ds.aspect || null,
    detail: Number.isFinite(density) ? (density > 0.16 ? 'high' : (density < 0.07 ? 'low' : 'medium')) : null,
    marginRatio: Number.isFinite(density) ? Number((density > 0.16 ? 0.05 : (density < 0.07 ? 0.09 : 0.07)).toFixed(2)) : null,
  };
}

/** image.analyze → composition rules. The 3×3 grid is coarse, so placement rules are estimates. */
function analyzeImage(a, sourceId) {
  if (!a || !Array.isArray(a.grid) || a.grid.length !== 9) return null;
  const row = (r) => a.grid.filter((c) => c.row === r);
  const col = (k) => a.grid.filter((c) => c.col === k);
  const mean = (cells, key) => cells.reduce((s, c) => s + c[key], 0) / cells.length;
  const rows = [0, 1, 2].map((r) => mean(row(r), 'brightness'));
  const jumps = [Math.abs(rows[0] - rows[1]), Math.abs(rows[1] - rows[2])];
  const horizon = jumps[0] >= jumps[1] ? 0.33 : 0.67;
  const cols = [0, 1, 2].map((k) => mean(col(k), 'brightness'));
  const lightSide = Math.abs(cols[0] - cols[2]) < 0.04 ? (rows[0] > rows[2] + 0.04 ? 'top' : 'front') : (cols[0] > cols[2] ? 'left' : 'right');
  const cellPoint = (c) => ({ x: Number(((c.col + 0.5) / 3).toFixed(3)), y: Number(((c.row + 0.5) / 3).toFixed(3)) });
  return {
    sourceId,
    measured: true,
    tone: a.tone,
    meanBrightness: a.meanBrightness,
    focal: Object.assign({ estimate: true }, cellPoint(a.busiestCell)),
    calmArea: Object.assign({ estimate: true }, cellPoint(a.calmestCell)),
    horizon: { ratio: horizon, estimate: true, confidence: Number(Math.max(...jumps).toFixed(3)) },
    lightFrom: { side: lightSide, estimate: true },
    balance: a.balance,
    colors: (a.colors || []).map((c) => c.hex || c).slice(0, 8),
  };
}

function analyzeReferences(context) {
  const ctx = context || {};
  const palettes = (ctx.paletteEntries || []).map((e) => analyzePalette((e.derivedLayer && e.derivedLayer.colors) || e.palette.colors, e.palette.id)).filter(Boolean);
  const image = analyzeImage(ctx.referenceAnalysis, ctx.referenceImage ? 'user-image' : 'reference-analysis');
  const imagePalette = image && image.colors.length >= 2 ? analyzePalette(image.colors, 'user-image') : null;
  const primary = imagePalette || palettes[0] || null;
  const rules = [];
  if (primary) {
    rules.push({ id: 'palette-harmony', source: primary.sourceId, value: primary.harmony, decision: `Keep the ${primary.harmony} scheme of the reference; add no hue outside it.`, rule: primary.harmony === 'monochrome' ? 'harmony-monochrome' : 'limited-palette' });
    rules.push({ id: 'value-key', source: primary.sourceId, value: primary.valueKey, decision: `Overall value key ${primary.valueKey} (range ${primary.valueRange}).`, rule: 'chroma-and-value' });
    rules.push({ id: 'temperature', source: primary.sourceId, value: primary.temperature, decision: `Reference temperature is ${primary.temperature}.`, rule: 'color-temperature' });
  }
  const ds = analyzeDesignSystem(ctx.designSystem);
  if (ds && ds.detail) rules.push({ id: 'detail-level', source: ds.sourceId, value: ds.detail, decision: `Styleguide edge density suggests ${ds.detail} detail and a ${ds.marginRatio} margin.` });
  if (image) {
    rules.push({ id: 'focal-from-image', source: image.sourceId, value: image.focal, decision: 'Place the focal subject near the busiest region of the reference.', estimate: true });
    rules.push({ id: 'calm-from-image', source: image.sourceId, value: image.calmArea, decision: 'Keep the calmest region of the reference as negative space or for text.', estimate: true });
    rules.push({ id: 'horizon-from-image', source: image.sourceId, value: image.horizon.ratio, decision: `Horizon near ${image.horizon.ratio} of the height (largest brightness change between grid rows).`, estimate: true });
    if (image.lightFrom.side !== 'front') rules.push({ id: 'light-from-image', source: image.sourceId, value: image.lightFrom.side, decision: `Key light from the ${image.lightFrom.side} (brighter side of the reference).`, estimate: true });
  }
  return { palettes, primary, designSystem: ds, image, rules };
}

module.exports = { analyzeReferences, analyzePalette, analyzeImage, analyzeDesignSystem };
