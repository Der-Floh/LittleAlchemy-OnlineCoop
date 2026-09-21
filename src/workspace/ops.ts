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

import * as v from 'valibot';
import { clamp, round } from 'es-toolkit';
import { MAX_ELEMENT_ID } from '../sync/pairs.ts';

export const MAX_OPS_PER_BATCH = 200;
export const MAX_ELEMENTS = 300;
export const OID_PATTERN = /^[a-z0-9]{1,24}$/;

export function round4(n: number): number {
  return round(n, 4);
}

export const OidSchema = v.pipe(v.string(), v.regex(OID_PATTERN));
export const ElementIdSchema = v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(MAX_ELEMENT_ID));
// A coordinate from a peer: any finite number, clamped into 0..1.
export const CoordSchema = v.pipe(
  v.number(),
  v.finite(),
  v.transform((n) => round4(clamp(n, 0, 1))),
);
// A player id as stamped by the host ('' if unknown).
const OwnerSchema = v.fallback(v.pipe(v.string(), v.maxLength(64)), '');

export const OpSchema = v.union([
  v.tuple([v.literal('a'), OidSchema, ElementIdSchema, CoordSchema, CoordSchema]),
  v.tuple([v.literal('m'), OidSchema, CoordSchema, CoordSchema]),
  v.tuple([v.picklist(['d', 'h', 'r']), OidSchema]),
]);
export type Op = v.InferOutput<typeof OpSchema>;
export type AddOp = Extract<Op, ['a', ...unknown[]]>;

const OpsSchema = v.pipe(v.array(OpSchema), v.minLength(1), v.maxLength(MAX_OPS_PER_BATCH));

// Returns clean ops, or null if the batch is malformed.
export function parseOps(raw: unknown): Op[] | null {
  const result = v.safeParse(OpsSchema, raw);
  return result.success ? result.output : null;
}

// Snapshot of a whole canvas from the host:
//   {elements: [[oid, el, x, y, owner]], holds: [[oid, playerId]], ack}
const SnapshotElementSchema = v.tuple([OidSchema, ElementIdSchema, CoordSchema, CoordSchema, OwnerSchema]);
export type SnapshotElement = v.InferOutput<typeof SnapshotElementSchema>;
export type Hold = [oid: string, playerId: string];

const HoldSchema = v.tuple([v.string(), v.pipe(v.string(), v.maxLength(64))]);

const SnapshotSchema = v.pipe(
  v.object({
    elements: v.pipe(
      v.array(SnapshotElementSchema),
      v.maxLength(MAX_ELEMENTS),
      v.check((elements) => new Set(elements.map((e) => e[0])).size === elements.length, 'duplicate element id'),
    ),
    holds: v.fallback(v.array(v.unknown()), () => []),
    ack: v.fallback(v.pipe(v.number(), v.integer(), v.minValue(0)), 0),
  }),
  // Holds on elements that aren't in the snapshot are dropped.
  v.transform(({ elements, holds, ack }) => {
    const known = new Set(elements.map((e) => e[0]));
    const valid: Hold[] = [];
    for (const item of holds.slice(0, MAX_ELEMENTS)) {
      const hold = v.safeParse(HoldSchema, item);
      if (hold.success && known.has(hold.output[0])) valid.push([hold.output[0], hold.output[1]]);
    }
    return { elements, holds: valid, ack };
  }),
);
export type Snapshot = v.InferOutput<typeof SnapshotSchema>;

export function parseSnapshot(raw: unknown): Snapshot | null {
  const result = v.safeParse(SnapshotSchema, raw);
  return result.success ? result.output : null;
}

// ---- app message payloads -------------------------------------------------------

// 'ws': a batch of ops. Clients number their batches (seq) so the host can
// acknowledge them in snapshots; `clear` marks a "clear my elements" batch.
// A malformed op list comes out as null, so the host can answer it.
const WsBatchSchema = v.object({
  seq: v.fallback(v.nullable(v.pipe(v.number(), v.integer(), v.minValue(1))), null),
  ops: v.fallback(v.nullable(OpsSchema), null),
  clear: v.fallback(v.boolean(), false),
});
export type WsBatch = v.InferOutput<typeof WsBatchSchema>;

export function parseBatch(raw: unknown): WsBatch {
  return v.parse(WsBatchSchema, raw && typeof raw === 'object' ? raw : {});
}

// 'wsnap': a snapshot; `fresh` when the host may never have seen our batches.
export type WsSnapshot = Snapshot & { fresh: boolean };

export function parseWsSnapshot(raw: unknown): WsSnapshot | null {
  const snap = parseSnapshot(raw);
  if (!snap) return null;
  const fresh = typeof raw === 'object' && raw !== null && 'fresh' in raw && raw.fresh === true;
  return { ...snap, fresh };
}

// 'wshash': a client's canvas fingerprint.
const WsHashSchema = v.object({ h: v.string() });

export function parseFingerprint(raw: unknown): string | null {
  const result = v.safeParse(WsHashSchema, raw);
  return result.success ? result.output.h : null;
}
