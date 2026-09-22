// WorkspaceBridge: connects Little Alchemy's canvas ("workspace") to the
// shared-workspace ops. It's the only code that touches the canvas internals
// (alchemy.580.js / dragNdrop.580.js):
//
// - Every canvas element is a WorkspaceBox; the constructor always ends with
//   initEvents(), so wrapping it catches every creation (library drop,
//   combination result, clone, restore from storage), synchronously.
// - Elements leave the canvas in several ways (workspace.del, clearSpecified,
//   Droppable.destroy), so removals are caught with a MutationObserver.
// - Drags move the element with a CSS transform and only write left/top at
//   the end; the jQuery drag events (bubbling to document) carry the live
//   position.
// - A Droppable caches its own position; after moving an element for a remote
//   player we update that cache, or local drops onto it would miss.
// - Disabling a Droppable makes the game destroy the element on the next drag,
//   so drops onto elements held by others are refused in Droppable._accept.
// - A drop out of the library trusts the drop target it hovered: remote
//   deletions wait until such a drag ends, or its element would be orphaned.
// - The game runs one drag at a time (Draggables.isDragging) and ends it only on
//   its own release. A new press means that release got lost, so it ends the drag.
// - workspace.del() removes document-level jQuery pointer handlers, so our
//   pointer listeners are native.
//
// Emits 'ops' {ops, clear} with batches of local changes. Remote changes come
// in through applyOps() and reconcile().

import { customAlphabet } from 'nanoid';
import { Emitter } from '../emitter.ts';
import { toShared, toLocal, type Metrics, type SharedPoint } from '../workspace/projection.ts';
import { MAX_OPS_PER_BATCH, type AddOp, type Op } from '../workspace/ops.ts';
import type { WorkspaceState } from '../workspace/state.ts';
import type { BridgeLike, LocalBatch, MemberInfo } from '../workspace/sync.ts';
import type { Who } from '../net/session.ts';
import { colorFor } from '../ui/colors.ts';
import pageCss from '../ui/page.css';

const NS = '.laCoopWs';
const MOVE_INTERVAL_MS = 50;
const POINTER_START_EVENTS = ['mousedown', 'touchstart', 'pointerdown'];

// Element ids are this page's random tag plus a counter.
const randomTag = customAlphabet('abcdefghijklmnopqrstuvwxyz0123456789', 5);

export type PageWindow = Window & typeof globalThis;
export type BridgeEvents = { ops: LocalBatch };
type Holder = { id: string; name: string; color: number };

// Every WorkspaceBox has its element.
function nodeOf(box: LAWorkspaceBox): HTMLElement {
    return box.$el[0] as HTMLElement;
}

function elementIdOf(box: LAWorkspaceBox): number {
    return parseInt(String(box.id), 10);
}

export class WorkspaceBridge extends Emitter<BridgeEvents> implements BridgeLike {
    readonly win: PageWindow;
    active = false;
    me: string | null = null;
    // Set by the sync: who placed an element (for "clear only mine").
    ownerOf: (oid: string) => string | null = () => null;
    private readonly _boxes = new Map<string, LAWorkspaceBox>();
    private readonly _shared = new Map<string, SharedPoint>(); // shared position, for re-fitting on resize
    private readonly _holders = new Map<string, Holder>(); // another player dragging it
    private readonly _tag = randomTag();
    private _counter = 0;
    private _outbox: Op[] = [];
    private _clearFlag = false;
    private _flushTimer: number | null = null;
    private _flushAt = 0;
    private _lastFlush = 0;
    private _applying = 0; // > 0 while we change the canvas ourselves
    private _dragging: { oid: string | null; held: boolean } | null = null; // while the local player drags; oid null: out of the library
    private _deferred: [ops: Op[], by: Who][] = []; // remote batches waiting for the local drag to end
    private _pendingReconcile: WorkspaceState | null = null;
    private _pendingMembers: MemberInfo = new Map();
    private _installed = false;
    private _style: HTMLStyleElement | null = null;

    constructor(win: PageWindow = window) {
        super();
        this.win = win;
    }

    // ---- lifecycle -------------------------------------------------------------

    activate(me: string): void {
        this.me = me;
        if (this.active) return;
        this.active = true;
        this._installOnce();
        const w = this.win;
        this._style = w.document.createElement('style');
        this._style.id = 'la-coop-page-css';
        this._style.textContent = pageCss;
        w.document.head.appendChild(this._style);
        // The game deletes off-screen elements on rotation; we re-fit them instead.
        w.removeEventListener('orientationchange', w.workspace.recalculateElements, false);
        for (const el of w.workspace.el.querySelectorAll(':scope > .element[data-elementtype="workspaceBox"]')) {
            const box = w.jQuery(el).data('ptr') as LAWorkspaceBox | undefined;
            if (!box) continue;
            const oid = this._newOid();
            this._register(box, oid);
            this._shared.set(oid, this._sharedPosition(box));
        }
    }

    deactivate(): void {
        if (!this.active) return;
        this.active = false;
        const w = this.win;
        w.clearTimeout(this._flushTimer ?? undefined);
        this._flushTimer = null;
        for (const [oid, box] of this._boxes) {
            this._unmarkHeld(oid, box);
            delete nodeOf(box).dataset.coopOid;
        }
        this._boxes.clear();
        this._shared.clear();
        this._holders.clear();
        this._deferred = [];
        this._pendingReconcile = null;
        this._dragging = null;
        this._outbox = [];
        if (this._style) this._style.remove();
        w.addEventListener('orientationchange', w.workspace.recalculateElements, false);
    }

    // Hooks stay installed for the page's lifetime and do nothing while inactive.
    private _installOnce(): void {
        if (this._installed) return;
        this._installed = true;
        const w = this.win;
        // The game calls these wrappers with its own `this` (the element or drop target).
        const watching = () => this.active && !this._applying;
        const onCreate = (box: LAWorkspaceBox) => this._onLocalCreate(box);
        const refusesDrops = (el: HTMLElement | undefined) => this.active && !!el?.dataset?.coopHeld;

        const proto = w.WorkspaceBox.prototype;
        const initEvents = proto.initEvents;
        proto.initEvents = function (...args) {
            const result = initEvents.apply(this, args);
            if (watching()) {
                try {
                    onCreate(this);
                } catch (err) {
                    console.error('[la-coop] workspace hook failed', err);
                }
            }
            return result;
        };

        const accept = w.Droppable.prototype._accept;
        w.Droppable.prototype._accept = function (element) {
            if (refusesDrops(this.element)) return false;
            return accept.call(this, element);
        };

        new w.MutationObserver((records) => this._onMutations(records)).observe(w.workspace.el, { childList: true });

        const $doc = w.jQuery(w.document);
        $doc.on('dragStart' + NS, (_e, drag: LADrag) => this._onDragStart(drag));
        $doc.on('dragMove' + NS, (_e, drag: LADrag) => this._onDragMove(drag));
        $doc.on('dragEnd' + NS, () => this._onDragEnd());

        w.addEventListener('pointerdown', (event) => this._endStaleDrag(event), true);
        for (const type of POINTER_START_EVENTS) {
            w.workspace.el.addEventListener(type, (event) => this._blockHeld(event), true);
        }
        w.document.addEventListener('click', (event) => this._interceptClear(event), true);
        w.addEventListener('resize', () => this._refit());
        w.addEventListener('orientationchange', () => this._refit());
    }

    // ---- geometry ----------------------------------------------------------------

    metrics(): Metrics {
        const w = this.win;
        const side = w.document.getElementById('side');
        const width = w.innerWidth;
        // Element sizes from the game's CSS breakpoints.
        const elem = width >= 768 ? 74 : width >= 598 ? 64 : width >= 490 ? 58 : 54;
        return {
            playW: Math.max(elem + 1, width - (side ? side.offsetWidth : 0)),
            playH: Math.max(elem + 1, w.innerHeight),
            elemW: elem,
            elemH: elem,
        };
    }

    private _sharedPosition(box: LAWorkspaceBox): SharedPoint {
        const el = nodeOf(box);
        let left = parseFloat(el.style.left);
        let top = parseFloat(el.style.top);
        if (!Number.isFinite(left) || !Number.isFinite(top)) ({ left, top } = box.$el.position());
        return toShared(left, top, this.metrics());
    }

    // The canvas as ops, e.g. to seed a new room with the host's elements.
    currentElements(): AddOp[] {
        const ops: AddOp[] = [];
        for (const [oid, box] of this._boxes) {
            const { x, y } = this._sharedPosition(box);
            ops.push(['a', oid, elementIdOf(box), x, y]);
        }
        return ops;
    }

    isDragging(): boolean {
        return this._dragging !== null;
    }

    draggedOid(): string | null {
        return this._dragging?.oid ?? null;
    }

    // ---- local changes -> ops ------------------------------------------------------

    private _newOid(): string {
        return this._tag + (this._counter++).toString(36);
    }

    private _register(box: LAWorkspaceBox, oid: string): void {
        nodeOf(box).dataset.coopOid = oid;
        this._boxes.set(oid, box);
    }

    private _onLocalCreate(box: LAWorkspaceBox): void {
        const oid = this._newOid();
        this._register(box, oid);
        const { x, y } = this._sharedPosition(box);
        this._shared.set(oid, { x, y });
        this._push(['a', oid, elementIdOf(box), x, y]);
    }

    private _onMutations(records: MutationRecord[]): void {
        if (!this.active) return;
        const removed = new Set<Node>();
        for (const record of records) for (const node of record.removedNodes) removed.add(node);
        for (const node of removed) {
            const oid = (node as Partial<HTMLElement>).dataset?.coopOid;
            // Re-appended to bring it to front: still on the canvas.
            if (!oid || !this._boxes.has(oid) || node.parentNode === this.win.workspace.el) continue;
            this._boxes.delete(oid);
            this._shared.delete(oid);
            this._holders.delete(oid);
            this._push(['d', oid]);
        }
    }

    private _canvasOid(drag: LADrag | undefined): string | null {
        const oid = drag?.element?.dataset?.coopOid;
        return oid && this._boxes.has(oid) ? oid : null;
    }

    private _onDragStart(drag: LADrag): void {
        if (!this.active) return;
        this._dragging = { oid: this._canvasOid(drag), held: false };
    }

    private _onDragMove(drag: LADrag): void {
        const dragging = this._dragging;
        if (!this.active || !dragging?.oid || this._canvasOid(drag) !== dragging.oid) return;
        if (!drag.dragPoint || (drag.dragPoint.x === 0 && drag.dragPoint.y === 0)) return;
        const oid = dragging.oid;
        if (!dragging.held) {
            dragging.held = true;
            this._push(['h', oid]);
        }
        const { x, y } = toShared(drag.position.x, drag.position.y, this.metrics());
        this._shared.set(oid, { x, y });
        this._push(['m', oid, x, y]);
    }

    // Runs after the game's own dragEnd handlers (it bubbles up to document), so
    // a combination or a delete has already happened.
    private _onDragEnd(): void {
        if (!this.active || !this._dragging) return;
        const { oid, held } = this._dragging;
        this._dragging = null;
        const box = oid === null ? undefined : this._boxes.get(oid);
        if (oid !== null && box && nodeOf(box).parentNode === this.win.workspace.el && held) {
            const { x, y } = this._sharedPosition(box);
            this._shared.set(oid, { x, y });
            this._push(['m', oid, x, y]);
            this._push(['r', oid]);
        }
        // Remote changes that waited for this drag.
        const deferred = this._deferred;
        this._deferred = [];
        for (const [ops, by] of deferred) this._applyNow(ops, by);
        if (this._pendingReconcile) {
            const target = this._pendingReconcile;
            this._pendingReconcile = null;
            this.reconcile(target, this._pendingMembers);
        }
    }

    // Keeps op order; consecutive moves of one element collapse into the latest.
    private _push(op: Op): void {
        const oid = op[1];
        if (op[0] === 'm') {
            for (let i = this._outbox.length - 1; i >= 0; i--) {
                const queued = this._outbox[i];
                if (!queued || queued[1] !== oid) continue;
                if (queued[0] === 'm') {
                    this._outbox[i] = op;
                    this._schedule(this._lastFlush + MOVE_INTERVAL_MS - Date.now());
                    return;
                }
                break;
            }
            this._outbox.push(op);
            this._schedule(this._lastFlush + MOVE_INTERVAL_MS - Date.now());
            return;
        }
        this._outbox.push(op);
        // setTimeout, so removals (reported in a microtask) land in the same batch.
        this._schedule(0);
    }

    private _schedule(delayMs: number): void {
        const at = Date.now() + Math.max(0, delayMs);
        if (this._flushTimer !== null && this._flushAt <= at) return;
        this.win.clearTimeout(this._flushTimer ?? undefined);
        this._flushAt = at;
        this._flushTimer = this.win.setTimeout(() => this._flushNow(), Math.max(0, delayMs));
    }

    private _flushNow(): void {
        this.win.clearTimeout(this._flushTimer ?? undefined);
        this._flushTimer = null;
        if (this._outbox.length === 0) return;
        const ops = this._outbox;
        const clear = this._clearFlag;
        this._outbox = [];
        this._clearFlag = false;
        this._lastFlush = Date.now();
        for (let i = 0; i < ops.length; i += MAX_OPS_PER_BATCH) {
            this.emit('ops', { ops: ops.slice(i, i + MAX_OPS_PER_BATCH), clear });
        }
    }

    // ---- remote changes -> canvas ----------------------------------------------------

    // Applies ops from another player.
    applyOps(ops: Op[], by: Who): void {
        if (!this.active) return;
        if (this._deferred.length > 0 || this._disturbsDrag(ops)) {
            this._deferred.push([ops, by]);
            return;
        }
        this._applyNow(ops, by);
    }

    private _disturbsDrag(ops: Op[]): boolean {
        const dragging = this._dragging;
        if (!dragging) return false;
        if (dragging.oid === null) return ops.some((op) => op[0] === 'd');
        return ops.some((op) => op[1] === dragging.oid);
    }

    private _applyNow(ops: Op[], by: Who): void {
        this._applying++;
        try {
            for (const op of ops) {
                try {
                    this._applyOp(op, by);
                } catch (err) {
                    console.error('[la-coop] could not apply', op, err);
                }
            }
        } finally {
            this._applying--;
        }
    }

    private _applyOp(op: Op, by: Who): void {
        const oid = op[1];
        const box = this._boxes.get(oid);
        switch (op[0]) {
            case 'a':
                if (box) this._moveTo(oid, box, op[3], op[4]);
                else this._create(oid, op[2], op[3], op[4]);
                break;
            case 'd':
                if (box) this._remove(oid, box);
                break;
            case 'm':
                if (box) this._moveTo(oid, box, op[2], op[3]);
                break;
            case 'h':
                if (box && by.id !== this.me) this._markHeld(oid, box, by);
                break;
            case 'r':
                if (box && this._holders.get(oid)?.id === by.id) this._unmarkHeld(oid, box);
                break;
            default:
                break;
        }
    }

    private _create(oid: string, el: number, x: number, y: number): LAWorkspaceBox {
        const { left, top } = toLocal(x, y, this.metrics());
        this._applying++;
        try {
            const box = this.win.workspace.add(el, { left, top });
            this._register(box, oid);
            this._shared.set(oid, { x, y });
            return box;
        } finally {
            this._applying--;
        }
    }

    private _remove(oid: string, box: LAWorkspaceBox): void {
        this._boxes.delete(oid);
        this._shared.delete(oid);
        this._holders.delete(oid);
        delete nodeOf(box).dataset.coopOid;
        this.win.workspace.del(box);
    }

    private _moveTo(oid: string, box: LAWorkspaceBox, x: number, y: number): void {
        this._shared.set(oid, { x, y });
        const { left, top } = toLocal(x, y, this.metrics());
        const el = nodeOf(box);
        if (parseFloat(el.style.left) === left && parseFloat(el.style.top) === top) return;
        el.style.left = left + 'px';
        el.style.top = top + 'px';
        // The drop target caches its position; keep it in step or drops miss.
        if (box.droppable?.position) box.droppable.position = { x: left, y: top };
    }

    private _markHeld(oid: string, box: LAWorkspaceBox, by: Holder): void {
        const el = nodeOf(box);
        this._holders.set(oid, by);
        el.dataset.coopHeld = '1';
        el.dataset.coopHolder = by.name;
        el.style.setProperty('--coop-color', colorFor(by.color));
        el.classList.add('coop-remote');
        if (el.parentNode) el.parentNode.appendChild(el); // bring to front, like a local drag
    }

    private _unmarkHeld(oid: string, box: LAWorkspaceBox): void {
        const el = nodeOf(box);
        this._holders.delete(oid);
        delete el.dataset.coopHeld;
        delete el.dataset.coopHolder;
        el.style.removeProperty('--coop-color');
        el.classList.remove('coop-remote');
    }

    // Makes the canvas match `state`: used for snapshots, refused batches and
    // replacing a joiner's canvas. members: id -> {name, color}.
    reconcile(state: WorkspaceState, members: MemberInfo = new Map()): void {
        if (!this.active) return;
        if (this._dragging) {
            this._pendingReconcile = state;
            this._pendingMembers = members;
            return;
        }
        this._deferred = [];
        this._applying++;
        try {
            for (const [oid, box] of [...this._boxes]) {
                const want = state.get(oid);
                if (!want || elementIdOf(box) !== want.el) this._remove(oid, box);
            }
            for (const [oid, e] of state.elements) {
                const box = this._boxes.get(oid);
                if (box) this._moveTo(oid, box, e.x, e.y);
                else this._create(oid, e.el, e.x, e.y);
            }
            for (const [oid, box] of this._boxes) {
                const holder = state.holderOf(oid);
                if (holder && holder !== this.me) {
                    const info = members.get(holder) ?? { name: '…', color: 0 };
                    this._markHeld(oid, box, { id: holder, name: info.name, color: info.color });
                } else if (this._holders.has(oid)) {
                    this._unmarkHeld(oid, box);
                }
            }
        } finally {
            this._applying--;
        }
    }

    // ---- interactions -------------------------------------------------------------------

    // A new press: any drag the game still thinks is running has lost its release.
    private _endStaleDrag(event: PointerEvent): void {
        if (!this.active || !event.isPrimary) return;
        const stale = this.win.Draggables?.isDragging;
        if (stale) {
            try {
                stale.dragEnd();
            } catch (err) {
                console.error('[la-coop] could not end a stale drag', err);
            }
        }
        if (this._dragging) this._onDragEnd();
    }

    // Elements another player is dragging can't be picked up.
    private _blockHeld(event: Event): void {
        if (!this.active) return;
        const target = event.target as Partial<Element> | null;
        const el = target?.closest?.<HTMLElement>('.element');
        if (el?.dataset.coopHeld) {
            event.stopPropagation();
            event.preventDefault();
        }
    }

    // In a room, the clear button removes only your own elements (with the
    // game's rule: just your final elements if final elements are marked).
    private _interceptClear(event: MouseEvent): void {
        const target = event.target as Partial<Element> | null;
        if (!this.active || !target?.closest?.('#clearWorkspace')) return;
        event.stopPropagation();
        event.preventDefault();
        const w = this.win;
        let mine = [...this._boxes].filter(([oid]) => this.ownerOf(oid) === this.me).map(([, box]) => nodeOf(box));
        mine = mine.filter((el) => !el.dataset.coopHeld);
        if (w.settings?.data?.markFinalElements) {
            const finals = mine.filter((el) => el.classList.contains('finalElement'));
            if (finals.length > 0) mine = finals;
        }
        if (mine.length === 0) return;
        this._clearFlag = true;
        w.workspace.clearSpecified(w.jQuery(mine));
        w.jQuery(w.document).trigger('workspaceCleared');
    }

    // Window size changed: re-fit every element from its shared position.
    private _refit(): void {
        if (!this.active) return;
        const w = this.win;
        this._applying++;
        try {
            for (const [oid, box] of this._boxes) {
                const pos = this._shared.get(oid);
                if (pos) this._moveTo(oid, box, pos.x, pos.y);
            }
        } finally {
            this._applying--;
        }
        // The game hid what was under the library; show what we moved back out.
        if (typeof w.workspace.hideUnderLibrary === 'function') w.workspace.hideUnderLibrary();
    }
}
