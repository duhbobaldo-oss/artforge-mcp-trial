'use strict';

/* global ArtForgeCore, state, call, guarded, toast, el, num, $, render, loadDocument, findObject, layerShown,
   isGroupLayer, layerAncestors, drawLayerId, renderLog, syncProps, viewport, overlay, R */

/**
 * ArtForge editor layer (P4b): selection and transform handles, node editing, guides/grid/snapping, and the
 * Layers / Layer / Effects / Arrange / View / History panels. Every change goes through the same engine
 * operations ChatGPT uses (object.transform, path.*, layer.*, effect.*, guide.*, history.*), so the UI never
 * holds a second copy of the document logic. Loaded before app.js; app.js calls the Editor hooks.
 */
const Editor = (() => {
  const PE = () => ArtForgeCore.pathEdit;
  const HANDLE = 8; // px on screen
  const SNAP = 6; // px on screen
  const view = loadView();
  let effectTypes = null;
  let presets = [];
  let nodeSel = null; // { objectId, index }
  let snapLines = [];
  const PIXEL_TOOLS = ['pbrush', 'peraser', 'pheal'];
  const SHAPE_TOOLS = ['polygon', 'star', 'arc', 'spiral'];
  const SHAPE_DEFAULTS = { polygon: { sides: 3 }, star: { points: 5, ratio: 0.382 }, arc: { start: -90, sweep: 270, ratio: 0 }, spiral: { turns: 4 } };
  const SH = () => ArtForgeCore.shapes;
  const pixelOpts = { size: 24, hardness: 0.8, opacity: 1 };

  function loadView() {
    const fallback = { grid: false, snap: true, guides: true };
    try { return Object.assign(fallback, JSON.parse(localStorage.getItem('artforge.view') || '{}')); } catch { return fallback; }
  }
  function saveView() { try { localStorage.setItem('artforge.view', JSON.stringify(view)); } catch { /* storage unavailable */ } }

  // ------------------------------------------------------------------ geometry (document space)

  const screenPx = (px) => px / state.zoom;

  function layerMatrix(layer) {
    const m = new DOMMatrix();
    const t = (layer && layer.transform) || {};
    m.translateSelf(num(t.x, 0), num(t.y, 0));
    const rot = num(t.rotation, 0);
    const sx = t.scaleX === undefined ? 1 : num(t.scaleX, 1);
    const sy = t.scaleY === undefined ? 1 : num(t.scaleY, 1);
    if (rot || sx !== 1 || sy !== 1) {
      m.translateSelf(num(t.pivotX, 0), num(t.pivotY, 0));
      m.rotateSelf(rot);
      m.scaleSelf(sx, sy);
      m.translateSelf(-num(t.pivotX, 0), -num(t.pivotY, 0));
    }
    return m;
  }

  const measure = () => viewport.getContext('2d');

  // Object space → document space (layer transform, then the object's rotation about its box centre).
  function objectMatrix(layer, object) {
    const m = layerMatrix(layer);
    const deg = num(object.rotation, 0);
    if (!deg || object.type === 'text') return m;
    const b = R.bboxOf(Object.assign({}, object, { rotation: 0 }), measure());
    const cx = b.x + b.w / 2;
    const cy = b.y + b.h / 2;
    return m.translate(cx, cy).rotate(deg).translate(-cx, -cy);
  }

  const apply = (m, p) => { const q = m.transformPoint(new DOMPoint(p.x, p.y)); return { x: q.x, y: q.y }; };

  function docBox(layer, object) {
    const b = R.bboxOf(object, measure());
    const m = objectMatrix(layer, object);
    const pts = [[b.x, b.y], [b.x + b.w, b.y], [b.x, b.y + b.h], [b.x + b.w, b.y + b.h]].map(([x, y]) => apply(m, { x, y }));
    const xs = pts.map((p) => p.x);
    const ys = pts.map((p) => p.y);
    return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys), corners: pts };
  }

  function union(boxes) {
    if (!boxes.length) return null;
    const x0 = Math.min(...boxes.map((b) => b.x));
    const y0 = Math.min(...boxes.map((b) => b.y));
    const x1 = Math.max(...boxes.map((b) => b.x + b.w));
    const y1 = Math.max(...boxes.map((b) => b.y + b.h));
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  // A document-space vector in a layer's coordinates (its linear part only).
  function vectorToLayer(layer, dx, dy) {
    const inv = layerMatrix(layer).inverse();
    return { x: inv.a * dx + inv.c * dy, y: inv.b * dx + inv.d * dy };
  }
  const pointToLayer = (layer, p) => apply(layerMatrix(layer).inverse(), p);

  // ------------------------------------------------------------------ selection

  function selectedIds() {
    if (!state.selection) return [];
    const ids = state.selection.ids || [state.selection.objectId];
    return ids.filter((id) => findObject(id));
  }
  function setSelection(ids) {
    const valid = ids.filter((id) => findObject(id));
    state.selection = valid.length ? { objectId: valid[valid.length - 1], ids: valid } : null;
    const primary = valid.length ? findObject(valid[valid.length - 1]) : null;
    if (primary) state.selectedLayerId = primary.layer.id;
    if (!primary || primary.object.type !== 'path') nodeSel = null;
  }
  const selection = () => selectedIds().map((id) => findObject(id));
  const selectionBox = () => union(selection().map((f) => docBox(f.layer, f.object)));

  function hitTest(point) {
    if (!state.doc) return null;
    for (let li = state.doc.layers.length - 1; li >= 0; li -= 1) {
      const layer = state.doc.layers[li];
      if (!layerShown(layer) || isGroupLayer(layer)) continue;
      for (let oi = layer.objects.length - 1; oi >= 0; oi -= 1) {
        const object = layer.objects[oi];
        if (object.visible === false) continue;
        const local = apply(objectMatrix(layer, object).inverse(), point);
        const b = R.bboxOf(object, measure());
        const pad = object.type === 'line' ? screenPx(4) : 0;
        if (local.x >= b.x - pad && local.x <= b.x + b.w + pad && local.y >= b.y - pad && local.y <= b.y + b.h + pad) return { layer, object };
      }
    }
    return null;
  }

  /** True when the point is on the object's actual geometry (fill area or stroke, with a few px of tolerance). */
  function preciseHit(f, point) {
    const o = f.object;
    if (!['path', 'network', 'polygon', 'line'].includes(o.type)) return true;
    const local = apply(objectMatrix(f.layer, o).inverse(), point);
    const ctx = measure();
    const p = new Path2D();
    const segs = o.type === 'network' ? ArtForgeCore.shapes.networkEdgeSegments(o)
      : o.type === 'line' ? [{ op: 'M', x: o.x1, y: o.y1 }, { op: 'L', x: o.x2, y: o.y2 }]
        : o.type === 'polygon' ? o.points.map((q, i) => ({ op: i ? 'L' : 'M', x: q.x, y: q.y })).concat(o.closed !== false ? [{ op: 'Z' }] : [])
          : o.segments;
    for (const sgm of segs) {
      if (sgm.op === 'M') p.moveTo(sgm.x, sgm.y); else if (sgm.op === 'L') p.lineTo(sgm.x, sgm.y);
      else if (sgm.op === 'Q') p.quadraticCurveTo(sgm.cx, sgm.cy, sgm.x, sgm.y); else if (sgm.op === 'C') p.bezierCurveTo(sgm.c1x, sgm.c1y, sgm.c2x, sgm.c2y, sgm.x, sgm.y);
      else if (sgm.op === 'Z') p.closePath();
    }
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.lineWidth = Math.max(Number(o.strokeWidth) || 1, screenPx(10));
    const onStroke = ctx.isPointInStroke(p, local.x, local.y);
    let inFill = (o.type === 'path' && (o.closed || o.fill)) || o.type === 'polygon' ? ctx.isPointInPath(p, local.x, local.y) : false;
    if (o.type === 'network') {
      for (const region of o.regions || []) {
        const rp = new Path2D();
        for (const sgm of ArtForgeCore.shapes.networkRegionSegments(o, region)) {
          if (sgm.op === 'M') rp.moveTo(sgm.x, sgm.y); else if (sgm.op === 'L') rp.lineTo(sgm.x, sgm.y);
          else if (sgm.op === 'C') rp.bezierCurveTo(sgm.c1x, sgm.c1y, sgm.c2x, sgm.c2y, sgm.x, sgm.y); else if (sgm.op === 'Z') rp.closePath();
        }
        if (ctx.isPointInPath(rp, local.x, local.y)) inFill = true;
      }
    }
    ctx.restore();
    return onStroke || inFill;
  }

  // Handles of the selection box: 0..7 scale (corners and edges), 8 rotate.
  function handlePoints(box) {
    const { x, y, w, h } = box;
    return [
      [x, y], [x + w / 2, y], [x + w, y], [x + w, y + h / 2],
      [x + w, y + h], [x + w / 2, y + h], [x, y + h], [x, y + h / 2],
      [x + w / 2, y - screenPx(28)],
    ].map(([px, py]) => ({ x: px, y: py }));
  }
  function handleAt(point) {
    const box = selectionBox();
    if (!box) return -1;
    const r = screenPx(HANDLE);
    return handlePoints(box).findIndex((p) => Math.abs(p.x - point.x) <= r && Math.abs(p.y - point.y) <= r);
  }

  // ------------------------------------------------------------------ snapping

  function snapTargets(excludeIds) {
    const doc = state.doc;
    const xs = [0, doc.canvas.width / 2, doc.canvas.width];
    const ys = [0, doc.canvas.height / 2, doc.canvas.height];
    if (view.guides) for (const g of doc.canvas.guides || []) (g.orientation === 'vertical' ? xs : ys).push(g.position);
    for (const layer of doc.layers) {
      if (!layerShown(layer) || isGroupLayer(layer)) continue;
      for (const object of layer.objects) {
        if (excludeIds.includes(object.id)) continue;
        const b = docBox(layer, object);
        xs.push(b.x, b.x + b.w / 2, b.x + b.w);
        ys.push(b.y, b.y + b.h / 2, b.y + b.h);
      }
    }
    return { xs, ys };
  }

  // Best offset bringing any of `values` onto a target (or the grid), within the snap distance.
  function snapAxis(values, targets, gridSize) {
    let best = null;
    const limit = screenPx(SNAP);
    for (const v of values) {
      for (const t of targets) { const d = t - v; if (Math.abs(d) <= limit && (!best || Math.abs(d) < Math.abs(best.d))) best = { d, at: t }; }
      if (gridSize) { const t = Math.round(v / gridSize) * gridSize; const d = t - v; if (Math.abs(d) <= limit && (!best || Math.abs(d) < Math.abs(best.d))) best = { d, at: t, grid: true }; }
    }
    return best;
  }

  function snapBox(box, excludeIds) {
    snapLines = [];
    if (!view.snap || state.noSnap) return { dx: 0, dy: 0 };
    const { xs, ys } = snapTargets(excludeIds);
    const grid = view.grid && state.doc.canvas.grid ? state.doc.canvas.grid.size : 0;
    const sx = snapAxis([box.x, box.x + box.w / 2, box.x + box.w], xs, grid);
    const sy = snapAxis([box.y, box.y + box.h / 2, box.y + box.h], ys, grid);
    if (sx) snapLines.push({ v: true, at: sx.at });
    if (sy) snapLines.push({ v: false, at: sy.at });
    return { dx: sx ? sx.d : 0, dy: sy ? sy.d : 0 };
  }

  function snapPoint(p, excludeIds) {
    const r = snapBox({ x: p.x, y: p.y, w: 0, h: 0 }, excludeIds || []);
    return { x: p.x + r.dx, y: p.y + r.dy };
  }

  // ------------------------------------------------------------------ local preview helpers

  function translateLocal(o, dx, dy) {
    const out = JSON.parse(JSON.stringify(o));
    const seg = (s) => { ['x', 'cx', 'c1x', 'c2x'].forEach((k) => { if (s[k] !== undefined) s[k] += dx; }); ['y', 'cy', 'c1y', 'c2y'].forEach((k) => { if (s[k] !== undefined) s[k] += dy; }); };
    if (out.points) out.points.forEach((p) => { p.x += dx; p.y += dy; });
    if (out.segments) out.segments.forEach(seg);
    if (out.x1 !== undefined) { out.x1 += dx; out.y1 += dy; out.x2 += dx; out.y2 += dy; }
    if (out.x !== undefined || (!out.points && !out.segments && out.x1 === undefined)) { out.x = num(out.x, 0) + dx; out.y = num(out.y, 0) + dy; }
    if (out.clip) { if (out.clip.segments) out.clip.segments.forEach(seg); if (out.clip.x !== undefined) { out.clip.x += dx; out.clip.y += dy; } }
    return out;
  }

  // A copy of the document with some objects replaced (live preview while dragging).
  function previewWith(replacements) {
    const doc = Object.assign({}, state.doc, {
      layers: state.doc.layers.map((layer) => Object.assign({}, layer, {
        objects: layer.objects.map((o) => replacements[o.id] || o),
      })),
    });
    state.previewDocOverride = doc;
    render();
  }

  // ------------------------------------------------------------------ commits

  // object.transform per layer (deltas and pivots converted into each layer's coordinates), one atomic batch.
  async function commitTransform(ids, build) {
    const groups = new Map();
    for (const id of ids) {
      const f = findObject(id);
      if (!f) continue;
      if (!groups.has(f.layer.id)) groups.set(f.layer.id, { layer: f.layer, ids: [] });
      groups.get(f.layer.id).ids.push(id);
    }
    const ops = [...groups.values()].map((g) => ({ op: 'object.transform', params: Object.assign({ documentId: state.docId, objectIds: g.ids }, build(g.layer)) }));
    await guarded(async () => {
      await call('batch', { atomic: true, ops });
      await loadDocument(state.docId);
    });
  }

  // ------------------------------------------------------------------ pointer: select tool

  function pointerDownSelect(event, point) {
    // Guides first (thin targets).
    if (view.guides) {
      const g = (state.doc.canvas.guides || []).find((gd) => Math.abs((gd.orientation === 'vertical' ? point.x : point.y) - gd.position) <= screenPx(4));
      if (g && !hitHandle(point)) { state.drag = { mode: 'guide', guide: g, start: point }; return true; }
    }
    const handle = selectedIds().length ? handleAt(point) : -1;
    if (handle >= 0) {
      const box = selectionBox();
      state.drag = { mode: handle === 8 ? 'rotate' : 'scale', handle, box, start: point, ids: selectedIds(), shift: event.shiftKey };
      return true;
    }
    const hit = hitTest(point);
    const ids = selectedIds();
    if (hit) {
      let next = ids;
      if (event.shiftKey) next = ids.includes(hit.object.id) ? ids.filter((id) => id !== hit.object.id) : ids.concat([hit.object.id]);
      else if (!ids.includes(hit.object.id)) next = [hit.object.id];
      setSelection(next);
      if (next.includes(hit.object.id)) {
        state.drag = { mode: 'move-many', start: point, ids: selectedIds(), box: selectionBox(), originals: Object.fromEntries(selection().map((f) => [f.object.id, f])) };
      }
    } else {
      if (!event.shiftKey) setSelection([]);
      state.drag = { mode: 'marquee', start: point, base: event.shiftKey ? ids : [] };
    }
    afterSelectionChange();
    return true;
  }
  const hitHandle = (point) => selectedIds().length && handleAt(point) >= 0;

  function afterSelectionChange() {
    renderShape();
    renderLayers();
    syncProps();
    renderArrange();
    drawOverlay();
  }

  function pointerMoveSelect(point, event) {
    const drag = state.drag;
    if (drag.mode === 'guide') {
      drag.position = drag.guide.orientation === 'vertical' ? point.x : point.y;
      drawOverlay();
      return true;
    }
    if (drag.mode === 'marquee') {
      drag.current = point;
      drawOverlay();
      return true;
    }
    if (drag.mode === 'move-many') {
      let dx = point.x - drag.start.x;
      let dy = point.y - drag.start.y;
      if (event.shiftKey || drag.shift) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
      const s = snapBox({ x: drag.box.x + dx, y: drag.box.y + dy, w: drag.box.w, h: drag.box.h }, drag.ids);
      dx += s.dx; dy += s.dy;
      drag.delta = { dx, dy };
      const replacements = {};
      for (const id of drag.ids) {
        const f = drag.originals[id];
        const v = vectorToLayer(f.layer, dx, dy);
        replacements[id] = translateLocal(f.object, v.x, v.y);
      }
      previewWith(replacements);
      return true;
    }
    if (drag.mode === 'scale') {
      const b = drag.box;
      const left = [0, 6, 7].includes(drag.handle);
      const right = [2, 3, 4].includes(drag.handle);
      const top = [0, 1, 2].includes(drag.handle);
      const bottom = [4, 5, 6].includes(drag.handle);
      const p = snapPoint(point, drag.ids);
      const pivot = { x: left ? b.x + b.w : right ? b.x : b.x + b.w / 2, y: top ? b.y + b.h : bottom ? b.y : b.y + b.h / 2 };
      if (event.altKey) { pivot.x = b.x + b.w / 2; pivot.y = b.y + b.h / 2; }
      let sx = left || right ? Math.max(0.01, Math.abs(p.x - pivot.x) / Math.max(1e-6, Math.abs((left ? b.x : b.x + b.w) - pivot.x))) : 1;
      let sy = top || bottom ? Math.max(0.01, Math.abs(p.y - pivot.y) / Math.max(1e-6, Math.abs((top ? b.y : b.y + b.h) - pivot.y))) : 1;
      if (event.shiftKey || drag.shift || [0, 2, 4, 6].includes(drag.handle) && !event.ctrlKey) {
        // Corners keep proportions (Ctrl frees them); Shift forces it on edges too.
        const s = (left || right) && (top || bottom) ? Math.max(sx, sy) : (left || right ? sx : sy);
        sx = s; sy = s;
      }
      drag.result = { sx, sy, pivot };
      drawOverlay();
      return true;
    }
    if (drag.mode === 'rotate') {
      const b = drag.box;
      const c = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
      let deg = (Math.atan2(point.y - c.y, point.x - c.x) - Math.atan2(drag.start.y - c.y, drag.start.x - c.x)) * 180 / Math.PI;
      deg = ((deg % 360) + 540) % 360 - 180; // shortest turn: −180..180, never +270 for a −90 drag
      if (event.shiftKey || drag.shift) deg = Math.round(deg / 15) * 15;
      drag.result = { deg, pivot: c };
      drawOverlay();
      return true;
    }
    return false;
  }

  async function pointerUpSelect(point) {
    const drag = state.drag;
    state.drag = null;
    state.previewDocOverride = null;
    snapLines = [];
    if (drag.mode === 'guide') {
      if (drag.position === undefined) { drawOverlay(); return true; }
      const outside = drag.position < 0 || drag.position > (drag.guide.orientation === 'vertical' ? state.doc.canvas.width : state.doc.canvas.height);
      await guarded(async () => {
        if (outside) await call('guide.remove', { documentId: state.docId, guideId: drag.guide.id });
        else await call('guide.update', { documentId: state.docId, guideId: drag.guide.id, position: Math.round(drag.position * 100) / 100 });
        await loadDocument(state.docId);
      });
      return true;
    }
    if (drag.mode === 'marquee') {
      const a = drag.start;
      const b = drag.current || drag.start;
      const r = { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) };
      if (r.w > 2 || r.h > 2) {
        const hits = [];
        for (const layer of state.doc.layers) {
          if (!layerShown(layer) || isGroupLayer(layer) || layer.locked) continue;
          for (const o of layer.objects) {
            const d = docBox(layer, o);
            if (d.x < r.x + r.w && d.x + d.w > r.x && d.y < r.y + r.h && d.y + d.h > r.y) hits.push(o.id);
          }
        }
        setSelection([...new Set(drag.base.concat(hits))]);
      }
      afterSelectionChange();
      return true;
    }
    if (drag.mode === 'move-many') {
      const d = drag.delta;
      if (!d || (Math.abs(d.dx) < 0.5 && Math.abs(d.dy) < 0.5)) { render(); return true; }
      await commitTransform(drag.ids, (layer) => { const v = vectorToLayer(layer, d.dx, d.dy); return { dx: v.x, dy: v.y }; });
      return true;
    }
    if (drag.mode === 'scale' && drag.result) {
      const { sx, sy, pivot } = drag.result;
      await commitTransform(drag.ids, (layer) => ({ scaleX: sx, scaleY: sy, pivot: pointToLayer(layer, pivot) }));
      return true;
    }
    if (drag.mode === 'rotate' && drag.result && Math.abs(drag.result.deg) > 0.05) {
      const { deg, pivot } = drag.result;
      await commitTransform(drag.ids, (layer) => ({ rotation: deg, pivot: pointToLayer(layer, pivot) }));
      return true;
    }
    drawOverlay();
    return true;
  }

  // ------------------------------------------------------------------ pointer: node tool

  function nodeTarget() {
    const f = state.selection ? findObject(state.selection.objectId) : null;
    return f && f.object.type === 'path' ? f : null;
  }

  function nodeHits(f, point) {
    const m = objectMatrix(f.layer, f.object);
    const anchors = PE().listAnchors(f.object.segments);
    const r = screenPx(HANDLE);
    for (const a of anchors) {
      for (const kind of ['in', 'out']) {
        if (a[kind] && nodeSel && nodeSel.index === a.index) {
          const p = apply(m, a[kind]);
          if (Math.hypot(p.x - point.x, p.y - point.y) <= r) return { kind, anchor: a };
        }
      }
    }
    for (const a of anchors) {
      const p = apply(m, a);
      if (Math.hypot(p.x - point.x, p.y - point.y) <= r) return { kind: 'anchor', anchor: a };
    }
    return null;
  }

  // Nearest point on the path (segment index + t) for inserting an anchor.
  function nearestOnPath(f, point) {
    const local = apply(objectMatrix(f.layer, f.object).inverse(), point);
    const segs = f.object.segments;
    let best = null;
    let prev = null;
    let start = null;
    segs.forEach((s, i) => {
      if (s.op === 'M') { prev = s; start = s; return; }
      const end = s.op === 'Z' ? start : s;
      if (!prev || !end) return;
      for (let k = 1; k < 24; k += 1) {
        const t = k / 24;
        let p;
        if (s.op === 'C') { const u = 1 - t; p = { x: u * u * u * prev.x + 3 * u * u * t * s.c1x + 3 * u * t * t * s.c2x + t * t * t * s.x, y: u * u * u * prev.y + 3 * u * u * t * s.c1y + 3 * u * t * t * s.c2y + t * t * t * s.y }; }
        else if (s.op === 'Q') { const u = 1 - t; p = { x: u * u * prev.x + 2 * u * t * s.cx + t * t * s.x, y: u * u * prev.y + 2 * u * t * s.cy + t * t * s.y }; }
        else p = { x: prev.x + (end.x - prev.x) * t, y: prev.y + (end.y - prev.y) * t };
        const d = Math.hypot(p.x - local.x, p.y - local.y);
        if (!best || d < best.d) best = { d, segment: i, t };
      }
      prev = s.op === 'Z' ? start : s;
    });
    return best && best.d <= screenPx(8) ? best : null;
  }

  // pointerdown carries no click count (event.detail is 0 in Chrome), so detect double presses here.
  let lastPress = { t: 0, x: 0, y: 0 };
  function isDoublePress(event) {
    const now = performance.now();
    const double = now - lastPress.t < 400 && Math.hypot(event.clientX - lastPress.x, event.clientY - lastPress.y) < 6;
    lastPress = double ? { t: 0, x: 0, y: 0 } : { t: now, x: event.clientX, y: event.clientY };
    return double;
  }

  function pointerDownNode(event, point) {
    const double = isDoublePress(event);
    const nf = networkTarget();
    if (nf) {
      const index = networkHit(nf, point);
      if (index >= 0) {
        state.drag = { mode: 'netnode', f: nf, index, start: point, inv: objectMatrix(nf.layer, nf.object).inverse() };
        return true;
      }
    }
    let f = nodeTarget();
    const hit = f ? nodeHits(f, point) : null;
    if (hit) {
      if (hit.kind === 'anchor' && event.altKey) {
        guarded(async () => {
          await call('path.convertAnchor', { documentId: state.docId, objectId: f.object.id, index: hit.anchor.index, type: hit.anchor.type === 'smooth' ? 'corner' : 'smooth' });
          await loadDocument(state.docId);
        });
        return true;
      }
      nodeSel = { objectId: f.object.id, index: hit.anchor.index };
      state.drag = { mode: 'node', kind: hit.kind, f, index: hit.anchor.index, start: point };
      drawOverlay();
      return true;
    }
    if (f && double) {
      const near = nearestOnPath(f, point);
      if (near) {
        guarded(async () => {
          await call('path.addAnchor', { documentId: state.docId, objectId: f.object.id, segment: near.segment, t: near.t });
          await loadDocument(state.docId);
        });
        return true;
      }
    }
    const other = hitTest(point);
    if (other) {
      setSelection([other.object.id]);
      nodeSel = null;
      f = nodeTarget();
      if (!f && !networkTarget()) toast('تحرير النقاط يعمل على المسارات والشبكات: استخدم «تحويل إلى مسار» من لوحة الترتيب');
    } else {
      setSelection([]);
    }
    afterSelectionChange();
    return true;
  }

  function nodeChange(drag, point, event) {
    const local = apply(objectMatrix(drag.f.layer, drag.f.object).inverse(), view.snap ? snapPoint(point, [drag.f.object.id]) : point);
    if (drag.kind === 'anchor') return { x: local.x, y: local.y };
    return { [drag.kind]: local, keepSmooth: !event.altKey };
  }

  function pointerMoveNode(point, event) {
    const drag = state.drag;
    drag.change = nodeChange(drag, point, event);
    try {
      const segments = PE().updateAnchor(drag.f.object.segments, drag.index, drag.change);
      previewWith({ [drag.f.object.id]: Object.assign({}, drag.f.object, { segments }) });
    } catch (error) { /* invalid intermediate state: keep the last preview */ }
    return true;
  }

  async function pointerUpNode() {
    const drag = state.drag;
    state.drag = null;
    state.previewDocOverride = null;
    snapLines = [];
    if (!drag.change) { drawOverlay(); return true; }
    await guarded(async () => {
      await call('path.updateAnchor', Object.assign({ documentId: state.docId, objectId: drag.f.object.id, index: drag.index }, drag.change));
      await loadDocument(state.docId);
    });
    return true;
  }

  // ------------------------------------------------------------------ hooks for app.js

  // ------------------------------------------------------------------ pixel tools (raster.paint / raster.spotHeal)

  function pointerDownPixel(point) {
    const layer = selectedLayer();
    if (!layer || !layer.raster) { toast('اختر طبقة بكسل، أو أنشئ واحدة بزر ▦+ في لوحة الطبقات', true); return true; }
    state.drag = { mode: 'pixel', tool: state.tool, layerId: layer.id, points: [point] };
    drawOverlay();
    return true;
  }
  function pointerMovePixel(point) {
    const pts = state.drag.points;
    const last = pts[pts.length - 1];
    if (Math.hypot(point.x - last.x, point.y - last.y) >= Math.max(1, pixelOpts.size / 6)) pts.push(point);
    drawOverlay();
    return true;
  }
  async function pointerUpPixel() {
    const drag = state.drag;
    state.drag = null;
    const pts = drag.points.map((p) => ({ x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10 }));
    await guarded(async () => {
      if (drag.tool === 'pheal') {
        // One heal per dab along the drag (spaced by the brush size), as the spot healing brush does.
        const spots = [pts[0]];
        for (const p of pts) { const s = spots[spots.length - 1]; if (Math.hypot(p.x - s.x, p.y - s.y) >= pixelOpts.size * 0.6) spots.push(p); }
        await call('raster.spotHeal', { documentId: state.docId, layerId: drag.layerId, points: spots.slice(0, 200), size: pixelOpts.size });
      } else {
        await call('raster.paint', { documentId: state.docId, layerId: drag.layerId, tool: drag.tool === 'peraser' ? 'eraser' : 'brush',
          points: pts, size: pixelOpts.size, hardness: pixelOpts.hardness, opacity: pixelOpts.opacity, color: ($('propFill') && $('propFill').value.trim()) || '#000000' });
      }
      await loadDocument(state.docId);
    });
    drawOverlay();
    return true;
  }

  // ------------------------------------------------------------------ pen tool (P): paths and vector networks
  // Click: corner vertex. Click-drag: smooth vertex with mirrored handles (Alt: break the mirror). Click an
  // existing vertex: connect to it and continue from there, so several edges can branch from one vertex (a
  // vector network). Click the first vertex of a simple chain: close it. Enter/Esc: finish. Backspace: undo the
  // last vertex. With a network selected, clicking one of its vertices extends that network.
  // A simple chain or loop is saved as a normal path; anything that branches is saved as a network.
  const near = (a, b, px) => Math.hypot(a.x - b.x, a.y - b.y) <= screenPx(px);
  const NET = () => ArtForgeCore.shapes;
  function networkTarget() {
    const f = state.selection ? findObject(state.selection.objectId) : null;
    return f && f.object.type === 'network' ? f : null;
  }
  function penVertexAt(point) {
    const pen = state.pen;
    if (!pen) return -1;
    for (let i = pen.pts.length - 1; i >= 0; i -= 1) if (near(point, pen.pts[i], 8)) return i;
    return -1;
  }
  function startPenFromNetwork(f, point) {
    const m = objectMatrix(f.layer, f.object);
    const verts = f.object.points.map((q, i) => ({ q, i })).filter((v) => !v.q.ctrl);
    const hit = verts.find((v) => near(point, apply(m, v.q), 8));
    if (!hit) return false;
    state.pen = { pts: verts.map((v) => Object.assign(apply(m, v.q), { in: null, out: null, baseIndex: v.i })), edges: [], current: null, base: f };
    state.pen.current = state.pen.pts.findIndex((q) => q.baseIndex === hit.i);
    return true;
  }
  const hasEdge = (pen, a, b) => pen.edges.some((e) => (e.a === a && e.b === b) || (e.a === b && e.b === a));
  function isSimpleChain(pen) {
    return !pen.base && pen.edges.every((e, i) => e.a === i && e.b === i + 1) && pen.edges.length === pen.pts.length - 1;
  }
  function pointerDownPen(event, point) {
    if (!state.pen) {
      const nf = networkTarget();
      if (!(nf && startPenFromNetwork(nf, point))) state.pen = { pts: [], edges: [], current: null };
      if (state.pen.base) { state.pen.hover = point; drawOverlay(); return true; }
    }
    const pen = state.pen;
    const hit = penVertexAt(point);
    if (hit === 0 && pen.pts.length >= 3 && pen.current === pen.pts.length - 1 && isSimpleChain(pen)) {
      pen.edges.push({ a: pen.current, b: 0 });
      finishPen(true);
      return true;
    }
    if (hit >= 0) {
      if (pen.current !== null && hit !== pen.current && !hasEdge(pen, pen.current, hit)) pen.edges.push({ a: pen.current, b: hit });
      pen.current = hit;
      state.drag = { mode: 'pen', anchor: pen.pts[hit], start: point };
    } else {
      pen.pts.push({ x: point.x, y: point.y, in: null, out: null });
      const v = pen.pts.length - 1;
      if (pen.current !== null) pen.edges.push({ a: pen.current, b: v });
      pen.current = v;
      state.drag = { mode: 'pen', anchor: pen.pts[v], start: point };
    }
    drawOverlay();
    return true;
  }
  function pointerMovePen(point, event) {
    const a = state.drag.anchor;
    if (!near(point, a, 2)) {
      a.out = { x: point.x, y: point.y };
      if (!event.altKey) a.in = { x: 2 * a.x - point.x, y: 2 * a.y - point.y };
    }
    state.pen.hover = point;
    drawOverlay();
    return true;
  }
  const r2 = (v) => Math.round(v * 100) / 100;
  // Segments of a simple chain (used for previews and for saving as a path).
  function penSegments(pts, edges) {
    const segs = [];
    edges.forEach((e, i) => {
      const p = pts[e.a]; const q = pts[e.b];
      if (i === 0 || edges[i - 1].b !== e.a) segs.push({ op: 'M', x: r2(p.x), y: r2(p.y) });
      segs.push(p.out || q.in ? { op: 'C', c1x: r2((p.out || p).x), c1y: r2((p.out || p).y), c2x: r2((q.in || q).x), c2y: r2((q.in || q).y), x: r2(q.x), y: r2(q.y) } : { op: 'L', x: r2(q.x), y: r2(q.y) });
    });
    return segs;
  }
  async function finishPen(closed) {
    const pen = state.pen;
    state.pen = null;
    state.drag = null;
    if (!pen || !pen.edges.length) { drawOverlay(); return; }
    await guarded(async () => {
      let objectId;
      if (isSimpleChain(pen) || (closed && !pen.base)) {
        const segs = penSegments(pen.pts, pen.edges);
        if (closed) segs.push({ op: 'Z' });
        objectId = (await call('draw.path', { documentId: state.docId, layerId: drawLayerId(), segments: segs, closed: Boolean(closed),
          stroke: currentFill(), strokeWidth: 2, fill: null, lineJoin: 'round', lineCap: 'round', name: closed ? 'vector (closed)' : 'vector' })).objectId;
      } else {
        // Network: vertices first, then one handle point per curved edge end.
        const base = pen.base ? pen.base.object : null;
        const inv = pen.base ? objectMatrix(pen.base.layer, base).inverse() : null;
        const local = (q) => (inv ? apply(inv, q) : { x: q.x, y: q.y });
        const points = base ? base.points.map((q) => Object.assign({}, q)) : [];
        const indexOf = pen.pts.map((q) => {
          if (q.baseIndex !== undefined) return q.baseIndex;
          const l = local(q); points.push({ x: r2(l.x), y: r2(l.y) }); return points.length - 1;
        });
        const handle = (h) => { const l = local(h); points.push({ x: r2(l.x), y: r2(l.y), ctrl: true }); return points.length - 1; };
        const edges = base ? base.edges.map((e) => Object.assign({}, e)) : [];
        for (const e of pen.edges) {
          const p = pen.pts[e.a]; const q = pen.pts[e.b];
          const edge = { a: indexOf[e.a], b: indexOf[e.b] };
          if (p.out) edge.c1 = handle(p.out);
          if (q.in) edge.c2 = handle(q.in);
          edges.push(edge);
        }
        if (base) {
          await call('object.update', { documentId: state.docId, objectId: base.id, patch: { points, edges } });
          objectId = base.id;
        } else {
          objectId = (await call('draw.network', { documentId: state.docId, layerId: drawLayerId(), points, edges, stroke: currentFill(), strokeWidth: 2, name: 'vector network' })).objectId;
        }
      }
      await loadDocument(state.docId);
      selectDrawn(objectId);
    });
  }

  // ------------------------------------------------------------------ network vertices (node tool, A)
  function networkHit(f, point) {
    const m = objectMatrix(f.layer, f.object);
    const pts = f.object.points;
    // Handles first (they sit on top of vertices when short).
    for (const ctrlFirst of [true, false]) {
      for (let i = pts.length - 1; i >= 0; i -= 1) if (Boolean(pts[i].ctrl) === ctrlFirst && near(point, apply(m, pts[i]), HANDLE)) return i;
    }
    return -1;
  }
  function movedNetworkPoints(f, index, dx, dy) {
    const pts = f.object.points.map((q) => Object.assign({}, q));
    const shift = (i) => { pts[i].x = r2(pts[i].x + dx); pts[i].y = r2(pts[i].y + dy); };
    shift(index);
    if (!pts[index].ctrl) for (const e of f.object.edges) { if (e.a === index && e.c1 !== undefined) shift(e.c1); if (e.b === index && e.c2 !== undefined) shift(e.c2); }
    return pts;
  }

  // ------------------------------------------------------------------ arc handles (start, end, inner radius) on the canvas
  function arcTarget() {
    const ids = selectedIds();
    if (ids.length !== 1) return null;
    const f = findObject(ids[0]);
    if (!f) return null;
    if (f.object.type === 'ellipse') return { f, spec: { kind: 'arc', box: { x: f.object.x, y: f.object.y, w: f.object.w, h: f.object.h }, start: 0, sweep: 360, ratio: 0 }, convert: true };
    if (f.object.type === 'path' && f.object.shape && f.object.shape.kind === 'arc') {
      const sh = f.object.shape;
      const was = SH().segmentsBox(SH().shapeSegments(sh)); const now = SH().segmentsBox(f.object.segments);
      let box = sh.box;
      if (was && now && was.w > 0 && was.h > 0) { const sx = now.w / was.w; const sy = now.h / was.h; box = { x: now.x + (sh.box.x - was.x) * sx, y: now.y + (sh.box.y - was.y) * sy, w: sh.box.w * sx, h: sh.box.h * sy }; }
      return { f, spec: Object.assign({}, sh, { box }), convert: false };
    }
    return null;
  }
  function arcHandles(t) {
    const { box, start, sweep, ratio } = t.spec;
    const cx = box.x + box.w / 2; const cy = box.y + box.h / 2; const rx = box.w / 2; const ry = box.h / 2;
    const at = (deg, k) => ({ x: cx + rx * k * Math.cos(deg * Math.PI / 180), y: cy + ry * k * Math.sin(deg * Math.PI / 180) });
    const m = objectMatrix(t.f.layer, t.f.object);
    return { start: apply(m, at(start, 1)), end: apply(m, at(start + sweep, 1)), ratio: apply(m, ratio > 0 ? at(start + sweep / 2, ratio) : { x: cx, y: cy }), cx, cy, rx, ry, m };
  }
  function arcDragSpec(drag, point) {
    const t = drag.t; const h = arcHandles(t);
    const l = apply(h.m.inverse(), point);
    const nx = (l.x - h.cx) / (h.rx || 1); const ny = (l.y - h.cy) / (h.ry || 1);
    const angle = Math.atan2(ny, nx) * 180 / Math.PI;
    const spec = Object.assign({}, t.spec);
    const norm = (v) => ((v % 360) + 360) % 360;
    if (drag.which === 'start') { const end = t.spec.start + t.spec.sweep; spec.start = Math.round(angle); spec.sweep = norm(end - spec.start) || 360; }
    else if (drag.which === 'end') { const sw = norm(angle - t.spec.start); spec.sweep = Math.round(sw < 1 ? 360 : sw); }
    else spec.ratio = Math.round(Math.min(0.99, Math.max(0, Math.hypot(nx, ny))) * 100) / 100;
    return spec;
  }

  // ------------------------------------------------------------------ shape tools  // ------------------------------------------------------------------ shape tools (polygon, star, arc, spiral)
  function shapeBox(start, point, event) {
    let w = point.x - start.x; let h = point.y - start.y;
    if (event && event.shiftKey) { const m = Math.max(Math.abs(w), Math.abs(h)); w = Math.sign(w || 1) * m; h = Math.sign(h || 1) * m; }
    return { x: Math.min(start.x, start.x + w), y: Math.min(start.y, start.y + h), w: Math.abs(w), h: Math.abs(h) };
  }
  function pointerDownShape(event, point) {
    state.drag = { mode: 'shape', kind: state.tool, start: point, box: { x: point.x, y: point.y, w: 0, h: 0 } };
    return true;
  }
  async function pointerUpShape() {
    const drag = state.drag;
    state.drag = null;
    if (drag.box.w < 4 || drag.box.h < 4) { drawOverlay(); return true; }
    const kind = drag.kind;
    const params = Object.assign({ documentId: state.docId, layerId: drawLayerId(), kind }, drag.box, SHAPE_DEFAULTS[kind]);
    if (kind === 'spiral') Object.assign(params, { stroke: currentFill(), strokeWidth: 3 }); else params.fill = currentFill();
    await guarded(async () => {
      const data = await call('draw.shape', params);
      await loadDocument(state.docId);
      selectDrawn(data.objectId);
    });
    return true;
  }

  // ------------------------------------------------------------------ vector paint bucket
  async function pointerDownBucket(point) {
    const hit = hitTest(point);
    if (hit && hit.object.type === 'network') {
      const l = apply(objectMatrix(hit.layer, hit.object).inverse(), point);
      if (NET().networkFaceAt(hit.object, l.x, l.y)) {
        await guarded(async () => {
          await call('network.fill', { documentId: state.docId, objectId: hit.object.id, x: l.x, y: l.y, fill: currentFill() });
          await loadDocument(state.docId);
          toast('مُلئت منطقة في الشبكة');
        });
        return true;
      }
    }
    await guarded(async () => {
      try {
        await call('vector.fill', { documentId: state.docId, layerId: drawLayerId(), x: point.x, y: point.y, fill: currentFill() });
      } catch (error) {
        const code = error.code || String(error.message || '').split(':')[0];
        if (code === 'REGION_NOT_CLOSED') { toast('المنطقة غير مغلقة: أغلق الشكل بالخطوط أولًا ثم املأه', true); return; }
        if (code === 'NOT_EMPTY') { toast('انقر داخل مساحة فارغة محاطة بخطوط أو أشكال', true); return; }
        throw error;
      }
      await loadDocument(state.docId);
      toast('مُلئت المنطقة المغلقة');
    });
    return true;
  }

  function finishToolSession() { if (state.pen) return finishPen(false); return null; }

  function pointerDown(event) {
    if (!state.doc) return false;
    const point = canvasPointOf(event);
    if (state.tool === 'pen') return pointerDownPen(event, point);
    if (state.tool === 'select') {
      // Arc handles of the selected ellipse/arc come before the box handles.
      const t = arcTarget();
      if (t) {
        const h = arcHandles(t);
        const which = ['start', 'end', 'ratio'].find((k) => near(point, h[k], HANDLE));
        if (which) { state.drag = { mode: 'arc', t, which, start: point, spec: t.spec }; return true; }
      }
    }
    if (SHAPE_TOOLS.includes(state.tool)) {
      if (selectedIds().length && handleAt(point) >= 0) { window.setTool('select'); return pointerDownSelect(event, point); }
      return pointerDownShape(event, point);
    }
    if (state.tool === 'vbucket') { pointerDownBucket(point); return true; }
    if (state.tool === 'select') return pointerDownSelect(event, point);
    // Handles that are drawn must work whatever tool is active: pressing a handle of the current selection, or
    // the body of a selected shape (with a shape tool), switches to Select and moves/scales/rotates it.
    if (state.tool !== 'node' && !PIXEL_TOOLS.includes(state.tool) && selectedIds().length) {
      const onHandle = handleAt(point) >= 0;
      const hit = !onHandle && !['freehand', 'image'].includes(state.tool) ? hitTest(point) : null;
      // The body counts only where the shape really is (its fill or stroke), not anywhere in its bounding box:
      // empty space inside a large network's box must still let the tool draw.
      if (onHandle || (hit && selectedIds().includes(hit.object.id) && preciseHit(hit, point))) {
        window.setTool('select');
        return pointerDownSelect(event, point);
      }
    }
    if (state.tool === 'node') return pointerDownNode(event, point);
    if (PIXEL_TOOLS.includes(state.tool)) return pointerDownPixel(point);
    return false;
  }
  function pointerMove(event) {
    if (state.doc && state.tool === 'pen' && state.pen && !state.drag) { state.pen.hover = canvasPointOf(event); drawOverlay(); return true; }
    if (!state.doc || !state.drag) return false;
    const point = canvasPointOf(event);
    if (state.drag.mode === 'pen') return pointerMovePen(point, event);
    if (state.drag.mode === 'arc') {
      const spec = arcDragSpec(state.drag, point);
      state.drag.spec = spec;
      const o = state.drag.t.f.object;
      previewWith({ [o.id]: Object.assign({}, o, { type: 'path', shape: spec, segments: SH().shapeSegments(SH().normalizeShapeSpec(spec)), closed: true }) });
      return true;
    }
    if (state.drag.mode === 'netnode') {
      const l0 = apply(state.drag.inv, state.drag.start); const l1 = apply(state.drag.inv, point);
      const pts = movedNetworkPoints(state.drag.f, state.drag.index, l1.x - l0.x, l1.y - l0.y);
      state.drag.points = pts;
      previewWith({ [state.drag.f.object.id]: Object.assign({}, state.drag.f.object, { points: pts }) });
      return true;
    }
    if (state.drag.mode === 'shape') { state.drag.box = shapeBox(state.drag.start, point, event); drawOverlay(); return true; }
    if (state.drag.mode === 'pixel') return pointerMovePixel(point);
    if (state.drag.mode === 'node') return pointerMoveNode(point, event);
    if (['guide', 'marquee', 'move-many', 'scale', 'rotate'].includes(state.drag.mode)) return pointerMoveSelect(point, event);
    return false;
  }
  async function pointerUp(event) {
    if (!state.doc || !state.drag) return false;
    const point = canvasPointOf(event);
    if (state.drag.mode === 'pixel') return pointerUpPixel();
    if (state.drag.mode === 'pen') { state.drag = null; drawOverlay(); return true; }
    if (state.drag.mode === 'arc') {
      const drag = state.drag; state.drag = null; state.previewDocOverride = null;
      const { start, sweep, ratio } = drag.spec;
      await guarded(async () => {
        if (drag.t.convert) await call('shape.convert', { documentId: state.docId, objectId: drag.t.f.object.id, start, sweep, ratio });
        else await call('shape.update', { documentId: state.docId, objectId: drag.t.f.object.id, params: { start, sweep, ratio } });
        await loadDocument(state.docId);
      });
      return true;
    }
    if (state.drag.mode === 'netnode') {
      const drag = state.drag; state.drag = null; state.previewDocOverride = null;
      if (drag.points) await guarded(async () => { await call('object.update', { documentId: state.docId, objectId: drag.f.object.id, patch: { points: drag.points } }); await loadDocument(state.docId); });
      drawOverlay();
      return true;
    }
    if (state.drag.mode === 'shape') return pointerUpShape();
    if (state.drag.mode === 'node') return pointerUpNode(point);
    if (['guide', 'marquee', 'move-many', 'scale', 'rotate'].includes(state.drag.mode)) return pointerUpSelect(point);
    return false;
  }
  function canvasPointOf(event) {
    const rect = viewport.getBoundingClientRect();
    return { x: (event.clientX - rect.left) / state.zoom, y: (event.clientY - rect.top) / state.zoom };
  }

  function keydown(event) {
    const key = event.key.toLowerCase();
    if (state.pen) {
      if (key === 'enter' || key === 'escape') { event.preventDefault(); finishPen(false); return true; }
      if (key === 'backspace' || key === 'delete') {
        event.preventDefault();
        const pen = state.pen;
        const last = pen.pts.length - 1;
        if (last >= 0 && pen.pts[last].baseIndex === undefined) { pen.pts.pop(); pen.edges = pen.edges.filter((e) => e.a !== last && e.b !== last); }
        else pen.edges.pop();
        pen.current = pen.edges.length ? pen.edges[pen.edges.length - 1].b : (pen.pts.length ? pen.pts.length - 1 : null);
        if (!pen.pts.length) state.pen = null;
        drawOverlay();
        return true;
      }
    }
    if (!event.ctrlKey && key === 'p') { window.setTool(event.shiftKey ? 'freehand' : 'pen'); return true; }
    if (!event.ctrlKey && key === 'b') { window.setTool('pbrush'); return true; }
    if (!event.ctrlKey && key === 'e') { window.setTool('peraser'); return true; }
    if (!event.ctrlKey && key === 'j') { window.setTool('pheal'); return true; }
    if (PIXEL_TOOLS.includes(state.tool) && (key === '[' || key === ']')) {
      pixelOpts.size = Math.max(1, Math.min(400, Math.round(pixelOpts.size * (key === ']' ? 1.25 : 0.8))));
      toast(`حجم الفرشاة: ${pixelOpts.size}`);
      renderLayerProps();
      return true;
    }
    if (key === 'a' && !event.ctrlKey) { window.setTool('node'); return true; }
    if (event.ctrlKey && key === 'a') { event.preventDefault(); selectAll(); return true; }
    if (event.ctrlKey && key === 'g') { event.preventDefault(); if (event.shiftKey) ungroupSelected(); else groupSelectedLayers(); return true; }
    if ((key === 'delete' || key === 'backspace') && state.tool === 'node' && nodeSel) {
      const f = findObject(nodeSel.objectId);
      if (f) {
        const index = nodeSel.index;
        nodeSel = null;
        guarded(async () => { await call('path.deleteAnchor', { documentId: state.docId, objectId: f.object.id, index }); await loadDocument(state.docId); });
        return true;
      }
    }
    if (key === 'delete' && selectedIds().length > 1) {
      const ids = selectedIds();
      setSelection([]);
      guarded(async () => {
        await call('batch', { atomic: true, ops: ids.map((objectId) => ({ op: 'object.delete', params: { documentId: state.docId, objectId } })) });
        await loadDocument(state.docId);
      });
      return true;
    }
    if (key.startsWith('arrow') && selectedIds().length && state.tool === 'select') {
      event.preventDefault();
      const step = event.shiftKey ? 10 : 1;
      const dx = key === 'arrowleft' ? -step : key === 'arrowright' ? step : 0;
      const dy = key === 'arrowup' ? -step : key === 'arrowdown' ? step : 0;
      commitTransform(selectedIds(), (layer) => { const v = vectorToLayer(layer, dx, dy); return { dx: v.x, dy: v.y }; });
      return true;
    }
    if (key === "'" && event.ctrlKey) { view.grid = !view.grid; saveView(); renderView(); drawOverlay(); return true; }
    if (key === ';' && event.ctrlKey) { view.guides = !view.guides; saveView(); renderView(); drawOverlay(); return true; }
    return false;
  }

  function selectAll() {
    const ids = [];
    for (const layer of state.doc.layers) if (layerShown(layer) && !isGroupLayer(layer) && !layer.locked) layer.objects.forEach((o) => ids.push(o.id));
    setSelection(ids);
    afterSelectionChange();
  }

  // ------------------------------------------------------------------ overlay

  function drawOverlay() {
    const doc = state.doc;
    if (!doc) return;
    const ctx = overlay.getContext('2d');
    const scale = overlay.width / doc.canvas.width;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, overlay.width, overlay.height);
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    const px = 1 / scale;
    const W = doc.canvas.width;
    const H = doc.canvas.height;
    const trace = (segs) => {
      ctx.beginPath();
      for (const s of segs) {
        if (s.op === 'M') ctx.moveTo(s.x, s.y); else if (s.op === 'L') ctx.lineTo(s.x, s.y);
        else if (s.op === 'Q') ctx.quadraticCurveTo(s.cx, s.cy, s.x, s.y); else if (s.op === 'C') ctx.bezierCurveTo(s.c1x, s.c1y, s.c2x, s.c2y, s.x, s.y);
        else if (s.op === 'Z') ctx.closePath();
      }
    };
    if (state.drag && state.drag.mode === 'shape' && state.drag.box.w > 1 && state.drag.box.h > 1) {
      try {
        const spec = SH().normalizeShapeSpec(Object.assign({ kind: state.drag.kind, box: state.drag.box }, SHAPE_DEFAULTS[state.drag.kind]));
        trace(SH().shapeSegments(spec));
        ctx.save(); ctx.globalAlpha = 0.35; ctx.fillStyle = state.drag.kind === 'spiral' ? 'transparent' : currentFill(); ctx.fill(); ctx.restore();
        ctx.lineWidth = px * 1.5; ctx.strokeStyle = '#38bdf8'; ctx.stroke();
      } catch (error) { /* preview only */ }
    }
    if (state.pen && state.pen.pts.length) {
      const pen = state.pen;
      ctx.lineWidth = px * 1.5; ctx.strokeStyle = '#38bdf8';
      for (const e of pen.edges) { trace(penSegments(pen.pts, [e])); ctx.stroke(); }
      if (pen.hover && !state.drag && pen.current !== null) {
        const c = pen.pts[pen.current];
        ctx.save(); ctx.setLineDash([4 * px, 4 * px]); ctx.beginPath(); ctx.moveTo(c.x, c.y);
        if (c.out) ctx.quadraticCurveTo(c.out.x, c.out.y, pen.hover.x, pen.hover.y); else ctx.lineTo(pen.hover.x, pen.hover.y);
        ctx.stroke(); ctx.restore();
      }
      pen.pts.forEach((a, i) => {
        for (const hnd of [a.in, a.out]) if (hnd) { ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(hnd.x, hnd.y); ctx.lineWidth = px; ctx.strokeStyle = '#94a3b8'; ctx.stroke(); ctx.beginPath(); ctx.arc(hnd.x, hnd.y, 3 * px, 0, Math.PI * 2); ctx.fillStyle = '#ffffff'; ctx.fill(); ctx.stroke(); }
        ctx.beginPath(); ctx.rect(a.x - 4 * px, a.y - 4 * px, 8 * px, 8 * px);
        ctx.fillStyle = i === pen.current ? '#38bdf8' : '#ffffff'; ctx.fill(); ctx.lineWidth = px * 1.5; ctx.strokeStyle = '#38bdf8'; ctx.stroke();
      });
    }
    if (state.tool === 'node' || state.tool === 'pen') {
      const nf = networkTarget();
      if (nf) {
        const live = state.previewDocOverride ? (() => { for (const l of state.previewDocOverride.layers) for (const o of l.objects) if (o.id === nf.object.id) return o; return nf.object; })() : nf.object;
        const m = objectMatrix(nf.layer, live);
        ctx.lineWidth = px;
        for (const e of live.edges) for (const [v, c] of [[e.a, e.c1], [e.b, e.c2]]) {
          if (c === undefined) continue;
          const a = apply(m, live.points[v]); const h = apply(m, live.points[c]);
          ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(h.x, h.y); ctx.strokeStyle = '#94a3b8'; ctx.stroke();
          ctx.beginPath(); ctx.arc(h.x, h.y, 3.5 * px, 0, Math.PI * 2); ctx.fillStyle = '#ffffff'; ctx.fill(); ctx.stroke();
        }
        live.points.forEach((q) => { if (q.ctrl) return; const a = apply(m, q); ctx.beginPath(); ctx.rect(a.x - 4 * px, a.y - 4 * px, 8 * px, 8 * px); ctx.fillStyle = '#ffffff'; ctx.fill(); ctx.lineWidth = px * 1.5; ctx.strokeStyle = '#38bdf8'; ctx.stroke(); });
      }
    }
    if (state.tool === 'select' && !state.pen) {
      const t = state.drag && state.drag.mode === 'arc' ? Object.assign({}, state.drag.t, { spec: state.drag.spec }) : arcTarget();
      if (t) {
        const h = arcHandles(t);
        for (const [k, color] of [['start', '#ffffff'], ['end', '#ffffff'], ['ratio', '#38bdf8']]) {
          ctx.beginPath(); ctx.arc(h[k].x, h[k].y, 5 * px, 0, Math.PI * 2); ctx.fillStyle = color; ctx.fill(); ctx.lineWidth = px * 1.5; ctx.strokeStyle = '#0284c7'; ctx.stroke();
        }
      }
    }
    if (state.drag && state.drag.mode === 'pixel') {
      // Live stroke preview; the engine paints the real pixels on release.
      const pts = state.drag.points;
      ctx.save();
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.lineWidth = pixelOpts.size;
      ctx.strokeStyle = state.drag.tool === 'pbrush' ? (($('propFill') && $('propFill').value.trim()) || '#000000') : 'rgba(56,189,248,0.45)';
      ctx.globalAlpha = state.drag.tool === 'pbrush' ? pixelOpts.opacity * 0.85 : 1;
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (const p of pts.slice(1)) ctx.lineTo(p.x, p.y);
      if (pts.length === 1) ctx.lineTo(pts[0].x + 0.01, pts[0].y);
      ctx.stroke();
      ctx.restore();
    }

    if (view.grid && doc.canvas.grid) {
      const g = doc.canvas.grid;
      const sub = g.size / g.subdivisions;
      ctx.lineWidth = px;
      for (const [step, color] of [[sub, 'rgba(148,163,184,0.10)'], [g.size, 'rgba(148,163,184,0.28)']]) {
        if (step * scale < 4) continue;
        ctx.strokeStyle = color;
        ctx.beginPath();
        for (let x = 0; x <= W; x += step) { ctx.moveTo(x, 0); ctx.lineTo(x, H); }
        for (let y = 0; y <= H; y += step) { ctx.moveTo(0, y); ctx.lineTo(W, y); }
        ctx.stroke();
      }
    }
    if (view.guides) {
      ctx.lineWidth = px;
      for (const g of doc.canvas.guides || []) {
        const dragging = state.drag && state.drag.mode === 'guide' && state.drag.guide.id === g.id && state.drag.position !== undefined;
        const at = dragging ? state.drag.position : g.position;
        ctx.strokeStyle = dragging ? '#f472b6' : '#22d3ee';
        ctx.beginPath();
        if (g.orientation === 'vertical') { ctx.moveTo(at, 0); ctx.lineTo(at, H); } else { ctx.moveTo(0, at); ctx.lineTo(W, at); }
        ctx.stroke();
      }
    }
    if (snapLines.length) {
      ctx.strokeStyle = '#f472b6';
      ctx.lineWidth = px;
      ctx.setLineDash([4 * px, 3 * px]);
      ctx.beginPath();
      for (const l of snapLines) { if (l.v) { ctx.moveTo(l.at, 0); ctx.lineTo(l.at, H); } else { ctx.moveTo(0, l.at); ctx.lineTo(W, l.at); } }
      ctx.stroke();
      ctx.setLineDash([]);
    }

    const drag = state.drag;
    if (drag && drag.mode === 'marquee' && drag.current) {
      ctx.fillStyle = 'rgba(56,189,248,0.10)';
      ctx.strokeStyle = '#38bdf8';
      ctx.lineWidth = px;
      const r = { x: Math.min(drag.start.x, drag.current.x), y: Math.min(drag.start.y, drag.current.y), w: Math.abs(drag.start.x - drag.current.x), h: Math.abs(drag.start.y - drag.current.y) };
      ctx.fillRect(r.x, r.y, r.w, r.h);
      ctx.strokeRect(r.x, r.y, r.w, r.h);
    }

    const sel = selection();
    if (!sel.length) return;
    // Each selected object: its real (rotated, layer-transformed) outline.
    ctx.strokeStyle = 'rgba(56,189,248,0.55)';
    ctx.lineWidth = px;
    for (const f of sel) {
      const c = docBox(f.layer, f.object).corners;
      ctx.beginPath();
      ctx.moveTo(c[0].x, c[0].y); ctx.lineTo(c[1].x, c[1].y); ctx.lineTo(c[3].x, c[3].y); ctx.lineTo(c[2].x, c[2].y); ctx.closePath();
      ctx.stroke();
    }
    if (state.tool === 'node') { drawNodes(ctx, px); return; }

    let box = selectionBox();
    if (drag && drag.mode === 'move-many' && drag.delta) box = Object.assign({}, box, { x: box.x + drag.delta.dx, y: box.y + drag.delta.dy });
    ctx.save();
    if (drag && drag.result && drag.mode === 'scale') {
      const { sx, sy, pivot } = drag.result;
      box = { x: pivot.x + (box.x - pivot.x) * sx, y: pivot.y + (box.y - pivot.y) * sy, w: box.w * sx, h: box.h * sy };
    }
    if (drag && drag.result && drag.mode === 'rotate') {
      ctx.translate(drag.result.pivot.x, drag.result.pivot.y);
      ctx.rotate(drag.result.deg * Math.PI / 180);
      ctx.translate(-drag.result.pivot.x, -drag.result.pivot.y);
    }
    ctx.strokeStyle = '#38bdf8';
    ctx.lineWidth = 1.5 * px;
    ctx.setLineDash([6 * px, 4 * px]);
    ctx.strokeRect(box.x, box.y, box.w, box.h);
    ctx.setLineDash([]);
    const handles = handlePoints(box);
    ctx.beginPath();
    ctx.moveTo(box.x + box.w / 2, box.y);
    ctx.lineTo(handles[8].x, handles[8].y);
    ctx.stroke();
    const hs = HANDLE * px;
    handles.forEach((p, i) => {
      ctx.fillStyle = i === 8 ? '#a855f7' : '#ffffff';
      ctx.strokeStyle = '#0ea5e9';
      if (i === 8) { ctx.beginPath(); ctx.arc(p.x, p.y, hs / 2, 0, Math.PI * 2); ctx.fill(); ctx.stroke(); } else { ctx.fillRect(p.x - hs / 2, p.y - hs / 2, hs, hs); ctx.strokeRect(p.x - hs / 2, p.y - hs / 2, hs, hs); }
    });
    ctx.restore();
    ctx.fillStyle = 'rgba(56,189,248,0.95)';
    ctx.font = `${12 * px}px "Segoe UI", Tahoma`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    const label = sel.length > 1 ? `${sel.length} عناصر` : sel[0].object.type;
    let info = `${label} · ${Math.round(box.w)}×${Math.round(box.h)}`;
    if (drag && drag.result && drag.mode === 'rotate') info = `${Math.round(drag.result.deg)}°`;
    ctx.fillText(info, box.x, box.y - 32 * px);
  }

  function drawNodes(ctx, px) {
    const f = nodeTarget();
    if (!f) return;
    const live = state.previewDocOverride ? (() => { for (const l of state.previewDocOverride.layers) for (const o of l.objects) if (o.id === f.object.id) return o; return f.object; })() : f.object;
    const m = objectMatrix(f.layer, live);
    const anchors = PE().listAnchors(live.segments);
    ctx.lineWidth = px;
    for (const a of anchors) {
      const p = apply(m, a);
      const selected = nodeSel && nodeSel.index === a.index;
      if (selected) {
        for (const kind of ['in', 'out']) {
          if (!a[kind]) continue;
          const h = apply(m, a[kind]);
          ctx.strokeStyle = '#a855f7';
          ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(h.x, h.y); ctx.stroke();
          ctx.fillStyle = '#ffffff';
          ctx.beginPath(); ctx.arc(h.x, h.y, 4 * px, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
        }
      }
      const s = (selected ? 9 : 7) * px;
      ctx.fillStyle = selected ? '#a855f7' : '#ffffff';
      ctx.strokeStyle = '#0ea5e9';
      if (a.type === 'smooth') { ctx.beginPath(); ctx.arc(p.x, p.y, s / 2, 0, Math.PI * 2); ctx.fill(); ctx.stroke(); } else { ctx.fillRect(p.x - s / 2, p.y - s / 2, s, s); ctx.strokeRect(p.x - s / 2, p.y - s / 2, s, s); }
    }
  }

  // ------------------------------------------------------------------ panels

  const BLENDS = [['source-over', 'عادي'], ['multiply', 'ضرب'], ['screen', 'تفتيح'], ['overlay', 'تراكب'], ['darken', 'تغميق'], ['lighten', 'تفتيح نسبي'],
    ['color-dodge', 'تفادي اللون'], ['color-burn', 'حرق اللون'], ['hard-light', 'ضوء قوي'], ['soft-light', 'ضوء ناعم'], ['difference', 'فرق'],
    ['exclusion', 'استبعاد'], ['hue', 'تدرج اللون'], ['saturation', 'تشبع'], ['color', 'لون'], ['luminosity', 'سطوع']];
  const FX_NAMES = { dropShadow: 'ظل خارجي', innerShadow: 'ظل داخلي', outerGlow: 'توهج خارجي', innerGlow: 'توهج داخلي', stroke: 'حد', bevel: 'تجسيم',
    colorOverlay: 'تراكب لون', gradientOverlay: 'تراكب تدرج', patternOverlay: 'تراكب نمط', extrude: 'عمق 2.5D', satin: 'ساتان' };
  const CONTOUR_TYPES = ['dropShadow', 'innerShadow', 'outerGlow', 'innerGlow', 'bevel', 'satin'];
  const CONTOURS = [['linear', 'خطي'], ['gaussian', 'غاوسي'], ['cone', 'مخروط'], ['coneInverted', 'مخروط معكوس'], ['cove', 'تجويف'],
    ['halfRound', 'نصف دائري'], ['ring', 'حلقة'], ['ringDouble', 'حلقة مزدوجة'], ['rollingSlope', 'منحدر متموج'], ['sawtooth', 'منشار']];
  const ADJ_NAMES = { curves: 'منحنيات', levels: 'مستويات', brightnessContrast: 'سطوع/تباين', exposure: 'تعريض', hueSaturation: 'تدرج/تشبع',
    vibrance: 'حيوية', colorBalance: 'توازن الألوان', blackWhite: 'أبيض وأسود', photoFilter: 'فلتر تصوير', gradientMap: 'خريطة تدرج',
    invert: 'عكس', posterize: 'تقليل الألوان', threshold: 'عتبة' };
  const FILTER_NAMES = { gaussianBlur: 'تمويه غاوسي', motionBlur: 'تمويه حركة', radialBlur: 'تمويه دائري', unsharpMask: 'قناع الحدة',
    sharpen: 'زيادة الحدة', highPass: 'تمرير عالٍ', addNoise: 'ضوضاء', pixelate: 'بكسلة', adjustment: 'ضبط' };
  const WARPS = [['arc', 'قوس'], ['arch', 'قنطرة'], ['bulge', 'انتفاخ'], ['flag', 'علم'], ['wave', 'موجة'], ['fisheye', 'عين السمكة'],
    ['rise', 'صعود'], ['squeeze', 'ضغط'], ['twist', 'التواء']];
  const FX_ENUMS = { position: ['outside', 'inside', 'center'], style: ['inner', 'outer', 'emboss'], technique: ['smooth', 'chisel'], direction: ['up', 'down'], source: ['edge', 'center'] };
  const FX_LABELS = { size: 'الحجم', distance: 'المسافة', spread: 'الانتشار', choke: 'الانكماش', opacity: 'الشفافية', color: 'اللون',
    blend: 'المزج', position: 'الموضع', paint: 'اللون', angle: 'الزاوية', altitude: 'الارتفاع', depth: 'العمق', soften: 'التنعيم',
    technique: 'الأسلوب', style: 'النمط', direction: 'الاتجاه', source: 'المصدر', shade: 'التظليل',
    highlightColor: 'لون الإضاءة', highlightBlend: 'مزج الإضاءة', highlightOpacity: 'شفافية الإضاءة', contour: 'المحيط', invert: 'عكس',
    shadowColor: 'لون الظل', shadowBlend: 'مزج الظل', shadowOpacity: 'شفافية الظل' };
  const ENUM_LABELS = { outside: 'خارج', inside: 'داخل', center: 'وسط', inner: 'داخلي', outer: 'خارجي', emboss: 'نقش',
    smooth: 'ناعم', chisel: 'حاد', up: 'بارز', down: 'غائر', edge: 'الحافة' };
  // History steps are op names; show the common ones in Arabic.
  const STEP_NAMES = { 'object.transform': 'تحويل', 'object.update': 'تعديل عنصر', 'object.delete': 'حذف عنصر', 'object.duplicate': 'نسخ عنصر',
    'object.align': 'محاذاة', 'object.distribute': 'توزيع', 'object.move': 'نقل عنصر', 'draw.rect': 'مستطيل', 'draw.ellipse': 'بيضاوي',
    'draw.line': 'خط', 'draw.polygon': 'مضلع', 'draw.path': 'مسار', 'draw.text': 'نص', 'draw.image': 'صورة', 'draw.stroke': 'رسم حر',
    'draw.freehand': 'رسم حر', 'layer.add': 'طبقة جديدة', 'layer.update': 'تعديل طبقة', 'layer.delete': 'حذف طبقة', 'layer.move': 'ترتيب طبقة',
    'layer.duplicate': 'نسخ طبقة', 'group.create': 'تجميع', 'group.ungroup': 'فك مجموعة', 'effect.add': 'إضافة مؤثر', 'effect.update': 'تعديل مؤثر',
    'effect.remove': 'حذف مؤثر', 'effect.applyPreset': 'إعداد جاهز', 'effect.move': 'ترتيب مؤثر', 'mask.create': 'قناع جديد',
    'mask.paint': 'رسم على القناع', 'mask.update': 'تعديل قناع', 'mask.delete': 'حذف قناع', 'mask.apply': 'تطبيق قناع',
    'path.boolean': 'عملية أشكال', 'path.updateAnchor': 'تحريك نقطة', 'path.addAnchor': 'إضافة نقطة', 'path.deleteAnchor': 'حذف نقطة',
    'path.convertAnchor': 'تحويل نقطة', 'path.fromShape': 'تحويل إلى مسار', 'path.outlineStroke': 'الحد إلى شكل', 'guide.add': 'دليل جديد',
    'guide.update': 'تحريك دليل', 'guide.remove': 'حذف دليل', 'guide.clear': 'مسح الأدلة', 'document.update': 'إعدادات المستند',
    'document.crop': 'قص اللوحة', batch: 'عدة عمليات', 'raster.create': 'طبقة بكسل', 'raster.paint': 'رسم بكسل', 'raster.fill': 'تعبئة',
    'raster.gradient': 'تدرج بكسل', 'raster.spotHeal': 'معالجة بقع', 'raster.patch': 'رقعة', 'raster.transform': 'تشويه/منظور',
    'raster.rasterize': 'تحويل إلى بكسل', 'adjustment.add': 'طبقة ضبط', 'adjustment.update': 'تعديل ضبط', 'filter.add': 'فلتر ذكي',
    'filter.update': 'تعديل فلتر', 'filter.remove': 'حذف فلتر', 'filter.move': 'ترتيب فلتر', 'text.style': 'تنسيق جزء من النص' };
  const stepName = (op) => STEP_NAMES[op] || op;
  const PRESET_NAMES = { gold: 'ذهبي', chrome: 'كروم', glass: 'زجاج', neon: 'نيون', emboss: 'نقش', extruded: 'مجسّم' };

  const selectedLayer = () => state.doc && state.doc.layers.find((l) => l.id === state.selectedLayerId);
  const selectedLayerIds = () => (state.selectedLayerIds && state.selectedLayerIds.length ? state.selectedLayerIds : (state.selectedLayerId ? [state.selectedLayerId] : []))
    .filter((id) => state.doc.layers.some((l) => l.id === id));

  async function op(name, params, message) {
    return guarded(async () => {
      const data = await call(name, Object.assign({ documentId: state.docId }, params));
      await loadDocument(state.docId);
      if (message) toast(message);
      return data;
    });
  }

  function panel(id, title, buttons) {
    return el('section', { class: 'panel', id }, [
      el('header', {}, [el('span', { text: title })].concat(buttons ? [el('div', { class: 'mini-row' }, buttons)] : [])),
      el('div', { class: 'pbody', id: `${id}Body` }),
    ]);
  }

  function buildPanels(container) {
    const layers = container.querySelector('#layerList').closest('.panel');
    layers.querySelector('header').appendChild(el('div', { class: 'mini-row' }, [
      el('button', { class: 'mini', title: 'تجميع الطبقات المحددة (Ctrl+G)', text: '📁+', onclick: groupSelectedLayers }),
      el('button', { class: 'mini', title: 'فك المجموعة (Ctrl+Shift+G)', text: '📂', onclick: ungroupSelected }),
      el('button', { class: 'mini', title: 'إلى الأعلى', text: '▲', onclick: () => moveLayer(1) }),
      el('button', { class: 'mini', title: 'إلى الأسفل', text: '▼', onclick: () => moveLayer(-1) }),
      el('button', { class: 'mini', title: 'طبقة بكسل جديدة (للفرشاة والرتوش)', text: '▦+', onclick: async () => {
        const data = await op('raster.create', { name: 'طبقة بكسل' }, 'أُنشئت طبقة بكسل');
        if (data) { state.selectedLayerId = data.layerId; state.selectedLayerIds = [data.layerId]; renderLayers(); renderLayerProps(); }
      } }),
    ]));
    const after = (node, newNode) => node.parentNode.insertBefore(newNode, node.nextSibling);
    const layerPanel = panel('layerPanel', 'الطبقة');
    const fxPanel = panel('fxPanel', 'المؤثرات');
    const adjPanel = panel('adjPanel', 'الضبط والفلاتر');
    after(layers, layerPanel);
    after(layerPanel, fxPanel);
    after(fxPanel, adjPanel);
    const props = container.querySelector('#selectionHint').closest('.panel');
    const shapePanel = panel('shapePanel', 'الشكل');
    after(props, shapePanel);
    const arrange = panel('arrangePanel', 'الترتيب والأشكال');
    after(shapePanel, arrange);
    const viewPanel = panel('viewPanel', 'العرض والأدلة');
    after(arrange, viewPanel);
    const log = container.querySelector('#logList').closest('.panel');
    log.parentNode.insertBefore(panel('historyPanel', 'السجل (History)'), log);
    call('effect.list', {}).then((data) => { effectTypes = data.types; presets = data.presets; renderEffects(); }).catch(() => {});
    renderView();
    makeCollapsible(container);
  }

  // Click a panel title to fold it; folded panels are remembered per viewer.
  function makeCollapsible(container) {
    let folded = {};
    try { folded = JSON.parse(localStorage.getItem('artforge.folded') || '{}'); } catch { folded = {}; }
    if (!Object.keys(folded).length) folded = { 'الحركة': true, 'الألوان والتدرجات': true };
    container.querySelectorAll('.panel').forEach((panelEl) => {
      const title = panelEl.querySelector('header > span');
      if (!title) return;
      const key = title.textContent;
      panelEl.classList.toggle('collapsed', Boolean(folded[key]));
      title.addEventListener('click', () => {
        folded[key] = !panelEl.classList.contains('collapsed');
        panelEl.classList.toggle('collapsed', folded[key]);
        try { localStorage.setItem('artforge.folded', JSON.stringify(folded)); } catch { /* storage unavailable */ }
      });
    });
  }

  function renderLayers() {
    const list = $('layerList');
    if (!list || !state.doc) return;
    list.innerHTML = '';
    const chosen = selectedLayerIds();
    state.doc.layers.slice().reverse().forEach((layer) => {
      const depth = layerAncestors(layer).length;
      const locked = layer.locked || (layer.locks && (layer.locks.position || layer.locks.content));
      const badges = [];
      if (layer.clipped) badges.push(el('span', { class: 'badge', title: 'مقصوصة على الطبقة التي تحتها', text: '↳' }));
      if (layer.mask) badges.push(el('span', { class: `badge${layer.mask.enabled === false ? ' off' : ''}`, title: 'قناع نقطي', text: '◐' }));
      if (layer.vectorMask) badges.push(el('span', { class: `badge${layer.vectorMask.enabled === false ? ' off' : ''}`, title: 'قناع متجه', text: '⬠' }));
      if (layer.effects && layer.effects.length) badges.push(el('span', { class: 'badge fx', title: 'مؤثرات', text: `fx${layer.effects.length > 1 ? layer.effects.length : ''}` }));
      if (layer.raster) badges.push(el('span', { class: 'badge', title: 'طبقة بكسل', text: '▦' }));
      if (layer.type === 'adjustment') badges.push(el('span', { class: 'badge', title: `طبقة ضبط: ${ADJ_NAMES[layer.adjustment.kind] || layer.adjustment.kind}`, text: '◑' }));
      if (layer.filters && layer.filters.length) badges.push(el('span', { class: 'badge', title: 'فلاتر ذكية', text: `ƒ${layer.filters.length}` }));
      if (layer.blendIf) badges.push(el('span', { class: 'badge', title: 'Blend If', text: '⇅' }));
      const row = el('div', {
        class: `layer${chosen.includes(layer.id) ? ' selected' : ''}${isGroupLayer(layer) ? ' group' : ''}${layer.clipped ? ' clipped' : ''}`,
        style: depth ? `padding-inline-start:${depth * 14}px` : undefined,
        onclick: (event) => {
          if (event.ctrlKey || event.shiftKey) {
            const set = new Set(chosen);
            if (set.has(layer.id)) set.delete(layer.id); else set.add(layer.id);
            state.selectedLayerIds = [...set];
          } else {
            state.selectedLayerIds = [layer.id];
          }
          state.selectedLayerId = layer.id;
          renderLayers();
          renderLayerProps();
          renderEffects();
          renderAdjustments();
        },
      }, [
        el('button', { class: 'eye', text: layer.visible ? '👁' : '🚫', title: 'إظهار/إخفاء',
          onclick: (event) => { event.stopPropagation(); op('layer.update', { layerId: layer.id, visible: !layer.visible }); } }),
        el('button', { class: `lock${locked ? ' on' : ''}`, text: locked ? '🔒' : '🔓', title: 'قفل',
          onclick: (event) => { event.stopPropagation(); op('layer.update', { layerId: layer.id, locked: !layer.locked }); } }),
        el('span', { class: 'name', text: `${isGroupLayer(layer) ? '📁 ' : ''}${layer.name}` }),
        el('span', { class: 'badges' }, badges),
        el('span', { class: 'count', text: `${Math.round(layer.opacity * 100)}%` }),
        el('button', { class: 'del', text: '✕', title: 'حذف الطبقة',
          onclick: (event) => { event.stopPropagation(); op('layer.delete', { layerId: layer.id }, 'حُذفت الطبقة'); } }),
      ]);
      list.appendChild(row);
    });
  }

  async function groupSelectedLayers() {
    const ids = selectedLayerIds();
    if (!ids.length) { toast('حدّد طبقة أو أكثر في لوحة الطبقات', true); return; }
    const data = await op('group.create', { layerIds: ids, name: 'مجموعة' }, 'جُمعت الطبقات');
    if (data) { state.selectedLayerId = data.groupId; state.selectedLayerIds = [data.groupId]; renderLayers(); }
  }
  async function ungroupSelected() {
    const layer = selectedLayer();
    if (!layer || !isGroupLayer(layer)) { toast('حدّد مجموعة أولًا', true); return; }
    const data = await op('group.ungroup', { groupId: layer.id }, 'فُكّت المجموعة');
    if (data && data.appearanceMayChange) toast('فُكّت المجموعة؛ شفافيتها أو مزجها لم يعد يُطبّق');
  }
  async function moveLayer(direction) {
    const layer = selectedLayer();
    if (!layer) return;
    const siblings = state.doc.layers.filter((l) => (l.parentId || null) === (layer.parentId || null));
    const index = siblings.indexOf(layer) + direction;
    if (index < 0 || index >= siblings.length) return;
    await op('layer.move', { layerId: layer.id, index });
  }

  function field(label, input, full) { return el('label', { class: full ? 'full' : '', text: label }, [input]); }

  function renderLayerProps() {
    const body = $('layerPanelBody');
    if (!body || !state.doc) return;
    body.innerHTML = '';
    const layer = selectedLayer();
    if (!layer) { body.appendChild(el('div', { class: 'hint', text: 'لا توجد طبقة محددة' })); return; }
    const group = isGroupLayer(layer);
    const update = (params) => op('layer.update', Object.assign({ layerId: layer.id }, params));
    const opacity = el('input', { type: 'range', min: '0', max: '100', value: String(Math.round(layer.opacity * 100)), onchange: (e) => update({ opacity: Number(e.target.value) / 100 }) });
    const blend = el('select', { onchange: (e) => update({ blend: e.target.value }) },
      (group ? [['pass-through', 'تمرير (Pass-through)']] : []).concat(BLENDS).map(([v, t]) => el('option', { value: v, text: t })));
    blend.value = layer.blend;
    const rows = [field('الشفافية', opacity), field('المزج', blend)];
    if (!group) {
      rows.push(field('شفافية التعبئة', el('input', { type: 'range', min: '0', max: '100', value: String(Math.round((layer.fillOpacity === undefined ? 1 : layer.fillOpacity) * 100)), onchange: (e) => update({ fillOpacity: Number(e.target.value) / 100 }) })));
    }
    const locks = layer.locks || {};
    const check = (label, checked, onchange) => el('label', { class: 'switch' }, [el('input', Object.assign({ type: 'checkbox', onchange }, checked ? { checked: 'checked' } : {})), el('span', { text: label })]);
    rows.push(el('div', { class: 'row' }, [
      check('قفل كامل', layer.locked, (e) => update({ locked: e.target.checked })),
      check('الموضع', locks.position, (e) => update({ locks: { position: e.target.checked } })),
      check('المحتوى', locks.content, (e) => update({ locks: { content: e.target.checked } })),
    ]));
    const maskButtons = [];
    if (!layer.mask) maskButtons.push(el('button', { class: 'btn small', text: '+ قناع', title: 'قناع يظهر كل شيء (من التحديد إن وُجد)', onclick: () => op('mask.create', { layerId: layer.id, from: 'reveal' }, 'أُضيف قناع') }));
    else {
      maskButtons.push(el('button', { class: 'btn small ghost', text: layer.mask.enabled === false ? 'تفعيل القناع' : 'تعطيل القناع', onclick: () => op('mask.update', { layerId: layer.id, enabled: layer.mask.enabled === false }) }));
      maskButtons.push(el('button', { class: 'btn small ghost', text: 'عكس', onclick: () => op('mask.update', { layerId: layer.id, invert: !layer.mask.invert }) }));
      maskButtons.push(el('button', { class: 'btn small danger', text: 'حذف القناع', onclick: () => op('mask.delete', { layerId: layer.id }) }));
    }
    if (!group) maskButtons.push(el('button', { class: `btn small${layer.clipped ? '' : ' ghost'}`, text: layer.clipped ? 'إلغاء القص' : 'قص على السفلية', onclick: () => update({ clipped: !layer.clipped }) }));
    rows.push(el('div', { class: 'row' }, maskButtons));
    if (!group && layer.type !== 'adjustment') rows.push(blendIfEditor(layer, update));
    if (layer.raster) rows.push(pixelControls(layer));
    body.appendChild(el('div', { class: 'props' }, rows));
  }

  // Blend If: four values per range (black0, black1, white1, white0); split pairs give a soft transition.
  function blendIfEditor(layer, update) {
    const b = layer.blendIf || { channel: 'gray', this: [0, 0, 255, 255], underlying: [0, 0, 255, 255] };
    const read = (box) => [...box.querySelectorAll('input')].map((i) => Math.max(0, Math.min(255, Math.round(Number(i.value) || 0))));
    const quad = (values) => el('div', { class: 'quad' }, values.map((v) => el('input', { type: 'number', min: '0', max: '255', value: String(v) })));
    const thisBox = quad(b.this);
    const underBox = quad(b.underlying);
    const channel = el('select', {}, [['gray', 'رمادي'], ['red', 'أحمر'], ['green', 'أخضر'], ['blue', 'أزرق']].map(([v, t]) => el('option', { value: v, text: t })));
    channel.value = b.channel;
    const apply = () => {
      const t = read(thisBox).sort((x, y) => x - y);
      const u = read(underBox).sort((x, y) => x - y);
      update({ blendIf: { channel: channel.value, this: t, underlying: u } });
    };
    return el('details', { class: 'fx' }, [
      el('summary', { text: layer.blendIf ? 'Blend If (مفعّل)' : 'Blend If (المزج حسب السطوع)' }),
      el('div', { class: 'props' }, [
        field('القناة', channel),
        field('هذه الطبقة', thisBox, true),
        field('الطبقة السفلية', underBox, true),
        el('div', { class: 'row' }, [
          el('button', { class: 'btn small', text: 'تطبيق', onclick: apply }),
          el('button', { class: 'btn small ghost', text: 'إعادة ضبط', onclick: () => update({ blendIf: null }) }),
        ]),
      ]),
    ]);
  }

  // Brush settings for the pixel tools + free transform (warp presets, skew) of the layer's pixels.
  function pixelControls(layer) {
    const num = (key, min, max, step) => el('input', { type: 'number', min: String(min), max: String(max), step: String(step), value: String(pixelOpts[key]),
      onchange: (e) => { pixelOpts[key] = Math.max(min, Math.min(max, Number(e.target.value) || pixelOpts[key])); } });
    const warp = el('select', {}, WARPS.map(([v, t]) => el('option', { value: v, text: t })));
    const bend = el('input', { type: 'number', min: '-100', max: '100', step: '5', value: '50' });
    const skew = el('input', { type: 'number', min: '-60', max: '60', step: '1', value: '15' });
    const transform = (params, message) => op('raster.transform', Object.assign({ layerId: layer.id }, params), message);
    return el('details', { class: 'fx', open: 'open' }, [
      el('summary', { text: 'البكسل: الفرشاة والتشويه' }),
      el('div', { class: 'props' }, [
        field('حجم الفرشاة', num('size', 1, 400, 1)),
        field('الصلابة', num('hardness', 0, 1, 0.05)),
        field('الشفافية', num('opacity', 0.01, 1, 0.05)),
        el('div', { class: 'hint', text: 'B فرشاة · E ممحاة · J معالجة البقع · [ ] الحجم · اللون من «تعبئة»' }),
        field('تشويه جاهز', warp),
        field('الانحناء %', bend),
        el('div', { class: 'row' }, [
          el('button', { class: 'btn small', text: 'تشويه', onclick: () => transform({ mode: 'warp', preset: warp.value, bend: Number(bend.value) / 100 }, 'طُبّق التشويه') }),
        ]),
        field('إمالة (درجة)', skew),
        el('div', { class: 'row' }, [
          el('button', { class: 'btn small ghost', text: 'إمالة أفقية', onclick: () => transform({ mode: 'skew', skewX: Number(skew.value) }) }),
          el('button', { class: 'btn small ghost', text: 'إمالة رأسية', onclick: () => transform({ mode: 'skew', skewY: Number(skew.value) }) }),
          el('button', { class: 'btn small ghost', text: 'رقعة من التحديد', title: 'يعالج التحديد الحالي من منطقة مجاورة مناسبة', onclick: () => op('raster.patch', { layerId: layer.id }, 'عولج التحديد') }),
        ]),
      ]),
    ]);
  }

  // ------------------------------------------------------------------ adjustments & smart filters

  function numericFields(object, onPatch, skip) {
    const out = [];
    for (const [key, value] of Object.entries(object)) {
      if ((skip || []).includes(key)) continue;
      if (typeof value === 'number') {
        const step = Math.abs(value) <= 1 && !Number.isInteger(value) ? '0.05' : (['hue', 'angle', 'distance', 'radius', 'size', 'amount', 'levels', 'level'].includes(key) ? '1' : '0.05');
        out.push(field(key, el('input', { type: 'number', step, value: String(value), onchange: (e) => onPatch({ [key]: Number(e.target.value) }) })));
      } else if (typeof value === 'boolean') {
        out.push(el('label', { class: 'switch' }, [el('input', Object.assign({ type: 'checkbox', onchange: (e) => onPatch({ [key]: e.target.checked }) }, value ? { checked: 'checked' } : {})), el('span', { text: key })]));
      }
    }
    return out;
  }

  function jsonEditor(value, onApply) {
    const area = el('textarea', { rows: '4', spellcheck: 'false' });
    area.value = JSON.stringify(value);
    return el('div', { class: 'full' }, [area, el('button', { class: 'btn small ghost', text: 'تطبيق JSON', onclick: () => {
      let parsed;
      try { parsed = JSON.parse(area.value); } catch (error) { toast('JSON غير صالح', true); return; }
      onApply(parsed);
    } })]);
  }

  function renderAdjustments() {
    const body = $('adjPanelBody');
    if (!body || !state.doc) return;
    body.innerHTML = '';
    const layer = selectedLayer();
    const addAdj = el('select', { onchange: (ev) => {
      if (!ev.target.value) return;
      op('adjustment.add', { kind: ev.target.value, name: ADJ_NAMES[ev.target.value] || ev.target.value, parentId: layer && layer.parentId ? layer.parentId : undefined }, 'أُضيفت طبقة ضبط');
    } }, [el('option', { value: '', text: '+ طبقة ضبط…' })].concat(Object.entries(ADJ_NAMES).map(([v, t]) => el('option', { value: v, text: t }))));
    body.appendChild(el('div', { class: 'props' }, [el('div', { class: 'row' }, [addAdj])]));
    if (!layer) return;
    if (layer.type === 'adjustment') {
      const a = layer.adjustment;
      const patch = (p) => op('adjustment.update', { layerId: layer.id, adjustment: p });
      body.appendChild(el('div', { class: 'props' }, [el('div', { class: 'hint', text: `طبقة ضبط: ${ADJ_NAMES[a.kind] || a.kind}` })]
        .concat(numericFields(a, patch, ['kind']))
        .concat([jsonEditor(a, (p) => patch(p))])));
      return;
    }
    if (isGroupLayer(layer)) return;
    const addFilter = el('select', { onchange: (ev) => { if (ev.target.value) op('filter.add', { layerId: layer.id, filter: { type: ev.target.value } }, 'أُضيف فلتر ذكي'); } },
      [el('option', { value: '', text: '+ فلتر ذكي…' })].concat(Object.entries(FILTER_NAMES).filter(([v]) => v !== 'adjustment').map(([v, t]) => el('option', { value: v, text: t }))));
    body.appendChild(el('div', { class: 'props' }, [el('div', { class: 'row' }, [addFilter,
      el('button', { class: 'btn small ghost', text: layer.filterMask ? 'إزالة قناع الفلاتر' : 'قناع الفلاتر من التحديد',
        onclick: () => op('filter.mask', { layerId: layer.id, from: layer.filterMask ? 'none' : 'selection' }) })])]));
    (layer.filters || []).forEach((f, index) => {
      const patch = (p) => op('filter.update', { layerId: layer.id, filterId: f.id, patch: p });
      const header = el('div', { class: 'fx-head' }, [
        el('input', Object.assign({ type: 'checkbox', title: 'تفعيل', onchange: (ev) => patch({ enabled: ev.target.checked }) }, f.enabled !== false ? { checked: 'checked' } : {})),
        el('span', { class: 'name', text: FILTER_NAMES[f.type] || f.type }),
        el('button', { class: 'mini', text: '▲', title: 'إلى الأعلى', onclick: () => index < layer.filters.length - 1 && op('filter.move', { layerId: layer.id, filterId: f.id, index: index + 1 }) }),
        el('button', { class: 'del', text: '✕', title: 'حذف الفلتر', onclick: () => op('filter.remove', { layerId: layer.id, filterId: f.id }) }),
      ]);
      body.appendChild(el('details', { class: 'fx' }, [el('summary', {}, [header]), el('div', { class: 'props' }, numericFields(f, patch, ['enabled']))]));
    });
  }

  function effectFields(layer, e) {
    const defaults = effectTypes && (effectTypes.find((t) => t.type === e.type) || {}).defaults || {};
    const fields = [];
    const patch = (key, value) => op('effect.update', { layerId: layer.id, effectId: e.id, patch: { [key]: value } });
    for (const key of Object.keys(defaults)) {
      const value = e[key];
      if (value === undefined || key === 'useGlobalLight' || key === 'knockout') continue;
      if (FX_ENUMS[key]) {
        const s = el('select', { onchange: (ev) => patch(key, ev.target.value) }, FX_ENUMS[key].map((v) => el('option', { value: v, text: ENUM_LABELS[v] || v })));
        s.value = value;
        fields.push(field(FX_LABELS[key] || key, s));
      } else if (typeof value === 'number') {
        const step = ['opacity', 'spread', 'choke', 'shade', 'highlightOpacity', 'shadowOpacity', 'depth'].includes(key) ? '0.05' : '1';
        fields.push(field(FX_LABELS[key] || key, el('input', { type: 'number', step, value: String(value), 'data-key': key, onchange: (ev) => patch(key, Number(ev.target.value)) })));
      } else if (typeof value === 'string' && (key.toLowerCase().includes('color') || key === 'paint')) {
        fields.push(field(FX_LABELS[key] || key, el('input', { type: 'text', value, 'data-key': key, onchange: (ev) => patch(key, ev.target.value.trim()) })));
      } else if (key === 'contour' && typeof value === 'string') {
        const s = el('select', { onchange: (ev) => patch(key, ev.target.value) }, CONTOURS.map(([v, t]) => el('option', { value: v, text: t })));
        s.value = value;
        fields.push(field(FX_LABELS[key] || key, s));
      } else if (typeof value === 'boolean') {
        fields.push(el('label', { class: 'switch' }, [el('input', Object.assign({ type: 'checkbox', onchange: (ev) => patch(key, ev.target.checked) }, value ? { checked: 'checked' } : {})), el('span', { text: FX_LABELS[key] || key })]));
      } else if (key === 'blend' || key.endsWith('Blend')) {
        const s = el('select', { onchange: (ev) => patch(key, ev.target.value) }, BLENDS.map(([v, t]) => el('option', { value: v, text: t })));
        s.value = value;
        fields.push(field(FX_LABELS[key] || key, s));
      }
    }
    // Optional contour on effects whose defaults carry none (linear unless set).
    if (CONTOUR_TYPES.includes(e.type) && defaults.contour === undefined) {
      const s = el('select', { onchange: (ev) => patch('contour', ev.target.value) }, CONTOURS.map(([v, t]) => el('option', { value: v, text: t })));
      s.value = typeof e.contour === 'string' ? e.contour : 'linear';
      fields.push(field(FX_LABELS.contour, s));
    }
    return fields;
  }

  function renderEffects() {
    const body = $('fxPanelBody');
    if (!body || !state.doc) return;
    body.innerHTML = '';
    const layer = selectedLayer();
    if (!layer || layer.type === 'adjustment') { body.appendChild(el('div', { class: 'hint', text: layer ? 'طبقات الضبط لا تأخذ مؤثرات' : 'حدّد طبقة' })); return; }
    const add = el('select', { onchange: (ev) => { if (ev.target.value) op('effect.add', { layerId: layer.id, effect: { type: ev.target.value } }); } },
      [el('option', { value: '', text: '+ مؤثر…' })].concat((effectTypes || []).map((t) => el('option', { value: t.type, text: FX_NAMES[t.type] || t.type }))));
    const tint = el('input', { type: 'text', placeholder: 'لون (اختياري)', class: 'tint' });
    const preset = el('select', { onchange: (ev) => { if (ev.target.value) op('effect.applyPreset', { layerId: layer.id, preset: ev.target.value, color: tint.value.trim() || undefined }, `طُبّق: ${PRESET_NAMES[ev.target.value] || ev.target.value}`); } },
      [el('option', { value: '', text: 'إعداد جاهز…' })].concat(presets.map((p) => el('option', { value: p, text: PRESET_NAMES[p] || p }))));
    body.appendChild(el('div', { class: 'props' }, [el('div', { class: 'row' }, [add, preset, tint])]));
    for (const e of layer.effects || []) {
      const header = el('div', { class: 'fx-head' }, [
        el('input', Object.assign({ type: 'checkbox', title: 'تفعيل', onchange: (ev) => op('effect.update', { layerId: layer.id, effectId: e.id, patch: { enabled: ev.target.checked } }) }, e.enabled !== false ? { checked: 'checked' } : {})),
        el('span', { class: 'name', text: FX_NAMES[e.type] || e.type }),
        el('button', { class: 'del', text: '✕', title: 'حذف المؤثر', onclick: () => op('effect.remove', { layerId: layer.id, effectId: e.id }) }),
      ]);
      const details = el('details', { class: 'fx' }, [el('summary', {}, [header]), el('div', { class: 'props' }, effectFields(layer, e))]);
      body.appendChild(details);
    }
  }

  function renderArrange() {
    const body = $('arrangePanelBody');
    if (!body || !state.doc) return;
    body.innerHTML = '';
    const ids = selectedIds();
    const t = (title, text, fn, enabled) => el('button', Object.assign({ class: 'btn small ghost', title, text, onclick: fn }, enabled === false ? { disabled: 'disabled' } : {}));
    const align = (mode) => op('object.align', { objectIds: ids, align: mode, relativeTo: ids.length > 1 ? 'selection' : 'canvas' });
    const boolOp = async (name) => {
      const data = await op('path.boolean', { objectIds: ids, op: name });
      if (data) { setSelection([data.objectId]); afterSelectionChange(); }
    };
    const single = ids.length === 1 ? findObject(ids[0]) : null;
    body.appendChild(el('div', { class: 'props' }, [
      el('div', { class: 'hint full', text: ids.length ? `${ids.length} محدد · Shift للإضافة، اسحب لتحديد مساحة` : 'لا يوجد تحديد' }),
      el('div', { class: 'row' }, [
        t('محاذاة لليسار', '⇤', () => align('left'), ids.length > 0), t('توسيط أفقي', '↔', () => align('center'), ids.length > 0), t('محاذاة لليمين', '⇥', () => align('right'), ids.length > 0),
        t('محاذاة للأعلى', '⤒', () => align('top'), ids.length > 0), t('توسيط رأسي', '↕', () => align('middle'), ids.length > 0), t('محاذاة للأسفل', '⤓', () => align('bottom'), ids.length > 0),
      ]),
      el('div', { class: 'row' }, [
        t('توزيع أفقي بمسافات متساوية', '⋯ أفقي', () => op('object.distribute', { objectIds: ids, axis: 'horizontal' }), ids.length >= 3),
        t('توزيع رأسي بمسافات متساوية', '⋮ رأسي', () => op('object.distribute', { objectIds: ids, axis: 'vertical' }), ids.length >= 3),
      ]),
      el('div', { class: 'row' }, [
        t('دمج', '∪ دمج', () => boolOp('union'), ids.length >= 2), t('طرح الباقي من الأول', '− طرح', () => boolOp('subtract'), ids.length >= 2),
        t('تقاطع', '∩ تقاطع', () => boolOp('intersect'), ids.length >= 2), t('استبعاد التداخل', '⊕ استبعاد', () => boolOp('exclude'), ids.length >= 2),
      ]),
      el('div', { class: 'row' }, [
        t('تحويل الشكل إلى مسار قابل لتحرير النقاط', 'تحويل إلى مسار', async () => { await op('path.fromShape', { objectId: ids[0] }); window.setTool('node'); }, Boolean(single && ['rect', 'ellipse', 'polygon', 'path'].includes(single.object.type))),
        t('تحويل الحد إلى شكل مملوء', 'الحد إلى شكل', () => op('path.outlineStroke', { objectId: ids[0] }), Boolean(single && single.object.stroke)),
        t('تحرير النقاط (A)', 'تحرير النقاط', () => window.setTool('node'), Boolean(single && single.object.type === 'path')),
      ]),
    ]));
  }

  function renderView() {
    const body = $('viewPanelBody');
    if (!body) return;
    body.innerHTML = '';
    const doc = state.doc;
    const toggle = (key, label) => el('label', { class: 'switch' }, [el('input', Object.assign({ type: 'checkbox', onchange: (e) => { view[key] = e.target.checked; saveView(); if (key === 'grid' && view.grid && doc && !doc.canvas.grid) op('document.update', { canvas: { grid: { size: 20, subdivisions: 4 } } }); drawOverlay(); } }, view[key] ? { checked: 'checked' } : {})), el('span', { text: label })]);
    const gridSize = el('input', { type: 'number', min: '1', max: '1000', value: String(doc && doc.canvas.grid ? doc.canvas.grid.size : 20), onchange: (e) => op('document.update', { canvas: { grid: { size: Number(e.target.value), subdivisions: doc && doc.canvas.grid ? doc.canvas.grid.subdivisions : 4 } } }) });
    body.appendChild(el('div', { class: 'props' }, [
      el('div', { class: 'row' }, [toggle('grid', 'الشبكة (Ctrl+\')'), toggle('guides', 'الأدلة (Ctrl+;)'), toggle('snap', 'الالتقاط')]),
      field('حجم الشبكة', gridSize),
      el('div', { class: 'row' }, [
        el('button', { class: 'btn small ghost', text: '+ دليل أفقي', onclick: () => doc && op('guide.add', { orientation: 'horizontal', position: Math.round(doc.canvas.height / 2) }) }),
        el('button', { class: 'btn small ghost', text: '+ دليل عمودي', onclick: () => doc && op('guide.add', { orientation: 'vertical', position: Math.round(doc.canvas.width / 2) }) }),
        el('button', { class: 'btn small danger', text: 'مسح الأدلة', onclick: () => op('guide.clear', {}) }),
      ]),
      el('div', { class: 'hint full', text: 'اسحب الدليل لتحريكه، وأخرجه من اللوحة لحذفه.' }),
    ]));
  }

  function renderHistory() {
    const body = $('historyPanelBody');
    if (!body || !state.history) return;
    body.innerHTML = '';
    const past = state.history.past || [];
    const future = state.history.future || [];
    const list = el('div', { class: 'history-list' });
    list.appendChild(el('div', { class: `history-item${past.length === 0 ? ' current' : ''}`, text: 'البداية', onclick: () => past.length && jump(-past.length) }));
    past.forEach((label, i) => list.appendChild(el('div', { class: `history-item${i === past.length - 1 ? ' current' : ''}`, text: stepName(label), title: label, onclick: () => jump(i + 1 - past.length) })));
    future.forEach((label, i) => list.appendChild(el('div', { class: 'history-item future', text: stepName(label), title: label, onclick: () => jump(i + 1) })));
    body.appendChild(list);
    list.scrollTop = list.scrollHeight;
  }
  async function jump(steps) {
    if (!steps) return;
    await op('history.jump', { steps });
  }

  // ------------------------------------------------------------------ shape parameters panel
  const SHAPE_FIELDS = {
    polygon: [['sides', 'عدد الأضلاع', 1, 3, 60], ['cornerRadius', 'استدارة الزوايا', 1, 0, 2000]],
    star: [['points', 'عدد الرؤوس', 1, 3, 60], ['ratio', 'نسبة العمق', 0.01, 0.05, 0.99], ['cornerRadius', 'استدارة الزوايا', 1, 0, 2000]],
    arc: [['start', 'البداية (°)', 1, -360, 360], ['sweep', 'المسح (°)', 1, 1, 360], ['ratio', 'نصف القطر الداخلي', 0.01, 0, 0.99]],
    spiral: [['turns', 'عدد اللفات', 0.25, 0.25, 40], ['innerRatio', 'المركز', 0.01, 0, 0.9]],
    rect: [['smoothing', 'تنعيم الزوايا (Squircle)', 0.05, 0, 1]],
  };
  const parseRadius = (text) => { const parts = String(text).split(/[,،\s]+/).filter(Boolean).map(Number); return parts.length === 4 && parts.every(Number.isFinite) ? parts : (Number.isFinite(parts[0]) ? parts[0] : 0); };
  function renderShape() {
    const body = $('shapePanelBody');
    if (!body || !state.doc) return;
    body.innerHTML = '';
    const ids = selectedIds();
    const f = ids.length === 1 ? findObject(ids[0]) : null;
    if (!f) { body.appendChild(el('div', { class: 'hint', text: 'حدّد شكلًا: مضلع، نجمة، قوس، حلزون، مستطيل أو دائرة' })); return; }
    const o = f.object;
    const rows = [];
    const numberField = (label, value, step, min, max, onchange) => field(label, el('input', { type: 'number', step: String(step), min: String(min), max: String(max), value: String(Math.round(value * 1000) / 1000), onchange: (e) => onchange(Number(e.target.value)) }));
    if (o.type === 'path' && o.shape) {
      const s = o.shape;
      rows.push(el('div', { class: 'hint', text: { polygon: 'مضلع', star: 'نجمة', arc: 'قوس', spiral: 'حلزون', rect: 'مستطيل بزوايا ناعمة' }[s.kind] }));
      for (const [key, label, step, min, max] of SHAPE_FIELDS[s.kind]) rows.push(numberField(label, s[key], step, min, max, (v) => op('shape.update', { objectId: o.id, params: { [key]: v } })));
      if (s.kind === 'rect') rows.push(field('نصف قطر الزوايا (أو 4 قيم)', el('input', { type: 'text', value: Array.isArray(s.radius) ? s.radius.join(',') : String(s.radius), onchange: (e) => op('shape.update', { objectId: o.id, params: { radius: parseRadius(e.target.value) } }) })));
      if (s.kind === 'spiral') {
        const g = el('select', { onchange: (e) => op('shape.update', { objectId: o.id, params: { growth: e.target.value } }) }, [el('option', { value: 'archimedean', text: 'منتظم' }), el('option', { value: 'logarithmic', text: 'لوغاريتمي' })]);
        g.value = s.growth; rows.push(field('النمو', g));
        const d = el('select', { onchange: (e) => op('shape.update', { objectId: o.id, params: { direction: e.target.value } }) }, [el('option', { value: 'cw', text: 'مع عقارب الساعة' }), el('option', { value: 'ccw', text: 'عكس عقارب الساعة' })]);
        d.value = s.direction; rows.push(field('الاتجاه', d));
      }
      rows.push(el('div', { class: 'hint', text: 'تحرير النقاط (A) يحوّله إلى متجه حر' }));
    } else if (o.type === 'rect') {
      rows.push(field('نصف قطر الزوايا (أو 4 قيم)', el('input', { type: 'text', value: Array.isArray(o.radius) ? o.radius.join(',') : String(o.radius || 0), onchange: (e) => op('object.update', { objectId: o.id, patch: { radius: parseRadius(e.target.value) } }) })));
      rows.push(numberField('تنعيم الزوايا (Squircle)', 0, 0.05, 0, 1, (v) => { if (v > 0) op('shape.convert', { objectId: o.id, smoothing: v }); }));
    } else if (o.type === 'ellipse') {
      rows.push(el('div', { class: 'row' }, [el('button', { class: 'btn small', text: 'تحويل إلى قوس / حلقة', onclick: () => op('shape.convert', { objectId: o.id, sweep: 270 }) })]));
    } else {
      rows.push(el('div', { class: 'hint', text: 'لا معاملات شكل لهذا العنصر' }));
    }
    body.appendChild(el('div', { class: 'props' }, rows));
  }

  function afterLoad() {
    renderShape();
    renderLayerProps();
    renderEffects();
    renderAdjustments();
    renderArrange();
    renderView();
    renderHistory();
  }

  return { pointerDown, pointerMove, pointerUp, keydown, drawOverlay, renderLayers, buildPanels, afterLoad, hitTest, selectedIds, setSelection, finishToolSession, renderShape };
})();
