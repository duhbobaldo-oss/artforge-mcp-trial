'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

/**
 * تتبّع زمني موحّد لكل طلب (traceId ينتقل مع الطلب)، باستخدام hrtime دقيق.
 * يكتب إلى logs/trace.jsonl ويُعيد ملخّصًا بالمراحل والذاكرة والأحجام.
 * الزمن المقاس هنا محلي حصرًا ولا يدّعي شمول زمن ChatGPT.
 */
class Trace {
  constructor(options) {
    const opts = options || {};
    this.traceId = opts.traceId || `tr_${crypto.randomBytes(8).toString('hex')}`;
    this.kind = opts.kind || 'generic';
    this.label = opts.label || null;
    this.logFile = opts.logFile || null;
    this.startedAt = new Date();
    this.startedHr = process.hrtime.bigint();
    this.memStart = process.memoryUsage().rss;
    this.spans = [];
    this.open = new Map();
    this.inputBytes = opts.inputBytes || 0;
  }

  static elapsed(hrStart) {
    return Number((Number(process.hrtime.bigint() - hrStart) / 1e6).toFixed(3));
  }

  span(name, detail) {
    const span = { name, startedHr: process.hrtime.bigint(), startedAt: new Date().toISOString() };
    if (detail !== undefined) span.detail = detail;
    this.open.set(name, span);
    return {
      end: (endDetail) => {
        this.open.delete(name);
        span.elapsedMs = Trace.elapsed(span.startedHr);
        if (endDetail !== undefined) span.detail = endDetail;
        this.spans.push(span);
        return span.elapsedMs;
      },
    };
  }

  event(name, detail) {
    this.spans.push({ name, at: new Date().toISOString(), elapsedMs: Trace.elapsed(this.startedHr), detail });
  }

  summary(extra) {
    const out = {
      traceId: this.traceId,
      kind: this.kind,
      label: this.label,
      startedAt: this.startedAt.toISOString(),
      totalMs: Trace.elapsed(this.startedHr),
      memoryDeltaBytes: process.memoryUsage().rss - this.memStart,
      inputBytes: this.inputBytes,
      spans: this.spans.map((span) => ({
        name: span.name,
        elapsedMs: span.elapsedMs,
        detail: span.detail,
      })),
    };
    return Object.assign(out, extra || {});
  }

  /** اكتب السجل واعده الملخّص. لا يرمي أخطاء أبدًا. */
  finish(status, extra) {
    const out = this.summary(Object.assign({ status }, extra || {}));
    if (this.logFile) {
      try {
        fs.mkdirSync(path.dirname(this.logFile), { recursive: true });
        fs.appendFileSync(this.logFile, `${JSON.stringify(Object.assign({ at: new Date().toISOString() }, out))}\n`, 'utf8');
      } catch { /* logging must never break a tool call */ }
    }
    return out;
  }
}

function newTraceId() {
  return `tr_${crypto.randomBytes(8).toString('hex')}`;
}

module.exports = { Trace, newTraceId };
