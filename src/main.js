// Entry point, injected into littlealchemy.com's page world by the extension.
// Wires the game adapter, the peer-to-peer room session, the UI and settings.

import { Peer } from 'peerjs';
import { GameAdapter } from './game/adapter.js';
import { RoomSession } from './net/session.js';
import { makeRoomCode, normalizeRoomCode, sanitizeName } from './net/protocol.js';
import { loadSettings, saveSettings, peerOptions, sanitizePeerServer } from './store.js';
import { CoopPanel } from './ui/panel.js';
import { TabGuard } from './tabguard.js';

/* global __LA_COOP_VERSION__ */
const VERSION = typeof __LA_COOP_VERSION__ === 'string' ? __LA_COOP_VERSION__ : 'dev';

function readInviteCode() {
  const match = /[#&]coop=([A-Za-z0-9-]{4,12})/.exec(window.location.hash);
  if (!match) return null;
  window.history.replaceState(null, '', window.location.pathname + window.location.search);
  return normalizeRoomCode(match[1]);
}

// Connection logging: run localStorage.laCoopDebug = '1' in the console, then reload.
function debugEnabled() {
  try {
    return window.localStorage.getItem('laCoopDebug') === '1';
  } catch {
    return false;
  }
}

function plural(n, word) {
  return n + ' ' + word + (n === 1 ? '' : 's');
}

async function main() {
  if (window.__laCoopStarted) return; // injected twice
  window.__laCoopStarted = true;
  const settings = loadSettings();
  const invite = readInviteCode();
  const adapter = new GameAdapter(window);
  let session = null;
  let lastState = 'idle';
  let hadRoom = false;

  const guard = new TabGuard({ onYield: () => yieldToOtherTab() });

  const panel = new CoopPanel({
    version: VERSION,
    handlers: {
      onCreate: () => joinRoom(makeRoomCode()),
      onJoin: (input) => {
        const code = normalizeRoomCode(input);
        if (!code) {
          panel.showBanner('Room codes are 6 characters: letters A–Z (no I, L or O) and digits 2–9.', { tone: 'bad' });
          return;
        }
        joinRoom(code);
      },
      onLeave: () => leaveRoom(),
      onRename: (raw) => {
        const name = sanitizeName(raw);
        if (name) {
          settings.name = name;
          saveSettings(settings);
          if (session) session.rename(name);
        }
        panel.setSettings(settings);
      },
      onToasts: (on) => {
        settings.toasts = on;
        saveSettings(settings);
      },
      onRestoreBackup: () => {
        try {
          adapter.restoreBackup();
          panel.showBanner('Backup restored.');
        } catch (err) {
          panel.showBanner('Could not restore the backup: ' + err.message, { tone: 'bad' });
        }
      },
      onDiscardBackup: () => {
        adapter.discardBackup();
        panel.setBackup(null);
      },
      onPeerServer: (raw) => {
        if (raw === null) settings.peerServer = null;
        else {
          const server = sanitizePeerServer(raw);
          if (!server) {
            panel.showBanner('Please enter a valid host name and port.', { tone: 'bad' });
            return;
          }
          settings.peerServer = server;
        }
        saveSettings(settings);
        panel.setSettings(settings);
        panel.hideBanner();
        if (session && session.code) session.join(session.code); // reconnect through the new server
      },
    },
  });
  panel.setSettings(settings);
  if (invite) {
    panel.prefillCode(invite);
    panel.open();
  }

  try {
    await adapter.whenReady();
  } catch (err) {
    panel.setAvailability('fatal');
    panel.showBanner('Co-op is unavailable: ' + err.message + '.', { tone: 'bad' });
    return;
  }
  adapter.start();
  panel.setBackup(adapter.backupInfo());

  session = new RoomSession({
    createPeer: (id) => new Peer(id, peerOptions(settings, { debug: debugEnabled() })),
    game: adapter,
    player: { id: settings.playerId, name: settings.name },
    build: adapter.getBuild(),
    log: (...args) => {
      if (debugEnabled()) console.debug('[la-coop]', ...args);
    },
  });

  window.__laCoop = { version: VERSION, session, adapter, settings, panel };

  // ---- session -> UI ---------------------------------------------------------

  session.on('status', (status) => {
    panel.setStatus(status);
    const { state } = status;
    if (state === 'hosting' && lastState !== 'hosting') {
      if (lastState === 'connecting') panel.addFeed(['You opened room ' + status.code + '.'], { muted: true });
      else panel.addFeed(['You are now the host.'], { muted: true });
    } else if (state === 'connected' && lastState !== 'connected') {
      panel.addFeed(['Connected to room ' + status.code + '.'], { muted: true });
    } else if (state === 'reconnecting' && lastState !== 'reconnecting') {
      panel.addFeed(['Connection lost, reconnecting…'], { muted: true });
    }
    lastState = state;
  });
  session.on('members', (members) => panel.setMembers(members));
  session.on('joined', (member) => panel.addFeed([{ who: member }, ' joined.'], { muted: true }));
  session.on('left', (member) => panel.addFeed([{ who: member }, ' left.'], { muted: true }));
  session.on('rejected', ({ reason, detail }) => {
    if (reason === 'replaced') {
      // Another window of ours took over; leave the shared settings alone.
      panel.showBanner('Disconnected: ' + panel.rejectText(reason, ''), { tone: 'bad' });
      return;
    }
    if (settings.room) settings.room.active = false;
    saveSettings(settings);
    panel.showBanner('Could not join: ' + panel.rejectText(reason, detail), { tone: 'bad' });
  });

  // ---- game -> session / UI ----------------------------------------------------

  const me = () => {
    const self = session.members.find((m) => m.you);
    return { name: 'You', color: self ? self.color : 0 };
  };
  const name = (id) => adapter.elementInfo(id).name;
  const recipeParts = (by, tuple, children, newElements) => {
    const parts = [{ who: by }, ': ' + name(tuple[0]) + ' + ' + name(tuple[1]) + ' → '];
    children.forEach((id, i) => {
      if (i > 0) parts.push(', ');
      parts.push({ el: name(id), isNew: newElements.includes(id) });
    });
    return parts;
  };

  adapter.on('local', ({ tuple, children, newElements }) => {
    session.broadcastLocal([tuple]);
    if (session.code) panel.addFeed(recipeParts(me(), tuple, children, newElements));
  });

  adapter.on('applied', ({ meta, recipes, newElements }) => {
    const by = meta.by || { name: 'Someone', color: 0 };
    if (meta.sync) {
      const summary = ': +' + plural(recipes.length, 'recipe') + (newElements.length ? ', +' + plural(newElements.length, 'new element') : '');
      if (by.host) panel.addFeed(['Synced with the room' + summary]);
      else panel.addFeed([{ who: by }, ' shared their progress' + summary]);
      if (settings.toasts && newElements.length > 0) {
        panel.toast({
          image: adapter.elementInfo(newElements[0]).image,
          parts: ['+' + plural(newElements.length, 'new element') + ' from ', by.host ? 'the room' : { who: by }],
        });
      }
      return;
    }
    for (const recipe of recipes) panel.addFeed(recipeParts(by, recipe.tuple, recipe.children, newElements));
    if (settings.toasts) {
      for (const id of newElements.slice(0, 3)) {
        const info = adapter.elementInfo(id);
        panel.toast({ image: info.image, parts: [{ who: by }, ' discovered ', { el: info.name, bold: true }] });
      }
    }
  });

  adapter.on('reset', ({ reason }) => {
    if (reason === 'game-reset' && session.code) {
      panel.addFeed(['Your progress was reset. It fills up again from the room the next time you reconnect.'], { muted: true });
    }
  });

  // ---- room actions --------------------------------------------------------------

  function joinRoom(code, { auto = false } = {}) {
    if (!guard.active) return;
    panel.hideBanner();
    if (adapter.ensureBackup()) panel.setBackup(adapter.backupInfo());
    settings.room = { code, active: true };
    saveSettings(settings);
    if (!auto || hadRoom) panel.clearFeed();
    hadRoom = true;
    lastState = 'connecting';
    session.join(code);
  }

  function leaveRoom() {
    session.leave();
    if (settings.room) settings.room.active = false;
    saveSettings(settings);
    panel.clearFeed();
    lastState = 'idle';
  }

  function yieldToOtherTab() {
    session.leave({ immediate: true });
    lastState = 'idle';
    setPassive('Co-op moved to another Little Alchemy tab.');
  }

  // An invite that arrived while this tab was passive, offered after a takeover.
  let pendingInvite = null;

  function setPassive(message) {
    panel.setAvailability('passive');
    panel.showBanner(message + ' Little Alchemy keeps one save per browser, so play in one tab at a time.', {
      actions: [{ label: 'Use co-op in this tab', primary: true, onClick: takeOver }],
    });
  }

  function takeOver() {
    guard.takeOver();
    Object.assign(settings, loadSettings());
    panel.setSettings(settings);
    panel.hideBanner();
    panel.setAvailability('ready');
    if (settings.room && settings.room.active) joinRoom(settings.room.code, { auto: true });
    if (pendingInvite) {
      const code = pendingInvite;
      pendingInvite = null;
      offerInvite(code);
    }
  }

  function offerInvite(code) {
    if (session.code === code) return;
    panel.prefillCode(code);
    panel.open();
    if (!guard.active) {
      pendingInvite = code;
      setPassive('You were invited to co-op room ' + code + ', but co-op is running in another Little Alchemy tab.');
      return;
    }
    panel.showBanner('You were invited to co-op room ' + code + '. Joining merges your progress with the room.', {
      actions: [{ label: 'Join ' + code, primary: true, onClick: () => joinRoom(code) }],
    });
  }

  // ---- startup -------------------------------------------------------------------

  // Say goodbye on unload so the room notices (and can hand over hosting) at once.
  window.addEventListener('pagehide', () => {
    if (session.code) session.leave({ immediate: true });
  });
  window.addEventListener('pageshow', (event) => {
    if (event.persisted && guard.active && settings.room && settings.room.active) joinRoom(settings.room.code, { auto: true });
  });
  // An invite link pasted into an already open game tab only changes the hash.
  window.addEventListener('hashchange', () => {
    const code = readInviteCode();
    if (code) offerInvite(code);
  });

  const active = await guard.start();
  if (!active) {
    if (invite) offerInvite(invite);
    else setPassive('Co-op is already running in another Little Alchemy tab.');
    return;
  }
  panel.setAvailability('ready');

  const rejoin = settings.room && settings.room.active ? settings.room.code : null;
  if (rejoin) joinRoom(rejoin, { auto: true });
  if (invite && invite !== rejoin) offerInvite(invite);
}

main().catch((err) => console.error('[la-coop] failed to start', err));
