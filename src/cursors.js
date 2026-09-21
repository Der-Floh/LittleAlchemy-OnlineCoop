// Live cursors: everyone's pointer on the canvas, in their colour with their
// name, plus the icon of an element they're dragging out of the library.
// Positions use the same shared 0..1 space as the canvas elements, so a
// cursor over an element appears over that element on every screen.
//
// App message kind 'cur': {x, y, h?} (h = element id being dragged from the
// library) or {off: true} when the pointer leaves the canvas.

import { pointToShared, pointToLocal } from './workspace/projection.js';
import { isElementId } from './sync/pairs.js';
import { colorFor } from './ui/colors.js';

const SEND_INTERVAL_MS = 66; // ~15 updates a second
const STALE_MS = 20_000;
const SVG_NS = 'http://www.w3.org/2000/svg';

function unit(value) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : null;
}

export class Cursors {
  constructor({ win = window, session, bridge, layer, elementImage }) {
    this.win = win;
    this.session = session;
    this.bridge = bridge;
    this.layer = layer;
    this.elementImage = elementImage;
    this.enabled = true;
    this.active = false;
    this._installed = false;
    this._pending = null;
    this._lastSent = '';
    this._lastSentAt = 0;
    this._timer = null;
    this._holding = null;
    this._remote = new Map(); // playerId -> {node, name, ghost, at, x, y, h}

    session.on('app', (message) => this._onApp(message));
    session.on('members', (members) => this._pruneTo(members));
    session.on('status', ({ state }) => {
      if (state === 'idle' || state === 'rejected') this.stop();
    });
  }

  start() {
    if (this.active) return;
    this.active = true;
    this._install();
    this._sweep = setInterval(() => this._hideStale(), 5_000);
  }

  stop() {
    this.active = false;
    clearInterval(this._sweep);
    clearTimeout(this._timer);
    this._timer = null;
    this._pending = null;
    this._lastSent = '';
    this._clear();
  }

  setEnabled(on) {
    this.enabled = on;
    if (!on) this._clear();
  }

  // ---- our pointer --------------------------------------------------------------

  _install() {
    if (this._installed) return;
    this._installed = true;
    const w = this.win;
    w.document.addEventListener('pointermove', (e) => this._onPointer(e.clientX, e.clientY), true);
    w.document.addEventListener('pointerout', (e) => {
      if (!e.relatedTarget) this._queue({ off: true }); // left the window
    }, true);
    w.addEventListener('blur', () => this._queue({ off: true }));
    w.addEventListener('pagehide', () => this._queue({ off: true }));
    w.addEventListener('resize', () => this._refit());
    const $doc = w.jQuery(w.document);
    // Library drags carry their element as a "ghost" on our cursor.
    $doc.on('dragStart.laCoopCursor', (_e, drag) => {
      if (drag && drag.options && drag.options.helper && drag.element) {
        this._holding = parseInt(drag.element.getAttribute('data-elementid'), 10) || null;
      }
    });
    $doc.on('dragEnd.laCoopCursor', () => {
      if (this._holding === null) return;
      this._holding = null;
      if (this._pending && !this._pending.off) this._queue({ x: this._pending.x, y: this._pending.y });
    });
  }

  _connected() {
    return this.session.state === 'hosting' || this.session.state === 'connected';
  }

  _onPointer(clientX, clientY) {
    if (!this.active) return;
    const pos = pointToShared(clientX, clientY, this.bridge.metrics());
    if (!pos) {
      this._queue({ off: true });
      return;
    }
    const payload = { x: pos.x, y: pos.y };
    if (this._holding !== null) payload.h = this._holding;
    this._queue(payload);
  }

  _queue(payload) {
    if (!this.active) return;
    this._pending = payload;
    if (this._timer !== null) return;
    const wait = Math.max(0, this._lastSentAt + SEND_INTERVAL_MS - Date.now());
    this._timer = setTimeout(() => {
      this._timer = null;
      this._flush();
    }, wait);
  }

  _flush() {
    if (!this.active || !this._pending || !this._connected()) return;
    const json = JSON.stringify(this._pending);
    if (json === this._lastSent) return;
    if (this.session.sendApp('cur', this._pending)) {
      this._lastSent = json;
      this._lastSentAt = Date.now();
    }
  }

  // ---- everyone else's ------------------------------------------------------------

  _onApp({ k, d, by, fromHost }) {
    if (k !== 'cur' || !this.active) return;
    // The host passes each player's cursor on to the others.
    if (!fromHost && this.session.role === 'host') this.session.relayApp('cur', d, by.id);
    this.receive(by, d);
  }

  // Shows (or hides) another player's cursor. `by` = {id, name, color}.
  receive(by, d) {
    if (!by || by.id === this.session.playerId || !d || typeof d !== 'object') return;
    let entry = this._remote.get(by.id);
    if (d.off === true || !this.enabled) {
      if (entry) entry.node.hidden = true;
      return;
    }
    const x = unit(d.x);
    const y = unit(d.y);
    if (x === null || y === null) return;
    if (!entry) {
      entry = this._createNode(by);
      this._remote.set(by.id, entry);
    }
    if (entry.name.textContent !== by.name) entry.name.textContent = by.name;
    const color = colorFor(by.color);
    entry.arrow.setAttribute('fill', color);
    entry.name.style.background = color;
    const h = isElementId(d.h) ? d.h : null;
    if (h !== entry.h) {
      entry.h = h;
      const src = h ? this.elementImage(h) : null;
      entry.ghost.hidden = !src;
      if (src) entry.ghost.src = src;
    }
    entry.x = x;
    entry.y = y;
    entry.at = Date.now();
    entry.node.hidden = false;
    this._place(entry);
  }

  _createNode(by) {
    const doc = this.layer.ownerDocument;
    const node = doc.createElement('div');
    node.className = 'cursor';
    node.dataset.player = by.id;
    const svg = doc.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('width', '18');
    svg.setAttribute('height', '22');
    svg.setAttribute('viewBox', '0 0 18 22');
    const arrow = doc.createElementNS(SVG_NS, 'path');
    arrow.setAttribute('d', 'M1 1 L1 17 L5.5 13 L8.5 20.5 L11.5 19.2 L8.6 11.8 L14.5 11.8 Z');
    arrow.setAttribute('stroke', '#fff');
    arrow.setAttribute('stroke-width', '1.5');
    arrow.setAttribute('stroke-linejoin', 'round');
    svg.append(arrow);
    const name = doc.createElement('span');
    name.className = 'name';
    const ghost = doc.createElement('img');
    ghost.className = 'ghost';
    ghost.alt = '';
    ghost.hidden = true;
    node.append(svg, name, ghost);
    this.layer.append(node);
    return { node, arrow, name, ghost, at: 0, x: 0, y: 0, h: null };
  }

  _place(entry) {
    const { left, top } = pointToLocal(entry.x, entry.y, this.bridge.metrics());
    entry.node.style.transform = `translate(${left}px, ${top}px)`;
  }

  _refit() {
    for (const entry of this._remote.values()) if (!entry.node.hidden) this._place(entry);
  }

  _hideStale() {
    const cutoff = Date.now() - STALE_MS;
    for (const entry of this._remote.values()) if (entry.at < cutoff) entry.node.hidden = true;
  }

  _pruneTo(members) {
    const present = new Set(members.map((m) => m.id));
    for (const [id, entry] of this._remote) {
      if (!present.has(id)) {
        entry.node.remove();
        this._remote.delete(id);
      }
    }
  }

  _clear() {
    for (const entry of this._remote.values()) entry.node.remove();
    this._remote.clear();
  }
}
