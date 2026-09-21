// Entry point, injected into littlealchemy.com's page world by the extension.
// Wires the game adapter, the peer-to-peer room session, the UI and settings.

import { Peer } from 'peerjs';
import { GameAdapter } from './game/adapter.ts';
import { WorkspaceBridge } from './game/workspace-bridge.ts';
import { WorkspaceSync } from './workspace/sync.ts';
import { Cursors } from './cursors.ts';
import { RoomSession, type Who } from './net/session.ts';
import type { CreatePeer } from './net/peer.ts';
import { makeRoomCode, normalizeRoomCode, sanitizeName } from './net/protocol.ts';
import { loadSettings, saveSettings, peerOptions, sanitizePeerServer } from './store.ts';
import { CoopPanel } from './ui/panel.tsx';
import type { Part } from './ui/state.ts';
import { TabGuard } from './tabguard.ts';
import type { Tuple } from './sync/pairs.ts';

const VERSION = typeof __LA_COOP_VERSION__ === 'string' ? __LA_COOP_VERSION__ : 'dev';

function readInviteCode(): string | null {
    const match = /[#&]coop=([A-Za-z0-9-]{4,12})/.exec(window.location.hash);
    if (!match) return null;
    window.history.replaceState(null, '', window.location.pathname + window.location.search);
    return normalizeRoomCode(match[1]);
}

// Connection logging: run localStorage.laCoopDebug = '1' in the console, then reload.
function debugEnabled(): boolean {
    try {
        return window.localStorage.getItem('laCoopDebug') === '1';
    } catch {
        return false;
    }
}

function plural(n: number, word: string): string {
    return n + ' ' + word + (n === 1 ? '' : 's');
}

function duration(ms: number): string {
    const minutes = Math.round(ms / 60_000);
    if (minutes < 60) return plural(Math.max(1, minutes), 'minute');
    const hours = Math.round(minutes / 60);
    if (hours < 48) return plural(hours, 'hour');
    return plural(Math.round(hours / 24), 'day');
}

async function main(): Promise<void> {
    if (window.__laCoopStarted) return; // injected twice
    window.__laCoopStarted = true;
    const settings = loadSettings();
    const invite = readInviteCode();
    const adapter = new GameAdapter(window);
    let session: RoomSession | null = null;
    let sync: WorkspaceSync | null = null;
    let cursors: Cursors | null = null;
    // When we were last in the room we're joining (for the while-away card).
    let awaySince: number | null = null;
    let hostId: string | null = null;
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
            onCursors: (on) => {
                settings.cursors = on;
                saveSettings(settings);
                if (cursors) cursors.setEnabled(on);
            },
            onKick: (member) => {
                if (session) session.kick(member.id);
            },
            onHandOver: (member) => {
                if (session) session.handOver(member.id);
            },
            onLock: (locked) => {
                if (session) session.setLocked(locked);
            },
            onRestoreBackup: () => {
                try {
                    adapter.restoreBackup();
                    panel.showBanner('Backup restored.');
                } catch (err) {
                    panel.showBanner('Could not restore the backup: ' + (err instanceof Error ? err.message : String(err)), { tone: 'bad' });
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
                if (session?.code && sync && cursors) {
                    // Reconnect through the new server.
                    sync.start();
                    cursors.start();
                    session.join(session.code);
                }
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
        panel.showBanner('Co-op is unavailable: ' + (err instanceof Error ? err.message : String(err)) + '.', { tone: 'bad' });
        return;
    }
    adapter.start();
    panel.setBackup(adapter.backupInfo());

    const log = (...args: unknown[]) => {
        if (debugEnabled()) console.debug('[la-coop]', ...args);
    };
    const createPeer: CreatePeer = (id) => {
        const options = peerOptions(settings, { debug: debugEnabled() });
        return id === undefined ? new Peer(options) : new Peer(id, options);
    };
    const room = new RoomSession({
        createPeer,
        game: adapter,
        player: { id: settings.playerId, name: settings.name },
        build: adapter.getBuild(),
        log,
    });
    session = room;
    const bridge = new WorkspaceBridge(window);
    const canvas = new WorkspaceSync({ session: room, bridge, log });
    sync = canvas;

    const pointers = new Cursors({
        win: window,
        session: room,
        bridge,
        render: (list) => panel.setCursors(list),
        elementImage: (id) => adapter.elementInfo(id).image,
    });
    pointers.setEnabled(settings.cursors);
    cursors = pointers;

    window.__laCoop = { version: VERSION, session: room, adapter, settings, panel, bridge, sync: canvas, cursors: pointers };

    // ---- session -> UI ---------------------------------------------------------

    room.on('status', (status) => {
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
    room.on('members', (members) => {
        panel.setMembers(members);
        const host = members.find((m) => m.host);
        if (host && hostId && host.id !== hostId && !host.you) panel.addFeed([{ who: host }, ' is now the host.'], { muted: true });
        if (host) hostId = host.id;
    });
    room.on('room', (flags) => {
        const wasLocked = panel.room.locked;
        panel.setRoom(flags);
        if (flags.locked !== wasLocked && ['hosting', 'connected'].includes(room.state)) {
            panel.addFeed([flags.locked ? 'The room is now locked: no new players can join.' : 'The room is open again.'], { muted: true });
        }
    });
    room.on('kicked', (member) => {
        if (room.role === 'host') panel.addFeed(['You removed ', { who: member }, ' from the room.'], { muted: true });
        else panel.addFeed([{ who: member }, ' was removed by the host.'], { muted: true });
    });
    room.on('handover', ({ to }) => {
        hostId = to.id; // so the host change isn't announced twice
        panel.addFeed(['You made ', { who: to }, ' the host.'], { muted: true });
    });
    canvas.on('cleared', (by) => panel.addFeed([{ who: by }, ' cleared their elements from the canvas.'], { muted: true }));
    room.on('joined', (member) => panel.addFeed([{ who: member }, ' joined.'], { muted: true }));
    room.on('left', (member) => panel.addFeed([{ who: member }, ' left.'], { muted: true }));
    room.on('rejected', ({ reason, detail }) => {
        if (reason === 'replaced') {
            // Another window of ours took over; leave the shared settings alone.
            panel.showBanner('Disconnected: ' + panel.rejectText(reason, ''), { tone: 'bad' });
            return;
        }
        if (settings.room) settings.room.active = false;
        saveSettings(settings);
        if (reason === 'kicked') panel.showBanner(panel.rejectText(reason, ''), { tone: 'bad' });
        else panel.showBanner('Could not join: ' + panel.rejectText(reason, detail), { tone: 'bad' });
    });

    // ---- game -> session / UI ----------------------------------------------------

    const me = () => {
        const self = room.members.find((m) => m.you);
        return { name: 'You', color: self ? self.color : 0 };
    };
    const name = (id: number) => adapter.elementInfo(id).name;
    const recipeParts = (by: { name: string; color: number }, tuple: Tuple, children: number[], newElements: number[]) => {
        const parts: Part[] = [{ who: by }, ': ' + name(tuple[0]) + ' + ' + name(tuple[1]) + ' → '];
        children.forEach((id, i) => {
            if (i > 0) parts.push(', ');
            parts.push({ el: name(id), isNew: newElements.includes(id) });
        });
        return parts;
    };

    adapter.on('local', ({ tuple, children, newElements }) => {
        room.broadcastLocal([tuple]);
        if (room.code) panel.addFeed(recipeParts(me(), tuple, children, newElements));
    });

    adapter.on('applied', ({ meta, recipes, newElements }) => {
        const by: Who = meta.by ?? { id: '?', name: 'Someone', color: 0 };
        if (meta.sync) {
            if (newElements.length > 0) showCatchUp(by, recipes.length, newElements);
            const summary = ': +' + plural(recipes.length, 'recipe') + (newElements.length ? ', +' + plural(newElements.length, 'new element') : '');
            if (by.host) panel.addFeed(['Synced with the room' + summary]);
            else panel.addFeed([{ who: by }, ' shared their progress' + summary]);
            const first = newElements[0];
            if (settings.toasts && first !== undefined) {
                panel.toast({
                    image: adapter.elementInfo(first).image,
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

    // "While you were away" (our own rejoin) or "Bob brought…" (someone joining).
    function showCatchUp(by: Who, recipeCount: number, newElements: number[]): void {
        const elements = newElements.map((id) => adapter.elementInfo(id)).sort((a, b) => a.name.localeCompare(b.name));
        let title;
        if (!by.host) title = by.name + ' brought new elements';
        else if (awaySince) title = 'While you were away (' + duration(Date.now() - awaySince) + ')';
        else title = 'New from the room';
        panel.showAway({
            title,
            subtitle: '+' + plural(elements.length, 'element') + ', +' + plural(recipeCount, 'recipe'),
            elements,
        });
        awaySince = null;
    }

    function rememberLastSeen(): void {
        if (!room.code || !['hosting', 'connected'].includes(room.state)) return;
        settings.lastSeen = { ...settings.lastSeen, [room.code]: Date.now() };
        saveSettings(settings);
    }
    setInterval(rememberLastSeen, 60_000);

    adapter.on('reset', ({ reason }) => {
        if (reason === 'game-reset' && room.code) {
            panel.addFeed(['Your progress was reset. It fills up again from the room the next time you reconnect.'], { muted: true });
        }
    });

    // ---- room actions --------------------------------------------------------------

    function joinRoom(code: string, { auto = false } = {}): void {
        if (!guard.active) return;
        panel.hideBanner();
        if (adapter.ensureBackup()) panel.setBackup(adapter.backupInfo());
        settings.room = { code, active: true };
        saveSettings(settings);
        if (!auto || hadRoom) panel.clearFeed();
        hadRoom = true;
        lastState = 'connecting';
        awaySince = settings.lastSeen[code] ?? null;
        hostId = null;
        panel.hideAway();
        canvas.start();
        pointers.start();
        room.join(code);
    }

    function leaveRoom(): void {
        rememberLastSeen();
        room.leave();
        if (settings.room) settings.room.active = false;
        saveSettings(settings);
        panel.clearFeed();
        lastState = 'idle';
    }

    function yieldToOtherTab(): void {
        room.leave({ immediate: true });
        lastState = 'idle';
        setPassive('Co-op moved to another Little Alchemy tab.');
    }

    // An invite that arrived while this tab was passive, offered after a takeover.
    let pendingInvite: string | null = null;

    function setPassive(message: string): void {
        panel.setAvailability('passive');
        panel.showBanner(message + ' Little Alchemy keeps one save per browser, so play in one tab at a time.', {
            actions: [{ label: 'Use co-op in this tab', primary: true, onClick: takeOver }],
        });
    }

    function takeOver(): void {
        guard.takeOver();
        Object.assign(settings, loadSettings());
        panel.setSettings(settings);
        panel.hideBanner();
        panel.setAvailability('ready');
        if (settings.room?.active) joinRoom(settings.room.code, { auto: true });
        if (pendingInvite) {
            const code = pendingInvite;
            pendingInvite = null;
            offerInvite(code);
        }
    }

    function offerInvite(code: string): void {
        if (room.code === code) return;
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
        rememberLastSeen();
        if (room.code) room.leave({ immediate: true });
    });
    window.addEventListener('pageshow', (event) => {
        if (event.persisted && guard.active && settings.room?.active) joinRoom(settings.room.code, { auto: true });
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

    const rejoin = settings.room?.active ? settings.room.code : null;
    if (rejoin) joinRoom(rejoin, { auto: true });
    if (invite && invite !== rejoin) offerInvite(invite);
}

main().catch((err: unknown) => console.error('[la-coop] failed to start', err));
