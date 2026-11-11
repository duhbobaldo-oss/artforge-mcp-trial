'use strict';

const { deflateSync } = require('node:zlib');
const table = Uint32Array.from({ length: 256 }, (_, n) => {
  for (let k = 0; k < 8; k += 1) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});
function chunk(type, data) {
  const bytes = Buffer.alloc(data.length + 12);
  bytes.writeUInt32BE(data.length);
  bytes.write(type, 4, 4, 'ascii');
  data.copy(bytes, 8);
  let crc = 0xffffffff;
  for (let i = 4; i < bytes.length - 4; i += 1) crc = table[(crc ^ bytes[i]) & 255] ^ (crc >>> 8);
  bytes.writeUInt32BE((crc ^ 0xffffffff) >>> 0, bytes.length - 4);
  return bytes;
}

/** Lossless RGBA PNG: low-latency compression for local delivery, no quantisation. */
function encodePng(canvas) {
  const { width, height } = canvas;
  // Keep large existing exports on the native encoder rather than allocate extra full RGBA rows.
  if (width * height > 16000000) return canvas.toBuffer('image/png');
  const pixels = canvas.getContext('2d').getImageData(0, 0, width, height).data;
  const stride = width * 4;
  const rows = Buffer.allocUnsafe((stride + 1) * height);
  const source = Buffer.from(pixels.buffer, pixels.byteOffset, pixels.byteLength);
  for (let y = 0; y < height; y += 1) {
    const start = y * (stride + 1);
    rows[start] = 0; // PNG filter None; zlib still compresses runs without costly adaptive filtering.
    source.copy(rows, start + 1, y * stride, (y + 1) * stride);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6; // RGBA, 8-bit channels.
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', deflateSync(rows, { level: 1 })), chunk('IEND', Buffer.alloc(0))]);
}
module.exports = { encodePng };