'use strict';

/**
 * ArtForge colour picker (popover). Saturation/brightness square, hue and alpha sliders, hex + alpha input,
 * eyedropper (where the browser supports it), document colours, recent colours and the palette library
 * (/api/palettes: the 74 reference palettes). Loaded before app.js.
 *
 *   ColorPicker.open(anchorElement, initialColor, onChange(color, final), { documentColors })
 *
 * onChange gets '#rrggbb' (opaque) or 'rgba(r,g,b,a)'; final = true when a drag ends or a swatch is chosen
 * (callers commit to the document then, so dragging does not flood the undo history).
 */
const ColorPicker = (() => {
  const RECENT_KEY = 'artforge.recentColors';
  let root = null;
  let palettes = null;
  let current = { h: 200, s: 0.75, v: 0.97, a: 1 };
  let onChange = null;
  let anchor = null;
  let options = {};

  // ---------------------------------------------------------------- colour maths
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  function parse(text) {
    const t = String(text || '').trim();
    let m = /^#([0-9a-f]{3})$/i.exec(t);
    if (m) return { r: parseInt(m[1][0] + m[1][0], 16), g: parseInt(m[1][1] + m[1][1], 16), b: parseInt(m[1][2] + m[1][2], 16), a: 1 };
    m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(t);
    if (m) return { r: parseInt(m[1].slice(0, 2), 16), g: parseInt(m[1].slice(2, 4), 16), b: parseInt(m[1].slice(4, 6), 16), a: m[2] ? parseInt(m[2], 16) / 255 : 1 };
    m = /^rgba?\(([^)]+)\)$/i.exec(t);
    if (m) { const p = m[1].split(',').map((x) => parseFloat(x)); return { r: p[0] || 0, g: p[1] || 0, b: p[2] || 0, a: p.length > 3 ? clamp(p[3], 0, 1) : 1 }; }
    return null;
  }
  function rgbToHsv({ r, g, b }) {
    const R = r / 255; const G = g / 255; const B = b / 255;
    const max = Math.max(R, G, B); const min = Math.min(R, G, B); const d = max - min;
    let h = 0;
    if (d) h = max === R ? ((G - B) / d) % 6 : max === G ? (B - R) / d + 2 : (R - G) / d + 4;
    return { h: (h * 60 + 360) % 360, s: max ? d / max : 0, v: max };
  }
  function hsvToRgb({ h, s, v }) {
    const c = v * s; const x = c * (1 - Math.abs(((h / 60) % 2) - 1)); const m = v - c;
    const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
    return { r: Math.round((r + m) * 255), g: Math.round((g + m) * 255), b: Math.round((b + m) * 255) };
  }
  const hex2 = (n) => n.toString(16).padStart(2, '0');
  function format(c) {
    const { r, g, b } = hsvToRgb(c);
    return c.a >= 0.999 ? `#${hex2(r)}${hex2(g)}${hex2(b)}` : `rgba(${r},${g},${b},${Number(c.a.toFixed(3))})`;
  }
  const hexOnly = (c) => { const { r, g, b } = hsvToRgb(c); return `#${hex2(r)}${hex2(g)}${hex2(b)}`; };

  // ---------------------------------------------------------------- storage
  function recent() { try { return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'); } catch { return []; } }
  function remember(color) {
    try { localStorage.setItem(RECENT_KEY, JSON.stringify([color].concat(recent().filter((c) => c !== color)).slice(0, 16))); } catch { /* storage unavailable */ }
  }
  async function loadPalettes() {
    if (palettes) return palettes;
    try { const res = await fetch('/api/palettes'); const json = await res.json(); palettes = (json.data && json.data.palettes) || []; } catch { palettes = []; }
    return palettes;
  }

  // ---------------------------------------------------------------- UI
  const h = (tag, attrs, kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === 'class') n.className = v; else if (k === 'text') n.textContent = v; else if (k.startsWith('on')) n.addEventListener(k.slice(2), v); else if (v !== undefined && v !== null) n.setAttribute(k, v);
    }
    (kids || []).forEach((c) => n.appendChild(c));
    return n;
  };
  let sv; let hue; let alpha; let hexInput; let alphaInput; let preview; let docBox; let recentBox; let paletteBox; let paletteSelect;

  function emit(final) {
    const color = format(current);
    preview.style.background = color;
    hexInput.value = hexOnly(current);
    alphaInput.value = String(Math.round(current.a * 100));
    if (final) remember(color);
    if (onChange) onChange(color, final);
    if (final) renderSwatches();
  }
  function setColor(text, final) {
    const p = parse(text);
    if (!p) return false;
    current = Object.assign(rgbToHsv(p), { a: p.a });
    paint(); emit(final);
    return true;
  }

  function paint() {
    const { width: W, height: H } = sv;
    const c = sv.getContext('2d');
    c.fillStyle = `hsl(${current.h},100%,50%)`; c.fillRect(0, 0, W, H);
    const white = c.createLinearGradient(0, 0, W, 0); white.addColorStop(0, '#fff'); white.addColorStop(1, 'rgba(255,255,255,0)');
    c.fillStyle = white; c.fillRect(0, 0, W, H);
    const black = c.createLinearGradient(0, 0, 0, H); black.addColorStop(0, 'rgba(0,0,0,0)'); black.addColorStop(1, '#000');
    c.fillStyle = black; c.fillRect(0, 0, W, H);
    const x = current.s * W; const y = (1 - current.v) * H;
    c.beginPath(); c.arc(x, y, 6, 0, Math.PI * 2); c.lineWidth = 2; c.strokeStyle = current.v > 0.5 ? '#000' : '#fff'; c.stroke();
    const hc = hue.getContext('2d');
    const hg = hc.createLinearGradient(0, 0, hue.width, 0);
    for (let i = 0; i <= 6; i += 1) hg.addColorStop(i / 6, `hsl(${i * 60},100%,50%)`);
    hc.fillStyle = hg; hc.fillRect(0, 0, hue.width, hue.height);
    knob(hc, (current.h / 360) * hue.width, hue.height);
    const ac = alpha.getContext('2d');
    for (let i = 0; i < alpha.width; i += 6) for (let j = 0; j < alpha.height; j += 6) { ac.fillStyle = ((i + j) / 6) % 2 ? '#cbd5e1' : '#f8fafc'; ac.fillRect(i, j, 6, 6); }
    const ag = ac.createLinearGradient(0, 0, alpha.width, 0); const rgb = hsvToRgb(current);
    ag.addColorStop(0, `rgba(${rgb.r},${rgb.g},${rgb.b},0)`); ag.addColorStop(1, `rgb(${rgb.r},${rgb.g},${rgb.b})`);
    ac.fillStyle = ag; ac.fillRect(0, 0, alpha.width, alpha.height);
    knob(ac, current.a * alpha.width, alpha.height);
  }
  function knob(c, x, H) { c.beginPath(); c.rect(x - 3, 1, 6, H - 2); c.lineWidth = 2; c.strokeStyle = '#fff'; c.stroke(); c.lineWidth = 1; c.strokeStyle = '#0b1220'; c.stroke(); }

  function dragOn(canvas, apply) {
    canvas.addEventListener('pointerdown', (e) => {
      canvas.setPointerCapture(e.pointerId);
      const at = (ev) => { const r = canvas.getBoundingClientRect(); apply(clamp((ev.clientX - r.left) / r.width, 0, 1), clamp((ev.clientY - r.top) / r.height, 0, 1)); paint(); emit(false); };
      at(e);
      const move = (ev) => at(ev);
      const up = () => { canvas.removeEventListener('pointermove', move); canvas.removeEventListener('pointerup', up); emit(true); };
      canvas.addEventListener('pointermove', move);
      canvas.addEventListener('pointerup', up);
    });
  }

  function swatchRow(box, colors, title) {
    box.innerHTML = '';
    for (const color of colors) box.appendChild(h('button', { class: 'cp-swatch', title: color, style: `background:${color}`, onclick: () => setColor(color, true) }));
    if (!colors.length) box.appendChild(h('span', { class: 'cp-empty', text: title }));
  }
  function renderSwatches() {
    swatchRow(recentBox, recent(), 'لا ألوان حديثة بعد');
    swatchRow(docBox, (options.documentColors ? options.documentColors() : []).slice(0, 24), 'لا ألوان في المستند');
  }
  async function renderPalettes() {
    const list = await loadPalettes();
    paletteSelect.innerHTML = '';
    if (!list.length) { paletteSelect.appendChild(h('option', { text: 'لا توجد مكتبة ألوان' })); return; }
    list.forEach((p, i) => paletteSelect.appendChild(h('option', { value: String(i), text: `${p.name} (${p.colors.length})` })));
    let saved = 0; try { saved = Number(localStorage.getItem('artforge.palette') || 0); } catch { /* ignore */ }
    paletteSelect.value = String(saved < list.length ? saved : 0);
    showPalette();
  }
  function showPalette() {
    const p = (palettes || [])[Number(paletteSelect.value)];
    try { localStorage.setItem('artforge.palette', paletteSelect.value); } catch { /* ignore */ }
    swatchRow(paletteBox, p ? p.colors : [], '');
  }

  function build() {
    sv = h('canvas', { class: 'cp-sv', width: '232', height: '150' });
    hue = h('canvas', { class: 'cp-strip', width: '232', height: '14' });
    alpha = h('canvas', { class: 'cp-strip', width: '232', height: '14' });
    preview = h('span', { class: 'cp-preview' });
    hexInput = h('input', { class: 'cp-hex', dir: 'ltr', spellcheck: 'false', onchange: (e) => { if (!setColor(e.target.value, true)) e.target.value = hexOnly(current); } });
    alphaInput = h('input', { class: 'cp-alpha', type: 'number', min: '0', max: '100', onchange: (e) => { current.a = clamp(Number(e.target.value) / 100, 0, 1); paint(); emit(true); } });
    docBox = h('div', { class: 'cp-swatches' }); recentBox = h('div', { class: 'cp-swatches' }); paletteBox = h('div', { class: 'cp-swatches' });
    paletteSelect = h('select', { class: 'cp-palette', onchange: showPalette });
    const eyedrop = typeof window.EyeDropper === 'function'
      ? h('button', { class: 'cp-btn', title: 'قطارة: التقط لونًا من الشاشة', text: '💧', onclick: async () => { try { const r = await new window.EyeDropper().open(); setColor(r.sRGBHex, true); } catch { /* cancelled */ } } })
      : null;
    dragOn(sv, (x, y) => { current.s = x; current.v = 1 - y; });
    dragOn(hue, (x) => { current.h = x * 360; });
    dragOn(alpha, (x) => { current.a = Math.round(x * 100) / 100; });
    root = h('div', { class: 'cp-pop', role: 'dialog', 'aria-label': 'منتقي الألوان' }, [
      sv, hue, alpha,
      h('div', { class: 'cp-row' }, [preview, h('span', { class: 'cp-label', text: 'HEX' }), hexInput, alphaInput, h('span', { class: 'cp-label', text: '%' })].concat(eyedrop ? [eyedrop] : [])),
      h('div', { class: 'cp-title', text: 'ألوان المستند' }), docBox,
      h('div', { class: 'cp-title', text: 'الألوان الأخيرة' }), recentBox,
      h('div', { class: 'cp-title', text: 'مكتبة الألوان' }), paletteSelect, paletteBox,
    ]);
    root.addEventListener('pointerdown', (e) => e.stopPropagation());
    document.body.appendChild(root);
    document.addEventListener('pointerdown', () => close());
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && root && !root.hidden) close(); });
  }

  function open(anchorEl, color, cb, opts) {
    if (!root) build();
    anchor = anchorEl; onChange = cb; options = opts || {};
    const p = parse(color) || parse('#38bdf8');
    current = Object.assign(rgbToHsv(p), { a: p.a });
    root.hidden = false;
    const r = anchor.getBoundingClientRect();
    const top = Math.min(window.innerHeight - root.offsetHeight - 8, r.bottom + 6);
    root.style.top = `${Math.max(8, top)}px`;
    root.style.left = `${Math.max(8, Math.min(window.innerWidth - 260, r.left))}px`;
    paint(); preview.style.background = format(current); hexInput.value = hexOnly(current); alphaInput.value = String(Math.round(current.a * 100));
    renderSwatches(); renderPalettes();
  }
  function close() { if (root) root.hidden = true; onChange = null; }

  return { open, close, parse, format: (c) => c, isOpen: () => Boolean(root && !root.hidden) };
})();
