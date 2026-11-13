'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { analyzeIntent } = require('../src/engine/intent');
const { understandRequest } = require('../src/engine/understanding');

const elementIds = (prompt) => (analyzeIntent(prompt, {}).elements || []).map((e) => e.id);
const motifs = (prompt) => understandRequest(prompt).entities.map((e) => e.motif);

test('definite relational adjectives are not drawn as the object (السحابي, الشمسي)', () => {
  const card = 'بطاقة ترحيب بسيطة مكتوب عليها: تم ربط ArtForge السحابي';
  assert.ok(!elementIds(card).includes('clouds'));
  assert.ok(!motifs(card).includes('clouds'));
  assert.ok(!elementIds('ملصق عن النظام الشمسي').includes('sun'));
  assert.ok(!elementIds('بطاقة للخدمات السحابيه').includes('clouds'));
});

test('real objects still match with article, plural and possessive forms', () => {
  assert.ok(elementIds('ارسم السحاب فوق الجبل').includes('clouds'));
  assert.ok(elementIds('ارسم سماء فيها سحابات').includes('clouds'));
  assert.ok(elementIds('ارسم سحابي الصغير').includes('clouds'));
  assert.ok(motifs('ارسم سيارة على طريق وخلفها جبل وسحاب').includes('clouds'));
});
