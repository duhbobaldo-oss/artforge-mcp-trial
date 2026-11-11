'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * سجل JSONL صغير بلا اعتماديات، مع تدوير بالحجم.
 * الغرض: أن يكون لكل انقطاع أثر مكتوب (من بدأ، من انتهى، وبأي رمز خروج).
 */
const MAX_BYTES = Number(process.env.ARTFORGE_LOG_MAX_BYTES || 5 * 1024 * 1024);
const KEEP = 3;

function resolveLogDir(explicit) {
  const dir = explicit || process.env.ARTFORGE_LOG_DIR || path.join(process.cwd(), 'logs');
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
  return dir;
}

function rotate(file) {
  try {
    const stat = fs.statSync(file);
    if (stat.size < MAX_BYTES) return;
    for (let index = KEEP - 1; index >= 1; index -= 1) {
      const from = `${file}.${index}`;
      const to = `${file}.${index + 1}`;
      if (fs.existsSync(from)) {
        try { fs.renameSync(from, to); } catch { /* ignore */ }
      }
    }
    try { fs.renameSync(file, `${file}.1`); } catch { /* ignore */ }
  } catch { /* ignore */ }
}

function createLogger(name, options) {
  const opts = options || {};
  const dir = resolveLogDir(opts.dir);
  const file = path.join(dir, `${name}.jsonl`);
  let broken = false;

  const write = (level, event, detail) => {
    const record = {
      at: new Date().toISOString(),
      pid: process.pid,
      level,
      event,
      detail: detail === undefined ? null : detail,
    };
    let line;
    try {
      line = `${JSON.stringify(record)}\n`;
    } catch {
      line = `${JSON.stringify({ at: record.at, pid: record.pid, level, event, detail: '<unserialisable>' })}\n`;
    }
    if (!broken) {
      try {
        rotate(file);
        fs.appendFileSync(file, line, 'utf8');
      } catch {
        broken = true;
      }
    }
    if (opts.echo !== false && (level === 'error' || level === 'warn')) {
      try { process.stderr.write(`${line}`); } catch { /* ignore */ }
    }
  };

  return {
    file,
    dir,
    info: (event, detail) => write('info', event, detail),
    warn: (event, detail) => write('warn', event, detail),
    error: (event, detail) => write('error', event, detail),
  };
}

module.exports = { createLogger, resolveLogDir };
