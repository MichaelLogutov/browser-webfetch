import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { chromium } from 'rebrowser-playwright';
import { BrowserSingleton } from '../../src/browser.js';

// Reproduces the "started but disconnected before attach" failure: when a stale
// Chromium (an orphan from a previous crashed/killed run) still holds the
// persistent --user-data-dir, the next launchPersistentContext spawns a chrome
// that prints "Opening in existing browser session." and exits immediately, so
// the remote-debugging pipe never comes up and playwright throws
// "Target page, context or browser has been closed".
//
// By default (no opt-in reclaim) BrowserSingleton must detect the locked profile
// natively and fall back to a throwaway profile so the fetch still works — no
// PowerShell, no AV pop-ups. This is the Kaspersky-safe guarantee.
//
// Windows-only: the reproduction relies on the Windows process-singleton handoff.
const isWin = process.platform === 'win32';

const tmpProfile = mkdtempSync(join(tmpdir(), 'bwf-reclaim-'));
const browser = new BrowserSingleton({ profileDir: tmpProfile, idleTimeoutMs: 60_000 });
let squatter: ChildProcess | undefined;

beforeAll(async () => {
  if (!isWin) return;
  // Spawn a stand-in for the leftover orphan: a real chrome holding the profile.
  squatter = spawn(
    chromium.executablePath(),
    ['--no-sandbox', `--user-data-dir=${tmpProfile}`, '--start-minimized', 'about:blank'],
    { stdio: 'ignore' },
  );
  // Wait until chrome has claimed the profile (it writes `lockfile` within ~250ms).
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline && !existsSync(join(tmpProfile, 'lockfile'))) {
    await new Promise((r) => setTimeout(r, 100));
  }
  // Small settle so the singleton handoff is fully active.
  await new Promise((r) => setTimeout(r, 750));
});

afterAll(async () => {
  await browser.close();
  // Safety net: kill the squatter tree (native taskkill, not PowerShell).
  if (squatter?.pid) {
    spawnSync('taskkill', ['/PID', String(squatter.pid), '/T', '/F'], { stdio: 'ignore' });
  }
  // taskkill returns before Windows releases the profile's file handles; let
  // them drain so rmSync does not hit EBUSY on lockfile.
  await new Promise((r) => setTimeout(r, 1000));
  rmSync(tmpProfile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

describe('locked-profile recovery (orphan from a previous run)', () => {
  it.runIf(isWin)(
    'falls back to a working browser when the persistent profile is held by a stale chrome',
    async () => {
      const page = await browser.acquireTab();
      expect(page).toBeDefined();
      await page.goto('about:blank');
      expect(await page.title()).toBe('');
      await browser.releaseTab(page);
    },
    60_000,
  );
});
