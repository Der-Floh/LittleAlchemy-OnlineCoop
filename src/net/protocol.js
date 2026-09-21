// Wire protocol between co-op peers (JSON strings over WebRTC data channels).
// Everything received from a peer is untrusted: decode() validates and
// normalizes every message before the session looks at it.

import { parseTuples } from '../sync/pairs.js';

// v2: shared workspace, cursors and host controls (app messages, room flags, handover).
export const PROTOCOL_VERSION = 2;
export const MAX_MESSAGE_CHARS = 256 * 1024;
export const MAX_PAIRS_PER_MESSAGE = 2000;
export const MAX_NAME_LENGTH = 24;
export const MAX_MEMBERS = 8;
export const PLAYER_COLOR_COUNT = 8;
// Banned / allowed player ids carried in room flags.
const MAX_ROOM_IDS = 64;

// No I, L, O, 0 or 1, so codes are easy to read aloud and type.
export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const ROOM_CODE_LENGTH = 6;
// Namespaces our peer ids on the shared public PeerJS broker.
export const HOST_ID_PREFIX = 'lacoop1-';

export const REJECT_REASONS = ['version', 'build', 'full', 'replaced', 'kicked', 'locked'];

export const EMPTY_ROOM_FLAGS = Object.freeze({ locked: false, banned: [], allowed: [] });

export function makeRoomCode(random = Math.random) {
  let code = '';
  for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
    code += ROOM_CODE_ALPHABET[Math.floor(random() * ROOM_CODE_ALPHABET.length)];
  }
  return code;
}

// Accepts user input like " k7m-4px " and returns "K7M4PX", or null if invalid.
export function normalizeRoomCode(input) {
  if (typeof input !== 'string') return null;
  const code = input.toUpperCase().replace(/[\s-]/g, '');
  if (code.length !== ROOM_CODE_LENGTH) return null;
  for (const ch of code) if (!ROOM_CODE_ALPHABET.includes(ch)) return null;
  return code;
}

export function hostPeerId(code) {
  return HOST_ID_PREFIX + code;
}

// Player names are shown to other players, so strip control characters and
// cap the length. Returns null when nothing usable is left.
export function sanitizeName(raw) {
  if (typeof raw !== 'string') return null;
  const cleaned = raw
    .replace(/\s+/g, ' ')
    .replace(/[\p{C}]/gu, '')
    .replace(/ {2,}/g, ' ')
    .trim();
  if (!cleaned) return null;
  return Array.from(cleaned).slice(0, MAX_NAME_LENGTH).join('');
}

function shortString(value, max) {
  return typeof value === 'string' && value.length > 0 && value.length <= max ? value : null;
}

function colorIndex(value) {
  return Number.isInteger(value) && value >= 0 && value < PLAYER_COLOR_COUNT ? value : 0;
}

function parsePlayer(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = shortString(raw.id, 64);
  if (!id) return null;
  return { id, name: sanitizeName(raw.name) || 'Player' };
}

function parseIds(raw) {
  if (!Array.isArray(raw)) return [];
  const ids = [];
  for (const item of raw.slice(0, MAX_ROOM_IDS)) {
    const id = shortString(item, 64);
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

// Room-wide settings the host enforces; every member keeps a copy so that a
// new host (after a migration or handover) keeps enforcing them.
export function parseRoomFlags(raw) {
  if (!raw || typeof raw !== 'object') return { ...EMPTY_ROOM_FLAGS };
  return { locked: raw.locked === true, banned: parseIds(raw.banned), allowed: parseIds(raw.allowed) };
}

function parseMembers(raw) {
  if (!Array.isArray(raw)) return [];
  const members = [];
  for (const item of raw.slice(0, MAX_MEMBERS)) {
    const player = parsePlayer(item);
    if (!player) continue;
    members.push({ ...player, color: colorIndex(item.color), host: item.host === true });
  }
  return members;
}

export function encode(msg) {
  return JSON.stringify(msg);
}

// Returns {msg} with a normalized message, or {error} describing why it was dropped.
export function decode(raw) {
  if (typeof raw !== 'string') return { error: 'not-a-string' };
  if (raw.length > MAX_MESSAGE_CHARS) return { error: 'too-large' };
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return { error: 'bad-json' };
  }
  if (!data || typeof data !== 'object' || typeof data.t !== 'string') return { error: 'no-type' };

  switch (data.t) {
    case 'hello': {
      const player = parsePlayer(data.player);
      if (!player || !Number.isInteger(data.v)) return { error: 'bad-hello' };
      return {
        msg: {
          t: 'hello',
          v: data.v,
          build: shortString(data.build, 16),
          player,
          pairs: parseTuples(data.pairs, MAX_PAIRS_PER_MESSAGE),
        },
      };
    }
    case 'welcome':
      if (!Number.isInteger(data.v)) return { error: 'bad-welcome' };
      return {
        msg: {
          t: 'welcome',
          v: data.v,
          you: { color: colorIndex(data.you && data.you.color) },
          members: parseMembers(data.members),
          room: parseRoomFlags(data.room),
          pairs: parseTuples(data.pairs, MAX_PAIRS_PER_MESSAGE),
        },
      };
    case 'reject':
      return {
        msg: {
          t: 'reject',
          reason: REJECT_REASONS.includes(data.reason) ? data.reason : 'unknown',
          detail: typeof data.detail === 'string' ? data.detail.slice(0, 200) : '',
        },
      };
    case 'add': {
      const by = parsePlayer(data.by);
      if (!by) return { error: 'bad-add' };
      return {
        msg: { t: 'add', by, pairs: parseTuples(data.pairs, MAX_PAIRS_PER_MESSAGE), sync: data.sync === true },
      };
    }
    case 'presence':
      return { msg: { t: 'presence', members: parseMembers(data.members), room: parseRoomFlags(data.room) } };
    case 'app': {
      // Feature messages (workspace, cursors). The payload is validated by
      // the feature that handles it; here only the envelope is checked.
      if (typeof data.k !== 'string' || !/^[a-z]{1,12}$/.test(data.k)) return { error: 'bad-app' };
      if (!data.d || typeof data.d !== 'object') return { error: 'bad-app' };
      return { msg: { t: 'app', k: data.k, d: data.d, by: shortString(data.by, 64) } };
    }
    case 'handover': {
      const to = shortString(data.to, 64);
      return to ? { msg: { t: 'handover', to } } : { error: 'bad-handover' };
    }
    case 'rename': {
      const name = sanitizeName(data.name);
      return name ? { msg: { t: 'rename', name } } : { error: 'bad-rename' };
    }
    case 'leave':
    case 'ping':
    case 'rehome':
      return { msg: { t: data.t } };
    default:
      // Unknown types are ignored, so newer peers can add features.
      return { msg: { t: 'unknown', type: data.t.slice(0, 32) } };
  }
}
