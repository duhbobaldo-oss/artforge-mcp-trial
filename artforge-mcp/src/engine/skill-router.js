'use strict';

/**
 * Skill router (stage ④): picks the few guides a task actually needs, in execution order, within a context budget.
 *
 * 1. Features are measured from the understood request (entities, relations, counts, constraints) and the inputs.
 * 2. Every skill scores the sum of its matched trigger weights; the operating procedure is always first.
 * 3. Dependencies are pulled in, conflicts keep the higher score, and a skill whose topics are already covered
 *    by chosen skills is dropped as a duplicate.
 * 4. Lowest scores are cut until the token budget and the skill limit hold; the result is ordered by phase.
 * Every exclusion carries its reason, so the routing decision is auditable.
 */

const { REGISTRY, PHASES, tokensOf } = require('./skill-registry');

const NATURE = ['sun', 'moon', 'stars', 'clouds', 'mountains', 'hills', 'sea', 'river', 'lake', 'trees', 'palms', 'dunes', 'rocks', 'flowers', 'grass', 'garden', 'sky', 'birds'];
const MATERIAL = ['desk', 'bookshelf', 'tv', 'sofa', 'armchair', 'window', 'rug', 'sea', 'lake', 'river', 'tower', 'building', 'boat', 'lamp', 'coffeeTable', 'frame'];
const PICTURE = ['scene', 'character', 'landscape', 'architecture', 'reference', 'abstract'];

// Tool-skill cues read from the user's own words (whole words only, with the Arabic prefixes و/ف, ب/ل/ك and the
// article ال/لل), so a scene prompt that merely mentions "stars" or "pens" does not pull in the vector-tool guide.
const cue = (words) => new RegExp(`(?<![\\p{L}])(?:[وف]?[بلك]?ال|[وف]?لل|[وف])?(?:${words.join('|')})(?:ًا|اً|ات|ها|ه)?(?![\\p{L}])`, 'iu');
const CUES = {
  photoEdit: cue(['قناع', 'أقنعة', 'ماسك', 'mask', 'masks', 'مؤثر', 'مؤثرات', 'تأثيرات الطبقة', 'layer style', 'layer effects', 'توهج', 'glow',
    'ظل خارجي', 'ظل داخلي', 'drop shadow', 'inner shadow', 'bevel', 'نقش بارز', 'emboss', 'نيون', 'neon', 'ساتان', 'satin',
    'منحنيات', 'curves', 'levels', 'مستويات الألوان', 'تصحيح الألوان', 'تصحيح لوني', 'color grading', 'فلتر', 'فلاتر', 'filter', 'filters',
    'blend if', 'clipping mask', 'قناع قص', 'وضع المزج', 'أوضاع المزج', 'blend mode', 'طبقة ضبط', 'طبقات ضبط', 'adjustment layer']),
  retouch: cue(['رتوش', 'ريتوش', 'retouch', 'إزالة البقع', 'إزالة العيوب', 'إزالة الشوائب', 'إزالة الخدوش', 'heal', 'healing', 'clone', 'استنساخ',
    'ترقيع', 'patch', 'بكسل', 'بكسلات', 'pixel', 'pixels', 'ممحاة', 'eraser', 'تشويه', 'warp', 'mesh warp', 'عصا سحرية', 'magic wand',
    'تحديد اللون', 'تحديد منطقة', 'selection', 'dodge', 'burn', 'تفتيح موضعي', 'تغميق موضعي', 'smudge', 'تلطيخ']),
  vectorTools: cue(['شعار', 'لوجو', 'لوغو', 'logo', 'أيقونة', 'ايقونة', 'أيقونات', 'icon', 'icons', 'مضلع', 'polygon', 'حلزون', 'spiral',
    'أداة القلم', 'pen tool', 'بيزيه', 'bezier', 'مسار متجه', 'vector path', 'شبكة متجهة', 'vector network', 'squircle', 'boolean',
    'دمج الأشكال', 'طرح الأشكال', 'شكل نجمة', 'star shape', 'دونات', 'donut']),
  editing: cue(['عدّل', 'تعديل', 'تعديلات', 'غيّر', 'حرّك', 'حرك', 'انقل', 'كبّر', 'صغّر', 'محاذاة', 'وزّع', 'توزيع', 'align', 'distribute',
    'resize', 'move', 'edit', 'modify', 'تراجع', 'undo', 'احذف', 'delete']),
  exportFormat: cue(['svg', 'pdf', 'psd', 'فوتوشوب', 'photoshop', 'icc', 'p3', 'display-p3', 'adobe rgb', 'adobe-rgb', 'للطباعة', 'print', 'bundle']),
  education: cue(['قالب درس', 'قالب تعليمي', 'إنفوجرافيك', 'انفوجرافيك', 'افوجرافيك', 'انفوغرافيك', 'إنفوغرافيك',
    'درس مصور', 'lesson template', 'lesson card', 'infographics?']),
  editorial: cue(['مجل[ةه]', 'غلاف مجلة', 'غلاف مجله', 'magazine(?: cover)?', 'editorial cover']),
  promotion: cue(['بطاق(?:ة|ات)', 'بطاقه', 'إعلانات?', 'اعلانات?', 'إعلان', 'اعلان', 'بوسترات?', 'بوستر',
    'ملصق', 'بنرات?', 'بانرات?', 'بنر', 'بانر', 'cards?', 'banners?', 'posters?', 'advertisements?', 'flyers?']),
  identity: cue(['شعار', 'شعارات', 'لوقو', 'لوجو', 'لوغو', 'logos?', 'monogram', 'wordmark']),
  // Ornamental compositions: strong words always; weak words («زخارف») only outside card/poster/logo/magazine/lesson
  // requests, mirroring intent.js, so «بطاقة دعوة بزخارف» keeps its layout guide alone.
  ornamentStrong: cue(['عنقاء', 'العنقاء', 'فينيق', 'الفينيق', 'فينكس', 'phoenix', 'بيزلي', 'paisley', 'أرابيسك', 'ارابيسك', 'arabesque', 'art nouveau', 'filigree',
    'زهرة المد', 'زهرة زخرفية', 'طائر زخرفي', 'تكوين زخرفي', 'لوحة زخرفية', 'رسمة زخرفية', 'رسم زخرفي', 'ornamental composition', 'ornamental flower']),
  ornamentWeak: cue(['زخرفي', 'زخرفية', 'زخارف', 'زخرفة', 'مزخرف', 'مزخرفة', 'ornament', 'ornamental', 'decorative']),
  vectorColour: cue(['إليستريتور', 'اليستريتور', 'illustrator', 'gradient(?: mesh| blend)?', 'opacity mask',
    'color blending', 'colour blending', 'blend tool', 'اندماج الألوان', 'اندماج الالوان', 'دمج الألوان', 'دمج الالوان',
    'مزج الألوان', 'مزج الالوان', 'تدرج لوني', 'تدرجات لونية', 'تدرج الألوان', 'تدرج الالوان', 'شبكة تدرج']),
};

function featuresOf(understanding, input) {
  const u = understanding || { entities: [], relations: [], constraints: {}, designType: 'text', ambiguities: [] };
  const opts = input || {};
  const motifs = u.entities.map((e) => e.motif);
  const c = u.constraints || {};
  const text = [opts.headline, opts.body, opts.kicker].filter(Boolean).join(' ');
  const ask = String(opts.prompt || '');
  const educationLayout = CUES.education.test(ask);
  const firstLayout = ['editorial', 'promotion', 'identity']
    .map(kind => ({ kind, position: ask.search(CUES[kind]) }))
    .filter(match => match.position >= 0)
    .sort((a, b) => a.position - b.position)[0]?.kind;
  const editorialLayout = !educationLayout && firstLayout === 'editorial';
  const promotionLayout = !educationLayout && (firstLayout === 'promotion' || (!firstLayout && opts.designType === 'card'));
  const identityLayout = !educationLayout && firstLayout === 'identity';
  const f = {
    picture: PICTURE.includes(u.designType),
    text: Boolean(text) || ['poster', 'card', 'text'].includes(u.designType),
    arabicText: /[؀-ۿ]/.test(text) || (['poster', 'card', 'text', 'ruled'].includes(u.designType) && /[؀-ۿ]/.test(String(opts.prompt || ''))),
    poster: ['poster', 'card'].includes(u.designType),
    table: u.designType === 'table' || Boolean(opts.table),
    ruled: u.designType === 'ruled' || Boolean(opts.ruled),
    reference: u.designType === 'reference' || Boolean(opts.referenceImage || opts.referenceAnalysis),
    abstract: u.designType === 'abstract',
    character: u.designType === 'character',
    person: motifs.includes('person') || u.designType === 'character',
    outdoor: ['landscape', 'architecture'].includes(u.designType) || motifs.some((m) => NATURE.includes(m)),
    nature: motifs.filter((m) => NATURE.includes(m)).length >= 2 || u.designType === 'landscape',
    materials: motifs.filter((m) => MATERIAL.includes(m)).length >= 2,
    perspective: ['architecture', 'scene'].includes(u.designType) || c.viewpoint !== 'eye',
    viewpoint: Boolean(c.viewpoint && c.viewpoint !== 'eye'),
    relations: (u.relations || []).length > 0,
    counts: u.entities.some((e) => e.count > 1),
    negations: (c.excluded || []).length > 0,
    ambiguous: (u.ambiguities || []).length > 0,
    lighting: Boolean(c.lighting),
    mood: (c.moods || []).length > 0,
    style: Boolean(c.style && c.style !== 'illustration'),
    painterly: c.style === 'painterly',
    palette: (c.palette || []).length > 0 || Boolean(opts.palettes),
    composition: Boolean(c.composition),
    detailHigh: c.detail === 'high',
    sceneSpec: Boolean(opts.sceneSpec),
    engineGraph: opts.engine === 'scene-graph',
    artDirection: Boolean(opts.artDirection),
    designSystem: Boolean(opts.designSystemId),
    books: Array.isArray(opts.books) && opts.books.length > 0,
    manualEdit: Boolean(opts.manualEdit),
    photoEdit: CUES.photoEdit.test(ask),
    retouch: CUES.retouch.test(ask),
    vectorTools: CUES.vectorTools.test(ask),
    editing: Boolean(opts.documentId) || CUES.editing.test(ask),
    exportFormat: CUES.exportFormat.test(ask) || ['svg', 'pdf', 'psd', 'bundle'].includes(String(opts.format || '')),
    educationLayout,
    editorialLayout,
    promotionLayout,
    identityLayout,
    vectorColour: CUES.vectorColour.test(ask),
    ornament: CUES.ornamentStrong.test(ask) || (CUES.ornamentWeak.test(ask) && !firstLayout && !educationLayout && opts.designType !== 'card'),
    routingQuery: Boolean(opts.routingQuery),
    unsupported: Boolean(opts.unsupported),
    delivery: true,
  };
  return f;
}

function routeSkills(understanding, input, options) {
  const opts = options || {};
  const budget = Number(opts.budgetTokens || 9000);
  const maxSkills = Number(opts.maxSkills || 5);
  const features = featuresOf(understanding, input);
  const scored = REGISTRY.map((skill) => {
    const reasons = Object.entries(skill.triggers || {}).filter(([k]) => features[k]).map(([k, w]) => ({ feature: k, weight: w }));
    return { skill, score: skill.always ? Infinity : reasons.reduce((s, r) => s + r.weight, 0), reasons, tokens: tokensOf(skill) };
  });
  const excluded = [];
  let chosen = scored.filter((s) => s.score >= 2 || s.skill.always).sort((a, b) => b.score - a.score);
  for (const s of scored) if (!chosen.includes(s)) excluded.push({ id: s.skill.id, reason: s.score ? `score ${s.score} below threshold 2` : 'no matching feature' });

  // Conflicts: keep the higher score.
  for (const s of chosen.slice()) {
    for (const other of s.skill.conflicts || []) {
      const o = chosen.find((c) => c.skill.id === other);
      if (o && chosen.includes(s) && o.score <= s.score) { chosen = chosen.filter((c) => c !== o); excluded.push({ id: other, reason: `conflicts with ${s.skill.id}` }); }
    }
  }
  // Dependencies.
  for (const s of chosen.slice()) {
    for (const dep of s.skill.requires || []) {
      if (chosen.some((c) => c.skill.id === dep)) continue;
      const d = scored.find((x) => x.skill.id === dep);
      if (d) { chosen.push(Object.assign({}, d, { score: s.score - 0.5, requiredBy: s.skill.id })); const i = excluded.findIndex((e) => e.id === dep); if (i >= 0) excluded.splice(i, 1); }
    }
  }
  // Duplicates: a skill whose topics are all covered by higher-scored chosen skills adds nothing.
  chosen.sort((a, b) => b.score - a.score);
  const covered = new Set();
  chosen = chosen.filter((s) => {
    const fresh = s.skill.covers.filter((t) => !covered.has(t));
    if (!fresh.length && !s.skill.always) { excluded.push({ id: s.skill.id, reason: 'topics already covered' }); return false; }
    s.skill.covers.forEach((t) => covered.add(t));
    return true;
  });
  const art = chosen.filter(s => s.skill.group === 'art').sort((a,b)=>b.score-a.score);
  const extraArt = new Set(art.slice(3).map(s=>s.skill.id));
  chosen = chosen.filter(s => { if (!extraArt.has(s.skill.id)) return true; excluded.push({id:s.skill.id,reason:'maximum 3 general art guides'}); return false; });
  // Budget and count: drop the lowest scores (never the procedure, never a dependency of a kept skill).
  const total = () => chosen.reduce((sum, s) => sum + s.tokens, 0);
  while ((total() > budget || chosen.length > maxSkills) && chosen.length > 1) {
    const victims = chosen.filter((s) => !s.skill.always && !chosen.some((k) => k !== s && (k.skill.requires || []).includes(s.skill.id)));
    if (!victims.length) break;
    const v = victims.reduce((min, s) => (s.score < min.score ? s : min));
    chosen = chosen.filter((s) => s !== v);
    excluded.push({ id: v.skill.id, reason: total() > budget ? 'context budget' : `limit of ${maxSkills} skills` });
  }
  chosen.sort((a, b) => PHASES.indexOf(a.skill.phase) - PHASES.indexOf(b.skill.phase) || b.score - a.score);
  return {
    version: 1,
    budgetTokens: budget,
    usedTokens: total(),
    skills: chosen.map((s, i) => ({
      order: i + 1,
      id: s.skill.id,
      group: s.skill.group,
      phase: s.skill.phase,
      score: s.score === Infinity ? 'always' : s.score,
      tokens: s.tokens,
      reasons: s.requiredBy ? [`required by ${s.requiredBy}`] : s.reasons.map((r) => `${r.feature}+${r.weight}`),
    })),
    excluded: excluded.filter((e, i, all) => all.findIndex((x) => x.id === e.id) === i && !chosen.some((c) => c.skill.id === e.id)),
    features: Object.keys(features).filter((k) => features[k]),
  };
}

module.exports = { routeSkills, featuresOf };
