'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createCanvas, GlobalFonts } = require('@napi-rs/canvas');

const BUNDLED_FONTS = [
  { file: 'Amiri-Regular.ttf', family: 'Amiri', weight: 400, style: 'normal', license: 'OFL-1.1' },
  { file: 'Amiri-Bold.ttf', family: 'Amiri', weight: 700, style: 'normal', license: 'OFL-1.1' },
  { file: 'Tajawal-Regular.ttf', family: 'Tajawal', weight: 400, style: 'normal', license: 'OFL-1.1' },
  { file: 'Tajawal-Bold.ttf', family: 'Tajawal', weight: 700, style: 'normal', license: 'OFL-1.1' },
  { file: 'Almarai-Regular.ttf', family: 'Almarai', weight: 400, style: 'normal', license: 'OFL-1.1' },
  { file: 'Almarai-Bold.ttf', family: 'Almarai', weight: 700, style: 'normal', license: 'OFL-1.1' },
];

const probeCanvas = createCanvas(96, 96);
const probeCtx = probeCanvas.getContext('2d');
const coverageCache = new Map();
const ARABIC_REFERENCE_FAMILY = 'Amiri';
let bundledRegistered = false;
let bundledRecords = [];

function signature(fontSpec, text) {
  probeCtx.clearRect(0, 0, 96, 96);
  probeCtx.font = fontSpec;
  probeCtx.textBaseline = 'top';
  probeCtx.fillStyle = '#000000';
  probeCtx.fillText(text, 8, 8);
  const data = probeCtx.getImageData(0, 0, 96, 96).data;
  let pixels = 0;
  let checksum = 0;
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] > 0) {
      pixels += 1;
      checksum = (checksum * 31 + i) % 2147483647;
    }
  }
  return `${pixels}:${checksum}`;
}

/**
 * Real coverage probe.
 *
 * A font only "supports Arabic" when the family itself supplies the glyphs rather
 * than the shaping engine silently falling back to another font. The probe renders
 * the letter م twice: once with the family alone and once with the family plus a
 * known Arabic fallback (the bundled Amiri face). Identical output means the family
 * rendered the letter itself; a different output means the fallback did the work.
 */
function hasArabicGlyphs(family) {
  if (!family) return false;
  if (coverageCache.has(family)) return coverageCache.get(family);
  const safeFamily = String(family).replace(/"/g, '');
  const alone = signature(`28px "${safeFamily}"`, 'م');
  const withFallback = signature(`28px "${safeFamily}", "${ARABIC_REFERENCE_FAMILY}"`, 'م');
  const result = alone === withFallback;
  coverageCache.set(family, result);
  return result;
}

function registerBundledFonts(fontsDir) {
  if (bundledRegistered) return bundledRecords;
  const records = [];
  for (const font of BUNDLED_FONTS) {
    const filePath = path.join(fontsDir, font.file);
    if (!fs.existsSync(filePath)) continue;
    const ok = GlobalFonts.registerFromPath(filePath, font.family);
    records.push(Object.assign({}, font, { path: filePath, registered: Boolean(ok) }));
  }
  bundledRegistered = true;
  bundledRecords = records;
  require('./text').setWeightResolver((family, weight) => nearestWeight(family, weight));
  return records;
}

/** CSS font-matching for a bundled family: the installed weight a browser would pick for `weight`. */
function nearestWeight(family, weight) {
  const have = [...new Set(bundledRecords.filter((r) => r.registered && r.family === family).map((r) => r.weight))].sort((a, b) => a - b);
  if (!have.length || have.includes(weight)) return weight;
  const below = have.filter((w) => w < weight).reverse();
  const above = have.filter((w) => w > weight);
  if (weight === 400 && have.includes(500)) return 500;
  if (weight === 500 && have.includes(400)) return 400;
  if (weight <= 500) return (below.concat(above))[0];
  return (above.concat(below))[0];
}

function systemFamilies() {
  return GlobalFonts.families.map((entry) => entry.family).filter(Boolean).sort((a, b) => a.localeCompare(b));
}

/**
 * Complete font inventory: bundled (redistributable) + installed system families,
 * each with a verified Arabic-coverage flag.
 */
function listFonts(fontsDir) {
  const records = registerBundledFonts(fontsDir);
  const bundledFamilies = new Set(records.map((r) => r.family));
  const bundled = records.map((font) => ({
    family: font.family,
    source: 'bundled',
    file: `/fonts/${font.file}`,
    weight: font.weight,
    style: font.style,
    license: font.license,
    arabic: hasArabicGlyphs(font.family),
  }));
  const system = systemFamilies()
    .filter((family) => !bundledFamilies.has(family))
    .map((family) => ({ family, source: 'system', arabic: hasArabicGlyphs(family) }));
  return bundled.concat(system);
}

function resolveFamily(requested, fontsDir) {
  if (!requested) return null;
  const all = listFonts(fontsDir).map((f) => f.family);
  const lower = String(requested).toLowerCase();
  const exact = all.find((family) => family.toLowerCase() === lower);
  return exact || null;
}

function describeFonts(fontsDir) {
  const fonts = listFonts(fontsDir);
  const uniqueFamilies = new Set(fonts.map((font) => font.family));
  const arabicFamilies = new Set(fonts.filter((font) => font.arabic).map((font) => font.family));
  return {
    total: fonts.length,
    uniqueFamilies: uniqueFamilies.size,
    arabicCapable: fonts.filter((font) => font.arabic).length,
    arabicFamilies: arabicFamilies.size,
    bundled: fonts.filter((font) => font.source === 'bundled'),
    bundledArabic: Array.from(new Set(fonts.filter((font) => font.source === 'bundled' && font.arabic).map((font) => font.family))),
    systemArabic: Array.from(new Set(fonts.filter((font) => font.source === 'system' && font.arabic).map((font) => font.family))),
  };
}

module.exports = {
  BUNDLED_FONTS,
  registerBundledFonts,
  listFonts,
  systemFamilies,
  hasArabicGlyphs,
  resolveFamily,
  describeFonts,
};
