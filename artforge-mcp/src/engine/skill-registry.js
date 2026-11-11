'use strict';

/**
 * Agent skill registry: one entry per guide in skills/.
 *
 * The operating procedure is the entry point for core, art, engine and tool guides.
 * Each entry declares when it applies (triggers), what it needs (requires), what it
 * replaces (conflicts), the topics it covers (for de-duplication) and its execution phase (for ordering).
 * Token cost is measured from the file itself, so the router's budget follows the real text.
 */

const fs = require('node:fs');
const path = require('node:path');

const SKILLS_DIR = path.join(__dirname, '..', '..', 'skills');

const PHASES = ['procedure', 'understand', 'structure', 'references', 'direction', 'render', 'review'];

const REGISTRY = [
  { id: 'operating-procedure', file: '00-operating-procedure.md', group: 'procedure', phase: 'procedure', always: true, covers: ['procedure', 'delivery-path'] },
  // ── the original seven ──
  { id: 'arabic-typography', file: '01-arabic-typography.md', group: 'core', phase: 'render', covers: ['arabic-text', 'ruled'], triggers: { arabicText: 3, ruled: 3, text: 1 } },
  { id: 'tables', file: '02-tables.md', group: 'core', phase: 'render', covers: ['table'], triggers: { table: 5 } },
  { id: 'color-light-shadow', file: '03-color-light-shadow.md', group: 'core', phase: 'direction', covers: ['palette', 'lighting', 'blend'], triggers: { lighting: 2, picture: 1, mood: 1, palette: 2 } },
  { id: 'drawing', file: '04-drawing-brushes-perspective.md', group: 'core', phase: 'render', covers: ['brushes', 'paths', 'perspective-tools', 'shapes', 'vector-networks'], triggers: { painterly: 3, vectorTools: 5, manualEdit: 2, picture: 1, perspective: 1 } },
  { id: 'references', file: '05-references-and-knowledge.md', group: 'core', phase: 'references', covers: ['palette-cards', 'books'], triggers: { abstract: 2, palette: 1, books: 3 } },
  { id: 'quality-delivery', file: '06-quality-and-delivery.md', group: 'core', phase: 'review', covers: ['delivery', 'qa', 'interchange'], triggers: { text: 1, delivery: 2, exportFormat: 3 } },
  { id: 'model-drawing', file: '07-model-drawing.md', group: 'core', phase: 'render', covers: ['scenespec-manual'], triggers: { sceneSpec: 6, unsupported: 3 }, conflicts: ['scenespec-engine'] },
  // ── general art (7) ──
  { id: 'composition', file: '08-composition.md', group: 'art', phase: 'direction', covers: ['focal', 'balance', 'hierarchy'], triggers: { picture: 2, composition: 4, relations: 1, poster: 1 } },
  { id: 'value-and-form', file: '09-value-and-form.md', group: 'art', phase: 'direction', covers: ['value', 'edges', 'form-shadow'], triggers: { picture: 1, lighting: 1, detailHigh: 2, painterly: 1 } },
  { id: 'figure-and-gesture', file: '10-figure-and-gesture.md', group: 'art', phase: 'direction', covers: ['figure'], triggers: { person: 5, character: 4 } },
  { id: 'depth-and-space', file: '11-depth-and-space.md', group: 'art', phase: 'direction', covers: ['depth', 'planes', 'overlap'], triggers: { outdoor: 2, relations: 2, perspective: 2, viewpoint: 2 } },
  { id: 'materials-and-texture', file: '12-materials-and-texture.md', group: 'art', phase: 'render', covers: ['materials', 'texture'], triggers: { materials: 3, detailHigh: 1, painterly: 1 } },
  { id: 'nature-elements', file: '13-nature-elements.md', group: 'art', phase: 'render', covers: ['nature'], triggers: { nature: 4, outdoor: 1 } },
  { id: 'mood-and-style', file: '14-mood-and-style.md', group: 'art', phase: 'direction', covers: ['mood', 'style'], triggers: { mood: 4, style: 2 } },
  // ── ArtForge engine (7) ──
  { id: 'request-understanding', file: '15-request-understanding.md', group: 'engine', phase: 'understand', covers: ['understanding'], triggers: { relations: 3, counts: 2, negations: 3, ambiguous: 4 } },
  { id: 'scene-graph', file: '16-scene-graph.md', group: 'engine', phase: 'structure', covers: ['scene-graph'], triggers: { relations: 3, counts: 1, engineGraph: 5 } },
  { id: 'skill-routing', file: '17-skill-routing.md', group: 'engine', phase: 'understand', covers: ['routing'], triggers: { routingQuery: 6 } },
  { id: 'visual-references', file: '18-visual-references.md', group: 'engine', phase: 'references', covers: ['reference-analysis'], triggers: { reference: 5, palette: 1, designSystem: 2 } },
  { id: 'art-direction', file: '19-art-direction.md', group: 'engine', phase: 'direction', covers: ['art-direction'], triggers: { engineGraph: 3, artDirection: 6, picture: 1 } },
  { id: 'scenespec-engine', file: '20-scenespec-engine.md', group: 'engine', phase: 'render', covers: ['scenespec-auto'], triggers: { engineGraph: 6, unsupported: 2 }, requires: ['scene-graph'], conflicts: ['model-drawing'] },
  { id: 'visual-review', file: '21-visual-review.md', group: 'engine', phase: 'review', covers: ['review', 'correction'], triggers: { engineGraph: 3, picture: 1, delivery: 1 } },
  // ── drawing-engine tools (3): professional use of the editor operations through artforge_tool_op ──
  { id: 'layers-and-effects', file: '22-layers-and-effects.md', group: 'tools', phase: 'render', covers: ['layers', 'effects', 'masks', 'adjustments', 'filters'], triggers: { photoEdit: 5, manualEdit: 2 } },
  { id: 'pixels-and-retouch', file: '23-pixels-and-retouch.md', group: 'tools', phase: 'render', covers: ['pixels', 'selection', 'retouch', 'warp'], triggers: { retouch: 5, reference: 1 } },
  { id: 'editing-workflow', file: '24-editing-workflow.md', group: 'tools', phase: 'render', covers: ['edit-workflow', 'arrange'], triggers: { editing: 5, manualEdit: 3 } },
  { id: 'promotional-layouts', file: '25-promotional-layouts.md', inlineBrief: true, group: 'core', phase: 'structure', covers: ['card-layout', 'advertising-layout', 'banner-layout', 'poster-layout'], triggers: { promotionLayout: 13 } },
  { id: 'logo-identity', file: '26-logo-identity.md', inlineBrief: true, group: 'core', phase: 'structure', covers: ['identity-layout', 'logo-geometry', 'small-size-proof'], triggers: { identityLayout: 13 } },
  { id: 'editorial-layouts', file: '27-editorial-layouts.md', inlineBrief: true, group: 'core', phase: 'structure', covers: ['magazine-grid', 'editorial-hierarchy'], triggers: { editorialLayout: 13 } },
  { id: 'educational-layouts', file: '28-educational-layouts.md', inlineBrief: true, group: 'core', phase: 'structure', covers: ['lesson-template', 'infographic-layout', 'data-labels', 'series-consistency'], triggers: { educationLayout: 13 } },
  { id: 'vector-colour-blending', file: '29-vector-colour-blending.md', inlineBrief: true, group: 'tools', phase: 'direction', covers: ['vector-gradient', 'shape-interpolation', 'colour-compositing', 'svg-fidelity'], triggers: { vectorColour: 14 } },
  { id: 'ornamental-composition', file: '30-ornamental-composition.md', inlineBrief: true, group: 'core', phase: 'structure', covers: ['ornament-flow', 'curve-vocabulary', 'detail-density', 'value-study'], triggers: { ornament: 14 } },
];

const tokenCache = new Map();
/** Real cost of loading a guide, ≈ characters/3.2 for mixed Arabic/English markdown. */
function tokensOf(entry) {
  if (!tokenCache.has(entry.id)) {
    let chars = 0;
    try { chars = fs.readFileSync(path.join(SKILLS_DIR, entry.file), 'utf8').length; } catch { chars = 0; }
    tokenCache.set(entry.id, Math.ceil(chars / 3.2));
  }
  return tokenCache.get(entry.id);
}

const SKILL_GUIDES = Object.fromEntries(REGISTRY.map((e) => [e.id, e.file]));

module.exports = { REGISTRY, SKILL_GUIDES, SKILLS_DIR, PHASES, tokensOf };
