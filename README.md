# ![LittleAlchemy-OnlineCoop icon](https://raw.githubusercontent.com/Der-Floh/LittleAlchemy-OnlineCoop/main/assets/icon-x64.png) Little Alchemy Co-op

[![Chrome users](https://img.shields.io/chrome-web-store/users/mmkohnifjldajadihckfeknpmgaciibo?label=chrome%20users&color=4285f4&logo=google-chrome)](https://chromewebstore.google.com/detail/mmkohnifjldajadihckfeknpmgaciibo)
[![Firefox users](https://img.shields.io/amo/users/little-alchemy-co-op?label=firefox%20users&color=ff7139&logo=firefox-browser)](https://addons.mozilla.org/firefox/addon/little-alchemy-co-op/)
[![Release](https://img.shields.io/github/v/release/Der-Floh/LittleAlchemy-OnlineCoop?label=Release&color=2ea44f&logo=github)](https://github.com/Der-Floh/LittleAlchemy-OnlineCoop/releases/latest)
[![Issues](https://img.shields.io/github/issues/Der-Floh/LittleAlchemy-OnlineCoop?label=Issues&color=e4a000&logo=github)](https://github.com/Der-Floh/LittleAlchemy-OnlineCoop/issues)
[![CI](https://github.com/Der-Floh/LittleAlchemy-OnlineCoop/actions/workflows/ci.yml/badge.svg)](https://github.com/Der-Floh/LittleAlchemy-OnlineCoop/actions/workflows/ci.yml)

A browser extension (tested in Chrome and Firefox; other Chromium browsers such as Edge and Brave use the same build) that lets friends play [Little Alchemy classic](https://littlealchemy.com/) together:

- **Shared discoveries:** everything one player discovers appears in everyone's game within about a second: in the library, the element counter and the save.
- **Shared canvas:** everyone sees and plays on the same workspace. Elements, drags and combinations show up for all players, and you can see everyone's cursor.
- **Catching up:** when you come back to a room, a card shows what the others discovered while you were away.
- **Host controls:** the host can lock the room, remove a player, or hand the host role to someone else.

It runs on top of the official game. There is no server to run: players connect directly to each other (WebRTC, via [PeerJS](https://peerjs.com/)).

> Unofficial fan project, not affiliated with or endorsed by the makers of Little Alchemy. It bundles none of the game's code or assets.

## How to play

1. Install the extension (see below) and open <https://littlealchemy.com/>.
2. Click the **Co-op** button at the top left, then **Create room**.
3. Send your friend the 6-character code, or click **Invite link** and send that (`https://littlealchemy.com/#coop=K7M4PX`).
4. Your friend opens the link (or types the code under **or join a friend**).
5. Play. When someone discovers something new you get a pop-up, and the **Activity** list shows who made what.

On the shared canvas:

- Anyone can move or combine any element. While someone is dragging an element it's outlined in their colour with their name, and nobody else can grab it or drop onto it.
- Everyone sees the same arrangement, fitted to their own window: nothing ends up off-screen or behind the library, even on a smaller screen.
- The game's **clear** button removes only the elements *you* placed or made.
- Other players' cursors can be hidden under ⚙ → *Show other players' cursors*.

Good to know:

- **Progress is merged both ways.** When you join, everything you already had goes to the room and everything the room has comes to you, permanently. The first time you ever join a room, your save is backed up once; you can restore it under ⚙ → *Restore backup* (after leaving the room).
- **A room lives as long as someone is in it.** If the player who created the room leaves, someone else takes over automatically. If everyone leaves, nothing is lost (every save holds everything); the next person to join the same code opens it again.
- **Joining replaces your canvas** with the room's (your progress is untouched; elements can always be dragged from the library again).
- Reloading the page rejoins your room automatically. **Leave room** stops that.
- Use one Little Alchemy tab at a time; a second tab stays passive until you click *Use co-op in this tab*.
- Rooms hold up to 8 players.
- **Everyone needs version 0.2 or later.** Version 0.2 introduced a new connection protocol, so 0.1 can't share a room with newer versions; the game tells you if that happens. Versions from 0.2 on play together.

Host controls (in the **Players** list, for whoever is host):

- **Lock room:** nobody new can join; players who were already in can reconnect.
- **Kick:** removes a player; they can't rejoin until the room has emptied.
- **Make host:** hands the host role (and these controls) to another player.

## Installing

Download `little-alchemy-coop-<version>.zip` from a GitHub release, or build it yourself (see *Development*): `npm run build` puts the extension in `dist/`.

### Chrome / Edge / Brave / other Chromium browsers

1. Unzip the zip into a folder you'll keep (the browser loads it from there), or use `dist/` if you built it yourself.
2. Open `chrome://extensions` (Edge: `edge://extensions`).
3. Turn on **Developer mode**, click **Load unpacked**, select the folder.

Updating: replace the folder's contents and click the reload arrow on the extension's card.

### Firefox

- **Quick test (until Firefox restarts):** open `about:debugging#/runtime/this-firefox`, click **Load Temporary Add-on…** and pick the zip (or `dist/manifest.json`).
- **Permanent install:** Firefox only installs signed add-ons. Signing is free and automatic for self-distributed ("unlisted") add-ons:
    1. Create a Mozilla account and get API credentials at <https://addons.mozilla.org/developers/addon/api/key/>.
    2. Build it (see *Development*), then run:
       ```bash
       npx web-ext sign --source-dir dist --channel unlisted --api-key YOUR_JWT_ISSUER --api-secret YOUR_JWT_SECRET
       ```
    3. Share the resulting `.xpi` (web-ext puts it in `web-ext-artifacts/`); opening it in Firefox installs it.

  Mozilla may ask for the source code of the bundled script: that's this repository (`npm ci && npm run build` reproduces `dist/coop.js`).

If the Co-op button doesn't show up in Firefox, click the puzzle-piece (Extensions) menu and allow the extension on littlealchemy.com.

## Privacy

- There is no co-op server. Players find each other through the public PeerJS broker (`0.peerjs.com`) and then talk directly. Like any peer-to-peer connection, **players in a room can see each other's IP addresses**, so only share codes with people you know. If a direct connection is impossible, traffic is relayed through PeerJS's TURN servers.
- What is sent: your chosen name, a random player id, the game version, the recipes (pairs of element ids) you've discovered, the elements on the canvas and your cursor position over the canvas. Nothing else, and nothing goes anywhere except to the players in your room (and the connection metadata the PeerJS broker needs).
- Settings live in the page's own storage (`laCoopSettings`, `laCoopBackup`) next to Little Alchemy's save.

## Troubleshooting

| What you see | What to do |
| --- | --- |
| *Reconnecting… (can't reach the matchmaking server)* | The public PeerJS server is down or blocked on your network. Wait, or run your own with `npx peer --port 9000` on a machine reachable over **https** (the game page is https, e.g. behind a reverse proxy or tunnel); then everyone in the room enters it under ⚙ → *Advanced: own PeerJS server*. |
| *Reconnecting… (direct connection failed)* | Some networks (school, office, strict NAT) block peer-to-peer. Try another network or a phone hotspot. |
| *You are hosting. Waiting for friends…* but your friend is in a different room | Double-check the code: typing a code nobody is in simply opens a new empty room. |
| *Could not join: different versions of Little Alchemy* | One of you has a cached old game version; reload with Ctrl+F5. |
| *Could not join: Your co-op extension version does not match the host* | Someone still has version 0.1; everyone needs 0.2 or later. |
| An element snaps back after you moved it | Someone else grabbed it a split second earlier; the host keeps the first grab. |
| Co-op button missing | The extension must be enabled for littlealchemy.com. In Firefox, see above. |

For connection logs, run `localStorage.laCoopDebug = '1'` in the page's console and reload (`localStorage.removeItem('laCoopDebug')` turns them off).

## Development

Requires Node 22.18+ (it runs the TypeScript tests and scripts directly).

The code is strict TypeScript. esbuild bundles `src/` into the one content script, and `tsc` only type-checks. Libraries (all bundled, all running in the page): [PeerJS](https://peerjs.com/) for the connections, [Preact](https://preactjs.com/) with [signals](https://preactjs.com/guide/v10/signals) for the UI, [valibot](https://valibot.dev/) to check everything that comes from other players or from storage (its schemas also define the message types), [nanoid](https://github.com/ai/nanoid) for random ids and room codes, and [es-toolkit](https://es-toolkit.dev/) for small helpers.

```bash
npm install
```

```bash
npm run build        # build the extension into dist/: public/, src/ bundled, icons rendered from assets/icon.svg (npm run watch to rebuild on change)
```

```bash
npm run check        # type check, ESLint and unit tests: run this before committing
```

```bash
npm test             # unit tests only (protocol, settings, merge logic, canvas state, room session on a fake network)
```

```bash
npm run test:integration   # one player, real game, no network: game adapter, canvas bridge, cursors
```

```bash
npm run test:e2e     # two or three real Chrome profiles play together on the live site
```

```bash
npm run test:e2e:firefox   # Chrome player + Firefox player (needs Firefox installed)
```

```bash
npm run lint:ext     # Mozilla's add-on linter
```

(`lint:ext` reports one warning, an `innerHTML` assignment inside Preact's `dangerouslySetInnerHTML` support. The extension never uses that feature.)

```bash
npm run run:firefox  # opens Firefox with the extension loaded temporarily
```

```bash
npm run pack-source  # little-alchemy-coop-<version>-source.zip from the v<version> tag, for uploading to AMO by hand
```

The end-to-end tests use your installed Chrome with throwaway profiles. Branded Chrome no longer accepts `--load-extension`, so the extension is loaded through the DevTools protocol (`Extensions.loadUnpacked`). Set `CHROME_PATH` to use another Chromium browser, and `HEADED=1` to watch the tests run. `EXTENSION_DIR_B=<other build>` (an unzipped release, or another checkout's `dist/`) makes the second player in the co-op and canvas tests run another build, e.g. the previous release, to check that the two versions can share a room. `node scripts/ui-preview.ts <dir>` saves screenshots of the UI.

On GitHub, every push and pull request runs `.github/workflows/ci.yml` (the shared extension-ci workflow): `npm run check`, plus a build that Mozilla's add-on linter checks and that is kept as a zip among the run's artifacts. The integration and end-to-end tests only run locally, since they need a real Chrome and the live game.

### How it works

Little Alchemy classic (build 580) keeps its save as a list of recipe pairs (`localStorage.progress = {parents: [[a, b], …], date: […]}`) and rebuilds everything else from it. The co-op state is simply that list, merged between players (a grow-only set, so merging is a union and can't conflict).

The extension injects one script into the page (`world: "MAIN"`):

| File | Role |
| --- | --- |
| `src/game/adapter.ts` | The only code touching the game. Hears local discoveries through the game's own `updateHistory` event, and applies remote ones through the game's `childCreated` event (small batches) or its own rebuild functions (big syncs), so the library, counter, save and achievements update as if you had combined the elements yourself. |
| `src/net/session.ts` | Room logic. Whoever holds the PeerJS id `lacoop1-<CODE>` is the host and relays; "join" means *connect to the host, or become it if nobody is*. On connect, hello/welcome exchange full recipe sets; afterwards only new recipes are sent. Handles host changes (automatic or handed over), heartbeats, room flags (locked, kicked players), rejection of different game/protocol versions, duplicate windows, and carries "app" messages for the features below. |
| `src/game/workspace-bridge.ts` | The only code touching the game's canvas. Wraps `WorkspaceBox.prototype.initEvents` to see every new element, watches removals with a `MutationObserver`, follows drags through the game's drag events, and applies other players' changes with the game's own `workspace.add/del` (updating the drop target's cached position so local drops keep working). |
| `src/workspace/state.ts`, `ops.ts`, `projection.ts`, `sync.ts` | The shared canvas as data. The host referees: it applies each batch of changes all-or-nothing (refusing moves of elements someone else holds, or uses of elements that are already gone) and relays accepted ones. Clients apply their own changes at once and rebuild from snapshots when needed; a periodic fingerprint check repairs any drift. Positions are element centres relative to the playable area, so every screen shows the same arrangement. |
| `src/cursors.ts` | Live cursors (about 15 updates a second), including the element someone is dragging out of the library. |
| `src/net/protocol.ts`, `src/sync/pairs.ts` | Message schemas (everything from peers is untrusted) and pair helpers. |
| `src/ui/*` | Panel, pop-ups and cursors as Preact components in a Shadow DOM, drawn from signals that `CoopPanel` (`panel.tsx`) updates; stops keyboard events at its edge so the game's type-to-search doesn't eat your typing. |
| `src/tabguard.ts`, `src/store.ts`, `src/main.ts` | One co-op tab per browser, settings, wiring. |
| `src/game/globals.d.ts` | Types for the parts of the game the extension relies on. |

### Ideas for later

- "Discovered by" badges on library elements and a scoreboard (tuples already reserve a slot for it).
- Sharing failed combinations ("Bob already tried this").
- Chat or quick reactions, and "suggest an element" to the room.
- A background-tab alert, recent rooms, a translated co-op panel.
- A versus mode, and an optional separate co-op save.
- A self-hosted PeerServer/TURN as the default.
- TypeScript 7 (the native compiler), once typescript-eslint supports it; the project is on TypeScript 6 until then.
