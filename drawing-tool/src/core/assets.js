'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { loadImage, createCanvas } = require('@napi-rs/canvas');
const { assert, fail } = require('./errors');
const { makeId } = require('./ids');

const ALLOWED_EXT = ['.png', '.jpg', '.jpeg', '.webp'];
const MAX_ASSET_BYTES = 25 * 1024 * 1024;

/** Image assets stored on disk, referenced by document image objects. */
class AssetStore {
  constructor(assetsDir) {
    this.dir = assetsDir;
    this.indexPath = path.join(assetsDir, 'index.json');
    fs.mkdirSync(this.dir, { recursive: true });
    this.index = this.readIndex();
    this.imageCache = new Map();
    const importedFonts=path.join(this.dir,'bundle-fonts');
    if(fs.existsSync(importedFonts))for(const name of fs.readdirSync(importedFonts))if(/^[A-Za-z]+-(Regular|Bold)\.ttf$/.test(name))require('@napi-rs/canvas').GlobalFonts.registerFromPath(path.join(importedFonts,name),name.split('-')[0]);
  }

  readIndex() {
    try {
      return JSON.parse(fs.readFileSync(this.indexPath, 'utf8'));
    } catch {
      return { assets: {} };
    }
  }

  writeIndex() {
    fs.writeFileSync(this.indexPath, JSON.stringify(this.index, null, 2), 'utf8');
  }

  registerBuffer(buffer, extension, options) {
    const opts = options || {};
    const ext = String(extension || '').toLowerCase();
    assert(ALLOWED_EXT.includes(ext), 'INVALID_ASSET_TYPE',
      `unsupported image extension "${ext}"; allowed: ${ALLOWED_EXT.join(', ')}`);
    assert(buffer && buffer.length > 0, 'EMPTY_ASSET', 'image data is empty');
    assert(buffer.length <= MAX_ASSET_BYTES, 'ASSET_TOO_LARGE',
      `image is larger than ${MAX_ASSET_BYTES} bytes`, { bytes: buffer.length });
    const id = opts.id || makeId('asset');
    assert(/^asset_[A-Za-z0-9_-]+$/.test(id),'INVALID_ASSET_ID','Asset identifier must be a safe asset token');
    const fileName = `${id}${ext}`;
    fs.writeFileSync(path.join(this.dir, fileName), buffer);
    const record = {
      id,
      file: fileName,
      name: opts.name ? String(opts.name) : fileName,
      bytes: buffer.length,
      sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
      createdAt: new Date().toISOString(),
    };
    this.index.assets[id] = record;
    this.writeIndex();
    return record;
  }

  async addFromFile(filePath, options) {
    assert(typeof filePath === 'string' && filePath.length > 0, 'INVALID_PATH', 'path is required');
    const resolved = path.resolve(filePath);
    assert(fs.existsSync(resolved), 'ASSET_NOT_FOUND', `file not found: ${resolved}`);
    assert(fs.statSync(resolved).isFile(), 'INVALID_PATH', `not a file: ${resolved}`);
    const record = this.registerBuffer(fs.readFileSync(resolved), path.extname(resolved), options);
    return Object.assign({}, record, await this.inspect(record.id));
  }

  async addFromDataUrl(dataUrl, options) {
    const match = /^data:image\/(png|jpeg|jpg|webp);base64,([A-Za-z0-9+/=\s]+)$/i.exec(String(dataUrl || '').trim());
    assert(match, 'INVALID_DATA_URL', 'dataUrl must be a base64 image/png, image/jpeg or image/webp data URL');
    const ext = match[1].toLowerCase().replace('jpeg', 'jpg');
    const record = this.registerBuffer(Buffer.from(match[2].replace(/\s/g, ''), 'base64'), `.${ext}`, options);
    return Object.assign({}, record, await this.inspect(record.id));
  }

  list() {
    return Object.values(this.index.assets).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  get(id) {
    const record = this.index.assets[id];
    if (!record) fail('ASSET_NOT_FOUND', `asset not found: ${id}`);
    return record;
  }

  pathOf(id) {
    return path.join(this.dir, this.get(id).file);
  }

  async inspect(id) {
    const record = this.get(id);
    const image = await this.load(id);
    return { width: image.width, height: image.height, file: record.file };
  }

  async load(id) {
    if (this.imageCache.has(id)) return this.imageCache.get(id);
    const record = this.get(id);
    const filePath = path.join(this.dir, record.file);
    if (!fs.existsSync(filePath)) fail('ASSET_FILE_MISSING', `asset file missing on disk: ${record.file}`);
    const image = await loadImage(filePath);
    this.imageCache.set(id, image);
    return image;
  }

  /** Load every image referenced by a document (used before rendering). */
  async loadForDocument(doc) {
    const ids = new Set();
    for (const layer of doc.layers) {
      for (const object of layer.objects) {
        if (object.type === 'image' && object.assetId) ids.add(object.assetId);
      }
    }
    // Pixel layer tiles (content-addressed PNGs) join the same image map, keyed "tile:<sha256>".
    const images = await require('./raster').loadTiles(require('./raster').tileStore({ assets: this }), doc);
    for (const id of ids) {
      try {
        images[id] = await this.load(id);
      } catch {
        // Missing assets are reported by the renderer as warnings.
      }
    }
    return images;
  }

  remove(id) {
    const record = this.get(id);
    const filePath = path.join(this.dir, record.file);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    delete this.index.assets[id];
    this.imageCache.delete(id);
    this.writeIndex();
    return { removed: id };
  }

  /** Dominant colour extraction (palettes for tooling and the MCP reference engine). */
  async palette(id, count) {
    const image = await this.load(id);
    const width = Math.min(160, image.width);
    const height = Math.min(160, image.height);
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(image, 0, 0, width, height);
    const data = ctx.getImageData(0, 0, width, height).data;
    const buckets = new Map();
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] < 16) continue;
      const key = `${data[i] >> 4}-${data[i + 1] >> 4}-${data[i + 2] >> 4}`;
      const entry = buckets.get(key) || { r: 0, g: 0, b: 0, n: 0 };
      entry.r += data[i];
      entry.g += data[i + 1];
      entry.b += data[i + 2];
      entry.n += 1;
      buckets.set(key, entry);
    }
    const sorted = Array.from(buckets.values()).sort((a, b) => b.n - a.n);
    const limit = Math.max(1, Math.min(16, Number(count) || 6));
    const total = sorted.reduce((sum, e) => sum + e.n, 0) || 1;
    return sorted.slice(0, limit).map((entry) => {
      const r = Math.round(entry.r / entry.n);
      const g = Math.round(entry.g / entry.n);
      const b = Math.round(entry.b / entry.n);
      return {
        hex: `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`,
        rgb: [r, g, b],
        share: Number((entry.n / total).toFixed(4)),
      };
    });
  }
}

module.exports = { AssetStore, ALLOWED_EXT, MAX_ASSET_BYTES };
