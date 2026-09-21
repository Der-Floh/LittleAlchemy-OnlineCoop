// window.__laCoop: the running extension's parts, for debugging in the
// console and for the browser tests.

import type { RoomSession } from './net/session.ts';
import type { GameAdapter } from './game/adapter.ts';
import type { WorkspaceBridge } from './game/workspace-bridge.ts';
import type { WorkspaceSync } from './workspace/sync.ts';
import type { Cursors } from './cursors.ts';
import type { CoopPanel } from './ui/panel.tsx';
import type { Settings } from './store.ts';

export type CoopDebug = {
  version: string;
  session: RoomSession;
  adapter: GameAdapter;
  settings: Settings;
  panel: CoopPanel;
  bridge: WorkspaceBridge;
  sync: WorkspaceSync;
  cursors: Cursors;
};

declare global {
  interface Window {
    __laCoop?: CoopDebug;
    __laCoopStarted?: boolean;
  }
}
