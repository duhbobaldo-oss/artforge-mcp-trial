'use strict';

/**
 * Request understanding (stage ②): turns the user's words into a structured request instead of a bag of keywords.
 *
 * Built on top of `analyzeIntent` (design type + element lexicon + counts), it adds what the composers never saw:
 *   - entities with their own attributes (colour and size written next to the noun),
 *   - spatial relations between entities ("مصباح بجانب الكنبة", "a cat under the table", "بين شجرتين"),
 *   - negated elements ("بدون أشجار", "no people") that must NOT be drawn,
 *   - constraints: viewpoint, mood, global colours, composition, level of detail, no-text, canvas.
 * Everything is derived from tokens of the request; nothing is guessed silently. Ambiguities are listed.
 */

const { analyzeIntent, normalizeArabic, ELEMENT_LEXICON, COLOR_WORDS, tokenMatches } = require('./intent');
const { motifOf } = require('./motifs');

const RELATIONS = {
  on: ['على', 'على سطح', 'فوق سطح', 'on', 'on top of', 'upon'],
  above: ['فوق', 'اعلى', 'above', 'over'],
  below: ['تحت', 'اسفل', 'اسفل من', 'under', 'below', 'beneath', 'underneath'],
  beside: ['بجانب', 'جانب', 'بجوار', 'جوار', 'قرب', 'بقرب', 'عند', 'next to', 'beside', 'near', 'by'],
  behind: ['خلف', 'وراء', 'behind'],
  front: ['امام', 'قدام', 'in front of'],
  left: ['يسار', 'على يسار', 'الى يسار', 'left of', 'to the left of'],
  right: ['يمين', 'على يمين', 'الى يمين', 'right of', 'to the right of'],
  inside: ['داخل', 'بداخل', 'في داخل', 'inside', 'within'],
  between: ['بين', 'between'],
  facing: ['يواجه', 'تواجه', 'مقابل', 'facing', 'opposite'],
};

const VIEWPOINTS = {
  top: ['من الاعلى', 'منظور علوي', 'عين الطائر', 'لقطه علويه', 'top view', 'top-down', 'bird s eye', 'birds eye', 'aerial'],
  low: ['من الاسفل', 'زاويه منخفضه', 'منظور منخفض', 'low angle', 'worm s eye', 'from below'],
  closeup: ['لقطه قريبه', 'عن قرب', 'مقرب', 'close-up', 'closeup', 'close up'],
  wide: ['بانورامي', 'لقطه واسعه', 'منظر واسع', 'panoramic', 'wide shot', 'wide angle'],
};

const MOODS = {
  calm: ['هادي', 'هادئ', 'هادئه', 'سكينه', 'هدوء', 'calm', 'peaceful', 'serene', 'quiet'],
  warm: ['دافي', 'دافئ', 'دافئه', 'دفء', 'مريح', 'مريحه', 'warm', 'cozy', 'cosy'],
  cool: ['بارد', 'بارده', 'برود', 'cold', 'cool', 'icy'],
  dramatic: ['درامي', 'دراميه', 'ملحمي', 'dramatic', 'epic', 'moody'],
  cheerful: ['مبهج', 'مبهجه', 'مرح', 'مرحه', 'سعيد', 'cheerful', 'happy', 'joyful', 'vibrant'],
  mysterious: ['غامض', 'غامضه', 'غموض', 'mysterious', 'eerie'],
  melancholic: ['حزين', 'حزينه', 'كئيب', 'sad', 'melancholic', 'gloomy'],
};

const SIZE_WORDS = {
  large: ['كبير', 'كبيره', 'ضخم', 'ضخمه', 'عملاق', 'large', 'big', 'huge', 'giant', 'tall', 'طويل', 'طويله'],
  small: ['صغير', 'صغيره', 'ضئيل', 'small', 'little', 'tiny', 'short'],
};

// Building materials: «منزل من حجر», «بيت خشبي», "stone house", "house made of brick". Normalised forms (ة→ه).
const MATERIAL_WORDS = {
  stone: ['حجر', 'حجري', 'حجريه', 'حجارة', 'حجاره', 'احجار', 'صخر', 'صخري', 'صخريه', 'stone', 'stones', 'stony', 'cobblestone', 'fieldstone'],
  brick: ['طوب', 'طوبي', 'طوبيه', 'اجر', 'اجري', 'brick', 'bricks'],
  wood: ['خشب', 'خشبي', 'خشبيه', 'خشبيا', 'خشبا', 'اخشاب', 'wood', 'wooden', 'timber', 'log', 'logs'],
};
const MATERIAL_MOTIFS = new Set(['house', 'building', 'tower', 'lighthouse']);

function materialNear(tokens, from, to) {
  for (let k = Math.max(0, from); k < Math.min(tokens.length, to); k += 1) {
    if (tokens[k] === BOUNDARY) break;
    const t = tokens[k].replace(/^(و|ب|ال|بال|من)(?=..)/, '');
    for (const [material, words] of Object.entries(MATERIAL_WORDS)) if (words.includes(t) || words.includes(tokens[k])) return material;
  }
  return null;
}

const COMPOSITION_WORDS = {
  center: ['في المنتصف', 'في الوسط', 'بالمنتصف', 'بالوسط', 'مركزي', 'centered', 'in the center', 'in the middle'],
  symmetric: ['متماثل', 'متناظر', 'تماثل', 'symmetric', 'symmetrical'],
  thirds: ['قاعده الاثلاث', 'الاثلاث', 'rule of thirds', 'thirds'],
};

const DETAIL_WORDS = {
  low: ['بسيط', 'بسيطه', 'مبسط', 'مبسطه', 'minimal', 'simple', 'minimalist'],
  high: ['مفصل', 'مفصله', 'دقيق', 'دقيقه', 'تفاصيل', 'detailed', 'intricate', 'highly detailed'],
};

const NEGATIONS = ['بدون', 'دون', 'بلا', 'من غير', 'لا يوجد', 'ليس فيه', 'ليس فيها', 'without', 'no', 'not', 'never'];
const PRONOUN_SUFFIX = /(ه|ها|هم|هما)$/;

function splitPrompt(normalized) {
  return normalized
    .replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)))
    .replace(/[’']/g, ' ')
    // Clause boundaries survive as «§» so relations never reach across a comma or a full stop.
    .replace(/[،,.؛;:!؟?\n]+/g, ' § ')
    .split(/[^\p{L}\p{N}§-]+/u)
    .filter(Boolean);
}

function tokenize(text) {
  const tokens = splitPrompt(normalizeArabic(text));
  // Tokens that ended in «ة» before normalisation (aligned 1:1): that ending is never the pronoun «ه»,
  // so «كتابة» (writing) is not read as «كتابه» (his book).
  const raw = splitPrompt(normalizeArabic(text, true));
  tokens.taMarbuta = new Set();
  raw.forEach((t, i) => { if (t.endsWith('ة')) tokens.taMarbuta.add(i); });
  return tokens;
}

const BOUNDARY = '§';
function sameClause(tokens, a, b) {
  for (let i = Math.min(a, b); i < Math.max(a, b); i += 1) if (tokens[i] === BOUNDARY) return false;
  return true;
}

/** Phrase match at token i; returns the number of tokens consumed (0 = no match). */
const phraseCache = new Map();
function phraseParts(phrase) {
  if (!phraseCache.has(phrase)) phraseCache.set(phrase, tokenize(phrase));
  return phraseCache.get(phrase);
}

function phraseAt(tokens, i, phrase, exact) {
  const parts = phraseParts(phrase);
  if (!parts.length || i + parts.length > tokens.length) return 0;
  for (let k = 0; k < parts.length; k += 1) {
    const t = tokens[i + k];
    const p = parts[k];
    const latin = /^[a-z0-9-]+$/.test(p);
    const ok = latin ? (t === p || t === `${p}s`) : (exact ? t === p || t === `و${p}` : tokenMatches(t, p, Boolean(tokens.taMarbuta && tokens.taMarbuta.has(i + k))));
    if (!ok) return 0;
  }
  return parts.length;
}

/** First lexicon key whose phrase matches at i, longest phrase first. */
function lexiconAt(tokens, i, lexicon, exact) {
  let best = null;
  for (const [key, phrases] of Object.entries(lexicon)) {
    for (const phrase of phrases) {
      const n = phraseAt(tokens, i, phrase, exact);
      if (n && (!best || n > best.length)) best = { key, length: n, phrase };
    }
  }
  return best;
}

function findAll(tokens, lexicon, exact) {
  const out = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const hit = lexiconAt(tokens, i, lexicon, exact);
    if (hit) { out.push(Object.assign({ index: i }, hit)); i += hit.length - 1; }
  }
  return out;
}

/** Element mentions in token order. Relation words are excluded first so «جانب» is not read as an object. */
const EXACT_WORDS = { desk: ['مكتب'] };

function mentions(tokens, elementIds) {
  const lexicon = {};
  for (const id of elementIds) lexicon[id] = (ELEMENT_LEXICON[id] || [id]).concat([id]);
  const out = findAll(tokens, lexicon).map((m) => ({ id: m.key, index: m.index, length: m.length }));
  for (const [id, words] of Object.entries(EXACT_WORDS)) {
    if (!elementIds.includes(id)) continue;
    tokens.forEach((t, index) => {
      if (words.some((w) => ['', 'ال', 'و', 'وال', 'ب', 'بال'].some((p) => t === p + w)) && !out.some((m) => m.index === index)) out.push({ id, index, length: 1 });
    });
  }
  for (const d of duals(tokens)) if (elementIds.includes(d.id) && !out.some((m) => m.index === d.index)) out.push({ id: d.id, index: d.index, length: 1 });
  return out.sort((a, b) => a.index - b.index);
}

/** Arabic dual nouns («شجرتين», «كرسيين», «قلمان») name exactly two instances. Forms are built once. */
const DUAL_FORMS = new Map();
for (const [id, words] of Object.entries(ELEMENT_LEXICON)) {
  for (const raw of words) {
    const w = normalizeArabic(raw);
    if (/[a-z ]/.test(w) || w.length < 3) continue;
    const stem = w.endsWith('ه') ? `${w.slice(0, -1)}ت` : w;
    for (const form of [`${stem}ين`, `${stem}ان`]) if (!DUAL_FORMS.has(form)) DUAL_FORMS.set(form, id);
  }
}
function duals(tokens) {
  const out = [];
  tokens.forEach((t, index) => {
    const id = DUAL_FORMS.get(t.replace(/^(و|ب|ال|وال|بال)(?=...)/, ''));
    if (id) out.push({ id, index });
  });
  return out;
}

function colorAfter(tokens, i, span) {
  for (let k = i; k < Math.min(tokens.length, i + span); k += 1) {
    const t = tokens[k].replace(/^(و|ب|ال|بال)(?=..)/, '');
    if (COLOR_WORDS[t]) return { word: t, hex: COLOR_WORDS[t], index: k };
  }
  return null;
}

function sizeNear(tokens, i, span) {
  for (let k = i; k < Math.min(tokens.length, i + span); k += 1) {
    const t = tokens[k].replace(/^(و|ال)(?=..)/, '');
    for (const [size, words] of Object.entries(SIZE_WORDS)) if (words.includes(t)) return size;
  }
  return null;
}

function understandRequest(prompt, input, precomputedIntent) {
  const opts = input || {};
  const intent = precomputedIntent || analyzeIntent(prompt, opts);
  const tokens = tokenize(prompt);
  const ambiguities = [];
  // Work on a copy: the composers keep the intent they were built for (they draw e.g. trees as one element,
  // so a dual count added to their intent would report drawn trees as missing).
  const elements = intent.elements.map((e) => Object.assign({}, e));
  // Duals are counts the keyword lexicon cannot see: add or count them before anything else.
  for (const d of duals(tokens)) {
    const known = elements.find((e) => e.id === d.id);
    if (known && !known.count) known.count = 2;
    else if (!known) elements.push({ id: d.id, matched: [tokens[d.index]], count: 2, dual: true });
  }

  // Negated elements: «بدون أشجار» → trees excluded. Only nouns within two tokens of the negation word.
  const negations = findAll(tokens, { neg: NEGATIONS }, true);
  const ids = elements.map((e) => e.id);
  const found = mentions(tokens, ids);
  const excluded = new Set();
  for (const n of negations) {
    const after = found.filter((m) => m.index > n.index && m.index <= n.index + n.length + 1);
    for (const m of after) excluded.add(m.id);
  }
  // An element that is negated AND positively mentioned elsewhere is ambiguous: keep it and say so.
  for (const id of [...excluded]) {
    const positives = found.filter((m) => m.id === id && !negations.some((n) => m.index > n.index && m.index <= n.index + n.length + 1));
    if (positives.length) { excluded.delete(id); ambiguities.push(`«${id}» is both requested and negated; kept`); }
  }

  const entities = elements.filter((e) => !excluded.has(e.id)).map((e) => {
    const first = found.find((m) => m.id === e.id);
    const attributes = {};
    if (e.id === 'person' && intent.pose) attributes.pose = intent.pose;
    if (first) {
      const latinNoun = /^[a-z]/.test(tokens[first.index]);
      // Arabic adjectives follow the noun; English adjectives precede it.
      const color = latinNoun ? colorAfter(tokens, Math.max(0, first.index - 2), 2) : colorAfter(tokens, first.index + first.length, 2);
      if (color) attributes.color = color.hex;
      const size = latinNoun ? sizeNear(tokens, Math.max(0, first.index - 2), 2) : sizeNear(tokens, first.index + first.length, 2);
      if (size) attributes.size = size;
      if (MATERIAL_MOTIFS.has(motifOf(e.id))) {
        // Arabic: the material follows the noun («منزل من حجر», «بيت خشبي»); English: before it ("stone house")
        // or after it ("house of stone", "house made of brick").
        const after = first.index + first.length;
        const material = latinNoun
          ? (materialNear(tokens, first.index - 2, first.index) || materialNear(tokens, after, after + 4))
          : materialNear(tokens, after, after + 3);
        if (material) attributes.material = material;
      }
    }
    return {
      id: e.id,
      motif: motifOf(e.id),
      count: e.count || 1,
      countSource: e.count ? 'text' : 'default',
      attributes,
      explicit: Boolean(e.explicit),
      mentioned: Boolean(first),
    };
  });

  // Discrete plurals are a cardinality constraint, not a singular synonym.
  // An unspecified Arabic plural uses its minimum three; English plural uses two.
  // Keep explicit numbers and duals authoritative and disclose the chosen minimum.
  for(const e of entities.filter(e=>e.countSource==='default')){
    const noun={armchair:{ar:/^(?:و|ال|وال)?كراسي$/,en:/^chairs$/},plate:{ar:/^(?:و|ال|وال)?اطباق$/,en:/^plates$/}}[e.motif];if(!noun)continue;
    const min=tokens.some(t=>noun.ar.test(t))?3:tokens.some(t=>noun.en.test(t))?2:0;
    if(min){e.count=min;e.countSource='plural-minimum';ambiguities.push('Unspecified plural '+e.id+' rendered with minimum '+min+' instances');}
  }
  // Relations: subject = nearest mention before the relation word, object = nearest mention after it.
  // «كنبة وبجانبها مصباح»: a pronoun suffix on the relation word flips the roles (subject comes after).
  // Every prefix/suffix split is tried, so «بجانبها» = بجانب + ها and «خلفه» = خلف + ه, but «الخلفيه» matches nothing.
  const relationHits = [];
  for (let i = 0; i < tokens.length; i += 1) {
    let best = null;
    for (const [key, phrases] of Object.entries(RELATIONS)) {
      for (const phrase of phrases) {
        const parts = phraseParts(phrase);
        if (i + parts.length > tokens.length) continue;
        const ok = parts.every((p, k) => {
          const t = tokens[i + k];
          if (/^[a-z0-9-]+$/.test(p)) return t === p;
          const core = t.replace(/^(و|ف)/, '');
          return [t, core].some((x) => x === p || ['ه', 'ها', 'هم', 'هما', 'ي', 'ك'].some((suf) => x === p + suf));
        });
        if (key === 'on' && /^(?:the )?(?:left|right)(?: |$)/.test(tokens.slice(i + parts.length, i + parts.length + 2).join(' '))) continue;
        if (ok && (!best || parts.length > best.length)) best = { key, length: parts.length, phrase, index: i };
      }
    }
    if (best) { relationHits.push(best); i += best.length - 1; }
  }
  const live = found.filter((m) => !excluded.has(m.id));
  const relations = [];
  for (const r of relationHits) {
    const end = r.index + r.length;
    const before = live.filter((m) => m.index + m.length <= r.index && r.index - (m.index + m.length) <= 5 && sameClause(tokens, m.index, r.index)).pop();
    const afterAll = live.filter((m) => m.index >= end && m.index - end <= 5 && sameClause(tokens, r.index, m.index));
    const relWord = tokens[end - 1];
    const pronoun = PRONOUN_SUFFIX.test(relWord) && !RELATIONS[r.key].some((p) => tokenize(p).pop() === relWord);
    if (r.key === 'between') {
      const subject = before;
      const plural = afterAll.find((m) => (entities.find((e) => e.id === m.id) || {}).count >= 2);
      if (subject && plural && plural.id !== subject.id) relations.push({ subject: subject.id, relation: 'between', object: `${plural.id}#1`, object2: `${plural.id}#2`, words: r.phrase });
      else if (subject && afterAll.length >= 2 && afterAll[0].id !== afterAll[1].id) relations.push({ subject: subject.id, relation: 'between', object: afterAll[0].id, object2: afterAll[1].id, words: r.phrase });
      else if (subject) ambiguities.push(`"${r.phrase}" names fewer than two objects`);
      continue;
    }
    // Who is the subject:
    //  «مصباح بجانب الكنبة»      subject before, object after
    //  «كنبة وبجانبها مصباح»     pronoun suffix: object before, subject(s) after
    //  «وخلف البيت جبال»          fronted (nothing before in the clause): object first, subject(s) after it
    let object;
    let subjects;
    if (pronoun && before && !afterAll.length) {
      // «قاربًا والشمس فوقه»: the subject stands just before the relation, the pronoun points to the noun before it.
      const referent = live.filter((m) => m.index + m.length <= before.index && sameClause(tokens, m.index, before.index)).pop();
      object = referent; subjects = [before];
    } else if (pronoun && before) { object = before; subjects = afterAll; }
    else if (!before && afterAll.length >= 2) { object = afterAll[0]; subjects = afterAll.slice(1); }
    else { object = afterAll[0]; subjects = before ? [before] : []; }
    if (!object || !subjects.length) continue;
    // Coordinated subjects share the relation: «عليه دفتر وثلاثة أقلام» puts both on the desk.
    const chain = [subjects[0]];
    for (const m of subjects.slice(1)) {
      const gap = tokens.slice(chain[chain.length - 1].index + 1, m.index);
      if (/^و/.test(tokens[m.index]) || gap.some((t) => t === 'و' || /^و(ثلاث|اربع|خمس|اثن|واحد|\d)/.test(t) || t === 'and')) chain.push(m);
      else break;
    }
    for (const subject of chain) if (subject.id !== object.id) relations.push({ subject: subject.id, relation: r.key, object: object.id, words: r.phrase });
  }
  // The same pair may be named twice ("on the desk, on top of it"): keep one.
  const uniq = [];
  for (const r of relations) if (!uniq.some((u) => u.subject === r.subject && u.object === r.object && u.relation === r.relation)) uniq.push(r);
  for (let i = 0; i < uniq.length; i += 1) {
    for (let k = i + 1; k < uniq.length; k += 1) {
      const a = uniq[i]; const b = uniq[k];
      if (a.subject === b.subject && a.object === b.object && a.relation !== b.relation
        && ['left:right', 'right:left', 'above:below', 'below:above', 'behind:front', 'front:behind'].includes(`${a.relation}:${b.relation}`)) {
        ambiguities.push(`contradictory relations ${a.subject} ${a.relation}/${b.relation} ${a.object}`);
      }
    }
  }

  // Global colours: colour words not attached to an entity or a garment.
  const attached = new Set();
  for (const e of entities) if (e.attributes.color) attached.add(e.attributes.color);
  for (const v of Object.values(intent.appearance || {})) if (typeof v === 'string') attached.add(v);
  const palette = [];
  tokens.forEach((t) => {
    const w = t.replace(/^(و|ب|ال|بال)(?=..)/, '');
    if (COLOR_WORDS[w] && !attached.has(COLOR_WORDS[w]) && !palette.includes(COLOR_WORDS[w])) palette.push(COLOR_WORDS[w]);
  });

  const firstKey = (lexicon) => { const h = findAll(tokens, lexicon); return h.length ? h[0].key : null; };
  const moods = [...new Set(findAll(tokens, MOODS).map((m) => m.key))];
  const viewpoint = opts.viewpoint || firstKey(VIEWPOINTS) || 'eye';
  const composition = opts.composition || firstKey(COMPOSITION_WORDS) || null;
  const detail = firstKey(DETAIL_WORDS) || 'medium';
  const noText = require('./router').wantsNoText(prompt);

  if (intent.confidence < 0.6) ambiguities.push(`design type "${intent.type}" chosen with low confidence (${intent.confidence}); pass designType to be explicit`);
  if (intent.lighting === 'night' && entities.some((e) => e.motif === 'sun')) ambiguities.push('night lighting requested together with a sun');

  if (entities.some(e=>e.motif==='book') && entities.some(e=>e.motif==='person')
    && /(?:يقرا|تقرا|reading|reads|read a|يحمل|carrying|holding)/i.test(tokens.join(' '))) {
    uniq.push({subject:entities.find(e=>e.motif==='book').id,relation:'held',object:entities.find(e=>e.motif==='person').id,source:'explicit-reading-verb'});
  }
  if(/crescent|هلال/.test(tokens.join(' '))) for(const e of entities) if(e.motif==='moon') e.attributes.phase='crescent';
  const poseWords=[['reading',/reading|يقرا|تقرا/],['walking',/walking|يمشي|مشي/],['carrying',/carrying|يحمل/],['desk',/at (?:a |the )?desk|عند المكتب/],['reclining',/reclining|lying down|مستلقي/],['bending',/bending|منحني/],['seated',/sitting|seated|جالس|يجلس/],['standing',/standing|واقف/]];
  const rigPose=poseWords.find(([,re])=>re.test(tokens.join(' '))) || (opts.artDirection?.anatomy==='rig-v1'?['standing']:null);
  if(rigPose && opts.artDirection && opts.artDirection.anatomy==='rig-v1') for(const e of entities) if(e.motif==='person') e.attributes.rigPose=rigPose[0];
  return {
    version: 1,
    designType: intent.type,
    label: intent.label,
    confidence: intent.confidence,
    reason: intent.reason,
    entities,
    relations: uniq,
    constraints: {
      noText,
      canvas: intent.explicitCanvas || null,
      lighting: intent.lighting,
      style: intent.style,
      pose: intent.pose,
      appearance: intent.appearance,
      viewpoint,
      moods,
      palette,
      composition,
      detail,
      excluded: [...excluded],
    },
    ambiguities,
    tokens: tokens.length,
  };
}

module.exports = { understandRequest, RELATIONS, tokenize };
