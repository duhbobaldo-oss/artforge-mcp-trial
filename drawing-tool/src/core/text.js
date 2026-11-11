'use strict';

const { assert } = require('./errors');

/** Arabic/Persian/Hebrew ranges used to auto-detect right-to-left text. */
const RTL_RE = /[\u0590-\u05FF\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/;

const DEFAULT_FONT = {
  family: 'Tahoma',
  size: 32,
  weight: 400,
  style: 'normal',
  lineHeight: 1.35,
  letterSpacing: 0,
};

function isRtlText(text) {
  return typeof text === 'string' && RTL_RE.test(text);
}

function normalizeFont(input, field) {
  const font = Object.assign({}, DEFAULT_FONT, input || {});
  const name = field || 'font';
  assert(typeof font.family === 'string' && font.family.trim().length > 0, 'INVALID_FONT',
    `${name}.family must be a non-empty string`, { received: font.family });
  const size = Number(font.size);
  assert(Number.isFinite(size) && size > 0 && size <= 2000, 'INVALID_FONT',
    `${name}.size must be a number between 1 and 2000`, { received: font.size });
  const weight = Number(font.weight === undefined ? 400 : font.weight);
  assert([100, 200, 300, 400, 500, 600, 700, 800, 900].includes(weight), 'INVALID_FONT',
    `${name}.weight must be a CSS font weight (100..900)`, { received: font.weight });
  const style = font.style || 'normal';
  assert(['normal', 'italic', 'oblique'].includes(style), 'INVALID_FONT',
    `${name}.style must be normal, italic or oblique`, { received: style });
  const lineHeight = Number(font.lineHeight === undefined ? 1.35 : font.lineHeight);
  assert(Number.isFinite(lineHeight) && lineHeight >= 0.5 && lineHeight <= 5, 'INVALID_FONT',
    `${name}.lineHeight must be between 0.5 and 5`, { received: font.lineHeight });
  const letterSpacing = Number(font.letterSpacing === undefined ? 0 : font.letterSpacing);
  assert(Number.isFinite(letterSpacing) && Math.abs(letterSpacing) <= 200, 'INVALID_FONT',
    `${name}.letterSpacing must be a number between -200 and 200`, { received: font.letterSpacing });
  return {
    family: font.family.trim(),
    size,
    weight,
    style,
    lineHeight,
    letterSpacing,
  };
}

// Node only: Skia does not fall back to the nearest installed weight (a missing weight renders another
// family, without Arabic glyphs). fonts.js installs a resolver for the bundled families; browsers match
// weights themselves (CSS), so they never set one.
let weightResolver = null;
function setWeightResolver(fn) { weightResolver = typeof fn === 'function' ? fn : null; }

/** Build the CSS `font` shorthand used by both Skia (Node) and browsers. */
function fontString(font) {
  const style = font.style === 'normal' ? '' : `${font.style} `;
  const w = weightResolver ? weightResolver(font.family, font.weight || 400) : font.weight;
  const weight = w && w !== 400 ? `${w} ` : '';
  const safeFamily = font.family.replace(/"/g, '');
  return `${style}${weight}${font.size}px "${safeFamily}"`;
}

/**
 * Skia (and browsers without an explicit dir) resolve each line as an LTR paragraph, which moves
 * trailing punctuation and Latin runs to the wrong side of Arabic lines. Wrapping the line in
 * RLI…PDI makes the shaper apply the Unicode Bidirectional Algorithm with an RTL base direction.
 */
const RLI = '\u2067';
const PDI = '\u2069';
const BIDI_CONTROL_RE = /[\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;

function bidiIsolate(text, rtl) {
  if (!rtl || !text) return text;
  return `${RLI}${text}${PDI}`;
}

/** Tokens made only of punctuation stay attached to the previous word so they never start a line. */
const TRAILING_PUNCT_RE = /^[،؛؟۔.,;:!?)\]}»”"'…%\-–—]+$/;

function measureLine(ctx, text, rtl) {
  return ctx.measureText(bidiIsolate(text, rtl)).width;
}

function wrapLine(ctx, line, maxWidth, rtl, overflow) {
  if (!maxWidth || maxWidth <= 0) return [line];
  const raw = line.split(' ');
  const words = [];
  for (const token of raw) {
    if (words.length && token && TRAILING_PUNCT_RE.test(token)) words[words.length - 1] += ` ${token}`;
    else words.push(token);
  }
  const out = [];
  let current = '';
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (measureLine(ctx, candidate, rtl) <= maxWidth || !current) {
      current = candidate;
    } else {
      out.push(current);
      current = word;
    }
    // A single word wider than the box is kept whole (breaking Arabic letters destroys shaping) and reported.
    if (overflow && current === word && word && measureLine(ctx, word, rtl) > maxWidth) {
      overflow.push(word);
    }
  }
  if (current || !out.length) out.push(current);
  return out;
}

/** Vertical font metrics used to align baselines (ruled paper, tables). */
function fontMetrics(ctx) {
  const probe = ctx.measureText('Hgهـيجلأ');
  const ascent = Number.isFinite(probe.fontBoundingBoxAscent) && probe.fontBoundingBoxAscent > 0
    ? probe.fontBoundingBoxAscent : probe.actualBoundingBoxAscent;
  const descent = Number.isFinite(probe.fontBoundingBoxDescent) && probe.fontBoundingBoxDescent > 0
    ? probe.fontBoundingBoxDescent : probe.actualBoundingBoxDescent;
  return { ascent: ascent || 0, descent: descent || 0 };
}

/**
 * Lay out a text object: splits on newlines, wraps to maxWidth and measures each line.
 * The caller is responsible for having set ctx.font before calling (or pass font).
 * baseline "top" (default): y is the top of the first line box.
 * baseline "alphabetic": y is the baseline of the first line (used for ruled paper).
 */
function layoutText(ctx, textObject) {
  if (Array.isArray(textObject.runs) && textObject.runs.length) return layoutRuns(ctx, textObject);
  const font = normalizeFont(textObject.font);
  ctx.font = fontString(font);
  if (typeof ctx.letterSpacing === 'string' && font.letterSpacing) {
    ctx.letterSpacing = `${font.letterSpacing}px`;
  }
  const raw = String(textObject.text === undefined ? '' : textObject.text);
  const rtl = textObject.rtl === undefined ? isRtlText(raw) : Boolean(textObject.rtl);
  const explicitLines = raw.split('\n');
  const lines = [];
  const overflowWords = [];
  for (const line of explicitLines) {
    for (const wrapped of wrapLine(ctx, line, textObject.maxWidth || 0, rtl, overflowWords)) {
      lines.push({ text: wrapped, width: measureLine(ctx, wrapped, rtl) });
    }
  }
  const lineHeight = font.size * font.lineHeight;
  const contentWidth = lines.reduce((max, l) => Math.max(max, l.width), 0);
  const contentHeight = Math.max(lineHeight, lines.length * lineHeight);
  const boxWidth = textObject.maxWidth ? Math.min(textObject.maxWidth, Math.max(contentWidth, 1)) : contentWidth;
  const metrics = fontMetrics(ctx);
  const baseline = textObject.baseline === 'alphabetic' ? 'alphabetic' : 'top';
  return {
    font,
    lines,
    lineHeight,
    contentWidth,
    contentHeight,
    boxWidth,
    boxHeight: contentHeight,
    align: textObject.align || (rtl ? 'right' : 'left'),
    rtl,
    baseline,
    ascent: metrics.ascent,
    descent: metrics.descent,
    overflowWords,
  };
}

// ------------------------------------------------------------------ styled runs

/*
 * Text runs: several styles inside one paragraph. `runs` are [{start, end, font?, fill?, underline?}]
 * (UTF-16 offsets into text, end exclusive; font holds only the overridden fields). Lines wrap with each
 * piece measured in its own font; pieces are placed in visual (bidi) order and share one baseline per
 * line. Where a run boundary falls inside an Arabic word, ZWJ is added on both sides so the letters keep
 * their joined forms.
 */
const ZWJ = '‍';
const LRI = '⁦';
const ARABIC_LETTER_RE = /[ؠ-يـٮ-ۓۺ-ۼ]/;
const ARABIC_MARK_RE = /[ً-ٰٟۖ-ۭ]/;
// Letters that join only to the letter before them (no connection to the next letter).
const RIGHT_JOINING = new Set('ءآأؤإاةدذرزوٱٲٳٵٶٷڈډڊڋڌڍڎڏڐڑڒړڔڕږڗژڙۀۃۄۅۆۇۈۉۊۋۍۏےۓۮۯ'.split(''));

function lastBase(text) {
  for (let i = text.length - 1; i >= 0; i -= 1) if (!ARABIC_MARK_RE.test(text[i]) && text[i] !== ZWJ) return text[i];
  return '';
}
function joinsAcross(left, right) {
  const a = lastBase(left);
  const b = right.replace(/^‍/, '')[0] || '';
  return ARABIC_LETTER_RE.test(a) && !RIGHT_JOINING.has(a) && ARABIC_LETTER_RE.test(b) && b !== 'ء';
}

const STRONG_LTR_RE = /[A-Za-zÀ-ɏͰ-ϿЀ-ӿ0-9٠-٩۰-۹]/;
function strongDirection(text) {
  for (const ch of text) {
    if (RTL_RE.test(ch) && !/[٠-٩۰-۹]/.test(ch)) return 'rtl';
    if (STRONG_LTR_RE.test(ch)) return 'ltr';
  }
  return 'neutral';
}

/** Full style for every character range: base font/fill overridden by runs. */
function styledSpans(text, base, runs) {
  const cuts = new Set([0, text.length]);
  for (const r of runs) { cuts.add(Math.max(0, Math.min(text.length, r.start))); cuts.add(Math.max(0, Math.min(text.length, r.end))); }
  const points = [...cuts].sort((a, b) => a - b);
  const spans = [];
  for (let i = 0; i < points.length - 1; i += 1) {
    const start = points[i]; const end = points[i + 1];
    if (end <= start) continue;
    const run = runs.find((r) => r.start <= start && r.end >= end);
    spans.push({ start, end, font: run && run.font ? normalizeFont(Object.assign({}, base, run.font)) : base,
      fill: run && run.fill !== undefined ? run.fill : undefined, underline: Boolean(run && run.underline), runIndex: run ? runs.indexOf(run) : -1 });
  }
  return spans;
}

const metricsCache = new Map();
function emAscentOf(ctx, font) {
  const key = fontString(font);
  if (metricsCache.has(key)) return metricsCache.get(key);
  ctx.font = key;
  const m = ctx.measureText('Hgهـ');
  const ascent = Number.isFinite(m.emHeightAscent) && m.emHeightAscent > 0 ? m.emHeightAscent
    : Number.isFinite(m.fontBoundingBoxAscent) && m.fontBoundingBoxAscent > 0 ? m.fontBoundingBoxAscent : font.size * 0.8;
  const descent = Number.isFinite(m.emHeightDescent) && m.emHeightDescent > 0 ? m.emHeightDescent
    : Number.isFinite(m.fontBoundingBoxDescent) && m.fontBoundingBoxDescent > 0 ? m.fontBoundingBoxDescent : font.size * 0.2;
  const out = { ascent, descent };
  if (metricsCache.size > 256) metricsCache.clear();
  metricsCache.set(key, out);
  return out;
}

const isolate = (text, dir) => (dir === 'ltr' ? `${LRI}${text}${PDI}` : `${RLI}${text}${PDI}`);

function measurePiece(ctx, text, font, dir) {
  ctx.font = fontString(font);
  return ctx.measureText(isolate(text, dir)).width;
}

/** Visual left→right order of a line's pieces (bidi at piece granularity). */
function visualOrder(pieces, rtl) {
  const dirs = pieces.map((p) => p.dir);
  // Neutrals between two pieces of the same strong direction take it; otherwise the paragraph's.
  for (let i = 0; i < dirs.length; i += 1) {
    if (dirs[i] !== 'neutral') continue;
    let a = null; let b = null;
    for (let k = i - 1; k >= 0; k -= 1) if (pieces[k].dir !== 'neutral') { a = pieces[k].dir; break; }
    for (let k = i + 1; k < pieces.length; k += 1) if (pieces[k].dir !== 'neutral') { b = pieces[k].dir; break; }
    dirs[i] = a && a === b ? a : rtl ? 'rtl' : 'ltr';
  }
  pieces.forEach((p, i) => { p.resolved = dirs[i]; });
  const embedded = rtl ? 'ltr' : 'rtl';
  // Runs of the embedded direction keep their own internal order; the paragraph direction orders blocks.
  const blocks = [];
  for (const p of pieces) {
    const last = blocks[blocks.length - 1];
    if (p.resolved === embedded && last && last.embedded) last.items.push(p);
    else blocks.push({ embedded: p.resolved === embedded, items: [p] });
  }
  const out = [];
  for (const blk of rtl ? blocks.slice().reverse() : blocks) out.push(...(blk.embedded && !rtl ? blk.items.slice().reverse() : blk.items));
  return out;
}

function layoutRuns(ctx, textObject) {
  const font = normalizeFont(textObject.font);
  const raw = String(textObject.text === undefined ? '' : textObject.text);
  const rtl = textObject.rtl === undefined ? isRtlText(raw) : Boolean(textObject.rtl);
  const spans = styledSpans(raw, font, textObject.runs || []);
  const piecesOf = (a, b) => spans.filter((s) => s.end > a && s.start < b).map((s) => ({ start: Math.max(a, s.start), end: Math.min(b, s.end), span: s }));
  const widthOf = (a, b) => piecesOf(a, b).reduce((sum, p) => sum + measurePiece(ctx, raw.slice(p.start, p.end), p.span.font, rtl ? 'rtl' : 'ltr'), 0);
  const maxWidth = textObject.maxWidth || 0;
  const ranges = [];
  const overflowWords = [];
  let offset = 0;
  for (const para of raw.split('\n')) {
    const start = offset; const end = offset + para.length;
    offset = end + 1;
    if (!maxWidth) { ranges.push([start, end]); continue; }
    // Words: [a, b) without the following space; punctuation-only words stick to the previous one.
    const words = [];
    let i = start;
    while (i <= end) {
      let j = raw.indexOf(' ', i);
      if (j === -1 || j > end) j = end;
      const w = raw.slice(i, j);
      if (words.length && w && TRAILING_PUNCT_RE.test(w)) words[words.length - 1][1] = j; else words.push([i, j]);
      i = j + 1;
    }
    let ls = null; let le = null;
    for (const [a, b] of words) {
      if (ls !== null && widthOf(ls, b) <= maxWidth) { le = b; continue; }
      if (ls !== null) ranges.push([ls, le]);
      ls = a; le = b;
      if (widthOf(a, b) > maxWidth) overflowWords.push(raw.slice(a, b));
    }
    ranges.push([ls === null ? start : ls, le === null ? end : le]);
  }
  const lines = [];
  let top = 0;
  let contentWidth = 0;
  for (const [a, b] of ranges) {
    // Spaces are pieces of their own: a shaper places a space at a piece edge by its own bidi rules,
    // which would disagree with this layout's placement.
    const parts = [];
    for (const p of piecesOf(a, b)) {
      const text = raw.slice(p.start, p.end);
      const re = / +|[^ ]+/g;
      let m;
      while ((m = re.exec(text))) {
        parts.push({ start: p.start + m.index, end: p.start + m.index + m[0].length, text: m[0], font: p.span.font, fill: p.span.fill, underline: p.span.underline, runIndex: p.span.runIndex });
      }
    }
    if (!parts.length) parts.push({ start: a, end: a, text: '', font, fill: undefined, underline: false, runIndex: -1 });
    for (const p of parts) { p.draw = p.text; p.dir = strongDirection(p.text); }
    for (let k = 0; k < parts.length - 1; k += 1) {
      if (joinsAcross(parts[k].text, parts[k + 1].text)) { parts[k].draw += ZWJ; parts[k + 1].draw = ZWJ + parts[k + 1].draw; }
    }
    const ordered = visualOrder(parts, rtl);
    let x = 0; let ascent = 0; let descent = 0; let height = 0;
    for (const p of ordered) {
      p.width = measurePiece(ctx, p.draw, p.font, p.resolved);
      p.x = x;
      x += p.width;
      const m = emAscentOf(ctx, p.font);
      ascent = Math.max(ascent, m.ascent);
      descent = Math.max(descent, m.descent);
      height = Math.max(height, p.font.size * font.lineHeight);
    }
    lines.push({ text: raw.slice(a, b), width: x, pieces: ordered, ascent, descent, height, top });
    top += height;
    contentWidth = Math.max(contentWidth, x);
  }
  ctx.font = fontString(font);
  const boxWidth = maxWidth ? Math.min(maxWidth, Math.max(contentWidth, 1)) : contentWidth;
  const first = lines[0] || { ascent: font.size * 0.8, descent: font.size * 0.2 };
  return {
    font, lines, runs: true,
    lineHeight: font.size * font.lineHeight,
    contentWidth, contentHeight: Math.max(1, top), boxWidth, boxHeight: Math.max(1, top),
    align: textObject.align || (rtl ? 'right' : 'left'), rtl,
    baseline: textObject.baseline === 'alphabetic' ? 'alphabetic' : 'top',
    ascent: first.ascent, descent: first.descent, overflowWords,
  };
}

module.exports = {
  setWeightResolver,
  layoutRuns,
  joinsAcross,
  isolate,
  RTL_RE,
  BIDI_CONTROL_RE,
  bidiIsolate,
  fontMetrics,
  measureLine,
  wrapLine,
  DEFAULT_FONT,
  isRtlText,
  normalizeFont,
  fontString,
  layoutText,
};
