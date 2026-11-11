'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { REGISTRY, SKILLS_DIR, tokensOf } = require('./skill-registry');
const { KnowledgeRules } = require('./knowledge-rules');

function skillContracts(knowledge) {
  const rules = new KnowledgeRules(knowledge);
  return REGISTRY.map(skill => {
    const text = fs.readFileSync(path.join(SKILLS_DIR, skill.file), 'utf8');
    const citations = rules.forSkill(skill.id).map(rule => ({ rule: rule.id, bookId: rule.citation.bookId,
      page: rule.citation.page, verification: rule.citation.verified }));
    return {
      id: skill.id, title: text.split('\n')[0].replace(/^#\s*/, '').trim(), group: skill.group, phase: skill.phase,
      triggers: skill.triggers || { always: true }, requires: skill.requires || [], conflicts: skill.conflicts || [],
      source: { file: `skills/${skill.file}`, sha256: crypto.createHash('sha256').update(text).digest('hex') },
      citations, citationPolicy: citations.length ? 'page-grounded art rules' : 'operating guidance; no book attribution claimed',
      contract: { input: ['original prompt', 'declared caller constraints'], output: skill.covers,
        acceptance: ['preserve original request', 'record applied decisions', 'separate structural and visual acceptance'] },
      toolBindings: skill.group === 'tools' ? ['artforge_tool_op', 'artforge_tool_docs'] : skill.phase === 'review' ? ['artforge_create_design', 'artforge_export'] : ['artforge_create_design'],
      example: skill.group === 'art' ? 'ارسم مكتبًا خشبيًا وعليه دفتر وثلاثة أقلام بإضاءة جانبية'
        : skill.group === 'tools' ? 'بعد الإنشاء: كل التعديلات في استدعاء artforge_tool_op واحد op:"batch"'
          : 'استخدم الطلب الأصلي وحدود المقاس والنصوص الصريحة في استدعاء إنشاء واحد',
      acceptanceTests: ['tests/direction.test.js', 'tests/repair-runtime.test.js'], tokens: tokensOf(skill),
    };
  });
}
module.exports = { skillContracts };
