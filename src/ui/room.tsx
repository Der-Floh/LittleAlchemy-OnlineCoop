// In a room: what arrived while you were away, the room code, the players
// (with the host's controls) and the activity feed.

import { useSignal } from '@preact/signals';
import type { RoomMember } from '../net/session.ts';
import { colorFor } from './colors.ts';
import { Parts } from './parts.tsx';
import type { Ui } from './state.ts';

type Props = { ui: Ui };

// The away card shows this many elements, then "+N more".
const AWAY_MAX = 48;

export function Room({ ui, hidden }: Props & { hidden: boolean }) {
  const { tone, text } = ui.statusLine.value;
  const inRoom = ui.inRoom.value;
  const locked = ui.room.value.locked;
  const code = () => ui.status.value.code ?? '';
  return (
    <div class="view stack" hidden={hidden}>
      <AwayCardView ui={ui} />
      <div class="room-code-row">
        <span class="room-code">{ui.status.value.code ?? ''}</span>
        <CopyButton label="Copy" title="Copy the room code" text={code} />
        <CopyButton label="Invite link" title="Copy an invite link" text={() => 'https://littlealchemy.com/#coop=' + code()} />
      </div>
      <div class="status-line">
        <span class="dot" data-tone={tone} />
        <span>{text}</span>
      </div>
      <div class="players-head">
        <div class="section-title">Players</div>
        <span class="lock-badge" title="New players can’t join this room" hidden={!(inRoom && locked)}>
          Locked
        </span>
        <button
          class="subtle lock-button"
          hidden={!(inRoom && ui.iAmHost.value)}
          title={locked ? 'Let new players join again' : 'Stop new players from joining'}
          onClick={() => ui.handlers.onLock(!ui.room.value.locked)}
        >
          {locked ? 'Unlock room' : 'Lock room'}
        </button>
      </div>
      <PlayerList ui={ui} />
      <div class="section-title">Activity</div>
      <Feed ui={ui} />
      <button class="danger" onClick={() => ui.handlers.onLeave()}>
        Leave room
      </button>
    </div>
  );
}

function AwayCardView({ ui }: Props) {
  const away = ui.away.value;
  const shown = away ? away.elements.slice(0, AWAY_MAX) : [];
  const more = away ? away.elements.length - shown.length : 0;
  return (
    <div class="away" role="status" hidden={!away}>
      <button class="subtle away-close" title="Dismiss" aria-label="Dismiss" onClick={() => (ui.away.value = null)}>
        ✕
      </button>
      <div class="away-title">{away?.title}</div>
      <div class="away-subtitle">{away?.subtitle}</div>
      <div class="away-grid">
        {shown.map((e) => (
          <div key={e.id} class="away-item" title={e.name}>
            {e.image && <img src={e.image} alt="" />}
            <span>{e.name}</span>
          </div>
        ))}
        {more > 0 && <div class="away-more">{'+' + more + ' more'}</div>}
      </div>
    </div>
  );
}

function PlayerList({ ui }: Props) {
  const iAmHost = ui.iAmHost.value;
  return (
    <ul class="players">
      {ui.members.value.map((m) => (
        <li key={m.id} data-player={m.id}>
          <span class="dot" style={{ background: colorFor(m.color) }} />
          <span class="player-name">{m.name}</span>
          {m.you && <span class="tag">you</span>}
          {m.host && <span class="tag">host</span>}
          {iAmHost && !m.you && <HostActions ui={ui} member={m} />}
        </li>
      ))}
    </ul>
  );
}

function HostActions({ ui, member }: Props & { member: RoomMember }) {
  return (
    <span class="player-actions">
      <button
        class="subtle"
        title={'Make ' + member.name + ' the host'}
        onClick={() => {
          if (window.confirm('Make ' + member.name + ' the host of this room?')) ui.handlers.onHandOver(member);
        }}
      >
        Make host
      </button>
      <button
        class="subtle danger"
        title={'Remove ' + member.name + ' from the room'}
        onClick={() => {
          if (window.confirm('Remove ' + member.name + ' from the room? They can’t rejoin until everyone has left.')) ui.handlers.onKick(member);
        }}
      >
        Kick
      </button>
    </span>
  );
}

function Feed({ ui }: Props) {
  const feed = ui.feed.value;
  return (
    <>
      <div class="feed-empty" hidden={feed.length > 0}>
        Discoveries from everyone in the room show up here.
      </div>
      <ol class="feed">
        {feed.map((item) => (
          <li key={item.id} class={item.muted ? 'muted' : ''}>
            <Parts parts={item.parts} />
          </li>
        ))}
      </ol>
    </>
  );
}

// A button that copies text and says whether it worked for a moment.
function CopyButton({ label, title, text }: { label: string; title: string; text: () => string }) {
  const shown = useSignal(label);
  const copy = async (button: HTMLButtonElement) => {
    const ok = await copyText(text(), button.getRootNode() as ShadowRoot);
    shown.value = ok ? 'Copied!' : 'Copy failed';
    setTimeout(() => (shown.value = label), 1500);
  };
  return (
    <button title={title} onClick={(event) => void copy(event.currentTarget)}>
      {shown.value}
    </button>
  );
}

async function copyText(text: string, root: ShadowRoot): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Older browsers, or the page doesn't allow the clipboard API.
    const area = document.createElement('textarea');
    area.value = text;
    root.append(area);
    area.select();
    let ok: boolean;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    area.remove();
    return ok;
  }
}
