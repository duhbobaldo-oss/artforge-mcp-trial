'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { error } = require('./generation-spec');

// Owner-only maintenance, never exposed to MCP. Does not delete or rewrite the job database.
function recoverGenerationLock(dir) {
  const lock = path.join(path.resolve(dir), 'coordinator.lock');
  const guard = lock + '.recovery';
  let fd;
  try { fd = fs.openSync(guard, 'wx'); } catch { throw error('GENERATION_STORE_LOCKED'); }
  try {
    const record = fs.readFileSync(lock, 'utf8'), pid = Number(record);
    if (!Number.isSafeInteger(pid) || pid < 1) throw error('GENERATION_STORE_LOCKED');
    try { process.kill(pid, 0); throw error('GENERATION_STORE_LOCKED'); }
    catch (e) { if (e.code !== 'ESRCH') throw e; }
    if (fs.readFileSync(lock, 'utf8') !== record) throw error('GENERATION_STORE_LOCKED');
    fs.unlinkSync(lock);
    return { recovered: true, databasePreserved: true };
  } finally { fs.closeSync(fd); fs.unlinkSync(guard); }
}
module.exports = { recoverGenerationLock };
