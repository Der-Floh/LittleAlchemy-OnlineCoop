// GameAdapter: the only module that touches Little Alchemy's internals.
//
// The game keeps its save as a list of recipe pairs in game.history and
// rebuilds everything else from it (see alchemy.580.js). We mirror that list
// as the replicated co-op state, hook the game's own "updateHistory" event to
// see local discoveries, and apply remote discoveries through the game's own
// "childCreated" event (small batches) or its own rebuild functions (big
// syncs), so the game updates its library, counter, save and achievements
// exactly as if the player had combined the elements themselves.

import { Emitter } from '../emitter.js';
import { normalizePair, pairKey, tupleKey, tuplesFromHistory } from '../sync/pairs.js';

// Above this many pairs, rebuild once instead of replaying pair by pair.
const TRIGGER_BATCH_LIMIT = 30;
const BACKUP_KEY = 'laCoopBackup';
const NS = '.laCoop';

const REQUIRED_FEATURES = [
  ['jQuery', (w) => typeof w.jQuery === 'function'],
  [
    'game',
    (w) =>
      !!w.game &&
      ['initProgress', 'checkIfNotAlreadyDone', 'getFinalElements', 'changeProgressCounter'].every(
        (fn) => typeof w.game[fn] === 'function',
      ),
  ],
  ['workspace', (w) => !!w.workspace && typeof w.workspace.sex === 'function'],
  ['library', (w) => !!w.library && typeof w.library.reload === 'function'],
  ['storage', (w) => !!w.storage && typeof w.storage.updateHistory === 'function'],
  ['bases', (w) => !!w.bases && typeof w.bases === 'object'],
];

export class GameAdapter extends Emitter {
  constructor(win = window) {
    super();
    this.win = win;
    this._tuples = [];
    this._keys = new Set();
    this._applying = false;
    this._pending = [];
    this._flushTimer = null;
    this._pointerDown = false;
    this._started = false;
  }

  // ---- readiness -------------------------------------------------------------

  missingFeatures() {
    return REQUIRED_FEATURES.filter(([, ok]) => !safe(() => ok(this.win))).map(([name]) => name);
  }

  isReady() {
    const w = this.win;
    return safe(() => {
      if (this.missingFeatures().length > 0) return false;
      if (w.bases.loaded !== true || !w.bases.base) return false;
      if (!w.game.history || !Array.isArray(w.game.history.parents) || !Array.isArray(w.game.progress)) return false;
      if (!w.library.el) return false;
      const list = w.loadingScreen && w.loadingScreen.list;
      return Array.isArray(list) ? list.includes('libraryShowed') : w.library.el.children.length > 0;
    });
  }

  whenReady({ timeoutMs = 90_000, intervalMs = 100 } = {}) {
    return new Promise((resolve, reject) => {
      const started = Date.now();
      const poll = () => {
        if (this.isReady()) return resolve();
        if (Date.now() - started > timeoutMs) {
          const missing = this.missingFeatures();
          return reject(
            new Error(
              missing.length
                ? 'this version of Little Alchemy is not supported (missing: ' + missing.join(', ') + ')'
                : 'Little Alchemy did not finish loading',
            ),
          );
        }
        this.win.setTimeout(poll, intervalMs);
      };
      poll();
    });
  }

  getBuild() {
    for (const script of this.win.document.scripts) {
      const match = /\/js\/alchemy\.(\d+)\.js/.exec(script.src || '');
      if (match) return match[1];
    }
    return null;
  }

  // ---- lifecycle -------------------------------------------------------------

  start() {
    if (this._started) return;
    this._started = true;
    const w = this.win;
    const $doc = w.jQuery(w.document);
    this._resync();
    // updateHistory fires (with [pair, date]) only when the game records a new pair.
    $doc.on('updateHistory' + NS, (_event, pair, date) => this._onUpdateHistory(pair, date));
    $doc.on('resetProgress' + NS, () => {
      this._resync();
      this.emit('reset', { reason: 'game-reset' });
    });

    // Big rebuilds reload the library; never do that in the middle of a drag.
    const down = () => {
      this._pointerDown = true;
    };
    const up = () => {
      this._pointerDown = false;
      if (this._pending.length > 0) this._scheduleFlush(50);
    };
    for (const type of ['mousedown', 'pointerdown', 'touchstart']) w.document.addEventListener(type, down, true);
    for (const type of ['mouseup', 'pointerup', 'pointercancel', 'touchend', 'touchcancel']) {
      w.document.addEventListener(type, up, true);
    }
    w.addEventListener('blur', up);
  }

  _resync() {
    this._tuples = tuplesFromHistory(this.win.game.history);
    this._keys = new Set(this._tuples.map(tupleKey));
  }

  _onUpdateHistory(pair, date) {
    if (this._applying || !Array.isArray(pair)) return;
    const normalized = normalizePair(pair[0], pair[1]);
    if (!normalized) return;
    const key = pairKey(normalized[0], normalized[1]);
    if (this._keys.has(key)) return;
    const tuple = [normalized[0], normalized[1], typeof date === 'number' ? date : Date.now()];
    this._keys.add(key);
    this._tuples.push(tuple);
    // This runs inside the game's childCreated handler, before the children
    // are added to game.progress, so "not known yet" means "new element".
    const children = this.childrenOf(normalized);
    const newElements = children.filter((id) => !this.hasElement(id));
    this.emit('local', { tuple, children, newElements });
  }

  // ---- replicated state --------------------------------------------------------

  getTuples() {
    return this._tuples.slice();
  }

  get recipeCount() {
    return this._tuples.length;
  }

  // Accepts validated tuples from peers; returns the ones that were new and
  // real recipes. The game itself is updated asynchronously (see _flush).
  applyTuples(tuples, meta = {}) {
    const added = [];
    for (const tuple of tuples) {
      const key = tupleKey(tuple);
      if (this._keys.has(key)) continue;
      if (this.childrenOf(tuple).length === 0) continue; // not a real recipe
      this._keys.add(key);
      this._tuples.push(tuple);
      added.push(tuple);
    }
    if (added.length > 0) {
      this._pending.push({ tuples: added, meta });
      this._scheduleFlush(0);
    }
    return added;
  }

  _scheduleFlush(delayMs) {
    if (this._flushTimer !== null) return;
    this._flushTimer = this.win.setTimeout(() => {
      this._flushTimer = null;
      this._flush();
    }, delayMs);
  }

  _flush() {
    if (this._pending.length === 0) return;
    const total = this._pending.reduce((sum, batch) => sum + batch.tuples.length, 0);
    const bulk = total > TRIGGER_BATCH_LIMIT;
    if (bulk && this._pointerDown) return; // retried on pointer up
    const batches = this._pending;
    this._pending = [];
    try {
      if (bulk) this._applyBulk(batches);
      else for (const batch of batches) this._applyByTrigger(batch);
    } catch (err) {
      console.error('[la-coop] applying remote discoveries failed', err);
    }
  }

  _applyByTrigger(batch) {
    const w = this.win;
    const game = w.game;
    const $doc = w.jQuery(w.document);
    const recipes = [];
    const newElements = [];
    this._applying = true;
    try {
      for (const tuple of batch.tuples) {
        const pair = [tuple[0], tuple[1]];
        const children = this.childrenOf(pair);
        if (!game.checkIfNotAlreadyDone(pair)) {
          recipes.push({ tuple, children });
          continue;
        }
        const fresh = children.filter((id) => !this.hasElement(id));
        $doc.trigger('childCreated', [children, pair]);
        for (const id of fresh) if (!newElements.includes(id)) newElements.push(id);
        recipes.push({ tuple, children });
      }
    } finally {
      this._applying = false;
    }
    this.emit('applied', { meta: batch.meta, recipes, newElements, bulk: false });
  }

  _applyBulk(batches) {
    const w = this.win;
    const game = w.game;
    const before = new Set(this._allElements());
    const done = new Set(game.history.parents.map((p) => pairKey(Math.min(p[0], p[1]), Math.max(p[0], p[1]))));
    const usedDates = new Set(game.history.date);
    this._applying = true;
    try {
      for (const batch of batches) {
        for (const tuple of batch.tuples) {
          const key = tupleKey(tuple);
          if (done.has(key)) continue;
          done.add(key);
          let date = tuple[2];
          while (usedDates.has(date)) date++;
          usedDates.add(date);
          game.history.parents.push([tuple[0], tuple[1]]);
          game.history.date.push(date);
        }
      }
      this._rebuildGame({ clearWorkspace: false });
    } finally {
      this._applying = false;
    }
    const gained = this._allElements().filter((id) => !before.has(id));
    const claimed = new Set();
    for (const batch of batches) {
      const recipes = batch.tuples.map((tuple) => ({ tuple, children: this.childrenOf(tuple) }));
      const newElements = [];
      for (const recipe of recipes) {
        for (const id of recipe.children) {
          if (gained.includes(id) && !claimed.has(id)) {
            claimed.add(id);
            newElements.push(id);
          }
        }
      }
      this.emit('applied', { meta: batch.meta, recipes, newElements, bulk: true });
    }
  }

  // Same steps the game's own cloud-save merge uses, minus clearing the workspace.
  _rebuildGame({ clearWorkspace }) {
    const w = this.win;
    const game = w.game;
    w.storage.updateHistory();
    game.initProgress();
    game.finalElements = [];
    game.getFinalElements();
    if (clearWorkspace && w.workspace.$el && typeof w.workspace.clearSpecified === 'function') {
      w.workspace.clearSpecified(w.workspace.$el.find('.element'));
    }
    w.library.reload();
    const achievements = w.achievements;
    if (achievements && achievements.data && typeof achievements.initialCheck === 'function') {
      achievements.initialCheck();
    }
  }

  // ---- element info --------------------------------------------------------------

  childrenOf(pair) {
    return safe(() => this.win.workspace.sex([pair[0], pair[1]])) || [];
  }

  hasElement(id) {
    const game = this.win.game;
    return (
      game.progress.includes(id) ||
      game.prime.includes(id) ||
      (Array.isArray(game.hiddenElements) && game.hiddenElements.includes(id))
    );
  }

  _allElements() {
    const game = this.win.game;
    return [...game.prime, ...game.progress, ...(game.hiddenElements || [])];
  }

  elementCount() {
    const game = this.win.game;
    return { have: game.progress.length + game.prime.length, total: game.maxProgress || 0 };
  }

  elementInfo(id) {
    const bases = this.win.bases;
    const name = (bases.names && bases.names[id]) || '#' + id;
    const image = bases.images && bases.images[id] ? 'data:image/png;base64,' + bases.images[id] : null;
    return { id, name, image };
  }

  // ---- one-time backup of the save before co-op merges into it -------------------

  backupInfo() {
    const raw = safe(() => this.win.localStorage.getItem(BACKUP_KEY));
    if (!raw) return null;
    const data = safe(() => JSON.parse(raw));
    return data && typeof data === 'object' ? { savedAt: data.savedAt, count: data.count } : null;
  }

  ensureBackup() {
    const ls = this.win.localStorage;
    if (ls.getItem(BACKUP_KEY)) return false;
    const { have } = this.elementCount();
    ls.setItem(
      BACKUP_KEY,
      JSON.stringify({
        savedAt: Date.now(),
        count: have,
        progress: ls.getItem('progress'),
        achievements: ls.getItem('achievements'),
      }),
    );
    return true;
  }

  restoreBackup() {
    const w = this.win;
    const raw = w.localStorage.getItem(BACKUP_KEY);
    if (!raw) throw new Error('No backup found');
    const data = JSON.parse(raw);
    const history = data.progress ? JSON.parse(data.progress) : { parents: [], date: [] };
    if (!history || !Array.isArray(history.parents) || !Array.isArray(history.date)) {
      throw new Error('The backup is damaged');
    }
    this._pending = []; // drop remote discoveries that were still queued
    w.game.history = history;
    this._applying = true;
    try {
      this._rebuildGame({ clearWorkspace: true });
    } finally {
      this._applying = false;
    }
    if (data.achievements && w.achievements) {
      const earned = safe(() => JSON.parse(data.achievements));
      if (Array.isArray(earned)) {
        w.achievements.earnedList = earned;
        if (typeof w.storage.updateAchievements === 'function') w.storage.updateAchievements();
      }
    }
    this._resync();
    this.emit('reset', { reason: 'backup-restored' });
  }

  discardBackup() {
    this.win.localStorage.removeItem(BACKUP_KEY);
  }
}

function safe(fn) {
  try {
    return fn();
  } catch {
    return undefined;
  }
}
