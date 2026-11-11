'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { DocumentStore } = require('./core/store');
const { AssetStore } = require('./core/assets');
const { registerBundledFonts, listFonts, describeFonts } = require('./core/fonts');
const { runOp, listOps, OP_DESCRIPTIONS, VERSION } = require('./core/ops');

/**
 * Create a fully wired engine instance (store + assets + fonts + operations).
 * Every operation receives this context.
 */
function createEngine(options) {
  const opts = options || {};
  const root = path.resolve(opts.root || path.join(__dirname, '..'));
  const dataDir = path.join(root, 'data');
  const docsDir = opts.docsDir ? path.resolve(opts.docsDir) : path.join(dataDir, 'documents');
  const assetsDir = opts.assetsDir ? path.resolve(opts.assetsDir) : path.join(dataDir, 'assets');
  const exportsDir = opts.exportsDir ? path.resolve(opts.exportsDir) : path.join(dataDir, 'exports');
  const fontsDir = path.join(root, 'fonts');
  for (const dir of [dataDir, docsDir, assetsDir, exportsDir]) fs.mkdirSync(dir, { recursive: true });
  registerBundledFonts(fontsDir);
  const store = new DocumentStore({ docsDir });
  const assets = new AssetStore(assetsDir);
  const ctx = {
    root,
    workspaceRoot: opts.workspaceRoot ? path.resolve(opts.workspaceRoot) : path.resolve(root, '..'),
    dataDir,
    docsDir,
    assetsDir,
    exportsDir,
    fontsDir,
    store,
    assets,
  };
  return {
    version: VERSION,
    ctx,
    store,
    assets,
    run: (op, params) => runOp(op, params, ctx),
    listOps: () => listOps(),
    describe: (op) => OP_DESCRIPTIONS[op] || '',
    fonts: () => listFonts(fontsDir),
    fontsSummary: () => describeFonts(fontsDir),
  };
}

module.exports = { createEngine };
