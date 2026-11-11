'use strict';

/**
 * Structured layout engine: turns data (tables, headings, paragraphs, lists, ruled paper) into ordinary
 * drawing objects (rect, line, text) using real font measurement and the same wrapping as the renderer.
 * Every function is pure: it returns objects plus a continuation cursor for multi-page output.
 */

const { assert } = require('./errors');
const { normalizeFont, fontString, wrapLine, measureLine, fontMetrics, isRtlText } = require('./text');

const DEFAULT_TABLE_THEME = {
  headerFill: '#1f2a44',
  headerText: '#ffffff',
  rowFill: '#ffffff',
  altRowFill: '#f1f4f8',
  text: '#1b2433',
  subtotalFill: '#e9eef5',
  subtotalText: '#1b2433',
  totalFill: '#d6e0ee',
  totalText: '#0b1220',
  sectionFill: '#e3e9f1',
  sectionText: '#1f2a44',
  border: '#cfd7e3',
  borderWidth: 1,
  outerBorder: '#1f2a44',
  outerBorderWidth: 2,
  radius: 10,
};

const ARABIC_INDIC = ['٠', '١', '٢', '٣', '٤', '٥', '٦', '٧', '٨', '٩'];

function toArabicIndic(text) {
  return String(text)
    .replace(/[0-9]/g, (d) => ARABIC_INDIC[Number(d)])
    .replace(/%/g, '٪')
    .replace(/(\d|[٠-٩]),(?=[0-9٠-٩])/g, '$1٬')
    .replace(/([٠-٩])\.(?=[٠-٩])/g, '$1٫');
}

/** Format one cell value according to its column (numbers, currency, percent, dates). */
function formatValue(value, column, digits) {
  if (value === null || value === undefined || value === '') return '';
  const format = column.format || 'text';
  let out;
  if (format === 'date') {
    const s = value instanceof Date ? value.toISOString() : String(value);
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
    out = m ? `${m[1]}/${m[2]}/${m[3]}` : s;
  } else if (format === 'text' || (typeof value === 'string' && Number.isNaN(Number(String(value).replace(/,/g, ''))))) {
    out = String(value);
  } else {
    const n = Number(String(value).replace(/,/g, ''));
    const decimals = column.decimals === undefined ? (format === 'percent' ? 1 : (format === 'currency' ? 2 : 0)) : Number(column.decimals);
    const scaled = format === 'percent' && column.fromFraction ? n * 100 : n;
    const abs = new Intl.NumberFormat('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals }).format(Math.abs(scaled));
    let body = abs;
    if (format === 'percent') body = `${abs}%`;
    if (format === 'currency') {
      const symbol = column.currency === undefined ? 'ر.س' : String(column.currency);
      body = column.currencyPosition === 'before' ? `${symbol} ${abs}` : `${abs} ${symbol}`;
    }
    out = scaled < 0 ? (column.negativeParens ? `(${body})` : `-${body}`) : body;
  }
  return digits === 'arabic-indic' ? toArabicIndic(out) : out;
}

function isNumericFormat(column) {
  return ['number', 'currency', 'percent'].includes(column.format);
}

function normalizePadding(padding, size) {
  const p = padding || {};
  return {
    x: p.x === undefined ? Math.round(size * 0.6) : Number(p.x),
    y: p.y === undefined ? Math.round(size * 0.42) : Number(p.y),
  };
}

function setFont(measure, font) {
  measure.font = fontString(font);
}

/**
 * Lay out a table from structured data.
 * spec: { x, y, width, maxHeight?, columns:[{title, format, align, width, decimals, currency}], rows:[[...]|{cells, kind}],
 *         font, headerFont, theme, padding, rtl, digits, repeatHeader, startRow, zebra, name }
 */
function layoutTable(measure, spec) {
  assert(Array.isArray(spec.columns) && spec.columns.length > 0, 'INVALID_TABLE', 'columns must be a non-empty array');
  assert(Array.isArray(spec.rows), 'INVALID_TABLE', 'rows must be an array');
  assert(Number.isFinite(Number(spec.width)) && Number(spec.width) > 20, 'INVALID_TABLE', 'width must be a number > 20');
  const warnings = [];
  const theme = Object.assign({}, DEFAULT_TABLE_THEME, spec.theme || {});
  const font = normalizeFont(Object.assign({ family: 'Tajawal', size: 22, lineHeight: 1.35 }, spec.font || {}));
  const headerFont = normalizeFont(Object.assign({}, font, { weight: 700 }, spec.headerFont || {}));
  const boldFont = normalizeFont(Object.assign({}, font, { weight: 700 }));
  const pad = normalizePadding(spec.padding, font.size);
  const columns = spec.columns.map((c, i) => {
    const col = typeof c === 'string' ? { title: c } : Object.assign({}, c);
    col.title = col.title === undefined ? `#${i + 1}` : String(col.title);
    col.format = col.format || 'text';
    col.align = col.align || (isNumericFormat(col) ? 'end' : 'start');
    return col;
  });
  const n = columns.length;
  const rows = spec.rows.map((r) => {
    const row = Array.isArray(r) ? { cells: r } : Object.assign({}, r);
    row.kind = row.kind || 'data';
    assert(Array.isArray(row.cells), 'INVALID_TABLE', 'each row needs cells');
    const cells = [];
    let col = 0;
    for (const raw of row.cells) {
      if (col >= n) break;
      const cell = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? Object.assign({}, raw) : { value: raw };
      cell.colspan = Math.max(1, Math.min(n - col, Number(cell.colspan) || 1));
      cell.col = col;
      cell.text = cell.text !== undefined ? String(cell.text) : formatValue(cell.value, cell.colspan > 1 ? { format: 'text' } : columns[col], spec.digits);
      cells.push(cell);
      col += cell.colspan;
    }
    row.cells = cells;
    return row;
  });
  const allText = columns.map((c) => c.title).concat(rows.flatMap((r) => r.cells.map((c) => c.text))).join(' ');
  const rtl = spec.rtl === undefined ? isRtlText(allText) : Boolean(spec.rtl);

  // ---- column widths from real measurement
  const natural = new Array(n).fill(0);
  const minimum = new Array(n).fill(0);
  const measureCell = (text, f) => {
    setFont(measure, f);
    let widest = 0;
    let longestWord = 0;
    for (const line of String(text).split('\n')) {
      widest = Math.max(widest, measureLine(measure, line, rtl));
      for (const word of line.split(' ')) longestWord = Math.max(longestWord, measureLine(measure, word, rtl));
    }
    return { widest, longestWord };
  };
  columns.forEach((c, i) => {
    const m = measureCell(c.title, headerFont);
    natural[i] = Math.max(natural[i], m.widest + pad.x * 2);
    // Numeric/date headers stay on one line when possible; long text columns absorb the shrink.
    minimum[i] = Math.max(minimum[i], (c.format === 'text' ? m.longestWord : m.widest) + pad.x * 2);
  });
  for (const row of rows) {
    for (const cell of row.cells) {
      if (cell.colspan !== 1) continue;
      const f = row.kind === 'total' || row.kind === 'subtotal' || cell.bold ? boldFont : font;
      const m = measureCell(cell.text, f);
      natural[cell.col] = Math.max(natural[cell.col], m.widest + pad.x * 2);
      const numeric = isNumericFormat(columns[cell.col]) || columns[cell.col].format === 'date';
      minimum[cell.col] = Math.max(minimum[cell.col], (numeric ? m.widest : m.longestWord) + pad.x * 2);
    }
  }
  const total = Number(spec.width);
  const widths = new Array(n).fill(0);
  let fixed = 0;
  columns.forEach((c, i) => {
    if (c.width !== undefined && Number(c.width) > 1) { widths[i] = Number(c.width); fixed += widths[i]; }
  });
  const free = columns.map((c, i) => widths[i] === 0 ? i : -1).filter((i) => i >= 0);
  const available = total - fixed;
  const natSum = free.reduce((s, i) => s + natural[i], 0);
  if (natSum <= available) {
    const extra = available - natSum;
    free.forEach((i) => { widths[i] = natural[i] + (natSum ? extra * (natural[i] / natSum) : extra / free.length); });
  } else {
    const minSum = free.reduce((s, i) => s + minimum[i], 0);
    if (minSum <= available) {
      const slack = natSum - minSum;
      const cut = natSum - available;
      free.forEach((i) => { widths[i] = natural[i] - (slack ? cut * ((natural[i] - minimum[i]) / slack) : 0); });
    } else {
      warnings.push(`table needs at least ${Math.ceil(minSum + fixed)}px but only ${total}px is available: reduce font size, columns or text`);
      free.forEach((i) => { widths[i] = minimum[i] * (available / minSum); });
    }
  }
  // Column edges: RTL tables start at the right edge.
  const left = Number(spec.x);
  const edges = [];
  let cursor = rtl ? left + total : left;
  for (let i = 0; i < n; i += 1) {
    if (rtl) { edges.push({ x: cursor - widths[i], w: widths[i] }); cursor -= widths[i]; }
    else { edges.push({ x: cursor, w: widths[i] }); cursor += widths[i]; }
  }
  const spanBox = (col, span) => {
    const boxes = edges.slice(col, col + span);
    const x = Math.min(...boxes.map((b) => b.x));
    const r = Math.max(...boxes.map((b) => b.x + b.w));
    return { x, w: r - x };
  };

  // ---- row heights
  const lineCount = (text, f, width) => {
    setFont(measure, f);
    let count = 0;
    for (const line of String(text).split('\n')) count += wrapLine(measure, line, Math.max(1, width), rtl, []).length;
    return Math.max(1, count);
  };
  const lh = (f) => f.size * f.lineHeight;
  const headerLines = Math.max(...columns.map((c, i) => lineCount(c.title, headerFont, widths[i] - pad.x * 2)));
  const headerHeight = headerLines * lh(headerFont) + pad.y * 2;
  const rowFont = (row, cell) => (row.kind === 'total' || row.kind === 'subtotal' || (cell && cell.bold) ? boldFont : font);
  const rowHeights = rows.map((row) => {
    let lines = 1;
    for (const cell of row.cells) {
      lines = Math.max(lines, lineCount(cell.text, rowFont(row, cell), spanBox(cell.col, cell.colspan).w - pad.x * 2));
    }
    return lines * lh(font) + pad.y * 2;
  });

  // ---- paginate
  const top = Number(spec.y);
  const maxHeight = spec.maxHeight === undefined ? Infinity : Number(spec.maxHeight);
  const startRow = Math.max(0, Math.min(rows.length, Number(spec.startRow) || 0));
  const drawHeader = spec.header !== false && (startRow === 0 || spec.repeatHeader !== false);
  let y = top + (drawHeader ? headerHeight : 0);
  let end = startRow;
  while (end < rows.length && (y + rowHeights[end] <= top + maxHeight || end === startRow)) {
    if (y + rowHeights[end] > top + maxHeight) warnings.push(`row ${end + 1} is taller than the available height; it was placed anyway`);
    y += rowHeights[end];
    end += 1;
  }
  const height = y - top;

  // ---- objects
  const objects = [];
  const prefix = spec.name || 'table';
  const radius = Number(theme.radius) || 0;
  objects.push({ type: 'rect', name: `${prefix}:frame-fill`, x: left, y: top, w: total, h: height, radius, fill: theme.rowFill });
  let rowY = top;
  const cellText = (text, box, rowTop, rowH, f, color, align, name) => {
    const lines = lineCount(text, f, box.w - pad.x * 2);
    const textH = lines * lh(f);
    const startSide = rtl ? 'right' : 'left';
    const endSide = rtl ? 'left' : 'right';
    const side = align === 'center' ? 'center' : (align === 'end' ? endSide : startSide);
    const x = side === 'center' ? box.x + box.w / 2 : (side === 'right' ? box.x + box.w - pad.x : box.x + pad.x);
    return {
      type: 'text',
      name,
      text: String(text),
      x,
      y: rowTop + (rowH - textH) / 2,
      font: f,
      align: side,
      rtl: isRtlText(String(text)) ? true : (rtl && !/^[\s\d.,%()+\-$€£¥]*$/.test(String(text))),
      maxWidth: Math.max(1, box.w - pad.x * 2),
      fill: color,
    };
  };
  if (drawHeader) {
    objects.push({ type: 'rect', name: `${prefix}:header-fill`, x: left, y: rowY, w: total, h: headerHeight, radius: [radius, radius, 0, 0], fill: theme.headerFill });
    columns.forEach((c, i) => {
      objects.push(cellText(c.title, edges[i], rowY, headerHeight, headerFont, theme.headerText,
        c.headerAlign || (c.align === 'end' ? 'end' : c.align), `${prefix}:header:c${i}`));
    });
    rowY += headerHeight;
  }
  const lines = [];
  let dataIndex = 0;
  for (let r = startRow; r < end; r += 1) {
    const row = rows[r];
    const h = rowHeights[r];
    let fill = theme.rowFill;
    let color = theme.text;
    if (row.kind === 'total') { fill = theme.totalFill; color = theme.totalText; }
    else if (row.kind === 'subtotal') { fill = theme.subtotalFill; color = theme.subtotalText; }
    else if (row.kind === 'section') { fill = theme.sectionFill; color = theme.sectionText; }
    else if (spec.zebra !== false && dataIndex % 2 === 1) fill = theme.altRowFill;
    if (row.kind === 'data') dataIndex += 1;
    if (row.fill) fill = row.fill;
    const lastRow = r === end - 1;
    objects.push({
      type: 'rect', name: `${prefix}:r${r}:fill`, x: left, y: rowY, w: total, h,
      radius: lastRow ? [0, 0, radius, radius] : 0, fill,
    });
    for (const cell of row.cells) {
      const box = spanBox(cell.col, cell.colspan);
      const f = rowFont(row, cell);
      const align = cell.align || (row.kind === 'section' ? 'start' : (cell.colspan > 1 ? 'start' : columns[cell.col].align));
      objects.push(cellText(cell.text, box, rowY, h, f, cell.color || color, align, `${prefix}:r${r}:c${cell.col}`));
      if (cell.fill) objects.splice(objects.length - 1, 0, { type: 'rect', name: `${prefix}:r${r}:c${cell.col}:fill`, x: box.x, y: rowY, w: box.w, h, fill: cell.fill });
    }
    if (r > startRow || drawHeader) {
      lines.push({ type: 'line', name: `${prefix}:hline:${r}`, x1: left, y1: rowY, x2: left + total, y2: rowY,
        stroke: row.kind === 'total' ? theme.outerBorder : theme.border,
        strokeWidth: row.kind === 'total' ? Math.max(1.5, theme.borderWidth * 1.5) : theme.borderWidth, cap: 'butt' });
    }
    // Vertical separators skip merged cells.
    for (let c = 1; c < n; c += 1) {
      const crossesSpan = row.cells.some((cell) => cell.colspan > 1 && c > cell.col && c < cell.col + cell.colspan);
      if (crossesSpan) continue;
      const xLine = rtl ? edges[c].x + edges[c].w : edges[c].x;
      lines.push({ type: 'line', name: `${prefix}:vline:${r}:${c}`, x1: xLine, y1: rowY, x2: xLine, y2: rowY + h, stroke: theme.border, strokeWidth: theme.borderWidth, cap: 'butt' });
    }
    rowY += h;
  }
  if (drawHeader) {
    for (let c = 1; c < n; c += 1) {
      const xLine = rtl ? edges[c].x + edges[c].w : edges[c].x;
      lines.push({ type: 'line', name: `${prefix}:header-vline:${c}`, x1: xLine, y1: top, x2: xLine, y2: top + headerHeight, stroke: 'rgba(255,255,255,0.22)', strokeWidth: theme.borderWidth, cap: 'butt' });
    }
  }
  objects.push(...lines);
  if (theme.outerBorderWidth > 0) {
    objects.push({ type: 'rect', name: `${prefix}:frame`, x: left, y: top, w: total, h: height, radius, fill: null, stroke: theme.outerBorder, strokeWidth: theme.outerBorderWidth });
  }
  return {
    objects,
    height,
    headerHeight: drawHeader ? headerHeight : 0,
    rowsDrawn: [startRow, end],
    nextRow: end < rows.length ? end : null,
    columns: columns.map((c, i) => ({ title: c.title, width: Number(widths[i].toFixed(1)), x: Number(edges[i].x.toFixed(1)), align: c.align, format: c.format })),
    rtl,
    warnings,
  };
}

/** Horizontal rules + margin line of a ruled sheet. */
function ruledPaperObjects(spec) {
  const x = Number(spec.x || 0);
  const w = Number(spec.width);
  const bottom = Number(spec.y || 0) + Number(spec.height);
  const spacing = Number(spec.spacing);
  assert(spacing >= 8, 'INVALID_RULED', 'ruled.spacing must be >= 8px');
  const first = Number(spec.top === undefined ? Number(spec.y || 0) + spacing * 2 : spec.top);
  const objects = [];
  const rules = [];
  for (let y = first; y <= bottom - spacing * 0.5; y += spacing) {
    rules.push(y);
    objects.push({ type: 'line', name: `ruled:line:${rules.length - 1}`, x1: x, y1: y, x2: x + w, y2: y, stroke: spec.color || '#9cc3e6', strokeWidth: Number(spec.lineWidth || 1.5), cap: 'butt' });
  }
  if (spec.margin !== false) {
    const m = spec.margin || {};
    const rtl = spec.rtl !== false;
    const offset = Number(m.offset === undefined ? Math.round(w * 0.1) : m.offset);
    const mx = rtl ? x + w - offset : x + offset;
    objects.push({ type: 'line', name: 'ruled:margin', x1: mx, y1: Number(spec.y || 0), x2: mx, y2: bottom, stroke: m.color || '#e57373', strokeWidth: Number(m.width || 2), cap: 'butt' });
  }
  return { objects, rules, first, spacing };
}

/**
 * Flow headings, paragraphs, lists and tables into a box (optionally snapped to ruled lines).
 * spec: { x, y, width, height, rtl, font, headingFont, color, headingColor, markerColor, blocks, ruled, start, blockGap }
 * Returns objects plus `cursor` (null when everything fitted) to continue on the next page.
 */
function layoutFlow(measure, spec) {
  assert(Array.isArray(spec.blocks) && spec.blocks.length > 0, 'INVALID_FLOW', 'blocks must be a non-empty array');
  const warnings = [];
  const base = normalizeFont(Object.assign({ family: 'Tajawal', size: 26, lineHeight: 1.6 }, spec.font || {}));
  const headingFamily = (spec.headingFont && spec.headingFont.family) || base.family;
  const allText = spec.blocks.map((b) => [b.text, ...(b.items || [])].join(' ')).join(' ');
  const rtl = spec.rtl === undefined ? isRtlText(allText) : Boolean(spec.rtl);
  const boxX = Number(spec.x);
  const boxY = Number(spec.y);
  const width = Number(spec.width);
  const height = Number(spec.height);
  const ruled = spec.ruled ? Object.assign({}, spec.ruled) : null;
  // On ruled paper the writing starts a small gap after the margin line, never on it.
  let textLeft = boxX;
  let textWidth = width;
  if (ruled && ruled.margin !== false) {
    const offset = Number((ruled.margin || {}).offset === undefined ? Math.round(width * 0.1) : ruled.margin.offset);
    const gap = Math.round(Number((spec.font || {}).size || 26) * 0.5);
    textWidth = Math.max(40, width - offset - gap);
    if (!rtl) textLeft = boxX + offset + gap;
  }
  const anchor = rtl ? textLeft + textWidth : textLeft;
  const dir = rtl ? -1 : 1;
  const color = spec.color || '#1b2433';
  const headingColor = spec.headingColor || color;
  const markerColor = spec.markerColor || headingColor;
  const objects = [];
  const placed = [];

  // Build visual lines per block.
  const headingScale = { 1: 1.55, 2: 1.3, 3: 1.12 };
  const units = [];
  spec.blocks.forEach((block, blockIndex) => {
    const type = block.type || 'paragraph';
    if (type === 'table') {
      units.push({ kind: 'table', blockIndex, block });
      return;
    }
    if (type === 'spacer') {
      units.push({ kind: 'gap', blockIndex, rows: Number(block.lines || 1) });
      return;
    }
    if (blockIndex > 0) units.push({ kind: 'gap', blockIndex, rows: type === 'heading' ? Number(spec.headingGap === undefined ? 1 : spec.headingGap) : Number(spec.blockGap || 0) });
    if (type === 'heading') {
      const level = [1, 2, 3].includes(Number(block.level)) ? Number(block.level) : 2;
      const f = normalizeFont(Object.assign({}, base, { family: headingFamily, size: Math.round(base.size * headingScale[level]), weight: 700 }, block.font || {}));
      let text = String(block.text || '');
      if (block.colon && !/[:：]\s*$/.test(text)) text += ':';
      setFont(measure, f);
      wrapLine(measure, text, textWidth, rtl, []).forEach((line, lineIndex) => units.push({ kind: 'line', blockIndex, lineIndex, text: line, font: f, color: block.color || headingColor, indent: 0 }));
    } else if (type === 'list') {
      const ordered = Boolean(block.ordered);
      const items = Array.isArray(block.items) ? block.items : [];
      setFont(measure, base);
      const markers = items.map((_, i) => (ordered ? `${(Number(block.start) || 1) + i}${block.marker || '-'}` : (block.marker || '•')));
      const markerWidth = Math.max(...markers.map((m) => measureLine(measure, m, false)), 0);
      const indent = markerWidth + Math.round(base.size * 0.45);
      let lineIndex = 0;
      items.forEach((item, i) => {
        setFont(measure, base);
        const wrapped = wrapLine(measure, String(item), textWidth - indent, rtl, []);
        wrapped.forEach((line, k) => {
          units.push({ kind: 'line', blockIndex, lineIndex, text: line, font: base, color: block.color || color, indent, marker: k === 0 ? markers[i] : null, item: i });
          lineIndex += 1;
        });
      });
    } else {
      setFont(measure, base);
      const overflow = [];
      let lineIndex = 0;
      for (const para of String(block.text || '').split('\n')) {
        wrapLine(measure, para, textWidth, rtl, overflow).forEach((line) => {
          units.push({ kind: 'line', blockIndex, lineIndex, text: line, font: base, color: block.color || color, indent: 0 });
          lineIndex += 1;
        });
      }
      if (overflow.length) warnings.push(`block ${blockIndex}: ${overflow.length} word(s) wider than the line`);
    }
  });

  // Find where to resume.
  const start = spec.start || null;
  let u = 0;
  if (start) {
    u = units.findIndex((unit) => unit.blockIndex === start.block && (unit.kind === 'table' || unit.lineIndex === start.line));
    if (u < 0) u = units.findIndex((unit) => unit.blockIndex === start.block);
    if (u < 0) u = units.length;
  }

  // Vertical rhythm.
  let pitch;
  let firstBaseline;
  let rules = [];
  const lift = (f) => {
    setFont(measure, f);
    return fontMetrics(measure);
  };
  if (ruled) {
    pitch = Number(ruled.spacing);
    const paper = ruledPaperObjects(Object.assign({ x: boxX, y: boxY, width, height, rtl }, ruled));
    rules = paper.rules;
    if (spec.emitRules) objects.push(...paper.objects);
  } else {
    pitch = base.size * base.lineHeight;
  }
  const bottom = boxY + height;
  let row = 0;
  let y = boxY;
  let cursor = null;
  let firstOnPage = true;

  for (; u < units.length; u += 1) {
    const unit = units[u];
    if (unit.kind === 'gap') {
      if (firstOnPage) continue;
      if (ruled) row += unit.rows; else y += unit.rows * pitch * 0.6;
      continue;
    }
    if (unit.kind === 'table') {
      // On ruled paper a table starts on the next free rule, one band below the last written line.
      const tableTop = ruled ? (rules[row] !== undefined ? rules[row] + 2 : bottom) : y + (firstOnPage ? 0 : pitch * 0.4);
      const remaining = bottom - tableTop;
      const startRow = start && start.block === unit.blockIndex && !placed.length ? Number(start.line) || 0 : 0;
      if (remaining < base.size * 4) { cursor = { block: unit.blockIndex, line: startRow }; break; }
      const t = layoutTable(measure, Object.assign({ font: { family: base.family, size: Math.round(base.size * 0.85) } }, unit.block, {
        x: textLeft, y: tableTop, width: textWidth, maxHeight: remaining, startRow, rtl: unit.block.rtl === undefined ? rtl : unit.block.rtl,
        name: `flow:b${unit.blockIndex}:table`,
      }));
      objects.push(...t.objects);
      warnings.push(...t.warnings);
      placed.push({ block: unit.blockIndex, table: true, rows: t.rowsDrawn, top: tableTop, height: t.height });
      firstOnPage = false;
      if (t.nextRow !== null) { cursor = { block: unit.blockIndex, line: t.nextRow }; break; }
      if (ruled) { while (row < rules.length && rules[row] < tableTop + t.height + pitch * 0.5) row += 1; }
      else y = tableTop + t.height + pitch * 0.4;
      continue;
    }
    const m = lift(unit.font);
    const inkHeight = m.ascent + m.descent;
    let baseline;
    if (ruled) {
      const rowsNeeded = Math.max(1, Math.ceil((m.ascent * 0.92) / pitch));
      const target = row + rowsNeeded - 1;
      if (target >= rules.length) { cursor = { block: unit.blockIndex, line: unit.lineIndex }; break; }
      const liftPx = ruled.lift === undefined ? Math.max(3, Math.round(base.size * 0.2)) : Number(ruled.lift);
      baseline = rules[target] - liftPx;
      row = target + 1;
    } else {
      const linePitch = Math.max(pitch, unit.font.size * unit.font.lineHeight);
      baseline = y + (linePitch - inkHeight) / 2 + m.ascent;
      if (baseline + m.descent > bottom) { cursor = { block: unit.blockIndex, line: unit.lineIndex }; break; }
      y += linePitch;
    }
    firstOnPage = false;
    const textX = anchor + dir * unit.indent;
    objects.push({
      type: 'text', name: `flow:b${unit.blockIndex}:l${unit.lineIndex}`, text: unit.text, x: textX, y: baseline,
      baseline: 'alphabetic', font: unit.font, align: rtl ? 'right' : 'left', rtl, fill: unit.color,
    });
    if (unit.marker) {
      objects.push({
        type: 'text', name: `flow:b${unit.blockIndex}:m${unit.item}`, text: unit.marker, x: anchor, y: baseline,
        baseline: 'alphabetic', font: Object.assign({}, unit.font, { weight: 700 }), align: rtl ? 'right' : 'left', rtl, fill: markerColor,
      });
    }
    placed.push({ block: unit.blockIndex, line: unit.lineIndex, text: unit.text, baseline, size: unit.font.size, ascent: m.ascent, descent: m.descent, rule: ruled ? baseline + (ruled.lift === undefined ? Math.max(3, Math.round(base.size * 0.2)) : Number(ruled.lift)) : null });
  }

  // Lossless check: every word of every finished block was emitted, in order.
  const emitted = {};
  for (const p of placed) if (p.text !== undefined) (emitted[p.block] = emitted[p.block] || []).push(p.text);
  spec.blocks.forEach((block, i) => {
    if (!emitted[i] || (cursor && cursor.block <= i) || block.type === 'table' || block.type === 'spacer') return;
    if (start && start.block === i) return;
    const expected = (block.type === 'list' ? (block.items || []).join(' ') : String(block.text || '') + (block.colon && !/[:：]\s*$/.test(String(block.text || '')) ? ':' : ''))
      .split(/\s+/).filter(Boolean).join(' ');
    const got = emitted[i].join(' ').split(/\s+/).filter(Boolean).join(' ');
    if (expected !== got) warnings.push(`block ${i}: emitted text differs from input (lost or changed words)`);
  });

  return { objects, cursor, placed, rules, pitch, rtl, warnings };
}

module.exports = {
  DEFAULT_TABLE_THEME,
  formatValue,
  toArabicIndic,
  layoutTable,
  layoutFlow,
  ruledPaperObjects,
};
