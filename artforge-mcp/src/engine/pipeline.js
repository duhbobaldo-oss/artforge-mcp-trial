'use strict';

const fs = require('node:fs');
const { context: traceContext } = require('./trace-context');
const { compareContract } = require('./request-contract');
const path = require('node:path');
const { createLogger } = require('./log');
const { analyzeLayout } = require('./layout-qa');
const { boundedPreview } = require('./preview');
const { reviewAndCorrect, BLOCKING: REVIEW_BLOCKING } = require('./visual-review');

const MAX_PAGES = 20;

/**
 * Preview width from a pixel budget, not a fixed width.
 * A 1200×1680 poster at width 720 is 726k pixels and inflates the MCP response to ~280 KB;
 * the same design at the default 520k-pixel budget is smaller and still legible.
 * An explicit previewWidth always wins.
 */
function previewWidthFor(canvas, explicit) {
  if (explicit) return Number(explicit);
  const budget = Number(process.env.ARTFORGE_PREVIEW_PIXEL_BUDGET || 520000);
  const w = Number(canvas && canvas.width) || 0;
  const h = Number(canvas && canvas.height) || 0;
  if (!w || !h || !Number.isFinite(budget) || budget <= 0) return 900;
  return Math.max(320, Math.min(900, Math.floor(Math.sqrt((budget * w) / h))));
}

/** Replace "$name.field.sub" strings with values saved from earlier ops (e.g. "$ref.asset.id"). */
function resolvePlaceholders(value, saved) {
  if (typeof value === 'string' && value.startsWith('$')) {
    const [name, ...fields] = value.slice(1).split('.');
    if (Object.prototype.hasOwnProperty.call(saved, name)) {
      return fields.reduce((acc, key) => (acc === undefined || acc === null ? acc : acc[key]), saved[name]);
    }
    return value;
  }
  if (Array.isArray(value)) return value.map((v) => resolvePlaceholders(v, saved));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = resolvePlaceholders(v, saved);
    return out;
  }
  return value;
}

/**
 * Executes a design plan through the mandatory sequence:
 * ① routing (already done by the router) → ② references (already resolved)
 * → ③ tool documentation → ④ drawing tool operations → ⑤ preview + save + export + QA.
 * Plans whose layout step reports a continuation cursor are paginated into several documents.
 */
class Pipeline {
  constructor(options) {
    const opts = options || {};
    this.bridge = opts.bridge;
    this.docs = opts.docs;
    this.stateDir = opts.stateDir;
    this.library = opts.library;
    this.logger = opts.logger || createLogger('pipeline', {});
    this.deadlineMs = Number(opts.deadlineMs || process.env.ARTFORGE_RUN_DEADLINE_MS || 180000);
    fs.mkdirSync(path.join(this.stateDir, 'runs'), { recursive: true });
  }

  savePlan(plan) {
    const file = path.join(this.stateDir, 'plans', `${plan.planId}.json`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(plan, null, 2), 'utf8');
    return file;
  }

  loadPlan(planId) {
    if (typeof planId !== 'string' || !/^plan_[a-zA-Z0-9_-]+$/.test(planId)) {
      const error = new Error('invalid planId');
      error.code = 'INVALID_PLAN_ID';
      throw error;
    }
    const file = path.join(this.stateDir, 'plans', `${planId}.json`);
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  }

  async execute(plan, options) {
    const opts = options || {};
    const runId = `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
    const startedAt = new Date().toISOString();
    const t0 = Date.now();
    const deadlineAt = Date.now() + this.deadlineMs;
    const phases = plan.phases.map((phase) => Object.assign({}, phase, { status: 'pending' }));
    let currentPhase = 'index';
    const setPhase = (key, status, detail) => {
      const phase = phases.find((entry) => entry.key === key);
      if (phase) {
        phase.status = status;
        phase.detail = detail;
        phase.at = new Date().toISOString();
        if (status === 'running') currentPhase = key;
      }
    };
    const executed = [];
    const warnings = [];
    const timings = [];
    const phaseMs = { docs: 0, draw: 0, deliver: 0, qa: 0, preview: 0, layout: 0 };
    const bridgeMetrics = Object.assign({}, this.bridge.metrics);
    const pages = [];
    let review = null;
    this.logger.info('run-start', { runId, planId: plan.planId, ops: plan.ops.length, deadlineMs: this.deadlineMs });

    try {
      setPhase('index', 'done', `skill=${plan.skill.id}, canvas=${plan.canvas.width}x${plan.canvas.height}, palettes=${plan.references.palettes.length}, designSystem=${plan.references.designSystem.id}`);
      const knowledge = plan.references.knowledge || { books: [] };
      setPhase('references', 'done', [
        plan.references.palettes
          .map((palette) => `${palette.id} [${palette.colors.slice(0, 4).join(' ')}]`)
          .join(' | '),
        knowledge.books.length
          ? `books: ${knowledge.books.map((book) => `${book.id}(p${book.score})`).join(', ')} · concepts: ${(knowledge.concepts || []).length}`
          : 'books: none matched (knowledge references not forced)',
      ].join(' · '));

      let mark = Date.now();
      const help = this.docs.helpFor(plan.operationNames);
      phaseMs.docs = Date.now() - mark;
      setPhase('tool-docs', 'done', `documented operations: ${help.filter((entry) => entry.inputs !== null).length}/${help.length}`);

      setPhase('execute', 'running', 'drawing tool operations');
      await this.bridge.ensure();
      let overrides = {};
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const layerIds = {};
        const saved = {};
        const objectIds = {};
        let documentId = page === 0 ? (opts.documentId || null) : null;
        let continuation = null;
        let ruledQa = null;
        const queue = [];
        const self = this;
        async function flush() {
          if (!queue.length) return;
          const items = queue.splice(0, queue.length);
          if (self.batchSupported !== false) {
            try {
              const started = Date.now();
              const response = await self.bridge.call('batch', { ops: items.map((item) => ({ op: item.step.op, params: item.params })) });
              const results = (response.data && response.data.results) || [];
              if (results.length !== items.length || results.some((r) => !r || r.ok !== true)) {
                const error = new Error('Drawing tool returned an incomplete or invalid batch response'); error.code = 'TOOL_BAD_RESPONSE'; throw error;
              }
              const share = Math.round((Date.now() - started) / items.length);
              items.forEach((item, k) => afterStep(item.step, item.index, Object.assign({ elapsedMs: share, batched: true }, results[k] || {})));
              return;
            } catch (error) {
              if (error.code !== 'UNKNOWN_OP') {
                if (error.details && Number.isInteger(error.details.batchIndex)) error.op = items[error.details.batchIndex] ? items[error.details.batchIndex].step.op : error.op;
                throw error;
              }
              self.batchSupported = false; // older drawing tool: fall back to one request per op
            }
          }
          for (const item of items) afterStep(item.step, item.index, await self.bridge.call(item.step.op, item.params));
        }
        mark = Date.now();
        for (let index = 0; index < plan.ops.length; index += 1) {
          const step = plan.ops[index];
          if (Date.now() > deadlineAt) {
            const error = new Error(`run exceeded the ${this.deadlineMs}ms deadline before ${step.op}`);
            error.code = 'PIPELINE_DEADLINE';
            error.op = step.op;
            throw error;
          }
          if (step.createsDocument && page === 0 && opts.documentId) {
            executed.push({ op: step.op, ok: true, skipped: true, note: 'existing document reused' });
            continue;
          }
          let params = Object.assign({}, step.params, overrides[index] || {});
          if (params.layer && !params.layerId) {
            const layerId = layerIds[params.layer];
            if (layerId) params.layerId = layerId;
            delete params.layer;
          }
          for (const key of Object.keys(params)) {
            // Any "<x>Layer" alias (e.g. rulesLayer) becomes "<x>LayerId".
            if (key !== 'layer' && /Layer$/.test(key) && typeof params[key] === 'string' && layerIds[params[key]]) {
              params[`${key}Id`] = layerIds[params[key]];
              delete params[key];
            }
          }
          params = resolvePlaceholders(params, saved);
          if (!step.createsDocument && step.op !== 'image.add') params.documentId = documentId;

          // Consecutive plain drawing steps travel together in one batch request (fewer round trips).
          const batchable = this.batching !== false && !step.createsDocument && !step.alias && !step.saveAs
            && !step.paginate && !step.qaRuled && !step.animates && step.op !== 'image.add';
          if (batchable) {
            queue.push({ step, index, params });
            const nextStep = plan.ops[index + 1];
            const nextBatchable = nextStep && !nextStep.createsDocument && !nextStep.alias && !nextStep.saveAs && !nextStep.paginate && !nextStep.qaRuled && !nextStep.animates && nextStep.op !== 'image.add';
            if (nextBatchable && queue.length < 1500) continue;
            await flush();
            continue;
          }
          await flush();
          const response = await this.bridge.call(step.op, params);
          afterStep(step, index, response);
        }
        await flush();
        function afterStep(step, index, response) {
          timings.push({ op: step.op, ms: response.elapsedMs || null, page: page + 1 });
          const data = response.data || {};
          if (step.createsDocument) documentId = data.documentId;
          if (step.alias && data.layerId) layerIds[step.alias] = data.layerId;
          if (step.saveAs) saved[step.saveAs] = data;
          if (data.objectId && step.animates) {
            objectIds.__animated = Object.assign({ objectId: data.objectId }, step.animates);
          }
          if (data.warnings && data.warnings.length) warnings.push(...data.warnings.map((w) => (page > 0 ? `page ${page + 1}: ${w}` : w)));
          if (step.paginate) {
            const next = data[step.paginate.resultField];
            if (next !== null && next !== undefined) continuation = { index, param: step.paginate.param, value: next };
          }
          if (step.qaRuled && Array.isArray(data.lines)) {
            const ruledLines = data.lines.filter((l) => l.rule !== null);
            ruledQa = { layerId: data.layerId, rules: ruledLines.map((l) => l.rule), sizes: ruledLines.map((l) => l.size), pitch: data.pitch };
          }
          executed.push({
            op: step.op,
            ok: true,
            note: step.note,
            element: step.element || undefined,
            owner: step.owner || undefined,
            page: page + 1,
            durationMs: response.durationMs,
            objectId: data.objectId,
            objectIds: Array.isArray(data.objectIds) ? data.objectIds : undefined,
            objectCount: Array.isArray(data.objectIds) ? data.objectIds.length : undefined,
            layerId: data.layerId,
            path: data.path,
          });
        }
        phaseMs.draw += Date.now() - mark;
        if (!documentId) throw new Error('document.create did not run: no documentId produced');
        if (page === 0) setPhase('execute', 'done', `${executed.filter((entry) => !entry.skipped).length} operations executed`);
        // ⑨ Visual review and correction: measure the drawn objects, move what breaks the plan, re-measure.
        if (page === 0 && plan.direction && /^(scene-graph|hybrid)/.test(String(plan.direction.engine)) && plan.direction.graph) {
          const reviewMark = Date.now();
          try {
            review = await reviewAndCorrect(Object.assign({ bridge: this.bridge, documentId, plan, steps: executed.filter((s) => s.page === 1) }, plan.direction.reviewOptions || {}));
          } catch (error) {
            review = { mode: 'failed', ok: null, error: error.message };
            warnings.push(`visual review failed: ${error.message}`);
          }
          phaseMs.review = Date.now() - reviewMark;
        }
        setPhase('deliver', 'running', `save, export, QA and preview (page ${page + 1})`);
        pages.push(await this.finishPage({
          plan, documentId, objectIds, page, ruledQa, executed, warnings, phaseMs, multi: Boolean(continuation) || page > 0,
        }));
        if (!continuation) break;
        if (page === MAX_PAGES - 1) {
          warnings.push(`content continues beyond ${MAX_PAGES} pages; the rest was not drawn`);
          break;
        }
        overrides = { [continuation.index]: { [continuation.param]: continuation.value } };
      }

      mark = Date.now();
      // The preview must fit the MCP response image limit, or the client receives no image at all.
      // PNG bytes grow with pixel area, so one measured correction replaces the old fixed
      // 0.75 ladder (900→675→506→320 = four renders) with at most two renders.
      const skipPreview = opts.preview === false;
      let preview = null;
      if (!skipPreview) {
          preview = await boundedPreview(this.bridge, pages[0].documentId, previewWidthFor(plan.canvas, opts.previewWidth));
      }
      phaseMs.preview = Date.now() - mark;
      const deliverPhase = phases.find((phase) => phase.key === 'deliver');
      if (deliverPhase) {
        deliverPhase.status = 'done';
        deliverPhase.detail = `${pages.length} page(s); saved ${pages.map((p) => p.saved.bytes).join('+')} bytes, exported ${pages.map((p) => p.exported.bytes).join('+')} bytes, preview ${preview ? `${preview.bytes} bytes` : 'skipped'}`;
        deliverPhase.at = new Date().toISOString();
      }
      const first = pages[0];
      const verification = Pipeline.mergeVerification(plan, pages);
      // No silent success: a measured missing/hidden element or a broken relation fails the run.
      if (review && review.ok === false) {
        verification.ok = false;
        verification.issues.push(...review.final.issues.filter((i) => REVIEW_BLOCKING.has(i.code)).map((i) => `review: ${i.code}${i.node ? ` ${i.node}` : ''}${i.relation ? ` ${i.relation}` : ''}${i.entity ? ` ${i.entity}` : ''}`));
      }
      if (review && review.mode === 'failed') { verification.ok = false; verification.issues.push(`review could not measure the drawing: ${review.error}`); }

      // Layout QA is measured separately from structural verification and never changes its verdict.
      // It costs one object.list round-trip, so it runs for layout-driven designs only.
      const LAYOUT_TYPES = new Set(['card', 'poster', 'ruled', 'text', 'table']);
      let layoutQA = null;
      if (process.env.ARTFORGE_LAYOUT_QA !== 'off' && plan.design && LAYOUT_TYPES.has(plan.design.type)) {
        const layoutMark = Date.now();
        try {
          const listed = await this.bridge.call('object.list', { documentId: first.documentId });
          layoutQA = analyzeLayout({
            canvas: plan.canvas,
            document: first.document,
            objects: (listed.data && listed.data.objects) || [],
          });
        } catch (error) {
          layoutQA = { scope: 'vector-geometry-only', applicable: false, ok: null, issues: [], error: error.message };
        }
        phaseMs.layout = Date.now() - layoutMark;
      }
      const layoutVerdict = !layoutQA || !layoutQA.applicable ? 'not-measured' : (layoutQA.ok ? 'passed' : 'failed');
      const run = {
        runId,
        traceId: traceContext.getStore()?.traceId || null,
        planTraceId: plan.traceId || null,
        planId: plan.planId,
        documentId: first.documentId,
        startedAt,
        finishedAt: new Date().toISOString(),
        ok: verification.ok,
        executionOk: true,
        acceptance: { structural: verification.ok ? 'passed' : 'failed', layout: layoutVerdict, geometry: review ? (review.ok ? 'passed' : 'failed') : 'not-measured', visual: 'not-reviewed' },
        bridgeMetrics: this.bridge.metrics ? Object.fromEntries(Object.entries(this.bridge.metrics).map(([k,v]) => [k, v - (bridgeMetrics[k] || 0)])) : null,
        phases,
        skill: plan.skill,
        design: plan.design || null,
        canvas: plan.canvas,
        references: plan.references,
        evidence: plan.evidence || null,
        colors: plan.colors,
        content: plan.content,
        typography: plan.typography,
        executed,
        warnings,
        verification,
        layoutQA,
        review,
        qa: pages.map((p) => p.qa),
        timings,
        phaseMs: Object.assign({ total: Date.now() - t0 }, phaseMs),
        pages: pages.map((p) => ({ page: p.page, documentId: p.documentId, saved: p.saved, exported: p.exported })),
        saved: first.saved,
        exported: first.exported,
        preview: preview && !preview.skipped ? {
          revision: preview.revision,
          sha256: preview.sha256,
          bytes: preview.bytes,
          width: preview.width,
          attempts: preview.attempts,
          fitsLimit: preview.fitsLimit,
          dataUrl: `data:image/png;base64,${preview.base64}`,
        } : (preview || { skipped: true, reason: 'preview disabled for this call' }),
        toolDocs: help,
      };
      const persisted = Object.assign({}, run, {
        preview: Object.assign({}, run.preview, { dataUrl: '<omitted in state file>' }),
      });
      fs.writeFileSync(path.join(this.stateDir, 'runs', `${runId}.json`), JSON.stringify(persisted, null, 2), 'utf8');
      this.logger.info(verification.ok ? 'run-ok' : 'run-incomplete', {
        runId, planId: plan.planId, documentId: first.documentId, pages: pages.length,
        elapsedMs: Date.now() - t0, phaseMs: run.phaseMs, exported: first.exported.bytes, preview: preview ? preview.bytes : null, ops: executed.length,
      });
      return run;
    } catch (error) {
      setPhase(currentPhase, 'failed', error.message);
      this.logger.error('run-failed', {
        runId, planId: plan.planId, phase: currentPhase, code: error.code || 'PIPELINE_ERROR',
        message: error.message, op: error.op || null, executed: executed.length,
      });
      const run = {
        runId,
        traceId: traceContext.getStore()?.traceId || null,
        planTraceId: plan.traceId || null,
        planId: plan.planId,
        startedAt,
        finishedAt: new Date().toISOString(),
        ok: false,
        error: {
          code: error.code || 'PIPELINE_ERROR',
          message: error.message,
          op: error.op || null,
          phase: currentPhase,
        },
        phases,
        executed,
        warnings,
        timings,
        pages: pages.map((p) => ({ page: p.page, documentId: p.documentId, exported: p.exported })),
      };
      fs.writeFileSync(path.join(this.stateDir, 'runs', `${runId}.json`), JSON.stringify(run, null, 2), 'utf8');
      error.run = run;
      throw error;
    }
  }

  /** Animation (first page only), save, export, verify and pixel QA for one page. */
  async finishPage(context) {
    const { plan, documentId, objectIds, page, ruledQa, executed, warnings, phaseMs, multi } = context;
    let mark = Date.now();
    const animated = objectIds.__animated;
    if (animated && page === 0) {
      for (const [op, params] of [
        ['animation.set', { documentId, enabled: true, duration: 2400, fps: 12, loop: true }],
        ['animation.addTrack', {
          documentId,
          targetId: animated.objectId,
          property: animated.property,
          keyframes: [
            { t: 0, value: animated.from, easing: 'easeOut' },
            { t: 900, value: animated.to, easing: 'easeOut' },
            { t: 2400, value: animated.to },
          ],
        }],
      ]) {
        const response = await this.bridge.call(op, params);
        executed.push({ op, ok: true, note: 'timeline', durationMs: response.durationMs });
      }
    }
    const info = await this.bridge.call('document.info', { documentId });
    const saveMark = performance.now();
    const saved = await this.bridge.call('document.save', { documentId });
    phaseMs.save = (phaseMs.save || 0) + performance.now() - saveMark;
    const format = plan.exportFormat || 'png';
    const suffix = multi ? `-p${page + 1}` : '';
    const exportMark = performance.now();
    const exported = await this.bridge.call('export.image', {
      documentId,
      format,
      static: true,
      outPath: path.join('outputs', `${plan.planId}${suffix}.${format === 'jpeg' ? 'jpg' : format}`),
    });
    phaseMs.export = (phaseMs.export || 0) + performance.now() - exportMark;
    for (const [key, value] of Object.entries(exported.data?.timings || {})) phaseMs[key] = (phaseMs[key] || 0) + value;
    phaseMs.deliver += Date.now() - mark;
    mark = Date.now();
    let qa = null;
    try {
      const qaParams = ruledQa ? { documentId, ruled: ruledQa } : { documentId };
      // The colour layer actually used (reference swatches or the layer derived from them) is measured on the pixels.
      if (!(plan.references && plan.references.enabled === false) && plan.colors && Array.isArray(plan.colors.colors) && plan.colors.colors.length) qaParams.palette = plan.colors.colors.slice(0, 12);
      const response = await this.bridge.call('qa.check', qaParams);
      qa = response.data || null;
    } catch (error) {
      // An older drawing tool without qa.check must not break delivery; the gap is reported, not hidden.
      qa = { ok: null, skipped: true, reason: error.message };
    }
    phaseMs.qa += Date.now() - mark;
    if (qa && Array.isArray(qa.issues)) {
      for (const issue of qa.issues) {
        const who = issue.object || (issue.objects || []).join(' & ');
        warnings.push(`QA page ${page + 1}: ${issue.code}${who ? ` (${who})` : ''}: ${issue.message}${issue.ratio ? ` (ratio ${issue.ratio})` : ''}`);
      }
    }
    const verification = Pipeline.verify(plan, (info.data || {}).document, exported.data);
    const actualIds = new Set((((info.data || {}).document || {}).layers || []).flatMap((l) => l.objects || []).map((o) => o.id));
    const pageSteps = executed.filter((step) => step.page === page + 1 && /^draw\./.test(step.op));
    const expectedIds = pageSteps.flatMap((step) => step.objectId ? [step.objectId] : (step.objectIds || []));
    const absentIds = expectedIds.filter((id) => !actualIds.has(id));
    if (absentIds.length) verification.issues.push(`${absentIds.length} returned drawing objects are absent from the authoritative document`);
    const unconfirmed = pageSteps.filter((step) => step.element && !step.objectId && !(step.objectIds || []).length);
    if (unconfirmed.length) verification.issues.push(`${unconfirmed.length} element drawing operations returned no object identity`);
    verification.objectReadback = { expected: expectedIds.length, found: expectedIds.length - absentIds.length, unconfirmed: unconfirmed.length };
    const layers = ((info.data || {}).document || {}).layers || [];
    const visibleIds = new Set(layers.filter((l) => l.visible !== false && l.opacity !== 0).flatMap((l) => l.objects || []).filter((o) => o.opacity !== 0).map((o) => o.id));
    verification.elementCounts = (plan.design?.coverage || []).map((c) => {
      const confirmed = (c.instances || []).filter((id) => {
        const steps = pageSteps.filter((s) => s.element === id);
        return steps.length > 0 && steps.every((s) => (s.objectId ? [s.objectId] : (s.objectIds || [])).length > 0 && (s.objectId ? [s.objectId] : s.objectIds).every((oid) => visibleIds.has(oid)));
      });
      const missingInstances = (c.declared || []).filter((id) => !confirmed.includes(id));
      const ok = confirmed.length >= c.requestedCount && missingInstances.length === 0;
      if (!ok) verification.issues.push(`element count ${c.motif}: requested ${c.requestedCount}, confirmed ${confirmed.length}; missing instances: ${missingInstances.join(', ')}`);
      return { motif: c.motif, requested: c.requestedCount, confirmed: confirmed.length, missingInstances, ok, scope: 'object-identity-readback-not-pixel-segmentation' };
    });
    verification.ok = verification.issues.length === 0;
    const savedData = saved.data || {};
    const exportedData = exported.data || {};
    return {
      page: page + 1,
      documentId,
      document: (info.data || {}).document,
      verification,
      qa,
      saved: { path: savedData.path, bytes: savedData.bytes },
      exported: {
        path: exportedData.path,
        bytes: exportedData.bytes,
        width: exportedData.width,
        height: exportedData.height,
        format: exportedData.format,
        sha256: exportedData.sha256,
      },
    };
  }

  /**
   * مطابقة المستند الفعلي للطلب: أبعاد اللوحة والتصدير، ووجود كل نص مخطط حرفيًا.
   * يقرأ من المحرك بعد الرسم، لا من الخطة، فيكشف أي فقد أو تعديل في النص أو الأبعاد.
   */
  static verify(plan, doc, exported) {
    const issues = [];
    const canvas = (doc && doc.canvas) || {};
    if (canvas.width !== plan.canvas.width || canvas.height !== plan.canvas.height) {
      issues.push(`canvas is ${canvas.width}x${canvas.height}, requested ${plan.canvas.width}x${plan.canvas.height}`);
    }
    if (exported && (exported.width !== plan.canvas.width || exported.height !== plan.canvas.height)) {
      issues.push(`export is ${exported.width}x${exported.height}, requested ${plan.canvas.width}x${plan.canvas.height}`);
    }
    const drawn = ((doc && doc.layers) || [])
      .flatMap((layer) => layer.objects || [])
      .filter((object) => object.type === 'text')
      .map((object) => object.text);
    const expected = plan.ops.filter((step) => step.op === 'draw.text').map((step) => step.params.text);
    for (const text of expected) {
      if (!drawn.includes(text)) issues.push(`text not found verbatim in the document: ${JSON.stringify(text.slice(0, 80))}`);
    }
    return { ok: issues.length === 0, canvas: { width: canvas.width, height: canvas.height }, texts: { expected: expected.length, matched: expected.length - issues.filter((issue) => issue.startsWith('text')).length }, issues };
  }

  /**
   * Whole-run verification: per-page canvas/text checks plus, for flowed text and tables, a word-level
   * check that every input word was drawn exactly once, in order, across all pages; and element coverage.
   */
  static mergeVerification(plan, pages) {
    const first = pages[0].verification;
    const issues = [];
    pages.forEach((p) => p.verification.issues.forEach((issue) => issues.push(pages.length > 1 ? `page ${p.page}: ${issue}` : issue)));
    const out = { ok: true, scope: 'structural-checks-only', visualReview: 'not-reviewed', canvas: first.canvas, texts: first.texts, pages: pages.length, objectReadback: pages.map((p) => p.verification.objectReadback), elementCounts: pages.flatMap((p) => p.verification.elementCounts || []) };
    const objectsOf = (p) => ((p.document && p.document.layers) || []).flatMap((l) => l.objects || []);
    const flowStep = plan.ops.find((s) => s.op === 'layout.flow');
    if (flowStep) {
      const words = (s) => String(s || '').split(/\s+/).filter(Boolean);
      const expected = [];
      for (const block of flowStep.params.blocks || []) {
        if (block.type === 'table' || block.type === 'spacer') continue;
        const text = block.type === 'list' ? (block.items || []).join(' ') : `${block.text || ''}${block.colon && !/[:：]\s*$/.test(String(block.text || '')) ? ':' : ''}`;
        expected.push(...words(text));
      }
      const drawn = [];
      for (const p of pages) {
        for (const o of objectsOf(p)) if (o.type === 'text' && /^flow:b\d+:l\d+$/.test(String(o.name || ''))) drawn.push(...words(o.text));
      }
      const same = expected.length === drawn.length && expected.every((w, i) => w === drawn[i]);
      out.flowText = { expectedWords: expected.length, drawnWords: drawn.length, identicalOrder: same };
      if (!same) issues.push(`flowed text: expected ${expected.length} words, drawn ${drawn.length}${expected.length === drawn.length ? ' (order/content differs)' : ''}`);
    }
    const countRows = (prefix) => {
      const seen = new Set();
      const re = new RegExp(`^${prefix}:r(\\d+):fill$`);
      for (const p of pages) for (const o of objectsOf(p)) { const m = re.exec(String(o.name || '')); if (m) seen.add(Number(m[1])); }
      return seen.size;
    };
    const tableStep = plan.ops.find((s) => s.op === 'layout.table');
    if (tableStep) {
      const rowsExpected = (tableStep.params.rows || []).length;
      const rowsDrawn = countRows('table');
      out.table = { rowsExpected, rowsDrawn };
      if (rowsDrawn !== rowsExpected) issues.push(`table: ${rowsExpected} rows expected, ${rowsDrawn} drawn`);
    }
    if (flowStep) {
      (flowStep.params.blocks || []).forEach((block, i) => {
        if (block.type !== 'table') return;
        const rowsExpected = (block.rows || []).length;
        const rowsDrawn = countRows(`flow:b${i}:table`);
        out.flowTables = (out.flowTables || []).concat([{ block: i, rowsExpected, rowsDrawn }]);
        if (rowsDrawn !== rowsExpected) issues.push(`table in block ${i}: ${rowsExpected} rows expected, ${rowsDrawn} drawn`);
      });
    }
    // Caller-supplied headline/kicker must appear verbatim on page 1 (as one object or as flowed heading lines).
    const firstObjects = objectsOf(pages[0]).filter((o) => o.type === 'text');
    const firstText = firstObjects.map((o) => o.text).join(' ').split(/\s+/).join(' ');
    for (const field of ['headline', 'kicker']) {
      const value = plan.content && plan.content[field];
      if (!value) continue;
      const norm = String(value).split(/\s+/).filter(Boolean).join(' ');
      if (!firstObjects.some((o) => o.text === value) && !firstText.includes(norm)) issues.push(`requested ${field} not drawn: ${JSON.stringify(String(value).slice(0, 60))}`);
    }
    if (plan.design && plan.design.missing && plan.design.missing.length) {
      out.missingElements = plan.design.missing;
      issues.push(`requested elements not drawn: ${plan.design.missing.join(', ')}`);
    }
    for (const p of pages) {
      if (p.qa && (p.qa.skipped || p.qa.ok === null)) issues.push(`page ${p.page}: pixel QA not verified`);
      else if (p.qa && p.qa.ok === false) issues.push(`page ${p.page}: pixel QA reported ${(p.qa.issues || []).length} issue(s)`);
    }
    out.qa = pages.map((p) => (p.qa ? { page: p.page, ok: p.qa.ok, issues: (p.qa.issues || []).length, ruled: p.qa.ruled ? { ok: p.qa.ruled.ok, summary: p.qa.ruled.summary } : undefined } : null));
    // Reference-palette adherence measured on the rendered pixels (page 1).
    const pal = pages[0].qa && pages[0].qa.palette;
    if (pal) {
      out.paletteAdherence = Object.assign({ source: (plan.references && plan.references.palettes && plan.references.palettes[0] && plan.references.palettes[0].id) || null }, pal);
      // Pictures are judged on palette family (tints/shades/blends). This is an adherence metric: it fails the
      // run only when the caller asked for colours (palette words, a palette, a reference image). For a palette
      // the engine picked itself, a 49.3% vs 50% margin is not a structural defect (run_mw7uly5z): it is reported.
      const c = plan.requestContract && plan.requestContract.constraints;
      const asked = Boolean((c && Array.isArray(c.palette) && c.palette.length) || (plan.intent && (plan.intent.referenceImage || plan.intent.palette || plan.intent.paletteId)));
      // A caller sceneSpec with its own literal colours is not drawn from the engine-chosen reference palette, so
      // measuring it against that palette failed correct designs (blue/yellow cover vs a beige reference palette).
      const callerColours = Boolean(plan.direction && plan.direction.engine === 'caller-scenespec');
      out.paletteAdherence.requiredByRequest = asked && !callerColours;
      if (callerColours) out.paletteAdherence.note = 'caller sceneSpec colours; reference palette adherence is informational';
      if (pal.family < 0.5) {
        const message = `reference palette weakly applied: only ${Math.round(pal.family * 100)}% of pixels belong to the palette family`;
        if (asked && !callerColours) issues.push(message);
        else if (!callerColours) out.warnings = (out.warnings || []).concat([message + ' (engine-chosen palette; not a failure)']);
      }
    }
    // Ornamental structure gates (eye path, fan, curve families, hierarchy, detail density, readable overlaps).
    const ornament = plan.design && plan.design.composition && plan.design.composition.ornament;
    if (ornament && ornament.review) {
      out.ornamentReview = { subject: ornament.subject, pass: ornament.pass, ok: ornament.review.ok, score: ornament.review.score, failed: ornament.review.gates.filter((g) => !g.ok) };
      for (const g of out.ornamentReview.failed) issues.push(`ornament structure: ${g.id}=${JSON.stringify(g.value)} (${g.min !== undefined ? `min ${g.min}` : ''}${g.max !== undefined ? ` max ${g.max}` : ''}) — ${g.fix}`);
    }
    if (plan.requestContract && plan.design && ['scene','landscape','character','architecture'].includes(plan.design.type)) {
      out.requestContract = { sha256: plan.requestContract.sha256, coverage: compareContract(plan.requestContract, plan.design.coverage) };
      for (const c of out.requestContract.coverage) if (!c.ok) issues.push('original request: ' + c.motif + ' required ' + c.required + ', planned ' + c.planned);
      // Requested materials must exist as geometry (stone courses, bricks, boards), not just as a word.
      const { materialEvidence } = require('./house-geometry');
      out.requestContract.materials = [];
      for (const r of plan.requestContract.required || []) {
        if (!r.attributes || !r.attributes.material) continue;
        const ev = materialEvidence(plan.ops, r.id, r.attributes.material);
        out.requestContract.materials.push(Object.assign({ element: r.id }, ev));
        if (ev.units < 12) issues.push(`original request: ${r.id} of ${r.attributes.material} — material not drawn (${ev.units} ${r.attributes.material} units)`);
      }
      // A house that is the subject (only nature around it) must read as the subject, not a distant prop.
      const settingOnly = new Set(['house', 'garden', 'trees', 'flowers', 'grass', 'sky', 'sun', 'clouds', 'hills', 'mountains', 'path']);
      const req = plan.requestContract.required || [];
      const subject = req.find((r) => r.motif === 'house');
      if (subject && req.every((r) => settingOnly.has(r.motif)) && !(subject.attributes && subject.attributes.size === 'small')) {
        const geo = plan.ops.filter((o) => o.element === subject.id && o.params && !/shadow|light spill/.test(o.note || ''));
        let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
        for (const o of geo) {
          const q = o.params; const pts = q.points || (Number.isFinite(q.x) && Number.isFinite(q.w) ? [{ x: q.x, y: q.y }, { x: q.x + q.w, y: q.y + q.h }] : []);
          for (const pt of pts) { x0 = Math.min(x0, pt.x); y0 = Math.min(y0, pt.y); x1 = Math.max(x1, pt.x); y1 = Math.max(y1, pt.y); }
        }
        const share = x1 > x0 ? ((x1 - x0) * (y1 - y0)) / (out.canvas.width * out.canvas.height) : 0;
        out.requestContract.subject = { element: subject.id, canvasShare: Number(share.toFixed(3)), minimum: 0.06 };
        if (share < 0.06) issues.push(`original request: ${subject.id} is the subject but covers ${Math.round(share * 100)}% of the canvas (minimum 6%)`);
      }
    }
    out.issues = issues;
    out.ok = issues.length === 0;
    return out;
  }
}

module.exports = { Pipeline, resolvePlaceholders };
