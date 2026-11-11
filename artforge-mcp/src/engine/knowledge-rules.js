'use strict';

/**
 * Actionable art rules derived from the indexed books.
 *
 * Each rule names the concept and page it comes from; the quote is NOT stored here: it is read from the
 * book index at runtime and the rule is only "grounded" when that page quote really exists. The decision
 * and parameters are ArtForge's interpretation of the quoted principle (labelled as such), and every
 * application is logged with the operations that implemented it, so evidence = book → rule → decision → ops.
 */

const RULES = [
  {
    id: 'atmospheric-perspective',
    // Reviewed from the original illustration, not inferred from OCR or a catalogue.
    // This is a reusable curated observation, not a claim of automatic scene vision.
    visualReview: {
      version: 1,
      sourceSha256: 'd1f85b38a1cc6bb97d51cd59d74dc577e0d823fa65cee150e38512fee7d70a0a',
      locator: { page: 176, coordinateSystem: 'normalized-page', region: { x: 0.079, y: 0.246, w: 0.591, h: 0.372 } },
      observation: 'In the main landscape illustration, nearby conifers are dark and distinct while the far shore and mountain shadows are lighter and more blue-violet, with reduced local contrast.',
      decision: 'Reduce distant terrain contrast by mixing it toward the sky; retain stronger foreground values. Blend percentages are ArtForge interpretation, not measurements from the illustration.',
      reviewMethod: 'vision-assisted inspection of the original PDF page raster; curated, not automatic per-request image understanding',
      inspectedRaster: { renderer: 'book-index openBook/renderPage', scale: 1.5, width: 1395, height: 1722, sha256: 'da62cab56d21b65343722c587ae1f1f1ee60dab68d2f102ab0e2a11f53b2436a' },
      reviewedAt: '2026-11-04',
      usage: 'reference-only; no source artwork is copied into the generated design',
    },
    concept: 'cpt-color-and-light-atmospheric-perspective',
    page: 176,
    topic: 'depth',
    decision: 'Distant layers move toward the sky colour and lose contrast; near layers keep full value and saturation.',
    params: { farMixToSky: 0.62, midMixToSky: 0.34, nearMixToSky: 0.08 },
    appliesTo: ['landscape', 'architecture', 'character'],
  },
  {
    id: 'warm-advance-cool-recede',
    concept: 'cpt-color-and-light-atmospheric-perspective',
    page: 178,
    topic: 'depth',
    decision: 'Foreground accents are kept warm, the far distance is shifted cool (bluer).',
    params: { farCoolShift: '#8fb3d9', nearWarmAccent: true },
    appliesTo: ['landscape', 'architecture'],
  },
  {
    id: 'three-light-systems-sunlight',
    concept: 'cpt-color-and-light-reflected-light',
    page: 28,
    topic: 'lighting',
    decision: 'Sunny scenes use three lights: warm sun as key, cool blue sky fill tinting the shadows, and a warm bounce from lit surfaces.',
    params: { shadowTint: 'rgba(40,70,140,0.32)', bounceTint: 'rgba(255,190,120,0.18)' },
    appliesTo: ['scene', 'landscape', 'architecture', 'character'],
    lighting: ['morning', 'sunset'],
  },
  {
    id: 'occlusion-shadows',
    concept: 'cpt-color-and-light-occlusion-shadow',
    page: 54,
    topic: 'shadows',
    decision: 'Where forms touch (furniture legs on the floor, feet, books on a shelf) a small dense dark accent is added.',
    params: { contactShadowAlpha: 0.55, contactBlur: 4 },
    appliesTo: ['scene', 'character', 'architecture', 'landscape'],
  },
  {
    id: 'hard-light-sharp-shadow',
    concept: 'cpt-how-to-render-edge',
    page: 12,
    topic: 'shadows',
    decision: 'Direct hard light (sun) gives sharp-edged cast shadows (small blur); diffuse or ambient light gives soft ones (large blur).',
    params: { hardBlur: 3, softBlur: 18 },
    appliesTo: ['scene', 'landscape', 'architecture', 'character'],
  },
  {
    id: 'key-light',
    concept: 'cpt-color-and-light-key-light',
    page: 56,
    topic: 'lighting',
    decision: 'One dominant key light per scene; every other source is weaker (lower alpha, smaller radius).',
    params: { keyAlpha: 0.55, secondaryAlpha: 0.28 },
    appliesTo: ['scene', 'landscape', 'architecture', 'character'],
  },
  {
    id: 'rim-light',
    concept: 'cpt-color-and-light-rim-light',
    page: 60,
    topic: 'lighting',
    decision: 'A backlit or side-lit figure gets a thin bright rim on the edges that face the light.',
    params: { rimWidth: 3, rimAlpha: 0.75 },
    appliesTo: ['scene', 'character'],
    lighting: ['night', 'sunset'],
  },
  {
    id: 'local-light-source',
    concept: 'cpt-color-and-light-light-source',
    page: 34,
    topic: 'lighting',
    decision: 'A practical lamp in a dark scene is a local source: a warm pool that falls off quickly around it.',
    params: { poolRadiusRatio: 0.28, poolAlpha: 0.45 },
    appliesTo: ['scene'],
    lighting: ['night'],
  },
  {
    id: 'color-temperature',
    concept: 'cpt-color-and-light-color-temperature',
    page: 39,
    topic: 'color',
    decision: 'Cool light sources (screens, moonlight) cool the lit surfaces; warm sources (lamps, sun) warm them. Mixed scenes keep both temperatures.',
    params: { coolLight: '#7fb2ff', warmLight: '#ffc27a' },
    appliesTo: ['scene', 'landscape', 'architecture', 'character'],
  },
  {
    id: 'contre-jour-silhouette',
    concept: 'cpt-color-and-light-silhouette',
    page: 62,
    topic: 'contrast',
    decision: 'Forms placed against the light (sunset) read as dark silhouettes with little interior detail.',
    params: { silhouetteDarken: 0.7 },
    appliesTo: ['landscape', 'architecture'],
    lighting: ['sunset'],
  },
  {
    id: 'limited-palette',
    concept: 'cpt-color-and-light-harmony',
    page: 104,
    topic: 'color',
    decision: 'Scene colours are derived from a restricted palette (the selected reference palette plus tints/shades), not arbitrary hues.',
    params: { maxBaseHues: 5 },
    appliesTo: ['scene', 'landscape', 'architecture', 'character', 'poster', 'card', 'table', 'text', 'ruled'],
  },
  {
    id: 'figure-proportion-balance',
    concept: 'cpt-figure-drawing-balance',
    page: 24,
    topic: 'figure',
    decision: 'The figure is built from proportions and balanced over its centre of gravity (over the supporting foot, or into the seat when seated).',
    params: {},
    appliesTo: ['character', 'scene'],
  },
  // ── added with the art-direction engine: composition, value, edges, figure, materials ──
  {
    id: 'composition-eye',
    concept: 'cpt-digital-art-masters-composition',
    page: 42,
    topic: 'composition',
    decision: 'Composition rules are guides, not laws: one focal subject placed by eye (thirds by default), with the rest subordinate.',
    params: { grid: 'thirds' },
    appliesTo: ['scene', 'landscape', 'architecture', 'character', 'abstract'],
  },
  {
    id: 'focal-flagging',
    concept: 'cpt-imaginative-realism-composition',
    page: 176,
    topic: 'composition',
    decision: 'The most important subject is separated from its surroundings by an opposite value placed behind it (light behind a dark head, dark behind a light one).',
    params: { haloAlpha: 0.22 },
    appliesTo: ['scene', 'character', 'landscape', 'architecture'],
  },
  {
    id: 'chiaroscuro',
    concept: 'cpt-imaginative-realism-composition',
    page: 161,
    topic: 'value',
    decision: 'Dramatic and night scenes are organised as light against dark: one lit area, the rest in shadow.',
    params: { ambientDarken: 0.45 },
    appliesTo: ['scene', 'landscape', 'architecture', 'character'],
    lighting: ['night'],
  },
  {
    id: 'cast-vs-form-shadow',
    concept: 'cpt-color-and-light-cast-shadow',
    page: 46,
    topic: 'shadows',
    decision: 'Each lit object gets a soft form shadow on its own turned-away side and a darker cast shadow on the surface it rests on, opposite the light.',
    params: { formShadowAlpha: 0.28, castShadowAlpha: 0.38 },
    appliesTo: ['scene', 'landscape', 'architecture', 'character'],
  },
  {
    id: 'shadow-edge',
    concept: 'cpt-color-and-light-shadow-edge',
    page: 50,
    topic: 'shadows',
    decision: 'Cast shadows in daylight are tinted by the blue sky, sharp near the object and softer with distance.',
    params: { daylightShadow: '#3c4f7a' },
    appliesTo: ['landscape', 'architecture', 'scene'],
    lighting: ['morning', 'sunset'],
  },
  {
    id: 'chroma-and-value',
    concept: 'cpt-color-and-light-value',
    page: 76,
    topic: 'value',
    decision: 'Value is decided before chroma: the picture is planned as 3-5 value masses, then coloured.',
    params: { valueSteps: 4 },
    appliesTo: ['scene', 'landscape', 'architecture', 'character', 'abstract', 'poster'],
  },
  {
    id: 'harmony-monochrome',
    concept: 'cpt-color-and-light-value',
    page: 110,
    topic: 'color',
    decision: 'A palette whose swatches share one hue is used as a monochromatic scheme: variety comes from value, not from added hues.',
    params: { maxHueSpread: 25 },
    appliesTo: ['scene', 'landscape', 'architecture', 'character', 'abstract', 'poster', 'card', 'text'],
  },
  {
    id: 'adaptation-contrast',
    concept: 'cpt-color-and-light-contrast',
    page: 146,
    topic: 'value',
    decision: 'Contrast is judged against the neighbour: the focal subject gets the strongest local contrast, distant planes the weakest.',
    params: { focalContrast: 1, farContrast: 0.45 },
    appliesTo: ['scene', 'landscape', 'architecture', 'character'],
  },
  {
    id: 'edge-control',
    concept: 'cpt-digital-art-masters-edge-control',
    page: 189,
    topic: 'edges',
    decision: 'Hard edges at the focal subject, softer (blurred) edges on far planes and at the periphery.',
    params: { farBlur: 1.6, midBlur: 0.4 },
    appliesTo: ['scene', 'landscape', 'architecture', 'character'],
  },
  {
    id: 'figure-gesture',
    concept: 'cpt-figure-drawing-gesture',
    page: 10,
    topic: 'figure',
    decision: 'A figure starts from one line of action through head, pelvis and supporting foot before any detail.',
    params: {},
    appliesTo: ['character', 'scene'],
  },
  {
    id: 'figure-proportion',
    concept: 'cpt-figure-drawing-proportion',
    page: 69,
    topic: 'figure',
    decision: 'Adult figures are about 7.5 heads tall; a seated figure about 5 heads, knees near seat height.',
    params: { heads: 7.5, seatedHeads: 5 },
    appliesTo: ['character', 'scene'],
  },
  {
    id: 'reflections',
    concept: 'cpt-how-to-render-reflection',
    page: 36,
    topic: 'materials',
    decision: 'Reflective materials (water, glass, polished surfaces) carry the colour of what faces them, usually the sky.',
    params: { reflectMix: 0.45 },
    appliesTo: ['scene', 'landscape', 'architecture'],
  },
  {
    id: 'dry-brush-texture',
    concept: 'cpt-digital-art-masters-texture',
    page: 14,
    topic: 'materials',
    decision: 'Rough textures (grass, foliage edges, stone) are suggested with stippled dry-brush strokes, mainly in the foreground.',
    params: { preset: 'rough' },
    appliesTo: ['landscape', 'scene', 'architecture', 'character'],
  },
];

/** Which agent skills each rule serves (book -> page -> rule -> skill). */
const RULE_SKILLS = {
  'atmospheric-perspective': ['depth-and-space', 'art-direction', 'color-light-shadow'],
  'warm-advance-cool-recede': ['depth-and-space', 'art-direction'],
  'three-light-systems-sunlight': ['color-light-shadow', 'art-direction'],
  'occlusion-shadows': ['value-and-form', 'figure-and-gesture', 'art-direction'],
  'hard-light-sharp-shadow': ['value-and-form', 'art-direction'],
  'key-light': ['color-light-shadow', 'art-direction'],
  'rim-light': ['color-light-shadow', 'figure-and-gesture'],
  'local-light-source': ['color-light-shadow', 'art-direction'],
  'color-temperature': ['color-light-shadow', 'mood-and-style', 'art-direction'],
  'contre-jour-silhouette': ['value-and-form', 'nature-elements'],
  'limited-palette': ['references', 'mood-and-style', 'visual-references'],
  'figure-proportion-balance': ['figure-and-gesture'],
  'composition-eye': ['composition', 'art-direction'],
  'focal-flagging': ['composition', 'art-direction'],
  chiaroscuro: ['value-and-form', 'mood-and-style'],
  'cast-vs-form-shadow': ['value-and-form', 'art-direction'],
  'shadow-edge': ['value-and-form', 'nature-elements'],
  'chroma-and-value': ['value-and-form'],
  'harmony-monochrome': ['visual-references', 'mood-and-style'],
  'adaptation-contrast': ['value-and-form', 'composition'],
  'edge-control': ['value-and-form', 'depth-and-space'],
  'figure-gesture': ['figure-and-gesture'],
  'figure-proportion': ['figure-and-gesture'],
  reflections: ['materials-and-texture', 'nature-elements'],
  'dry-brush-texture': ['materials-and-texture', 'nature-elements'],
};
for (const rule of RULES) rule.skills = RULE_SKILLS[rule.id] || [];

class KnowledgeRules {
  constructor(knowledge) {
    this.knowledge = knowledge;
    this.cache = null;
  }

  /** Resolve each rule's quote from the book index; ungrounded rules are reported, never invented. */
  grounded() {
    if (this.cache) return this.verifyIllustrations(this.cache);
    const index = this.knowledge && this.knowledge.isAvailable() ? this.knowledge.load() : null;
    const concepts = new Map(((index && index.concepts) || []).map((c) => [c.id, c]));
    this.cache = RULES.map((rule) => {
      const concept = concepts.get(rule.concept);
      const ref = concept && (concept.pageRefs || []).find((r) => Number(r.page) === rule.page && String(r.verified || '').startsWith('verified'));
      return Object.assign({}, rule, {
        grounded: Boolean(ref),
        citation: ref ? { bookId: concept.bookId, bookFile: concept.bookFile, page: ref.page, concept: concept.title, quote: ref.quote, verified: ref.verified } : null,
      });
    });
    return this.verifyIllustrations(this.cache);
  }

  verifyIllustrations(rules) {
    return rules.map((rule) => {
      if (!rule.visualReview) return rule;
      const source = rule.citation && this.knowledge && typeof this.knowledge.verifyOriginalSource === 'function'
        ? this.knowledge.verifyOriginalSource(rule.citation.bookId, rule.visualReview.sourceSha256)
        : { ok: false, reason: 'original-unavailable' };
      return Object.assign({}, rule, {
        grounded: rule.grounded && source.ok,
        visualEvidence: source.ok ? Object.assign({ bookId: rule.citation.bookId, file: rule.citation.bookFile }, rule.visualReview) : null,
        visualVerification: source.ok ? 'original-bytes-verified' : source.reason,
      });
    });
  }

  /** Grounded rules serving one agent skill. */
  forSkill(skillId) {
    return this.grounded().filter((rule) => rule.grounded && rule.skills.includes(skillId));
  }

  /** Catalogue rows: rule, book, page, quote, skills; grounded or not. */
  catalog() {
    return this.grounded().map((rule) => ({
      id: rule.id, topic: rule.topic, grounded: rule.grounded, skills: rule.skills, appliesTo: rule.appliesTo, lighting: rule.lighting || null,
      book: rule.citation ? rule.citation.bookId : null, file: rule.citation ? rule.citation.bookFile : null, page: rule.page,
      concept: rule.citation ? rule.citation.concept : rule.concept, verified: rule.citation ? rule.citation.verified : null,
      quote: rule.citation ? String(rule.citation.quote).slice(0, 200) : null, decision: rule.decision,
    }));
  }

  /** Rules relevant to a design type + lighting. */
  select(type, lighting) {
    return this.grounded().filter((rule) => rule.grounded
      && rule.appliesTo.includes(type)
      && (!rule.lighting || (lighting && rule.lighting.includes(lighting))));
  }
}

/** Collects which rule changed which decision and which ops implemented it. */
class EvidenceLog {
  constructor(rules, enabled) {
    this.enabled = enabled !== false;
    this.rules = new Map((rules || []).map((r) => [r.id, r]));
    this.entries = [];
  }

  /** True when the rule is available AND references are enabled for this run. */
  on(ruleId) {
    return this.enabled && this.rules.has(ruleId);
  }

  record(ruleId, decision, opIndexes, element) {
    if (!this.on(ruleId)) return;
    const rule = this.rules.get(ruleId);
    this.entries.push({
      rule: ruleId,
      book: rule.citation.bookId,
      page: rule.citation.page,
      concept: rule.citation.concept,
      quote: String(rule.citation.quote).slice(0, 220),
      principle: rule.decision,
      decision,
      ...(rule.visualEvidence ? { visualEvidence: rule.visualEvidence } : {}),
      element: element || null,
      ops: opIndexes,
      // Traceable = the decision is bound to the drawing operations that carry it out. A decision without ops
      // (art direction, palette choice) may still shape the image, but cannot be checked op by op.
      traceable: Array.isArray(opIndexes) && opIndexes.length > 0,
      interpretation: 'ArtForge parameters are an interpretation of the quoted principle, not text from the book.',
    });
  }

  summary() {
    return {
      enabled: this.enabled,
      rulesAvailable: Array.from(this.rules.keys()),
      applied: this.entries,
      // appliedCount used to count every entry (15 of 18 had no ops in the audited run): it now counts only
      // decisions bound to drawing ops; the rest are reported as directed decisions.
      appliedCount: this.entries.filter((e) => e.traceable).length,
      directedCount: this.entries.filter((e) => !e.traceable).length,
      decisionCount: this.entries.length,
    };
  }
}

module.exports = { RULES, RULE_SKILLS, KnowledgeRules, EvidenceLog };
