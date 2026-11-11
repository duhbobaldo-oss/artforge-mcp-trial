'use strict';

/**
 * ICC colour management for RGB working spaces: sRGB, Display P3, Adobe RGB (1998).
 *
 * All three are matrix/TRC profiles, so conversions are exact math (no LUT approximations):
 * encoded RGB → linear (tone curve) → XYZ (D50, Bradford-adapted primaries) → target linear → encoded.
 * `iccProfile(name)` builds a standard ICC v2.1 display profile (header, tag table, desc, cprt, wtpt,
 * rXYZ/gXYZ/bXYZ, rTRC/gTRC/bTRC) that other software (Photoshop, LittleCMS) reads natively.
 */

const { assert } = require('./errors');

const D50 = [0.9642, 1.0, 0.8249];

// Primaries are derived from each standard's published chromaticities (white D65), then adapted to the
// ICC D50 connection space with the Bradford transform — no hand-copied matrices.
const CHROMATICITIES = {
  srgb: { label: 'sRGB IEC61966-2.1', xy: [[0.64, 0.33], [0.30, 0.60], [0.15, 0.06]], trc: 'srgb' },
  'display-p3': { label: 'Display P3', xy: [[0.680, 0.320], [0.265, 0.690], [0.150, 0.060]], trc: 'srgb' },
  'adobe-rgb': { label: 'Adobe RGB (1998)', xy: [[0.64, 0.33], [0.21, 0.71], [0.15, 0.06]], trc: 563 / 256 },
};
const D65_XYZ = [0.95047, 1.0, 1.08883];
const D50_XYZ = [0.96422, 1.0, 0.82521];
const BRADFORD = [[0.8951, 0.2664, -0.1614], [-0.7502, 1.7135, 0.0367], [0.0389, -0.0685, 1.0296]];

function primariesD50(xy) {
  const cols = xy.map(([x, y]) => [x / y, 1, (1 - x - y) / y]);
  const P = [[cols[0][0], cols[1][0], cols[2][0]], [cols[0][1], cols[1][1], cols[2][1]], [cols[0][2], cols[1][2], cols[2][2]]];
  const S = mul3(invert3(P), D65_XYZ);
  const M = P.map((row) => row.map((v, j) => v * S[j]));
  const src = mul3(BRADFORD, D65_XYZ);
  const dst = mul3(BRADFORD, D50_XYZ);
  const adapt = mulMat(invert3(BRADFORD), mulMat([[dst[0] / src[0], 0, 0], [0, dst[1] / src[1], 0], [0, 0, dst[2] / src[2]]], BRADFORD));
  const A = mulMat(adapt, M);
  return [0, 1, 2].map((j) => [A[0][j], A[1][j], A[2][j]]); // columns = adapted primaries
}

const PROFILES = {};


function requireProfile(name) {
  assert(Object.prototype.hasOwnProperty.call(PROFILES, name), 'INVALID_COLOR_PROFILE', `colour profile must be one of ${NAMES.join(', ')}`, { received: name });
  return PROFILES[name];
}

const decode = (trc, v) => (trc === 'srgb' ? (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)) : Math.pow(v, trc));
const encode = (trc, v) => {
  const x = v < 0 ? 0 : v > 1 ? 1 : v;
  return trc === 'srgb' ? (x <= 0.0031308 ? x * 12.92 : 1.055 * Math.pow(x, 1 / 2.4) - 0.055) : Math.pow(x, 1 / trc);
};

// RGB→XYZ matrix (rows X, Y, Z) from primaries given as columns.
const toXyz = (p) => [[p[0][0], p[1][0], p[2][0]], [p[0][1], p[1][1], p[2][1]], [p[0][2], p[1][2], p[2][2]]];
function invert3(m) {
  const [a, b, c] = m[0]; const [d, e, f] = m[1]; const [g, h, i] = m[2];
  const A = e * i - f * h; const B = -(d * i - f * g); const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  return [[A / det, -(b * i - c * h) / det, (b * f - c * e) / det], [B / det, (a * i - c * g) / det, -(a * f - c * d) / det], [C / det, -(a * h - b * g) / det, (a * e - b * d) / det]];
}
const mul3 = (m, v) => [m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2], m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2], m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2]];
const mulMat = (a, b) => a.map((row) => [0, 1, 2].map((j) => row[0] * b[0][j] + row[1] * b[1][j] + row[2] * b[2][j]));

for (const [name, c] of Object.entries(CHROMATICITIES)) PROFILES[name] = { label: c.label, primaries: primariesD50(c.xy), trc: c.trc };
const NAMES = Object.keys(PROFILES);

/** Convert RGBA pixel data (Uint8ClampedArray) in place from one profile to another (absolute = relative colorimetric, D50). */
function convertPixels(data, from, to) {
  if (from === to) return data;
  const src = requireProfile(from);
  const dst = requireProfile(to);
  const m = mulMat(invert3(toXyz(dst.primaries)), toXyz(src.primaries));
  const lut = new Float64Array(256);
  for (let i = 0; i < 256; i += 1) lut[i] = decode(src.trc, i / 255);
  for (let p = 0; p < data.length; p += 4) {
    const lin = mul3(m, [lut[data[p]], lut[data[p + 1]], lut[data[p + 2]]]);
    data[p] = Math.round(encode(dst.trc, lin[0]) * 255);
    data[p + 1] = Math.round(encode(dst.trc, lin[1]) * 255);
    data[p + 2] = Math.round(encode(dst.trc, lin[2]) * 255);
  }
  return data;
}

// ------------------------------------------------------------------ ICC v2 profile writer

const s15 = (v) => { const b = Buffer.alloc(4); b.writeInt32BE(Math.round(v * 65536), 0); return b; };
const pad4 = (b) => (b.length % 4 ? Buffer.concat([b, Buffer.alloc(4 - (b.length % 4))]) : b);
const xyzTag = (xyz) => Buffer.concat([Buffer.from('XYZ '), Buffer.alloc(4), s15(xyz[0]), s15(xyz[1]), s15(xyz[2])]);
function descTag(text) {
  const ascii = Buffer.from(`${text}\0`, 'latin1');
  const head = Buffer.alloc(12); head.write('desc', 0, 'latin1'); head.writeUInt32BE(ascii.length, 8);
  // ASCII description, empty Unicode part (language 0, count 0), empty ScriptCode part (code 0, count 0, 67 bytes).
  return Buffer.concat([head, ascii, Buffer.alloc(8), Buffer.alloc(3 + 67)]);
}
const textTag = (text) => Buffer.concat([Buffer.from('text'), Buffer.alloc(4), Buffer.from(`${text}\0`, 'latin1')]);
function curvTag(trc) {
  if (trc !== 'srgb') {
    const b = Buffer.alloc(14); b.write('curv', 0, 'latin1'); b.writeUInt32BE(1, 8); b.writeUInt16BE(Math.round(trc * 256), 12);
    return b;
  }
  const n = 1024;
  const b = Buffer.alloc(12 + n * 2); b.write('curv', 0, 'latin1'); b.writeUInt32BE(n, 8);
  for (let i = 0; i < n; i += 1) b.writeUInt16BE(Math.round(decode('srgb', i / (n - 1)) * 65535), 12 + i * 2);
  return b;
}

const cache = new Map();
/** A standard ICC v2.1 RGB display profile for `name`. */
function iccProfile(name) {
  if (cache.has(name)) return cache.get(name);
  const p = requireProfile(name);
  const trc = curvTag(p.trc);
  const tags = [
    ['desc', descTag(p.label)], ['cprt', textTag('No copyright, use freely')], ['wtpt', xyzTag(D50)],
    ['rXYZ', xyzTag(p.primaries[0])], ['gXYZ', xyzTag(p.primaries[1])], ['bXYZ', xyzTag(p.primaries[2])],
    ['rTRC', trc], ['gTRC', trc], ['bTRC', trc],
  ];
  const tableSize = 4 + tags.length * 12;
  let offset = 128 + tableSize;
  const table = Buffer.alloc(tableSize);
  table.writeUInt32BE(tags.length, 0);
  const bodies = [];
  const placed = new Map();
  tags.forEach(([sig, data], i) => {
    let at = placed.get(data);
    if (at === undefined) { at = offset; placed.set(data, at); const padded = pad4(data); bodies.push(padded); offset += padded.length; }
    table.write(sig, 4 + i * 12, 'latin1');
    table.writeUInt32BE(at, 8 + i * 12);
    table.writeUInt32BE(data.length, 12 + i * 12);
  });
  const header = Buffer.alloc(128);
  header.writeUInt32BE(offset, 0);
  header.write('lcms', 4, 'latin1');
  header.writeUInt32BE(0x02100000, 8); // version 2.1
  header.write('mntr', 12, 'latin1');
  header.write('RGB ', 16, 'latin1');
  header.write('XYZ ', 20, 'latin1');
  header.writeUInt16BE(2026, 24); header.writeUInt16BE(1, 26); header.writeUInt16BE(1, 28);
  header.write('acsp', 36, 'latin1');
  header.writeUInt32BE(0, 64); // rendering intent: perceptual
  s15(D50[0]).copy(header, 68); s15(D50[1]).copy(header, 72); s15(D50[2]).copy(header, 76);
  header.write('afrg', 80, 'latin1');
  const profile = Buffer.concat([header, table, ...bodies]);
  cache.set(name, profile);
  return profile;
}

// ------------------------------------------------------------------ embedding

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i += 1) { c ^= buf[i]; for (let k = 0; k < 8; k += 1) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); }
  return (~c) >>> 0;
}

/** PNG with an iCCP chunk (after IHDR) carrying `name`'s profile. */
function embedPng(png, name) {
  const zlib = require('node:zlib');
  const label = Buffer.from(requireProfile(name).label.slice(0, 79), 'latin1');
  const data = Buffer.concat([label, Buffer.from([0, 0]), zlib.deflateSync(iccProfile(name))]);
  const type = Buffer.from('iCCP', 'latin1');
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([type, data])), 0);
  const ihdrEnd = 8 + 4 + 4 + 13 + 4;
  return Buffer.concat([png.subarray(0, ihdrEnd), len, type, data, crc, png.subarray(ihdrEnd)]);
}

/** JPEG with an APP2 ICC_PROFILE segment (after SOI). */
function embedJpeg(jpeg, name) {
  const profile = iccProfile(name);
  const body = Buffer.concat([Buffer.from('ICC_PROFILE ', 'latin1'), Buffer.from([1, 1]), profile]);
  const head = Buffer.from([0xff, 0xe2, 0, 0]);
  head.writeUInt16BE(body.length + 2, 2);
  return Buffer.concat([jpeg.subarray(0, 2), head, body, jpeg.subarray(2)]);
}

/** Name an embedded ICC profile: {name, label} where name is a known profile or null. Matches primaries, not just text. */
function identifyProfile(icc) {
  if (!icc || icc.length < 132) return { name: null, label: null };
  let label = null;
  const tags = {};
  const count = icc.readUInt32BE(128);
  for (let i = 0; i < count && 132 + i * 12 + 12 <= icc.length; i += 1) {
    const at = 132 + i * 12;
    tags[icc.toString('latin1', at, at + 4)] = { offset: icc.readUInt32BE(at + 4), size: icc.readUInt32BE(at + 8) };
  }
  const t = tags.desc;
  if (t && t.offset + 12 <= icc.length) {
    const type = icc.toString('latin1', t.offset, t.offset + 4);
    if (type === 'desc') label = icc.toString('latin1', t.offset + 12, Math.min(icc.length, t.offset + 12 + icc.readUInt32BE(t.offset + 8))).replace(/\0+$/, '');
    else if (type === 'mluc' && t.offset + 28 <= icc.length) {
      const len = icc.readUInt32BE(t.offset + 20); const off = icc.readUInt32BE(t.offset + 24);
      let s = ''; for (let k = 0; k + 1 < len && t.offset + off + k + 1 < icc.length; k += 2) s += String.fromCharCode(icc.readUInt16BE(t.offset + off + k));
      label = s.replace(/\0+$/, '');
    }
  }
  const xyz = (sig) => { const e = tags[sig]; if (!e || e.offset + 20 > icc.length) return null; return [0, 1, 2].map((k) => icc.readInt32BE(e.offset + 8 + k * 4) / 65536); };
  const prim = ['rXYZ', 'gXYZ', 'bXYZ'].map(xyz);
  if (prim.every(Boolean)) {
    for (const [name, p] of Object.entries(PROFILES)) {
      const close = p.primaries.every((col, i) => col.every((v, k) => Math.abs(v - prim[i][k]) < 0.003));
      if (close) return { name, label: label || p.label };
    }
  }
  return { name: null, label };
}

module.exports = { NAMES, PROFILES, requireProfile, convertPixels, iccProfile, embedPng, embedJpeg, identifyProfile };
