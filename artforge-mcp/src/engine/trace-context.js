'use strict';
const { AsyncLocalStorage } = require('node:async_hooks');
const context = new AsyncLocalStorage();
function safeTraceId(value) { return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,96}$/.test(value) ? value : null; }
module.exports = { context, safeTraceId };
