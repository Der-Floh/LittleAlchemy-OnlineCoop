// The co-op UI: a small pill next to the game's fullscreen button that opens
// a panel (lobby / room / settings), plus discovery toasts and other players'
// cursors. It lives in a Shadow DOM so the game's CSS can't touch it, and it
// stops input events at its boundary so the game's document-level handlers
// (search-on-type, Backspace blocking, disabled context menu) don't interfere
// with typing.
//
// CoopPanel is what the rest of the extension talks to; its methods update
// the UI state (state.ts) and the Preact components (app.tsx) redraw.

import { render } from 'preact';
import type { RoomMember, Status } from '../net/session.ts';
import type { RoomFlags } from '../net/protocol.ts';
import type { Settings } from '../store.ts';
import type { BackupInfo } from '../game/adapter.ts';
import { App } from './app.tsx';
import { rejectText, type Availability } from './text.ts';
import { createUi, type AwayCard, type BannerAction, type CursorView, type PanelHandlers, type Part, type Ui } from './state.ts';

// Events the game listens for on document that must not see our UI's input.
const GUARDED_EVENTS = [
  'keydown',
  'keyup',
  'keypress',
  'contextmenu',
  'mousedown',
  'pointerdown',
  'touchstart',
  'touchmove',
  'wheel',
  'click',
  'dblclick',
  'paste',
  'copy',
  'cut',
];

const MAX_FEED = 60;
const MAX_TOASTS = 4;

export class CoopPanel {
  readonly ui: Ui;
  readonly host: HTMLElement;
  readonly shadow: ShadowRoot;
  private nextId = 0;

  constructor({ version, handlers }: { version: string; handlers: PanelHandlers }) {
    this.ui = createUi(version, handlers);
    // A custom tag (not a div) so page CSS doesn't match it, and inline styles
    // so our layer sits above everything, including the game's loading screen.
    this.host = document.createElement('la-coop');
    this.host.id = 'la-coop-root';
    this.host.style.cssText = 'all:initial;display:block;position:fixed;top:0;left:0;width:0;height:0;z-index:2147483000;';
    this.shadow = this.host.attachShadow({ mode: 'open' });
    for (const type of GUARDED_EVENTS) this.host.addEventListener(type, (event) => event.stopPropagation());
    render(<App ui={this.ui} />, this.shadow);
    (document.body || document.documentElement).append(this.host);
    this.watchNightMode();
  }

  private watchNightMode(): void {
    const sync = () => (this.ui.night.value = !!document.body && document.body.classList.contains('nightMode'));
    sync();
    if (document.body) new MutationObserver(sync).observe(document.body, { attributes: true, attributeFilter: ['class'] });
  }

  // True while the player is typing in that text field (so we don't overwrite it).
  private isTyping(name: string): boolean {
    const active = this.shadow.activeElement;
    return active instanceof HTMLInputElement && active.name === name;
  }

  // ---- public API ----------------------------------------------------------

  get available(): Availability {
    return this.ui.available.value;
  }

  get room(): RoomFlags {
    return this.ui.room.value;
  }

  open(): void {
    this.ui.open.value = true;
  }

  close(): void {
    this.ui.open.value = false;
  }

  toggle(): void {
    this.ui.open.value = !this.ui.open.value;
  }

  showSettings(open: boolean): void {
    this.ui.settingsOpen.value = open;
  }

  setAvailability(available: Availability): void {
    this.ui.available.value = available;
  }

  setSettings(settings: Settings): void {
    this.ui.settings.value = { ...settings };
    if (!this.isTyping('name')) this.ui.nameDraft.value = settings.name;
    const server = settings.peerServer;
    this.ui.serverDraft.value = {
      host: server?.host ?? '',
      port: server ? String(server.port) : '',
      path: server?.path ?? '',
      key: server?.key ?? '',
      secure: server ? server.secure : true,
    };
  }

  setBackup(info: BackupInfo | null): void {
    this.ui.backup.value = info;
  }

  setStatus(status: Status): void {
    this.ui.status.value = { ...status };
  }

  setMembers(members: RoomMember[]): void {
    this.ui.members.value = members;
  }

  setRoom(room: RoomFlags): void {
    this.ui.room.value = room;
  }

  // "While you were away": a card listing the elements that arrived.
  showAway(card: AwayCard): void {
    this.ui.away.value = card;
    this.open();
  }

  hideAway(): void {
    this.ui.away.value = null;
  }

  prefillCode(code: string): void {
    this.ui.codeDraft.value = code;
  }

  showBanner(text: string, { tone = 'info', actions = [] }: { tone?: 'info' | 'bad'; actions?: BannerAction[] } = {}): void {
    this.ui.banner.value = { text, tone, actions };
  }

  hideBanner(): void {
    this.ui.banner.value = null;
  }

  addFeed(parts: Part[], { muted = false } = {}): void {
    this.ui.feed.value = [{ id: this.nextId++, parts, muted }, ...this.ui.feed.value].slice(0, MAX_FEED);
  }

  clearFeed(): void {
    this.ui.feed.value = [];
  }

  toast({ image, parts }: { image: string | null; parts: Part[] }): void {
    const id = this.nextId++;
    const toasts = this.ui.toasts;
    toasts.value = [...toasts.value, { id, image, parts, leaving: false }].slice(-MAX_TOASTS);
    setTimeout(() => {
      toasts.value = toasts.value.map((t) => (t.id === id ? { ...t, leaving: true } : t));
      setTimeout(() => (toasts.value = toasts.value.filter((t) => t.id !== id)), 350);
    }, 4500);
  }

  setCursors(cursors: CursorView[]): void {
    this.ui.cursors.value = cursors;
  }

  rejectText(reason: string, detail: string): string {
    return rejectText(reason, detail);
  }
}
