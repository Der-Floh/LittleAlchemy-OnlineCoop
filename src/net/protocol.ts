// Wire protocol between co-op peers (JSON strings over WebRTC data channels).
// Everything received from a peer is untrusted: decode() validates and
// normalizes every message (with the valibot schemas below) before the
// session looks at it. The schemas also define the message types.

import * as v from 'valibot';
import { customAlphabet } from 'nanoid';
import { uniq } from 'es-toolkit';
import { parseTuples, type Tuple } from '../sync/pairs.ts';

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

export const REJECT_REASONS = ['version', 'build', 'full', 'replaced', 'kicked', 'locked'] as const;
export type RejectReason = (typeof REJECT_REASONS)[number];

const randomRoomCode = customAlphabet(ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH);

export function makeRoomCode(): string {
  return randomRoomCode();
}

// Accepts user input like " k7m-4px " and returns "K7M4PX", or null if invalid.
export function normalizeRoomCode(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const code = input.toUpperCase().replace(/[\s-]/g, '');
  if (code.length !== ROOM_CODE_LENGTH) return null;
  for (const ch of code) if (!ROOM_CODE_ALPHABET.includes(ch)) return null;
  return code;
}

export function hostPeerId(code: string): string {
  return HOST_ID_PREFIX + code;
}

// Player names are shown to other players, so strip control characters and
// cap the length. Returns null when nothing usable is left.
export function sanitizeName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const cleaned = raw
    .replace(/\s+/g, ' ')
    .replace(/[\p{C}]/gu, '')
    .replace(/ {2,}/g, ' ')
    .trim();
  if (!cleaned) return null;
  return Array.from(cleaned).slice(0, MAX_NAME_LENGTH).join('');
}

// ---- schemas ----------------------------------------------------------------------
// Fields wrapped in v.fallback() are forgiving (a missing or bad value gets a
// default); the others make the whole message invalid.

const shortString = (max: number) => v.pipe(v.string(), v.minLength(1), v.maxLength(max));
const PlayerId = shortString(64);
const Name = v.pipe(v.unknown(), v.transform(sanitizeName), v.string());
const Flag = v.fallback(v.boolean(), false);
const ColorIndex = v.fallback(v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(PLAYER_COLOR_COUNT - 1)), 0);
const Pairs = v.fallback(
  v.pipe(
    v.unknown(),
    v.transform((raw) => parseTuples(raw, MAX_PAIRS_PER_MESSAGE)),
  ),
  () => [],
);

// A list where bad entries are skipped instead of failing the message. Only
// the first `max` entries are looked at.
function lenientList<TSchema extends v.GenericSchema>(schema: TSchema, max: number) {
  return v.fallback(
    v.pipe(
      v.unknown(),
      v.transform((raw) => {
        const out: v.InferOutput<TSchema>[] = [];
        if (!Array.isArray(raw)) return out;
        for (const item of (raw as readonly unknown[]).slice(0, max)) {
          const result = v.safeParse(schema, item);
          if (result.success) out.push(result.output);
        }
        return out;
      }),
    ),
    () => [],
  );
}

const PlayerSchema = v.object({ id: PlayerId, name: v.fallback(Name, 'Player') });
export type Player = v.InferOutput<typeof PlayerSchema>;

const MemberSchema = v.object({ ...PlayerSchema.entries, color: ColorIndex, host: Flag });
export type Member = v.InferOutput<typeof MemberSchema>;
const Members = lenientList(MemberSchema, MAX_MEMBERS);

const IdList = v.pipe(lenientList(PlayerId, MAX_ROOM_IDS), v.transform(uniq));

// Room-wide settings the host enforces; every member keeps a copy so that a
// new host (after a migration or handover) keeps enforcing them.
const RoomFlagsSchema = v.fallback(v.object({ locked: Flag, banned: IdList, allowed: IdList }), () => ({
  locked: false,
  banned: [],
  allowed: [],
}));
export type RoomFlags = v.InferOutput<typeof RoomFlagsSchema>;

export function emptyRoomFlags(): RoomFlags {
  return { locked: false, banned: [], allowed: [] };
}

const Version = v.pipe(v.number(), v.integer());

const MessageSchema = v.variant('t', [
  v.object({
    t: v.literal('hello'),
    v: Version,
    build: v.fallback(v.nullable(shortString(16)), null),
    player: PlayerSchema,
    pairs: Pairs,
  }),
  v.object({
    t: v.literal('welcome'),
    v: Version,
    you: v.fallback(v.object({ color: ColorIndex }), () => ({ color: 0 })),
    members: Members,
    room: RoomFlagsSchema,
    pairs: Pairs,
  }),
  v.object({
    t: v.literal('reject'),
    reason: v.fallback(v.picklist([...REJECT_REASONS, 'unknown']), 'unknown'),
    detail: v.fallback(
      v.pipe(
        v.string(),
        v.transform((s) => s.slice(0, 200)),
      ),
      '',
    ),
  }),
  v.object({ t: v.literal('add'), by: PlayerSchema, pairs: Pairs, sync: Flag }),
  v.object({ t: v.literal('presence'), members: Members, room: RoomFlagsSchema }),
  // Feature messages (workspace, cursors). The payload is validated by the
  // feature that handles it; here only the envelope is checked.
  v.object({
    t: v.literal('app'),
    k: v.pipe(v.string(), v.regex(/^[a-z]{1,12}$/)),
    d: v.custom<object>((d) => typeof d === 'object' && d !== null),
    by: v.fallback(v.nullable(PlayerId), null),
  }),
  v.object({ t: v.literal('handover'), to: PlayerId }),
  v.object({ t: v.literal('rename'), name: Name }),
  v.object({ t: v.literal('leave') }),
  v.object({ t: v.literal('ping') }),
  v.object({ t: v.literal('rehome') }),
]);

type KnownMessage = v.InferOutput<typeof MessageSchema>;
// Unknown types are passed on as such (and ignored), so newer peers can add features.
export type Message = KnownMessage | { t: 'unknown'; type: string };
export type MessageOf<T extends Message['t']> = Extract<Message, { t: T }>;

const KNOWN_TYPES: ReadonlySet<string> = new Set(MessageSchema.options.map((option) => option.entries.t.literal));

// What we send. The same shapes, a few fields optional.
export type Outgoing =
  | MessageOf<'hello' | 'welcome' | 'presence' | 'handover' | 'rename' | 'leave' | 'ping' | 'rehome'>
  | { t: 'reject'; reason: RejectReason; detail: string }
  | { t: 'add'; by: Player; pairs: Tuple[]; sync?: boolean }
  | { t: 'app'; k: string; d: object; by?: string };

export function encode(msg: Outgoing): string {
  return JSON.stringify(msg);
}

export type Decoded = { msg: Message; error?: undefined } | { msg?: undefined; error: string };

// Returns {msg} with a normalized message, or {error} describing why it was dropped.
export function decode(raw: unknown): Decoded {
  if (typeof raw !== 'string') return { error: 'not-a-string' };
  if (raw.length > MAX_MESSAGE_CHARS) return { error: 'too-large' };
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return { error: 'bad-json' };
  }
  if (!data || typeof data !== 'object' || !('t' in data) || typeof data.t !== 'string') return { error: 'no-type' };
  if (!KNOWN_TYPES.has(data.t)) return { msg: { t: 'unknown', type: data.t.slice(0, 32) } };
  const result = v.safeParse(MessageSchema, data);
  return result.success ? { msg: result.output } : { error: 'bad-' + data.t };
}
