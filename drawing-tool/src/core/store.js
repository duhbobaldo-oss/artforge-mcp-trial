'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { assert, fail } = require('./errors');
const { createDocument, normalizeDocument, documentStats, SCHEMA, VERSION } = require('./document');

const HISTORY_LIMIT = 40;

/**
 * In-memory document store with disk persistence (.artforge.json), revision
 * tracking for live previews, undo/redo history and change events.
 */
class DocumentStore extends EventEmitter {
  constructor(options) {
    super();
    const opts = options || {};
    this.docsDir = path.resolve(opts.docsDir);
    this.historyLimit = opts.historyLimit || HISTORY_LIMIT;
    fs.mkdirSync(this.docsDir, { recursive: true });
    this.documents = new Map();
    this.revisions = new Map();
    this.history = new Map();
    // Active selection per document: a coverage program. Transient editor state like Photoshop's marching
    // ants: not saved in the document and not part of its undo history.
    this.selections = new Map();
    this.loadFromDisk();
  }

  loadFromDisk() {
    for (const file of fs.readdirSync(this.docsDir)) {
      if (!file.endsWith('.artforge.json')) continue;
      try {
        const doc = normalizeDocument(JSON.parse(fs.readFileSync(path.join(this.docsDir, file), 'utf8')));
        this.documents.set(doc.id, doc);
        this.revisions.set(doc.id, 1);
        this.history.set(doc.id, { past: [], future: [] });
      } catch {
        // Corrupt files are ignored on startup; they can still be opened manually.
      }
    }
  }

  fileFor(docId) {
    return path.join(this.docsDir, `${docId}.artforge.json`);
  }

  create(payload) {
    const doc = createDocument(payload || {});
    assert(!this.documents.has(doc.id), 'DUPLICATE_DOCUMENT', `document id already exists: ${doc.id}`);
    this.documents.set(doc.id, doc);
    this.revisions.set(doc.id, 1);
    this.history.set(doc.id, { past: [], future: [] });
    this.emitChange(doc.id, 'document.create');
    return doc;
  }

  has(docId) {
    return this.documents.has(docId);
  }

  get(docId) {
    const doc = this.documents.get(docId);
    if (!doc) fail('DOCUMENT_NOT_FOUND', `document not found: ${docId}`, { known: Array.from(this.documents.keys()) });
    return doc;
  }

  list() {
    return Array.from(this.documents.values())
      .map((doc) => Object.assign(documentStats(doc), { revision: this.revisions.get(doc.id) || 1 }))
      .sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
  }

  revision(docId) {
    return this.revisions.get(docId) || 0;
  }

  emitChange(docId, op) {
    const revision = (this.revisions.get(docId) || 0) + 1;
    this.revisions.set(docId, revision);
    this.emit('change', { docId, op, revision, at: new Date().toISOString() });
    return revision;
  }

  /** Record the current state before a mutation (undo support); `label` names the step (the op). */
  pushHistory(docId, label) {
    const doc = this.get(docId);
    const entry = this.history.get(docId) || { past: [], future: [] };
    entry.past.push({ doc: JSON.stringify(doc), label: label || 'edit' });
    if (entry.past.length > this.historyLimit) entry.past.shift();
    entry.future = [];
    this.history.set(docId, entry);
    return entry;
  }

  historyState(docId) {
    const entry = this.history.get(docId) || { past: [], future: [] };
    return {
      canUndo: entry.past.length > 0,
      canRedo: entry.future.length > 0,
      undoDepth: entry.past.length,
      redoDepth: entry.future.length,
      // Step names, oldest first: what each undo / redo would revert / re-apply.
      past: entry.past.map((e) => e.label),
      future: entry.future.map((e) => e.label).reverse(),
    };
  }

  undo(docId) {
    const entry = this.history.get(docId) || { past: [], future: [] };
    assert(entry.past.length > 0, 'NOTHING_TO_UNDO', 'no undo history available for this document');
    const previous = entry.past.pop();
    entry.future.push({ doc: JSON.stringify(this.get(docId)), label: previous.label });
    this.history.set(docId, entry);
    const restored = normalizeDocument(JSON.parse(previous.doc));
    this.documents.set(docId, restored);
    this.emitChange(docId, 'history.undo');
    return restored;
  }

  redo(docId) {
    const entry = this.history.get(docId) || { past: [], future: [] };
    assert(entry.future.length > 0, 'NOTHING_TO_REDO', 'no redo history available for this document');
    const next = entry.future.pop();
    entry.past.push({ doc: JSON.stringify(this.get(docId)), label: next.label });
    this.history.set(docId, entry);
    const restored = normalizeDocument(JSON.parse(next.doc));
    this.documents.set(docId, restored);
    this.emitChange(docId, 'history.redo');
    return restored;
  }

  /** Persist a document as .artforge.json (design file, re-openable). */
  save(docId, options) {
    const opts = options || {};
    const doc = this.get(docId);
    const target = opts.path ? path.resolve(opts.path) : this.fileFor(docId);
    assert(!opts.path || target.endsWith('.artforge.json') || target.endsWith('.json'), 'INVALID_PATH',
      'save path must end with .artforge.json or .json');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const payload = JSON.stringify(doc, null, 2);
    fs.writeFileSync(target, payload, 'utf8');
    return {
      path: target,
      bytes: Buffer.byteLength(payload, 'utf8'),
      stats: documentStats(doc),
      revision: this.revision(docId),
    };
  }

  /** Open a saved design file into the store. */
  open(filePath, options) {
    const opts = options || {};
    const resolved = path.resolve(String(filePath || ''));
    assert(fs.existsSync(resolved), 'FILE_NOT_FOUND', `design file not found: ${resolved}`);
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(resolved, 'utf8'));
    } catch (error) {
      fail('INVALID_DESIGN_FILE', `cannot parse design file: ${error.message}`);
    }
    assert(parsed && parsed.schema === SCHEMA, 'INVALID_DESIGN_FILE',
      `file is not an ArtForge design (expected schema "${SCHEMA}")`, { received: parsed && parsed.schema });
    const doc = normalizeDocument(parsed);
    if (this.documents.has(doc.id) && !opts.replace) {
      const originalId=doc.id;let suffix=1;while(this.documents.has(doc.id))doc.id=`${originalId}_copy${suffix++}`;
      doc.name = `${doc.name} (copy)`;
    }
    this.documents.set(doc.id, doc);
    if (!this.revisions.has(doc.id)) this.revisions.set(doc.id, 1);
    this.history.set(doc.id, { past: [], future: [] });
    this.emitChange(doc.id, 'document.open');
    return { document: doc, stats: documentStats(doc), sourcePath: resolved, version: VERSION };
  }

  /** Register an already-parsed design object (browser upload, MCP hand-off). */
  openDocument(parsed, options) {
    const opts = options || {};
    assert(parsed && parsed.schema === SCHEMA, 'INVALID_DESIGN_FILE',
      `object is not an ArtForge design (expected schema "${SCHEMA}")`, { received: parsed && parsed.schema });
    const doc = normalizeDocument(parsed);
    if (this.documents.has(doc.id) && !opts.replace) {
      const originalId=doc.id;let suffix=1;while(this.documents.has(doc.id))doc.id=`${originalId}_copy${suffix++}`;
      doc.name = `${doc.name} (copy)`;
    }
    this.documents.set(doc.id, doc);
    if (!this.revisions.has(doc.id)) this.revisions.set(doc.id, 1);
    this.history.set(doc.id, { past: [], future: [] });
    this.emitChange(doc.id, 'document.import');
    return { document: doc, stats: documentStats(doc), version: VERSION };
  }

  remove(docId) {
    this.get(docId);
    this.documents.delete(docId);
    this.revisions.delete(docId);
    this.history.delete(docId);
    this.selections.delete(docId);
    const file = this.fileFor(docId);
    if (fs.existsSync(file)) fs.unlinkSync(file);
    this.emit('change', { docId, op: 'document.delete', revision: 0, at: new Date().toISOString() });
    return { removed: docId };
  }

  // ---- atomic batch support: in-memory state only (atomic batches refuse ops with disk side effects)

  getSelection(docId) {
    return this.selections.get(docId) || null;
  }

  setSelection(docId, steps) {
    this.get(docId);
    if (steps && steps.length) this.selections.set(docId, steps); else this.selections.delete(docId);
    this.emit('change', { docId, op: 'selection', revision: this.revision(docId), at: new Date().toISOString() });
  }

  documentIds() {
    return Array.from(this.documents.keys());
  }

  /** Snapshot a document with its undo/redo stacks and selection so a failed atomic batch can put them back. */
  captureState(docId) {
    const entry = this.history.get(docId) || { past: [], future: [] };
    const selection = this.selections.get(docId);
    return { doc: JSON.stringify(this.get(docId)), past: entry.past.slice(), future: entry.future.slice(), selection: selection ? JSON.stringify(selection) : null };
  }

  restoreState(docId, state) {
    this.documents.set(docId, normalizeDocument(JSON.parse(state.doc)));
    this.history.set(docId, { past: state.past.slice(), future: state.future.slice() });
    if (state.selection) this.selections.set(docId, JSON.parse(state.selection)); else this.selections.delete(docId);
    // Revisions only move forward; viewers see a new revision whose content equals the pre-batch one.
    this.emitChange(docId, 'batch.rollback');
  }

  /** Drop a document created inside a failed atomic batch (never saved, so nothing on disk). */
  discard(docId) {
    this.selections.delete(docId);
    this.documents.delete(docId);
    this.revisions.delete(docId);
    this.history.delete(docId);
    this.emit('change', { docId, op: 'batch.rollback', revision: 0, at: new Date().toISOString() });
  }

  exportAll() {
    return {
      schema: 'artforge.documents',
      version: VERSION,
      exportedAt: new Date().toISOString(),
      documents: Array.from(this.documents.values()),
    };
  }
}

module.exports = { DocumentStore, HISTORY_LIMIT };
