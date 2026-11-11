'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { compileGenerationSpec, fingerprint, error } = require('./generation-spec');
const { validatePng } = require('./png-contract');
const TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);

// Single coordinator per database, bounded local DEV queue. Not a distributed GPU scheduler.
class GenerationJobs {
  constructor(options) {
    this.enabled = options.enabled === true;
    this.provider = options.provider;
    this.deliver = options.deliver;
    this.onError = typeof options.onError === 'function' ? options.onError : () => {};
    this.maxJobs = options.maxJobs || 32;
    this.maxReceipts = options.maxReceipts || 1024;
    this.maxPending = options.maxPending || 4;
    this.timeoutMs = options.timeoutMs || 120000;
    this.db = null;
    this.closed = false;
    this.pumping = null;
    this.controller = null;
    if (!this.enabled) return;
    if (!this.provider || typeof this.provider.generate !== 'function' || !/^[a-f0-9]{64}$/.test(this.provider.profileHash || '') || typeof this.deliver !== 'function') throw error('GENERATION_UNCONFIGURED');
    // Optional feature only. Existing Node 20 clients remain usable when it is disabled.
    const { DatabaseSync } = require('node:sqlite');
    fs.mkdirSync(options.dir, { recursive: true });
    this.lock = path.join(options.dir, 'coordinator.lock');
    try { fs.writeFileSync(this.lock, String(process.pid), { flag: 'wx' }); }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      // Fail closed. Crash recovery requires the owner to verify the recorded PID is gone
      // before removing the lock; never steal a lock while another coordinator may start.
      throw error('GENERATION_STORE_LOCKED');
    }
    try {
      this.db = new DatabaseSync(path.join(options.dir, 'jobs.sqlite'));
      const version = this.db.prepare('PRAGMA user_version').get().user_version;
      if (version > 1) throw error('GENERATION_SCHEMA_UNSUPPORTED');
      this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL; BEGIN IMMEDIATE;
        CREATE TABLE IF NOT EXISTS generation_schema(version INTEGER PRIMARY KEY CHECK(version=1));
        INSERT OR IGNORE INTO generation_schema VALUES(1);
        CREATE TABLE IF NOT EXISTS jobs(
          id TEXT PRIMARY KEY, owner TEXT NOT NULL, operation TEXT NOT NULL, fingerprint TEXT NOT NULL,
          spec TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('queued','running','succeeded','failed','cancelled')),
          created INTEGER NOT NULL, updated INTEGER NOT NULL, result TEXT, png BLOB, error TEXT,
          UNIQUE(owner, operation));
        CREATE INDEX IF NOT EXISTS jobs_queue ON jobs(state,created);
        PRAGMA user_version=1; COMMIT;`);
      // Running work may already have caused effects. Never automatically repeat after a crash.
      this.db.prepare("UPDATE jobs SET state='failed',error='GENERATION_INTERRUPTED',updated=? WHERE state='running'").run(Date.now());
    } catch (e) { this.db?.close(); fs.unlinkSync(this.lock); throw e; }
    this.schedule();
  }
  status() { return { enabled: this.enabled, configured: Boolean(this.provider), provider: this.provider?.id || null, persistent: true, concurrency: 1, automaticRouting: false }; }
  requireOwner(owner) {
    if (!this.enabled) throw error('GENERATION_DISABLED');
    if (this.closed) throw error('GENERATION_CLOSED');
    if (typeof owner !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(owner)) throw error('GENERATION_OWNER_REQUIRED');
  }
  row(owner, id) {
    this.requireOwner(owner);
    const row = this.db.prepare('SELECT * FROM jobs WHERE owner=? AND id=?').get(owner, id);
    if (!row) throw error('GENERATION_JOB_NOT_FOUND');
    return row;
  }
  view(row) {
    return { jobId: row.id, operationId: row.operation, state: row.state, createdAt: row.created, updatedAt: row.updated,
      result: row.result ? JSON.parse(row.result) : null, error: row.error || null };
  }
  submit(owner, input) {
    this.requireOwner(owner);
    const spec = compileGenerationSpec(input);
    const hash = fingerprint(spec, this.provider.profileHash);
    this.db.exec('BEGIN IMMEDIATE');
    let row;
    try {
      row = this.db.prepare('SELECT * FROM jobs WHERE owner=? AND operation=?').get(owner, spec.operationId);
      if (row && row.fingerprint !== hash) throw error('GENERATION_OPERATION_CONFLICT');
      if (!row) {
        if (this.db.prepare("SELECT count(*) AS n FROM jobs WHERE owner=? AND (error IS NULL OR error!='GENERATION_REMOVED')").get(owner).n >= this.maxJobs
          || this.db.prepare('SELECT count(*) AS n FROM jobs WHERE owner=?').get(owner).n >= this.maxReceipts
          || this.db.prepare("SELECT count(*) AS n FROM jobs WHERE state IN ('queued','running')").get().n >= this.maxPending) throw error('GENERATION_QUOTA');
        const id = 'gj_' + crypto.randomBytes(16).toString('hex'), now = Date.now();
        this.db.prepare("INSERT INTO jobs(id,owner,operation,fingerprint,spec,state,created,updated) VALUES(?,?,?,?,?,'queued',?,?)")
          .run(id, owner, spec.operationId, hash, JSON.stringify(spec), now, now);
        row = this.db.prepare('SELECT * FROM jobs WHERE id=?').get(id);
      }
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
    this.schedule();
    return this.view(row);
  }
  get(owner, id) { return this.view(this.row(owner, id)); }
  list(owner) { this.requireOwner(owner); return this.db.prepare('SELECT * FROM jobs WHERE owner=? ORDER BY created,id').all(owner).map(r => this.view(r)); }
  image(owner, id) {
    const row = this.row(owner, id);
    if (row.state !== 'succeeded' || !row.png) throw error('GENERATION_NOT_READY');
    return { bytes: Buffer.from(row.png), spec: JSON.parse(row.spec), result: JSON.parse(row.result) };
  }
  cancel(owner, id) {
    const row = this.row(owner, id);
    if (TERMINAL.has(row.state)) return this.view(row);
    // Persist intent, then abort. The pump waits for provider settlement before admitting another job.
    this.db.prepare("UPDATE jobs SET state='cancelled',error='GENERATION_CANCELLED',updated=? WHERE id=?").run(Date.now(), id);
    if (this.active === id) this.controller?.abort();
    return this.get(owner, id);
  }
  remove(owner, id) {
    const row = this.row(owner, id);
    if (!TERMINAL.has(row.state) || this.active === id) throw error('GENERATION_JOB_ACTIVE');
    // Keep a tombstone for durable idempotency, release prompt and image. Deleting a receipt must not repeat GPU work.
    this.db.prepare("UPDATE jobs SET spec='{}',png=NULL,result=NULL,error='GENERATION_REMOVED',updated=? WHERE id=?").run(Date.now(), id);
    return { removed: id, projectPreserved: true, receiptRetained: true };
  }
  schedule() {
    if (!this.enabled || this.closed || this.pumping) return;
    this.pumping = new Promise(resolve => setImmediate(resolve)).then(() => this.pump()).finally(() => { this.pumping = null; });
  }
  async pump() {
    while (!this.closed) {
      const row = this.db.prepare("SELECT * FROM jobs WHERE state='queued' ORDER BY created,id LIMIT 1").get();
      if (!row) break;
      this.active = row.id;
      this.controller = new AbortController();
      this.db.prepare("UPDATE jobs SET state='running',updated=? WHERE id=? AND state='queued'").run(Date.now(), row.id);
      const spec = JSON.parse(row.spec), start = performance.now();
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; this.controller.abort(); }, this.timeoutMs);
      try {
        const generated = await this.provider.generate(spec, { signal: this.controller.signal, jobId: row.id });
        if (timedOut) throw error('GENERATION_TIMEOUT');
        if (this.controller.signal.aborted || this.get(row.owner, row.id).state !== 'running') continue;
        const bytes = generated?.bytes;
        if (generated?.mimeType !== 'image/png' || !Buffer.isBuffer(bytes) || bytes.length > 8 * 1024 * 1024) throw error('INVALID_GENERATION_IMAGE');
        try { validatePng(bytes, spec); } catch { throw error('INVALID_GENERATION_IMAGE'); }
        // Durable checkpoint before document creation. A crash becomes INTERRUPTED, never silent regeneration.
        this.db.prepare('UPDATE jobs SET png=?,updated=? WHERE id=?').run(bytes, Date.now(), row.id);
        const delivery = await this.deliver(spec, bytes, { owner: row.owner, jobId: row.id, signal: this.controller.signal });
        if (timedOut) throw error('GENERATION_TIMEOUT');
        if (this.controller.signal.aborted || this.get(row.owner, row.id).state !== 'running') continue;
        const result = { ...delivery, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), width: spec.width, height: spec.height,
          provider: this.provider.id, profileHash: this.provider.profileHash, seed: spec.seed, durationMs: performance.now() - start, visualReview: 'not-reviewed' };
        this.db.prepare("UPDATE jobs SET state='succeeded',result=?,updated=? WHERE id=?").run(JSON.stringify(result), Date.now(), row.id);
      } catch (e) {
        try { this.onError({ jobId: row.id, code: e.code || 'UNEXPECTED_ERROR', op: e.op || null }); } catch {}
        const safeCodes = ['INVALID_GENERATION_IMAGE', 'GENERATION_CANCELLED', 'GENERATION_WORKER_UNAVAILABLE', 'GENERATION_MODEL_UNAVAILABLE', 'CLOUDFLARE_AUTH_REQUIRED', 'CLOUDFLARE_AUTH_DENIED', 'CLOUDFLARE_RATE_LIMIT', 'CLOUDFLARE_LOCAL_BUDGET', 'CLOUDFLARE_TIMEOUT', 'CLOUDFLARE_NETWORK_ERROR', 'CLOUDFLARE_PROVIDER_ERROR', 'CLOUDFLARE_OPERATION_RESERVED', 'CLOUDFLARE_DIMENSIONS'];
        const code = timedOut ? 'GENERATION_TIMEOUT' : safeCodes.includes(e.code) ? e.code : 'GENERATION_JOB_FAILED';
        this.db.prepare("UPDATE jobs SET state='failed',error=?,updated=? WHERE id=? AND state='running'").run(code, Date.now(), row.id);
      } finally { clearTimeout(timer); this.active = null; this.controller = null; }
    }
  }
  async idle() { while (this.pumping) await this.pumping; }
  async close() {
    if (this.closed) return;
    this.closed = true;
    this.controller?.abort();
    await this.idle();
    this.db?.close();
    if (this.lock) fs.unlinkSync(this.lock);
  }
}
module.exports = { GenerationJobs };
