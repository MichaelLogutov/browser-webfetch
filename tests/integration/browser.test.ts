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
});
