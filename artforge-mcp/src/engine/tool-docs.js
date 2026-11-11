'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * Index of the tool documentation (docs/*.md). The routing engine consults this
 * index in phase ③ so the design is executed with the tool's real operations.
 */
class ToolDocs {
  constructor(docsDir, options) {
    const opts = options || {};
    this.docsDir = docsDir;
    this.opsSource = opts.opsSource || null;
    this.documents = [];
    this.sections = [];
    this.operations = new Map();
    this.supportedOps = new Map();
    this.loaded = false;
  }

  /**
   * المصفوفة المرجعية الحقيقية من كود الأداة نفسه (core/ops.js)، لا من تشابه كلمات:
   * `OPS['op.name'] = async ...` (الدعم الفعلي) + قاموس `OP_DOCS` (الوصف).
   * فهرس Markdown يبقى للتفاصيل؛ أي تعارض يرجح الكود.
   */
  loadCodeRegistry() {
    if (!this.opsSource || !fs.existsSync(this.opsSource)) return;
    const src = fs.readFileSync(this.opsSource, 'utf8');
    const add = (name) => { if (!this.supportedOps.has(name)) this.supportedOps.set(name, { summary: null }); };
    for (const match of src.matchAll(/OPS\['([a-zA-Z]+(?:\.[a-zA-Z]+)*)'\]\s*=/g)) add(match[1]);
    for (const match of src.matchAll(/OPS\.([a-zA-Z]+)\s*=/g)) add(match[1]);
    // Ops registered in loops were invisible to the literal patterns above (draw.rect, draw.ellipse, …,
    // material.*), so tool docs reported them "NOT SUPPORTED" although the engine runs them.
    // 1) for (const [name, …] of Object.entries(MAP)) { OPS[name] = … }  → the keys of `const MAP = {…}`
    for (const loop of src.matchAll(/for\s*\(\s*const\s*\[\s*(\w+)[^\]]*\]\s*of\s*Object\.entries\(\s*(\w+)\s*\)\s*\)\s*\{?\s*OPS\[\s*\1\s*\]\s*=/g)) {
      const block = new RegExp(`const\\s+${loop[2]}\\s*=\\s*\\{([\\s\\S]*?)\\};`).exec(src);
      if (block) for (const key of block[1].matchAll(/'([a-zA-Z]+(?:\.[a-zA-Z]+)+)'\s*:/g)) add(key[1]);
    }
    // 2) for (const action of ['a', 'b']) OPS['prefix.' + action] = …
    for (const loop of src.matchAll(/for\s*\(\s*const\s+(\w+)\s+of\s*\[([^\]]*)\]\s*\)\s*\{?\s*OPS\[\s*'([a-zA-Z.]+\.)'\s*\+\s*\1\s*\]\s*=/g)) {
      for (const item of loop[2].matchAll(/'([a-zA-Z]+)'/g)) add(loop[3] + item[1]);
    }
    const docsBlock = /const\s+OP_DESCRIPTIONS\s*=\s*\{([\s\S]*?)\};/.exec(src);
    if (docsBlock) {
      for (const match of docsBlock[1].matchAll(/'([a-zA-Z]+(?:\.[a-zA-Z]+)+)'\s*:\s*'((?:[^'\\]|\\.)*)'/g)) {
        const entry = this.supportedOps.get(match[1]) || { summary: null };
        entry.summary = match[2];
        this.supportedOps.set(match[1], entry);
      }
    }
  }

  load() {
    if (this.loaded) return this;
    this.loadCodeRegistry();
    if (!fs.existsSync(this.docsDir)) {
      this.loaded = true;
      return this;
    }
    const files = fs.readdirSync(this.docsDir).filter((file) => file.endsWith('.md')).sort();
    for (const file of files) {
      const fullPath = path.join(this.docsDir, file);
      const text = fs.readFileSync(fullPath, 'utf8');
      const titleMatch = /^#\s+(.*)$/m.exec(text);
      this.documents.push({
        file,
        path: fullPath,
        title: titleMatch ? titleMatch[1].trim() : file,
        bytes: Buffer.byteLength(text, 'utf8'),
      });
      let heading = titleMatch ? titleMatch[1].trim() : file;
      let buffer = [];
      const flush = () => {
        const body = buffer.join('\n').trim();
        if (body) {
          this.sections.push({
            id: `${file}#${this.sections.filter((section) => section.doc === file).length + 1}`,
            doc: file,
            heading,
            text: body,
          });
        }
        buffer = [];
      };
      for (const line of text.split(/\r?\n/)) {
        const sectionMatch = /^#{1,3}\s+(.*)$/.exec(line);
        if (sectionMatch) {
          flush();
          heading = sectionMatch[1].trim();
        } else {
          buffer.push(line);
        }
      }
      flush();

      // Operation reference rows look like: | `draw.rect` | inputs | outputs |
      const opRegex = /^\|[ \t]*`([a-z]+\.[a-zA-Z]+)`[ \t]*\|([^|\r\n]*)\|([^|\r\n]*)\|/gm;
      let match = opRegex.exec(text);
      while (match) {
        if (!this.operations.has(match[1]) || file === '04-operations.md') this.operations.set(match[1], {
          name: match[1],
          inputs: match[2].replace(/\s+/g, ' ').trim(),
          outputs: match[3].replace(/\s+/g, ' ').trim(),
          doc: file,
        });
        match = opRegex.exec(text);
      }
    }
    this.loaded = true;
    return this;
  }

  summary() {
    this.load();
    return {
      documents: this.documents,
      sections: this.sections.length,
      operations: this.operations.size,
      supportedOperations: this.supportedOps.size,
      undocumentedSupported: [...this.supportedOps.keys()].filter((name) => !this.operations.has(name)),
    };
  }

  /** Keyword search over section headings and bodies. */
  search(query, limit) {
    this.load();
    const terms = String(query || '').toLowerCase().split(/[\s,،.]+/).filter((term) => term.length > 1);
    if (!terms.length) {
      return this.sections.slice(0, limit || 5).map((section) => ({
        id: section.id, doc: section.doc, heading: section.heading, excerpt: section.text.slice(0, 400),
      }));
    }
    const scored = this.sections.map((section) => {
      const headingText = section.heading.toLowerCase();
      const bodyText = section.text.toLowerCase();
      let score = 0;
      for (const term of terms) {
        if (headingText.includes(term)) score += 4;
        const occurrences = bodyText.split(term).length - 1;
        score += Math.min(6, occurrences);
      }
      return { section, score };
    }).filter((entry) => entry.score > 0).sort((a, b) => b.score - a.score);

    return scored.slice(0, limit || 5).map((entry) => ({
      id: entry.section.id,
      doc: entry.section.doc,
      heading: entry.section.heading,
      score: entry.score,
      excerpt: entry.section.text.slice(0, 600),
    }));
  }

  /** Exact operation documentation (inputs/outputs) for the ops a plan will use. */
  helpFor(operations) {
    this.load();
    return operations.map((name) => {
      const docEntry = this.operations.get(name) || null;
      const codeEntry = this.supportedOps.has(name) ? this.supportedOps.get(name) : null;
      return {
        name,
        supported: Boolean(codeEntry),
        documented: Boolean(docEntry),
        inputs: docEntry ? docEntry.inputs : null,
        outputs: docEntry ? docEntry.outputs : null,
        summary: (codeEntry && codeEntry.summary) || null,
        doc: docEntry ? docEntry.doc : null,
        note: codeEntry
          ? (docEntry ? null : 'supported by the engine; no markdown table row — see the operation description')
          : 'NOT SUPPORTED by the drawing tool engine (verified against core/ops.js)',
      };
    });
  }

  getSection(id) {
    this.load();
    return this.sections.find((section) => section.id === id) || null;
  }
}

module.exports = { ToolDocs };
