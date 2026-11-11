'use strict';

/**
 * Ornamental composer (abstractStyle "ornamental"): a decorative bloom over waves, or a phoenix, planned by the
 * ornament-flow engine (eye path, curve vocabulary, weight hierarchy, detail density, readable overlaps).
 *
 * ornamentPass "value" renders the one-hue value study; "color" (default) renders the same geometry in colour.
 * The structural review runs on the plan in both passes and is returned in meta.ornament.review; failed gates
 * become verification issues (see Pipeline.mergeVerification).
 */

const { planOrnament, reviewOrnament, renderOrnament } = require('../ornament-flow');
const { hexToOklab, lch } = require('../swatches');

/** Reference hues (only when the caller asked for colours): the engine's hue roles take the palette's hues. */
function hueMapFrom(colors) {
  const chroma = (colors || []).map((hex) => Object.assign({ hex }, lch(hexToOklab(hex)))).filter((c) => c.C > 0.04).sort((a, b) => a.h - b.h);
  if (chroma.length < 3) return null;
  const roles = ['crimson', 'pink', 'magenta', 'purple', 'lilac', 'orange', 'gold', 'green', 'teal', 'blue', 'cloud'];
  const target = { crimson: 12, pink: 352, magenta: 335, purple: 305, lilac: 290, orange: 52, gold: 82, green: 140, teal: 195, blue: 255, cloud: 330 };
  const dist = (a, b) => Math.min(Math.abs(a - b), 360 - Math.abs(a - b));
  return Object.fromEntries(roles.map((r) => [r, chroma.reduce((best, c) => (dist(c.h, target[r]) < dist(best.h, target[r]) ? c : best)).h]));
}

function composeOrnamental(P, ctx) {
  const { intent, ev, input, roles } = ctx;
  const orn = intent.ornament || {};
  const subject = input.ornamentSubject || orn.subject || 'bloom';
  const pass = input.ornamentPass || orn.pass || 'color';
  const seed = Math.floor(P.rand(1, 2 ** 31));
  const plan = planOrnament({ width: P.W, height: P.H, seed, subject, waves: orn.waves !== false });
  const review = reviewOrnament(plan);
  const requested = new Set((intent.elements || []).map((e) => e.id));
  const askedColours = Boolean(input.palette || input.paletteId || input.palettes || input.referenceImage || input.referenceAnalysis);
  const hueMap = askedColours && roles && roles.colors ? hueMapFrom(roles.colors) : null;
  const subjectId = subject === 'phoenix' ? (requested.has('birds') ? 'birds' : 'shapes') : (requested.has('flowers') ? 'flowers' : 'shapes');
  const elementIds = { bloom: subjectId, plume: subjectId, body: subjectId, crest: subjectId, wing: subjectId, tail: subjectId, wave: requested.has('sea') ? 'sea' : 'waves', ground: 'shapes' };
  const out = renderOrnament(P, plan, { pass, elementIds, hueMap });
  ctx.effects = pass === 'value' ? [] : [{ type: 'grade', contrast: 1.03, saturation: 1.02 }, { type: 'grain', amount: 0.05 }];
  const m = review.metrics;
  ev.record('rhythm-flow', `Ornament eye path: ${m.eyePathReversals} reversals, masses cover ${Math.round(m.eyePathCoverage * 100)}% of the path; origins concentration ${Math.round(m.originConcentration * 100)}% (fan ≤ 35%); curve families ${JSON.stringify(m.curveFamilyCounts)}.`, [], subjectId);
  ev.record('value-contrast', `Ornament values: range ${m.valueRange}, ${m.interlace} overlaps, ${Math.round(m.overlapReadable * 100)}% readable in the one-hue study (Δ≥0.12 or rim).`, [], subjectId);
  return {
    style: 'ornamental',
    requested: (intent.elements || []).map((e) => e.id),
    ornament: {
      subject, pass, seed, ops: out.ops,
      review: { ok: review.ok, score: review.score, gates: review.gates, counts: review.counts, metrics: { curveFamilyCounts: m.curveFamilyCounts, roleCounts: m.roleCounts, detailGrid: m.detailGrid } },
      next: pass === 'value' ? 'Value study: judge movement, variety and interlace in greys; then repeat with ornamentPass "color" and the same seed/prompt.' : 'Colour pass of the reviewed structure.',
    },
  };
}

module.exports = { composeOrnamental, hueMapFrom };
