// Shared-workspace operations, as they travel between players. Everything
// received from a peer is untrusted, so parsing is strict: a malformed op
// makes the whole batch invalid.
//
//   ['a', oid, el, x, y]  add element `el` (a Little Alchemy element id)
//   ['d', oid]            delete
//   ['m', oid, x, y]      move
//   ['h', oid]            hold (a player started dragging it)
//   ['r', oid]            release
//
// x and y are the element's centre relative to the playable area (0..1), so
// every player sees the same arrangement fitted to their own window.

import { isElementId } from '../sync/pairs.js';

export const MAX_OPS_PER_BATCH = 200;
export const MAX_ELEMENTS = 300;
export const OID_PATTERN = /^[a-z0-9]{1,24}$/;

export function isOid(value) {
  return typeof value === 'string' && OID_PATTERN.test(value);
}

export function round4(n) {
  return Math.round(n * 10000) / 10000;
}

// A coordinate from a peer: any finite number, clamped into 0..1.
export function coord(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return round4(Math.min(1, Math.max(0, value)));
}

function parseOp(raw) {
  if (!Array.isArray(raw) || !isOid(raw[1])) return null;
  const oid = raw[1];
  switch (raw[0]) {
    case 'a': {
      const x = coord(raw[3]);
      const y = coord(raw[4]);
      if (!isElementId(raw[2]) || x === null || y === null) return null;
      return ['a', oid, raw[2], x, y];
    }
    case 'm': {
      const x = coord(raw[2]);
      const y = coord(raw[3]);
      return x === null || y === null ? null : ['m', oid, x, y];
    }
    case 'd':
    case 'h':
    case 'r':
      return [raw[0], oid];
    default:
      return null;
  }
}

// Returns clean ops, or null if the batch is malformed.
export function parseOps(raw) {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_OPS_PER_BATCH) return null;
  const ops = [];
  for (const item of raw) {
    const op = parseOp(item);
    if (!op) return null;
    ops.push(op);
  }
  return ops;
}

// Snapshot of a whole canvas from the host:
//   {elements: [[oid, el, x, y, owner]], holds: [[oid, playerId]], ack}
export function parseSnapshot(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.elements) || raw.elements.length > MAX_ELEMENTS) return null;
  const elements = [];
  const seen = new Set();
  for (const item of raw.elements) {
    if (!Array.isArray(item) || !isOid(item[0]) || seen.has(item[0]) || !isElementId(item[1])) return null;
    const x = coord(item[2]);
    const y = coord(item[3]);
    const owner = typeof item[4] === 'string' && item[4].length <= 64 ? item[4] : '';
    if (x === null || y === null) return null;
    seen.add(item[0]);
    elements.push([item[0], item[1], x, y, owner]);
  }
  const holds = [];
  if (Array.isArray(raw.holds)) {
    for (const item of raw.holds.slice(0, MAX_ELEMENTS)) {
      if (Array.isArray(item) && seen.has(item[0]) && typeof item[1] === 'string' && item[1].length <= 64) {
        holds.push([item[0], item[1]]);
      }
    }
  }
  const ack = Number.isInteger(raw.ack) && raw.ack >= 0 ? raw.ack : 0;
  return { elements, holds, ack };
}
