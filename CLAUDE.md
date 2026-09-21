# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Little Alchemy Co-op is a Chrome/Firefox extension (Manifest V3) that lets friends play
[Little Alchemy classic](https://littlealchemy.com/) (game build 580) together. It provides:

- shared discoveries;
- a shared canvas with live cursors;
- a "while you were away" card;
- host controls: lock, kick and hand over.

Players connect peer-to-peer over WebRTC through PeerJS. There is no co-op server: they find each other through the public PeerJS broker (`0.peerjs.com`).

It is an unofficial fan project. It runs on top of the official game and bundles none of the game's code or assets.

README.md is the user-facing documentation: playing, installing, privacy, troubleshooting and releasing.

## Commands

Requires Node 22.18+, which runs the `.ts` tests and scripts directly by stripping types. `tsc` only type-checks and never emits.

```bash
npm install
npm run build              # src/main.ts -> extension/dist/coop.js; also copies package.json's version into extension/manifest.json
npm run watch              # rebuild on change, with inline source maps
npm run check              # type check (both tsconfigs) + ESLint + unit tests; run before committing (CI runs it too)
npm test                   # unit tests only
node --test test/unit/session.test.ts                                 # one unit test file
node --test --test-name-pattern="handover" "test/unit/*.test.ts"      # unit tests by name
npm run test:integration   # Playwright: one player, real Chrome, live littlealchemy.com, no networking
npm run test:e2e           # 2-3 Chrome profiles playing together through the public PeerJS broker (slow)
npx playwright test test/integration/adapter.spec.ts -g "backup"      # one browser test (run npm run build first; the npm scripts do)
npm run test:e2e:firefox   # Alice in Chrome, Bob in Firefox (Selenium + geckodriver); needs Firefox installed
npm run lint:ext           # Mozilla's add-on linter: 0 errors expected, 1 known warning (Preact's dangerouslySetInnerHTML path, unused)
npm run package            # dist-packages/little-alchemy-coop-<version>.zip
npm run run:firefox        # Firefox with the extension loaded temporarily
npm run icons              # render assets/icon.svg to extension/icons/*.png with the installed Chrome (Chromium takes no SVG icons)
node scripts/ui-preview.ts <dir>   # screenshots of the co-op UI
```

**How the browser tests load the extension.** Branded Chrome ignores `--load-extension`, so the tests:

- start the installed Chrome with throwaway profiles in `.e2e-profiles/`;
- load the unpacked extension through the DevTools protocol (`Extensions.loadUnpacked`);
- drive the extension through `window.__laCoop` (`src/debug.ts`).

Environment variables for the browser tests:

- `CHROME_PATH`: use another Chromium browser.
- `HEADED=1`: show the browser windows.
- `EXTENSION_DIR`: load another build.
- `EXTENSION_DIR_B`: run the second player on another build (co-op and canvas e2e tests). Point it at the previous release's `extension/` to prove the two versions still share a room.

**Debugging in the page:** run `localStorage.laCoopDebug = '1'` and reload to get connection logs. `window.__laCoop` holds:

- session, adapter, bridge, sync, cursors, panel and settings.

## Architecture

### How the script runs

There is one content script, bundled by esbuild (IIFE, unminified). It runs in the page's **MAIN world** so it can reach the game's globals. Consequences:

- **No extension APIs.** Settings live in the page's localStorage (`laCoopSettings`, `laCoopBackup`) next to the game's own save (`progress`).
- **The page's rules apply**, so bundled code must be browser-safe and must not use `eval`.
- **Minimal manifest.** It requests no permissions, and the toolbar popup is static HTML.

### How the modules connect

`src/main.ts` wires the modules together. They talk through typed events (`src/emitter.ts`), which isolate listener errors, so a UI bug can't break the session mid-transition.

**How data flows:**

- **A local discovery:** `GameAdapter` fires `local` → `main.ts` → `RoomSession.broadcastLocal()`.
- **A remote discovery:** `RoomSession` → `GameAdapter.applyTuples()` → `applied` event → `main.ts` → feed and toasts in `CoopPanel`.
- **Canvas and cursors** travel as the session's app messages:
  - `WorkspaceSync` ⇄ `WorkspaceBridge` (the game canvas);
  - `Cursors` → `CoopPanel.setCursors()`.

### The replicated state

The game keeps its save as a list of recipe pairs (`game.history.parents`) and rebuilds everything else from it. That list *is* the co-op state:

- It is a grow-only set of tuples `[a, b, timestamp]` (`src/sync/pairs.ts`).
- Merging is a union, so it can't conflict.
- Every player's save holds the whole room's union.

### Game side

`src/game/adapter.ts` is the only code that touches the game.

- **Local discoveries:** it hears them through the game's jQuery `updateHistory` event.
- **Remote discoveries** are applied through the game's own code paths, so the library, counter, save and achievements update natively:
  - Up to 30 pairs: triggering the game's `childCreated` event.
  - Bigger syncs: the game's own rebuild functions, deferred while the player holds the mouse button down.
- **Backup:** it keeps a one-time backup of the save from before the first co-op merge.
- **Game globals** are typed in `src/game/globals.d.ts`. `whenReady()` is the runtime check, and it reports unsupported game builds.

### Room session

`src/net/session.ts` (`RoomSession`) runs a star topology.

**Host election**
- Whoever holds the PeerJS id `lacoop1-<CODE>` on the broker is the host and relays messages.
- "Join" means: connect to that id, or claim it if nobody holds it.
- When the host goes away, the others race to claim the id.

**Syncing**
- A `hello`/`welcome` exchange swaps full pair sets.
- After that, `add` messages carry only new pairs.

**It also handles**
- heartbeats, reconnects and host handover;
- rate limits;
- rejections: `version`, `build`, `full`, `replaced`, `kicked`, `locked`;
- room flags (locked, banned). These are copied to every member, so a new host keeps enforcing them.

**Stale callbacks** from an earlier connection attempt are dropped by comparing a generation counter (`_gen`).

**Dependencies are injected** so the whole state machine is unit-tested against fakes: `createPeer`, `game`, `timing` and `random`.

### Wire protocol

`src/net/protocol.ts` defines JSON messages over WebRTC data channels.

- They are validated with valibot. `decode()` never throws.
- Unknown message types decode to `{t: 'unknown'}` and are ignored, which lets newer peers add features.
- `PROTOCOL_VERSION = 2`. The host rejects clients with a different protocol version or a different game build.

### Features built on the room

Features use "app" messages instead of new protocol messages:

- `sendApp(k, d)`, `relayApp` and `sendAppTo` send them; the `app` event receives them.
- `welcomed` and `departed` events let a feature send its state to newcomers and clean up after leavers.
- Each feature validates its own payloads.

### Shared canvas

It is split so the rules are testable without a browser:

- **`workspace/ops.ts`:** op tuples `a`/`d`/`m`/`h`/`r` (add, delete, move, hold, release).
  - Positions are the element's centre, relative to the playable area (0..1).
  - `projection.ts` maps these positions to and from each screen.
- **`workspace/state.ts`:** the canvas as data.
  - The host applies batches all-or-nothing. It refuses touching an element someone else holds, or using an element that is already gone.
  - Clients apply the host's relayed batches leniently.
  - `hash()` is an FNV-1a fingerprint.
- **`workspace/sync.ts`:**
  - The host referees and relays.
  - Clients apply their own batches at once, then rebuild from a snapshot plus their unacknowledged batches.
  - A joining player's canvas is replaced by the room's.
  - Idle clients send a fingerprint every 30 s; two mismatches in a row get a fresh snapshot.
  - App kinds: `ws` (batch), `wsnap` (snapshot), `wshash` (fingerprint).
- **`game/workspace-bridge.ts`:** the only code touching the game's canvas. The header comment explains each hook:
  - wraps `WorkspaceBox.prototype.initEvents`;
  - watches removals with a MutationObserver;
  - follows drags through jQuery drag events;
  - patches `Droppable` position caches and `_accept`.

### Cursors and UI

**Cursors (`src/cursors.ts`)**
- App kind `cur`: `{x, y, h?}` or `{off: true}`, throttled.
- They are drawn by `ui/cursor-layer.tsx`.

**UI (`src/ui/`)**
- Preact + `@preact/signals`, inside a Shadow DOM.
- `state.ts` holds all UI state as signals, and the components redraw from them.
- `CoopPanel` (`panel.tsx`) is the facade the rest of the code calls (`setStatus`, `setMembers`, `toast`, `addFeed`, …).
- Input events are stopped at the shadow boundary, because the game's document-level handlers would eat typing.
- CSS files are imported as text.

**Tab guard (`src/tabguard.ts`)**
- Keeps co-op active in one tab per browser, because the game's save is per-origin localStorage.

## Rules

### Protocol, data and game coupling

- **Keep the wire protocol compatible.** Versions 0.2 and later must be able to share a room.
  - Don't change existing message shapes, app kinds, the op format or the `state.hash()` fingerprint incompatibly.
  - Add optional fields or new message/app kinds instead; older peers ignore the unknown ones.
  - A breaking change needs a `PROTOCOL_VERSION` bump, which splits rooms by version.
  - Verify compatibility with `EXTENSION_DIR_B`.
- **Treat data from peers and from storage as untrusted.** Parse it through the valibot schemas in `protocol.ts`, `ops.ts`, `cursors.ts` and `store.ts`. Types come from the schemas (`v.InferOutput`); don't duplicate them as hand-written interfaces.
- **Keep game coupling in two files:** `adapter.ts` (game state) and `workspace-bridge.ts` (canvas). Anything newly used from the game goes into `globals.d.ts` and gets a runtime check.
- **Keep the README's promises true.**
  - README's *Privacy* section lists exactly what goes over the wire. Keep it accurate when adding data to messages.
  - The manifest declares no data collection to Firefox (`data_collection_permissions: none`).
  - The extension stays labelled an unofficial fan project and never bundles the game's code or assets.

### UI

- **Keep class names, labels and DOM order stable.** `styles.css` and the browser tests select by them.
- **Don't overwrite what the player is typing.** Text fields use draft signals (`nameDraft`, `codeDraft`, `serverDraft`), and room updates must not overwrite a field while it's being typed in.

### Dependencies and tooling

- **Prefer packages over own code**, as long as they run in the browser: no Node-only dependencies and no `eval`.
  - Runtime dependencies: peerjs, preact, @preact/signals, valibot, nanoid, es-toolkit.
  - Deliberately kept as own code, because it's specific to this game and protocol: the Emitter, session state machine, canvas referee, op batching, FNV hash, tab guard, rate limiters and projection maths.
- **No React.** Preact + signals was chosen on purpose.
- **Linting is ESLint only** (typescript-eslint, type-aware); no Prettier.
- **The build stays esbuild + web-ext**, not a framework like WXT.

### TypeScript

- Strict mode; relative imports carry the `.ts`/`.tsx` extension.
- Only erasable syntax (no enums, namespaces or parameter properties), because Node strips the types.
- There are two projects:
  - `src/tsconfig.json`: browser code; DOM + jQuery types, no Node types.
  - `tsconfig.json`: tests, scripts and config files, run by Node.
- TypeScript is pinned to `~6.0` because typescript-eslint doesn't support TypeScript 7 yet. Don't bump it until it does.

### Build output

- The release bundle stays unminified and without source maps, because store reviewers read it.
- The version lives only in `package.json`; the build writes it into `extension/manifest.json`.

### Tests

- **Unit tests** use `test/unit/fakes.ts`:
  - `FakeNetwork`, `FakePeer` and `FakeConn`, which mimic the PeerJS broker (`unavailable-id`, `peer-unavailable`, broker disconnects);
  - `FakeGame`, `FAST_TIMING` and `waitFor`.
- **Behaviour that needs the real game** goes in `test/integration` (one player). Only use `test/e2e` when players must actually connect; those tests are slow and depend on the live site and broker.

### Git

- Commit straight to `main`, without feature branches.
- Don't push unless asked.

## CI and releasing

**Workflows.** `.github/workflows/ci.yml` and `publish.yml` only call reusable workflows (`@v1`) from the user's shared CI repository **Der-Floh/Der-Floh**: `extension-ci.yml` and `extension-publish.yml`. Change CI behaviour there, not here. That repo's `.github/CI.md` documents them, and it prefers common third-party or official actions over custom scripts.

**Releasing a version:**

1. Run `npm version <x.y.z> --no-git-tag-version` and `npm run build`, then commit.
2. Publish a GitHub release tagged `v<x.y.z>`. The tag must match `package.json`.

**What the publish workflow does:**

1. Lints and zips the extension, attaches the zip to the release, and attests it.
2. Submits it to the Chrome Web Store and to addons.mozilla.org. AMO also gets a source archive, and its reviewers rebuild with `npm ci && npm run build`.

**Store setup:**

- Each store is switched on by a repository variable (`CHROME_EXTENSION_ID`, `FIREFOX_ADDON_ID`) once its first version has been uploaded by hand.
- Keep the gecko id `little-alchemy-coop@fan-project` stable. AMO treats a changed id as a new add-on.
