// The whole co-op UI inside our shadow root: other players' cursors, the pill
// next to the game's fullscreen button, the panel it opens, and toasts.

import css from './styles.css';
import type { Ui } from './state.ts';
import { Parts } from './parts.tsx';
import { Lobby } from './lobby.tsx';
import { Room } from './room.tsx';
import { SettingsView } from './settings.tsx';
import { CursorLayer } from './cursor-layer.tsx';

type Props = { ui: Ui };

export function App({ ui }: Props) {
  return (
    <>
      <style>{css}</style>
      <div class={ui.night.value ? 'root night' : 'root'}>
        <CursorLayer ui={ui} />
        <Pill ui={ui} />
        <Panel ui={ui} />
        <Toasts ui={ui} />
      </div>
    </>
  );
}

function Pill({ ui }: Props) {
  const { code } = ui.status.value;
  const { tone, text } = ui.statusLine.value;
  const inRoom = ui.inRoom.value;
  return (
    <button
      class="pill"
      title={inRoom ? 'Co-op room ' + code + ' (' + text + ')' : 'Little Alchemy Co-op'}
      aria-expanded={ui.open.value ? 'true' : 'false'}
      onClick={() => (ui.open.value = !ui.open.value)}
    >
      <span class="dot" data-tone={tone} />
      <span>Co-op</span>
      <span class="extra">{inRoom && code ? code + ' · ' + Math.max(1, ui.members.value.length) : ''}</span>
    </button>
  );
}

function Panel({ ui }: Props) {
  const settingsOpen = ui.settingsOpen.value;
  const inRoom = ui.inRoom.value;
  const close = () => (ui.open.value = false);
  return (
    <section
      class="panel"
      aria-label="Co-op panel"
      hidden={!ui.open.value}
      onKeyDown={(event) => {
        if (event.key === 'Escape') close();
      }}
    >
      <header>
        <h2>
          Co-op<small>unofficial</small>
        </h2>
        <button
          class="subtle"
          title="Settings"
          aria-label="Settings"
          aria-pressed={String(settingsOpen) as 'true' | 'false'}
          onClick={() => (ui.settingsOpen.value = !settingsOpen)}
        >
          ⚙
        </button>
        <button class="subtle" title="Close" aria-label="Close" onClick={close}>
          ✕
        </button>
      </header>
      <BannerView ui={ui} />
      <Lobby ui={ui} hidden={settingsOpen || inRoom} />
      <Room ui={ui} hidden={settingsOpen || !inRoom} />
      <SettingsView ui={ui} hidden={!settingsOpen} />
    </section>
  );
}

function BannerView({ ui }: Props) {
  const banner = ui.banner.value;
  return (
    <div class="banner" role="status" hidden={!banner} data-tone={banner?.tone}>
      {banner && <div>{banner.text}</div>}
      {banner && banner.actions.length > 0 && (
        <div class="banner-actions">
          {banner.actions.map((action) => (
            <button key={action.label} class={action.primary ? 'primary' : ''} onClick={action.onClick}>
              {action.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function Toasts({ ui }: Props) {
  return (
    <div class="toasts" aria-live="polite">
      {ui.toasts.value.map((toast) => (
        <div key={toast.id} class={toast.leaving ? 'toast leaving' : 'toast'}>
          {toast.image && <img src={toast.image} alt="" />}
          <span>
            <Parts parts={toast.parts} />
          </span>
        </div>
      ))}
    </div>
  );
}
