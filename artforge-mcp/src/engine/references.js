'use strict';

const fs = require('node:fs');

/**
 * Access layer over the generated reference index (palettes, styleguides, books,
 * instruction rules). It never copies reference content: it returns metadata,
 * extracted colours and file paths of the preserved originals.
 */

const COLOR_WORDS = [
  { hue: 210, words: ['أزرق', 'ازرق', 'blue', 'سماوي', 'sky', 'نيلي', 'indigo'] },
  { hue: 275, words: ['بنفسجي', 'violet', 'purple', 'أرجواني', 'ارجواني'] },
  { hue: 330, words: ['وردي', 'pink', 'زهري', 'magenta'] },
  { hue: 0, words: ['أحمر', 'احمر', 'red', 'قرمزي', 'crimson'] },
  { hue: 25, words: ['برتقالي', 'orange', 'نحاسي'] },
  { hue: 45, words: ['ذهبي', 'gold', 'أصفر', 'اصفر', 'yellow', 'شمسي'] },
  { hue: 130, words: ['أخضر', 'اخضر', 'green', 'زمردي', 'نعناعي'] },
  { hue: 175, words: ['فيروزي', 'teal', 'تركواز', 'cyan', 'مائي'] },
  { hue: 20, words: ['بني', 'brown', 'ترابي', 'خشبي'] },
];

/** Request vocabulary → palette mood tags (weights). */
const MOOD_WORDS = [
  { tags: { pastel: 3, soft: 1 }, words: ['باستيل', 'pastel', 'ناعم', 'رقيق', 'حالم', 'أطفال', 'اطفال', 'طفل', 'soft', 'dreamy', 'clay', 'صلصال', 'طين'] },
  { tags: { neon: 3, vivid: 1, dark: 1 }, words: ['نيون', 'neon', 'سايبر', 'cyber', 'مستقبلي', 'futur', 'gaming', 'ألعاب', 'synthwave'] },
  { tags: { luxury: 3, dark: 1 }, words: ['فاخر', 'فخم', 'luxury', 'premium', 'راقي', 'ملكي', 'royal', 'elegant', 'أنيق', 'انيق'] },
  { tags: { earthy: 3, warm: 1 }, words: ['ترابي', 'خشب', 'قهوة', 'coffee', 'earthy', 'rustic', 'ريفي', 'صحراء', 'desert', 'خريف', 'autumn', 'كثبان'] },
  { tags: { nature: 2, green: 1 }, words: ['غابة', 'forest', 'حديقة', 'garden', 'شجر', 'أشجار', 'tree', 'نبات', 'plant', 'عشب', 'grass', 'ربيع', 'spring', 'leaf'] },
  { tags: { ocean: 2, blue: 1, cool: 1 }, words: ['بحر', 'sea', 'ocean', 'شاطئ', 'beach', 'ساحل', 'coast', 'ماء', 'water', 'نهر', 'river', 'بحيرة', 'lake', 'شتاء', 'winter', 'ثلج'] },
  { tags: { sunset: 3, warm: 1 }, words: ['غروب', 'sunset', 'شروق', 'sunrise', 'مغيب', 'أصيل'] },
  { tags: { dark: 2 }, words: ['ليل', 'night', 'داكن', 'dark', 'مظلم', 'غامق'] },
  { tags: { light: 2 }, words: ['نهار', 'day', 'مشرق', 'bright', 'صباح', 'morning', 'فاتح'] },
  { tags: { vivid: 2 }, words: ['حيوي', 'زاهي', 'vivid', 'colorful', 'colourful', 'ملون', 'مبهج', 'فرح', 'بقع', 'splash', 'رشق', 'كرنفال'] },
  { tags: { muted: 2 }, words: ['هادئ', 'هادئة', 'مطفأ', 'muted', 'minimal', 'بسيط', 'بسيطة', 'رمادي', 'calm', 'سكينة'] },
  { tags: { warm: 2 }, words: ['دافئ', 'دافئة', 'warm', 'cozy', 'دفء', 'مريح'] },
  { tags: { cool: 2 }, words: ['بارد', 'cool', 'منعش', 'fresh', 'ثلجي'] },
  { tags: { monochrome: 3 }, words: ['أبيض وأسود', 'ابيض واسود', 'monochrome', 'أحادي', 'grayscale'] },
  { tags: { purple: 2 }, words: ['بنفسجي', 'purple', 'violet', 'ليلكي', 'lavender'] },
  { tags: { pink: 2 }, words: ['وردي', 'pink', 'زهري', 'rose'] },
];

/** Subject and lighting defaults, so a request without mood words still gets a fitting palette. */
const SUBJECT_TAGS = {
  landscape: { nature: 1, ocean: 0.8 },
  architecture: { ocean: 0.8, muted: 0.6, light: 0.4 },
  scene: { warm: 1, earthy: 0.8 },
  character: { nature: 0.6, light: 0.6, warm: 0.4 },
  abstract: { vivid: 0.6 },
};
// Time of day colours the whole picture, so it outweighs the subject defaults.
const LIGHTING_TAGS = { night: { dark: 3 }, sunset: { sunset: 4, warm: 2 }, morning: { light: 1.5, warm: 0.8 }, day: { light: 0.8 } };

function wantedTags(text, intent) {
  const out = {};
  const add = (tags) => { for (const [tag, w] of Object.entries(tags)) out[tag] = (out[tag] || 0) + w; };
  for (const entry of MOOD_WORDS) if (entry.words.some((w) => text.includes(w.toLowerCase()))) add(entry.tags);
  if (intent && SUBJECT_TAGS[intent.type]) add(SUBJECT_TAGS[intent.type]);
  if (intent && intent.lighting && LIGHTING_TAGS[intent.lighting]) add(LIGHTING_TAGS[intent.lighting]);
  return out;
}

/** Mood of a palette; recomputed from its colours for an older (v1) index without mood tags. */
function moodOf(palette) {
  if (palette.mood) return palette.mood;
  const { hexToOklab, lch, describePalette } = require('./swatches');
  const swatches = palette.colors.map((c) => { const l = lch(hexToOklab(c.hex)); return { hex: c.hex, share: c.share || 0.1, role: 'swatch', L: l.L, C: l.C, h: l.h }; });
  palette.mood = describePalette(swatches);
  return palette.mood;
}

function tieBreak(text, id) {
  let h = 2166136261;
  for (const ch of `${text}|${id}`) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
  return ((h >>> 0) % 1000) / 1000;
}

function hexToHsl(hex) {
  const value = String(hex).replace('#', '');
  const r = parseInt(value.slice(0, 2), 16) / 255;
  const g = parseInt(value.slice(2, 4), 16) / 255;
  const b = parseInt(value.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const lightness = (max + min) / 2;
  let hue = 0;
  let saturation = 0;
  const delta = max - min;
  if (delta !== 0) {
    saturation = delta / (1 - Math.abs(2 * lightness - 1));
    if (max === r) hue = 60 * (((g - b) / delta) % 6);
    else if (max === g) hue = 60 * ((b - r) / delta + 2);
    else hue = 60 * ((r - g) / delta + 4);
  }
  if (hue < 0) hue += 360;
  return { hue, saturation, lightness };
}

function hueDistance(a, b) {
  const diff = Math.abs(a - b) % 360;
  return diff > 180 ? 360 - diff : diff;
}

function summarisePalette(palette) {
  return {
    id: palette.id,
    file: palette.file,
    colors: palette.colors.map((color) => color.hex),
    tone: palette.tone,
    contrast: palette.contrast,
    aspect: palette.aspect,
  };
}

function summariseDesignSystem(entry) {
  return {
    id: entry.id,
    file: entry.file,
    tone: entry.tone,
    aspect: entry.aspect,
    contrast: entry.contrast,
    edgeDensity: entry.edgeDensity,
    colors: entry.colors.map((color) => color.hex),
  };
}

class ReferenceLibrary {
  constructor(indexPath) {
    this.indexPath = indexPath;
    this.index = null;
  }

  load() {
    if (this.index) return this.index;
    if (!fs.existsSync(this.indexPath)) {
      throw new Error(`reference index not found at ${this.indexPath}; run: node bin/artforge-mcp.js index`);
    }
    this.index = JSON.parse(fs.readFileSync(this.indexPath, 'utf8'));
    return this.index;
  }

  summary() {
    const index = this.load();
    return {
      generatedAt: index.generatedAt,
      counts: index.counts,
      rules: index.rules,
      archive: index.source.archive,
      books: index.books.map((book) => ({ id: book.id, file: book.file, bytes: book.bytes })),
    };
  }

  get(kind, id) {
    const index = this.load();
    const collections = {
      palette: index.palettes,
      'design-system': index.designSystems,
      book: index.books,
      instruction: index.instructions,
    };
    const collection = collections[kind];
    if (!collection) return null;
    return collection.find((entry) => entry.id === id) || null;
  }

  list(kind) {
    const index = this.load();
    if (kind === 'palette') return index.palettes.map(summarisePalette);
    if (kind === 'design-system') return index.designSystems.map(summariseDesignSystem);
    if (kind === 'book') return index.books;
    if (kind === 'instruction') {
      return index.instructions.map((entry) => ({ id: entry.id, title: entry.title, path: entry.path, rules: entry.rules }));
    }
    return {
      palettes: index.palettes.length,
      designSystems: index.designSystems.length,
      books: index.books.length,
      instructions: index.instructions.length,
    };
  }

  /**
   * Choose the reference palette(s) for a request BY MEANING, not by contrast:
   *   mood words in the request (Arabic/English) → wanted tags (pastel, neon, luxury, earthy, nature, ocean…),
   *   subject/lighting defaults (landscape → nature/ocean, night → dark, sunset → sunset…),
   *   colour words → hue match against the card's swatches.
   * Each palette carries mood tags read from its swatches (index v2). Combination sheets (many palettes on one
   * card) are penalised. Ties break by a hash of (prompt, id): stable for one prompt, varied across prompts.
   * Default: ONE palette (one coherent colour layer per design).
   */
  scorePalettes(prompt, options) {
    const index = this.load();
    const opts = options || {};
    const text = String(prompt || '').toLowerCase();
    let wantedHues = COLOR_WORDS
      .filter((entry) => entry.words.some((word) => text.includes(word.toLowerCase())))
      .map((entry) => entry.hue);
    if (opts.hue !== undefined) wantedHues = [Number(opts.hue)];
    const wanted = wantedTags(text, opts.intent);
    const scored = index.palettes.map((palette) => {
      let score = 0;
      const reasons = [];
      const mood = moodOf(palette);
      const matched = [];
      for (const [tag, weight] of Object.entries(wanted)) {
        if (mood.tags.includes(tag)) { score += weight; matched.push(tag); }
      }
      if (matched.length) reasons.push(`mood match: ${matched.join(', ')}`);
      if (wantedHues.length) {
        const best = Math.min(...palette.colors.filter((c) => c.role !== 'background').map((color) => {
          const { hue, saturation } = hexToHsl(color.hex);
          return saturation < 0.15 ? 180 : Math.min(...wantedHues.map((w) => hueDistance(hue, w)));
        }));
        if (best < 40) {
          score += (40 - best) / 8;
          reasons.push(`hue match (delta ${best.toFixed(0)} deg)`);
        }
      }
      if (palette.collection) { score -= 3; reasons.push('combination sheet (several palettes): penalised'); }
      if (palette.swatchSource === 'histogram') score -= 1;
      score += Math.min(1, palette.contrast * 1.5) * 0.3;
      score += tieBreak(text, palette.id) * 0.6;
      return { palette, score: Number(score.toFixed(4)), reasons, mood: mood.tags };
    }).sort((a, b) => b.score - a.score || a.palette.id.localeCompare(b.palette.id));

    const limit = Math.max(1, Math.min(3, opts.limit || 1));
    return scored.slice(0, limit);
  }

  /**
   * The colour layer actually used: the chosen card's swatches, or — when the request asks for a mood the card
   * does not have (pastel / dark / muted / vivid) — a layer DERIVED from that card in OKLab (same hues, moved
   * lightness/chroma). Returns { colors[], derived: mode|null, from: paletteId }.
   */
  colorLayer(entry, prompt, intent) {
    const palette = entry.palette;
    const hexes = palette.colors.map((c) => c.hex);
    const wanted = wantedTags(String(prompt || '').toLowerCase(), intent);
    const tags = moodOf(palette).tags;
    const { deriveLayer } = require('./swatches');
    for (const mode of ['pastel', 'dark', 'muted', 'vivid']) {
      if ((wanted[mode] || 0) >= 2 && !tags.includes(mode)) return { colors: deriveLayer(hexes, mode), derived: mode, from: palette.id };
    }
    return { colors: hexes, derived: null, from: palette.id };
  }

  /** Pick exactly one styleguide: tone match plus aspect-ratio proximity. */
  scoreDesignSystems(prompt, canvas) {
    const index = this.load();
    const text = String(prompt || '').toLowerCase();
    const wantsDark = /داكن|غامق|dark|ليلي|night/.test(text);
    const wantsLight = /فاتح|مشرق|light|نهاري|bright/.test(text);
    const targetAspect = canvas ? canvas.width / canvas.height : 1;
    return index.designSystems.map((entry) => {
      let score = 0;
      const reasons = [];
      if (wantsDark && entry.tone === 'dark') { score += 2; reasons.push('dark tone'); }
      if (wantsLight && entry.tone === 'light') { score += 2; reasons.push('light tone'); }
      const aspectDelta = Math.abs(Math.log(entry.aspect / targetAspect));
      score += Math.max(0, 1.5 - aspectDelta);
      if (aspectDelta < 0.2) reasons.push('aspect close to canvas');
      score += entry.edgeDensity * 2;
      return { designSystem: entry, score: Number(score.toFixed(4)), reasons };
    }).sort((a, b) => b.score - a.score || a.designSystem.id.localeCompare(b.designSystem.id));
  }
}

module.exports = {
  ReferenceLibrary,
  hexToHsl,
  hueDistance,
  COLOR_WORDS,
  summarisePalette,
  summariseDesignSystem,
};

