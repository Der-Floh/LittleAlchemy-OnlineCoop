import { defineConfig } from '@playwright/test';

// test/integration: one player, real game, no network.
// test/e2e: several players connected through the public PeerJS broker.
export default defineConfig({
  testDir: 'test',
  testMatch: /(integration|e2e)[\\/].*\.spec\.ts$/,
  timeout: 300_000,
  expect: { timeout: 30_000 },
  workers: 1,
  reporter: [['list']],
  use: { actionTimeout: 30_000 },
});
