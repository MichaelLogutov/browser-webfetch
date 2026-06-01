import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrowserSingleton } from '../../src/browser.js';

const tmpProfile = mkdtempSync(join(tmpdir(), 'bwf-test-'));
const singleton = new BrowserSingleton({
  profileDir: tmpProfile,
  idleTimeoutMs: 60_000,
});

afterAll(async () => {
  await singleton.close();
  rmSync(tmpProfile, { recursive: true, force: true });
});

describe('BrowserSingleton', () => {
  it('lazily launches and provides a tab on first acquire', async () => {
    const tab = await singleton.acquireTab();
    expect(tab).toBeDefined();
    await tab.goto('about:blank');
    expect(await tab.title()).toBe('');
    await singleton.releaseTab(tab);
  });

  it('navigator.webdriver is false (stealth applied)', async () => {
    const tab = await singleton.acquireTab();
    await tab.goto('about:blank');
    const webdriver = await tab.evaluate(() => navigator.webdriver);
    expect(webdriver).toBe(false);
    await singleton.releaseTab(tab);
  });

  it('unminimize() does not throw and returns void', async () => {
    const tab = await singleton.acquireTab();
    try {
      await expect(singleton.unminimize(tab)).resolves.toBeUndefined();
    } finally {
      await singleton.releaseTab(tab);
    }
  });

  it('starts the window minimized when startMinimized is set', async () => {
    // --start-minimized is not a real Chromium switch; the window must be
    // actively minimized via CDP at launch so it stays out of the way until a
    // login/captcha/interactive step restores it.
    const profile = mkdtempSync(join(tmpdir(), 'bwf-min-'));
    const browser = new BrowserSingleton({
      profileDir: profile,
      idleTimeoutMs: 60_000,
      startMinimized: true,
    });
    try {
      const tab = await browser.acquireTab();
      const cdp = await tab.context().newCDPSession(tab);
      try {
        const win = (await cdp.send('Browser.getWindowForTarget')) as {
          bounds: { windowState?: string };
        };
        expect(win.bounds.windowState).toBe('minimized');
      } finally {
        await cdp.detach().catch(() => undefined);
      }
    } finally {
      await browser.close();
      rmSync(profile, { recursive: true, force: true });
    }
  });

  it('unminimize brings the (off-screen, minimized) window back on-screen', async () => {
    // Minimized windows launch off-screen to avoid a flash, so unminimize must
    // also move them on-screen or a login/captcha would surface where the user
    // can't see it.
    const profile = mkdtempSync(join(tmpdir(), 'bwf-unmin-'));
    const browser = new BrowserSingleton({
      profileDir: profile,
      idleTimeoutMs: 60_000,
      startMinimized: true,
    });
    try {
      const tab = await browser.acquireTab();
      await browser.unminimize(tab);
      const cdp = await tab.context().newCDPSession(tab);
      try {
        const win = (await cdp.send('Browser.getWindowForTarget')) as {
          bounds: { windowState?: string; left?: number; top?: number };
        };
        expect(win.bounds.windowState).toBe('normal');
        expect(win.bounds.left).toBeGreaterThanOrEqual(0);
        expect(win.bounds.top).toBeGreaterThanOrEqual(0);
      } finally {
        await cdp.detach().catch(() => undefined);
      }
    } finally {
      await browser.close();
      rmSync(profile, { recursive: true, force: true });
    }
  });

  it('reuses the launch tab so only one tab is open after acquire', async () => {
    // launchPersistentContext always opens one about:blank tab; acquireTab must
    // reuse it rather than open a second tab beside the empty one.
    const profile = mkdtempSync(join(tmpdir(), 'bwf-onetab-'));
    const browser = new BrowserSingleton({ profileDir: profile, idleTimeoutMs: 60_000 });
    try {
      const tab = await browser.acquireTab();
      expect(tab.context().pages()).toHaveLength(1);
    } finally {
      await browser.close();
      rmSync(profile, { recursive: true, force: true });
    }
  });
});
