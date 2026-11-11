'use strict';

/**
 * Photoshop PSD (version 1, RGB, 8 bits/channel) export and import with declared limits.
 *
 * Export keeps as PSD features: layer order, pixel layers, groups (section dividers), names (Unicode
 * `luni`, so Arabic survives), opacity, blend modes, visibility, clipping, the merged composite and the
 * ICC profile; adjustment layers invert/posterize/threshold/brightnessContrast/levels/curves/hueSaturation
 * are written natively. Everything else is honest about its loss in the report: text, effects, smart
 * filters and masks are baked into the layer's pixels; other adjustments live only in the composite.
 *
 * Import reads RGB 8-bit files: raw, RLE (PackBits) and ZIP (with/without prediction) channel data,
 * groups, layer masks, clipping, the same native adjustments; anything else arrives as pixels.
 */

const zlib = require('node:zlib');
const { createCanvas } = require('@napi-rs/canvas');
const { assert } = require('./errors');

const BLEND_TO_PSD = {
  'source-over': 'norm', 'pass-through': 'pass', multiply: 'mul ', screen: 'scrn', overlay: 'over', darken: 'dark', lighten: 'lite',
  'color-dodge': 'div ', 'color-burn': 'idiv', 'hard-light': 'hLit', 'soft-light': 'sLit', difference: 'diff', exclusion: 'smud',
  hue: 'hue ', saturation: 'sat ', color: 'colr', luminosity: 'lum ', lighter: 'lddg',
};
const PSD_TO_BLEND = Object.fromEntries(Object.entries(BLEND_TO_PSD).map(([k, v]) => [v, k]));

// ------------------------------------------------------------------ byte writer / reader

class Writer {
  constructor() { this.parts = []; this.length = 0; }
  push(buf) { this.parts.push(buf); this.length += buf.length; return this; }
  u8(v) { const b = Buffer.alloc(1); b.writeUInt8(v & 0xff); return this.push(b); }
  u16(v) { const b = Buffer.alloc(2); b.writeUInt16BE(v & 0xffff); return this.push(b); }
  i16(v) { const b = Buffer.alloc(2); b.writeInt16BE(v); return this.push(b); }
  u32(v) { const b = Buffer.alloc(4); b.writeUInt32BE(v >>> 0); return this.push(b); }
  i32(v) { const b = Buffer.alloc(4); b.writeInt32BE(v | 0); return this.push(b); }
  str(s) { return this.push(Buffer.from(s, 'latin1')); }
  buffer() { return Buffer.concat(this.parts, this.length); }
}

class Reader {
  constructor(buf) { this.b = buf; this.o = 0; }
  need(n) { assert(this.o + n <= this.b.length, 'INVALID_PSD', 'unexpected end of PSD data', { at: this.o, need: n }); }
  u8() { this.need(1); return this.b.readUInt8(this.o++); }
  u16() { this.need(2); const v = this.b.readUInt16BE(this.o); this.o += 2; return v; }
  i16() { this.need(2); const v = this.b.readInt16BE(this.o); this.o += 2; return v; }
  u32() { this.need(4); const v = this.b.readUInt32BE(this.o); this.o += 4; return v; }
  i32() { this.need(4); const v = this.b.readInt32BE(this.o); this.o += 4; return v; }
  str(n) { this.need(n); const v = this.b.toString('latin1', this.o, this.o + n); this.o += n; return v; }
  bytes(n) { this.need(n); const v = this.b.subarray(this.o, this.o + n); this.o += n; return v; }
  skip(n) { this.need(n); this.o += n; }
}

// ------------------------------------------------------------------ PackBits RLE

function packRow(row) {
  const out = [];
  let i = 0;
  while (i < row.length) {
    let run = 1;
    while (i + run < row.length && run < 128 && row[i + run] === row[i]) run += 1;
    if (run >= 2) { out.push(257 - run, row[i]); i += run; continue; }
    const start = i;
    let lit = 0;
    while (i < row.length && lit < 128 && !(i + 1 < row.length && row[i + 1] === row[i])) { i += 1; lit += 1; }
    if (lit === 0) { i += 1; lit = 1; }
    out.push(lit - 1);
    for (let k = start; k < start + lit; k += 1) out.push(row[k]);
  }
  return Buffer.from(out);
}

function unpackRow(src, length) {
  const out = Buffer.alloc(length);
  let i = 0; let o = 0;
  while (o < length && i < src.length) {
    const n = src[i] > 127 ? src[i] - 256 : src[i];
    i += 1;
    if (n >= 0) { src.copy(out, o, i, i + n + 1); i += n + 1; o += n + 1; }
    else if (n !== -128) { out.fill(src[i], o, o + 1 - n); i += 1; o += 1 - n; }
  }
  return out;
}

/** Channel planes (each width*height bytes) → RLE channel blocks (compression + counts + rows). */
function rleChannel(plane, width, height) {
  const rows = [];
  for (let y = 0; y < height; y += 1) rows.push(packRow(plane.subarray(y * width, (y + 1) * width)));
  const w = new Writer().u16(1);
  for (const r of rows) w.u16(r.length);
  for (const r of rows) w.push(r);
  return w.buffer();
}

function planes(rgba, n, count) {
  const out = [];
  for (let c = 0; c < count; c += 1) {
    const plane = Buffer.alloc(n);
    for (let i = 0; i < n; i += 1) plane[i] = rgba[i * 4 + c];
    out.push(plane);
  }
  return out;
}

const pascal = (name, padTo) => {
  const bytes = Buffer.from(String(name).replace(/[^\x20-\x7e]/g, '?').slice(0, 255), 'latin1');
  const total = 1 + bytes.length;
  const padded = Math.ceil(total / padTo) * padTo;
  return Buffer.concat([Buffer.from([bytes.length]), bytes, Buffer.alloc(padded - total)]);
};

function infoBlock(key, data) {
  const pad = data.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0);
  return new Writer().str('8BIM').str(key).u32(data.length + pad.length).push(data).push(pad).buffer();
}

function unicodeName(name) {
  const s = String(name);
  const w = new Writer().u32(s.length);
  for (let i = 0; i < s.length; i += 1) w.u16(s.charCodeAt(i));
  return w.buffer();
}

// ------------------------------------------------------------------ native adjustment data

function adjustmentBlock(adj) {
  const w = new Writer();
  switch (adj.kind) {
    case 'invert': return { key: 'nvrt', data: Buffer.alloc(0) };
    case 'posterize': return { key: 'post', data: w.u16(adj.levels).u16(0).buffer() };
    case 'threshold': return { key: 'thrs', data: w.u16(Math.round(adj.level)).u16(0).buffer() };
    case 'brightnessContrast': return { key: 'brit', data: w.i16(Math.round(adj.brightness * 150)).i16(Math.round(adj.contrast * 100)).i16(127).u8(0).buffer() };
    case 'levels': {
      w.u16(2);
      const rec = (l) => w.u16(l.inBlack).u16(l.inWhite).u16(l.outBlack).u16(l.outWhite).u16(Math.round(l.gamma * 100));
      const def = { inBlack: 0, inWhite: 255, outBlack: 0, outWhite: 255, gamma: 1 };
      rec(adj.rgb || def);
      for (const c of ['r', 'g', 'b']) rec(adj[c] || def);
      for (let i = 4; i < 29; i += 1) rec(def);
      return { key: 'levl', data: w.buffer() };
    }
    case 'curves': {
      const curves = [adj.rgb, adj.r, adj.g, adj.b];
      let bitmap = 0;
      curves.forEach((c, i) => { if (c) bitmap |= 1 << i; });
      w.u8(0).u16(1).u32(bitmap);
      const writePoints = (c) => { w.u16(c.length); for (const [x, y] of c) w.u16(Math.round(y)).u16(Math.round(x)); };
      for (const c of curves) if (c) writePoints(c);
      // Photoshop also requires its extended section: 'Crv ', version 4, then (channel index, points) per curve.
      w.str('Crv ').u16(4).u32(curves.filter(Boolean).length);
      curves.forEach((c, i) => { if (c) { w.u16(i); writePoints(c); } });
      return { key: 'curv', data: w.buffer() };
    }
    case 'hueSaturation': {
      w.u16(2).u8(adj.colorize ? 1 : 0).u8(0);
      w.i16(adj.colorize ? Math.round(adj.colorize.hue > 180 ? adj.colorize.hue - 360 : adj.colorize.hue) : 0).i16(adj.colorize ? Math.round(adj.colorize.saturation * 100) : 0).i16(0);
      w.i16(Math.round(adj.hue)).i16(Math.round(adj.saturation * 100)).i16(Math.round(adj.lightness * 100));
      const ranges = [[315, 345, 15, 45], [15, 45, 75, 105], [75, 105, 135, 165], [135, 165, 195, 225], [195, 225, 255, 285], [255, 285, 315, 345]];
      for (const r of ranges) { for (const v of r) w.u16(v); w.i16(0).i16(0).i16(0); }
      return { key: 'hue2', data: w.buffer() };
    }
    default: return null;
  }
}

function readAdjustment(key, data) {
  const r = new Reader(data);
  switch (key) {
    case 'nvrt': return { kind: 'invert' };
    case 'post': return { kind: 'posterize', levels: Math.max(2, r.u16()) };
    case 'thrs': return { kind: 'threshold', level: r.u16() };
    case 'brit': { const b = r.i16(); const c = r.i16(); return { kind: 'brightnessContrast', brightness: Math.max(-1, Math.min(1, b / 150)), contrast: Math.max(-1, Math.min(0.99, c / 100)) }; }
    case 'levl': {
      r.u16();
      const rec = () => ({ inBlack: r.u16(), inWhite: r.u16(), outBlack: r.u16(), outWhite: r.u16(), gamma: Math.max(0.1, Math.min(9.99, r.u16() / 100)) });
      const out = { kind: 'levels', rgb: rec() };
      const isDefault = (l) => l.inBlack === 0 && l.inWhite === 255 && l.outBlack === 0 && l.outWhite === 255 && l.gamma === 1;
      for (const c of ['r', 'g', 'b']) { const l = rec(); if (!isDefault(l)) out[c] = l; }
      return out;
    }
    case 'curv': {
      r.u8(); r.u16();
      const bitmap = r.u32();
      const out = { kind: 'curves' };
      ['rgb', 'r', 'g', 'b'].forEach((name, i) => {
        if (!(bitmap & (1 << i))) return;
        const n = r.u16();
        const pts = [];
        for (let k = 0; k < n; k += 1) { const y = r.u16(); const x = r.u16(); pts.push([x, y]); }
        out[name] = pts;
      });
      if (!out.rgb) out.rgb = [[0, 0], [255, 255]];
      return out;
    }
    case 'hue2': {
      r.u16();
      const colorize = r.u8(); r.u8();
      const ch = r.i16(); const cs = r.i16(); r.i16();
      const h = r.i16(); const s = r.i16(); const l = r.i16();
      const out = { kind: 'hueSaturation', hue: h, saturation: s / 100, lightness: l / 100 };
      if (colorize) out.colorize = { hue: (ch + 360) % 360, saturation: Math.max(0, Math.min(1, cs / 100)) };
      return out;
    }
    default: return null;
  }
}

// ------------------------------------------------------------------ export

/**
 * Write a PSD. layerPixels(layer) → {canvas, x, y} (the layer's own pixels, document coordinates,
 * cropped) is supplied by the caller (it knows how to render a single layer with its effects).
 */
function writePsd(doc, { composite, layerPixels, iccProfile, background }) {
  const W = doc.canvas.width;
  const H = doc.canvas.height;
  const report = [];
  const records = [];
  const channelData = [];
  const tree = require('./layer-tree');

  const addRecord = (rec) => { records.push(rec); };
  const blendKey = (blend, layer) => {
    const key = BLEND_TO_PSD[blend || 'source-over'];
    if (!key) { report.push({ layerId: layer.id, name: layer.name, loss: `blend mode ${blend} has no PSD equivalent; written as Normal` }); return 'norm'; }
    return key;
  };
  const emptyChannels = () => [-1, 0, 1, 2].map((id) => ({ id, data: Buffer.from([0, 0]) }));

  const visit = (parentId) => {
    for (const layer of tree.childrenOf(doc.layers, parentId)) {
      if (tree.isGroup(layer)) {
        addRecord({ name: '</Layer group>', top: 0, left: 0, bottom: 0, right: 0, channels: emptyChannels(), blend: 'norm', opacity: 255, clipping: 0, hidden: false, section: 3, irrelevant: true });
        visit(layer.id);
        addRecord({ name: layer.name, top: 0, left: 0, bottom: 0, right: 0, channels: emptyChannels(), blend: blendKey(layer.blend, layer), opacity: Math.round(layer.opacity * 255), clipping: 0, hidden: layer.visible === false, section: 1, sectionBlend: blendKey(layer.blend, layer), irrelevant: true });
        const lost = [];
        if (layer.mask || layer.vectorMask) lost.push('group mask not written');
        if (layer.effects && layer.effects.length) lost.push('group effects appear only in the merged composite');
        if (lost.length) report.push({ layerId: layer.id, name: layer.name, as: 'group', loss: lost.join('; ') });
        else report.push({ layerId: layer.id, name: layer.name, as: 'group' });
        continue;
      }
      if (layer.type === 'adjustment') {
        const native = adjustmentBlock(layer.adjustment);
        if (!native) { report.push({ layerId: layer.id, name: layer.name, as: 'composite-only', loss: `${layer.adjustment.kind} adjustment is applied in the composite only (no native PSD block written)` }); continue; }
        addRecord({ name: layer.name, top: 0, left: 0, bottom: 0, right: 0, channels: emptyChannels(), blend: blendKey(layer.blend, layer), opacity: Math.round(layer.opacity * 255), clipping: layer.clipped ? 1 : 0, hidden: layer.visible === false, extraBlocks: [infoBlock(native.key, native.data)] });
        report.push({ layerId: layer.id, name: layer.name, as: `adjustment ${native.key}`, loss: layer.mask || layer.vectorMask ? 'adjustment mask not written' : undefined });
        continue;
      }
      const px = layerPixels(layer);
      const losses = [];
      if (layer.objects.some((o) => o.type === 'text')) losses.push('text written as pixels');
      if (layer.effects && layer.effects.length) losses.push('effects baked into pixels');
      if (layer.filters && layer.filters.length) losses.push('smart filters baked into pixels');
      if (layer.mask || layer.vectorMask) losses.push('mask applied to pixels');
      if (layer.fillOpacity !== undefined) losses.push('fill opacity baked into pixels');
      if (layer.blendIf) losses.push('Blend If not written (it shows only in the merged composite)');
      if (!px) {
        addRecord({ name: layer.name, top: 0, left: 0, bottom: 0, right: 0, channels: emptyChannels(), blend: blendKey(layer.blend, layer), opacity: Math.round(layer.opacity * 255), clipping: layer.clipped ? 1 : 0, hidden: layer.visible === false });
      } else {
        addRecord(pixelRecord(layer.name, px, { blend: blendKey(layer.blend, layer), opacity: Math.round(layer.opacity * 255), clipping: layer.clipped ? 1 : 0, hidden: layer.visible === false }));
      }
      report.push({ layerId: layer.id, name: layer.name, as: 'pixels', loss: losses.length ? losses.join('; ') : undefined });
    }
  };
  const pixelRecord = (name, px, extra) => {
    const { canvas, x, y } = px;
    const w = canvas.width; const h = canvas.height;
    const rgba = canvas.getContext('2d').getImageData(0, 0, w, h).data;
    const [r, g, b, a] = planes(rgba, w * h, 4);
    return Object.assign({ name, top: y, left: x, bottom: y + h, right: x + w,
      channels: [{ id: -1, data: rleChannel(a, w, h) }, { id: 0, data: rleChannel(r, w, h) }, { id: 1, data: rleChannel(g, w, h) }, { id: 2, data: rleChannel(b, w, h) }],
      blend: 'norm', opacity: 255, clipping: 0, hidden: false }, extra || {});
  };
  if (background) { addRecord(pixelRecord('Background', background)); report.push({ name: 'Background', as: 'pixels', loss: 'canvas background written as a pixel layer' }); }
  visit(null);
  if (doc.canvas.effects && doc.canvas.effects.length) report.push({ name: 'canvas', as: 'composite-only', loss: 'canvas effects appear only in the merged composite' });

  // Layer records + channel data.
  const info = new Writer();
  info.i16(-records.length); // negative: the merged image's first alpha channel is its transparency
  for (const rec of records) {
    info.i32(rec.top).i32(rec.left).i32(rec.bottom).i32(rec.right);
    info.u16(rec.channels.length);
    for (const ch of rec.channels) info.i16(ch.id).u32(ch.data.length);
    info.str('8BIM').str(rec.blend).u8(rec.opacity).u8(rec.clipping);
    info.u8((rec.hidden ? 2 : 0) | 8 | (rec.irrelevant ? 16 : 0)).u8(0);
    const extra = new Writer();
    extra.u32(0); // no layer mask data
    extra.u32(0); // no blending ranges
    extra.push(pascal(rec.name, 4));
    extra.push(infoBlock('luni', unicodeName(rec.name)));
    if (rec.section) extra.push(infoBlock('lsct', rec.sectionBlend ? new Writer().u32(rec.section).str('8BIM').str(rec.sectionBlend).buffer() : new Writer().u32(rec.section).buffer()));
    for (const blk of rec.extraBlocks || []) extra.push(blk);
    const extraBuf = extra.buffer();
    info.u32(extraBuf.length).push(extraBuf);
    for (const ch of rec.channels) channelData.push(ch.data);
  }
  for (const d of channelData) info.push(d);
  let infoBuf = info.buffer();
  if (infoBuf.length % 2) infoBuf = Buffer.concat([infoBuf, Buffer.alloc(1)]);
  const layerSection = new Writer().u32(infoBuf.length).push(infoBuf).u32(0).buffer(); // + empty global mask info

  // Merged composite (RGBA, RLE).
  const crgba = composite.getContext('2d').getImageData(0, 0, W, H).data;
  const cplanes = planes(crgba, W * H, 4);
  const merged = new Writer().u16(1);
  const packed = cplanes.map((plane) => { const rows = []; for (let y = 0; y < H; y += 1) rows.push(packRow(plane.subarray(y * W, (y + 1) * W))); return rows; });
  for (const rows of packed) for (const r of rows) merged.u16(r.length);
  for (const rows of packed) for (const r of rows) merged.push(r);

  const out = new Writer();
  out.str('8BPS').u16(1).push(Buffer.alloc(6)).u16(4).u32(H).u32(W).u16(8).u16(3);
  out.u32(0); // colour mode data
  const res = new Writer();
  if (iccProfile) {
    const pad = iccProfile.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0);
    res.str('8BIM').u16(1039).u16(0).u32(iccProfile.length).push(iccProfile).push(pad);
  }
  const resBuf = res.buffer();
  out.u32(resBuf.length).push(resBuf);
  out.u32(layerSection.length).push(layerSection);
  out.push(merged.buffer());
  return { buffer: out.buffer(), report: report.filter((r) => r) };
}

// ------------------------------------------------------------------ import

function readChannel(r, ch, w, h) {
  const start = r.o;
  const end = start + ch.length;
  const n = w * h;
  if (ch.length < 2 || n === 0) { r.o = end; return Buffer.alloc(n); }
  const compression = r.u16();
  let out;
  if (compression === 0) out = Buffer.from(r.bytes(Math.min(n, end - r.o)));
  else if (compression === 1) {
    const counts = []; for (let y = 0; y < h; y += 1) counts.push(r.u16());
    out = Buffer.alloc(n);
    for (let y = 0; y < h; y += 1) unpackRow(r.bytes(counts[y]), w).copy(out, y * w);
  } else if (compression === 2 || compression === 3) {
    out = zlib.inflateSync(r.bytes(end - r.o));
    if (compression === 3) for (let y = 0; y < h; y += 1) for (let x = 1; x < w; x += 1) out[y * w + x] = (out[y * w + x] + out[y * w + x - 1]) & 0xff;
  } else assert(false, 'UNSUPPORTED_PSD', `unknown channel compression ${compression}`);
  r.o = end;
  return out.length === n ? out : Buffer.concat([out, Buffer.alloc(Math.max(0, n - out.length))]).subarray(0, n);
}

/** Parse a PSD into a neutral structure: layers bottom→top with RGBA pixels, groups, masks, adjustments. */
function readPsd(buffer) {
  const r = new Reader(buffer);
  assert(r.str(4) === '8BPS', 'INVALID_PSD', 'not a Photoshop file (missing 8BPS signature)');
  const version = r.u16();
  assert(version === 1, 'UNSUPPORTED_PSD', 'only PSD (version 1) is supported; PSB large documents are not', { version });
  r.skip(6);
  const channels = r.u16(); const height = r.u32(); const width = r.u32(); const depth = r.u16(); const mode = r.u16();
  assert(depth === 8 && mode === 3, 'UNSUPPORTED_PSD', 'only 8-bit RGB PSD files are supported', { depth, colorMode: mode });
  assert(width <= 8192 && height <= 8192, 'UNSUPPORTED_PSD', 'PSD is larger than the 8192 px canvas limit', { width, height });
  r.skip(r.u32()); // colour mode data
  const resEnd = r.u32() + r.o;
  let icc = null;
  while (r.o < resEnd) {
    r.str(4); const id = r.u16();
    const nameLen = r.u8(); r.skip(nameLen + ((nameLen + 1) % 2));
    const size = r.u32();
    if (id === 1039) icc = Buffer.from(r.bytes(size)); else r.skip(size);
    if (size % 2) r.skip(1);
  }
  r.o = resEnd;
  const layers = [];
  const report = [];
  const lmLen = r.u32();
  const lmEnd = r.o + lmLen;
  if (lmLen > 0) {
    const liLen = r.u32();
    const liEnd = r.o + liLen;
    if (liLen > 0) {
      const count = Math.abs(r.i16());
      const recs = [];
      for (let i = 0; i < count; i += 1) {
        const rec = { top: r.i32(), left: r.i32(), bottom: r.i32(), right: r.i32() };
        const n = r.u16();
        rec.channels = [];
        for (let k = 0; k < n; k += 1) rec.channels.push({ id: r.i16(), length: r.u32() });
        r.str(4); rec.blend = r.str(4); rec.opacity = r.u8(); rec.clipping = r.u8(); rec.flags = r.u8(); r.u8();
        const extraEnd = r.u32() + r.o;
        const maskLen = r.u32();
        if (maskLen >= 18) { rec.mask = { top: r.i32(), left: r.i32(), bottom: r.i32(), right: r.i32(), defaultColor: r.u8(), flags: r.u8() }; r.skip(maskLen - 18); } else r.skip(maskLen);
        r.skip(r.u32()); // blending ranges
        const nameLen = r.u8(); rec.name = r.str(nameLen); r.skip((4 - ((nameLen + 1) % 4)) % 4);
        rec.blocks = {};
        while (r.o + 12 <= extraEnd) {
          const sig = r.str(4);
          if (sig !== '8BIM' && sig !== '8B64') break;
          const key = r.str(4); const len = r.u32();
          rec.blocks[key] = Buffer.from(r.bytes(Math.min(len, extraEnd - r.o)));
        }
        r.o = extraEnd;
        if (rec.blocks.luni) { const u = new Reader(rec.blocks.luni); const len = u.u32(); let s = ''; for (let k = 0; k < len && u.o + 2 <= rec.blocks.luni.length; k += 1) s += String.fromCharCode(u.u16()); rec.name = s.replace(/\0+$/, ''); }
        recs.push(rec);
      }
      for (const rec of recs) {
        const w = Math.max(0, rec.right - rec.left); const h = Math.max(0, rec.bottom - rec.top);
        rec.data = {};
        for (const ch of rec.channels) {
          if (ch.id === -2 && rec.mask) rec.data[-2] = readChannel(r, ch, Math.max(0, rec.mask.right - rec.mask.left), Math.max(0, rec.mask.bottom - rec.mask.top));
          else rec.data[ch.id] = readChannel(r, ch, w, h);
        }
      }
      r.o = liEnd;
      // Bottom → top; section dividers open groups, folder records close them.
      const stack = [];
      let gid = 0;
      for (const rec of recs) {
        const section = rec.blocks.lsct ? rec.blocks.lsct.readUInt32BE(0) : 0;
        if (section === 3) { stack.push({ children: [] , id: `g${gid += 1}` }); continue; }
        const parent = stack.length ? stack[stack.length - 1] : null;
        const base = { name: rec.name, opacity: rec.opacity / 255, visible: !(rec.flags & 2), clipped: rec.clipping === 1, parent: parent ? parent.id : null };
        if (section === 1 || section === 2) {
          const group = stack.pop() || { id: `g${gid += 1}` };
          const sectionBlend = rec.blocks.lsct.length >= 12 ? rec.blocks.lsct.toString('latin1', 8, 12) : rec.blend;
          const top = stack.length ? stack[stack.length - 1] : null;
          layers.push(Object.assign(base, { kind: 'group', id: group.id, parent: top ? top.id : null, blend: PSD_TO_BLEND[sectionBlend] || 'pass-through' }));
          continue;
        }
        const adjKey = ['nvrt', 'post', 'thrs', 'brit', 'levl', 'curv', 'hue2'].find((k) => rec.blocks[k]);
        if (adjKey) {
          layers.push(Object.assign(base, { kind: 'adjustment', blend: PSD_TO_BLEND[rec.blend] || 'source-over', adjustment: readAdjustment(adjKey, rec.blocks[adjKey]) }));
          continue;
        }
        const unknownAdj = ['selc', 'mixr', 'blnc', 'grdm', 'phfl', 'expA', 'vibA', 'blwh', 'clrL'].find((k) => rec.blocks[k]);
        if (unknownAdj) { report.push({ name: rec.name, loss: `adjustment layer ${unknownAdj} is not supported; skipped` }); continue; }
        const w = Math.max(0, rec.right - rec.left); const h = Math.max(0, rec.bottom - rec.top);
        const rgba = Buffer.alloc(w * h * 4);
        for (let i = 0; i < w * h; i += 1) {
          rgba[i * 4] = rec.data[0] ? rec.data[0][i] : 0; rgba[i * 4 + 1] = rec.data[1] ? rec.data[1][i] : 0;
          rgba[i * 4 + 2] = rec.data[2] ? rec.data[2][i] : 0; rgba[i * 4 + 3] = rec.data[-1] ? rec.data[-1][i] : 255;
        }
        const layer = Object.assign(base, { kind: 'pixels', blend: PSD_TO_BLEND[rec.blend] || 'source-over', x: rec.left, y: rec.top, width: w, height: h, rgba });
        if (!PSD_TO_BLEND[rec.blend]) report.push({ name: rec.name, loss: `blend mode "${rec.blend}" is not supported; imported as Normal` });
        if (rec.blocks.TySh) report.push({ name: rec.name, loss: 'text layer imported as pixels' });
        if (rec.blocks.SoLd || rec.blocks.PlLd) report.push({ name: rec.name, loss: 'smart object imported as pixels' });
        if (rec.blocks.lfx2 || rec.blocks.lrFX) report.push({ name: rec.name, loss: 'layer effects are not imported (pixels only)' });
        if (rec.mask && rec.data[-2]) layer.mask = { x: rec.mask.left, y: rec.mask.top, width: rec.mask.right - rec.mask.left, height: rec.mask.bottom - rec.mask.top, defaultColor: rec.mask.defaultColor, values: rec.data[-2], disabled: Boolean(rec.mask.flags & 2) };
        layers.push(layer);
      }
    }
  }
  r.o = lmEnd;
  // Merged composite (used when there are no layers).
  let merged = null;
  if (!layers.length && r.o < buffer.length) {
    const compression = r.u16();
    const n = width * height;
    const chans = [];
    if (compression === 1) {
      const counts = []; for (let i = 0; i < channels * height; i += 1) counts.push(r.u16());
      for (let c = 0; c < channels; c += 1) { const plane = Buffer.alloc(n); for (let y = 0; y < height; y += 1) unpackRow(r.bytes(counts[c * height + y]), width).copy(plane, y * width); chans.push(plane); }
    } else if (compression === 0) for (let c = 0; c < channels; c += 1) chans.push(Buffer.from(r.bytes(n)));
    else assert(false, 'UNSUPPORTED_PSD', 'compressed merged image without layers is not supported');
    merged = Buffer.alloc(n * 4);
    for (let i = 0; i < n; i += 1) { merged[i * 4] = chans[0][i]; merged[i * 4 + 1] = chans[1][i]; merged[i * 4 + 2] = chans[2][i]; merged[i * 4 + 3] = chans[3] ? chans[3][i] : 255; }
  }
  return { width, height, icc, layers, merged, report };
}

module.exports = { writePsd, readPsd, packRow, unpackRow, BLEND_TO_PSD };
