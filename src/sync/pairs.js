// Pure helpers for recipe pairs. A "pair" is a Little Alchemy combination
// [a, b] of two element ids, always normalized so that a <= b (the game itself
// stores and compares pairs order-independently via Math.min / Math.max).
// A "tuple" is what travels over the network: [a, b, ts] where ts is the
// discovery time in ms. A 4th slot is reserved for a future "discovered by" id.

// Generous upper bound; the current game build (580) uses ids up to 617.
export const MAX_ELEMENT_ID = 4096;

export function isElementId(n) {
  return Number.isInteger(n) && n >= 1 && n <= MAX_ELEMENT_ID;
}

export function normalizePair(a, b) {
  const x = typeof a === 'string' ? Number(a) : a;
  const y = typeof b === 'string' ? Number(b) : b;
  if (!isElementId(x) || !isElementId(y)) return null;
  return x <= y ? [x, y] : [y, x];
}

export function pairKey(a, b) {
  return a + '+' + b;
}

export function tupleKey(tuple) {
  return pairKey(tuple[0], tuple[1]);
}

// Accepts an untrusted tuple and returns a clean [a, b, ts] or null.
export function parseTuple(raw, now = Date.now()) {
  if (!Array.isArray(raw) || raw.length < 2) return null;
  const pair = normalizePair(raw[0], raw[1]);
  if (!pair) return null;
  const ts = raw[2];
  const time = typeof ts === 'number' && Number.isFinite(ts) && ts > 0 ? Math.floor(ts) : now;
  return [pair[0], pair[1], time];
}

// Cleans a list of untrusted tuples: drops invalid entries and duplicates,
// keeps the first occurrence (and therefore the original order).
export function parseTuples(rawList, maxCount = Infinity, now = Date.now()) {
  const out = [];
  if (!Array.isArray(rawList)) return out;
  const seen = new Set();
  for (const raw of rawList) {
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

// Builds tuples from the game's own save format {parents: [[a,b]...], date: [...]}.
export function tuplesFromHistory(history) {
  const out = [];
  if (!history || !Array.isArray(history.parents)) return out;
  const seen = new Set();
  const dates = Array.isArray(history.date) ? history.date : [];
  for (let i = 0; i < history.parents.length; i++) {
    const p = history.parents[i];
    if (!Array.isArray(p)) continue;
    const tuple = parseTuple([p[0], p[1], dates[i]]);
    if (!tuple) continue;
    const key = tupleKey(tuple);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tuple);
  }
  return out;
}

// Returns the tuples of `incoming` whose pair is not in `knownKeys`.
export function missingTuples(knownKeys, incoming) {
  const out = [];
  const seen = new Set();
  for (const tuple of incoming) {
    const key = tupleKey(tuple);
    if (knownKeys.has(key) || seen.has(key)) continue;
    seen.add(key);
    out.push(tuple);
  }
  return out;
}
