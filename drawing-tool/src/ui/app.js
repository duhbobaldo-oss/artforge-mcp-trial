'use strict';

/* global ArtForgeCore */

const R = ArtForgeCore.renderer;

const state = {
  doc: null,
  docId: null,
  revision: 0,
  history: { canUndo: false, canRedo: false },
  docs: [],
  fonts: [],
  assets: [],
  images: {},
  tool: 'select',
  zoom: 1,
  selection: null,
  selectedLayerId: null,
  drag: null,
  previewObject: null,
  playTime: 0,
  playing: false,
  log: [],
  swatches: ['#38bdf8', '#a855f7', '#f8fafc', '#0b1220', '#22c55e', '#f59e0b', '#ef4444', '#94a3b8'],
  gradient: { type: 'linear', angle: 135, active: 0, stops: [{ offset: 0, color: '#38bdf8' }, { offset: 1, color: '#a855f7' }] },
};

const $ = (id) => document.getElementById(id);
const viewport = $('viewport');
const overlay = $('overlay');

/* ------------------------------------------------------------------ helpers */

function toast(message, isError) {
  const el = $('toast');
  el.textContent = message;
  el.className = `toast${isError ? ' error' : ''}`;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.add('hidden'), 4200);
}

async function call(op, params) {
  const res = await fetch('/api/op', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ op, params: params || {} }),
  });
  const json = await res.json();
  if (!json.ok) throw new Error(`${json.error.code}: ${json.error.message}`);
  return json.data;
}

async function guarded(fn) {
  try {
    return await fn();
  } catch (error) {
    toast(error.message, true);
    console.error(error);
    return null;
  }
}

function el(tag, attrs, children) {
  const node = document.createElement(tag);
  Object.entries(attrs || {}).forEach(([key, value]) => {
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else if (value !== undefined && value !== null) node.setAttribute(key, value);
  });
  (children || []).forEach((child) => node.appendChild(child));
  return node;
}

function num(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/* ------------------------------------------------------------------- panels */

function buildPanels() {
  const panels = $('panels');
  panels.innerHTML = '';

  panels.appendChild(el('section', { class: 'panel' }, [
    el('header', {}, [
      el('span', { text: 'الطبقات' }),
      el('button', { class: 'mini', id: 'btnAddLayer', text: '+ طبقة', onclick: addLayer }),
    ]),
    el('div', { class: 'layer-list', id: 'layerList' }),
  ]));

  panels.appendChild(el('section', { class: 'panel' }, [
    el('header', {}, [el('span', { text: 'الخصائص' }), el('span', { class: 'hint', id: 'selectionHint', text: 'لا يوجد تحديد' })]),
    el('div', { class: 'props' }, [
      el('label', { text: 'X' }, [el('input', { id: 'propX', type: 'number', step: '1' })]),
      el('label', { text: 'Y' }, [el('input', { id: 'propY', type: 'number', step: '1' })]),
      el('label', { text: 'العرض' }, [el('input', { id: 'propW', type: 'number', step: '1' })]),
      el('label', { text: 'الارتفاع' }, [el('input', { id: 'propH', type: 'number', step: '1' })]),
      el('label', { text: 'الدوران' }, [el('input', { id: 'propRot', type: 'number', step: '1' })]),
      el('label', { text: 'الشفافية' }, [el('input', { id: 'propOpacity', type: 'number', step: '0.05', min: '0', max: '1' })]),
      el('label', { text: 'تعبئة' }, [el('div', { class: 'color-field' }, [colorChip('propFill', 'fill'), el('input', { id: 'propFill', type: 'text', placeholder: '#38bdf8', dir: 'ltr' })])]),
      el('label', { text: 'حدود' }, [el('div', { class: 'color-field' }, [colorChip('propStroke', 'stroke'), el('input', { id: 'propStroke', type: 'text', placeholder: '#94a3b8', dir: 'ltr' })])]),
      el('label', { text: 'سماكة الحد' }, [el('input', { id: 'propStrokeWidth', type: 'number', step: '1', min: '0' })]),
      el('div', { class: 'row' }, [
        el('button', { class: 'btn small', id: 'btnApplyProps', text: 'تطبيق', onclick: applyProps }),
        el('button', { class: 'btn small ghost', id: 'btnDuplicate', text: 'نسخ', onclick: duplicateObject }),
        el('button', { class: 'btn small danger', id: 'btnDeleteObject', text: 'حذف', onclick: deleteObject }),
      ]),
    ]),
  ]));

  panels.appendChild(el('section', { class: 'panel' }, [
    el('header', {}, [
      el('span', { text: 'النص والخطوط' }),
      el('label', { class: 'switch' }, [
        el('input', { id: 'arabicOnly', type: 'checkbox', checked: 'checked', onchange: loadFonts }),
        el('span', { text: 'عربية فقط' }),
      ]),
    ]),
    el('div', { class: 'props' }, [
      el('label', { class: 'full', text: 'الخط' }, [el('select', { id: 'fontFamily' })]),
      el('label', { text: 'الحجم' }, [el('input', { id: 'fontSize', type: 'number', value: '48', min: '4', max: '800' })]),
      el('label', { text: 'الوزن' }, [el('select', { id: 'fontWeight' }, [
        el('option', { value: '400', text: 'عادي 400' }),
        el('option', { value: '700', text: 'عريض 700' }),
      ])]),
      el('label', { text: 'المحاذاة' }, [el('select', { id: 'textAlign' }, [
        el('option', { value: 'right', text: 'يمين (RTL)' }),
        el('option', { value: 'center', text: 'وسط' }),
        el('option', { value: 'left', text: 'يسار' }),
      ])]),
      el('label', { class: 'full', text: 'النص' }, [el('textarea', { id: 'textContent', rows: '3', placeholder: 'اكتب النص العربي هنا…' })]),
      el('div', { class: 'row' }, [
        el('button', { class: 'btn small', id: 'btnAddText', text: 'إضافة نص', onclick: addTextAtCenter }),
        el('button', { class: 'btn small ghost', id: 'btnUpdateText', text: 'تحديث المحدد', onclick: updateSelectedText }),
      ]),
    ]),
  ]));

  panels.appendChild(el('section', { class: 'panel' }, [
    el('header', {}, [el('span', { text: 'الألوان والتدرجات' })]),
    el('div', { class: 'props' }, [
      el('div', { class: 'swatches', id: 'swatches' }),
      el('div', { class: 'row' }, [el('button', { class: 'btn small', id: 'btnPicker', text: '🎨 منتقي الألوان والمكتبة…', onclick: (e) => openPickerFor('propFill', 'fill', e.currentTarget) })]),
      el('div', { class: 'full grad-head' }, [
        el('span', { text: 'التدرج' }),
        el('select', { id: 'gradType', onchange: (e) => { state.gradient.type = e.target.value; renderGradientEditor(); } }, [
          el('option', { value: 'linear', text: 'خطي' }), el('option', { value: 'radial', text: 'دائري' }), el('option', { value: 'conic', text: 'مخروطي' }),
        ]),
      ]),
      el('div', { class: 'full grad-bar', id: 'gradBar', dir: 'ltr' }),
      el('label', { text: 'الزاوية' }, [el('input', { id: 'gradAngle', type: 'number', value: '135', step: '5', onchange: (e) => { state.gradient.angle = num(e.target.value, 0); } })]),
      el('div', { class: 'row' }, [
        el('button', { class: 'btn small ghost', id: 'btnStopColor', text: 'لون النقطة', onclick: (e) => editStopColor(e.currentTarget) }),
        el('button', { class: 'btn small ghost', id: 'btnStopDelete', text: 'حذف النقطة', onclick: deleteStop }),
      ]),
      el('div', { class: 'row' }, [
        el('button', { class: 'btn small', id: 'btnApplyGradient', text: 'تدرج على التحديد', onclick: applyGradientToSelection }),
        el('button', { class: 'btn small ghost', id: 'btnBgGradient', text: 'تدرج الخلفية', onclick: applyBackgroundGradient }),
      ]),
    ]),
  ]));

  panels.appendChild(el('section', { class: 'panel' }, [
    el('header', {}, [
      el('span', { text: 'الحركة' }),
      el('button', { class: 'mini', id: 'btnPlay', text: 'تشغيل', onclick: togglePlay }),
    ]),
    el('div', { class: 'props' }, [
      el('label', { text: 'المدة (ms)' }, [el('input', { id: 'animDuration', type: 'number', value: '2400', step: '100', min: '200' })]),
      el('label', { text: 'إطار/ثانية' }, [el('input', { id: 'animFps', type: 'number', value: '12', min: '1', max: '60' })]),
      el('label', { class: 'full', text: 'الزمن' }, [el('input', { id: 'animTime', type: 'range', min: '0', max: '2400', value: '0', step: '20', oninput: onTimeInput })]),
      el('label', { text: 'الخاصية' }, [el('select', { id: 'animProp' }, [
        el('option', { value: 'opacity', text: 'الشفافية' }),
        el('option', { value: 'x', text: 'X' }),
        el('option', { value: 'y', text: 'Y' }),
        el('option', { value: 'rotation', text: 'الدوران' }),
        el('option', { value: 'scale', text: 'الحجم' }),
      ])]),
      el('label', { text: 'القيمة' }, [el('input', { id: 'animValue', type: 'number', value: '1', step: '0.1' })]),
      el('div', { class: 'row' }, [
        el('button', { class: 'btn small', id: 'btnAddKey', text: 'إضافة مفتاح', onclick: addKeyframe }),
        el('button', { class: 'btn small ghost', id: 'btnExportFrames', text: 'تصدير الإطارات', onclick: exportFrames }),
      ]),
    ]),
  ]));

  panels.appendChild(el('section', { class: 'panel grow' }, [
    el('header', {}, [
      el('span', { text: 'سجل العمليات الحيّة' }),
      el('button', { class: 'mini', id: 'btnClearLog', text: 'تفريغ', onclick: () => { state.log = []; renderLog(); } }),
    ]),
    el('div', { class: 'log', id: 'logList' }),
  ]));

  renderSwatches();
  renderGradientEditor();
  Editor.buildPanels(panels);
}

function renderSwatches() {
  const box = $('swatches');
  if (!box) return;
  box.innerHTML = '';
  state.swatches.forEach((color) => {
    box.appendChild(el('button', {
      class: 'swatch',
      title: color,
      style: `background:${color}`,
      onclick: () => setColorField('propFill', 'fill', color, true),
    }));
  });
}

/* ---------------------------------------------------------- colour picker wiring */

function colorChip(inputId, field) {
  return el('button', { class: 'color-chip', id: `${inputId}Chip`, title: 'منتقي الألوان', onclick: (e) => { e.preventDefault(); openPickerFor(inputId, field, e.currentTarget); } });
}

// Every solid colour used in the document, most used first (picker: "ألوان المستند").
function documentColors() {
  const counts = new Map();
  const addColor = (c) => { if (typeof c === 'string' && /^(#|rgb)/i.test(c)) counts.set(c.toLowerCase(), (counts.get(c.toLowerCase()) || 0) + 1); };
  for (const layer of (state.doc ? state.doc.layers : [])) {
    for (const o of layer.objects || []) {
      for (const paint of [o.fill, o.stroke, o.color]) {
        if (typeof paint === 'string') addColor(paint);
        else if (paint && Array.isArray(paint.stops)) paint.stops.forEach((s) => addColor(s.color));
      }
    }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([c]) => c);
}

// Lines and open paths are coloured by their stroke.
function strokeOnly(object) { return object.type === 'line' || (object.type === 'path' && !object.closed && !object.fill); }

async function applyColorToSelection(field, color) {
  const ids = Editor.selectedIds();
  if (!ids.length) return;
  await guarded(async () => {
    for (const id of ids) {
      const found = findObject(id);
      if (!found) continue;
      const key = field === 'fill' && strokeOnly(found.object) ? 'stroke' : field;
      await call('object.update', { documentId: state.docId, objectId: id, patch: { [key]: color } });
    }
    await loadDocument(state.docId);
    updateStatusAfterMutation();
  });
}

function setColorField(inputId, field, color, final) {
  const input = $(inputId);
  if (input) input.value = color;
  const chip = $(`${inputId}Chip`);
  if (chip) chip.style.background = color;
  if (final) applyColorToSelection(field, color);
}

function openPickerFor(inputId, field, anchorEl) {
  const input = $(inputId);
  ColorPicker.open(anchorEl || input, (input && input.value.trim()) || '#38bdf8', (color, final) => setColorField(inputId, field, color, final), { documentColors });
}

/* ---------------------------------------------------------- gradient editor (multi-stop) */

function interpolateColor(a, b, t) {
  const p = ColorPicker.parse(a) || { r: 0, g: 0, b: 0, a: 1 }; const q = ColorPicker.parse(b) || p;
  const m = (x, y) => Math.round(x + (y - x) * t);
  return `#${[m(p.r, q.r), m(p.g, q.g), m(p.b, q.b)].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}
function colorAt(stops, offset) {
  const s = stops.slice().sort((a, b) => a.offset - b.offset);
  if (offset <= s[0].offset) return s[0].color;
  for (let i = 1; i < s.length; i += 1) if (offset <= s[i].offset) return interpolateColor(s[i - 1].color, s[i].color, (offset - s[i - 1].offset) / ((s[i].offset - s[i - 1].offset) || 1));
  return s[s.length - 1].color;
}
function renderGradientEditor() {
  const bar = $('gradBar');
  if (!bar) return;
  initGradientBar();
  const g = state.gradient;
  if ($('gradType')) $('gradType').value = g.type;
  if ($('gradAngle')) { $('gradAngle').value = String(g.angle); $('gradAngle').disabled = g.type === 'radial'; }
  const stops = g.stops.slice().sort((a, b) => a.offset - b.offset);
  bar.style.background = `linear-gradient(90deg, ${stops.map((s) => `${s.color} ${Math.round(s.offset * 100)}%`).join(', ')})`;
  bar.innerHTML = '';
  g.stops.forEach((stop, i) => {
    const handle = el('span', { class: `grad-stop${i === g.active ? ' active' : ''}`, title: `${stop.color} @ ${Math.round(stop.offset * 100)}%`, style: `left:${stop.offset * 100}%;background:${stop.color}` });
    handle.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      g.active = i;
      handle.setPointerCapture(e.pointerId);
      const rect = bar.getBoundingClientRect();
      const move = (ev) => { stop.offset = Math.max(0, Math.min(1, (ev.clientX - rect.left) / rect.width)); renderGradientEditor(); };
      const up = () => { handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', up); renderGradientEditor(); };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
      renderGradientEditor();
    });
    handle.addEventListener('dblclick', () => { g.active = i; editStopColor(handle); });
    bar.appendChild(handle);
  });
}
function initGradientBar() {
  const bar = $('gradBar');
  if (!bar || bar.dataset.bound) return;
  bar.dataset.bound = '1';
  bar.addEventListener('pointerdown', (e) => {
    const rect = bar.getBoundingClientRect();
    const offset = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    state.gradient.stops.push({ offset, color: colorAt(state.gradient.stops, offset) });
    state.gradient.active = state.gradient.stops.length - 1;
    renderGradientEditor();
  });
}
function editStopColor(anchorEl) {
  const g = state.gradient; const stop = g.stops[g.active] || g.stops[0];
  ColorPicker.open(anchorEl, stop.color, (color) => { stop.color = color; renderGradientEditor(); }, { documentColors });
}
function deleteStop() {
  const g = state.gradient;
  if (g.stops.length <= 2) { toast('التدرج يحتاج نقطتين على الأقل', true); return; }
  g.stops.splice(g.active, 1);
  g.active = 0;
  renderGradientEditor();
}

/* --------------------------------------------------------------- data loads */

// The engine renders bundled fonts (Tajawal, Amiri, Almarai) from fonts/*.ttf; the browser must load the
// same files under the same family names, or the live view silently falls back to a system font while
// exports use the real one. System fonts need nothing: the browser already has them.
const registeredFontFiles = new Set();
async function registerBundledFonts(fonts) {
  if (typeof FontFace !== 'function' || !document.fonts) return;
  const pending = fonts
    .filter((font) => font.source === 'bundled' && font.file && !registeredFontFiles.has(font.file))
    .map(async (font) => {
      registeredFontFiles.add(font.file);
      try {
        const face = new FontFace(font.family, `url(${encodeURI(font.file)})`, { weight: String(font.weight || 400), style: font.style || 'normal' });
        document.fonts.add(await face.load());
      } catch (error) {
        registeredFontFiles.delete(font.file);
        console.warn(`ArtForge: bundled font ${font.family} ${font.weight} failed to load`, error);
      }
    });
  await Promise.all(pending);
}

async function loadFonts() {
  const arabicOnly = $('arabicOnly') && $('arabicOnly').checked ? '?arabicOnly=1' : '';
  const res = await fetch(`/api/fonts${arabicOnly}`);
  const json = await res.json();
  if (!json.ok) return;
  state.fonts = json.data.fonts;
  await registerBundledFonts(state.fonts);
  const select = $('fontFamily');
  select.innerHTML = '';
  state.fonts.forEach((font) => {
    const label = `${font.family}${font.source === 'bundled' ? ' ★' : ''}${font.arabic ? '' : ' — بلا عربية'}`;
    select.appendChild(el('option', { value: font.family, text: label }));
  });
  const preferred = state.fonts.find((font) => font.family === 'Tajawal')
    || state.fonts.find((font) => font.arabic)
    || state.fonts[0];
  if (preferred) select.value = preferred.family;
}

async function loadAssets() {
  const data = await call('image.list', {});
  state.assets = data.assets;
  if(state.doc) for(const layer of state.doc.layers)for(const object of layer.objects){const id=object.fill&&object.fill.imageId;if(id&&!state.assets.some(a=>a.id===id))state.assets.push({id,url:'/api/materials/'+id});}
  const pending = state.assets
    .filter((asset) => !state.images[asset.id])
    .map((asset) => new Promise((resolve) => {
      const img = new Image();
      img.onload = () => { state.images[asset.id] = img; resolve(); };
      img.onerror = () => resolve();
      img.src = asset.url;
    }));
  // Pixel layers: content-addressed 256px tiles, keyed as the renderer expects ("tile:<sha256>").
  if (state.doc) {
    for (const layer of state.doc.layers) {
      if (!layer.raster) continue;
      for (const hash of Object.values(layer.raster.tiles)) {
        const key = `tile:${hash}`;
        if (state.images[key] || !/^[a-f0-9]{64}$/.test(hash)) continue;
        pending.push(new Promise((resolve) => {
          const img = new Image();
          img.onload = () => { state.images[key] = img; resolve(); };
          img.onerror = () => resolve();
          img.src = `/assets/tiles/${hash}.png`;
        }));
      }
    }
  }
  await Promise.all(pending);
}

// Layer groups: entries with type 'group' hold no objects; layers point at their group via parentId.
const isGroupLayer = (layer) => Boolean(layer && layer.type === 'group');
function layerAncestors(layer) {
  const out = [];
  let cursor = layer;
  while (cursor && cursor.parentId && out.length < 12) {
    cursor = state.doc.layers.find((item) => item.id === cursor.parentId);
    if (cursor) out.push(cursor);
  }
  return out;
}
const layerShown = (layer) => layer.visible !== false && layerAncestors(layer).every((g) => g.visible !== false);
function topDrawableLayer(doc) {
  const drawable = doc.layers.filter((layer) => !isGroupLayer(layer));
  return drawable.length ? drawable[drawable.length - 1] : doc.layers[doc.layers.length - 1];
}

// Where new objects go: the selected layer, or, when a group is selected, its topmost drawable layer.
function drawLayerId() {
  const selected = state.doc && state.doc.layers.find((layer) => layer.id === state.selectedLayerId);
  if (!selected || !isGroupLayer(selected)) return state.selectedLayerId;
  const inside = state.doc.layers.filter((layer) => !isGroupLayer(layer) && layerAncestors(layer).includes(selected));
  return inside.length ? inside[inside.length - 1].id : topDrawableLayer(state.doc).id;
}

function findObject(objectId) {
  if (!state.doc) return null;
  for (const layer of state.doc.layers) {
    const object = layer.objects.find((item) => item.id === objectId);
    if (object) return { layer, object };
  }
  return null;
}

async function loadDocument(docId) {
  const data = await call('document.info', { documentId: docId });
  state.doc = data.document;
  state.docId = data.documentId;
  state.revision = data.revision;
  state.history = data.history;
  if (!state.selectedLayerId || !state.doc.layers.some((layer) => layer.id === state.selectedLayerId)) {
    state.selectedLayerId = topDrawableLayer(state.doc).id;
  }
  if (state.selection && !findObject(state.selection.objectId)) state.selection = null;
  await loadAssets();
  fitZoom();
  render();
  renderLayers();
  syncProps();
  updateStatus();
  Editor.afterLoad();
  $('docName').value = state.doc.name;
  const slider = $('animTime');
  if (slider) {
    slider.max = String(state.doc.animation.duration);
    $('animDuration').value = String(state.doc.animation.duration);
    $('animFps').value = String(state.doc.animation.fps);
  }
}

/* ------------------------------------------------------------------ drawing */

function fitZoom() {
  if (!state.doc) return;
  const bounds = $('stageScroll').getBoundingClientRect();
  const zoom = Math.min(
    (bounds.width - 60) / state.doc.canvas.width,
    (bounds.height - 60) / state.doc.canvas.height,
    1,
  );
  state.zoom = Math.max(0.05, zoom);
}

function buildPreviewDoc() {
  if (state.previewDocOverride) return state.previewDocOverride;
  const preview = state.previewObject;
  if (!preview) return state.doc;
  const doc = Object.assign({}, state.doc, {
    layers: state.doc.layers.map((layer) => Object.assign({}, layer, { objects: layer.objects.slice() })),
  });
  const targetLayerId = preview.layerId || state.selectedLayerId || topDrawableLayer(doc).id;
  const chosen = doc.layers.find((item) => item.id === targetLayerId);
  const layer = chosen && !isGroupLayer(chosen) ? chosen : topDrawableLayer(doc);
  if (preview.replaceId) {
    const index = layer.objects.findIndex((item) => item.id === preview.replaceId);
    if (index >= 0) layer.objects[index] = preview.object;
    else layer.objects.push(preview.object);
  } else {
    layer.objects.push(preview.object);
  }
  return doc;
}

function drawChecker(ctx, width, height) {
  const size = 16;
  ctx.save();
  ctx.fillStyle = '#0a0f16';
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = '#131b25';
  for (let y = 0; y < height; y += size) {
    for (let x = 0; x < width; x += size) {
      if (((x / size) + (y / size)) % 2 === 0) ctx.fillRect(x, y, size, size);
    }
  }
  ctx.restore();
}

function render() {
  const doc = state.doc;
  if (!doc) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const cssWidth = Math.max(1, Math.round(doc.canvas.width * state.zoom));
  const cssHeight = Math.max(1, Math.round(doc.canvas.height * state.zoom));
  const pixelWidth = Math.round(cssWidth * dpr);
  const pixelHeight = Math.round(cssHeight * dpr);
  for (const canvas of [viewport, overlay]) {
    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
      canvas.width = pixelWidth;
      canvas.height = pixelHeight;
    }
    canvas.style.width = `${cssWidth}px`;
    canvas.style.height = `${cssHeight}px`;
  }
  $('stageInner').style.width = `${cssWidth}px`;
  $('stageInner').style.height = `${cssHeight}px`;
  const ctx = viewport.getContext('2d');
  ctx.setTransform(pixelWidth / doc.canvas.width, 0, 0, pixelHeight / doc.canvas.height, 0, 0);
  drawChecker(ctx, doc.canvas.width, doc.canvas.height);
  R.render(ctx, buildPreviewDoc(), { time: state.playTime, images: state.images, warnings: [] });
  drawOverlay();
}

// Selection handles, node editing, guides, grid and snap lines live in editor.js.
function drawOverlay() {
  Editor.drawOverlay();
}

function updateStatus() {
  const toolNames = {
    select: 'تحديد', node: 'تحرير النقاط', rect: 'مستطيل', ellipse: 'دائرة', line: 'خط', freehand: 'رسم حر', text: 'نص', image: 'صورة',
  };
  $('statusTool').textContent = `الأداة: ${toolNames[state.tool] || state.tool}`;
  $('statusZoom').textContent = `تكبير ${Math.round(state.zoom * 100)}%`;
  $('statusRev').textContent = `إصدار المستند: ${state.revision}`;
}

/* ------------------------------------------------------------------- panels */

function renderLayers() {
  Editor.renderLayers();
}

function syncProps() {
  const found = state.selection ? findObject(state.selection.objectId) : null;
  $('selectionHint').textContent = found ? `${found.object.type} · ${found.object.id.slice(-6)}` : 'لا يوجد تحديد';
  if (!found) return;
  const object = found.object;
  const measure = viewport.getContext('2d');
  const box = R.bboxOf(object, measure);
  $('propX').value = Math.round(num(object.x, box.x));
  $('propY').value = Math.round(num(object.y, box.y));
  $('propW').value = Math.round(num(object.w, box.w));
  $('propH').value = Math.round(num(object.h, box.h));
  $('propRot').value = num(object.rotation, 0);
  $('propOpacity').value = num(object.opacity, 1);
  $('propFill').value = typeof object.fill === 'string' ? object.fill : '';
  $('propStroke').value = typeof object.stroke === 'string' ? object.stroke : '';
  if ($('propFillChip')) $('propFillChip').style.background = $('propFill').value || 'transparent';
  if ($('propStrokeChip')) $('propStrokeChip').style.background = $('propStroke').value || 'transparent';
  $('propStrokeWidth').value = num(object.strokeWidth, 0);
  if (object.type === 'text') {
    $('textContent').value = object.text || '';
    $('fontSize').value = object.font ? object.font.size : 48;
    if (object.font && object.font.family) $('fontFamily').value = object.font.family;
    if (object.font && object.font.weight) $('fontWeight').value = String(object.font.weight);
    $('textAlign').value = object.align || 'right';
  }
}

function updateStatusAfterMutation() {
  renderLayers();
  syncProps();
  updateStatus();
  render();
}

async function addLayer() {
  await guarded(async () => {
    const name = prompt('اسم الطبقة', `طبقة ${(state.doc ? state.doc.layers.length : 0) + 1}`);
    if (name === null) return;
    const data = await call('layer.add', { documentId: state.docId, name });
    state.selectedLayerId = data.layerId;
    await loadDocument(state.docId);
    toast(`أُضيفت الطبقة: ${name}`);
  });
}

async function toggleLayerVisibility(layer) {
  await guarded(async () => {
    await call('layer.update', { documentId: state.docId, layerId: layer.id, visible: !layer.visible });
    await loadDocument(state.docId);
  });
}

async function deleteLayer(layerId) {
  await guarded(async () => {
    await call('layer.delete', { documentId: state.docId, layerId });
    await loadDocument(state.docId);
    toast('حُذفت الطبقة');
  });
}

async function applyProps() {
  const found = state.selection ? findObject(state.selection.objectId) : null;
  if (!found) { toast('حدّد عنصرًا أولًا', true); return; }
  await guarded(async () => {
    const patch = {
      x: num($('propX').value, num(found.object.x, 0)),
      y: num($('propY').value, num(found.object.y, 0)),
      rotation: num($('propRot').value, 0),
      opacity: num($('propOpacity').value, 1),
    };
    if (found.object.w !== undefined) patch.w = num($('propW').value, found.object.w);
    if (found.object.h !== undefined) patch.h = num($('propH').value, found.object.h);
    const fill = $('propFill').value.trim();
    if (fill) patch.fill = fill;
    const stroke = $('propStroke').value.trim();
    if (stroke) patch.stroke = stroke;
    const strokeWidth = num($('propStrokeWidth').value, 0);
    if (strokeWidth > 0) patch.strokeWidth = strokeWidth;
    await call('object.update', { documentId: state.docId, objectId: found.object.id, patch });
    await loadDocument(state.docId);
    updateStatusAfterMutation();
    toast('حُدّثت الخصائص');
  });
}

async function duplicateObject() {
  const found = state.selection ? findObject(state.selection.objectId) : null;
  if (!found) { toast('حدّد عنصرًا أولًا', true); return; }
  await guarded(async () => {
    const data = await call('object.duplicate', { documentId: state.docId, objectId: found.object.id });
    state.selection = { objectId: data.objectId };
    await loadDocument(state.docId);
    updateStatusAfterMutation();
  });
}

async function deleteObject() {
  const found = state.selection ? findObject(state.selection.objectId) : null;
  if (!found) { toast('حدّد عنصرًا أولًا', true); return; }
  await guarded(async () => {
    await call('object.delete', { documentId: state.docId, objectId: found.object.id });
    state.selection = null;
    await loadDocument(state.docId);
    updateStatusAfterMutation();
  });
}

/* --------------------------------------------------------------- text/color */

function textParams(x, y) {
  return {
    documentId: state.docId,
    layerId: drawLayerId(),
    x,
    y,
    text: $('textContent').value || 'نص جديد',
    font: {
      family: $('fontFamily').value,
      size: num($('fontSize').value, 48),
      weight: num($('fontWeight').value, 400),
      lineHeight: 1.4,
    },
    align: $('textAlign').value,
    fill: $('propFill').value.trim() || '#f8fafc',
  };
}

async function addTextAtCenter() {
  await guarded(async () => {
    const doc = state.doc;
    const x = $('textAlign').value === 'right' ? doc.canvas.width - 80 : doc.canvas.width / 2;
    const data = await call('draw.text', textParams(x, Math.round(doc.canvas.height / 2)));
    state.selection = { objectId: data.objectId };
    await loadDocument(state.docId);
    updateStatusAfterMutation();
    toast('أُضيف النص العربي');
  });
}

async function updateSelectedText() {
  const found = state.selection ? findObject(state.selection.objectId) : null;
  if (!found || found.object.type !== 'text') { toast('حدّد عنصر نص أولًا', true); return; }
  await guarded(async () => {
    await call('object.update', {
      documentId: state.docId,
      objectId: found.object.id,
      patch: {
        text: $('textContent').value,
        font: {
          family: $('fontFamily').value,
          size: num($('fontSize').value, 48),
          weight: num($('fontWeight').value, 400),
          lineHeight: 1.4,
        },
        align: $('textAlign').value,
      },
    });
    await loadDocument(state.docId);
    updateStatusAfterMutation();
    toast('حُدّث النص');
  });
}

function gradientPaint() {
  const g = state.gradient;
  const stops = g.stops.slice().sort((a, b) => a.offset - b.offset).map((s) => ({ offset: Math.round(s.offset * 1000) / 1000, color: s.color }));
  if (g.type === 'radial') return { type: 'radial', cx: 0.5, cy: 0.5, stops };
  if (g.type === 'conic') return { type: 'conic', angle: g.angle, cx: 0.5, cy: 0.5, stops };
  return { type: 'linear', angle: g.angle, stops };
}

async function applyGradientToSelection() {
  const found = state.selection ? findObject(state.selection.objectId) : null;
  if (!found) { toast('حدّد شكلًا أولًا', true); return; }
  await guarded(async () => {
    await call('object.update', {
      documentId: state.docId,
      objectId: found.object.id,
      patch: { fill: gradientPaint() },
    });
    await loadDocument(state.docId);
    updateStatusAfterMutation();
    toast('طُبّق التدرج');
  });
}

async function applyBackgroundGradient() {
  await guarded(async () => {
    await call('document.update', {
      documentId: state.docId,
      canvas: { background: { type: 'gradient', gradient: gradientPaint() } },
    });
    await loadDocument(state.docId);
    toast('تدرّجت الخلفية');
  });
}

/* ---------------------------------------------------------------- animation */

function onTimeInput() {
  state.playTime = num($('animTime').value, 0);
  render();
}

function togglePlay() {
  state.playing = !state.playing;
  $('btnPlay').textContent = state.playing ? 'إيقاف' : 'تشغيل';
  if (!state.playing) return;
  let last = performance.now();
  const tick = (now) => {
    if (!state.playing || !state.doc) return;
    const dt = now - last;
    last = now;
    state.playTime += dt;
    const duration = state.doc.animation.duration || 1000;
    if (state.playTime > duration) state.playTime = 0;
    $('animTime').value = String(Math.round(state.playTime));
    render();
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

async function addKeyframe() {
  const found = state.selection ? findObject(state.selection.objectId) : null;
  if (!found) { toast('حدّد عنصرًا أولًا', true); return; }
  await guarded(async () => {
    await call('animation.set', {
      documentId: state.docId,
      enabled: true,
      duration: num($('animDuration').value, state.doc.animation.duration),
      fps: num($('animFps').value, state.doc.animation.fps),
    });
    await call('animation.addKey', {
      documentId: state.docId,
      targetId: found.object.id,
      property: $('animProp').value,
      time: num($('animTime').value, 0),
      value: num($('animValue').value, 0),
    });
    await loadDocument(state.docId);
    toast('أُضيف مفتاح تحريك');
  });
}

async function exportFrames() {
  await guarded(async () => {
    const data = await call('export.frames', {
      documentId: state.docId,
      fps: num($('animFps').value, 12),
    });
    toast(`صُدّر ${data.frames} إطارًا إلى ${data.dir}`);
    pushLog({ type: 'operation', op: 'export.frames', ok: true, message: `${data.frames} frames → ${data.dir}` });
  });
}

/* --------------------------------------------------------------------- log */

function pushLog(entry) {
  state.log.unshift(entry);
  if (state.log.length > 120) state.log.pop();
  renderLog();
}

function renderLog() {
  const box = $('logList');
  if (!box) return;
  box.innerHTML = '';
  if (!state.log.length) {
    box.appendChild(el('div', { class: 'log-entry', text: 'لا توجد عمليات بعد…' }));
    return;
  }
  state.log.forEach((entry) => {
    const time = (entry.at || '').slice(11, 19);
    const label = entry.op || entry.type;
    const detail = entry.ok === false
      ? `${entry.error || 'خطأ'}: ${entry.message || ''}`
      : `${entry.durationMs !== undefined ? `${entry.durationMs} ms` : ''}${entry.revision ? ` · rev ${entry.revision}` : ''}`;
    box.appendChild(el('div', { class: `log-entry${entry.ok === false ? ' err' : ''}` }, [
      el('div', { class: 'op', text: `${time} — ${label}` }),
      el('div', { text: detail }),
    ]));
  });
}

function connectEvents() {
  const source = new EventSource('/api/events');
  source.onmessage = (message) => {
    let event;
    try { event = JSON.parse(message.data); } catch { return; }
    if (event.type === 'hello') return;
    if (event.type === 'operation') {
      pushLog(event);
      return;
    }
    if (event.type === 'document-change' && event.documentId === state.docId) {
      if (event.op && event.op.startsWith('history.')) return;
      clearTimeout(connectEvents.timer);
      connectEvents.timer = setTimeout(() => {
        if (state.docId) loadDocument(state.docId).catch(() => {});
      }, 150);
    }
  };
  source.onerror = () => { /* browser retries automatically */ };
}

/* ---------------------------------------------------------------- pointers */

function canvasPoint(event) {
  const rect = viewport.getBoundingClientRect();
  return {
    x: (event.clientX - rect.left) / state.zoom,
    y: (event.clientY - rect.top) / state.zoom,
    p: event.pointerType === 'pen' && Number.isFinite(event.pressure) ? Math.max(0,Math.min(1,event.pressure)) : 0.5,
  };
}

function hitTest(point) {
  return Editor.hitTest(point);
}

function currentFill() {
  return $('propFill').value.trim() || '#38bdf8';
}

function onPointerDown(event) {
  if (!state.doc) return;
  if (Editor.pointerDown(event)) return;
  const point = canvasPoint(event);
  state.drag = { mode: state.tool, start: point, points: [point] };
  if (state.tool === 'image') {
    state.pendingImagePoint = point;
    $('fileImage').click();
  }
}

function onPointerMove(event) {
  if (!state.doc) return;
  const point = canvasPoint(event);
  $('statusPos').textContent = `${Math.round(point.x)} , ${Math.round(point.y)}`;
  if (Editor.pointerMove(event)) return;
  const drag = state.drag;
  if (!drag) return;

  if (drag.mode === 'rect' || drag.mode === 'ellipse') {
    const x = Math.min(point.x, drag.start.x);
    const y = Math.min(point.y, drag.start.y);
    const w = Math.abs(point.x - drag.start.x);
    const h = Math.abs(point.y - drag.start.y);
    state.previewObject = {
      object: {
        type: drag.mode,
        id: 'preview-shape',
        x,
        y,
        w: Math.max(1, w),
        h: Math.max(1, h),
        radius: drag.mode === 'rect' ? 16 : 0,
        fill: currentFill(),
        stroke: '#0ea5e9',
        strokeWidth: 2,
      },
    };
    render();
    return;
  }

  if (drag.mode === 'line') {
    state.previewObject = {
      object: {
        type: 'line',
        id: 'preview-line',
        x1: drag.start.x,
        y1: drag.start.y,
        x2: point.x,
        y2: point.y,
        stroke: currentFill(),
        strokeWidth: 4,
      },
    };
    render();
    return;
  }

  if (drag.mode === 'freehand') {
    drag.points.push(point);
    state.previewObject = {
      object: {
        type: 'path',
        id: 'preview-freehand',
        segments: drag.points.map((item, index) => ({ op: index === 0 ? 'M' : 'L', x: item.x, y: item.y })),
        stroke: currentFill(),
        strokeWidth: 4,
        fill: null,
      },
    };
    render();
  }
}

// After a shape is drawn, hand it to the Select tool with the new shape selected (as Figma does). Before this,
// the drawing tool stayed active: the new shape showed handles but every drag on it drew another shape
// (or, with the line tool, a zero-length line), so a freshly drawn shape could never be moved.
function selectDrawn(objectId) {
  setTool('select');
  Editor.setSelection([objectId]);
  render();
  syncProps();
}

async function onPointerUp(event) {
  if (await Editor.pointerUp(event)) return;
  const drag = state.drag;
  state.drag = null;
  if (!drag || !state.doc) return;
  const point = canvasPoint(event);
  state.previewObject = null;

  if (drag.mode === 'rect' || drag.mode === 'ellipse') {
    const x = Math.min(point.x, drag.start.x);
    const y = Math.min(point.y, drag.start.y);
    const w = Math.abs(point.x - drag.start.x);
    const h = Math.abs(point.y - drag.start.y);
    if (w < 4 || h < 4) { render(); return; }
    await guarded(async () => {
      const data = await call(drag.mode === 'rect' ? 'draw.rect' : 'draw.ellipse', {
        documentId: state.docId,
        layerId: drawLayerId(),
        x,
        y,
        w,
        h,
        radius: drag.mode === 'rect' ? 16 : 0,
        fill: currentFill(),
      });
      state.selection = { objectId: data.objectId };
      await loadDocument(state.docId);
      selectDrawn(data.objectId);
      updateStatusAfterMutation();
    });
    return;
  }

  if (drag.mode === 'line') {
    // A click is not a line: it left invisible zero-length lines (e.g. 938,269 → 938,269) when users clicked a shape to grab it.
    if (Math.hypot(point.x - drag.start.x, point.y - drag.start.y) < 4) { render(); return; }
    await guarded(async () => {
      const data = await call('draw.line', {
        documentId: state.docId,
        layerId: drawLayerId(),
        x1: drag.start.x,
        y1: drag.start.y,
        x2: point.x,
        y2: point.y,
        stroke: currentFill(),
        strokeWidth: 4,
      });
      state.selection = { objectId: data.objectId };
      await loadDocument(state.docId);
      selectDrawn(data.objectId);
      updateStatusAfterMutation();
    });
    return;
  }

  if (drag.mode === 'freehand') {
    if (drag.points.length < 3) { render(); return; }
    await guarded(async () => {
      const data = await call('draw.stroke', {
        documentId: state.docId,
        layerId: drawLayerId(),
        points: drag.points,
        color: currentFill(),
        size: 4,
      });
      state.selection = { objectId: data.objectId };
      await loadDocument(state.docId);
      updateStatusAfterMutation();
    });
    return;
  }

  if (drag.mode === 'text') {
    await guarded(async () => {
      const data = await call('draw.text', textParams(point.x, point.y));
      state.selection = { objectId: data.objectId };
      await loadDocument(state.docId);
      selectDrawn(data.objectId);
      updateStatusAfterMutation();
    });
  }
}

/* ----------------------------------------------------------------- actions */

function setTool(tool) {
  if (state.tool === 'pen' && tool !== 'pen' && Editor.finishToolSession) Editor.finishToolSession();
  state.tool = tool;
  document.querySelectorAll('.tool[data-tool]').forEach((button) => {
    button.classList.toggle('active', button.dataset.tool === tool);
  });
  updateStatus();
}

function zoomBy(factor) {
  state.zoom = Math.min(8, Math.max(0.05, state.zoom * factor));
  render();
  updateStatus();
}

async function undo() {
  await guarded(async () => {
    await call('history.undo', { documentId: state.docId });
    await loadDocument(state.docId);
    toast('تراجع');
  });
}

async function redo() {
  await guarded(async () => {
    await call('history.redo', { documentId: state.docId });
    await loadDocument(state.docId);
    toast('إعادة');
  });
}

async function saveDesign() {
  await guarded(async () => {
    const data = await call('document.save', { documentId: state.docId });
    toast(`حُفظ التصميم: ${data.path} (${data.bytes} بايت)`);
  });
}

async function exportPng() {
  await guarded(async () => {
    const data = await call('export.image', { documentId: state.docId, format: 'png', scale: 1, static: true });
    toast(`صُدّر PNG: ${data.path} (${data.bytes} بايت · ${data.width}×${data.height})`);
    pushLog({ type: 'operation', op: 'export.image', ok: true, message: data.path });
  });
}

function showEnginePreview() {
  const image = $('enginePreviewImg');
  image.src = `/api/documents/${encodeURIComponent(state.docId)}/preview.png?maxWidth=1100&t=${Date.now()}`;
  $('enginePreviewMeta').textContent = `المستند ${state.docId} · إصدار ${state.revision} · مصيّر بواسطة Node/Skia`;
  $('previewDialog').showModal();
}

async function createDocument() {
  await guarded(async () => {
    const data = await call('document.create', {
      name: $('newName').value || 'تصميم جديد',
      width: num($('newWidth').value, 1200),
      height: num($('newHeight').value, 800),
      background: { type: 'solid', color: '#0b1220' },
      locale: 'ar',
    });
    await loadDocument(data.documentId);
    toast('أُنشئت لوحة جديدة');
  });
}

async function bootstrap() {
  buildPanels();
  await loadFonts();
  connectEvents();
  const docs = await call('document.list', {});
  if (docs.documents.length) await loadDocument(docs.documents[0].id);
  else await createDocument();
  renderLog();
}

/* ------------------------------------------------------------------- wiring */

viewport.addEventListener('pointerdown', onPointerDown);
window.addEventListener('pointermove', onPointerMove);
window.addEventListener('pointerup', onPointerUp);

$('toolbar').addEventListener('click', (event) => {
  const button = event.target.closest('.tool[data-tool]');
  if (button) setTool(button.dataset.tool);
});
$('btnUndo').addEventListener('click', undo);
$('btnRedo').addEventListener('click', redo);
$('btnZoomIn').addEventListener('click', () => zoomBy(1.2));
$('btnZoomOut').addEventListener('click', () => zoomBy(1 / 1.2));
$('btnSave').addEventListener('click', saveDesign);
$('btnExport').addEventListener('click', exportPng);
$('btnEnginePreview').addEventListener('click', showEnginePreview);
$('btnClosePreview').addEventListener('click', () => $('previewDialog').close());
$('btnNew').addEventListener('click', () => $('newDialog').showModal());
$('newDialog').addEventListener('close', () => {
  if ($('newDialog').returnValue === 'create') createDocument();
});
$('btnOpen').addEventListener('click', () => $('fileDesign').click());

$('fileDesign').addEventListener('change', async (event) => {
  const file = event.target.files[0];
  event.target.value = '';
  if (!file) return;
  await guarded(async () => {
    const parsed = JSON.parse(await file.text());
    const data = await call('document.import', { document: parsed });
    await loadDocument(data.documentId);
    toast(`فُتح التصميم: ${file.name}`);
  });
});

$('fileImage').addEventListener('change', async (event) => {
  const file = event.target.files[0];
  event.target.value = '';
  if (!file) return;
  await guarded(async () => {
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
    const asset = await call('image.add', { dataUrl, name: file.name });
    const point = state.pendingImagePoint || { x: 40, y: 40 };
    const width = Math.min(420, state.doc.canvas.width / 2);
    const ratio = asset.asset.height / Math.max(1, asset.asset.width);
    const data = await call('draw.image', {
      documentId: state.docId,
      layerId: drawLayerId(),
      x: point.x,
      y: point.y,
      w: width,
      h: Math.round(width * ratio),
      assetId: asset.asset.id,
      fit: 'cover',
      radius: 12,
    });
    state.selection = { objectId: data.objectId };
    await loadDocument(state.docId);
    updateStatusAfterMutation();
    toast('أُضيفت الصورة');
  });
});

$('docName').addEventListener('change', async (event) => {
  await guarded(async () => {
    await call('document.update', { documentId: state.docId, name: event.target.value });
    await loadDocument(state.docId);
  });
});

window.addEventListener('keydown', (event) => {
  const tag = (event.target.tagName || '').toLowerCase();
  if (['input', 'textarea', 'select'].includes(tag)) return;
  if (Editor.keydown(event)) return;
  const key = event.key.toLowerCase();
  if (event.ctrlKey && key === 'z') {
    event.preventDefault();
    if (event.shiftKey) redo(); else undo();
    return;
  }
  if (event.ctrlKey && key === 's') { event.preventDefault(); saveDesign(); return; }
  if (key === 'v') setTool('select');
  if (key === 'r') setTool('rect');
  if (key === 'o') setTool('ellipse');
  if (key === 'l') setTool('line');
  if (key === 'p') setTool('freehand');
  if (key === 't') setTool('text');
  if (key === 'i') setTool('image');
  if (key === 'delete') deleteObject();
  if (key === 'escape') { state.selection = null; drawOverlay(); syncProps(); }
  if (key === '+' || key === '=') zoomBy(1.2);
  if (key === '-') zoomBy(1 / 1.2);
});

window.addEventListener('resize', () => { fitZoom(); render(); updateStatus(); });

bootstrap().catch((error) => {
  console.error(error);
  toast(`فشل بدء الواجهة: ${error.message}`, true);
});
