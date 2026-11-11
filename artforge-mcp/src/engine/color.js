'use strict';

/** Small colour toolkit for the composer: mixing, tints/shades, alpha and WCAG contrast. */

function parse(hex) {
  let v = String(hex || '#000000').trim();
  const m = /^rgba?\(([^)]+)\)$/i.exec(v);
  if (m) {
    const p = m[1].split(',').map((s) => parseFloat(s));
    return { r: p[0] || 0, g: p[1] || 0, b: p[2] || 0 };
  }
  v = v.replace('#', '');
  if (v.length === 3) v = v.split('').map((c) => c + c).join('');
  return { r: parseInt(v.slice(0, 2), 16) || 0, g: parseInt(v.slice(2, 4), 16) || 0, b: parseInt(v.slice(4, 6), 16) || 0 };
}

function hex({ r, g, b }) {
  const h = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`;
}

function mix(a, b, t) {
  const x = parse(a);
  const y = parse(b);
  const k = Math.max(0, Math.min(1, t));
  return hex({ r: x.r + (y.r - x.r) * k, g: x.g + (y.g - x.g) * k, b: x.b + (y.b - x.b) * k });
}

const lighten = (c, t) => mix(c, '#ffffff', t);
const darken = (c, t) => mix(c, '#000000', t);

function rgba(c, a) {
  const { r, g, b } = parse(c);
  return `rgba(${Math.round(r)},${Math.round(g)},${Math.round(b)},${Number(Math.max(0, Math.min(1, a)).toFixed(3))})`;
}

function relLum(c) {
  const { r, g, b } = parse(c);
  const lin = (v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function contrast(a, b) {
  const x = relLum(a);
  const y = relLum(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/** Pick the readable text colour for a background (WCAG ratio, prefers the palette's own dark/light). */
function readableOn(bg, dark, light) {
  const d = dark || '#0b1220';
  const l = light || '#ffffff';
  return contrast(bg, d) >= contrast(bg, l) ? d : l;
}

function hsl(c) {
  const { r, g, b } = parse(c);
  const R = r / 255; const G = g / 255; const B = b / 255;
  const max = Math.max(R, G, B); const min = Math.min(R, G, B);
  const l = (max + min) / 2;
  let h = 0; let s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === R) h = (G - B) / d + (G < B ? 6 : 0);
    else if (max === G) h = (B - R) / d + 2;
    else h = (R - G) / d + 4;
    h *= 60;
  }
  return { h, s, l };
}

function saturate(c, amount) {
  const { h, s, l } = hsl(c);
  return fromHsl(h, Math.max(0, Math.min(1, s * (1 + amount))), l);
}

function fromHsl(h, s, l) {
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return hex({ r: f(0) * 255, g: f(8) * 255, b: f(4) * 255 });
}

module.exports = { parse, hex, mix, lighten, darken, rgba, relLum, contrast, readableOn, hsl, saturate, fromHsl };
