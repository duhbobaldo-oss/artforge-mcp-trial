'use strict';

/**
 * Explicit element-type dictionary (motifs).
 *
 * A plan may name the same object many ways: `pen1`, `pen_2`, `pens`, `قلم`, `أقلام`.
 * Coverage accounting must treat all of them as ONE motif, and must never invent a
 * motif for an unknown name (that would hide a genuinely missing element).
 *
 * This replaces the earlier heuristic (`strip trailing digits, then strip a plural "s"`),
 * which turned any English word ending in "s" into a false motif.
 */

const SURFACES = {
  ...require('./subjects'),
  desk: ['مكتب', 'مكتب خشبي', 'سطح مكتب', 'طاوله عمل', 'طاولة مكتب', 'desk', 'writing desk', 'work desk', 'tabletop'],
  notebook: ['دفتر', 'دفتر ملاحظات', 'مفكره', 'كراسه', 'كراسة', 'كشكول', 'notebook', 'note book', 'notepad', 'journal', 'exercise book'],
  pen: ['قلم', 'اقلام', 'قلم حبر', 'حبر جاف', 'pen', 'pencil', 'ballpoint', 'marker', 'stylus'],
  bookshelf: ['مكتبه', 'مكتبة', 'رفوف', 'رف كتب', 'رفوف كتب', 'خزانه كتب', 'bookshelf', 'bookcase', 'shelf', 'shelves'],
  tv: ['تلفزيون', 'تلفاز', 'تليفزيون', 'شاشه', 'شاشه تلفاز', 'tv', 'television', 'televisions'],
  person: ['شخص', 'رجل', 'امراه', 'طفل', 'فتاه', 'ولد', 'انسان', 'person', 'people', 'man', 'woman', 'child', 'girl', 'boy', 'figure'],
  sofa: ['كنبه', 'اريكه', 'كنب', 'sofa', 'couch'],
  armchair: ['كراسي', 'كراسي طعام', 'كرسي', 'مقعد', 'كرسي مريح', 'armchair', 'chair'],
  lamp: ['مصباح', 'لمبه', 'اباجوره', 'ابجوره', 'lamp', 'table lamp', 'floor lamp'],
  window: ['نافذه', 'شباك', 'نوافذ', 'window'],
  plant: ['نبته', 'نبات', 'زرع', 'اصيص', 'plant', 'potted plant'],
  rug: ['سجاده', 'زوليه', 'سجاد', 'rug', 'carpet'],
  clock: ['ساعه', 'ساعه حائط', 'clock', 'wall clock'],
  frame: ['برواز', 'لوحه على الجدار', 'صوره معلقه', 'frame', 'wall art', 'picture frame'],
  coffeeTable: ['طاوله', 'طاوله قهوه', 'coffee table', 'side table'],
  sun: ['شمس', 'sun'],
  moon: ['قمر', 'هلال', 'moon'],
  stars: ['نجوم', 'نجمه', 'stars', 'star'],
  clouds: ['غيوم', 'سحاب', 'غيم', 'clouds', 'cloud'],
  mountains: ['جبال', 'جبل', 'mountains', 'mountain'],
  hills: ['تلال', 'تل', 'hills', 'hill'],
  sea: ['بحر', 'محيط', 'ساحل', 'شاطئ', 'sea', 'ocean', 'coast', 'beach'],
  river: ['نهر', 'river', 'stream'],
  lake: ['بحيره', 'lake'],
  trees: ['اشجار', 'شجره', 'شجر', 'غابه', 'trees', 'tree', 'forest'],
  palms: ['نخيل', 'نخله', 'palms', 'palm', 'palm tree'],
  dunes: ['صحراء', 'كثبان', 'رمال', 'desert', 'dunes', 'sand dune'],
  rocks: ['صخور', 'صخره', 'rocks', 'rock'],
  boat: ['قارب', 'سفينه', 'مركب', 'boat', 'ship'],
  lighthouse: ['مناره', 'منارة', 'lighthouse'],
  house: ['بيت', 'منزل', 'كوخ', 'house', 'cabin'],
  birds: ['طيور', 'طائر', 'birds', 'bird'],
  flowers: ['زهور', 'ورود', 'ازهار', 'flowers', 'flower'],
  grass: ['عشب', 'حشائش', 'grass', 'meadow'],
  garden: ['حديقه', 'حدائق', 'منتزه', 'بستان', 'garden', 'park'],
  sky: ['سماء', 'sky'],
  building: ['مبنى', 'عماره', 'مباني', 'building', 'buildings'],
  tower: ['برج', 'ناطحه', 'tower', 'skyscraper'],
  road: ['شارع', 'طريق', 'road', 'street'],
  shapes: ['اشكال', 'اشكال هندسيه', 'shapes', 'shape'],
  lines: ['خطوط', 'lines', 'line'],
  tiles: ['بلاطات', 'مربعات', 'tiles', 'tile'],
  waves: ['امواج', 'موجات', 'waves', 'wave'],
  spheres: ['كرات', 'كرات ثلاثيه', 'spheres', 'sphere'],
  ribbons: ['اشرطه', 'شرائط', 'ribbons', 'ribbon'],
  smoke: ['دخان', 'smoke'],
  splash: ['رشقات', 'بقع طلاء', 'splash', 'splatter'],
  speckles: ['نقاط', 'بقع صغيره', 'speckles', 'specks'],
};

function normalizeSurface(text) {
  return String(text == null ? '' : text)
    .toLowerCase()
    .replace(/[\u064B-\u0652\u0640]/g, '')
    .replace(/[\u0625\u0623\u0622\u0671]/g, '\u0627')
    .replace(/\u0649/g, '\u064A')
    .replace(/\u0629/g, '\u0647')
    .replace(/\u0624/g, '\u0648')
    .replace(/\u0626/g, '\u064A')
    .replace(/[\u060C\u061B\u061F.,:;!?()[\]{}"'`/\\]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** surface → motif, resolved once. English plurals are listed explicitly, never derived blindly. */
const BY_SURFACE = new Map();
const MOTIFS = new Set();

for (const [motif, surfaces] of Object.entries(SURFACES)) {
  MOTIFS.add(motif);
  const all = [motif, `${motif}s`, ...surfaces];
  for (const surface of all) {
    const key = normalizeSurface(surface);
    if (key && !BY_SURFACE.has(key)) BY_SURFACE.set(key, motif);
  }
}

/**
 * Canonical motif for an element id such as `pen1`, `pen_2`, `Pens`, `أقلام`.
 * Unknown names are returned lower-cased and otherwise untouched, so an element the
 * composer cannot draw stays visible in `missing` instead of being merged away.
 */
function motifOf(id) {
  const raw = String(id == null ? '' : id).trim();
  if (!raw) return '';
  // Count suffixes only: pen1 / pen_2 / pen-3 → pen. A digit inside the name is preserved.
  const stripped = raw.replace(/[\s_-]*\d+$/, '') || raw;
  const direct = normalizeSurface(stripped);
  if (BY_SURFACE.has(direct)) return BY_SURFACE.get(direct);
  return direct || raw.toLowerCase();
}

function isKnownMotif(motif) {
  return MOTIFS.has(motifOf(motif));
}

module.exports = { SURFACES, MOTIFS, motifOf, isKnownMotif, normalizeSurface };
