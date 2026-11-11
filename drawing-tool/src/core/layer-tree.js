'use strict';

/**
 * Layer groups on top of the flat `doc.layers` array.
 *
 * `doc.layers` stays one ordered array (bottom → top) so code that only walks objects keeps working.
 * A group is an entry `{type:'group', objects:[]}`; any entry may carry `parentId` naming its group.
 * The array is kept in canonical post-order: a group's descendants are contiguous and sit directly
 * below the group entry (the order a layers panel shows, read bottom-up). Sibling order is the
 * relative array order, so the tree is fully defined by (array order, parentId).
 */

const { assert } = require('./errors');

const MAX_GROUP_DEPTH = 10;

const isGroup = (layer) => Boolean(layer && layer.type === 'group');

function byId(layers) {
  const map = new Map();
  for (const layer of layers) map.set(layer.id, layer);
  return map;
}

function parentOf(layers, layer) {
  if (!layer || !layer.parentId) return null;
  return layers.find((l) => l.id === layer.parentId) || null;
}

/** Children of `parentId` (null = root) in sibling order, bottom → top. */
function childrenOf(layers, parentId) {
  return layers.filter((l) => (l.parentId || null) === (parentId || null));
}

/** Ancestor groups of a layer, nearest first. */
function ancestors(layers, layer) {
  const map = byId(layers);
  const out = [];
  let cursor = layer && layer.parentId ? map.get(layer.parentId) : null;
  while (cursor && out.length <= MAX_GROUP_DEPTH + 1) {
    out.push(cursor);
    cursor = cursor.parentId ? map.get(cursor.parentId) : null;
  }
  return out;
}

/** Ids of every layer inside a group (any depth). */
function descendantIds(layers, groupId) {
  const out = new Set();
  const stack = [groupId];
  while (stack.length) {
    const id = stack.pop();
    for (const l of layers) if (l.parentId === id && !out.has(l.id)) { out.add(l.id); stack.push(l.id); }
  }
  return out;
}

const effectiveVisible = (layers, layer) => layer.visible !== false && ancestors(layers, layer).every((g) => g.visible !== false);
const effectiveLocked = (layers, layer) => Boolean(layer.locked) || ancestors(layers, layer).some((g) => g.locked);

/** Validate parent links: parent exists, is a group, no cycles, depth ≤ MAX_GROUP_DEPTH. */
function validateTree(layers) {
  const map = byId(layers);
  assert(map.size === layers.length, 'DUPLICATE_LAYER_ID', 'layer ids must be unique');
  for (const layer of layers) {
    if (!layer.parentId) continue;
    const parent = map.get(layer.parentId);
    assert(parent, 'INVALID_PARENT', `layer "${layer.name}" has an unknown parentId`, { layerId: layer.id, parentId: layer.parentId });
    assert(isGroup(parent), 'INVALID_PARENT', `parent of layer "${layer.name}" is not a group`, { layerId: layer.id, parentId: layer.parentId });
    let depth = 1;
    let cursor = parent;
    while (cursor.parentId) {
      assert(cursor.id !== layer.id && cursor.parentId !== layer.id, 'GROUP_CYCLE', `layer "${layer.name}" is inside itself`, { layerId: layer.id });
      cursor = map.get(cursor.parentId);
      assert(cursor, 'INVALID_PARENT', 'broken parent chain', { layerId: layer.id });
      depth += 1;
      assert(depth <= MAX_GROUP_DEPTH, 'GROUP_TOO_DEEP', `groups can be nested at most ${MAX_GROUP_DEPTH} levels`, { layerId: layer.id });
    }
  }
}

/** Reorder `layers` in place into canonical post-order (children, then their group). */
function canonicalize(layers) {
  const ordered = [];
  const visit = (parentId) => {
    for (const layer of childrenOf(layers, parentId)) {
      if (isGroup(layer)) visit(layer.id);
      ordered.push(layer);
    }
  };
  visit(null);
  assert(ordered.length === layers.length, 'GROUP_CYCLE', 'layer tree contains a cycle');
  layers.splice(0, layers.length, ...ordered);
  return layers;
}

/** Tree of render nodes: [{layer, children?}] bottom → top. */
function buildTree(layers) {
  const build = (parentId) => childrenOf(layers, parentId).map((layer) => (isGroup(layer) ? { layer, children: build(layer.id) } : { layer }));
  return build(null);
}

/**
 * Place `layer` (already removed from `layers`) as a child of `parentId` at sibling position `index`
 * (0 = bottom; default top), then canonicalize.
 */
function insertAt(layers, layer, parentId, index) {
  const siblings = childrenOf(layers, parentId);
  const position = index === undefined ? siblings.length : index;
  assert(Number.isInteger(position) && position >= 0 && position <= siblings.length, 'INVALID_INDEX',
    `index must be between 0 and ${siblings.length} among the destination's layers`, { received: index });
  if (parentId) layer.parentId = parentId; else delete layer.parentId;
  if (position < siblings.length) layers.splice(layers.indexOf(siblings[position]), 0, layer);
  else if (siblings.length) layers.splice(layers.indexOf(siblings[siblings.length - 1]) + 1, 0, layer);
  else if (parentId) layers.splice(layers.findIndex((l) => l.id === parentId), 0, layer);
  else layers.push(layer);
  canonicalize(layers);
  return position;
}

/** Sibling index of a layer within its parent. */
function siblingIndex(layers, layer) {
  return childrenOf(layers, layer.parentId || null).indexOf(layer);
}

module.exports = {
  MAX_GROUP_DEPTH,
  isGroup,
  parentOf,
  childrenOf,
  ancestors,
  descendantIds,
  effectiveVisible,
  effectiveLocked,
  validateTree,
  canonicalize,
  buildTree,
  insertAt,
  siblingIndex,
};
