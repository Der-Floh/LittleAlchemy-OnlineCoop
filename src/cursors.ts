// Live cursors: everyone's pointer on the canvas, in their colour with their
// name, plus the icon of an element they're dragging out of the library.
// Positions use the same shared 0..1 space as the canvas elements, so a
// cursor over an element appears over that element on every screen.
// Drawing is up to the UI (ui/cursor-layer.tsx): we hand it the cursors to show.
//
// App message kind 'cur': {x, y, h?} (h = element id being dragged from the
// library) or {off: true} when the pointer leaves the canvas.

import * as v from 'valibot';
import { clamp, throttle } from 'es-toolkit';
import { pointToShared, pointToLocal, type Metrics } from './workspace/projection.ts';
import { ElementIdSchema } from './workspace/ops.ts';
import type { AppMessage, RoomMember, RoomSession, Who } from './net/session.ts';
import type { PageWindow } from './game/workspace-bridge.ts';
import type { CursorView } from './ui/state.ts';

const SEND_INTERVAL_MS = 66; // ~15 updates a second
const STALE_MS = 20_000;

const UnitSchema = v.pipe(
  v.number(),
  v.finite(),
  v.transform((n) => clamp(n, 0, 1)),
);
const CursorSchema = v.union([
  v.object({ off: v.literal(true) }),
  v.object({ x: UnitSchema, y: UnitSchema, h: v.fallback(v.nullable(ElementIdSchema), null) }),
]);
export type CursorPayload = v.InferOutput<typeof CursorSchema>;

// A cursor update from a peer, or null if it's junk.
export function parseCursor(raw: unknown): CursorPayload | null {
  const result = v.safeParse(CursorSchema, raw);
  return result.success ? result.output : null;
}

type Outgoing = { off: true } | { x: number; y: number; h?: number };
type Remote = { name: string; color: number; x: number; y: number; h: number | null; ghost: string | null; at: number; hidden: boolean };

export type CursorsOptions = {
  win?: PageWindow;
  session: RoomSession;
  bridge: { metrics(): Metrics };
  render: (cursors: CursorView[]) => void;
  elementImage: (id: number) => string | null;
};

export class Cursors {
  readonly win: PageWindow;
  readonly session: RoomSession;
  readonly bridge: { metrics(): Metrics };
  private readonly render: (cursors: CursorView[]) => void;
  private readonly elementImage: (id: number) => string | null;
  enabled = true;
  active = false;
  private _installed = false;
  private _pending: Outgoing | null = null;
  private _lastSent = '';
  private _holding: number | null = null;
  private _sweep: number | null = null;
  private readonly _remote = new Map<string, Remote>();
  private readonly _send = throttle(() => this._flush(), SEND_INTERVAL_MS);

  constructor({ win = window, session, bridge, render, elementImage }: CursorsOptions) {
    this.win = win;
    this.session = session;
    this.bridge = bridge;
    this.render = render;
    this.elementImage = elementImage;

    session.on('app', (message) => this._onApp(message));
    session.on('members', (members) => this._pruneTo(members));
    session.on('status', ({ state }) => {
      if (state === 'idle' || state === 'rejected') this.stop();
    });
  }

  start(): void {
    if (this.active) return;
    this.active = true;
    this._install();
    this._sweep = this.win.setInterval(() => this._hideStale(), 5_000);
  }

  stop(): void {
    this.active = false;
    if (this._sweep !== null) this.win.clearInterval(this._sweep);
    this._sweep = null;
    this._send.cancel();
    this._pending = null;
    this._lastSent = '';
    this._clear();
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    if (!on) this._clear();
  }

  // Whether cursor updates can go out (tests replace it).
  connected(): boolean {
    return this.session.state === 'hosting' || this.session.state === 'connected';
  }

  // ---- our pointer --------------------------------------------------------------

  private _install(): void {
    if (this._installed) return;
    this._installed = true;
    const w = this.win;
    w.document.addEventListener('pointermove', (e) => this._onPointer(e.clientX, e.clientY), true);
    w.document.addEventListener(
      'pointerout',
      (e) => {
        if (!e.relatedTarget) this._queue({ off: true }); // left the window
      },
      true,
    );
    w.addEventListener('blur', () => this._queue({ off: true }));
    w.addEventListener('pagehide', () => this._queue({ off: true }));
    w.addEventListener('resize', () => this._publish());
    const $doc = w.jQuery(w.document);
    // Library drags carry their element as a "ghost" on our cursor.
    $doc.on('dragStart.laCoopCursor', (_e, drag: LADrag | undefined) => {
      if (drag?.options?.helper && drag.element) {
        this._holding = parseInt(drag.element.getAttribute('data-elementid') ?? '', 10) || null;
      }
    });
    $doc.on('dragEnd.laCoopCursor', () => {
      if (this._holding === null) return;
      this._holding = null;
      const pending = this._pending;
      if (pending && !('off' in pending)) this._queue({ x: pending.x, y: pending.y });
    });
  }

  private _onPointer(clientX: number, clientY: number): void {
    if (!this.active) return;
    const pos = pointToShared(clientX, clientY, this.bridge.metrics());
    if (!pos) {
      this._queue({ off: true });
      return;
    }
    this._queue(this._holding !== null ? { x: pos.x, y: pos.y, h: this._holding } : { x: pos.x, y: pos.y });
  }

  private _queue(payload: Outgoing): void {
    if (!this.active) return;
    this._pending = payload;
    this._send();
  }

  private _flush(): void {
    if (!this.active || !this._pending || !this.connected()) return;
    const json = JSON.stringify(this._pending);
    if (json === this._lastSent) return;
    if (this.session.sendApp('cur', this._pending)) this._lastSent = json;
  }

  // ---- everyone else's ------------------------------------------------------------

  private _onApp({ k, d, by, fromHost }: AppMessage): void {
    if (k !== 'cur' || !this.active) return;
    // The host passes each player's cursor on to the others.
    if (!fromHost && this.session.role === 'host') this.session.relayApp('cur', d, by.id);
    this.receive(by, d);
  }

  // Shows (or hides) another player's cursor.
  receive(by: Who, d: unknown): void {
    if (by.id === this.session.playerId) return;
    const cursor = parseCursor(d);
    if (!cursor) return;
    let entry = this._remote.get(by.id);
    if ('off' in cursor || !this.enabled) {
      if (entry) {
        entry.hidden = true;
        this._publish();
      }
      return;
    }
    if (!entry) {
      entry = { name: by.name, color: by.color, x: 0, y: 0, h: null, ghost: null, at: 0, hidden: true };
      this._remote.set(by.id, entry);
    }
    entry.name = by.name;
    entry.color = by.color;
    if (cursor.h !== entry.h) {
      entry.h = cursor.h;
      entry.ghost = cursor.h ? this.elementImage(cursor.h) : null;
    }
    entry.x = cursor.x;
    entry.y = cursor.y;
    entry.at = Date.now();
    entry.hidden = false;
    this._publish();
  }

  // Hands the cursors, in this screen's pixels, to the UI.
  private _publish(): void {
    const m = this.bridge.metrics();
    this.render(
      [...this._remote].map(([id, e]) => {
        const { left, top } = pointToLocal(e.x, e.y, m);
        return { id, name: e.name, color: e.color, left, top, ghost: e.ghost, hidden: e.hidden };
      }),
    );
  }

  private _hideStale(): void {
    const cutoff = Date.now() - STALE_MS;
    let changed = false;
    for (const entry of this._remote.values()) {
      if (entry.at < cutoff && !entry.hidden) {
        entry.hidden = true;
        changed = true;
      }
    }
    if (changed) this._publish();
  }

  private _pruneTo(members: RoomMember[]): void {
    const present = new Set(members.map((m) => m.id));
    let changed = false;
    for (const id of this._remote.keys()) {
      if (!present.has(id)) {
        this._remote.delete(id);
        changed = true;
      }
    }
    if (changed) this._publish();
  }

  private _clear(): void {
    this._remote.clear();
    this._publish();
  }
}
