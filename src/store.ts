// Co-op settings, kept in the page's localStorage next to the game's own save
// (the content script runs in the page's world, where extension storage APIs
// are not available). What comes back from storage may be old or damaged, so
// it's read through a schema: each bad field falls back to its default.

import * as v from 'valibot';
import { sanitizeName, normalizeRoomCode } from './net/protocol.ts';

const KEY = 'laCoopSettings';
const MAX_LAST_SEEN = 20;

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

function defaultName(): string {
  return 'Alchemist ' + String(Math.floor(100 + Math.random() * 900));
}

// A self-hosted PeerJS server, as typed into the settings or saved.
const PeerServerSchema = v.object({
  host: v.pipe(v.string(), v.trim(), v.regex(/^[a-z0-9.-]+$/i)),
  port: v.pipe(v.unknown(), v.transform(Number), v.integer(), v.minValue(1), v.maxValue(65535)),
  path: v.fallback(
    v.pipe(
      v.string(),
      v.trim(),
      v.minLength(1),
      v.transform((path) => (path.startsWith('/') ? path : '/' + path)),
    ),
    '/',
  ),
  secure: v.fallback(
    v.pipe(
      v.unknown(),
      v.transform((secure) => secure !== false),
    ),
    true,
  ),
  key: v.fallback(
    v.pipe(
      v.string(),
      v.trim(),
      v.minLength(1),
      v.transform((key) => key.slice(0, 64)),
    ),
    'peerjs',
  ),
});
export type PeerServer = v.InferOutput<typeof PeerServerSchema>;

export function sanitizePeerServer(raw: unknown): PeerServer | null {
  const result = v.safeParse(PeerServerSchema, raw);
  return result.success ? result.output : null;
}

// When we were last in each room (for the while-you-were-away summary):
// the most recent rooms, newest first.
function sanitizeLastSeen(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!raw || typeof raw !== 'object') return out;
  const entries = Object.entries(raw as Record<string, unknown>)
    .filter((entry): entry is [string, number] => normalizeRoomCode(entry[0]) === entry[0] && Number.isFinite(entry[1]))
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_LAST_SEEN);
  for (const [code, ts] of entries) out[code] = ts;
  return out;
}

const SettingsSchema = v.object({
  playerId: v.fallback(v.pipe(v.string(), v.minLength(1), v.maxLength(64)), () => crypto.randomUUID()),
  name: v.fallback(v.pipe(v.unknown(), v.transform(sanitizeName), v.string()), defaultName),
  room: v.fallback(
    v.nullable(
      v.object({
        code: v.pipe(v.unknown(), v.transform(normalizeRoomCode), v.string()),
        active: v.fallback(v.boolean(), false),
      }),
    ),
    null,
  ),
  // Only an explicit false turns these off.
  toasts: v.fallback(v.boolean(), true),
  cursors: v.fallback(v.boolean(), true),
  lastSeen: v.fallback(v.pipe(v.unknown(), v.transform(sanitizeLastSeen)), () => ({})),
  peerServer: v.fallback(v.nullable(PeerServerSchema), null),
});
export type Settings = v.InferOutput<typeof SettingsSchema>;

export function loadSettings(storage: StorageLike = globalThis.localStorage): Settings {
  let data: unknown;
  try {
    data = JSON.parse(storage.getItem(KEY) || '{}');
  } catch {
    data = null;
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) data = {};
  const settings = v.parse(SettingsSchema, data);
  saveSettings(settings, storage);
  return settings;
}

export function saveSettings(settings: Settings, storage: Pick<Storage, 'setItem'> = globalThis.localStorage): void {
  try {
    storage.setItem(KEY, JSON.stringify(settings));
  } catch (err) {
    console.warn('[la-coop] could not save settings', err);
  }
}

export type PeerOptions = { debug: 0 | 2 } & Partial<PeerServer>;

// PeerJS options for the configured broker (defaults to the public PeerJS cloud).
// PeerJS logging stays off unless debugging: "could not connect to peer" is an
// expected step of join-or-host, not an error worth a console message.
export function peerOptions(settings: Pick<Settings, 'peerServer'>, { debug = false } = {}): PeerOptions {
  return { debug: debug ? 2 : 0, ...settings.peerServer };
}
