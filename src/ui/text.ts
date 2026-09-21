// What the panel says about the connection.

import type { RoomMember, Status } from '../net/session.ts';

export type Tone = 'idle' | 'ok' | 'warn' | 'bad';
export type Availability = 'loading' | 'ready' | 'passive' | 'fatal';

const DETAIL_TEXT: Record<string, string> = {
    broker: "can't reach the matchmaking server",
    webrtc: 'direct connection failed, your network may block peer-to-peer',
    timeout: 'connection timed out',
    closed: 'connection closed',
    error: 'connection error',
    rtc: 'connection dropped',
    'host-left': 'the host left, switching host',
    rehome: 'switching host',
    handover: 'handing over the host',
};

const REJECT_TEXT: Record<string, string> = {
    version: 'Your co-op extension version does not match the host. Update the extension on both sides.',
    build: 'You and the host play different versions of Little Alchemy.',
    full: 'That room is full.',
    replaced: 'You are connected to this room from another window or tab.',
    kicked: 'The host removed you from this room.',
    locked: 'This room is locked by its host.',
};

export function rejectText(reason: string, detail: string): string {
    return (REJECT_TEXT[reason] ?? 'The host refused the connection.') + (detail ? ' ' + detail : '');
}

// The status dot's colour and the status line.
export function describeStatus(status: Status, members: RoomMember[], available: Availability): { tone: Tone; text: string } {
    const { state, detail } = status;
    let tone: Tone = 'idle';
    let text = '';
    const others = members.filter((m) => !m.you).length;
    if (state === 'connecting') {
        tone = 'warn';
        text = 'Connecting…';
    } else if (state === 'hosting') {
        tone = 'ok';
        text =
            others === 0
                ? 'You are hosting. Waiting for friends to join (share the code, and double-check it if you expected someone).'
                : 'Connected. You are the host.';
    } else if (state === 'connected') {
        tone = 'ok';
        text = 'Connected.';
    } else if (state === 'reconnecting') {
        tone = 'warn';
        const why = detail ? DETAIL_TEXT[detail] : undefined;
        text = 'Reconnecting…' + (why ? ' (' + why + ')' : '');
    } else if (state === 'rejected') {
        tone = 'bad';
    }
    if (available === 'fatal') tone = 'bad';
    return { tone, text };
}
