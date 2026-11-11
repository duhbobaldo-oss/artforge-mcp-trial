'use strict';
const { execFile } = require('node:child_process');
const { error } = require('./generation-spec');

// Official credential handoff. Capture in memory only; never log or write the returned token.
function wranglerCredentials(cliPath) {
  return () => new Promise((resolve, reject) => {
    execFile(process.execPath, [cliPath, 'auth', 'token', '--json'], { windowsHide: true, timeout: 30000, maxBuffer: 65536,
      env: { ...process.env, WRANGLER_SEND_METRICS: 'false' } }, (failure, stdout) => {
      if (failure) return reject(error('CLOUDFLARE_AUTH_REQUIRED'));
      try { const value = JSON.parse(stdout); if (!['api_token', 'oauth'].includes(value.type) || typeof value.token !== 'string') throw Error(); resolve({ token: value.token }); }
      catch { reject(error('CLOUDFLARE_AUTH_REQUIRED')); }
    });
  });
}
module.exports = { wranglerCredentials };
