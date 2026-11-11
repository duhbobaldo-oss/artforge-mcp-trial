'use strict';

const { assert } = require('./errors');

const EASINGS = {
  linear: (t) => t,
  easeIn: (t) => t * t,
  easeOut: (t) => 1 - (1 - t) * (1 - t),
  easeInOut: (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2),
};

const ANIMATABLE = ['x', 'y', 'w', 'h', 'opacity', 'rotation', 'scale', 'fontSize'];

function createAnimation(duration) {
  return { enabled: false, duration: duration || 3000, fps: 24, loop: true, tracks: [] };
}

function normalizeAnimation(input) {
  const anim = input || {};
  const duration = anim.duration === undefined ? 3000 : Number(anim.duration);
  assert(Number.isFinite(duration) && duration > 0, 'INVALID_ANIMATION',
    'animation.duration must be a positive number of milliseconds', { received: anim.duration });
  const fps = anim.fps === undefined ? 24 : Number(anim.fps);
  assert(Number.isFinite(fps) && fps >= 1 && fps <= 60, 'INVALID_ANIMATION',
    'animation.fps must be between 1 and 60', { received: anim.fps });
  return {
    enabled: Boolean(anim.enabled),
    duration,
    fps,
    loop: anim.loop === undefined ? true : Boolean(anim.loop),
    tracks: Array.isArray(anim.tracks) ? anim.tracks.map(normalizeTrack) : [],
  };
}

function normalizeTrack(track, index) {
  const label = `animation.tracks[${index}]`;
  assert(track && typeof track === 'object', 'INVALID_ANIMATION', `${label} must be an object`);
  assert(typeof track.targetId === 'string' && track.targetId.length > 0, 'INVALID_ANIMATION',
    `${label}.targetId is required (layer or object id)`);
  assert(ANIMATABLE.includes(track.property), 'INVALID_ANIMATION',
    `${label}.property must be one of: ${ANIMATABLE.join(', ')}`, { received: track.property });
  assert(Array.isArray(track.keyframes) && track.keyframes.length >= 2, 'INVALID_ANIMATION',
    `${label}.keyframes needs at least two keyframes`);
  const keyframes = track.keyframes.map((kf, i) => {
    const t = Number(kf.t);
    assert(Number.isFinite(t) && t >= 0, 'INVALID_ANIMATION', `${label}.keyframes[${i}].t must be a number >= 0`);
    const value = Number(kf.value);
    assert(Number.isFinite(value), 'INVALID_ANIMATION', `${label}.keyframes[${i}].value must be a number`);
    const easing = kf.easing || 'easeInOut';
    assert(EASINGS[easing], 'INVALID_ANIMATION',
      `${label}.keyframes[${i}].easing must be one of: ${Object.keys(EASINGS).join(', ')}`, { received: easing });
    return { t, value, easing };
  }).sort((a, b) => a.t - b.t);
  return {
    id: track.id || `trk_${index}`,
    targetId: track.targetId,
    property: track.property,
    keyframes,
  };
}

function sampleTrack(track, timeMs) {
  const kfs = track.keyframes;
  if (timeMs <= kfs[0].t) return kfs[0].value;
  const last = kfs[kfs.length - 1];
  if (timeMs >= last.t) return last.value;
  for (let i = 0; i < kfs.length - 1; i += 1) {
    const a = kfs[i];
    const b = kfs[i + 1];
    if (timeMs >= a.t && timeMs <= b.t) {
      const span = b.t - a.t;
      const raw = span === 0 ? 0 : (timeMs - a.t) / span;
      const eased = EASINGS[b.easing || 'easeInOut'](raw);
      return a.value + (b.value - a.value) * eased;
    }
  }
  return last.value;
}

/**
 * Resolve every animation track at a given time.
 * Returns { layers: {id: props}, objects: {id: props} } without mutating the document.
 */
function resolveAnimation(doc, timeMs) {
  const empty = { layers: {}, objects: {} };
  const anim = doc.animation;
  if (!anim || !anim.enabled || !Array.isArray(anim.tracks) || anim.tracks.length === 0) return empty;
  const time = anim.loop ? ((timeMs % anim.duration) + anim.duration) % anim.duration : Math.min(Math.max(0, timeMs), anim.duration);
  const out = { layers: {}, objects: {}, time };
  for (const track of anim.tracks) {
    const value = sampleTrack(track, time);
    const owner = findOwner(doc, track.targetId);
    if (!owner) continue;
    const bucket = owner.kind === 'layer' ? out.layers : out.objects;
    if (!bucket[track.targetId]) bucket[track.targetId] = {};
    bucket[track.targetId][track.property] = value;
  }
  return out;
}

function findOwner(doc, id) {
  for (const layer of doc.layers) {
    if (layer.id === id) return { kind: 'layer', node: layer };
    for (const object of layer.objects) {
      if (object.id === id) return { kind: 'object', node: object };
    }
  }
  return null;
}

module.exports = {
  EASINGS,
  ANIMATABLE,
  createAnimation,
  normalizeAnimation,
  normalizeTrack,
  sampleTrack,
  resolveAnimation,
  findOwner,
};
