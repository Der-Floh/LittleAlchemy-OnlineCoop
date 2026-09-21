// Settings: name, pop-ups, cursors, the pre-co-op backup, and an own PeerJS server.

import type { BackupInfo } from '../game/adapter.ts';
import type { Settings } from '../store.ts';
import { NameInput } from './lobby.tsx';
import type { PeerServerInput, Ui } from './state.ts';

function backupText(backup: BackupInfo | null | undefined): string {
  if (backup === undefined) return '';
  if (!backup) return 'No backup yet. One is made automatically the first time you join a room.';
  const date = new Date(backup.savedAt).toLocaleString();
  return 'Your save from before you first used co-op (' + date + ', ' + backup.count + ' elements) is kept here.';
}

function serverNote(settings: Settings | null): string {
  if (!settings) return '';
  const server = settings.peerServer;
  return server
    ? 'Using ' + server.host + ':' + server.port + server.path + '. Everyone in the room must use the same server.'
    : 'Using the public PeerJS server.';
}

export function SettingsView({ ui, hidden }: { ui: Ui; hidden: boolean }) {
  const settings = ui.settings.value;
  const backup = ui.backup.value;
  const inRoom = ui.inRoom.value;
  const draft = ui.serverDraft.value;
  const edit = (change: Partial<PeerServerInput>) => (ui.serverDraft.value = { ...ui.serverDraft.value, ...change });
  // The checkbox shows the new value right away; main.ts saves it.
  const setFlag = (key: 'toasts' | 'cursors', on: boolean) => {
    if (ui.settings.value) ui.settings.value = { ...ui.settings.value, [key]: on };
    if (key === 'toasts') ui.handlers.onToasts(on);
    else ui.handlers.onCursors(on);
  };
  return (
    <div class="view stack" hidden={hidden}>
      <label class="field">
        Your name
        <NameInput ui={ui} />
      </label>
      <label class="check">
        <input type="checkbox" checked={settings?.toasts ?? false} onChange={(event) => setFlag('toasts', event.currentTarget.checked)} />
        Pop-ups for your friends’ discoveries
      </label>
      <label class="check">
        <input type="checkbox" checked={settings?.cursors ?? false} onChange={(event) => setFlag('cursors', event.currentTarget.checked)} />
        Show other players’ cursors
      </label>
      <div class="section-title">Backup</div>
      <p class="note">{backupText(backup)}</p>
      <div class="row">
        <button
          disabled={!backup || inRoom || !ui.usable.value}
          title={inRoom ? 'Leave the room first' : ''}
          onClick={() => {
            if (window.confirm('Replace your current Little Alchemy progress with the backup? Progress made since then will be lost.')) {
              ui.handlers.onRestoreBackup();
            }
          }}
        >
          Restore backup
        </button>
        <button
          class="danger"
          disabled={!backup}
          onClick={() => {
            if (window.confirm('Delete the backup of your pre-co-op save?')) ui.handlers.onDiscardBackup();
          }}
        >
          Delete backup
        </button>
      </div>
      <details>
        <summary>Advanced: own PeerJS server</summary>
        <div class="stack">
          <p class="note">
            Rooms find each other through the free public PeerJS server (0.peerjs.com). If it is down you can point everyone in the room at
            your own PeerServer.
          </p>
          <div class="grid2">
            <input
              type="text"
              placeholder="host (e.g. peer.example.com)"
              spellcheck={false}
              value={draft.host}
              onInput={(event) => edit({ host: event.currentTarget.value })}
            />
            <input
              type="number"
              placeholder="port"
              min="1"
              max="65535"
              value={draft.port}
              onInput={(event) => edit({ port: event.currentTarget.value })}
            />
          </div>
          <div class="grid2">
            <input
              type="text"
              placeholder="path (default /)"
              spellcheck={false}
              value={draft.path}
              onInput={(event) => edit({ path: event.currentTarget.value })}
            />
            <label class="check">
              <input type="checkbox" checked={draft.secure} onChange={(event) => edit({ secure: event.currentTarget.checked })} />
              https
            </label>
          </div>
          <input
            type="text"
            placeholder="key (default peerjs)"
            spellcheck={false}
            value={draft.key}
            onInput={(event) => edit({ key: event.currentTarget.value })}
          />
          <p class="note">{serverNote(settings)}</p>
          <div class="row">
            <button onClick={() => ui.handlers.onPeerServer(ui.serverDraft.value)}>Use this server</button>
            <button class="subtle" onClick={() => ui.handlers.onPeerServer(null)}>
              Use default
            </button>
          </div>
        </div>
      </details>
      <p class="about">{'Little Alchemy Co-op v' + ui.version + ' · unofficial fan project'}</p>
      <button onClick={() => (ui.settingsOpen.value = false)}>Back</button>
    </div>
  );
}
