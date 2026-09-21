// Everything the co-op UI shows, as signals: components read them and are
// redrawn when they change; CoopPanel (panel.tsx) sets them.

import { signal, computed } from '@preact/signals';
import type { RoomMember, Status } from '../net/session.ts';
import { emptyRoomFlags, type RoomFlags } from '../net/protocol.ts';
import type { Settings } from '../store.ts';
import type { BackupInfo, ElementInfo } from '../game/adapter.ts';
import { describeStatus, type Availability } from './text.ts';

// Rich text for the activity feed and toasts:
//   'text' | {who: {name, color}} | {el: 'steam', isNew: true}
export type Part = string | { who: { name: string; color: number } } | { el: string; isNew?: boolean; bold?: boolean };

export type BannerAction = { label: string; primary?: boolean; onClick: () => void };
export type Banner = { text: string; tone: 'info' | 'bad'; actions: BannerAction[] };
export type FeedItem = { id: number; parts: Part[]; muted: boolean };
export type Toast = { id: number; image: string | null; parts: Part[]; leaving: boolean };
export type AwayCard = { title: string; subtitle: string; elements: ElementInfo[] };
// Another player's cursor, in this screen's pixels.
export type CursorView = { id: string; name: string; color: number; left: number; top: number; ghost: string | null; hidden: boolean };
// The own-PeerJS-server form, as typed.
export type PeerServerInput = { host: string; port: string; path: string; key: string; secure: boolean };

export type PanelHandlers = {
  onCreate(): void;
  onJoin(code: string): void;
  onLeave(): void;
  onRename(name: string): void;
  onToasts(on: boolean): void;
  onCursors(on: boolean): void;
  onKick(member: RoomMember): void;
  onHandOver(member: RoomMember): void;
  onLock(locked: boolean): void;
  onRestoreBackup(): void;
  onDiscardBackup(): void;
  onPeerServer(server: PeerServerInput | null): void;
};

export function createUi(version: string, handlers: PanelHandlers) {
  const status = signal<Status>({ state: 'idle', role: null, code: null, detail: null });
  const members = signal<RoomMember[]>([]);
  const available = signal<Availability>('loading');
  return {
    version,
    handlers,
    open: signal(false),
    settingsOpen: signal(false),
    available,
    status,
    members,
    room: signal<RoomFlags>(emptyRoomFlags()),
    settings: signal<Settings | null>(null),
    // undefined until known, null when there is none
    backup: signal<BackupInfo | null | undefined>(undefined),
    banner: signal<Banner | null>(null),
    feed: signal<FeedItem[]>([]),
    toasts: signal<Toast[]>([]),
    away: signal<AwayCard | null>(null),
    night: signal(false),
    cursors: signal<CursorView[]>([]),
    // What's typed into the text fields, kept apart from the saved settings.
    nameDraft: signal(''),
    codeDraft: signal(''),
    serverDraft: signal<PeerServerInput>({ host: '', port: '', path: '', key: '', secure: true }),

    inRoom: computed(() => status.value.state !== 'idle' && status.value.state !== 'rejected'),
    usable: computed(() => available.value === 'ready'),
    iAmHost: computed(() => members.value.some((m) => m.you && m.host)),
    statusLine: computed(() => describeStatus(status.value, members.value, available.value)),
  };
}

export type Ui = ReturnType<typeof createUi>;
