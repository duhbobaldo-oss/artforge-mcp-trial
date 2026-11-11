'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const sourceRoot = path.resolve(__dirname, '..');
const hash = crypto.createHash('sha256');
function visit(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) visit(file);
    else if (entry.name.endsWith('.js')) hash.update(path.relative(sourceRoot, file).replace(/\\/g, '/')).update('\0').update(fs.readFileSync(file)).update('\0');
  }
}
visit(sourceRoot);
const packageFile = path.resolve(sourceRoot, '..', 'package.json');
hash.update(fs.readFileSync(packageFile));
module.exports = Object.freeze({ version: JSON.parse(fs.readFileSync(packageFile, 'utf8')).version, sourceSha256: hash.digest('hex') });
