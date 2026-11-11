'use strict';

const dot = (a, b) => a.reduce((sum, value, i) => sum + value * b[i], 0);
function normalize(vector) {
  const norm = Math.sqrt(dot(vector, vector));
  return norm > 1e-12 ? Float64Array.from(vector, value => value / norm) : null;
}

// Experimental corpus-only latent semantic indexing: normalized TF-IDF followed by
// a low-rank eigendecomposition of A*A^T. No pretrained model, network or external art.
// This is not CLIP or a neural multilingual embedding model.
class CorpusSemanticSearch {
  constructor(concepts, tokenize, dimensions = 12) {
    if (concepts.length > 1000) throw Object.assign(new Error('Experimental corpus limit is 1000 concepts'), { code: 'SEMANTIC_CORPUS_LIMIT' });
    this.ids = concepts.map(c => c.id);
    const counts = concepts.map(c => {
      const words = tokenize([c.title, c.title, ...(c.terms || []), ...(c.pageRefs || []).slice(0, 4).map(r => r.quote || '')].join(' '));
      const map = new Map();
      for (const word of words) map.set(word, (map.get(word) || 0) + 1);
      return map;
    });
    const df = new Map();
    for (const count of counts) for (const term of count.keys()) df.set(term, (df.get(term) || 0) + 1);
    this.idf = new Map([...df].map(([term, frequency]) => [term, 1 + Math.log((1 + counts.length) / (1 + frequency))]));
    this.docs = counts.map(count => this.vector(count));
    const n = counts.length;
    const gram = Array.from({ length: n }, () => new Float64Array(n));
    const postings = new Map();
    this.docs.forEach((doc, i) => { for (const [term, weight] of doc) { if (!postings.has(term)) postings.set(term, []); postings.get(term).push([i, weight]); } });
    for (const list of postings.values()) for (const [i, a] of list) for (const [j, b] of list) gram[i][j] += a * b;
    const multiply = v => Float64Array.from(gram, row => dot(row, v));
    this.axes = [];
    for (let axis = 0; axis < Math.min(dimensions, n); axis++) {
      let u = normalize(Float64Array.from({ length: n }, (_, i) => Math.sin((i + 1) * (axis + 1) * 1.618)));
      if (!u) break;
      for (let iteration = 0; iteration < 32; iteration++) {
        const v = multiply(u);
        for (const previous of this.axes) {
          const projection = dot(v, previous.u);
          for (let i = 0; i < n; i++) v[i] -= projection * previous.u[i];
        }
        const next = normalize(v);
        if (!next) { u = null; break; }
        u = next;
      }
      if (!u) break;
      const eigenvalue = dot(u, multiply(u));
      if (eigenvalue < 1e-9) break;
      this.axes.push({ u, sigma: Math.sqrt(eigenvalue) });
    }
    this.norms = this.docs.map((_, i) => Math.sqrt(this.axes.reduce((sum, axis) => sum + (axis.u[i] * axis.sigma) ** 2, 0)));
  }

  vector(counts) {
    const vector = new Map();
    for (const [term, count] of counts) if (this.idf.has(term)) vector.set(term, (1 + Math.log(count)) * this.idf.get(term));
    const norm = Math.sqrt([...vector.values()].reduce((sum, value) => sum + value * value, 0));
    if (norm) for (const [term, value] of vector) vector.set(term, value / norm);
    return vector;
  }

  rank(tokens) {
    const counts = new Map();
    for (const token of tokens) counts.set(token, (counts.get(token) || 0) + 1);
    const q = this.vector(counts);
    if (!q.size || !this.axes.length) return new Map();
    const kernel = Float64Array.from(this.docs, doc => [...q].reduce((sum, [term, weight]) => sum + weight * (doc.get(term) || 0), 0));
    const latent = this.axes.map(axis => dot(axis.u, kernel) / axis.sigma);
    const norm = Math.sqrt(latent.reduce((sum, value) => sum + value * value, 0));
    if (norm < 1e-12) return new Map();
    const ranked = this.ids.map((id, i) => ({ id, similarity: this.axes.reduce((sum, axis, k) => sum + axis.u[i] * axis.sigma * latent[k], 0) / (this.norms[i] * norm || 1) }))
      .filter(row => Number.isFinite(row.similarity) && row.similarity > 0.05).sort((a, b) => b.similarity - a.similarity || a.id.localeCompare(b.id));
    return new Map(ranked.map((row, i) => [row.id, { rank: i + 1, similarity: Math.min(1, row.similarity) }]));
  }
}
module.exports = { CorpusSemanticSearch };
