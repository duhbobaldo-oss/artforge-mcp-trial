'use strict';

/**
 * Data-driven document designs: professional tables, ruled pages with long Arabic text, and designs built
 * around a user-supplied reference image. Pagination is delegated to the drawing tool (layout.* cursors).
 */

const { mix, darken, lighten, readableOn, contrast } = require('../color');

/** Parse "| a | b |" markdown-style rows from text into { columns, rows }. */
function parseTableText(text) {
  const lines = String(text || '').split('\n').map((l) => l.trim()).filter((l) => l.startsWith('|') || (l.split('|').length > 2));
  const rows = lines
    .filter((l) => !/^\|?\s*:?-{2,}/.test(l.replace(/\|/g, '').trim() ? l : '---'))
    .map((l) => l.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim()));
  const clean = rows.filter((r) => !r.every((c) => /^:?-+:?$/.test(c)));
  if (clean.length < 2) return null;
  return { columns: clean[0].map((title) => ({ title })), rows: clean.slice(1) };
}

/** Turn plain text into flow blocks: "# " headings, "1-"/"1." numbered lists, "-"/"•" bullets, blank-line paragraphs. */
function textToBlocks(text) {
  const blocks = [];
  let list = null;
  let para = [];
  const flushPara = () => { if (para.length) { blocks.push({ type: 'paragraph', text: para.join(' ') }); para = []; } };
  const flushList = () => { if (list) { blocks.push(list); list = null; } };
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim();
    if (!line) { flushPara(); flushList(); continue; }
    let m;
    if ((m = /^(#{1,3})\s+(.+)$/.exec(line))) { flushPara(); flushList(); blocks.push({ type: 'heading', level: m[1].length, text: m[2] }); continue; }
    if ((m = /^([0-9٠-٩]+)\s*[-.)]\s*(.+)$/.exec(line))) {
      flushPara();
      if (!list || !list.ordered) { flushList(); list = { type: 'list', ordered: true, items: [], start: Number(String(m[1]).replace(/[٠-٩]/g, (d) => '٠١٢٣٤٥٦٧٨٩'.indexOf(d))) || 1 }; }
      list.items.push(m[2]);
      continue;
    }
    if ((m = /^[-•*]\s+(.+)$/.exec(line))) {
      flushPara();
      if (!list || list.ordered) { flushList(); list = { type: 'list', ordered: false, items: [] }; }
      list.items.push(m[1]);
      continue;
    }
    flushList();
    para.push(line);
  }
  flushPara();
  flushList();
  return blocks;
}

function tableTheme(palette, refsOn, override) {
  if (!refsOn) return Object.assign({ headerFill: '#000080', headerText: '#ffffff', altRowFill: '#eeeeee', totalFill: '#cccccc', border: '#999999', outerBorder: '#000080' }, override || {});
  const headerFill = palette.strong;
  const theme = {
    headerFill,
    headerText: readableOn(headerFill, '#0b1220', '#ffffff'),
    rowFill: '#ffffff',
    altRowFill: mix('#ffffff', headerFill, 0.06),
    subtotalFill: mix('#ffffff', headerFill, 0.12),
    totalFill: mix('#ffffff', palette.accent, 0.22),
    totalText: '#0b1220',
    sectionFill: mix('#ffffff', headerFill, 0.16),
    sectionText: darken(headerFill, 0.1),
    text: '#1b2433',
    border: mix('#ffffff', headerFill, 0.22),
    outerBorder: headerFill,
  };
  if (contrast(theme.totalFill, theme.totalText) < 4.5) theme.totalText = readableOn(theme.totalFill);
  return Object.assign(theme, override || {});
}

function composeTable(P, ctx) {
  const { W, H } = P;
  const { input, palette, content, ev, refsOn } = ctx;
  const table = input.table || parseTableText(input.body) || null;
  if (!table || !Array.isArray(table.columns) || !Array.isArray(table.rows)) {
    const error = new Error('A table design needs data: pass table={columns:[...], rows:[[...]]} or a "| a | b |" table in body. ArtForge does not invent table data.');
    error.code = 'TABLE_DATA_REQUIRED';
    throw error;
  }
  const margin = Math.round(W * 0.05);
  P.layer('background', 'الخلفية');
  P.layer('content', 'المحتوى');
  P.draw('draw.rect', 'background', { x: 0, y: 0, w: W, h: H, fill: refsOn ? lighten(palette.paper, 0.4) : '#ffffff' }, 'background', 'page');
  P.rect('background', { x: 0, y: 0, w: W, h: Math.round(H * 0.012), fill: palette.strong }, 'background', 'top accent bar');
  const titleSize = Math.round(W * 0.03);
  let y = Math.round(H * 0.06);
  if (content.headline) {
    P.text('content', { x: W - margin, y, text: content.headline, font: { family: input.headlineFont || 'Tajawal', size: titleSize, weight: 700 }, fill: palette.strong, maxWidth: W - margin * 2, align: 'right' }, 'title', 'table title (H1)');
    y += Math.round(titleSize * 1.6);
  }
  if (content.body && !parseTableText(content.body)) {
    P.text('content', { x: W - margin, y, text: content.body, font: { family: input.bodyFont || 'Tajawal', size: Math.round(titleSize * 0.55), lineHeight: 1.5 }, fill: '#4a5568', maxWidth: W - margin * 2, align: 'right' }, 'subtitle', 'table subtitle');
    y += Math.round(titleSize * 1.4);
  }
  const theme = tableTheme(palette, refsOn, table.theme);
  const tableStep = P.draw('layout.table', 'content', {
    x: margin, y, width: W - margin * 2, maxHeight: H - y - margin,
    columns: table.columns, rows: table.rows, digits: table.digits, zebra: table.zebra,
    font: Object.assign({ family: input.bodyFont || 'Tajawal', size: Math.round(W * 0.0155) }, table.font || {}),
    theme, repeatHeader: true, name: 'table',
  }, 'table', 'professional table from structured data (auto widths, zebra rows, totals, RTL)');
  P.ops[tableStep].paginate = { resultField: 'nextRow', param: 'startRow', firstPageOnly: [], continuedTop: Math.round(H * 0.06) };
  if (refsOn) ev.record('limited-palette', `Table colours derived from the reference palette: header ${theme.headerFill}, zebra ${theme.altRowFill}, total ${theme.totalFill}; header text contrast ${contrast(theme.headerFill, theme.headerText).toFixed(1)}:1.`, [tableStep], 'table');
  return { table: { columns: table.columns.length, rows: table.rows.length }, theme };
}

function composeRuled(P, ctx) {
  const { W, H } = P;
  const { input, content, palette, refsOn } = ctx;
  let blocks = Array.isArray(input.blocks) && input.blocks.length ? input.blocks.slice() : textToBlocks(content.body || '');
  if (content.headline && !(blocks[0] && blocks[0].type === 'heading' && blocks[0].text === content.headline)) {
    blocks.unshift({ type: 'heading', level: 1, text: content.headline, colon: Boolean(input.headlineColon) });
  }
  if (input.table) blocks.push(Object.assign({ type: 'table', theme: tableTheme(palette, refsOn, input.table.theme) }, input.table));
  if (!blocks.length) {
    const error = new Error('A ruled page needs text: pass body (long text; "# " headings, "1-" lists, "-" bullets) or blocks.');
    error.code = 'TEXT_REQUIRED';
    throw error;
  }
  const ruledOpt = typeof input.ruled === 'object' && input.ruled ? input.ruled : {};
  const size = Number(ruledOpt.fontSize || input.fontSize || Math.round(W * 0.025));
  const spacing = Number(ruledOpt.spacing || Math.round(size * 1.95));
  const margin = Math.round(W * 0.06);
  P.layer('paper', 'الورقة');
  P.layer('rules', 'الأسطر');
  P.layer('text', 'النص');
  P.draw('draw.rect', 'paper', { x: 0, y: 0, w: W, h: H, fill: ruledOpt.paper || '#fffdf6' }, 'paper', 'paper');
  const flow = P.draw('layout.flow', 'text', {
    rulesLayer: 'rules',
    x: margin, y: margin, width: W - margin * 2, height: H - margin * 2,
    font: { family: input.bodyFont || 'Tajawal', size },
    headingFont: { family: input.headlineFont || 'Tajawal' },
    color: ruledOpt.ink || '#1b2433', headingColor: ruledOpt.headingInk || palette.strong, markerColor: palette.strong,
    ruled: { spacing, top: margin + spacing * 1.6, color: ruledOpt.lineColor || '#8fb8e6', lineWidth: 1.5, margin: ruledOpt.margin === false ? false : { offset: Math.round(W * 0.07), color: ruledOpt.marginColor || '#e06666' } },
    blocks,
  }, 'text', 'text flowed onto the ruled lines (baseline snapped to each rule)');
  P.ops[flow].paginate = { resultField: 'cursor', param: 'start' };
  P.ops[flow].qaRuled = true;
  return { blocks: blocks.length, fontSize: size, ruleSpacing: spacing, words: blocks.map((b) => [b.text, ...(b.items || [])].join(' ')).join(' ').split(/\s+/).filter(Boolean).length };
}

function composeReference(P, ctx) {
  const { W, H } = P;
  const { input, content, palette, analysis } = ctx;
  if (!input.referenceImage) {
    const error = new Error('A reference-based design needs referenceImage (absolute path to a PNG/JPEG/WebP the user provided).');
    error.code = 'REFERENCE_REQUIRED';
    throw error;
  }
  P.layer('image', 'الصورة المرجعية');
  P.layer('overlay', 'طبقة القراءة');
  P.layer('text', 'النصوص');
  const add = P.push({ op: 'image.add', note: 'register the user reference image as an asset', element: 'reference', saveAs: 'ref', params: { path: input.referenceImage, name: 'user-reference' } });
  P.draw('draw.image', 'image', { assetId: '$ref.asset.id', x: 0, y: 0, w: W, h: H, fit: 'cover' }, 'reference', 'reference image used as the hero (cover fit)');
  // Text goes into the calmest third of the reference (least detail), so the image subject stays visible.
  const calm = analysis && analysis.calmestCell ? analysis.calmestCell : { row: 2, col: 1 };
  const band = calm.row === 0 ? { y: 0, h: H * 0.42 } : calm.row === 1 ? { y: H * 0.29, h: H * 0.42 } : { y: H * 0.58, h: H * 0.42 };
  const dark = analysis ? analysis.tone !== 'light' : true;
  const overlay = dark ? '#0b1220' : '#ffffff';
  P.draw('draw.rect', 'overlay', { x: 0, y: band.y, w: W, h: band.h, fill: { type: 'linear', angle: 90, stops: [{ offset: 0, color: `rgba(${dark ? '11,18,32' : '255,255,255'},0)` }, { offset: 0.35, color: `rgba(${dark ? '11,18,32' : '255,255,255'},0.72)` }, { offset: 1, color: `rgba(${dark ? '11,18,32' : '255,255,255'},0.85)` }] } }, 'overlay', `legibility gradient over the calmest region (row ${calm.row})`);
  const textColor = readableOn(overlay);
  const margin = Math.round(W * 0.07);
  const hs = Math.round(W * 0.065);
  let y = band.y + band.h * 0.4;
  if (content.headline) {
    P.text('text', { x: W - margin, y, text: content.headline, font: { family: input.headlineFont || 'Amiri', size: hs, weight: 700 }, fill: textColor, maxWidth: W - margin * 2, align: 'right' }, 'headline', 'headline in the calm region');
    y += hs * 1.5;
  }
  if (content.body) P.text('text', { x: W - margin, y, text: content.body, font: { family: input.bodyFont || 'Tajawal', size: Math.round(hs * 0.42), lineHeight: 1.55 }, fill: textColor, maxWidth: W - margin * 2, align: 'right' }, 'body', 'body text');
  P.rect('text', { x: W - margin - W * 0.18, y: band.y + band.h * 0.33, w: W * 0.18, h: 6, fill: palette.accent }, 'accent', 'accent rule in a colour taken from the reference');
  void add;
  return { analysis: analysis ? { tone: analysis.tone, calmestCell: calm, balance: analysis.balance, colors: (analysis.colors || []).slice(0, 6) } : null };
}

module.exports = { composeTable, composeRuled, composeReference, textToBlocks, parseTableText, tableTheme };
