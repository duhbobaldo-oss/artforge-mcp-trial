'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

/**
 * Knowledge access layer for the nine design books (built by ../book-index).
 * It answers two questions:
 *   ① which books are relevant to this design request (and why),
 *   ② which page-bound concepts from those books support it.
 * It never copies book text into a design; it returns short, page-referenced quotes
 * for internal reasoning plus the measured visual analysis of illustrated pages.
 */

const INTENT_RULES = [
  {
    id: 'real-estate-luxury',
    test: /(عقار|عقاري|بروفايل|شقة|فيلا|إسكان|اسكان|وسيط|real\s*estate|property|luxury\s*(home|villa)|listing)/i,
    books: { 'book-color-and-light': 3, 'book-photoshop-down-dirty': 1.2 },
  },
  {
    id: 'cinematic-poster',
    test: /(بوستر|ملصق|سينمائي|فيلم|إعلان\s*سينمائي|cinematic|movie\s*poster|film\s*poster)/i,
    books: { 'book-digital-art-masters': 3, 'book-color-and-light': 3, 'book-imaginative-realism': 2 },
  },
  {
    id: 'character',
    test: /(شخصية|شخصيات|تشريح|بطل|بطلات|figure|character|anatomy|pose)/i,
    books: { 'book-figure-drawing': 3, 'book-digital-art-masters': 2 },
  },
  {
    id: 'golden-title',
    test: /(عنوان|عناوين|ذهبي|ذهبية|معدني|حروف|typography|title|golden|gold\s*effect|lettering)/i,
    books: { 'book-photoshop-down-dirty': 3, 'book-color-and-light': 2, 'book-how-to-render': 2 },
  },
  {
    id: 'fantasy-scene',
    test: /(خيالي|خيالية|فانتازيا|مشهد|عالم|fantasy|imaginative|scene)/i,
    books: { 'book-imaginative-realism': 3, 'book-color-and-light': 3, 'book-digital-art-masters': 2 },
  },
  {
    id: 'game',
    test: /(لعبة|ألعاب|العاب|مرحلة|لاعب|game|level\s*design|gameplay|player)/i,
    books: { 'book-level-up': 3, 'book-digital-art-masters': 1 },
  },
  {
    id: 'ideation',
    test: /(فكرة|أفكار|افكار|تصور|مفهوم|توليد|ذكاء\s*اصطناعي|ذكاء\s*صناعي|ideation|brainstorm|concept|generative|prompt)/i,
    books: { 'book-generative-ai-visualization': 3 },
  },
  {
    id: 'texture-material',
    test: /(خامة|خامات|ملمس|معدن|زجاج|رخام|لمعان|material|texture|metal|glass|specular)/i,
    books: { 'book-how-to-render': 3, 'book-digital-painting': 2, 'book-digital-art-masters': 1 },
  },
  {
    id: 'illustration',
    test: /(رسم|لوحة|لوحات|تلوين|فرشاة|فرش|illustration|painting|brush)/i,
    books: { 'book-digital-art-masters': 3, 'book-digital-painting': 2 },
  },
  {
    id: 'photo-composite',
    test: /(?<![\u0600-\u06FF])صور|دمج|تركيب|فوتوغراف|composite|photo|photoshop|retouch/i,
    books: { 'book-photoshop-down-dirty': 3, 'book-digital-painting': 2 },
  },
  {
    id: 'ui-product',
    test: /(واجهة|بطاقة|تطبيق|ui|ux|card|app|dashboard)/i,
    books: { 'book-color-and-light': 2, 'book-photoshop-down-dirty': 1 },
  },
];

/**
 * Curated, test-verified mapping from concept terms to operations that actually
 * exist in the ArtForge drawing tool. Anything absent here is *not* claimed as a
 * tool capability; it stays artistic guidance only.
 */
const TOOL_CAPABILITY_MAP = {
  'drop shadow': { supported: 'yes', ops: ['draw.text', 'draw.rect', 'draw.ellipse', 'draw.polygon'], note: 'shadow parameter on shapes and text' },
  'blend mode': { supported: 'yes', ops: ['layer.update'], note: 'layer blend + opacity' },
  layer: { supported: 'yes', ops: ['layer.add', 'layer.update', 'layer.move'], note: 'named layers, order, opacity, blend' },
  layering: { supported: 'yes', ops: ['layer.add', 'layer.update'], note: 'stacked layers with blend and opacity' },
  gradient: { supported: 'yes', ops: ['draw.gradient', 'document.create'], note: 'linear/radial gradients' },
  composition: { supported: 'partial', ops: ['object.align', 'draw.rect'], note: 'layout helpers only; composition theory stays guidance' },
  typography: { supported: 'yes', ops: ['draw.text', 'text.measure'], note: 'Arabic shaping, wrapping, alignment' },
  lettering: { supported: 'partial', ops: ['draw.text'], note: 'text rendering only; no vector letterform editing' },
  glow: { supported: 'partial', ops: ['draw.gradient', 'draw.text'], note: 'radial gradients plus soft shadows' },
  'texture overlay': { supported: 'partial', ops: ['draw.image'], note: 'image placement with opacity; no procedural texture generator' },
  contrast: { supported: 'partial', ops: ['draw.rect', 'draw.text'], note: 'achieved through colour choice, not an adjustment filter' },
  'color grading': { supported: 'no', ops: [], note: 'no adjustment layers or curves in ArtForge' },
  masking: { supported: 'no', ops: [], note: 'no layer masks in ArtForge' },
  'layer mask': { supported: 'no', ops: [], note: 'no layer masks in ArtForge' },
  clone: { supported: 'no', ops: [], note: 'no clone stamp tool' },
  retouch: { supported: 'no', ops: [], note: 'no retouching pipeline' },
  filter: { supported: 'no', ops: [], note: 'no filter engine (no blur/sharpen/emboss)' },
  sharpen: { supported: 'no', ops: [], note: 'no sharpening filter' },
  emboss: { supported: 'no', ops: [], note: 'no emboss/bevel effect' },
  bevel: { supported: 'no', ops: [], note: 'no bevel effect' },
  'gradient map': { supported: 'no', ops: [], note: 'no gradient map adjustment' },
};

function normaliseText(value) {
  return String(value || '').toLowerCase().replace(/[إأآ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه');
}

function tokenise(value) {
  return normaliseText(value)
    .split(/[^a-z0-9\u0600-\u06FF]+/)
    .filter((token) => token.length >= 3);
}

const VERIFICATION_WEIGHT = {
  'verified-text': 1,
  'verified-caption': 0.85,
  'verified-ocr': 0.7,
  'verified-toc': 0.45,
};

/**
 * Arabic phrases → the exact multi-word terms of the book index (checked against termIndex).
 * Single-word expansion alone turned «المنظور الجوي» into "perspective", which never equals the indexed
 * term "atmospheric perspective", so Arabic searches for core concepts returned nothing.
 * Keys are normalised (ة→ه, أإآ→ا, ى→ي) and matched as substrings, longest first.
 */
const ARABIC_PHRASE_MAP = {
  'منظور جوي': ['atmospheric perspective'], 'المنظور الجوي': ['atmospheric perspective'], 'منظور هوائي': ['atmospheric perspective'],
  'المنظور الهوائي': ['atmospheric perspective'], 'المنظور اللوني': ['atmospheric perspective'],
  'ضوء منعكس': ['reflected light'], 'الضوء المنعكس': ['reflected light'], 'الضوء المرتد': ['reflected light'], 'انعكاس الضوء': ['reflected light'],
  'ظل ساقط': ['cast shadow'], 'الظل الساقط': ['cast shadow'], 'الظل الملقي': ['cast shadow'], 'ظل الشكل': ['form shadow'], 'الظل الذاتي': ['form shadow'],
  'ظل التلامس': ['occlusion shadow'], 'ظل الاحتجاب': ['occlusion shadow'], 'ظل مسقط': ['drop shadow'], 'حد الظل': ['shadow edge'],
  'حراره اللون': ['color temperature', 'warm color', 'cool color'], 'حراره الالوان': ['color temperature', 'warm color', 'cool color'],
  'الوان دافئه': ['warm color', 'color temperature'], 'لون دافئ': ['warm color'], 'الوان بارده': ['cool color', 'color temperature'], 'لون بارد': ['cool color'],
  'ضوء محيط': ['ambient light'], 'الاضاءه المحيطه': ['ambient light'], 'ضوء خلفي': ['backlight', 'rim light'], 'اضاءه خلفيه': ['backlighting', 'rim light'],
  'ضوء الحافه': ['rim light'], 'مصدر الضوء': ['light source'], 'مصادر الضوء': ['light sources'], 'تلاشي الضوء': ['light falloff'], 'خفوت الضوء': ['light falloff'],
  'ضوء رئيسي': ['key light'], 'ضوء التعبئه': ['fill light'], 'ضوء الملء': ['fill light'], 'ضوء الشمس': ['sunlight'], 'وقت اليوم': ['time of day'],
  'الضوء والظل': ['light and shadow'], 'اضاءه دافئه': ['warm color', 'color temperature'], 'ضوء دافئ': ['warm color', 'color temperature'],
  'اضاءه بارده': ['cool color', 'color temperature'], 'ضوء بارد': ['cool color', 'color temperature'], 'غروب': ['time of day', 'sunlight'], 'شروق': ['time of day', 'sunlight'], 'اضاءه المزاج': ['mood lighting'], 'اضاءه مزاجيه': ['mood lighting'],
  'لون محلي': ['local color'], 'اللون المحلي': ['local color'], 'الوان متكامله': ['complementary color'], 'لون مكمل': ['complementary color'],
  'الوان متجاوره': ['analogous color'], 'عجله الالوان': ['color wheel'], 'دائره الالوان': ['color wheel'], 'لوحه الوان': ['color palette'],
  'سيناريو الالوان': ['color script'], 'تباين متزامن': ['simultaneous contrast'], 'نطاق التباين': ['contrast range'], 'المدى الديناميكي': ['dynamic range'],
  'تشتت تحت السطح': ['subsurface scattering'], 'حواف ناعمه': ['soft edge'], 'حافه ناعمه': ['soft edge'], 'حواف حاده': ['hard edge'], 'حافه حاده': ['hard edge'],
  'التحكم بالحواف': ['edge control'], 'رسم الحركه': ['gesture drawing'], 'رسم الايماءه': ['gesture drawing'], 'رسم مصغر': ['thumbnail sketch'],
  'اسكتش مصغر': ['thumbnail sketch'], 'وضع المزج': ['blend mode', 'blending mode'], 'قناع الطبقه': ['layer mask'], 'خريطه التدرج': ['gradient map'],
  'طبقه ضبط': ['adjustment layer'], 'القفص الصدري': ['rib cage'], 'حزام الكتف': ['shoulder girdle'], 'تصميم المراحل': ['level design'],
  'تصميم الالعاب': ['game design'], 'تجربه اللاعب': ['player experience'], 'منحني الصعوبه': ['difficulty curve'], 'فن المفاهيم': ['concept art'],
  'فن تصوري': ['concept art'], 'الرسم الرقمي': ['digital painting', 'digital art'], 'الواقعيه الخياليه': ['imaginative realism'],
  'فرشاه ناعمه': ['soft brush'], 'فرشاه صلبه': ['hard brush'], 'ضغط القلم': ['pen pressure', 'pressure sensitivity'],
  'ختم النسخ': ['clone stamp'], 'صوره مرجعيه': ['reference photo'], 'الذكاء الاصطناعي التوليدي': ['generative ai'],
};

/** Arabic design vocabulary → the English terms used by the books. */
const ARABIC_TERM_MAP = {
  'جوي': ['atmospheric', 'atmosphere'], 'هوائي': ['atmospheric'], 'ضباب': ['atmosphere', 'atmospheric'], 'منعكس': ['reflected'],
  'سطوع': ['value'], 'قيم لونيه': ['value', 'values'], 'تشبع': ['saturation', 'chroma'], 'صبغه': ['hue'], 'خطوط عريضه': ['silhouette'],
  'ظلي': ['silhouette'], 'انكسار': ['refraction'], 'شفاف': ['glass', 'refraction'], 'قماش': ['fabric', 'cloth'], 'نسيج': ['texture', 'fabric'],
  'بشره': ['skin'], 'خشب': ['wood', 'texture'], 'خشبي': ['wood'], 'حجر': ['texture', 'surface', 'materials'], 'حجري': ['texture', 'surface'],
  'صخر': ['texture', 'surface'], 'سطح': ['surface'], 'حافه': ['edge'], 'حواف': ['edges'], 'ليل': ['night'], 'ليلي': ['night'], 'غائم': ['overcast'],
  'توهج': ['glow', 'luminescence'], 'كتله': ['volume', 'form'], 'حجم': ['volume'], 'هيكل عظمي': ['skeleton'], 'عضلات': ['muscle', 'muscles'],
  'اضاءه': ['light', 'lighting'], 'ضوء': ['light'], 'ظل': ['shadow'], 'ظلال': ['shadow'],
  'لون': ['color'], 'الوان': ['color', 'palette'], 'تدرج': ['gradient'], 'تباين': ['contrast'],
  'تشريح': ['anatomy'], 'نسب': ['proportion'], 'وضعيه': ['pose'], 'حركه': ['gesture'],
  'جسم': ['figure'], 'شخصيه': ['character'], 'شخصيات': ['character'], 'يد': ['hands'],
  'تكوين': ['composition'], 'منظور': ['perspective'], 'افق': ['horizon'],
  'خامه': ['material', 'texture'], 'خامات': ['material'], 'ملمس': ['texture'],
  'معدن': ['metal'], 'معدني': ['metal'], 'زجاج': ['glass'], 'انعكاس': ['reflection'],
  'لمعان': ['specular'], 'واقعي': ['realistic'], 'اظهار': ['rendering'],
  'عنوان': ['typography', 'title'], 'عناوين': ['typography'], 'حروف': ['lettering'],
  'مؤثر': ['effect'], 'مؤثرات': ['effects'], 'دمج': ['composite'], 'تركيب': ['composite'],
  'طبقات': ['layer'], 'طبقه': ['layer'], 'قناع': ['mask'], 'فرشاه': ['brush'], 'فرش': ['brush'],
  'تلوين': ['painting', 'color'], 'رسم': ['drawing', 'painting'], 'لوحه': ['painting'],
  'مرحله': ['level'], 'لاعب': ['player'], 'لعبه': ['game'], 'العاب': ['game'], 'تجربه': ['experience'],
  'ذهبي': ['gold'], 'فاخر': ['luxury'], 'داكن': ['dark'], 'فاتح': ['light'],
  'تصور': ['concept', 'visualization'], 'فكره': ['idea', 'concept'], 'مفهوم': ['concept'],
  'خيالي': ['fantasy', 'imaginative'], 'مشهد': ['scene'], 'عالم': ['world'],
  'محيط': ['ambient'], 'مصدر': ['source'], 'انعكاسات': ['reflections'],
};

/** Intent → English concept terms, so Arabic briefs still reach the English books. */
const INTENT_TERMS = {
  'real-estate-luxury': ['light', 'contrast', 'palette', 'visual hierarchy', 'photography'],
  'cinematic-poster': ['composition', 'lighting', 'color script', 'mood', 'value pattern'],
  character: ['gesture', 'proportion', 'anatomy', 'pose', 'figure drawing', 'line of action'],
  'golden-title': ['typography', 'metal', 'specular', 'highlight', 'drop shadow', 'blend mode'],
  'fantasy-scene': ['composition', 'perspective', 'imaginative realism', 'atmospheric perspective'],
  game: ['level design', 'player experience', 'gameplay', 'pacing', 'difficulty curve'],
  ideation: ['brainstorming', 'mood board', 'prompt', 'iteration', 'concept development'],
  'texture-material': ['material', 'specular', 'reflection', 'texture', 'diffuse'],
  illustration: ['digital painting', 'brush', 'blending', 'block-in', 'layering'],
  'photo-composite': ['compositing', 'masking', 'blending', 'color grading', 'visual effects'],
  'ui-product': ['contrast', 'palette', 'visual hierarchy', 'typography'],
};

class BookKnowledge {
  constructor(options) {
    const opts = typeof options === 'string' ? { indexPath: options } : (options || {});
    this.indexPath = opts.indexPath;
    this.booksDir = opts.booksDir || (this.indexPath ? path.join(path.dirname(this.indexPath), 'books') : null);
    // The original corpus is separate from extracted index records. Never infer
    // current illustration provenance from an index hash alone.
    this.originalsDir = opts.originalsDir || (this.indexPath ? path.resolve(path.dirname(this.indexPath), '..', '..', 'THE_BOOK') : null);
    this.index = null;
    this.conceptById = new Map();
    this.pageCache = new Map();
  }

  isAvailable() {
    return Boolean(this.indexPath && fs.existsSync(this.indexPath));
  }

  load() {
    if (this.index) return this.index;
    if (!this.isAvailable()) {
      throw new Error(
        `book index not found at ${this.indexPath}. Build it with: cd book-index && node bin/book-index.js build`,
      );
    }
    this.index = JSON.parse(fs.readFileSync(this.indexPath, 'utf8'));
    this.conceptById = new Map(this.index.concepts.map((concept) => [concept.id, concept]));
    return this.index;
  }

  summary() {
    if (!this.isAvailable()) {
      return {
        available: false,
        indexPath: this.indexPath || null,
        hint: 'run: cd book-index && node bin/book-index.js build',
      };
    }
    // الملخّص ثابت طوال عمر الفهرس المحمّل؛ يُحسب مرة واحدة فقط.
    if (this._summaryCache) return this._summaryCache;
    const index = this.load();
    this._summaryCache = {
      available: true,
      generatedAt: index.generatedAt,
      books: index.books.map((book) => ({
        id: book.id,
        title: book.title,
        file: book.file,
        specialty: book.specialty,
        categories: book.categories,
        pages: book.pagesProcessed,
        pagesWithText: book.pagesWithUsableText,
        ocrPages: book.ocrPages,
        imagesDetected: book.imagesDetected,
        concepts: book.concepts,
        secondarySource: book.secondarySource,
        toolBound: book.toolBound,
      })),
      coverage: index.coverage,
      categories: Object.fromEntries(Object.entries(index.categoryIndex).map(([key, ids]) => [key, ids.length])),
      counts: {
        concepts: index.concepts.length,
        pages: index.pages.length,
        terms: Object.keys(index.termIndex).length,
      },
      tooling: index.tooling,
      rules: index.rules,
    };
    return this._summaryCache;
  }

  listBooks() {
    return this.load().books;
  }

  book(bookId) {
    return this.load().books.find((book) => book.id === bookId) || null;
  }

  concept(conceptId) {
    this.load();
    return this.conceptById.get(conceptId) || null;
  }

  pageRecord(bookId, pageNumber) {
    if (!this.book(bookId) || !Number.isInteger(pageNumber) || pageNumber < 1) return null;
    const cacheKey = `${bookId}:${pageNumber}`;
    if (this.pageCache.has(cacheKey)) return this.pageCache.get(cacheKey);
    let record = null;
    const file = this.booksDir ? path.join(this.booksDir, `${bookId}.json`) : null;
    if (file && fs.existsSync(file)) {
      const book = JSON.parse(fs.readFileSync(file, 'utf8'));
      record = (book.pages || []).find((page) => page.page === Number(pageNumber)) || null;
    }
    if (!record) {
      const summaryPage = this.load().pages.find((page) => page.bookId === bookId && page.page === Number(pageNumber));
      record = summaryPage ? Object.assign({}, summaryPage, { text: '' }) : null;
    }
    this.pageCache.set(cacheKey, record);
    return record;
  }

  /** Verify a reviewed illustration against the actual original bytes, not cached metadata. */
  verifyOriginalSource(bookId, expectedSha256) {
    const book = this.book(bookId);
    if (!book || !/^[a-f0-9]{64}$/.test(String(expectedSha256)) || book.sha256 !== expectedSha256) return { ok: false, reason: 'indexed-source-mismatch' };
    if (!this.originalsDir || path.basename(book.file) !== book.file) return { ok: false, reason: 'original-unavailable' };
    try {
      const directory = fs.realpathSync(this.originalsDir);
      const original = fs.realpathSync(path.join(directory, book.file));
      const relative = path.relative(directory, original);
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return { ok: false, reason: 'original-outside-corpus' };
      const stat = fs.statSync(original);
      if (!stat.isFile() || stat.size > 128 * 1024 * 1024) return { ok: false, reason: 'invalid-original-size' };
      const sha256 = crypto.createHash('sha256').update(fs.readFileSync(original)).digest('hex');
      return sha256 === expectedSha256 ? { ok: true, sha256 } : { ok: false, reason: 'original-source-mismatch' };
    } catch { return { ok: false, reason: 'original-unavailable' }; }
  }

  /** Which operations of the drawing tool can actually express a concept. */
  toolMapping(concept) {
    const candidates = [concept.title, concept.matchedTerm, ...(concept.terms || [])].filter(Boolean);
    for (const candidate of candidates) {
      const key = String(candidate).toLowerCase();
      if (TOOL_CAPABILITY_MAP[key]) return Object.assign({ concept: concept.title }, TOOL_CAPABILITY_MAP[key]);
    }
    return {
      concept: concept.title,
      supported: 'unknown',
      ops: [],
      note: 'لا توجد مطابقة موثّقة لوظائف أداة ArtForge؛ تُستخدم المعرفة كتوجيه فني فقط.',
    };
  }

  /** Match the request against the editorial intents and per-book keywords. */
  matchIntents(prompt) {
    const text = String(prompt || '');
    const matches = [];
    for (const rule of INTENT_RULES) {
      if (rule.test.test(text)) matches.push({ id: rule.id, books: rule.books });
    }
    return matches;
  }

  /**
   * Choose the books that the request actually needs (never all nine).
   * score = intent weight + keyword hits + skill affinity + category affinity.
   */
  selectBooks(prompt, options) {
    const opts = options || {};
    const index = this.load();
    const text = normaliseText(prompt);
    const limit = Math.max(1, Math.min(3, opts.limit || 2));
    // Book keywords are English: match them against the Arabic brief's English expansion too.
    const keywordText = normaliseText(this.expandQuery(prompt));
    const intents = this.matchIntents(prompt);
    const forced = Array.isArray(opts.books) ? opts.books : [];
    const scored = [];

    for (const book of index.books) {
      let score = 0;
      const reasons = [];
      const matchedIntents = [];
      for (const intent of intents) {
        const weight = intent.books[book.id];
        if (weight) {
          score += weight;
          matchedIntents.push(intent.id);
          reasons.push(`intent:${intent.id}`);
        }
      }
      let keywordHits = 0;
      for (const keyword of (book.routingHints && book.routingHints.keywords) || []) {
        if (keyword.length >= 3 && keywordText.includes(normaliseText(keyword))) {
          keywordHits += 1;
          if (keywordHits <= 2) reasons.push(`keyword:${keyword}`);
        }
      }
      score += Math.min(keywordHits, 3) * 0.8;
      // Skill/category affinity may only *rank* books that already matched intent or keywords.
      if (score > 0) {
        if (opts.skillId && (book.routingHints.skills || []).includes(opts.skillId)) {
          score += 1.2;
          reasons.push(`skill:${opts.skillId}`);
        }
        if (Array.isArray(opts.categories)) {
          const overlap = (book.categories || []).filter((category) => opts.categories.includes(category));
          if (overlap.length) { score += overlap.length * 0.5; reasons.push(`category:${overlap.join(',')}`); }
        }
      }
      if (forced.includes(book.id)) { score += 10; reasons.push('explicitly requested'); }
      if (score <= 0) continue;
      scored.push({
        bookId: book.id,
        title: book.title,
        file: book.file,
        specialty: book.specialty,
        categories: book.categories,
        secondarySource: book.secondarySource,
        toolBound: book.toolBound,
        conceptCount: book.concepts,
        score: Number(score.toFixed(3)),
        reasons,
        matchedIntents,
      });
    }

    return scored
      .sort((a, b) => b.score - a.score || a.bookId.localeCompare(b.bookId))
      .slice(0, limit);
  }

  /**
   * Expand an Arabic or mixed brief into the English vocabulary the books use.
   * Without this, a brief like "تصميم شخصية بشرية" would never match "gesture".
   */
  expandQuery(query) {
    const original = String(query || '');
    const normalised = normaliseText(original);
    const additions = new Set();
    for (const phrase of Object.keys(ARABIC_PHRASE_MAP).sort((a, b) => b.length - a.length)) {
      if (normalised.includes(phrase)) for (const term of ARABIC_PHRASE_MAP[phrase]) additions.add(term);
    }
    for (const [arabic, english] of Object.entries(ARABIC_TERM_MAP)) {
      if (normalised.includes(arabic)) {
        for (const term of english) additions.add(term);
      }
    }
    for (const intent of this.matchIntents(original)) {
      for (const term of INTENT_TERMS[intent.id] || []) additions.add(term);
    }
    return [original, ...additions].join(' ');
  }

  /**
   * Retrieve page-bound concepts for a query, optionally restricted to books or
   * categories. Every hit carries its quote, page and verification state.
   */
  retrieve(query, options) {
    const opts = options || {};
    const index = this.load();
    const limit = Math.max(1, Math.min(20, opts.limit || 6));
    const bookFilter = Array.isArray(opts.books) && opts.books.length ? new Set(opts.books) : null;
    const categoryFilter = Array.isArray(opts.categories) && opts.categories.length ? new Set(opts.categories) : null;
    const text = normaliseText(this.expandQuery(query));
    const tokens = new Set(tokenise(this.expandQuery(query)));
    // Topics (page headings) must match the caller's own words, not the expanded ones,
    // otherwise generic words like "design" or "light" pull unrelated chapter titles.
    const originalText = normaliseText(query);
    const originalTokens = new Set(tokenise(query));
    if (opts.mode && !['keyword','hybrid-fts5','hybrid-local-lsa'].includes(opts.mode)) throw Object.assign(new Error('Unknown retrieval mode'), {code:'INVALID_SEARCH_MODE'});
    let ftsRanks = null;
    if (opts.mode === 'hybrid-fts5' || opts.mode === 'hybrid-local-lsa') {
      this._fts = this._fts || new (require('./fts-search').FtsSearch)(index.concepts, normaliseText);
      ftsRanks = this._fts.rank(tokens);
    }

    const phraseTerms = [];
    for (const term of Object.keys(index.termIndex)) {
      if (term.length >= 4 && text.includes(term)) phraseTerms.push(term);
    }

    let semanticRanks = null;
    if (opts.mode === 'hybrid-local-lsa') {
      this._semantic = this._semantic || new (require('./corpus-semantic-search').CorpusSemanticSearch)(index.concepts, tokenise);
      semanticRanks = this._semantic.rank(tokens);
    }
    const results = [];
    for (const concept of index.concepts) {
      if (bookFilter && !bookFilter.has(concept.bookId)) continue;
      if (categoryFilter && !concept.categories.some((category) => categoryFilter.has(category))) continue;
      let score = 0;
      const reasons = [];
      const matchText = concept.isTopic ? originalText : text;
      const matchTokens = concept.isTopic ? originalTokens : tokens;
      for (const term of phraseTerms) {
        if (matchText.includes(term) && (concept.terms || []).includes(term)) { score += 3; reasons.push(`term:${term}`); }
      }
      for (const term of concept.terms || []) {
        if (matchTokens.has(term)) { score += 2; reasons.push(`token:${term}`); break; }
      }
      if (opts.category && concept.categories.includes(opts.category)) score += 1.5;
      const lexicalMatched = score > 0;
      if (!lexicalMatched && !(ftsRanks && ftsRanks.has(concept.id)) && !(semanticRanks && semanticRanks.has(concept.id))) continue;
      // A defined concept with an explanatory quote is worth more than a heading topic.
      score += concept.isTopic ? 0.2 : 1.6;
      score += (VERIFICATION_WEIGHT[concept.verification] || 0.3) * 1.2;
      score += Math.min(concept.pages.length, 8) * 0.1;
      const refScore = ref => { const words = new Set(tokenise(ref.quote || '')); return [...matchTokens].reduce((sum,t) => sum + (words.has(t) ? 1 : 0),0); };
      const rankedRefs = concept.pageRefs.map((ref,i)=>({ref,i,score:refScore(ref)})).sort((a,b)=>b.score-a.score || a.i-b.i).map(x=>x.ref);
      const firstRef = rankedRefs[0] || {};
      results.push({
        id: concept.id,
        title: concept.title,
        bookId: concept.bookId,
        bookTitle: (this.book(concept.bookId) || {}).title || concept.bookFile,
        categories: concept.categories,
        type: concept.type,
        page: firstRef.page || concept.page,
        pages: concept.pages,
        evidence: String(concept.evidence || '').slice(0, 320),
        verification: concept.verification,
        pageRefs: rankedRefs.slice(0, 3).map((ref) => ({ page: ref.page, verified: ref.verified })),
        secondarySource: concept.secondarySource,
        toolBound: concept.toolBound,
        toolMapping: this.toolMapping(concept),
        score: Number(score.toFixed(3)),
        ...(ftsRanks ? {ftsRank:ftsRanks.get(concept.id) || null,lexicalMatched,retrievalMode:opts.mode,semanticRank:semanticRanks?.get(concept.id)?.rank || null,semanticSimilarity:semanticRanks?.get(concept.id)?.similarity ?? null} : {}),
        reasons,
        quote: firstRef.quote ? String(firstRef.quote).slice(0, 320) : null,
      });
    }

    results.sort((a,b) => b.score-a.score || a.id.localeCompare(b.id));
    if (ftsRanks) {
      let lexicalRank=0;
      results.forEach(result => { result.lexicalScore=result.score; result.lexicalRank=result.lexicalMatched ? ++lexicalRank : null; result.score=(result.lexicalRank ? 1/(60+result.lexicalRank) : 0)+(result.ftsRank ? 1/(60+result.ftsRank) : 0)+(result.semanticRank ? 1/(60+result.semanticRank) : 0); });
      const queryWords = ' ' + tokenise(query).join(' ') + ' ';
      for (const result of results) {
        const titleWords = tokenise(result.title).join(' ');
        result.rrfScore = result.score;
        result.rerank = titleWords.length >= 4 && queryWords.includes(' ' + titleWords + ' ') ? 'exact-title-phrase' : null;
        if (result.rerank) result.score += 0.05;
      }
      results.sort((a,b)=>b.score-a.score || a.id.localeCompare(b.id));
    }
    const seen = new Set();
    return results.filter(result => {
      const key = result.bookId + ':' + result.page + ':' + normaliseText(result.quote || result.title);
      if (seen.has(key)) return false; seen.add(key); return true;
    }).slice(0,limit);
  }

  /** Concepts grouped by category for one book (used to fill plan details). */
  conceptsByBook(bookId, limit) {
    const index = this.load();
    return index.concepts
      .filter((concept) => concept.bookId === bookId)
      .slice(0, Math.max(1, Math.min(50, limit || 8)))
      .map((concept) => ({
        id: concept.id,
        title: concept.title,
        page: concept.page,
        categories: concept.categories,
        verification: concept.verification,
        evidence: String(concept.evidence || '').slice(0, 240),
      }));
  }
}

module.exports = {
  BookKnowledge,
  INTENT_RULES,
  TOOL_CAPABILITY_MAP,
  VERIFICATION_WEIGHT,
  normaliseText,
  tokenise,
};
