'use strict';

const fs = require('node:fs');
const path = require('node:path');

/** Core modules shared by the Node renderer and the browser live view. */
const BROWSER_MODULES = ['errors', 'effects', 'mesh-gradient', 'material', 'lighting', 'paint', 'animation', 'text', 'brush', 'layer-tree', 'distance', 'layer-styles', 'coverage', 'path-edit', 'shapes', 'adjustments', 'renderer'];

/**
 * Build a tiny CommonJS bundle so the browser renders documents with exactly the
 * same renderer source used by the Node exporter.
 */
function buildCoreBundle(coreDir) {
  let out = '(function(){\n';
  out += 'var __mods = {}, __cache = {};\n';
  out += 'function __req(name){ if(__cache[name]) return __cache[name].exports; ';
  out += 'var def = __mods[name]; if(!def) throw new Error("core module not found: " + name); ';
  out += 'var module = { exports: {} }; __cache[name] = module; def.fn(module, __req); return module.exports; }\n';
  for (const name of BROWSER_MODULES) {
    const file = path.join(coreDir, `${name}.js`);
    const source = fs.readFileSync(file, 'utf8').replace(/require\('\.\/([A-Za-z0-9_-]+)'\)/g, "require('$1')");
    out += `__mods['${name}'] = { fn: function(module, require){\n${source}\n} };\n`;
  }
  out += 'window.ArtForgeCore = {';
  out += '  renderer: __req("renderer"), paint: __req("paint"), animation: __req("animation"),';
  out += '  text: __req("text"), errors: __req("errors"), pathEdit: __req("path-edit"), layerTree: __req("layer-tree"), shapes: __req("shapes")';
  out += ' };\n})();\n';
  return out;
}

module.exports = { buildCoreBundle, BROWSER_MODULES };
