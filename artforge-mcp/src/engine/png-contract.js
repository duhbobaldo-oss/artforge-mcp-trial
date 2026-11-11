'use strict';
const { inflateSync } = require('node:zlib');
const table = Array.from({ length: 256 }, (_, n) => {
  for (let bit = 0; bit < 8; bit++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = table[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
// Deliberately narrow contract: non-interlaced, 8-bit grayscale/RGB/gray-alpha/RGBA PNG.
// Validate compressed data and scanline bounds before an image reaches any native decoder.
function validatePng(bytes, expected) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 45 || bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw Error('Invalid PNG');
  let offset = 8, ended = false, header, idatEnded = false;
  const compressed = [];
  while (offset < bytes.length) {
    if (offset + 12 > bytes.length) throw Error('Truncated chunk');
    const length = bytes.readUInt32BE(offset);
    if (length > bytes.length - offset - 12) throw Error('Truncated chunk');
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    if (crc32(bytes.subarray(offset + 4, offset + 8 + length)) !== bytes.readUInt32BE(offset + 8 + length)) throw Error('PNG checksum');
    if (!header && type !== 'IHDR') throw Error('Missing IHDR');
    if (type === 'IHDR') {
      if (header || length !== 13) throw Error('Invalid IHDR');
      header = bytes.subarray(offset + 8, offset + 21);
      if (header.readUInt32BE(0) !== expected.width || header.readUInt32BE(4) !== expected.height
        || header[8] !== 8 || ![0, 2, 4, 6].includes(header[9]) || header[10] || header[11] || header[12]) throw Error('Unsupported PNG format');
    } else if (type === 'IDAT') {
      if (idatEnded) throw Error('Non-contiguous image data');
      compressed.push(bytes.subarray(offset + 8, offset + 8 + length));
    } else {
      if (compressed.length) idatEnded = true;
      if (type === 'IEND') { if (length !== 0) throw Error('Invalid IEND'); ended = true; }
      else if (/^[A-Z]/.test(type) && type !== 'PLTE') throw Error('Unknown critical chunk');
    }
    offset += length + 12;
    if (ended) break;
  }
  if (!ended || offset !== bytes.length || !compressed.length) throw Error('Incomplete PNG');
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[header[9]];
  const rowBytes = expected.width * channels + 1;
  const size = rowBytes * expected.height;
  const pixels = inflateSync(Buffer.concat(compressed), { maxOutputLength: size });
  if (pixels.length !== size) throw Error('Incorrect pixel data size');
  for (let i = 0; i < size; i += rowBytes) if (pixels[i] > 4) throw Error('Invalid PNG filter');
}
module.exports = { validatePng };
