'use strict';

/**
 * Typed error used by every drawing-tool operation.
 * `code` is stable and documented in docs/ (errors reference).
 */
class OpError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'OpError';
    this.code = code;
    this.details = details || null;
  }
  toJSON() {
    return { code: this.code, message: this.message, details: this.details };
  }
}

function fail(code, message, details) {
  throw new OpError(code, message, details);
}

function assert(condition, code, message, details) {
  if (!condition) fail(code, message, details);
}

module.exports = { OpError, fail, assert };
