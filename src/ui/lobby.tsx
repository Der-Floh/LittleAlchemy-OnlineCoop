// Before joining: your name, create a room, or join one by code.

import type { Ui } from './state.ts';

// The player's name, saved when it changes. Shared by the lobby and settings.
export function NameInput({ ui }: { ui: Ui }) {
  return (
    <input
      type="text"
      name="name"
      maxLength={24}
      autoComplete="off"
      spellcheck={false}
      value={ui.nameDraft.value}
      onInput={(event) => (ui.nameDraft.value = event.currentTarget.value)}
      onChange={(event) => ui.handlers.onRename(event.currentTarget.value)}
    />
  );
}

export function Lobby({ ui, hidden }: { ui: Ui; hidden: boolean }) {
  const disabled = !ui.usable.value;
  const join = () => ui.handlers.onJoin(ui.codeDraft.value);
  return (
    <div class="view stack" hidden={hidden}>
      <label class="field">
        Your name
        <NameInput ui={ui} />
      </label>
      <button class="primary" disabled={disabled} onClick={() => ui.handlers.onCreate()}>
        Create room
      </button>
      <div class="divider">or join a friend</div>
      <div class="row">
        <input
          type="text"
          class="code-input"
          maxLength={8}
          placeholder="CODE"
          autoComplete="off"
          spellcheck={false}
          aria-label="Room code"
          disabled={disabled}
          value={ui.codeDraft.value}
          onInput={(event) => (ui.codeDraft.value = event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') join();
          }}
        />
        <button disabled={disabled} onClick={join}>
          Join
        </button>
      </div>
      <p class="note">
        Joining merges progress both ways: everything anyone in the room discovers ends up in everyone’s save. Your current save is backed
        up once (see ⚙).
      </p>
    </div>
  );
}
