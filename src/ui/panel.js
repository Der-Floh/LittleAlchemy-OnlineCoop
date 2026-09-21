// The co-op UI: a small pill next to the game's fullscreen button that opens
// a panel (lobby / room / settings), plus discovery toasts. It lives in a
// Shadow DOM so the game's CSS can't touch it, and it stops input events at
// its boundary so the game's document-level handlers (search-on-type,
// Backspace blocking, disabled context menu) don't interfere with typing.

import css from './styles.css';
import { colorFor } from './colors.js';

export { PLAYER_COLORS, colorFor } from './colors.js';

const DETAIL_TEXT = {
  broker: "can't reach the matchmaking server",
  webrtc: 'direct connection failed, your network may block peer-to-peer',
  timeout: 'connection timed out',
  closed: 'connection closed',
  error: 'connection error',
  rtc: 'connection dropped',
  'host-left': 'the host left, switching host',
  rehome: 'switching host',
  handover: 'handing over the host',
};

const REJECT_TEXT = {
  version: 'Your co-op extension version does not match the host. Update the extension on both sides.',
  build: 'You and the host play different versions of Little Alchemy.',
  full: 'That room is full.',
  replaced: 'You are connected to this room from another window or tab.',
  kicked: 'The host removed you from this room.',
  locked: 'This room is locked by its host.',
};

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

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'text') el.textContent = value;
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value);
    else if (typeof value === 'boolean' || typeof value === 'number') el[key] = value;
    else el.setAttribute(key, value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : String(child));
  }
  return el;
}

// replaceChildren that skips null/false slots (the DOM would print "null").
function setChildren(el, ...children) {
  el.replaceChildren(...children.flat().filter((child) => child !== null && child !== undefined && child !== false));
}

// Renders a list of rich-text parts:
//   'text' | {who: {name, color}} | {el: 'steam', isNew: true}
function renderParts(parts) {
  return parts.map((part) => {
    if (typeof part === 'string') return part;
    if (part.who) {
      const span = h('span', { class: 'who', text: part.who.name });
      span.style.color = colorFor(part.who.color);
      return span;
    }
    if (part.el !== undefined) {
      const span = h('span', { class: part.bold ? 'what' : '', text: part.el });
      return part.isNew ? [span, h('span', { class: 'new', text: 'new' })] : span;
    }
    return '';
  });
}

export class CoopPanel {
  constructor({ version, handlers }) {
    this.handlers = handlers;
    this.version = version;
    this.view = 'lobby';
    this.settingsOpen = false;
    this.available = 'loading';
    this.status = { state: 'idle', role: null, code: null, detail: null };
    this.members = [];
    this.room = { locked: false, banned: [], allowed: [] };
    this._build();
  }

  // ---- construction --------------------------------------------------------

  _build() {
    // A custom tag (not a div) so page CSS doesn't match it, and inline styles
    // so our layer sits above everything, including the game's loading screen.
    this.host = document.createElement('la-coop');
    this.host.id = 'la-coop-root';
    this.host.style.cssText =
      'all:initial;display:block;position:fixed;top:0;left:0;width:0;height:0;z-index:2147483000;';
    const shadow = this.host.attachShadow({ mode: 'open' });
    this.shadow = shadow;
    for (const type of GUARDED_EVENTS) this.host.addEventListener(type, (event) => event.stopPropagation());

    this.pillDot = h('span', { class: 'dot' });
    this.pillExtra = h('span', { class: 'extra' });
    this.pill = h(
      'button',
      { class: 'pill', title: 'Little Alchemy Co-op', 'aria-expanded': 'false', onclick: () => this.toggle() },
      this.pillDot,
      h('span', { text: 'Co-op' }),
      this.pillExtra,
    );

    this.banner = h('div', { class: 'banner', role: 'status' });
    this.banner.hidden = true;

    this.lobbyView = this._buildLobby();
    this.roomView = this._buildRoom();
    this.settingsView = this._buildSettings();

    this.settingsButton = h('button', {
      class: 'subtle',
      title: 'Settings',
      'aria-label': 'Settings',
      text: '⚙',
      onclick: () => this.showSettings(!this.settingsOpen),
    });
    this.panel = h(
      'section',
      { class: 'panel', 'aria-label': 'Co-op panel' },
      h(
        'header',
        {},
        h('h2', {}, 'Co-op', h('small', { text: 'unofficial' })),
        this.settingsButton,
        h('button', { class: 'subtle', title: 'Close', 'aria-label': 'Close', text: '✕', onclick: () => this.close() }),
      ),
      this.banner,
      this.lobbyView,
      this.roomView,
      this.settingsView,
    );
    this.panel.hidden = true;
    this.panel.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') this.close();
    });

    this.toasts = h('div', { class: 'toasts', 'aria-live': 'polite' });
    this.cursorLayer = h('div', { class: 'cursors', 'aria-hidden': 'true' });
    this.root = h('div', { class: 'root' }, this.cursorLayer, this.pill, this.panel, this.toasts);
    shadow.append(h('style', { text: css }), this.root);

    (document.body || document.documentElement).append(this.host);
    this._watchNightMode();
    this._render();
  }

  _buildLobby() {
    this.nameInput = h('input', { type: 'text', maxlength: '24', autocomplete: 'off', spellcheck: 'false' });
    this.nameInput.addEventListener('change', () => this.handlers.onRename(this.nameInput.value));
    this.createButton = h('button', { class: 'primary', text: 'Create room', onclick: () => this.handlers.onCreate() });
    this.codeInput = h('input', {
      type: 'text',
      class: 'code-input',
      maxlength: '8',
      placeholder: 'CODE',
      autocomplete: 'off',
      spellcheck: 'false',
      'aria-label': 'Room code',
    });
    this.codeInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') this._submitJoin();
    });
    this.joinButton = h('button', { text: 'Join', onclick: () => this._submitJoin() });
    return h(
      'div',
      { class: 'view stack' },
      h('label', { class: 'field' }, 'Your name', this.nameInput),
      this.createButton,
      h('div', { class: 'divider', text: 'or join a friend' }),
      h('div', { class: 'row' }, this.codeInput, this.joinButton),
      h('p', {
        class: 'note',
        text:
          'Joining merges progress both ways: everything anyone in the room discovers ends up in everyone’s save. ' +
          'Your current save is backed up once (see ⚙).',
      }),
    );
  }

  _buildRoom() {
    this.roomCode = h('span', { class: 'room-code' });
    this.copyCodeButton = h('button', { text: 'Copy', title: 'Copy the room code', onclick: () => this._copy('code') });
    this.copyLinkButton = h('button', { text: 'Invite link', title: 'Copy an invite link', onclick: () => this._copy('link') });
    this.statusDot = h('span', { class: 'dot' });
    this.statusText = h('span');
    this.playerList = h('ul', { class: 'players' });
    this.feed = h('ol', { class: 'feed' });
    this.feedEmpty = h('div', { class: 'feed-empty', text: 'Discoveries from everyone in the room show up here.' });
    this.lockBadge = h('span', { class: 'lock-badge', text: 'Locked', title: 'New players can’t join this room' });
    this.lockBadge.hidden = true;
    this.lockButton = h('button', { class: 'subtle lock-button', onclick: () => this.handlers.onLock(!this.room.locked) });
    this.awayTitle = h('div', { class: 'away-title' });
    this.awaySubtitle = h('div', { class: 'away-subtitle' });
    this.awayGrid = h('div', { class: 'away-grid' });
    this.awayCard = h(
      'div',
      { class: 'away', role: 'status' },
      h('button', { class: 'subtle away-close', title: 'Dismiss', 'aria-label': 'Dismiss', text: '✕', onclick: () => this.hideAway() }),
      this.awayTitle,
      this.awaySubtitle,
      this.awayGrid,
    );
    this.awayCard.hidden = true;
    return h(
      'div',
      { class: 'view stack' },
      this.awayCard,
      h('div', { class: 'room-code-row' }, this.roomCode, this.copyCodeButton, this.copyLinkButton),
      h('div', { class: 'status-line' }, this.statusDot, this.statusText),
      h('div', { class: 'players-head' }, h('div', { class: 'section-title', text: 'Players' }), this.lockBadge, this.lockButton),
      this.playerList,
      h('div', { class: 'section-title', text: 'Activity' }),
      this.feedEmpty,
      this.feed,
      h('button', { class: 'danger', text: 'Leave room', onclick: () => this.handlers.onLeave() }),
    );
  }

  _buildSettings() {
    this.settingsName = h('input', { type: 'text', maxlength: '24', autocomplete: 'off', spellcheck: 'false' });
    this.settingsName.addEventListener('change', () => this.handlers.onRename(this.settingsName.value));
    this.toastsToggle = h('input', { type: 'checkbox' });
    this.toastsToggle.addEventListener('change', () => this.handlers.onToasts(this.toastsToggle.checked));
    this.cursorsToggle = h('input', { type: 'checkbox' });
    this.cursorsToggle.addEventListener('change', () => this.handlers.onCursors(this.cursorsToggle.checked));

    this.backupText = h('p', { class: 'note' });
    this.restoreButton = h('button', { text: 'Restore backup', onclick: () => this._confirmRestore() });
    this.discardButton = h('button', { class: 'danger', text: 'Delete backup', onclick: () => this._confirmDiscard() });

    this.serverHost = h('input', { type: 'text', placeholder: 'host (e.g. peer.example.com)', spellcheck: 'false' });
    this.serverPort = h('input', { type: 'number', placeholder: 'port', min: '1', max: '65535' });
    this.serverPath = h('input', { type: 'text', placeholder: 'path (default /)', spellcheck: 'false' });
    this.serverKey = h('input', { type: 'text', placeholder: 'key (default peerjs)', spellcheck: 'false' });
    this.serverSecure = h('input', { type: 'checkbox', checked: true });
    this.serverNote = h('p', { class: 'note' });

    return h(
      'div',
      { class: 'view stack' },
      h('label', { class: 'field' }, 'Your name', this.settingsName),
      h('label', { class: 'check' }, this.toastsToggle, 'Pop-ups for your friends’ discoveries'),
      h('label', { class: 'check' }, this.cursorsToggle, 'Show other players’ cursors'),
      h('div', { class: 'section-title', text: 'Backup' }),
      this.backupText,
      h('div', { class: 'row' }, this.restoreButton, this.discardButton),
      h(
        'details',
        {},
        h('summary', { text: 'Advanced: own PeerJS server' }),
        h(
          'div',
          { class: 'stack' },
          h('p', {
            class: 'note',
            text:
              'Rooms find each other through the free public PeerJS server (0.peerjs.com). ' +
              'If it is down you can point everyone in the room at your own PeerServer.',
          }),
          h('div', { class: 'grid2' }, this.serverHost, this.serverPort),
          h('div', { class: 'grid2' }, this.serverPath, h('label', { class: 'check' }, this.serverSecure, 'https')),
          this.serverKey,
          this.serverNote,
          h(
            'div',
            { class: 'row' },
            h('button', { text: 'Use this server', onclick: () => this._submitServer() }),
            h('button', { class: 'subtle', text: 'Use default', onclick: () => this.handlers.onPeerServer(null) }),
          ),
        ),
      ),
      h('p', { class: 'about', text: 'Little Alchemy Co-op v' + this.version + ' · unofficial fan project' }),
      h('button', { text: 'Back', onclick: () => this.showSettings(false) }),
    );
  }

  _watchNightMode() {
    const sync = () => this.root.classList.toggle('night', !!document.body && document.body.classList.contains('nightMode'));
    sync();
    if (document.body) new MutationObserver(sync).observe(document.body, { attributes: true, attributeFilter: ['class'] });
  }

  // ---- actions -------------------------------------------------------------

  _submitJoin() {
    this.handlers.onJoin(this.codeInput.value);
  }

  _submitServer() {
    this.handlers.onPeerServer({
      host: this.serverHost.value,
      port: this.serverPort.value,
      path: this.serverPath.value,
      key: this.serverKey.value,
      secure: this.serverSecure.checked,
    });
  }

  _confirmRestore() {
    if (window.confirm('Replace your current Little Alchemy progress with the backup? Progress made since then will be lost.')) {
      this.handlers.onRestoreBackup();
    }
  }

  _confirmDiscard() {
    if (window.confirm('Delete the backup of your pre-co-op save?')) this.handlers.onDiscardBackup();
  }

  async _copy(what) {
    const code = this.status.code || '';
    const text = what === 'link' ? 'https://littlealchemy.com/#coop=' + code : code;
    const button = what === 'link' ? this.copyLinkButton : this.copyCodeButton;
    const label = button.textContent;
    let ok = false;
    try {
      await navigator.clipboard.writeText(text);
      ok = true;
    } catch {
      const area = h('textarea', {});
      area.value = text;
      this.shadow.append(area);
      area.select();
      try {
        ok = document.execCommand('copy');
      } catch {
        ok = false;
      }
      area.remove();
    }
    button.textContent = ok ? 'Copied!' : 'Copy failed';
    setTimeout(() => {
      button.textContent = label;
    }, 1500);
  }

  // ---- public API ----------------------------------------------------------

  open() {
    this.panel.hidden = false;
    this.pill.setAttribute('aria-expanded', 'true');
  }

  close() {
    this.panel.hidden = true;
    this.pill.setAttribute('aria-expanded', 'false');
  }

  toggle() {
    if (this.panel.hidden) this.open();
    else this.close();
  }

  showSettings(open) {
    this.settingsOpen = open;
    this._render();
  }

  // 'loading' | 'ready' | 'passive' | 'fatal'
  setAvailability(available, message = '') {
    this.available = available;
    this.availabilityMessage = message;
    this._render();
  }

  setSettings(settings) {
    for (const input of [this.nameInput, this.settingsName]) {
      if (this.shadow.activeElement !== input) input.value = settings.name;
    }
    this.toastsToggle.checked = settings.toasts;
    this.cursorsToggle.checked = settings.cursors;
    const server = settings.peerServer;
    this.serverHost.value = server ? server.host : '';
    this.serverPort.value = server ? String(server.port) : '';
    this.serverPath.value = server ? server.path : '';
    this.serverKey.value = server ? server.key : '';
    this.serverSecure.checked = server ? server.secure : true;
    this.serverNote.textContent = server
      ? 'Using ' + server.host + ':' + server.port + server.path + '. Everyone in the room must use the same server.'
      : 'Using the public PeerJS server.';
  }

  setBackup(info) {
    if (info) {
      const date = new Date(info.savedAt);
      this.backupText.textContent =
        'Your save from before you first used co-op (' + date.toLocaleString() + ', ' + info.count + ' elements) is kept here.';
    } else {
      this.backupText.textContent = 'No backup yet. One is made automatically the first time you join a room.';
    }
    this.hasBackup = !!info;
    this._render();
  }

  setStatus(status) {
    this.status = { ...status };
    this._render();
  }

  setMembers(members) {
    this.members = members;
    const iAmHost = members.some((m) => m.you && m.host);
    setChildren(
      this.playerList,
      ...members.map((m) => {
        const dot = h('span', { class: 'dot' });
        dot.style.background = colorFor(m.color);
        const actions =
          iAmHost && !m.you
            ? h(
                'span',
                { class: 'player-actions' },
                h('button', {
                  class: 'subtle',
                  text: 'Make host',
                  title: 'Make ' + m.name + ' the host',
                  onclick: () => {
                    if (window.confirm('Make ' + m.name + ' the host of this room?')) this.handlers.onHandOver(m);
                  },
                }),
                h('button', {
                  class: 'subtle danger',
                  text: 'Kick',
                  title: 'Remove ' + m.name + ' from the room',
                  onclick: () => {
                    if (window.confirm('Remove ' + m.name + ' from the room? They can’t rejoin until everyone has left.')) {
                      this.handlers.onKick(m);
                    }
                  },
                }),
              )
            : null;
        return h(
          'li',
          { 'data-player': m.id },
          dot,
          h('span', { class: 'player-name', text: m.name }),
          m.you ? h('span', { class: 'tag', text: 'you' }) : null,
          m.host ? h('span', { class: 'tag', text: 'host' }) : null,
          actions,
        );
      }),
    );
    this._render();
  }

  setRoom(room) {
    this.room = room;
    this._render();
  }

  // "While you were away": a card listing the elements that arrived.
  showAway({ title, subtitle, elements }) {
    const shown = elements.slice(0, 48);
    this.awayTitle.textContent = title;
    this.awaySubtitle.textContent = subtitle;
    setChildren(
      this.awayGrid,
      ...shown.map((e) =>
        h('div', { class: 'away-item', title: e.name }, e.image ? h('img', { src: e.image, alt: '' }) : null, h('span', { text: e.name })),
      ),
      elements.length > shown.length ? h('div', { class: 'away-more', text: '+' + (elements.length - shown.length) + ' more' }) : null,
    );
    this.awayCard.hidden = false;
    this.open();
  }

  hideAway() {
    this.awayCard.hidden = true;
  }

  prefillCode(code) {
    this.codeInput.value = code;
  }

  showBanner(text, { tone = 'info', actions = [] } = {}) {
    setChildren(
      this.banner,
      h('div', { text }),
      actions.length
        ? h('div', { class: 'banner-actions' }, ...actions.map((a) => h('button', { class: a.primary ? 'primary' : '', text: a.label, onclick: a.onClick })))
        : null,
    );
    this.banner.dataset.tone = tone;
    this.banner.hidden = false;
  }

  hideBanner() {
    this.banner.hidden = true;
  }

  addFeed(parts, { muted = false } = {}) {
    const item = h('li', { class: muted ? 'muted' : '' }, ...renderParts(parts));
    this.feed.prepend(item);
    while (this.feed.children.length > 60) this.feed.lastElementChild.remove();
    this.feedEmpty.hidden = true;
  }

  clearFeed() {
    this.feed.replaceChildren();
    this.feedEmpty.hidden = false;
  }

  toast({ image, parts }) {
    const toast = h('div', { class: 'toast' }, image ? h('img', { src: image, alt: '' }) : null, h('span', {}, ...renderParts(parts)));
    this.toasts.append(toast);
    while (this.toasts.children.length > 4) this.toasts.firstElementChild.remove();
    setTimeout(() => {
      toast.classList.add('leaving');
      setTimeout(() => toast.remove(), 350);
    }, 4500);
  }

  // ---- rendering -----------------------------------------------------------

  _render() {
    const { state, code, detail } = this.status;
    const inRoom = state !== 'idle' && state !== 'rejected';
    const usable = this.available === 'ready';

    this.lobbyView.hidden = this.settingsOpen || inRoom;
    this.roomView.hidden = this.settingsOpen || !inRoom;
    this.settingsView.hidden = !this.settingsOpen;
    this.settingsButton.setAttribute('aria-pressed', String(this.settingsOpen));

    for (const control of [this.createButton, this.joinButton, this.codeInput]) control.disabled = !usable;
    this.restoreButton.disabled = !this.hasBackup || inRoom || !usable;
    this.discardButton.disabled = !this.hasBackup;
    this.restoreButton.title = inRoom ? 'Leave the room first' : '';

    let tone = 'idle';
    let text = '';
    const others = this.members.filter((m) => !m.you).length;
    if (state === 'connecting') {
      tone = 'warn';
      text = 'Connecting…';
    } else if (state === 'hosting') {
      tone = 'ok';
      text = others === 0 ? 'You are hosting. Waiting for friends to join (share the code, and double-check it if you expected someone).' : 'Connected. You are the host.';
    } else if (state === 'connected') {
      tone = 'ok';
      text = 'Connected.';
    } else if (state === 'reconnecting') {
      tone = 'warn';
      text = 'Reconnecting…' + (detail && DETAIL_TEXT[detail] ? ' (' + DETAIL_TEXT[detail] + ')' : '');
    } else if (state === 'rejected') {
      tone = 'bad';
    }
    if (this.available === 'fatal') tone = 'bad';

    const iAmHost = this.members.some((m) => m.you && m.host);
    this.lockBadge.hidden = !(inRoom && this.room.locked);
    this.lockButton.hidden = !(inRoom && iAmHost);
    this.lockButton.textContent = this.room.locked ? 'Unlock room' : 'Lock room';
    this.lockButton.title = this.room.locked ? 'Let new players join again' : 'Stop new players from joining';

    this.statusDot.dataset.tone = tone;
    this.statusText.textContent = text;
    this.pillDot.dataset.tone = tone;
    this.roomCode.textContent = code || '';
    this.pillExtra.textContent = inRoom && code ? code + ' · ' + Math.max(1, this.members.length) : '';
    this.pill.title = inRoom ? 'Co-op room ' + code + ' (' + text + ')' : 'Little Alchemy Co-op';
  }

  rejectText(reason, detail) {
    return (REJECT_TEXT[reason] || 'The host refused the connection.') + (detail ? ' ' + detail : '');
  }
}
