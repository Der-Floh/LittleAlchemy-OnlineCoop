// Maps positions between a player's screen and the shared 0..1 space.
//
// Windows differ in size, and Little Alchemy's elements (74/64/58/54 px) and
// library panel (250/210/200/150 px) scale with the window. Positions are
// shared as the element's *centre* relative to the playable area (the window
// minus the library), so everyone sees the same arrangement fitted to their
// own screen, and nothing lands off-screen or behind the library.

import { clamp } from 'es-toolkit';
import { round4 } from './ops.ts';

export type Metrics = { playW: number; playH: number; elemW: number; elemH: number };
export type SharedPoint = { x: number; y: number };
export type LocalPoint = { left: number; top: number };

// Element top-left in px -> shared centre coordinates.
export function toShared(left: number, top: number, m: Metrics): SharedPoint {
  return {
    x: round4(clamp((left + m.elemW / 2) / m.playW, 0, 1)),
    y: round4(clamp((top + m.elemH / 2) / m.playH, 0, 1)),
  };
}

// Shared centre coordinates -> element top-left in px, kept fully visible.
export function toLocal(x: number, y: number, m: Metrics): LocalPoint {
  return {
    left: Math.round(clamp(x * m.playW - m.elemW / 2, 0, Math.max(0, m.playW - m.elemW))),
    top: Math.round(clamp(y * m.playH - m.elemH / 2, 0, Math.max(0, m.playH - m.elemH))),
  };
}

// A pointer position -> shared coordinates, or null over the library.
export function pointToShared(px: number, py: number, m: Metrics): SharedPoint | null {
  if (px < 0 || py < 0 || px > m.playW || py > m.playH) return null;
  return { x: round4(px / m.playW), y: round4(py / m.playH) };
}

export function pointToLocal(x: number, y: number, m: Metrics): LocalPoint {
  return { left: Math.round(clamp(x, 0, 1) * m.playW), top: Math.round(clamp(y, 0, 1) * m.playH) };
}
