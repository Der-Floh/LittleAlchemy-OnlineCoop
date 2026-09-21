// Co-op settings, kept in the page's localStorage next to the game's own save
// (the content script runs in the page's world, where extension storage APIs
// are not available).

import { sanitizeName, normalizeRoomCode } from './net/protocol.js';

const KEY = 'laCoopSettings';

function randomId() {
  if (globalThis.crypto && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return 'p-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function defaultName() {
  return 'Alchemist ' + String(Math.floor(100 + Math.random() * 900));
}

export function sanitizePeerServer(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const host = typeof raw.host === 'string' ? raw.host.trim() : '';
  if (!/^[a-z0-9.-]+$/i.test(host)) return null;
  const port = Number(raw.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  let path = typeof raw.path === 'string' && raw.path.trim() ? raw.path.trim() : '/';
  if (!path.startsWith('/')) path = '/' + path;
  const key = typeof raw.key === 'string' && raw.key.trim() ? raw.key.trim().slice(0, 64) : 'peerjs';
  return { host, port, path, secure: raw.secure !== false, key };
}

// When we were last in each room (for the while-you-were-away summary).
function sanitizeLastSeen(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  const entries = Object.entries(raw)
    .filter(([code, ts]) => normalizeRoomCode(code) === code && Number.isFinite(ts))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20);
  for (const [code, ts] of entries) out[code] = ts;
  return out;
}

export function loadSettings(storage = globalThis.localStorage) {
  let data = {};
  try {
    data = JSON.parse(storage.getItem(KEY) || '{}') || {};
  } catch {
    data = {};
  }
  const room = data.room && normalizeRoomCode(data.room.code) ? { code: normalizeRoomCode(data.room.code), active: data.room.active === true } : null;
  const settings = {
    playerId: typeof data.playerId === 'string' && data.playerId.length <= 64 && data.playerId ? data.playerId : randomId(),
    name: sanitizeName(data.name) || defaultName(),
    room,
    toasts: data.toasts !== false,
    cursors: data.cursors !== false,
    lastSeen: sanitizeLastSeen(data.lastSeen),
    peerServer: sanitizePeerServer(data.peerServer),
  };
  saveSettings(settings, storage);
  return settings;
}

export function saveSettings(settings, storage = globalThis.localStorage) {
  try {
    storage.setItem(KEY, JSON.stringify(settings));
  } catch (err) {
    console.warn('[la-coop] could not save settings', err);
  }
}

// PeerJS options for the configured broker (defaults to the public PeerJS cloud).
// PeerJS logging stays off unless debugging: "could not connect to peer" is an
// expected step of join-or-host, not an error worth a console message.
export function peerOptions(settings, { debug = false } = {}) {
  const options = { debug: debug ? 2 : 0 };
  if (settings.peerServer) Object.assign(options, settings.peerServer);
  return options;
}
