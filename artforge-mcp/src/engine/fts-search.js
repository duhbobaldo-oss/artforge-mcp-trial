'use strict';

class FtsSearch {
  constructor(concepts, normalise) {
    let DatabaseSync;
    try { ({ DatabaseSync } = require('node:sqlite')); }
    catch { throw Object.assign(new Error('Optional FTS5 requires a Node runtime with node:sqlite'), { code: 'SEARCH_BACKEND_UNAVAILABLE' }); }
    this.db = new DatabaseSync(':memory:');
    this.db.exec('CREATE VIRTUAL TABLE concepts USING fts5(id UNINDEXED, title, terms, quotes)');
    const insert = this.db.prepare('INSERT INTO concepts(id,title,terms,quotes) VALUES(?,?,?,?)');
    this.db.exec('BEGIN');
    try {
      for (const c of concepts) insert.run(c.id, normalise(c.title || ''), normalise((c.terms || []).join(' ')), normalise((c.pageRefs || []).map(r => r.quote || '').join(' ')));
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); this.db.close(); throw error; }
  }
  rank(tokens) {
    const terms = [...new Set(tokens)].filter(t => /^[\p{L}\p{N}]+$/u.test(t)).slice(0, 100);
    if (!terms.length) return new Map();
    const query = terms.map(t => `"${t}"`).join(' OR ');
    const rows = this.db.prepare('SELECT id FROM concepts WHERE concepts MATCH ? ORDER BY bm25(concepts,0,4,3,1),id').all(query);
    return new Map(rows.map((r, i) => [r.id, i + 1]));
  }
  close() { this.db.close(); }
}
module.exports = { FtsSearch };
