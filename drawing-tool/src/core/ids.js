'use strict';

const { randomUUID } = require('node:crypto');

/** Short, human-readable, collision-safe identifier. */
function makeId(prefix) {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

module.exports = { makeId };
