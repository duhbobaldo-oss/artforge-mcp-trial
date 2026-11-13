'use strict';

const { motifOf } = require('./motifs');

/**
 * Design intent analysis: decides WHAT kind of design the user asked for (poster, table, ruled page,
 * interior scene, landscape, character, architecture, card, text, reference-based) and WHICH visual
 * elements must appear, so the planner never collapses a scene request into a generic text card.
 */

const DESIGN_TYPES = {
  text: { label: 'تصميم نصي', canvas: { width: 1200, height: 1200 } },
  poster: { label: 'ملصق إعلاني', canvas: { width: 1200, height: 1600 } },
  table: { label: 'تصميم يحتوي على جدول', canvas: { width: 1400, height: 1000 } },
  ruled: { label: 'ورقة مسطرة / محتوى تعليمي', canvas: { width: 1200, height: 2200 } },
  scene: { label: 'رسم مشهد داخلي', canvas: { width: 1600, height: 1000 } },
  character: { label: 'رسم شخصية', canvas: { width: 1000, height: 1400 } },
  landscape: { label: 'منظر طبيعي', canvas: { width: 1600, height: 900 } },
  architecture: { label: 'رسم معماري / منظور', canvas: { width: 1600, height: 1100 } },
  card: { label: 'بطاقة أو دعوة', canvas: { width: 1200, height: 1680 } },
  reference: { label: 'تصميم مرجعي من صورة المستخدم', canvas: { width: 1200, height: 1500 } },
  abstract: { label: 'فن تجريدي / خلفية فنية', canvas: { width: 1000, height: 1500 } },
};

/** Keyword lexicon (Arabic + English). Matching is on normalised text, so diacritics/hamza variants match. */
const TYPE_KEYWORDS = {
  table: ['جدول', 'جداول', 'صفوف', 'اعمده', 'table', 'spreadsheet', 'rows', 'columns'],
  ruled: ['ورق مسطر', 'ورقه مسطره', 'مسطر', 'مسطره', 'اسطر الورقه', 'سطور الورقه', 'ruled', 'lined paper', 'notebook page', 'worksheet'],
  scene: ['غرفه', 'صاله', 'صالون', 'مجلس', 'غرفه معيشه', 'غرفه نوم', 'مطبخ', 'مكتب منزلي', 'داخلي', 'room', 'interior', 'living room', 'bedroom', 'kitchen'],
  character: ['شخصيه', 'بورتريه', 'رسم شخص', 'رسم رجل', 'رسم امراه', 'رسم طفل', 'رسم فتاه', 'character', 'portrait', 'figure drawing', 'full body'],
  landscape: ['منظر طبيعي', 'طبيعه', 'جبال', 'جبل', 'بحر', 'شاطئ', 'غابه', 'صحراء', 'غروب', 'شروق', 'نهر', 'بحيره', 'ريف', 'وادي', 'landscape', 'mountain', 'sea', 'beach', 'forest', 'desert', 'sunset', 'sunrise', 'river', 'lake', 'coast', 'ساحل', 'ساحلي', 'منارة', 'منارة', 'lighthouse'],
  architecture: ['مدينه', 'مدن', 'ساحه المدينه', 'افق المدينه', 'city', 'cityscape', 'skyline', 'downtown', 'مبنى', 'مباني', 'عماره', 'معماري', 'برج', 'ناطحه', 'نقطتي تلاشي', 'نقطه تلاشي', 'منظور معماري', 'واجهه', 'building', 'architecture', 'architectural', 'skyscraper', 'tower', 'two-point', 'vanishing point', 'facade'],
  abstract: ['تجريدي', 'تجريديه', 'فن تجريدي', 'لوحه تجريديه', 'abstract', 'باوهاوس', 'bauhaus', 'اشكال هندسيه', 'تكوين هندسي', 'geometric art', 'geometric', 'دخان ملون', 'smoke art', 'سائل', 'fluid', 'تموجات', 'بقع الوان', 'بقع طلاء', 'بقع', 'طلاء', 'رشقات الوان', 'رشقه', 'splash', 'splatter', 'paint splash', 'صلصال', 'clay', 'طين', 'ثلاثي الابعاد ناعم', 'soft 3d', 'خلفيه فنيه', 'خلفيه جوال', 'wallpaper', 'ورق حائط'],
  card: ['بطاقه', 'دعوه', 'تهنئه', 'معايده', 'كرت', 'card', 'invitation', 'greeting'],
  poster: ['ملصق', 'بوستر', 'اعلان', 'اعلاني', 'دعائي', 'poster', 'flyer', 'advert', 'billboard'],
  text: ['تصميم نصي', 'اقتباس', 'عباره', 'مقوله', 'quote', 'typography', 'نص فقط'],
  reference: ['مثل الصوره', 'من الصوره', 'بناء على الصوره', 'الصوره المرفقه', 'الصوره المرجعيه', 'reference image', 'based on the image', 'like this image'],
};

/** Visual elements the composer can draw (ids map to motif functions). */
const ELEMENT_LEXICON = {
  ...require('./subjects'),
  desk: ['مكتب خشبي', 'سطح مكتب', 'طاوله عمل', 'desk', 'tabletop'],
  notebook: ['دفتر', 'مفكره', 'كراسه', 'كشكول', 'notebook'],
  pen: ['قلم', 'اقلام', 'pen', 'pencil'],
  bookshelf: ['مكتبه', 'رفوف كتب', 'رف كتب', 'رفوف', 'كتب', 'bookshelf', 'bookcase', 'books'],
  tv: ['تلفزيون', 'تلفاز', 'تليفزيون', 'شاشه تلفاز', 'شاشه', 'tv', 'television'],
  person: ['شخص', 'رجل', 'امراه', 'فتاه', 'ولد', 'طفل', 'انسان', 'جالس', 'يجلس', 'person', 'man', 'woman', 'girl', 'boy', 'human', 'sitting', 'seated'],
  sofa: ['كنبه', 'اريكه', 'كنب', 'sofa', 'couch'],
  armchair: ['كراسي', 'كراسي طعام', 'كرسي', 'مقعد', 'كرسي مريح', 'armchair', 'chair'],
  lamp: ['مصباح', 'اباجوره', 'ابجوره', 'اضاءه ارضيه', 'lamp'],
  window: ['نافذه', 'شباك', 'نوافذ', 'window'],
  plant: ['نبته', 'نبات', 'زرع', 'اصيص', 'plant'],
  rug: ['سجاده', 'زوليه', 'rug', 'carpet'],
  clock: ['ساعه حائط', 'ساعه', 'clock'],
  frame: ['لوحه على الجدار', 'صوره معلقه', 'برواز', 'frame', 'wall art'],
  coffeeTable: ['طاوله', 'طاوله قهوه', 'coffee table', 'side table'],
  sun: ['شمس', 'مشمس', 'sun', 'sunny'],
  moon: ['قمر', 'هلال', 'moon'],
  stars: ['نجوم', 'نجمه', 'stars'],
  clouds: ['غيوم', 'سحاب', 'غيم', 'clouds'],
  mountains: ['جبال', 'جبل', 'mountains', 'mountain'],
  hills: ['تلال', 'تل', 'hills'],
  sea: ['بحر', 'محيط', 'ساحل', 'ساحلي', 'شاطئ', 'sea', 'ocean', 'coast', 'beach'],
  river: ['نهر', 'جدول ماء', 'river', 'stream'],
  lake: ['بحيره', 'lake'],
  trees: ['اشجار', 'شجره', 'شجر', 'غابه', 'trees', 'tree', 'forest'],
  palms: ['نخيل', 'نخله', 'palm', 'palms'],
  dunes: ['صحراء', 'كثبان', 'رمال', 'desert', 'dunes'],
  rocks: ['صخور', 'صخره', 'rocks', 'rock'],
  boat: ['قارب', 'سفينه', 'مركب', 'boat', 'ship'],
  lighthouse: ['منارة', 'منارة', 'lighthouse'],
  house: ['بيت', 'منزل', 'كوخ', 'اكواخ', 'house', 'cabin', 'hut', 'cottage', 'chalet'],
  farm: ['مزرعه', 'مزارع', 'حقل', 'حقول', 'farm', 'farmland', 'crop field', 'wheat field'],
  fence: ['سياج', 'سور خشبي', 'fence'],
  birds: ['طيور', 'طائر', 'birds'],
  flowers: ['زهور', 'ورود', 'ازهار', 'flowers'],
  grass: ['عشب', 'حشائش', 'grass', 'meadow'],
  building: ['مبنى', 'عماره', 'مباني', 'building'],
  tower: ['برج', 'ناطحه', 'tower', 'skyscraper'],
  road: ['شارع', 'طريق', 'road', 'street'],
  garden: ['حديقه', 'حدائق', 'منتزه', 'بستان', 'garden', 'park'],
  sky: ['سماء', 'sky'],
};

/** Colour words (normalised Arabic + English) → hex. */
const COLOR_WORDS = {
  ازرق: '#2f6fb0', زرقاء: '#2f6fb0', blue: '#2f6fb0', احمر: '#c0392b', حمراء: '#c0392b', red: '#c0392b',
  اخضر: '#3d8b4f', خضراء: '#3d8b4f', green: '#3d8b4f', اسود: '#1e1e22', سوداء: '#1e1e22', black: '#1e1e22',
  ابيض: '#f2f0ea', بيضاء: '#f2f0ea', white: '#f2f0ea', بني: '#8a5a3b', بنيه: '#8a5a3b', brown: '#8a5a3b',
  رمادي: '#8a8f98', رماديه: '#8a8f98', grey: '#8a8f98', gray: '#8a8f98', اصفر: '#e8c547', صفراء: '#e8c547', yellow: '#e8c547',
  برتقالي: '#e67e22', orange: '#e67e22', وردي: '#e58fb0', pink: '#e58fb0', بنفسجي: '#7d4fa6', purple: '#7d4fa6',
  كحلي: '#1f2f5a', navy: '#1f2f5a', بيج: '#d8c3a0', beige: '#d8c3a0', ذهبي: '#c9a227', golden: '#c9a227',
  داكن: '#2b1d16', غامق: '#2b1d16', dark: '#2b1d16', اشقر: '#d9b36c', شقراء: '#d9b36c', blond: '#d9b36c', blonde: '#d9b36c',
};
const GARMENTS = {
  shirt: ['قميص', 'تيشيرت', 'تيشرت', 'بلوزه', 'سترة', 'ستره', 'shirt', 't-shirt', 'tshirt', 'blouse'],
  pants: ['بنطال', 'بنطلون', 'جينز', 'سروال', 'pants', 'trousers', 'jeans'],
  shoe: ['حذاء', 'احذيه', 'جزمه', 'shoes', 'shoe', 'sneakers', 'boots'],
  hair: ['شعر', 'hair'],
};

/**
 * Appearance written in the request: "قميص أزرق، بنطال بني، حذاء أبيض، شعر داكن قصير، يبتسم".
 * A colour must follow its garment within three words, before the next garment.
 */
function parseAppearance(normalized) {
  const tokens = normalized.split(/[^\p{L}\p{N}-]+/u).filter(Boolean);
  const strip = (t) => t.replace(/^(و|ب|ل|ال|وال|بال)(?=..)/, '');
  const garmentOf = (t) => Object.entries(GARMENTS).find(([, words]) => words.some((w) => strip(t) === normalizeArabic(w) || t === normalizeArabic(w)));
  const out = {};
  tokens.forEach((token, i) => {
    const g = garmentOf(token);
    if (!g) return;
    for (let k = i + 1; k <= i + 3 && k < tokens.length; k += 1) {
      if (garmentOf(tokens[k])) break;
      const c = COLOR_WORDS[strip(tokens[k])] || COLOR_WORDS[tokens[k]];
      if (c && !out[g[0]]) { out[g[0]] = c; break; }
    }
    if (g[0] === 'hair') {
      const near = tokens.slice(i + 1, i + 4).map(strip);
      if (near.includes('طويل') || near.includes('long')) out.hairLength = 'long';
      if (near.includes('قصير') || near.includes('short')) out.hairLength = 'short';
    }
  });
  if (/(يبتسم|تبتسم|مبتسم|مبتسمه|ابتسامه|smil)/.test(normalized)) out.smile = true;
  if (/(امراه|فتاه|سيده|بنت|woman|girl|lady)/.test(normalized)) out.gender = 'female';
  else if (/(رجل|شاب|ولد|man|boy)/.test(normalized)) out.gender = 'male';
  return out;
}

const LIGHTING_KEYWORDS = {
  morning: ['صباح', 'صباحي', 'صباحيه', 'شروق', 'نهار', 'نهاري', 'ضوء الشمس', 'morning', 'daylight', 'sunrise', 'day'],
  night: ['ليل', 'ليلي', 'ليليه', 'ليلا', 'منتصف الليل', 'مساء', 'night', 'nighttime', 'evening', 'moonlight'],
  sunset: ['غروب', 'الغروب', 'sunset', 'dusk', 'golden hour'],
  overcast: ['غائم', 'ملبد', 'overcast', 'cloudy'],
};

/**
 * Ornamental compositions (composer/ornamental.js). Strong words name the genre and always mean an ornamental
 * picture; weak words («زخارف», "decorative") only count when no card/poster/text/table/room words are present,
 * so «بطاقة دعوة بزخارف» stays a card.
 */
const ORNAMENT_STRONG = ['عنقاء', 'العنقاء', 'فينيق', 'الفينيق', 'فينكس', 'phoenix', 'بيزلي', 'paisley', 'ارابيسك', 'arabesque', 'art nouveau', 'ارت نوفو', 'filigree',
  'تكوين زخرفي', 'لوحه زخرفيه', 'رسمه زخرفيه', 'رسم زخرفي', 'زهره زخرفيه', 'زهور زخرفيه', 'طائر زخرفي', 'طاير زخرفي', 'زهره المد', 'tide flower', 'ornamental composition', 'ornamental flower', 'ornamental bird'];
const ORNAMENT_WEAK = ['زخرفي', 'زخرفيه', 'زخارف', 'زخرفه', 'مزخرف', 'مزخرفه', 'ornament', 'ornamental', 'decorative'];
const ORNAMENT_BIRD = ['عنقاء', 'العنقاء', 'فينيق', 'الفينيق', 'فينكس', 'phoenix', 'طائر', 'طاير', 'طيور', 'bird'];

/** Abstract art styles (each maps to a drawer in composer/abstract.js). */
const ABSTRACT_STYLE_KEYWORDS = {
  ornamental: ORNAMENT_STRONG.concat(ORNAMENT_WEAK),
  splash: ['بقع', 'رشق', 'رش', 'دهان', 'طلاء', 'splash', 'splatter', 'paint'],
  fluid: ['دخان', 'سائل', 'تموج', 'انسياب', 'حرير', 'شرائط', 'smoke', 'fluid', 'flow', 'ribbon', 'silk', 'swirl', 'كرات'],
  clay: ['صلصال', 'طين', 'ثلاثي الابعاد', 'ناعم', 'باستيل', 'لوحه تحكم', 'واجهه', 'clay', 'soft 3d', '3d', 'pastel', 'dashboard', 'ui'],
  geometric: ['هندسي', 'هندسيه', 'باوهاوس', 'دوائر', 'خطوط', 'اقواس', 'geometric', 'bauhaus', 'circles', 'arcs', 'mid-century'],
};

const STYLE_KEYWORDS = {
  painterly: ['فرش', 'فرشاه', 'زيتي', 'مائي', 'لوحه فنيه', 'رسم فني', 'خلط الالوان', 'تدرجات', 'painterly', 'painting', 'brush', 'oil', 'watercolor', 'watercolour'],
  sketch: ['رصاص', 'اسكتش', 'سكتش', 'تخطيط', 'pencil', 'sketch'],
  flat: ['مسطح', 'فلات', 'flat', 'vector', 'minimal'],
};

/** Normalise Arabic for matching: drop tatweel/diacritics, unify alef/ya/ta marbuta. */
function normalizeArabic(text, keepTaMarbuta) {
  const base = String(text || '')
    .toLowerCase()
    .replace(/[ً-ْـ]/g, '')
    .replace(/[إأآٱ]/g, 'ا')
    .replace(/ى/g, 'ي');
  return (keepTaMarbuta ? base : base.replace(/ة/g, 'ه'))
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي');
}

/**
 * Normalisation merges «ة» into «ه», which makes «كتابة» (writing) look like «كتابه» (his book).
 * The possessive suffix is always «ه», never «ة», so we remember which tokens ended in «ة» in the
 * original text (same split, aligned token for token) and refuse to read that ending as a suffix.
 */
function taMarbutaTokens(text, split) {
  const raw = split(normalizeArabic(text, true));
  const out = new Set();
  raw.forEach((t, i) => { if (t.endsWith('ة')) out.add(i); });
  return out;
}

const AR_PREFIXES = ['وبال', 'وال', 'بال', 'كال', 'فال', 'لل', 'ال', 'و', 'ف', 'ب', 'ل', 'ك'];
const AR_SUFFIXES = ['', 'ات', 'ين', 'ون', 'ان', 'ه', 'ها', 'هم', 'ي', 'يه', 'يات'];
const NISBA_SUFFIXES = ['ي', 'يه', 'يات'];

/** Word-level match so "تل" never matches inside "تلفزيون" and "صباح" never inside "مصباح". */
function tokenMatches(token, word, endsWithTaMarbuta) {
  for (const prefix of AR_PREFIXES.concat([''])) {
    if (prefix && !token.startsWith(prefix)) continue;
    const stem = token.slice(prefix.length);
    if (!stem.startsWith(word)) continue;
    const suffix = stem.slice(word.length);
    // A final «ة» is the feminine ending of a different word (كتابة، شمسية), not the pronoun «ه».
    if (endsWithTaMarbuta && suffix && suffix.endsWith('ه')) continue;
    // The article «ال» never takes the possessive «ي» («السحابي» cannot mean "my cloud"): after it,
    // «ي/يه/يات» form a relational adjective (السحابي = cloud-based, الشمسي = solar), not the object.
    if (prefix.endsWith('ال') && NISBA_SUFFIXES.includes(suffix)) continue;
    if (AR_SUFFIXES.includes(suffix)) return true;
    // Indefinite accusative «قاربًا»/«برجًا»: the tanween is stripped, leaving a final alif.
    if (suffix === 'ا' && word.length >= 3 && !word.endsWith('ا')) return true;
  }
  return false;
}

const splitTokens = (text) => text.split(/[^\p{L}\p{N}-]+/u).filter(Boolean);

function hits(normalized, words, original) {
  const found = [];
  const tokens = splitTokens(normalized);
  const ta = original === undefined ? new Set() : taMarbutaTokens(original, splitTokens);
  for (const word of words) {
    const w = normalizeArabic(word);
    if (!w) continue;
    const latin = /^[a-z0-9 -]+$/.test(w);
    let ok;
    if (latin) ok = new RegExp(`\\b${w.replace(/[-]/g, '\\-')}s?\\b`).test(normalized);
    else if (w.includes(' ')) {
      const parts = w.split(' ');
      ok = tokens.some((_, i) => parts.every((part, k) => tokens[i + k] && tokenMatches(tokens[i + k], part, ta.has(i + k))));
    } else ok = tokens.some((token, i) => tokenMatches(token, w, ta.has(i)));
    if (ok) found.push(word);
  }
  return found;
}

/**
 * Words too short or too ambiguous for substring matching.
 * «مكتب» (desk) sits inside «مكتبه» (bookshelf), so it must match a whole token only.
 */
const EXACT_ELEMENT_WORDS = { desk: ['مكتب'] };
const STRIP_PREFIXES = ['', 'ال', 'و', 'وال', 'ب', 'بال', 'ل', 'لل', 'ف', 'فال', 'ك', 'كال'];

function exactHits(normalized, words) {
  const tokens = normalized.split(/[^\p{L}\p{N}-]+/u).filter(Boolean);
  const found = [];
  for (const word of words) {
    const w = normalizeArabic(word);
    if (!w) continue;
    if (tokens.some((token) => STRIP_PREFIXES.some((prefix) => token === prefix + w))) found.push(word);
  }
  return found;
}

/** Explicit size in the prompt: "1200×2200", "1080x1080", "1200 في 2200", "A4". */
function parseCanvasFromPrompt(prompt) {
  const text = String(prompt || '');
  const m = /(\d{2,5})\s*(?:[x×X*]|في|بـ?|by)\s*(\d{2,5})\s*(?:px|بكسل|pixel)?/.exec(text);
  if (m) return { width: Number(m[1]), height: Number(m[2]), source: 'prompt' };
  if (/\bA4\b/i.test(text)) return { width: 1240, height: 1754, source: 'prompt:A4@150dpi' };
  return null;
}

function analyzeIntent(prompt, input) {
  const opts = input || {};
  const normalized = normalizeArabic(prompt);
  const scores = {};
  const evidence = {};
  for (const [type, words] of Object.entries(TYPE_KEYWORDS)) {
    const found = hits(normalized, words, prompt);
    scores[type] = found.length;
    evidence[type] = found;
  }
  // Structured inputs are stronger evidence than keywords.
  if (opts.table) { scores.table += 5; evidence.table.push('input.table'); }
  if (opts.ruled) { scores.ruled += 5; evidence.ruled.push('input.ruled'); }
  if (opts.referenceImage) { scores.reference += 5; evidence.reference.push('input.referenceImage'); }
  if (Array.isArray(opts.blocks) && opts.blocks.some((b) => b && b.type === 'table')) { scores.table += 2; evidence.table.push('blocks[table]'); }

  const elements = [];
  for (const [id, words] of Object.entries(ELEMENT_LEXICON)) {
    const found = hits(normalized, words, prompt);
    if (found.length) elements.push({ id, matched: found });
  }
  // "palm trees" names palms only: the word «trees» inside it must not also request leafy trees (a cover with
  // palms was failed for "trees not drawn"). Trees stay when they are named on their own elsewhere.
  if (elements.some((e) => e.id === 'palms')) {
    const i = elements.findIndex((e) => e.id === 'trees');
    if (i >= 0 && !hits(normalized.replace(/\bpalm\s+trees?\b/g, ' '), ELEMENT_LEXICON.trees, prompt).length) elements.splice(i, 1);
  }
  // A hut/cabin is a timber house by default (the composer drew a plastered modern house for «كوخ»).
  const hut = elements.find((e) => e.id === 'house' && e.matched.some((w) => ['كوخ', 'اكواخ', 'cabin', 'hut', 'chalet'].includes(w)));
  if (hut) hut.defaultMaterial = 'wood';
  if (elements.some(e => e.id === 'diningTable')) { const i = elements.findIndex(e => e.id === 'coffeeTable'); if (i >= 0 && !hits(normalized, ['طاوله قهوه','coffee table','side table'], prompt).length) elements.splice(i, 1); }
  // Ambiguous short words match a whole token only (مكتب ≠ مكتبه).
  for (const [id, words] of Object.entries(EXACT_ELEMENT_WORDS)) {
    const found = exactHits(normalized, words);
    if (!found.length) continue;
    const existing = elements.find((e) => e.id === id);
    if (existing) existing.matched = [...new Set([...existing.matched, ...found])];
    else elements.push({ id, matched: found, exact: true });
  }
  if (Array.isArray(opts.elements)) {
    for (const raw of opts.elements) {
      const n = normalizeArabic(raw);
      const known = Object.entries(ELEMENT_LEXICON).find(([id, words]) => id.toLowerCase() === n || words.some((w) => normalizeArabic(w) === n));
      // «أقلام»/«pens» تصبح pen؛ والاسم المجهول يبقى كما هو كي يُبلَّغ عنه ناقصًا.
      const motif = motifOf(raw);
      const id = known ? known[0] : (ELEMENT_LEXICON[motif] ? motif : String(raw));
      if (!elements.some((e) => e.id === id)) elements.push({ id, matched: [String(raw)], explicit: true });
    }
  }
  // Quantities belong to instances, not to synonym matching. Keep unnumbered plurals unspecified.
  const numbers = { six: 6, seven: 7, eight: 8, nine: 9, ten: 10, سته: 6, ست: 6, سبعه: 7, ثمانيه: 8, تسعه: 9, عشره: 10, one: 1, two: 2, three: 3, four: 4, five: 5, واحد: 1, اثنان: 2, اثنين: 2, ثلاثه: 3, ثلاث: 3, اربعه: 4, اربع: 4, خمسه: 5, خمس: 5 };
  for (const element of elements) {
    const words = (ELEMENT_LEXICON[element.id] || []).map(normalizeArabic);
    const tokens = normalized.replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d))).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
    for (let i = 1; i < tokens.length; i += 1) {
      if (!words.some((word) => tokens[i] === word || tokens[i] === `${word}s`)) continue;
      const numberToken = tokens[i - 1].replace(/^و(?=ثلاث|اربع|خمس|اثن|واحد|ست|سبع|ثمان|تسع|عشر)/, '');
      const count = numbers[numberToken] || (/^\d+$/.test(numberToken) ? Number(numberToken) : 0);
      if (count > 0) element.count = count;
    }
  }
  const has = (id) => elements.some((e) => e.id === id);
  // A notebook is an object in a still life unless the caller explicitly requests a ruled page.
  if (has('desk') && (has('notebook') || has('pen')) && !opts.ruled && !opts.blocks) {
    scores.scene += 5; evidence.scene.push('desktop still life');
    if (!hits(normalized, ['ورقه مسطره', 'ورق مسطر', 'ruled', 'lined paper', 'worksheet'], prompt).length) scores.ruled = 0;
  }

  // Scene vs character: a room with furniture is a scene even if a person sits in it.
  const furniture = ['bookshelf', 'tv', 'sofa', 'armchair', 'lamp', 'window', 'rug', 'coffeeTable', 'frame', 'clock'].filter(has).length;
  if (furniture >= 2) { scores.scene += 2; evidence.scene.push(`${furniture} furniture elements`); }
  if (has('person') && furniture === 0 && !scores.landscape && !scores.architecture) { scores.character += 1; evidence.character.push('person without setting'); }
  const nature = ['mountains', 'sea', 'river', 'lake', 'trees', 'palms', 'dunes', 'rocks', 'hills', 'farm'].filter(has).length;
  if (nature >= 2) { scores.landscape += 1; evidence.landscape.push(`${nature} nature elements`); }
  if (has('building') || has('tower')) { scores.architecture += 1; evidence.architecture.push('building element'); }
  // A house/cabin/lighthouse or a garden outside a room is an exterior picture. Without this rule
  // «منزل من حجر وحديقة» / "a stone house with a garden" scored nothing and fell to a *text* design.
  const exterior = ['house', 'lighthouse', 'garden'].filter(has);
  if (exterior.length && furniture === 0 && !scores.scene) {
    scores.landscape += exterior.length;
    evidence.landscape.push(`exterior ${exterior.join('+')}`);
  }
  // "مكتبة" alone in a design request (no room) is ambiguous: do not let it create a scene.
  // Ornamental genre words (see ORNAMENT_STRONG/WEAK): «زهرة المد زخرفية» had no keyword at all and fell to text.
  const ornamentStrong = hits(normalized, ORNAMENT_STRONG, prompt);
  const ornamentWeak = hits(normalized, ORNAMENT_WEAK, prompt);
  const layoutWords = scores.card + scores.poster + scores.text + scores.table + scores.ruled + scores.scene;
  if (ornamentStrong.length || (ornamentWeak.length && !layoutWords)) {
    scores.abstract += 2 * ornamentStrong.length + (layoutWords ? 0 : ornamentWeak.length);
    evidence.abstract.push(...ornamentStrong, ...(layoutWords ? [] : ornamentWeak));
  }

  let type = opts.designType && DESIGN_TYPES[opts.designType] ? opts.designType : null;
  let confidence = 1;
  let reason = 'explicit designType';
  // designType "architecture" draws a city (skyline, towers, street). A request whose only structure is a
  // house/cabin, with no city words or city elements, is a house in its surroundings: the city composer
  // put a small house in front of towers (plan_mw7uly3l). Draw it as an exterior scene and say why.
  if (type === 'architecture' && has('house') && !has('building') && !has('tower') && !scores.architecture) {
    type = 'landscape';
    reason = 'explicit designType "architecture" with a house and no city: drawn as an exterior (house as the main subject); add city words or buildings for a cityscape';
  }
  if (!type) {
    const priority = ['reference', 'ruled', 'table', 'abstract', 'architecture', 'scene', 'character', 'landscape', 'card', 'poster', 'text'];
    const ranked = priority.map((t) => [t, scores[t]]).sort((a, b) => b[1] - a[1] || priority.indexOf(a[0]) - priority.indexOf(b[0]));
    if (ranked[0][1] > 0) {
      type = ranked[0][0];
      const second = ranked[1][1];
      confidence = Number((ranked[0][1] / (ranked[0][1] + second || 1)).toFixed(2));
      reason = `keywords: ${evidence[type].slice(0, 5).join(', ')}`;
    } else {
      type = opts.headline || opts.body ? 'poster' : 'text';
      confidence = 0.4;
      reason = 'no visual intent detected; text design by default';
    }
  }

  const lighting = Object.entries(LIGHTING_KEYWORDS).find(([, words]) => hits(normalized, words, prompt).length)?.[0] || opts.lighting || null;
  const style = opts.style || Object.entries(STYLE_KEYWORDS).find(([, words]) => hits(normalized, words, prompt).length)?.[0] || 'illustration';
  const pose = /جالس|يجلس|جلوس|قاعد|sitting|seated/.test(normalized) ? 'seated' : (/واقف|يقف|standing/.test(normalized) ? 'standing' : null);
  const appearance = Object.assign(parseAppearance(normalized), opts.appearance || {});
  const explicitCanvas = opts.width && opts.height
    ? { width: Number(opts.width), height: Number(opts.height), source: 'input' }
    : parseCanvasFromPrompt(prompt);

  const result = {
    type,
    label: DESIGN_TYPES[type].label,
    confidence,
    reason,
    scores,
    elements,
    lighting,
    style,
    pose,
    appearance,
    explicitCanvas,
    abstractStyle: type === 'abstract' ? (opts.abstractStyle || Object.entries(ABSTRACT_STYLE_KEYWORDS).find(([, words]) => hits(normalized, words, prompt).length)?.[0] || 'geometric') : null,
    defaultCanvas: DESIGN_TYPES[type].canvas,
  };
  if (result.abstractStyle === 'ornamental') {
    result.ornament = {
      subject: opts.ornamentSubject || (hits(normalized, ORNAMENT_BIRD, prompt).length ? 'phoenix' : 'bloom'),
      pass: opts.ornamentPass === 'value' ? 'value' : 'color',
      waves: !/(بلا|بدون|without|no) ?(امواج|موج|waves?)/.test(normalized),
    };
  }
  return result;
}

module.exports = { DESIGN_TYPES, ELEMENT_LEXICON, COLOR_WORDS, analyzeIntent, normalizeArabic, parseCanvasFromPrompt, parseAppearance, tokenMatches, hits, taMarbutaTokens };
