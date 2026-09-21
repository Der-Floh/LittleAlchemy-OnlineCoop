// Pure helpers for recipe pairs. A "pair" is a Little Alchemy combination
// [a, b] of two element ids, always normalized so that a <= b (the game itself
// stores and compares pairs order-independently via Math.min / Math.max).
// A "tuple" is what travels over the network: [a, b, ts] where ts is the
// discovery time in ms. A 4th slot is reserved for a future "discovered by" id.

export type Pair = [a: number, b: number];
export type Tuple = [a: number, b: number, ts: number];

// Generous upper bound; the current game build (580) uses ids up to 617.
export const MAX_ELEMENT_ID = 4096;

export function isElementId(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= MAX_ELEMENT_ID;
}

export function normalizePair(a: unknown, b: unknown): Pair | null {
  const x = typeof a === 'string' ? Number(a) : a;
  const y = typeof b === 'string' ? Number(b) : b;
  if (!isElementId(x) || !isElementId(y)) return null;
  return x <= y ? [x, y] : [y, x];
}

export function pairKey(a: number, b: number): string {
  return a + '+' + b;
}

export function tupleKey(tuple: readonly [number, number, ...unknown[]]): string {
  return pairKey(tuple[0], tuple[1]);
}

// Accepts an untrusted tuple and returns a clean [a, b, ts] or null.
export function parseTuple(raw: unknown, now = Date.now()): Tuple | null {
  if (!Array.isArray(raw) || raw.length < 2) return null;
  const list: readonly unknown[] = raw;
  const pair = normalizePair(list[0], list[1]);
  if (!pair) return null;
  const ts = list[2];
  const time = typeof ts === 'number' && Number.isFinite(ts) && ts > 0 ? Math.floor(ts) : now;
  return [pair[0], pair[1], time];
}

// Cleans a list of untrusted tuples: drops invalid entries and duplicates,
// keeps the first occurrence (and therefore the original order).
export function parseTuples(rawList: unknown, maxCount = Infinity, now = Date.now()): Tuple[] {
  const out: Tuple[] = [];
  if (!Array.isArray(rawList)) return out;
  const seen = new Set<string>();
  for (const raw of rawList as readonly unknown[]) {
    if (out.length >= maxCount) break;
    const tuple = parseTuple(raw, now);
    if (!tuple) continue;
    const key = tupleKey(tuple);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tuple);
  }
  return out;
}

// The game's own save format, {parents: [[a,b]...], date: [...]}, possibly damaged.
export type HistoryLike = { parents?: unknown; date?: unknown } | null | undefined;

// Builds tuples from the game's save format.
export function tuplesFromHistory(history: HistoryLike): Tuple[] {
  const out: Tuple[] = [];
  if (!history || !Array.isArray(history.parents)) return out;
  const parents = history.parents as readonly unknown[];
  const dates: readonly unknown[] = Array.isArray(history.date) ? history.date : [];
  const seen = new Set<string>();
  for (let i = 0; i < parents.length; i++) {
    const p = parents[i];
    if (!Array.isArray(p)) continue;
    const pair: readonly unknown[] = p;
    const tuple = parseTuple([pair[0], pair[1], dates[i]]);
    if (!tuple) continue;
    const key = tupleKey(tuple);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tuple);
  }
  return out;
}

// Returns the tuples of `incoming` whose pair is not in `knownKeys`.
export function missingTuples(knownKeys: ReadonlySet<string>, incoming: readonly Tuple[]): Tuple[] {
  const out: Tuple[] = [];
  const seen = new Set<string>();
  for (const tuple of incoming) {
    const key = tupleKey(tuple);
    if (knownKeys.has(key) || seen.has(key)) continue;
    seen.add(key);
    out.push(tuple);
  }
  return out;
}
