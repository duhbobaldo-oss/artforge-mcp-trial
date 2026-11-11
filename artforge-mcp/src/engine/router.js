'use strict';

const crypto = require('node:crypto');
const { context: traceContext } = require('./trace-context');
const { requestContract } = require('./request-contract');
const { contrast } = require('./color');
const { matchSkills, getSkill } = require('./skills');
const { hexToHsl } = require('./references');
const { analyzeIntent } = require('./intent');
const { compose, COMPOSED_TYPES } = require('./composer');
const { KnowledgeRules, EvidenceLog } = require('./knowledge-rules');
const { fitCopy } = require('./composer/text-layout');
const { understandRequest } = require('./understanding');
const { buildSceneGraph, summarizeGraph } = require('./scene-graph');
const { routeSkills } = require('./skill-router');
const { analyzeReferences } = require('./reference-analysis');
const { directArt, summarizeArt } = require('./art-direction');
const { compileSceneSpec } = require('./scenespec-engine');
const { PRIORS } = require('./scene-graph');
const { composeHybrid } = require('./hybrid');

/** Mass elements (stars, grass…) are textures, not individually arranged objects. */
const MASS = new Set(['stars', 'flowers', 'grass', 'birds', 'clouds', 'sky', 'garden']);

/**
 * Why a picture needs scene-graph placement (empty = the composer alone is the right engine):
 * spatial relations, several instances that must each exist, elements the composer was not given or did not draw,
 * or a negated element the composer added on its own.
 */
function arrangementNeed(understanding, intent, result) {
  const reasons = [];
  if(understanding.entities.some(e=>e.attributes.rigPose || e.attributes.phase==='crescent')) reasons.push('explicit articulated pose');
  // Relations among environment only («sky behind grass») are already true by depth order: no re-arrangement.
  const ENV = new Set(['sky', 'grass', 'garden', 'hills', 'mountains', 'sea', 'lake', 'river', 'dunes', 'road', 'clouds', 'stars', 'sun', 'moon']);
  const objectRelations = understanding.relations.filter((r) => [r.subject, r.object, r.object2].filter(Boolean).some((ref) => !ENV.has(String(ref).split('#')[0])));
  if (objectRelations.length) reasons.push(`${objectRelations.length} spatial relation(s)`);
  const multi = understanding.entities.filter((e) => e.count >= 2 && PRIORS[e.motif] && !MASS.has(e.motif));
  if (multi.length) reasons.push(`counts: ${multi.map((e) => `${e.id}×${e.count}`).join(', ')}`);
  const given = new Set(intent.elements.map((e) => e.id));
  const unseen = understanding.entities.filter((e) => !given.has(e.id) && PRIORS[e.motif]);
  if (unseen.length) reasons.push(`not given to the composer: ${unseen.map((e) => e.id).join(', ')}`);
  const missing = (result.missing || []).filter((m) => PRIORS[m]);
  if (missing.length) reasons.push(`composer cannot draw: ${missing.join(', ')}`);
  const excluded = new Set(understanding.constraints.excluded || []);
  const drawnExcluded = (result.ops || []).filter((o) => o.element && excluded.has(require('./motifs').motifOf(o.element)));
  if (drawnExcluded.length) reasons.push(`composer added a negated element: ${[...new Set(drawnExcluded.map((o) => o.element))].join(', ')}`);
  return reasons;
}

const rulesCache = new WeakMap();
function rulesFor(knowledge) {
  if (!knowledge) return null;
  if (!rulesCache.has(knowledge)) rulesCache.set(knowledge, new KnowledgeRules(knowledge));
  return rulesCache.get(knowledge);
}

/** Visual designs draw only text the caller supplied explicitly; the prompt itself is never drawn. */
function explicitContent(input, type) {
  const limits = { headline: 300, body: type === 'ruled' ? 20000 : 2000, kicker: 200 };
  const out = { headline: '', body: '', kicker: '', source: 'caller' };
  for (const field of ['headline', 'body', 'kicker']) {
    const value = input[field] || (field === 'headline' ? input.title : null);
    if (!value) continue;
    if (String(value).length > limits[field]) {
      const error = new Error(`${field} is ${String(value).length} characters; the maximum is ${limits[field]}. Shorten it instead of letting it be cut.`);
      error.code = 'TEXT_TOO_LONG';
      throw error;
    }
    out[field] = String(value);
  }
  if (!out.headline && !out.body) out.source = 'none';
  return out;
}

function composedSkill(intent) {
  return {
    id: `compose-${intent.type}`,
    name: intent.label,
    nameEn: intent.type,
    bestFor: intent.label,
    canvas: intent.defaultCanvas,
    typography: { headlineRatio: 0.05, bodyRatio: 0.022, kickerRatio: 0.016 },
  };
}

const PHASE_TEMPLATE = [
  { key: 'index', order: 1, title: 'محرك الفهرسة والمهارات والتوجيه', titleEn: 'Indexing, skills and routing' },
  { key: 'references', order: 2, title: 'استدعاء مراجع التصميم وتحليلها', titleEn: 'Design references resolved' },
  { key: 'tool-docs', order: 3, title: 'استدعاء شرح الأداة', titleEn: 'Tool documentation consulted' },
  { key: 'execute', order: 4, title: 'تنفيذ التصميم بالأداة', titleEn: 'Design executed with the drawing tool' },
  { key: 'deliver', order: 5, title: 'إظهار التصميم وحفظ النتيجة', titleEn: 'Preview, save and export' },
];

const LIGHT_TEXT = '#f8fafc';
const DARK_TEXT = '#0b1220';

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function toRgba(hex, alpha) {
  const value = String(hex).replace('#', '');
  const r = parseInt(value.slice(0, 2), 16);
  const g = parseInt(value.slice(2, 4), 16);
  const b = parseInt(value.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

function luminanceOf(hex) {
  const value = String(hex).replace('#', '');
  const r = parseInt(value.slice(0, 2), 16) / 255;
  const g = parseInt(value.slice(2, 4), 16) / 255;
  const b = parseInt(value.slice(4, 6), 16) / 255;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Build the colour roles used by the layout from the extracted reference colours. */
function buildColorRoles(paletteEntries) {
  const colors = [];
  for (const entry of paletteEntries) {
    for (const color of entry.palette.colors) {
      if (!colors.includes(color.hex)) colors.push(color.hex);
    }
  }
  if (colors.length < 2) colors.push('#0b1220', '#f8fafc');

  const sortedByLuma = colors.slice().sort((a, b) => luminanceOf(a) - luminanceOf(b));
  const sortedBySaturation = colors.slice().sort((a, b) => hexToHsl(b).saturation - hexToHsl(a).saturation);
  const darkest = sortedByLuma[0];
  const lightest = sortedByLuma[sortedByLuma.length - 1];
  const accent = sortedBySaturation[0];
  const secondary = sortedBySaturation[1] || sortedBySaturation[0];
  const darkTone = luminanceOf(darkest) < 0.35;

  return {
    colors,
    background: darkTone ? darkest : lightest,
    backgroundAlt: darkTone
      ? (sortedByLuma[1] || darkest)
      : (sortedByLuma[sortedByLuma.length - 2] || lightest),
    text: darkTone ? LIGHT_TEXT : DARK_TEXT,
    accent,
    secondary,
    darkTone,
  };
}

function deriveContent(prompt, input) {
  const explicitHeadline = input.headline || input.title;
  const explicitBody = input.body || input.subtitle;
  const explicitKicker = input.kicker || input.eyebrow;
  // النص الصريح يُرسم حرفيًا؛ القطع الصامت السابق كان يُنتج تصميمًا لا يطابق النص المطلوب.
  for (const [field, value, max] of [['headline', explicitHeadline, 300], ['body', explicitBody, 2000], ['kicker', explicitKicker, 200]]) {
    if (value && String(value).length > max) {
      const error = new Error(`${field} is ${String(value).length} characters; the maximum is ${max}. Shorten it instead of letting it be cut.`);
      error.code = 'TEXT_TOO_LONG';
      throw error;
    }
  }
  if (explicitHeadline) {
    return {
      headline: String(explicitHeadline),
      body: explicitBody ? String(explicitBody) : '',
      kicker: explicitKicker ? String(explicitKicker) : '',
      source: 'caller',
    };
  }
  if (wantsNoText(prompt)) return { headline: '', body: '', kicker: '', source: 'no-text' };
  const quoted = /["“«](.{2,90}?)["”»]/.exec(prompt);
  if (quoted) {
    return { headline: quoted[1], body: explicitBody ? String(explicitBody) : '', kicker: explicitKicker ? String(explicitKicker) : '', source: 'quoted' };
  }
  // The request is an instruction, not copy. Only a short one-line request may stand in for a headline;
  // a long instruction is never drawn (that produced posters showing "اختبار عملي لنسخة…" as the title).
  const cleaned = String(prompt)
    .replace(/^(اعمل|صمم|صمّم|أنشئ|انشئ|اصنع|أعد|اعد|design|create|make|generate|build)\s+/i, '')
    .trim();
  if (cleaned.length > 80 || /[\n.؛]/.test(cleaned.replace(/\.$/, ''))) {
    const error = new Error('No text to draw: pass the exact words in headline (and body/kicker). ArtForge never draws the request itself. '
      + 'If this is a picture (person, scene, landscape, building), pass designType instead.');
    error.code = 'TEXT_REQUIRED';
    throw error;
  }
  return {
    headline: cleaned || 'تصميم جديد',
    body: explicitBody ? String(explicitBody) : '',
    kicker: explicitKicker ? String(explicitKicker) : '',
    source: 'derived',
  };
}

/** "بدون كتابة" / "لا نص" / "no text": the user wants an image with no words at all. */
function wantsNoText(prompt) {
  const p = String(prompt || '').toLowerCase().replace(/[إأآ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي');
  return /(بدون|دون|بلا|لا|ممنوع|من غير)\s+(اي\s+|أي\s+)?(كتابه|كتابات|نص|نصوص|كلمات|كلام|عناوين|حروف)/.test(p)
    || /\b(no|without)\s+(any\s+)?(text|words|lettering|titles?)\b|text-free/.test(p);
}

module.exports = { PHASE_TEMPLATE, buildColorRoles, deriveContent, deriveDocumentName, toRgba, luminanceOf, clamp, wantsNoText };

/** اسم مستند من طلب المستخدم الحالي (الاسم الصريح أو العنوان)، لا من محتوى سابق. */
function deriveDocumentName(input, content) {
  const explicit = input && input.name ? String(input.name) : null;
  const raw = explicit || (content && content.headline) || 'ArtForge';
  const safe = raw.replace(/\s+/g, ' ').trim().slice(0, 60);
  return safe || 'ArtForge design';
}

function buildPlan(input, deps) {
  const prompt = String(input.prompt || '').trim();
  if (!prompt) throw new Error('prompt is required: describe the design you want');
  const { library, knowledge } = deps;

  const planningStarted = performance.now();
  if (input.sceneSpec) {
    require('./scene-spec').validateSceneSpec(input.sceneSpec);
    input = Object.assign({}, input, { designType: input.designType || 'scene', elements: [...new Set([...(input.elements || []), ...input.sceneSpec.elements.map((e) => e.id)])] });
    if (wantsNoText(prompt) && input.sceneSpec.operations.some((op) => op.op === 'draw.text')) {
      const error = new Error('The request prohibits text but sceneSpec contains draw.text'); error.code = 'SCENE_TEXT_CONFLICT'; throw error;
    }
  }
  const intent = analyzeIntent(prompt, input);
  const explicitWorld=input.artDirection&&(input.artDirection.world===true||input.artDirection.perspective==='three-point');
  const explicitRig=input.artDirection?.anatomy==='rig-v1';
  if(!input.sceneSpec&&!input.designType&&!input.headline&&(explicitWorld||explicitRig)){
    const room=intent.elements.some(e=>['bed','armchair','diningTable','desk','coffeeTable','sofa'].includes(e.id));
    intent.type=explicitWorld?(room?'scene':'architecture'):(room?'scene':'character');
    intent.label=require('./intent').DESIGN_TYPES[intent.type].label;intent.defaultCanvas=require('./intent').DESIGN_TYPES[intent.type].canvas;intent.reason+='; explicit geometry option';
  }
  if(explicitWorld&&['composer','hybrid'].includes(input.engine))throw Object.assign(new Error('World camera requires engine auto or scene-graph'),{code:'WORLD_REQUIRES_SCENE_GRAPH'});
  // ② Understanding: entities, counts (incl. Arabic duals), relations, negations, constraints.
  const understanding = understandRequest(prompt, input, intent);
  // The same required instances must reach compilation and coverage (Arabic duals
  // were previously drawn by the graph but absent from the verification inventory).
  for (const entity of understanding.entities) {
    const existing = intent.elements.find(e => e.id === entity.id);
    if (existing) { if (entity.count > 1) existing.count = entity.count; }
    else intent.elements.push({id:entity.id,matched:[],count:entity.count});
  }
  // A negated element («بدون نباتات») is never drawn, even though the keyword matched.
  if (understanding.constraints.excluded.length) intent.elements = intent.elements.filter((e) => !understanding.constraints.excluded.includes(e.id));
  const pictureWords = /(?:ارسم|رسم|مرسوم|مشهد|illustration|\bdraw\b|\bdrawing\b|\bscene\b)/i.test(prompt);
  const drawableEntities = understanding.entities.filter((e) => PRIORS[e.motif]);
  // ⑧ The SceneSpec engine draws from the scene graph when asked, or when no composer matches a picture request
  // whose elements it knows (instead of refusing with VISUAL_PLAN_REQUIRED).
  // Engine: explicit choice wins; otherwise "auto" decides after the composer has drawn (see arrangementNeed).
  let engineChoice = input.sceneSpec ? 'caller-scenespec' : (['composer', 'hybrid'].includes(input.engine) ? input.engine : 'auto');
  if (!input.sceneSpec && input.engine === 'scene-graph') engineChoice = 'scene-graph';
  else if (!input.sceneSpec && intent.type === 'text' && !input.headline && pictureWords && drawableEntities.length) engineChoice = 'scene-graph-fallback';
  if(!input.sceneSpec && input.artDirection && (input.artDirection.perspective==='three-point'||input.artDirection.world===true) && engineChoice==='auto') engineChoice='scene-graph';
  if(!input.sceneSpec&&engineChoice==='auto'&&explicitRig&&understanding.entities.some(e=>['desk','reclining'].includes(e.attributes.rigPose)))engineChoice='scene-graph';
  if(!input.sceneSpec&&engineChoice==='auto'&&understanding.entities.some(e=>e.motif==='diningTable')&&understanding.entities.some(e=>e.motif==='armchair'&&e.count>=2))engineChoice='scene-graph';
  if (engineChoice.startsWith('scene-graph') && !COMPOSED_TYPES.has(intent.type)) {
    const roomish = drawableEntities.some((e) => ['floor', 'wall', 'surface'].includes(PRIORS[e.motif].anchor));
    intent.type = roomish ? 'scene' : 'landscape';
    intent.label = require('./intent').DESIGN_TYPES[intent.type].label;
    intent.defaultCanvas = require('./intent').DESIGN_TYPES[intent.type].canvas;
    intent.reason = `${intent.reason}; drawn by the scene-graph engine`;
    understanding.designType = intent.type;
  }
  // A model-authored layout (infographic, poster with UI cards…) is drawn as authored in ONE call, whatever the
  // design type; refusing it made clients rebuild the same layout with dozens of single-shape calls.
  if (input.sceneSpec && !COMPOSED_TYPES.has(intent.type)) {
    const requested = intent.type;
    intent.type = 'scene';
    intent.label = `${require('./intent').DESIGN_TYPES[requested].label} (model-authored sceneSpec)`;
    intent.defaultCanvas = require('./intent').DESIGN_TYPES[requested].canvas;
    intent.reason = `${intent.reason}; sceneSpec drawn as authored for a ${requested} design`;
  }
  input = Object.assign({}, input, { _planningStarted: planningStarted });
  // A picture request is always drawn. skillId selects a TEXT layout template (poster, card…) and must never
  // turn a person/scene/landscape/building into a text card; it is ignored (and reported) for visual types.
  if (!input.sceneSpec && intent.type === 'text' && !input.headline && pictureWords) {
    const error = new Error('No supported composition matches this picture request. Supply sceneSpec with explicit elements and documented geometry; the prompt will not be rendered as text.');
    error.code = 'VISUAL_PLAN_REQUIRED'; throw error;
  }
  const composed = COMPOSED_TYPES.has(intent.type);
  const ignored = composed && input.skillId ? [`skillId "${input.skillId}" ignored: it is a text-layout template and this request is a ${intent.type} drawing`] : [];
  const matches = matchSkills(prompt);
  let skill;
  if (composed) skill = composedSkill(intent);
  else if (input.skillId) skill = getSkill(input.skillId);
  else if (input.designType && getSkill(input.designType)) skill = getSkill(input.designType);
  else if (intent.type === 'card' && !matches[0].hits.length) skill = getSkill('card');
  else skill = matches[0].skill;
  if (!skill) throw new Error(`unknown skillId: ${input.skillId}`);

  // Requested size wins: explicit width/height, then a size written in the prompt, then the type default.
  const fallbackCanvas = composed ? intent.defaultCanvas : skill.canvas;
  const promptCanvas = intent.explicitCanvas && intent.explicitCanvas.source !== 'input' ? intent.explicitCanvas : null;
  const canvas = {
    width: Number(input.width || (promptCanvas && promptCanvas.width) || fallbackCanvas.width),
    height: Number(input.height || (promptCanvas && promptCanvas.height) || fallbackCanvas.height),
  };
  if (!(canvas.width >= 32 && canvas.width <= 8192 && canvas.height >= 32 && canvas.height <= 8192)) {
    throw new Error('width/height must be between 32 and 8192');
  }

  // One reference palette by default: one coherent colour layer per design (palettes: 2-3 only on request).
  const paletteLimit = clamp(Number(input.palettes || 1), 1, 3);
  const paletteEntries = library.scorePalettes(prompt, { limit: paletteLimit, intent });

  let designSystem;
  let designSystemReasons;
  if (input.designSystemId) {
    const found = library.get('design-system', input.designSystemId);
    if (!found) throw new Error(`unknown designSystemId: ${input.designSystemId}`);
    designSystem = found;
    designSystemReasons = ['explicitly requested'];
  } else {
    const scored = library.scoreDesignSystems(prompt, canvas);
    designSystem = scored[0].designSystem;
    designSystemReasons = scored[0].reasons;
  }

  // A user reference image supplies its own colours (extracted from its pixels) instead of the library palette.
  const refColors = input.referenceAnalysis && Array.isArray(input.referenceAnalysis.colors) ? input.referenceAnalysis.colors.map((c) => ({ hex: c.hex || c })) : null;
  // One colour layer from the chosen reference (derived in OKLab when the requested mood is not on the card).
  const layer = library.colorLayer ? library.colorLayer(paletteEntries[0], prompt, intent) : { colors: null, derived: null };
  if (layer.derived) paletteEntries[0].derivedLayer = { mode: layer.derived, colors: layer.colors };
  const layerEntries = layer.derived ? [{ palette: { colors: layer.colors.map((hex) => ({ hex })) } }].concat(paletteEntries.slice(1)) : paletteEntries;
  const roles = buildColorRoles(refColors && refColors.length >= 2 ? [{ palette: { colors: refColors } }] : layerEntries);
  let content = composed ? explicitContent(input, intent.type) : deriveContent(prompt, input);
  if (composed && wantsNoText(prompt) && (content.headline || content.body || content.kicker)) {
    ignored.push('headline/body/kicker ignored: the request says the image must contain no text');
    content = { headline: '', body: '', kicker: '', source: 'no-text' };
  }
  const refsOn = input.useReferences !== false;

  // ② knowledge from the nine books: only the books this request needs.
  let knowledgeSelection = { books: [], concepts: [], warnings: [], available: false };
  if (refsOn && knowledge && knowledge.isAvailable()) {
    const limit = clamp(Number(input.knowledgeBooks || 2), 1, 3);
    const books = knowledge.selectBooks(prompt, {
      limit,
      skillId: skill.id,
      books: Array.isArray(input.books) ? input.books : undefined,
    });
    const bookIds = books.map((entry) => entry.bookId);
    const concepts = bookIds.length
      ? knowledge.retrieve(prompt, { books: bookIds, limit: clamp(Number(input.knowledgeConcepts || 5), 1, 12) })
      : [];
    const warnings = [];
    const toolBound = books.filter((entry) => entry.toolBound);
    if (toolBound.length) {
      warnings.push(
        `مراجع مرتبطة بأدوات ${toolBound.map((entry) => entry.toolBound).join(', ')}: `
        + 'تُستخدم مفاهيمها كتوجيه فني فقط، ولا تُنفَّذ إلا إذا طابقت عملية موثّقة في أداة ArtForge.',
      );
    }
    for (const concept of concepts) {
      if (concept.toolMapping && concept.toolMapping.supported === 'no') {
        warnings.push(`«${concept.title}» (${concept.bookId} ص${concept.page}) غير مدعوم في أداة ArtForge: ${concept.toolMapping.note}`);
      }
    }
    knowledgeSelection = {
      available: true,
      books: books.map((entry) => ({
        id: entry.bookId,
        title: entry.title,
        file: entry.file,
        specialty: entry.specialty,
        categories: entry.categories,
        score: entry.score,
        reasons: entry.reasons,
        matchedIntents: entry.matchedIntents,
        secondarySource: entry.secondarySource,
        toolBound: entry.toolBound,
        conceptsIndexed: entry.conceptCount,
      })),
      concepts,
      warnings,
      rules: {
        maxBooks: 3,
        irrelevantBooksCalled: 0,
        evidencePolicy: 'كل مفهوم مرتبط بصفحة واقتباس؛ لا تُنسخ نصوص الكتب إلى التصميم.',
      },
    };
  }
  const ruleSet = refsOn ? rulesFor(knowledge) : null;
  const evidence = new EvidenceLog(ruleSet ? ruleSet.select(intent.type, intent.lighting) : [], refsOn);
  if (input.sceneSpec) {
    const sources = new Set([...paletteEntries.map((p) => p.palette.id), designSystem.id, ...knowledgeSelection.books.map((b) => b.id)]);
    for (const application of input.sceneSpec.referenceApplications || []) {
      if (!refsOn || !sources.has(application.sourceId)) {
        const error = new Error('sceneSpec reference source must be one of this plan selected palettes, styleguide or books'); error.code = 'INVALID_SCENE_REFERENCE'; throw error;
      }
    }
  }
  // ④ skills, ⑤ reference rules, ③ scene graph and ⑦ art direction, computed for every plan and attached as `direction`.
  const references = analyzeReferences({ paletteEntries, designSystem, referenceAnalysis: input.referenceAnalysis || null, referenceImage: input.referenceImage || null });
  const direction = {
    version: 1,
    engine: engineChoice,
    understanding,
    skills: routeSkills(understanding, Object.assign({}, input, { sceneSpec: input.sceneSpec, engine: engineChoice.startsWith('scene-graph') ? 'scene-graph' : input.engine })),
    references,
    reviewOptions: input.review && typeof input.review === 'object' ? { correct: input.review.correct !== false, maxRounds: input.review.maxRounds } : { correct: true, maxRounds: 2 },
  };
  const pictureType = ['scene', 'character', 'landscape', 'architecture'].includes(intent.type);
  if (composed && pictureType) {
    direction.graph = buildSceneGraph(understanding, canvas);
    direction.art = directArt({ understanding, graph: direction.graph, references, rules: ruleSet ? ruleSet.grounded() : [], roles, overrides: input.artDirection });
  }
  if ((engineChoice === 'hybrid') && !pictureType) {
    const error = new Error(`The hybrid engine places pictures (scene, landscape, character, architecture); "${intent.type}" is laid out by its own composer.`); error.code = 'ENGINE_NOT_APPLICABLE'; throw error;
  }
  const pureGraph = () => {
    if (!direction.graph) {
      const error = new Error(`The scene-graph engine draws pictures (scene, landscape, character, architecture); "${intent.type}" is laid out by its own composer.`); error.code = 'ENGINE_NOT_APPLICABLE'; throw error;
    }
    const compiled = compileSceneSpec(direction.graph, direction.art, { roles, useReferences: refsOn, seed: input.seed, understanding, noText: wantsNoText(prompt) });
    direction.spec = { check: compiled.check, drawn: compiled.drawn };
    if (!compiled.check.complete || !compiled.check.executable) {
      const error = new Error(`Generated SceneSpec is not complete: ${compiled.check.issues.map((i) => i.code + (i.node ? ` ${i.node}` : '') + (i.entity ? ` ${i.entity}` : '')).join(', ')}`);
      error.code = 'SCENESPEC_INCOMPLETE'; error.details = compiled.check; throw error;
    }
    input = Object.assign({}, input, { sceneSpec: compiled.spec });
    for (const r of direction.art.rulesApplied) if (evidence.on(r.rule)) evidence.record(r.rule, r.decision, [], 'art-direction');
  };
  if (engineChoice.startsWith('scene-graph')) {
    pureGraph();
    if (engineChoice === 'scene-graph-fallback') ignored.push('No built-in composer matches this picture; it was drawn by the scene-graph engine from the understood elements and relations.');
  }
  if (composed) {
    let result = compose(intent, { canvas, roles, content, input, evidence, analysis: input.referenceAnalysis || null, prompt, understanding });
    const need = pictureType && !input.sceneSpec ? arrangementNeed(understanding, intent, result) : [];
    if(input.artDirection && input.artDirection.perspective==='three-point') need.push('three-point camera');
    if (engineChoice === 'hybrid' || (engineChoice === 'auto' && need.length)) {
      // Composer detail + scene-graph placement. If the merge cannot guarantee the request, draw from the graph alone.
      const hybrid = composeHybrid({ result, understanding, canvas, rules: ruleSet ? ruleSet.grounded() : [], roles, references, refsOn, seed: input.seed, overrides: input.artDirection, noText: wantsNoText(prompt) });
      const relationsOk = hybrid.graph.check.relations.every((r) => r.holds);
      const drawableMissing = hybrid.missing.filter((m) => PRIORS[m]);
      direction.autoSelect = { reasons: need, requested: engineChoice };
      if (relationsOk && !drawableMissing.length) {
        engineChoice = 'hybrid';
        direction.graph = hybrid.graph; direction.art = hybrid.art;
        direction.hybrid = { sources: hybrid.sources, removed: hybrid.removed };
        direction.reviewOptions = Object.assign({ fixes: ['RELATION_BROKEN', 'OCCLUDED', 'ELEMENT_OFF_CANVAS', 'TOUCHES_EDGE'] }, direction.reviewOptions);
        for (const r of hybrid.art.rulesApplied) if (evidence.on(r.rule)) evidence.record(r.rule, r.decision, [], 'art-direction');
        result = Object.assign({}, result, { ops: hybrid.ops, coverage: hybrid.coverage, missing: hybrid.missing, limits: hybrid.limits, meta: Object.assign({}, result.meta, { hybrid: direction.hybrid }) });
        ignored.push(`Scene-graph placement applied (${need.join('; ') || 'requested'}): the ${intent.type} composer's rendering is kept and placed to satisfy the requested counts and relations.`);
      } else {
        engineChoice = 'scene-graph-auto';
        direction.hybridRejected = { relationsOk, missing: drawableMissing };
        direction.graph = buildSceneGraph(understanding, canvas);
        direction.art = directArt({ understanding, graph: direction.graph, references, rules: ruleSet ? ruleSet.grounded() : [], roles, overrides: input.artDirection });
        pureGraph();
        result = compose(intent, { canvas, roles, content, input, evidence, analysis: input.referenceAnalysis || null, prompt, understanding });
        ignored.push(`Drawn by the scene-graph engine: merging with the ${intent.type} composer could not guarantee ${drawableMissing.length ? `the elements ${drawableMissing.join(', ')}` : 'every requested relation'}.`);
      }
    } else if (engineChoice === 'auto') engineChoice = 'composer';
    if (engineChoice === 'composer' && direction.graph) {
      // No silent success: what the composer was not given or could not draw is missing, and said so.
      const given = new Set(intent.elements.map((e) => e.id));
      const unseen = understanding.entities.filter((e) => !given.has(e.id) && PRIORS[e.motif]);
      const drawable = (result.missing || []).filter((m) => PRIORS[m]);
      if (unseen.length) {
        ignored.push(`Understood but not passed to the ${intent.type} composer: ${unseen.map((e) => `${e.id}×${e.count}`).join(', ')}. engine:"auto" or "hybrid" draws them.`);
        result = Object.assign({}, result, { missing: [...new Set([...(result.missing || []), ...unseen.map((e) => e.motif)])] });
      }
      if (drawable.length) ignored.push(`engine:"auto" or "hybrid" can draw the missing ${drawable.join(', ')}.`);
      if (understanding.relations.length) ignored.push(`Spatial relations (${understanding.relations.map((r) => `${r.subject} ${r.relation} ${r.object}`).join('; ')}) are not enforced by the composer (engine:"composer" was requested).`);
    }
    direction.engine = engineChoice;
    // A generated SceneSpec is the engine's own output, not a caller's: route to the engine skills.
    if (engineChoice !== 'composer' && engineChoice !== 'caller-scenespec') direction.skills = routeSkills(understanding, Object.assign({}, input, { engine: 'scene-graph', sceneSpec: undefined }));
    return planEnvelope({
      input, prompt, skill, matches, canvas, paletteEntries, designSystem, designSystemReasons, roles, content,
      typography: null, ops: result.ops, library, knowledgeSelection, intent, evidence, composition: result, notices: ignored, direction,
    });
  }
  if (engineChoice === 'auto') engineChoice = 'composer';
  direction.engine = engineChoice;
  const contextDirection = direction;

  const typography = {
    headline: {
      family: input.headlineFont || 'Amiri',
      size: Math.round(canvas.width * skill.typography.headlineRatio),
      weight: 700,
      lineHeight: 1.25,
    },
    body: {
      family: input.bodyFont || 'Tajawal',
      size: Math.round(canvas.width * skill.typography.bodyRatio),
      weight: 400,
      lineHeight: 1.6,
    },
    kicker: {
      family: input.bodyFont || 'Tajawal',
      size: Math.round(canvas.width * skill.typography.kickerRatio),
      weight: 700,
      lineHeight: 1.4,
    },
  };

  const layout = skill.layout;
  const margin = Math.round(Math.min(canvas.width, canvas.height) * layout.marginRatio);
  const ops = [];

  ops.push({
    op: 'document.create',
    note: 'canvas + gradient background derived from the reference palette',
    createsDocument: true,
    params: {
      name: String(input.name || content.headline).slice(0, 60),
      width: canvas.width,
      height: canvas.height,
      background: {
        type: 'gradient',
        gradient: {
          type: 'linear',
          angle: 135,
          stops: [
            { offset: 0, color: roles.background },
            { offset: 1, color: roles.backgroundAlt },
          ],
        },
      },
      locale: 'ar',
      notes: `Generated by ArtForge AI MCP from: ${prompt.slice(0, 180)}`,
    },
  });

  ops.push({ op: 'layer.add', note: 'background layer', alias: 'background', params: { name: 'الخلفية' } });
  ops.push({ op: 'layer.add', note: 'shapes layer', alias: 'shapes', params: { name: 'الأشكال' } });
  ops.push({ op: 'layer.add', note: 'text layer', alias: 'text', params: { name: 'النصوص' } });

  ops.push({
    op: 'draw.gradient',
    note: 'radial accent glow from the reference accent colour',
    params: {
      layer: 'background',
      x: 0,
      y: 0,
      w: canvas.width,
      h: canvas.height,
      gradientType: 'radial',
      stops: [
        { offset: 0, color: toRgba(roles.accent, 0.35) },
        { offset: 1, color: toRgba(roles.background, 0) },
      ],
    },
  });

  for (let index = 0; index < layout.circles.count; index += 1) {
    const size = Math.round(Math.min(canvas.width, canvas.height) * layout.circles.sizeRatio * (1 - index * 0.08));
    ops.push({
      op: 'draw.ellipse',
      note: 'decorative circle from the palette',
      params: {
        layer: 'background',
        x: margin + index * Math.round(size * 1.35),
        y: Math.min(Math.round(canvas.height * layout.circles.yRatio), canvas.height - margin - size),
        w: size,
        h: size,
        fill: toRgba(roles.secondary, 0.22),
        stroke: toRgba(roles.text, 0.22),
        strokeWidth: 2,
      },
    });
  }

  return finishPlan({ input, prompt, skill, matches, canvas, paletteEntries, designSystem, designSystemReasons, roles, content, typography, layout, margin, ops, library, knowledgeSelection, intent, evidence, direction: contextDirection });
}

function finishPlan(context) {
  const {
    input, prompt, skill, matches, canvas, paletteEntries, designSystem,
    designSystemReasons, roles, content, typography, layout, margin, ops, library,
    knowledgeSelection,
  } = context;

  const fitted = fitCopy(canvas, layout, margin, content, typography);
  Object.assign(typography, fitted.fonts);
  const anchorX = canvas.width - margin - fitted.padding;
  const headlineMaxWidth = fitted.widths.headline;
  const bodyMaxWidth = fitted.widths.body;
  const cardHeight = fitted.height;
  const cardTop = fitted.top;
  const cardWidth = canvas.width - margin * 2;
  const { kicker: kickerY, headline: headlineY, body: bodyY } = fitted.positions;
  const lineY = fitted.lineY;

  // Decorations must not straddle the fitted content frame on short/landscape canvases.
  let circleRight = margin;
  for (const step of ops.filter((o) => o.op === 'draw.ellipse' && o.note === 'decorative circle from the palette')) {
    const p = step.params;
    p.x = circleRight;
    circleRight += p.w + Math.max(8, p.w * 0.25);
    const below = cardTop + cardHeight + margin * 0.45;
    const above = cardTop - margin * 0.45 - p.h;
    if (below + p.h <= canvas.height - margin) p.y = below;
    else if (above >= margin) p.y = above;
    else step.omitDecoration = true;
  }
  // No free band exists in a dense landscape card: omit optional ornaments instead of overlap.
  for (let i = ops.length - 1; i >= 0; i -= 1) if (ops[i].omitDecoration) ops.splice(i, 1);

  if (layout.card.enabled) {
    ops.push({
      op: 'draw.rect',
      note: 'content card: proportions taken from the selected styleguide, height fitted to the copy',
      params: {
        layer: 'shapes',
        x: margin,
        y: cardTop,
        w: cardWidth,
        h: cardHeight,
        radius: layout.card.radius,
        fill: roles.darkTone
          ? `rgba(9,14,22,${layout.card.overlay})`
          : `rgba(255,255,255,${layout.card.overlay})`,
        stroke: layout.card.stroke,
        strokeWidth: 2,
        shadow: { color: 'rgba(0,0,0,0.35)', blur: 40, offsetY: 18 },
      },
    });
  }

  if (content.headline) {
    ops.push({
      op: 'draw.text',
      note: 'headline (Arabic shaping + RTL, right aligned)',
      animates: { property: 'opacity', from: 0, to: 1 },
      params: {
        layer: 'text',
        x: anchorX,
        y: headlineY,
        text: content.headline,
        font: typography.headline,
        align: 'right',
        maxWidth: headlineMaxWidth,
        fill: roles.text,
        shadow: { color: 'rgba(0,0,0,0.35)', blur: 18, offsetY: 6 },
      },
    });
  }

  if (content.body) {
    ops.push({
      op: 'draw.text',
      note: 'body copy with automatic wrapping',
      params: {
        layer: 'text',
        x: anchorX,
        y: bodyY,
        text: content.body,
        font: typography.body,
        align: 'right',
        maxWidth: bodyMaxWidth,
        fill: toRgba(roles.text, 0.82),
      },
    });
  }

  if (content.kicker) {
    ops.push({
      op: 'draw.text',
      note: 'eyebrow / kicker with readable contrast against both background tones',
      params: {
        layer: 'text',
        x: anchorX,
        y: kickerY,
        text: content.kicker,
        font: typography.kicker,
        align: 'right',
        maxWidth: fitted.widths.kicker,
        fill: Math.min(contrast(roles.accent, roles.background), contrast(roles.accent, roles.backgroundAlt)) >= 4.5 ? roles.accent : roles.text,
      },
    });
  }

  ops.push({
    op: 'draw.line',
    note: 'accent rule (shape language from the styleguide)',
    params: {
      layer: 'shapes',
      x1: anchorX,
      y1: lineY,
      x2: anchorX - Math.min(fitted.widths.kicker, Math.round(canvas.width * layout.accentLine.widthRatio)),
      y2: lineY,
      stroke: roles.accent,
      strokeWidth: layout.accentLine.thickness,
      arrow: layout.accentLine.arrow ? 'end' : 'none',
      dash: [12, 8],
    },
  });

  // اسم المستند مشتق من الطلب الحالي، لا من مستندات سابقة.
  const docName = deriveDocumentName(input, content);
  for (const op of ops) {
    if (op.createsDocument && op.params && !op.params.name) op.params.name = docName;
  }
  if (context.evidence && context.evidence.on('limited-palette')) {
    context.evidence.record('limited-palette', `Background, accent and text colours come from the selected reference palette (${roles.colors.slice(0, 4).join(', ')}).`, [0, 4], 'palette');
  }
  return planEnvelope(context);
}

function planEnvelope(context) {
  const {
    input, prompt, skill, matches, canvas, paletteEntries, designSystem, designSystemReasons, roles, content,
    typography, ops, library, knowledgeSelection, intent, evidence, composition, direction,
  } = context;

  // ربط صارم بين الطلب والخطة: يرفض التنفيذ أي خطة قديمة أو غير مطابقة.
  const requestId = `req_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`;
  const requestIntent = {
    prompt,
    width: canvas.width,
    height: canvas.height,
    headline: content.headline,
    body: content.body,
    kicker: content.kicker,
    skillId: skill.id,
    designType: intent ? intent.type : null,
    sceneSpec: input.sceneSpec ? crypto.createHash('sha256').update(JSON.stringify(input.sceneSpec)).digest('hex') : null,
    data: input.table || input.blocks ? crypto.createHash('sha256').update(JSON.stringify([input.table || null, input.blocks || null])).digest('hex').slice(0, 16) : null,
    useReferences: input.useReferences !== false,
  };
  const requestHash = crypto.createHash('sha256').update(JSON.stringify(requestIntent)).digest('hex').slice(0, 24);
  const planTtlMs = Math.max(1, Number(process.env.ARTFORGE_PLAN_TTL_MINUTES || 120)) * 60 * 1000;

  return {
    planId: `plan_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    requestId,
    requestHash,
    requestContract: requestContract(prompt, input),
    traceId: traceContext.getStore()?.traceId || null,
    intent: requestIntent,
    design: intent ? {
      type: intent.type,
      label: intent.label,
      confidence: intent.confidence,
      reason: intent.reason,
      lighting: intent.lighting,
      style: intent.style,
      pose: intent.pose,
      elements: intent.elements.map((e) => e.id),
      canvasSource: input.width && input.height ? 'input' : (intent.explicitCanvas ? intent.explicitCanvas.source : 'default'),
      composed: Boolean(composition),
      composition: composition ? composition.meta : null,
      coverage: composition ? composition.coverage : [],
      missing: composition ? composition.missing : [],
      limits: (composition ? composition.limits : []).concat(engineLimits(intent)),
      notices: context.notices || [],
    } : null,
    evidence: evidence ? evidence.summary() : null,
    direction: direction || null,
    planningMs: Math.round((performance.now() - input._planningStarted) * 100) / 100,
    status: 'planned',
    expiresAt: new Date(Date.now() + planTtlMs).toISOString(),
    createdAt: new Date().toISOString(),
    prompt,
    skill: {
      id: skill.id,
      name: skill.name,
      nameEn: skill.nameEn,
      bestFor: skill.bestFor,
      matchedKeywords: matches[0].skill.id === skill.id ? matches[0].hits : [],
      alternatives: matches.slice(1, 3).map((entry) => ({ id: entry.skill.id, score: entry.score })),
    },
    canvas,
    exportFormat: String(input.format || 'png').toLowerCase().replace('jpg', 'jpeg'),
    phases: PHASE_TEMPLATE.map((phase) => Object.assign({}, phase, { status: 'pending' })),
    references: {
      enabled: input.useReferences !== false,
      palettes: paletteEntries.map((entry) => ({
        id: entry.palette.id,
        file: entry.palette.file,
        path: entry.palette.path,
        sha256: entry.palette.sha256,
        colors: entry.palette.colors.map((color) => color.hex),
        tone: entry.palette.tone,
        score: entry.score,
        reasons: entry.reasons,
        mood: entry.mood,
        derivedLayer: entry.derivedLayer || null,
      })),
      designSystem: {
        id: designSystem.id,
        file: designSystem.file,
        path: designSystem.path,
        sha256: designSystem.sha256,
        tone: designSystem.tone,
        aspect: designSystem.aspect,
        edgeDensity: designSystem.edgeDensity,
        reasons: designSystemReasons,
      },
      rules: {
        palettesUsed: paletteEntries.length,
        palettesMax: 3,
        designSystemsUsed: 1,
        contentIsolation: 'No text or dummy content from the references is reused.',
      },
      books: library.list('book').map((book) => ({ id: book.id, file: book.file, path: book.path })),
      instructions: library.list('instruction'),
      knowledge: knowledgeSelection,
    },
    colors: roles,
    typography,
    content,
    ops,
    operationNames: Array.from(new Set(ops.map((entry) => entry.op))),
  };
}

module.exports.buildPlan = buildPlan;


/** Honest statement of what the drawing engine can and cannot produce for each design type. */
function engineLimits(intent) {
  const limits = [];
  if (['scene', 'character', 'landscape', 'architecture'].includes(intent.type)) {
    limits.push('Output is a vector-style illustration built from shapes, gradients, blur and procedural brush strokes (Skia 2D). It is not a photograph and not a generative-model painting.');
  }
  if (intent.type === 'character' || (intent.type === 'scene' && intent.elements.some((e) => e.id === 'person'))) {
    limits.push('Figures are stylised (7.5-head convention, simple shapes). Detailed anatomy, faces and hands are beyond the current engine.');
  }
  if (intent.style === 'painterly') {
    limits.push('Painterly look comes from brush stamps, soft edges and blend modes; it does not simulate real oil/watercolour pigment or apply learned style transfer.');
  }
  return limits;
}
