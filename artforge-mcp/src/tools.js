'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { boundedPreview } = require('./engine/preview');

/** Registered agent operating guides shipped in artforge-mcp/skills. */
const { REGISTRY, SKILL_GUIDES, SKILLS_DIR } = require('./engine/skill-registry');
const INLINE_BRIEFS = new Set(REGISTRY.filter(skill => skill.inlineBrief).map(skill => skill.id));
const { routeSkills } = require('./engine/skill-router');
const { understandRequest } = require('./engine/understanding');

/** UI resource that renders the preview image inside ChatGPT (MCP Apps / Apps SDK). */
const WIDGET_URI = 'ui://widget/artforge-preview-v1.html';
const WIDGET_TOOL_META = {
  ui: { resourceUri: WIDGET_URI },
  'openai/outputTemplate': WIDGET_URI,
  'openai/toolInvocation/invoking': 'Drawing the design…',
  'openai/toolInvocation/invoked': 'Design ready',
};

const PLAN_PROPERTIES = {
  sceneSpec: {
    type: 'object',
    description: 'Model-authored geometry. Read guide=model-drawing and exact operation docs. Coordinates are canvas pixels; colour tokens bind selected reference roles: $color.accent/background/backgroundAlt/secondary/text. No file/network operations.',
    required: ['version', 'elements', 'layers', 'operations'],
    properties: {
      version: { type: 'integer', enum: [1] },
      elements: { type: 'array', minItems: 1, maxItems: 80, items: { type: 'object', required: ['id', 'description'], properties: { id: { type: 'string' }, description: { type: 'string', maxLength: 500 } }, additionalProperties: false } },
      layers: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'object', required: ['id'], properties: { id: { type: 'string' }, name: { type: 'string' } }, additionalProperties: false } },
      operations: { type: 'array', minItems: 1, maxItems: 1200, items: { type: 'object', required: ['op', 'layer', 'element', 'params'], properties: { op: { type: 'string', enum: Array.from(require('./engine/scene-spec').DRAW_OPS) }, layer: { type: 'string' }, element: { type: 'string' }, params: { type: 'object' }, note: { type: 'string' } }, additionalProperties: false } },
      referenceApplications: { type: 'array', maxItems: 20, items: { type: 'object', required: ['sourceId', 'decision', 'operationIndexes'], properties: { sourceId: { type: 'string' }, decision: { type: 'string' }, operationIndexes: { type: 'array', minItems: 1, items: { type: 'integer', minimum: 0 } } }, additionalProperties: false } },
    },
    additionalProperties: false,
  },
  prompt: { type: 'string', description: 'The user request (Arabic or English).' },
  headline: { type: 'string', description: 'Exact headline text (drawn verbatim, max 300 chars); omit to derive it from the prompt.' },
  body: { type: 'string', description: 'Exact body text (drawn verbatim, max 2000 chars).' },
  kicker: { type: 'string', description: 'Exact eyebrow/kicker text (drawn verbatim, max 200 chars).' },
  name: { type: 'string', description: 'Document name.' },
  width: { type: 'number', description: 'Canvas width in px (defaults to the skill canvas).' },
  height: { type: 'number', description: 'Canvas height in px.' },
  skillId: { type: 'string', description: 'TEXT layout template only (poster, social-square, story, banner, card, cover, invitation). Do not pass it for drawings: it is ignored for people, scenes, landscapes, buildings, tables and ruled pages.' },
  palettes: { type: 'number', description: 'How many reference palettes to use: 1-3 (default 1: one coherent colour layer chosen by the request’s mood and subject).' },
  designSystemId: { type: 'string', description: 'Force one styleguide id.' },
  books: {
    type: 'array',
    items: { type: 'string' },
    description: 'Force specific knowledge book ids (see artforge_book_knowledge) instead of automatic selection.',
  },
  knowledgeBooks: { type: 'number', description: 'How many books to consult: 1-3 (default 2).' },
  knowledgeConcepts: { type: 'number', description: 'How many page-bound concepts to return: 1-12 (default 5).' },
  format: { type: 'string', enum: ['png', 'jpeg', 'webp'], description: 'Export format for phase ⑤.' },
  headlineFont: { type: 'string', description: 'Headline font family (default Amiri, bundled).' },
  bodyFont: { type: 'string', description: 'Body font family (default Tajawal, bundled).' },
  designType: {
    type: 'string',
    enum: ['text', 'poster', 'table', 'ruled', 'scene', 'character', 'landscape', 'architecture', 'abstract', 'card', 'reference'],
    description: 'Force the design type. Omit to let ArtForge detect it from the prompt (a room/landscape/building request is DRAWN, not turned into a text card).',
  },
  elements: { type: 'array', items: { type: 'string' }, description: 'Visual elements that must appear (e.g. ["bookshelf","tv","person"]). Merged with elements detected in the prompt; any element ArtForge cannot draw is reported, never faked.' },
  lighting: { type: 'string', enum: ['morning', 'night', 'sunset', 'overcast'], description: 'Scene lighting (scenes, landscapes, architecture).' },
  abstractStyle: { type: 'string', enum: ['geometric', 'clay', 'fluid', 'splash', 'ornamental'], description: 'Abstract art style (designType abstract): geometric = Bauhaus discs/arcs/lines, clay = soft 3D tiles/pills/spheres, fluid = silk ribbons and smoke, splash = glossy paint splashes, ornamental = decorative bloom/phoenix built on an eye path with varied curves (guide ornamental-composition). Detected from the prompt when omitted.' },
  ornamentSubject: { type: 'string', enum: ['bloom', 'phoenix'], description: 'Ornamental subject: bloom (flower of plumes over waves) or phoenix. Detected from the prompt when omitted.' },
  ornamentPass: { type: 'string', enum: ['value', 'color'], description: 'Ornamental pass: value = one-hue value study to judge movement, curve variety and interlace before colour; color (default) = same geometry in colour. Reuse the same prompt and seed for both passes.' },
  style: { type: 'string', enum: ['illustration', 'painterly', 'flat', 'sketch'], description: 'Rendering style; painterly uses brush strokes and soft blending.' },
  table: {
    type: 'object',
    description: 'Structured table: {columns:[{title, format:text|number|currency|percent|date, align, decimals, currency}], rows:[[...] | {kind:data|subtotal|total|section, cells:[value | {text, colspan}]}], theme?, digits?: "latin"|"arabic-indic"}. Laid out automatically (auto widths, zebra rows, totals, RTL, pagination with repeated header).',
  },
  blocks: {
    type: 'array',
    items: { type: 'object' },
    description: 'Long structured text for ruled/educational pages: [{type:"heading", level:1-3, text, colon?}, {type:"paragraph", text}, {type:"list", ordered, items:[...]}, {type:"table", columns, rows}]. Alternative: put the text in body using "# " headings, "1-" numbered and "-" bullet lines.',
  },
  ruled: { anyOf: [{ type: 'boolean' }, { type: 'object' }], description: 'true, or {fontSize, spacing, lineColor, marginColor, margin:false} for writing on ruled paper (baselines snapped to the rules, pixel-verified).' },
  referenceImage: { type: 'string', description: 'Absolute path to a user-provided image to build the design on (colours and calm region are analysed from its pixels).' },
  useReferences: { type: 'boolean', description: 'Default true. false disables the reference palettes and the book rules (used for A/B comparison).' },
  seed: { type: 'number', description: 'Random seed for reproducible procedural details (books, stars, brush grain).' },
  engine: { type: 'string', enum: ['auto', 'composer', 'hybrid', 'scene-graph'], description: 'auto (default): pictures with spatial relations, several instances, or elements the composer cannot draw are placed by the scene graph while keeping the composer rendering (hybrid; pure scene-graph when the merge cannot guarantee the request); simple requests keep the composer. composer / hybrid / scene-graph force one engine. Read guide=scene-graph.' },
  artDirection: {
    type: 'object',
    description: 'Override art-direction decisions (guide=art-direction).',
    properties: {
      composition: { type: 'string', enum: ['thirds', 'center', 'symmetric'] },
      focal: { type: 'string', description: 'Element id of the focal subject.' },
      lightFrom: { type: 'string', enum: ['left', 'right', 'top'] },
      anatomy: {type:'string',enum:['legacy','rig-v1'],description:'Opt into articulated FK/IK anatomy; legacy remains default for compatibility.'},
      cameraYaw:{type:'number',minimum:-3.141593,maximum:3.141593},
      cameraFocal:{type:'number',minimum:1,maximum:20000},
      world:{type:'boolean'},
      materials:{type:'boolean'},
      lighting:{type:'boolean'},
      cameraHeight: {type:'number',minimum:0.1,maximum:100},
      cameraPitch: {type:'number',minimum:-1.3,maximum:1.3},
      perspective: { type: 'string', enum: ['flat', 'one-point', 'two-point', 'three-point', 'aerial', 'top-down'] },
      shadows: { type: 'string', enum: ['hard', 'soft', 'none'] },
      temperature: { type: 'string', enum: ['warm', 'cool', 'neutral'] },
    },
    additionalProperties: false,
  },
  viewpoint: { type: 'string', enum: ['eye', 'top', 'low', 'closeup', 'wide'], description: 'Camera viewpoint (detected from the prompt when omitted).' },
  review: { type: 'object', description: 'Visual review for engine scene-graph: {correct: false} to report only, maxRounds 0-3 (default 2).', properties: { correct: { type: 'boolean' }, maxRounds: { type: 'number' } }, additionalProperties: false },
};

/** Compact view of the planning direction (understanding → skills → graph → art → spec). */
function directionSummary(d) {
  if (!d) return undefined;
  const u = d.understanding;
  return {
    engine: d.engine,
    autoSelect: d.autoSelect,
    sources: d.hybrid ? d.hybrid.sources : undefined,
    removed: d.hybrid && d.hybrid.removed.length ? d.hybrid.removed : undefined,
    hybridRejected: d.hybridRejected,
    understanding: { entities: u.entities.map((e) => `${e.id}×${e.count}${e.attributes.color ? ` ${e.attributes.color}` : ''}${e.attributes.size ? ` ${e.attributes.size}` : ''}`), relations: u.relations.map((r) => `${r.subject} ${r.relation} ${r.object}${r.object2 ? ` & ${r.object2}` : ''}`), excluded: u.constraints.excluded, viewpoint: u.constraints.viewpoint, moods: u.constraints.moods, ambiguities: u.ambiguities },
    skills: d.skills.skills.map((s) => s.id),
    references: d.references.rules.map((r) => `${r.id}=${typeof r.value === 'object' ? JSON.stringify(r.value) : r.value}`).slice(0, 6),
    graph: d.graph ? { relations: d.graph.check.relations.map((r) => `${r.subject} ${r.relation} ${r.object}: ${r.holds ? 'holds' : 'NOT satisfied'}`), issues: d.graph.check.issues.map((i) => i.code + (i.node ? ` ${i.node}` : '')).slice(0, 6) } : undefined,
    art: d.art ? require('./engine/art-direction').summarizeArt(d.art) : undefined,
    spec: d.spec ? { complete: d.spec.check.complete, operations: d.spec.check.operations, issues: d.spec.check.issues.map((i) => i.code) } : undefined,
  };
}

function reviewSummary(review) {
  if (!review) return undefined;
  return { mode: review.mode, ok: review.ok, improved: review.improved, rounds: (review.rounds || []).map((r) => ({ round: r.round, metrics: r.metrics, issues: r.issues.map((i) => i.code + (i.node ? ` ${i.node}` : '') + (i.relation ? ` ${i.relation}` : '')), corrections: r.corrections.map((c) => (c.raisedTo ? `${c.element} raised to ${c.raisedTo}` : (c.lightened ? `${c.element} lightened ${c.lightened}` : (c.darkened ? `${c.element} darkened ${c.darkened}` : `${c.element} dx${c.dx} dy${c.dy}`)))), reverted: r.reverted })), scope: review.scope, error: review.error };
}

function planSummary(plan) {
  return {
    success: true,
    planId: plan.planId,
    requestId: plan.requestId,
    requestHash: plan.requestHash,
    status: 'planned',
    width: plan.canvas.width,
    height: plan.canvas.height,
    content: plan.content,
    design: plan.design ? {
      type: plan.design.type, label: plan.design.label, confidence: plan.design.confidence, reason: plan.design.reason,
      lighting: plan.design.lighting, style: plan.design.style, elements: plan.design.elements,
      coverage: plan.design.coverage, missing: plan.design.missing, limits: plan.design.limits, canvasSource: plan.design.canvasSource, notices: plan.design.notices || [],
    } : null,
    planningMs: plan.planningMs,
    direction: directionSummary(plan.direction),
    referenceContext: plan.design && plan.design.composed ? { concepts: ((plan.references.knowledge || {}).concepts || []).slice(0, 2).map((c) => ({ id:c.id, bookId:c.bookId, page:c.page, title:c.title, quote:String(c.quote || '').slice(0, 100) })), referenceApplications: plan.design.composition ? plan.design.composition.referenceApplications || [] : [] } : undefined,
    nextAction: plan.design && plan.design.composed ? 'Inspect the PNG; Edits: send ALL changes in ONE artforge_tool_op call with op:"batch", params:{documentId, ops:[{op, params}, ...]}; the reply carries the updated preview. One edit per call costs ~4 s each through ChatGPT.' : undefined,
    knowledgeRulesApplied: plan.evidence ? plan.evidence.appliedCount : 0,
    skill: { id: plan.skill.id, name: plan.skill.name },
    palettes: plan.references.palettes.map((palette) => ({ id: palette.id, colors: palette.colors.slice(0, 5) })),
    designSystem: plan.references.designSystem ? plan.references.designSystem.id : null,
    colors: plan.colors,
    typography: plan.typography,
    operations: plan.ops.length,
    expiresAt: plan.expiresAt,
  };
}

/**
 * Compact run result. The model gets the facts and the PNG as an image block;
 * the data URL travels only in _meta (hidden from the model) for the chat widget.
 */
function runResult(plan, run) {
  const data = {
    success: run.ok,
    executionOk: run.executionOk === undefined ? run.ok : run.executionOk,
    acceptance: run.acceptance,
    bridgeMetrics: run.bridgeMetrics,
    planId: plan.planId,
    requestId: plan.requestId,
    documentId: run.documentId,
    runId: run.runId,
    canvas: run.canvas,
    content: run.content,
    design: run.design ? { type: run.design.type, label: run.design.label, elements: run.design.elements, missing: run.design.missing, limits: run.design.limits, notices: run.design.notices || [] } : null,
    verification: run.verification,
    review: reviewSummary(run.review),
    direction: directionSummary(plan.direction),
    saved: run.saved,
    exported: run.exported,
    pages: run.pages && run.pages.length > 1 ? run.pages.map((p) => ({ page: p.page, documentId: p.documentId, path: p.exported.path, width: p.exported.width, height: p.exported.height, bytes: p.exported.bytes, sha256: p.exported.sha256 })) : undefined,
    evidence: run.evidence ? {
      enabled: run.evidence.enabled,
      appliedCount: run.evidence.appliedCount,
      directedCount: run.evidence.directedCount,
      decisionCount: run.evidence.decisionCount,
      countsMeaning: 'appliedCount = book decisions bound to drawing ops (traceable); directedCount = decisions recorded without ops',
      applied: run.evidence.applied.map((e) => ({
        rule: e.rule, book: e.book, page: e.page, decision: e.decision, ops: e.ops.length, traceable: e.traceable,
        ...(e.visualEvidence ? { visualSource: {
          bookId: e.visualEvidence.bookId, page: e.visualEvidence.locator.page,
          sourceSha256: e.visualEvidence.sourceSha256,
          inspectedRasterSha256: e.visualEvidence.inspectedRaster.sha256,
          verification: 'original-bytes-verified',
          locator: e.visualEvidence.locator,
          observation: e.visualEvidence.observation,
          reviewMethod: e.visualEvidence.reviewMethod,
          operationIndices: e.ops.slice(0, 32), operationIndicesTruncated: e.ops.length > 32,
        } } : {}),
      })),
    } : null,
    phaseMs: run.phaseMs,
    delivery: {
      fileOnDisk: Boolean(run.exported && run.exported.path),
      imageInResponse: Boolean(run.preview && run.preview.dataUrl),
      code: run.preview && run.preview.reason === 'PREVIEW_SIZE_LIMIT' ? 'PREVIEW_SIZE_LIMIT' : undefined,
      note: 'The PNG preview is returned as MCP image content (rendered from the same document as the exported file). Whether a client displays it is decided by the client; the exported file path is a local path on the server machine.',
    },
    preview: run.preview && run.preview.dataUrl
      ? { bytes: run.preview.bytes, width: run.preview.width, sha256: run.preview.sha256, revision: run.preview.revision, attempts: run.preview.attempts, fitsLimit: run.preview.fitsLimit }
      : { ...run.preview, skipped: true, reason: run.preview ? run.preview.reason : 'no preview' },
    layoutQA: run.layoutQA ? {
      ok: run.layoutQA.ok,
      applicable: run.layoutQA.applicable,
      scope: run.layoutQA.scope,
      margins: run.layoutQA.margins,
      rtl: run.layoutQA.rtl,
      overlap: run.layoutQA.overlap ? { textPairs: run.layoutQA.overlap.textPairs, maxRatio: run.layoutQA.overlap.maxRatio } : null,
      clipping: run.layoutQA.clipping,
      whitespace: run.layoutQA.whitespace,
      issues: run.layoutQA.issues,
      visualReview: run.layoutQA.visualReview || 'not-reviewed',
      error: run.layoutQA.error,
    } : null,
    operations: run.executed.length,
    warnings: run.warnings,
    elapsedMs: Date.parse(run.finishedAt) - Date.parse(run.startedAt),
  };
  const hasImage = Boolean(run.preview && run.preview.dataUrl);
  // A preview widget needs the data URL, but it duplicates the image block byte-for-byte:
  // the poster above is 375 KB of which 184 KB is the same PNG sent twice.
  // Clients that render image blocks can set ARTFORGE_PREVIEW_DATA_URL=off and halve the response.
  const wantDataUrl = process.env.ARTFORGE_PREVIEW_DATA_URL !== 'off';
  const result = { data };
  if (hasImage) {
    result.images = [{ mimeType: 'image/png', data: run.preview.dataUrl.replace(/^data:image\/png;base64,/, '') }];
    result.meta = {
      artforge: wantDataUrl
        ? { previewDataUrl: run.preview.dataUrl, documentId: run.documentId, exported: run.exported }
        : { documentId: run.documentId, exported: run.exported, previewDataUrlOmitted: 'ARTFORGE_PREVIEW_DATA_URL=off', bytes: run.preview.bytes },
    };
  } else {
    result.meta = { artforge: { documentId: run.documentId, exported: run.exported } };
  }
  return result;
}

/**
 * Many edits in one MCP call: the drawing tool's batch op (one HTTP request), documentId filled into every op,
 * a compact per-op result, then one bounded preview of the edited document. Replaces dozens of single-op calls
 * that each cost a full ChatGPT + tunnel round trip (~4 s) while the server work is ~10 ms.
 */
async function runBatch(engine, params, list) {
  const documentId = params.documentId;
  const ops = list.slice(0, 2000).map((item) => {
    const p = Object.assign({}, (item && item.params) || {});
    if (documentId && !p.documentId && item && item.op !== 'document.create') p.documentId = documentId;
    return { op: item && item.op, params: p };
  });
  const started = performance.now();
  // atomic / expectedRevisions pass through unchanged: the drawing tool owns their semantics.
  const call = { ops };
  if (params.atomic !== undefined) call.atomic = params.atomic;
  if (params.expectedRevisions !== undefined) call.expectedRevisions = params.expectedRevisions;
  const result = await engine.bridge.call('batch', call);
  const results = ((result.data && result.data.results) || []).map((r, i) => {
    const d = (r && r.data) || r || {};
    return { i, op: ops[i].op, documentId: ops[i].op === 'document.create' ? d.documentId : undefined, objectId: d.objectId, layerId: d.layerId, objectIds: Array.isArray(d.objectIds) ? d.objectIds.length : undefined };
  });
  const data = { op: 'batch', success: true, atomic: Boolean(result.data && result.data.atomic), count: results.length, documentId, durationMs: Math.round(performance.now() - started), results };
  const doc = documentId || (results.find((r) => r.op === 'document.create') || {}).documentId;
  if (params.preview === false || !doc) return { data };
  const preview = await boundedPreview(engine.bridge, doc, params.previewWidth || 720);
  if (preview.skipped) { data.preview = { skipped: true, reason: preview.reason }; return { data }; }
  data.preview = { width: preview.width, bytes: preview.bytes, sha256: preview.sha256 };
  return {
    data,
    images: [{ mimeType: 'image/png', data: preview.base64 }],
    meta: { artforge: process.env.ARTFORGE_PREVIEW_DATA_URL !== 'off' ? { previewDataUrl: `data:image/png;base64,${preview.base64}`, documentId: doc } : { documentId: doc } },
  };
}

/**
 * MCP tool catalogue. Each tool maps to a capability of the three components;
 * design tools never bypass the routing engine.
 */
function buildTools(engine) {
  const tools = [];

  tools.push({
    name: 'artforge_capabilities',
    title: 'ArtForge AI MCP capabilities',
    description:
      'Report the three components (routing engine, references, drawing tool), the design skills, reference index counts, '
      + 'whether the drawing tool HTTP API is reachable and the available low-level operations. Call this first.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async () => {
      const health = await engine.bridge.health();
      const summary = engine.library.summary();
      const docs = engine.docs.summary();
      let toolCapabilities = null;
      if (health.ok) {
        try {
          const caps = await engine.bridge.capabilities();
          toolCapabilities = {
            version: caps.version,
            engine: caps.engine,
            limits: caps.limits,
            fonts: { total: caps.fonts.total, arabicFamilies: caps.fonts.arabicFamilies, bundledArabic: caps.fonts.bundledArabic },
            operations: caps.operations.length,
          };
        } catch (error) {
          toolCapabilities = { error: error.message };
        }
      }
      return {
        data: {
          name: 'ArtForge AI MCP',
          version: require('./engine/build-info').version,
          generativeImages: engine.generativeImages ? engine.generativeImages.status() : { enabled: false },
          generationJobs: engine.generationJobs ? engine.generationJobs.status() : { enabled: false },
          // Which copy/build answers this call (lets a client confirm it reaches the intended deployment).
          build: {
            sourceSha256: require('./engine/build-info').sourceSha256,
            label: process.env.ARTFORGE_BUILD_LABEL || 'photoshop-p1-p8-20261108',
            codeRoot: path.resolve(__dirname, '..', '..'),
            designTypes: ['text', 'poster', 'table', 'ruled', 'scene', 'character', 'landscape', 'architecture', 'abstract', 'card', 'reference'],
            abstractStyles: ['geometric', 'clay', 'fluid', 'splash', 'ornamental'],
            agentGuides: Object.keys(SKILL_GUIDES),
            features: engine.featureStatus(),
            modelDrawing: { sceneSpecVersion: 1, cachedSchemaTransport: { tool: 'artforge_tool_op', op: 'design.plan', params: 'same inputs as artforge_plan_design, including sceneSpec', guideQuery: 'artforge_tool_docs query=model-drawing' }, guide: 'model-drawing', primitiveOperations: Array.from(require('./engine/scene-spec').DRAW_OPS), limits: { elements: 80, layers: 20, operations: 1200 }, colourBindings: ['$color.background', '$color.backgroundAlt', '$color.accent', '$color.secondary', '$color.text'], visualAcceptance: 'requires preview inspection by a vision-capable caller' },
          },
          sequence: [
            '① محرك الفهرسة والمهارات والتوجيه',
            '② مراجع التصميم',
            '③ شرح الأداة',
            '④ أداة الرسم',
            '⑤ إظهار التصميم وحفظه',
          ],
          components: {
            routing: { skills: engine.skills.length, templateCount: engine.skills.length, guideCount: Object.keys(SKILL_GUIDES).length, guideRegistry: require('./engine/skill-registry').REGISTRY.map(({id,group,phase,requires,conflicts}) => ({id,group,phase,requires:requires || [],conflicts:conflicts || []})), toolDocsSections: docs.sections, documentedOperations: docs.operations },
            references: summary,
            knowledge: engine.knowledge && engine.knowledge.isAvailable()
              ? {
                available: true,
                books: engine.knowledge.listBooks().length,
                concepts: engine.knowledge.summary().counts.concepts,
                categories: Object.keys(engine.knowledge.summary().categories).length,
                coverage: engine.knowledge.summary().coverage,
              }
              : { available: false, hint: 'cd book-index && node bin/book-index.js build' },
            drawingTool: { url: engine.bridge.baseUrl, reachable: health.ok, health, capabilities: toolCapabilities },
          },
          skills: engine.skills,
        },
      };
    },
  });

  tools.push({
    name: 'artforge_plan_design',
    title: 'Plan a design (phases ① ② ③)',
    description:
      'Analyse a design request, pick the design skill, resolve which reference palettes (1-3) and which single styleguide apply, '
      + 'extract their real colours, choose Arabic typography and return an ordered operation plan with phases ①→⑤. '
      + 'Only needed to inspect a plan before drawing; for a new design prefer artforge_create_design (one call). '
      + 'Supply text explicitly to control the copy. For model-authored scenes pass sceneSpec; read guide=model-drawing first.',
    inputSchema: {
      type: 'object',
      properties: Object.assign({}, PLAN_PROPERTIES),
      required: ['prompt'],
      additionalProperties: false,
    },
    handler: async (args) => {
      const plan = await engine.planAsync(args);
      const file = engine.pipeline.savePlan(plan);
      // ملخص مضغوط (~2KB بدل ~21KB): planId في المقدمة، والخطة الكاملة محفوظة على القرص.
      return {
        data: Object.assign(planSummary(plan), {
          planPath: file,
          next: `Call artforge_execute_design with planId=${plan.planId} and requestId=${plan.requestId}.`,
        }),
      };
    },
  });

  tools.push({
    name: 'artforge_create_design',
    title: 'Create a design in one call (plan + draw + save + export)',
    description:
      'ONE call is enough for any new picture or design: put the user’s own words in prompt (do not shorten or rephrase them), plus exact texts, width/height and data. '
      + 'Do not search books or references first and do not pass skillId for drawings: book rules, palettes and appearance (clothes colours, hair, smile, setting) are applied automatically and reported in evidence. '
      + 'Runs every phase: intent analysis (text, poster, card, table, ruled page, interior scene, '
      + 'character, landscape, architecture, abstract art: geometric/clay/fluid/splash, reference image), ONE reference colour palette chosen automatically by the request mood and subject (adherence measured on the pixels), book rules, drawing, save, export, pixel QA and verification '
      + '(canvas size, every text verbatim, flowed words, table rows, requested elements). Returns planId, documentId, the exported file(s) '
      + 'and a preview image. Pass the exact texts, exact width/height, and structured data (table / blocks) instead of drawing cells or lines by hand. '
      + 'For custom compositions (infographics, UI cards, diagrams, posters with your own layout) pass the WHOLE layout as sceneSpec in this one call (up to 1200 operations, guide=model-drawing) instead of drawing shape by shape. '
      + 'Execution and structural checks are reported separately from visual review. Edits: send ALL changes in ONE artforge_tool_op call with op:"batch", params:{documentId, ops:[{op, params}, ...]}; the reply carries the updated preview. One edit per call costs ~4 s each through ChatGPT.',
    inputSchema: {
      type: 'object',
      properties: Object.assign({}, PLAN_PROPERTIES, {
        previewWidth: { type: 'number', description: 'Preview width in px (default 720).' },
        preview: { type: 'boolean', description: 'Set false to skip the PNG preview: no image block and no data URL, the smallest and fastest response.' },
      }),
      required: ['prompt'],
      additionalProperties: false,
    },
    _meta: WIDGET_TOOL_META,
    handler: async (args) => {
      const planArgs = Object.assign({}, args);
      delete planArgs.previewWidth;
      delete planArgs.preview;
      const plan = await engine.planAsync(planArgs);
      engine.pipeline.savePlan(plan);
      const run = await engine.pipeline.execute(plan, { previewWidth: args.previewWidth, preview: args.preview !== false });
      return runResult(plan, run);
    },
  });

  tools.push({
    name: 'artforge_get_reference',
    title: 'Read design references',
    description:
      'List or read the indexed references: palettes (extracted colours), styleguides (tone/aspect metrics), theory books (paths) and the '
      + 'mandatory instruction rules. Originals are preserved and never modified; no reference content is copied into designs.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['palette', 'design-system', 'book', 'instruction'], description: 'Reference collection.' },
        id: { type: 'string', description: 'Exact reference id; omit to list the collection.' },
        limit: { type: 'number', description: 'Max rows when listing (default 20).' },
      },
      required: ['kind'],
      additionalProperties: false,
    },
    handler: async (args) => {
      const { kind } = args;
      // The PDF registry and the knowledge index name the same book differently
      // (book-ColorandLightJamesGurneyEnglish vs book-color-and-light); link them by the file's SHA-256 so a
      // book record leads straight to artforge_book_knowledge {bookId}.
      const knowledgeIdOf = (entry) => {
        if (kind !== 'book' || !entry || !entry.sha256) return undefined;
        try { const b = engine.knowledge.listBooks().find((x) => x.sha256 === entry.sha256); return b ? b.id : null; } catch { return null; }
      };
      const linked = (entry) => (kind === 'book' ? Object.assign({}, entry, { knowledgeBookId: knowledgeIdOf(entry) }) : entry);
      if (args.id) {
        const entry = engine.library.get(kind, args.id);
        if (!entry) throw new Error(`reference not found: ${kind}/${args.id}`);
        const payload = linked(entry);
        if (payload.text && payload.text.length > 4000) payload.text = `${payload.text.slice(0, 4000)}…`;
        return { data: { kind, reference: payload } };
      }
      const list = engine.library.list(kind);
      const rows = Array.isArray(list) ? list.slice(0, args.limit || 20).map(linked) : list;
      return { data: { kind, count: Array.isArray(list) ? list.length : undefined, rows } };
    },
  });

  tools.push({
    name: 'artforge_tool_docs',
    title: 'Read the drawing tool documentation',
    description:
      'Search the tool documentation (docs/) for how to call drawing operations: parameters, outputs, saving/exporting, limits and errors. '
      + 'Pass guide to read the binding agent skills (start with guide="operating-procedure"; guide="list" lists them). '
      + 'Pass route with the user request to get only the skills that task needs, ordered, within a context budget.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Keywords, e.g. "draw.text arabic wrap" or "export image".' },
        sectionId: { type: 'string', description: 'Exact section id returned by a previous search.' },
        operations: { type: 'array', items: { type: 'string' }, description: 'Operation names to fetch exact signatures for.' },
        limit: { type: 'number', description: 'Max sections (default 5).' },
        guide: { type: 'string', enum: ['list'].concat(Object.keys(SKILL_GUIDES)), description: 'Read a registered ArtForge guide. Use list for the current catalogue.' },
        route: { type: 'string', description: 'The user request: returns ordered guides and the selected layout/colour guidance without planning.' },
        budgetTokens: { type: 'number', description: 'Context budget for route (default 9000).' },
      },
      additionalProperties: false,
    },
    handler: async (args) => {
      // Older connector schemas retain query but may omit the new guide parameter.
      if (!args.guide && /^(sceneSpec|model-drawing)$/i.test(String(args.query || '').trim())) return { data: { guide: 'model-drawing', markdown: fs.readFileSync(path.join(SKILLS_DIR, SKILL_GUIDES['model-drawing']), 'utf8') } };
      if (args.route) {
        const understanding = understandRequest(String(args.route), {});
        const route = routeSkills(understanding, { prompt: args.route, routingQuery: true }, { budgetTokens: args.budgetTokens });
        const briefs = route.skills
          .filter(({id}) => INLINE_BRIEFS.has(id))
          .map(({id}) => ({ id, markdown: fs.readFileSync(path.join(SKILLS_DIR, SKILL_GUIDES[id]), 'utf8') }));
        return { data: { route, briefs, understanding: { designType: understanding.designType, entities: understanding.entities.map((e) => `${e.id}×${e.count}`), relations: understanding.relations.map((r) => `${r.subject} ${r.relation} ${r.object}`) } } };
      }
      if (args.guide) {
        if (args.guide === 'list') {
          return { data: { guides: require('./engine/skill-contracts').skillContracts(engine.knowledge) } };
        }
        const file = SKILL_GUIDES[args.guide];
        if (!file) throw new Error(`unknown guide: ${args.guide}`);
        return { data: { guide: args.guide, markdown: fs.readFileSync(path.join(SKILLS_DIR, file), 'utf8') } };
      }
      if (args.sectionId) {
        const section = engine.docs.getSection(args.sectionId);
        if (!section) throw new Error(`section not found: ${args.sectionId}`);
        return { data: { section } };
      }
      if (Array.isArray(args.operations) && args.operations.length) {
        return { data: { operations: engine.docs.helpFor(args.operations) } };
      }
      return {
        data: {
          summary: engine.docs.summary(),
          results: engine.docs.search(args.query || 'operations', args.limit || 5),
        },
      };
    },
  });

  tools.push({
    name: 'artforge_book_knowledge',
    title: 'Query the nine design books (page-verified knowledge)',
    description:
      'Browse the book knowledge (research only). NOT needed before drawing: artforge_create_design already applies the book rules and reports them in evidence. '
      + 'Search the knowledge index built from the nine design books: page-bound concepts with their book, page, category, short quote and '
      + 'verification state (embedded text / OCR / caption / table of contents), plus which ArtForge operations can actually express each concept. '
      + 'Actions: coverage, books, search, page. Knowledge is guidance only — book text and artwork are never copied into designs.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['coverage', 'books', 'search', 'page'], description: 'What to return (default search).' },
        previewPage: { type: 'boolean', description: 'For action=page only: render a bounded preview of the hash-verified original book page, reference-only.' },
        pagePreviewWidth: { type: 'integer', minimum:120, maximum:900, description:'Original-page preview width; default 600.' },
        retrievalMode: { type: 'string', enum: ['keyword','hybrid-fts5','hybrid-local-lsa'], description: 'Optional local search: keyword default; hybrid-fts5 uses BM25/RRF; hybrid-local-lsa adds corpus-only latent semantic vectors, without a neural model.' },
        query: { type: 'string', description: 'Design query or concept, e.g. "reflected light" or "تشريح الشخصية".' },
        bookId: { type: 'string', description: 'Restrict to one book id (see action=books).' },
        page: { type: 'number', description: 'Page number for action=page.' },
        books: { type: 'array', items: { type: 'string' }, description: 'Restrict search to these book ids.' },
        categories: { type: 'array', items: { type: 'string' }, description: 'Restrict search to these categories.' },
        limit: { type: 'number', description: 'Max results (default 8, max 20).' },
      },
      additionalProperties: false,
    },
    handler: async (args) => {
      const knowledge = engine.knowledge;
      if (!knowledge || !knowledge.isAvailable()) {
        throw new Error('book knowledge index is not built yet. Run: cd book-index && node bin/book-index.js build');
      }
      const action = args.action || (args.page ? 'page' : 'search');
      if (action === 'coverage') {
        return { data: knowledge.summary() };
      }
      if (action === 'books') {
        const books = knowledge.listBooks().map((book) => ({
          id: book.id,
          title: book.title,
          specialty: book.specialty,
          categories: book.categories,
          pages: book.pagesProcessed,
          pagesWithText: book.pagesWithUsableText,
          ocrPages: book.ocrPages,
          imagesDetected: book.imagesDetected,
          concepts: book.concepts,
          secondarySource: book.secondarySource,
          toolBound: book.toolBound,
          intents: (book.routingHints && book.routingHints.intents) || [],
        }));
        return { data: { count: books.length, books } };
      }
      if (action === 'page') {
        if (!args.bookId || !args.page) throw new Error('bookId and page are required for action=page');
        const page = knowledge.pageRecord(args.bookId, args.page);
        if (!page) throw new Error(`page not found: ${args.bookId} p${args.page}`);
        const originalPage = args.previewPage ? await require('./engine/book-page-preview').bookPagePreview(knowledge, engine.paths, args.bookId, args.page, args.pagePreviewWidth || 600) : null;
        const concepts = knowledge.load().concepts
          .filter((concept) => concept.bookId === args.bookId && concept.pages.includes(Number(args.page)))
          .map((concept) => ({
            id: concept.id,
            title: concept.title,
            categories: concept.categories,
            verification: concept.verification,
            evidence: String(concept.evidence || '').slice(0, 240),
          }));
        return {
          data: {
            bookId: args.bookId,
            page: Number(args.page),
            kind: page.kind,
            textSource: page.textSource,
            textConfidence: page.textConfidence,
            isToc: Boolean(page.isToc),
            headings: page.headings,
            captions: page.captions,
            imagesDetected: page.imagesDetected,
            visual: page.visual,
            textExcerpt: String(page.text || '').slice(0, 700),
            concepts,
            referencePreview: originalPage ? { width:originalPage.width,height:originalPage.height,sha256:originalPage.sha256,source:originalPage.source } : undefined,
            note: 'textExcerpt is a short internal citation; book text is never copied into outputs.',
          },
          ...(originalPage ? { images:[{mimeType:'image/png',data:originalPage.bytes.toString('base64')}],meta:{artforge:{previewDataUrl:'data:image/png;base64,'+originalPage.bytes.toString('base64'),referenceOnly:true}} } : {}),
        };
      }

      if (!args.query) throw new Error('query is required for action=search');
      // bookId (documented as "restrict to one book") was ignored here; an explicit restriction is honoured,
      // and without one the search covers every book: the 1–2 auto-selected books are reported as a hint
      // only, because narrowing to them hid the right page (Arabic «المنظور الجوي» never reached Color and Light).
      const requested = Array.isArray(args.books) && args.books.length ? args.books : (args.bookId ? [args.bookId] : []);
      const known = new Set(knowledge.listBooks().map((b) => b.id));
      const unknown = requested.filter((id) => !known.has(id));
      if (unknown.length) throw Object.assign(new Error(`Unknown book id: ${unknown.join(', ')} (see action=books)`), { code: 'BOOK_NOT_FOUND' });
      const selection = knowledge.selectBooks(args.query, { limit: Math.min(3, requested.length || 2), books: requested });
      const books = requested.length ? requested : null;
      const results = knowledge.retrieve(args.query, {
        mode: args.retrievalMode,
        books,
        categories: args.categories,
        limit: Math.min(20, args.limit || 8),
      });
      return {
        data: {
          query: args.query,
          searchedBooks: books || 'all',
          selectedBooks: selection,
          resultCount: results.length,
          results,
          rules: {
            scope: 'books/bookId restrict the search; otherwise all nine books are searched and selectedBooks is a ranking hint',
            evidencePolicy: 'each result carries book, page, quote and verification state',
          },
        },
      };
    },
  });

  tools.push({
    name: 'artforge_execute_design',
    title: 'Execute the plan (phases ④ ⑤)',
    description:
      'Run a plan created by artforge_plan_design through the drawing tool: create the document, draw every element with the real operations, '
      + 'add the animation, save the editable design, export an image and return an authoritative PNG preview. '
      + 'planId is required; pass the requestId from artforge_plan_design too so a mismatched plan is rejected.',
    inputSchema: {
      type: 'object',
      properties: {
        planId: { type: 'string', description: 'Plan id returned by artforge_plan_design.' },
        requestId: { type: 'string', description: 'Request id returned by planning; when provided it must match the plan.' },
        requestHash: { type: 'string', description: 'Request hash returned by planning; when provided it must match the plan.' },
        documentId: { type: 'string', description: 'Optional existing document id to draw into instead of creating one.' },
        previewWidth: { type: 'number', description: 'Preview width in px (default 720).' },
        preview: { type: 'boolean', description: 'Set false to skip the PNG preview image.' },
      },
      required: ['planId'],
      additionalProperties: false,
    },
    _meta: WIDGET_TOOL_META,
    handler: async (args) => {
      const plan = engine.pipeline.loadPlan(args.planId);
      if (!plan) {
        throw new Error(`plan not found: ${args.planId}. Call artforge_create_design to plan and draw in one call.`);
      }
      // متوافق مع عقد الإنتاج (planId فقط)؛ أي معرّف يُرسل يجب أن يطابق. الخطط القديمة تُرفض عبر expiresAt.
      if ((args.requestId && args.requestId !== plan.requestId) || (args.requestHash && args.requestHash !== plan.requestHash)) {
        const error = new Error('The supplied request identity does not match this plan. Create a new plan for the current request.');
        error.code = 'PLAN_REQUEST_MISMATCH';
        throw error;
      }
      if (plan.expiresAt && (!Number.isFinite(Date.parse(plan.expiresAt)) || Date.now() >= Date.parse(plan.expiresAt))) {
        const error = new Error('Plan has expired. Create a new plan for the current request.');
        error.code = 'PLAN_EXPIRED';
        throw error;
      }
      const run = await engine.pipeline.execute(plan, {
        documentId: args.documentId,
        previewWidth: args.previewWidth,
        preview: args.preview !== false,
      });
      return runResult(plan, run);
    },
  });

  tools.push({
    name: 'artforge_tool_op',
    title: 'Call any drawing tool operation',
    description:
      'Edit an existing design (object.update, draw.text, …). BATCH YOUR EDITS: op:"batch" with params:{documentId, ops:[{op, params}, …]} runs up to 2000 operations in ONE call '
      + '(documentId is filled into each op) and returns the updated preview image, so no separate export call is needed. Every separate call costs seconds of round trip; never send one shape per call. '
      + 'Optional generation.status and generation.generate use the separately injected image adapter (disabled by default; MCP cannot enable it). For draw-then-generate pass params:{operationId,prompt,width,height,documentId}; the existing drawing is rendered and sent as an actual reference image. source reports its document id and SHA256. A 3D look is a raster image, not a 3D mesh. '
      + 'DEV optional durable generation.jobs.status/submit/get/cancel/delete/preview use a separately owner-configured local worker; submit accepts GenerationSpec v1 (version,operationId,prompt,width,height,seed,overlays). Never pass owner, provider URLs or model paths. '
      + 'For connectors with cached schemas, op=design.plan forwards params to the same authoritative design planner, including sceneSpec; execute its returned planId with artforge_execute_design. '
      + 'Pass-through to the drawing tool operations API (document.info, object.update, draw.text, export.image, animation.addKey, ...). '
      + 'Use it to edit a design after it was created; see artforge_tool_docs for parameters.',
    inputSchema: {
      type: 'object',
      properties: {
        op: { type: 'string', description: 'Operation name, e.g. object.update, or "batch" for many operations in one call.' },
        params: { type: 'object', description: 'Operation parameters (documentId is required for document operations). For batch: {documentId, ops:[{op, params}], preview?: true, previewWidth?}.' },
        ops: { type: 'array', items: { type: 'object' }, description: 'Shortcut for a batch: [{op, params}, …] applied to params.documentId in one call.' },
      },
      required: ['op'],
      additionalProperties: false,
    },
    handler: async (args) => {
      if (args.op === 'generation.status') return { data: engine.generativeImages.status() };
      if (args.op.startsWith('generation.jobs.')) {
        const jobs = engine.generationJobs, owner = engine.generationOwner, params = args.params || {};
        if (!jobs) throw Object.assign(new Error('GENERATION_DISABLED'), { code: 'GENERATION_DISABLED' });
        const action = args.op.slice('generation.jobs.'.length);
        if (action === 'status') return { data: jobs.status() };
        if (action === 'submit') return { data: jobs.submit(owner, params) };
        // Prevent client owner/path/model injection, including on read/delete endpoints.
        if (Object.keys(params).some(k => k !== 'jobId') || typeof params.jobId !== 'string') throw Object.assign(new Error('INVALID_GENERATION_REQUEST'), { code: 'INVALID_GENERATION_REQUEST' });
        if (action === 'get') return { data: jobs.get(owner, params.jobId) };
        if (action === 'cancel') return { data: jobs.cancel(owner, params.jobId) };
        if (action === 'delete') return { data: jobs.remove(owner, params.jobId) };
        if (action === 'preview') {
          const image = jobs.image(owner, params.jobId);
          // Preview the committed composite, including exact editable Arabic, not the raw model output.
          const final = engine.artifacts.get(image.result.artifact.id);
          const preview = await engine.previewGeneratedImage({ bytes: final.bytes, width: image.spec.width, height: image.spec.height, mimeType: 'image/png' });
          return { data: { ...jobs.get(owner, params.jobId), previewOf: 'saved-composite' }, images: [{ mimeType: preview.mimeType, data: preview.bytes.toString('base64') }] };
        }
        throw Object.assign(new Error('INVALID_GENERATION_OPERATION'), { code: 'INVALID_GENERATION_OPERATION' });
      }
      if (args.op === 'generation.generate') {
        const generated = await engine.generativeImages.generate(args.params || {});
        const preview = await engine.previewGeneratedImage(generated);
        return { data: { width: generated.width, height: generated.height, sha256: generated.sha256, source: generated.source, preview: {width:preview.width,height:preview.height,sha256:preview.sha256},
          delivery: { imageInResponse: true }, visualReview: 'not-reviewed' },
          images: [{ mimeType: preview.mimeType, data: preview.bytes.toString('base64') }] };
      }
      if (args.op === 'design.plan') return tools.find((tool) => tool.name === 'artforge_plan_design').handler(args.params || {});
      const params = Object.assign({}, args.params || {});
      const list = Array.isArray(args.ops) && args.ops.length ? args.ops : (args.op === 'batch' && Array.isArray(params.ops) ? params.ops : null);
      if (list) return runBatch(engine, params, list);
      const result = await engine.bridge.call(args.op, params);
      return { data: { op: args.op, durationMs: result.durationMs, result: result.data } };
    },
  });

  tools.push({
    name: 'artforge_export',
    title: 'Export an existing design',
    description: 'Export a document to PNG/JPEG/WebP/SVG/PDF, a Photoshop PSD (layers, groups, blend, clipping, simple adjustments; a report lists what is baked) or a project bundle, and return an engine-rendered preview image.',
    inputSchema: {
      type: 'object',
      properties: {
        documentId: { type: 'string' },
        format: { type: 'string', enum: ['png', 'jpeg', 'webp', 'svg', 'pdf', 'psd', 'bundle'] },
        scale: { type: 'number', description: '1-4' },
        time: { type: 'number', description: 'Animation time in ms.' },
        static: { type: 'boolean', description: 'Ignore animation (true for still posters).' },
        previewWidth: { type: 'number', description: 'Preview width in px (default 900).' },
        preview: { type: 'boolean', description: 'Set false to skip the PNG preview image.' },
      },
      required: ['documentId'],
      additionalProperties: false,
    },
    _meta: WIDGET_TOOL_META,
    handler: async (args) => {
      const exported = await engine.bridge.call(['svg','pdf','psd','bundle'].includes(args.format) ? 'export.' + args.format : 'export.image', {
        documentId: args.documentId,
        format: args.format || 'png',
        ...(['svg','pdf','psd','bundle'].includes(args.format) ? {outPath: 'outputs/' + args.documentId + (args.format==='bundle'?'.artforge.zip':'.'+args.format), inline:false} : {}),
        scale: args.scale,
        time: args.time,
        static: args.static !== false,
      });
      const artifact=['svg','pdf','psd','bundle'].includes(args.format) ? engine.artifacts.register(exported.data.path,args.format,args.documentId) : null;
      if(artifact)exported.data.artifact=artifact;
      const resources=artifact?[artifact]:[];
      if (args.preview === false) {
        return { resources, data: { exported: exported.data, preview: { skipped: true, reason: 'preview:false' } }, meta: { artforge: { documentId: args.documentId, exported: exported.data } } };
      }
      const preview = await boundedPreview(engine.bridge, args.documentId, args.previewWidth || 900);
      if (preview.skipped) return { resources, data: { exported: exported.data, preview }, meta: { artforge: { documentId: args.documentId, exported: exported.data, previewDataUrlOmitted: preview.reason } } };
      return {
        resources,
        data: {
          exported: exported.data,
          preview: { sha256: preview.sha256, revision: preview.revision, bytes: preview.bytes },
        },
        images: [{ mimeType: 'image/png', data: preview.base64 }],
        meta: { artforge: { previewDataUrl: `data:image/png;base64,${preview.base64}`, documentId: args.documentId, exported: exported.data } },
      };
    },
  });

  tools.push({
    name: 'artforge_status',
    title: 'Runtime status',
    description: 'Report engine state: reference index, plans/runs on disk, drawing tool reachability and stored documents.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async () => {
      const health = await engine.bridge.health();
      let documents = [];
      if (health.ok) {
        try { documents = await engine.bridge.documents(); } catch { documents = []; }
      }
      const plansDir = path.join(engine.stateDir, 'plans');
      const runsDir = path.join(engine.stateDir, 'runs');
      const count = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).length : 0);
      const latestRuns = fs.existsSync(runsDir)
        ? fs.readdirSync(runsDir).sort().slice(-5).map((file) => {
          const run = JSON.parse(fs.readFileSync(path.join(runsDir, file), 'utf8'));
          return { runId: run.runId, planId: run.planId, documentId: run.documentId, ok: run.ok, finishedAt: run.finishedAt };
        })
        : [];
      return {
        data: {
          references: engine.library.summary().counts,
          plans: count(plansDir),
          runs: count(runsDir),
          latestRuns,
          drawingTool: { url: engine.bridge.baseUrl, reachable: health.ok },
          documents: documents.slice(0, 10),
        },
      };
    },
  });

tools.push({name:'artforge_artifacts',title:'Manage exported artifacts',description:'List/get metadata or remove bounded exported resources. Removal deletes only resource copy. Retention7days, max64 entries,8MiB each.',inputSchema:{type:'object',properties:{action:{type:'string',enum:['list','get','delete']},artifactId:{type:'string'}},required:['action'],additionalProperties:false},handler:async args=>({data:args.action==='list'?{artifacts:engine.artifacts.list()}:args.action==='delete'?engine.artifacts.remove(args.artifactId):{artifact:engine.artifacts.get(args.artifactId).record}})});

  return tools;
}

module.exports = { buildTools, WIDGET_URI };

