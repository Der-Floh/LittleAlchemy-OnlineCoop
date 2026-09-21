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
// - workspace.del() removes document-level jQuery pointer handlers, so our
//   pointer listeners are native.
//
// Emits 'ops' {ops, clear} with batches of local changes. Remote changes come
// in through applyOps() and reconcile().

import { Emitter } from '../emitter.js';
import { toShared, toLocal } from '../workspace/projection.js';
import { MAX_OPS_PER_BATCH } from '../workspace/ops.js';
import { colorFor } from '../ui/colors.js';
import pageCss from '../ui/page.css';

const NS = '.laCoopWs';
const MOVE_INTERVAL_MS = 50;
const POINTER_START_EVENTS = ['mousedown', 'touchstart', 'pointerdown'];

function randomTag() {
  let tag = '';
  for (let i = 0; i < 5; i++) tag += 'abcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(Math.random() * 36)];
  return tag;
}

export class WorkspaceBridge extends Emitter {
  constructor(win = window) {
    super();
    this.win = win;
    this.active = false;
    this.me = null;
    // Set by the sync: who placed an element (for "clear only mine").
    this.ownerOf = () => null;
    this._boxes = new Map(); // oid -> WorkspaceBox
    this._shared = new Map(); // oid -> {x, y}: shared position, for re-fitting on resize
    this._holders = new Map(); // oid -> {id, name, color} of another player dragging it
    this._tag = randomTag();
    this._counter = 0;
    this._outbox = [];
    this._clearFlag = false;
    this._flushTimer = null;
    this._flushAt = 0;
    this._lastFlush = 0;
    this._applying = 0; // > 0 while we change the canvas ourselves
    this._dragging = null; // {oid, held} while the local player drags a canvas element
    this._deferred = []; // remote batches waiting for the local drag to end
    this._pendingReconcile = null;
    this._installed = false;
  }

  // ---- lifecycle -------------------------------------------------------------

  activate(me) {
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
      const box = w.jQuery(el).data('ptr');
      if (!box) continue;
      const oid = this._newOid();
      this._register(box, oid);
      this._shared.set(oid, this._sharedPosition(box));
    }
  }

  deactivate() {
    if (!this.active) return;
    this.active = false;
    const w = this.win;
    clearTimeout(this._flushTimer);
    this._flushTimer = null;
    for (const [oid, box] of this._boxes) {
      this._unmarkHeld(oid, box);
      delete box.$el[0].dataset.coopOid;
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
  _installOnce() {
    if (this._installed) return;
    this._installed = true;
    const w = this.win;
    const bridge = this;

    const proto = w.WorkspaceBox.prototype;
    const initEvents = proto.initEvents;
    proto.initEvents = function (...args) {
      const result = initEvents.apply(this, args);
      if (bridge.active && !bridge._applying) {
        try {
          bridge._onLocalCreate(this);
        } catch (err) {
          console.error('[la-coop] workspace hook failed', err);
        }
      }
      return result;
    };

    const accept = w.Droppable.prototype._accept;
    w.Droppable.prototype._accept = function (element) {
      if (bridge.active && this.element && this.element.dataset && this.element.dataset.coopHeld) return false;
      return accept.call(this, element);
    };

    new w.MutationObserver((records) => this._onMutations(records)).observe(w.workspace.el, { childList: true });

    const $doc = w.jQuery(w.document);
    $doc.on('dragStart' + NS, (_e, drag) => this._onDragStart(drag));
    $doc.on('dragMove' + NS, (_e, drag) => this._onDragMove(drag));
    $doc.on('dragEnd' + NS, (_e, drag) => this._onDragEnd(drag));

    for (const type of POINTER_START_EVENTS) {
      w.workspace.el.addEventListener(type, (event) => this._blockHeld(event), true);
    }
    w.document.addEventListener('click', (event) => this._interceptClear(event), true);
    w.addEventListener('resize', () => this._refit());
    w.addEventListener('orientationchange', () => this._refit());
  }

  // ---- geometry ----------------------------------------------------------------

  metrics() {
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

  _sharedPosition(box) {
    const el = box.$el[0];
    let left = parseFloat(el.style.left);
    let top = parseFloat(el.style.top);
    if (!Number.isFinite(left) || !Number.isFinite(top)) ({ left, top } = box.$el.position());
    return toShared(left, top, this.metrics());
  }

  // The canvas as ops, e.g. to seed a new room with the host's elements.
  currentElements() {
    const ops = [];
    for (const [oid, box] of this._boxes) {
      const { x, y } = this._sharedPosition(box);
      ops.push(['a', oid, parseInt(box.id, 10), x, y]);
    }
    return ops;
  }

  isDragging() {
    return this._dragging !== null;
  }

  // ---- local changes -> ops ------------------------------------------------------

  _newOid() {
    return this._tag + (this._counter++).toString(36);
  }

  _register(box, oid) {
    box.$el[0].dataset.coopOid = oid;
    this._boxes.set(oid, box);
  }

  _onLocalCreate(box) {
    const oid = this._newOid();
    this._register(box, oid);
    const { x, y } = this._sharedPosition(box);
    this._shared.set(oid, { x, y });
    this._push(['a', oid, parseInt(box.id, 10), x, y]);
  }

  _onMutations(records) {
    if (!this.active) return;
    const removed = new Set();
    for (const record of records) for (const node of record.removedNodes) removed.add(node);
    for (const node of removed) {
      const oid = node.dataset && node.dataset.coopOid;
      // Re-appended to bring it to front: still on the canvas.
      if (!oid || !this._boxes.has(oid) || node.parentNode === this.win.workspace.el) continue;
      this._boxes.delete(oid);
      this._shared.delete(oid);
      this._holders.delete(oid);
      this._push(['d', oid]);
    }
  }

  _canvasOid(drag) {
    const el = drag && drag.element;
    const oid = el && el.dataset && el.dataset.coopOid;
    return oid && this._boxes.has(oid) ? oid : null;
  }

  _onDragStart(drag) {
    if (!this.active) return;
    const oid = this._canvasOid(drag);
    if (oid) this._dragging = { oid, held: false };
  }

  _onDragMove(drag) {
    if (!this.active || !this._dragging || this._canvasOid(drag) !== this._dragging.oid) return;
    if (!drag.dragPoint || (drag.dragPoint.x === 0 && drag.dragPoint.y === 0)) return;
    const { oid } = this._dragging;
    if (!this._dragging.held) {
      this._dragging.held = true;
      this._push(['h', oid]);
    }
    const { x, y } = toShared(drag.position.x, drag.position.y, this.metrics());
    this._shared.set(oid, { x, y });
    this._push(['m', oid, x, y]);
  }

  // Runs after the game's own dragEnd handlers (it bubbles up to document), so
  // a combination or a delete has already happened.
  _onDragEnd(drag) {
    if (!this.active || !this._dragging) return;
    const { oid, held } = this._dragging;
    this._dragging = null;
    const box = this._boxes.get(oid);
    if (box && box.$el[0].parentNode === this.win.workspace.el && held) {
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
  _push(op) {
    const [kind, oid] = op;
    if (kind === 'm') {
      for (let i = this._outbox.length - 1; i >= 0; i--) {
        if (this._outbox[i][1] !== oid) continue;
        if (this._outbox[i][0] === 'm') {
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

  _schedule(delayMs) {
    const at = Date.now() + Math.max(0, delayMs);
    if (this._flushTimer !== null && this._flushAt <= at) return;
    clearTimeout(this._flushTimer);
    this._flushAt = at;
    this._flushTimer = setTimeout(() => this._flushNow(), Math.max(0, delayMs));
  }

  _flushNow() {
    clearTimeout(this._flushTimer);
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

  // Applies ops from another player (`by` = {id, name, color}).
  applyOps(ops, by) {
    if (!this.active) return;
    const draggedOid = this._dragging && this._dragging.oid;
    if (this._deferred.length > 0 || (draggedOid && ops.some((op) => op[1] === draggedOid))) {
      this._deferred.push([ops, by]);
      return;
    }
    this._applyNow(ops, by);
  }

  _applyNow(ops, by) {
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

  _applyOp(op, by) {
    const [kind, oid] = op;
    const box = this._boxes.get(oid);
    switch (kind) {
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
        if (box && by && by.id !== this.me) this._markHeld(oid, box, by);
        break;
      case 'r':
        if (box && this._holders.has(oid) && (!by || this._holders.get(oid).id === by.id)) this._unmarkHeld(oid, box);
        break;
      default:
        break;
    }
  }

  _create(oid, el, x, y) {
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

  _remove(oid, box) {
    this._boxes.delete(oid);
    this._shared.delete(oid);
    this._holders.delete(oid);
    delete box.$el[0].dataset.coopOid;
    this.win.workspace.del(box);
  }

  _moveTo(oid, box, x, y) {
    this._shared.set(oid, { x, y });
    const { left, top } = toLocal(x, y, this.metrics());
    const el = box.$el[0];
    if (parseFloat(el.style.left) === left && parseFloat(el.style.top) === top) return;
    el.style.left = left + 'px';
    el.style.top = top + 'px';
    // The drop target caches its position; keep it in step or drops miss.
    if (box.droppable && box.droppable.position) box.droppable.position = { x: left, y: top };
  }

  _markHeld(oid, box, by) {
    const el = box.$el[0];
    this._holders.set(oid, by);
    el.dataset.coopHeld = '1';
    el.dataset.coopHolder = by.name;
    el.style.setProperty('--coop-color', colorFor(by.color));
    el.classList.add('coop-remote');
    if (el.parentNode) el.parentNode.appendChild(el); // bring to front, like a local drag
  }

  _unmarkHeld(oid, box) {
    const el = box.$el[0];
    this._holders.delete(oid);
    delete el.dataset.coopHeld;
    delete el.dataset.coopHolder;
    el.style.removeProperty('--coop-color');
    el.classList.remove('coop-remote');
  }

  // Makes the canvas match `state` (a WorkspaceState): used for snapshots,
  // refused batches and replacing a joiner's canvas. members: id -> {name, color}.
  reconcile(state, members = new Map()) {
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
        if (!want || parseInt(box.id, 10) !== want.el) this._remove(oid, box);
      }
      for (const [oid, e] of state.elements) {
        const box = this._boxes.get(oid);
        if (box) this._moveTo(oid, box, e.x, e.y);
        else this._create(oid, e.el, e.x, e.y);
      }
      for (const [oid, box] of this._boxes) {
        const holder = state.holderOf(oid);
        if (holder && holder !== this.me) {
          const info = members.get(holder) || { name: '…', color: 0 };
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

  // Elements another player is dragging can't be picked up.
  _blockHeld(event) {
    if (!this.active) return;
    const el = event.target && event.target.closest && event.target.closest('.element');
    if (el && el.dataset.coopHeld) {
      event.stopPropagation();
      event.preventDefault();
    }
  }

  // In a room, the clear button removes only your own elements (with the
  // game's rule: just your final elements if final elements are marked).
  _interceptClear(event) {
    if (!this.active || !event.target || !event.target.closest || !event.target.closest('#clearWorkspace')) return;
    event.stopPropagation();
    event.preventDefault();
    const w = this.win;
    let mine = [...this._boxes].filter(([oid]) => this.ownerOf(oid) === this.me).map(([, box]) => box.$el[0]);
    mine = mine.filter((el) => !el.dataset.coopHeld);
    if (w.settings && w.settings.data && w.settings.data.markFinalElements) {
      const finals = mine.filter((el) => el.classList.contains('finalElement'));
      if (finals.length > 0) mine = finals;
    }
    if (mine.length === 0) return;
    this._clearFlag = true;
    w.workspace.clearSpecified(w.jQuery(mine));
    w.jQuery(w.document).trigger('workspaceCleared');
  }

  // Window size changed: re-fit every element from its shared position.
  _refit() {
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
